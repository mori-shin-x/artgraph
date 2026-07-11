// spec 021 (tasks.md T007, research.md V1-V5) — trace capture engine v2:
// a Vite plugin that statically instruments every project source module's
// function entries with a branchless execution-hit stamp, and registers a
// self-contained `ModuleRegistration` into `globalThis[REGISTRY_KEY]`
// (contracts/instrumentation-runtime.md — the SSOT for this boundary's
// shape) for the runner's `instrument` engine (`src/vitest/runner.ts`) to
// drain at test boundaries. No inspector / CDP is involved on this path
// (research.md V1) — the whole point is to make per-test capture cost
// independent of how many modules are loaded.
//
// Dependency boundary (plan.md Structure Decision; spec 021 tasks.md T007):
// this module is the MAIN-PROCESS half of the v2 engine — it runs inside
// vite-node's transform pipeline (main process, once per module, cached and
// shared across worker forks/threads), never inside a worker. It may import
// `oxc-parser`, `magic-string`, and `src/trace/schema.ts` (the
// dependency-free SSOT for the hash / exclusion-rule / registry-shape
// primitives shared with the runner). It must NEVER import `vitest/runners`
// (that's the WORKER half's exclusive dependency, `src/vitest/runner.ts`)
// or any other `src/` module — the two halves of the v2 engine are separate
// build artifacts that share nothing but the `globalThis` shape this file
// writes and the runner reads.
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import MagicString from "magic-string";
import { REGISTRY_KEY, REGISTRY_VERSION, hashContent, isExcludedRelPath } from "../trace/schema.js";

// oxc-parser is a CJS package with a native binding; loading it lazily via
// createRequire mirrors `src/parsers/typescript.ts`'s identical `loadOxc`
// (same rationale: keep this module's own top-level import cheap, and this
// module never needs to touch that file — see the dependency-boundary
// comment above).
const requireCjs = createRequire(import.meta.url);
let oxcModule: typeof import("oxc-parser") | undefined;
function loadOxc(): typeof import("oxc-parser") {
  return (oxcModule ??= requireCjs("oxc-parser") as typeof import("oxc-parser"));
}

// oxc's real AST node union (`@oxc-project/types`) is large and this module
// only ever reads `.type` plus a handful of structural fields to decide
// function names and body spans — so, matching
// `src/parsers/typescript.ts`'s existing convention, nodes are walked as
// plain structural objects rather than threaded through the full generated
// union type.
interface AnyNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function isFunctionLike(type: string): boolean {
  return FUNCTION_TYPES.has(type);
}

// research.md V4: static name for a non-computed property/method key.
// Computed keys (`[expr()]: …`) never reach here — callers check `computed`
// first and pass `undefined` as the naming hint instead (关点2/6 — "computed
// key は計装しない").
function keyName(key: AnyNode | undefined): string | undefined {
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "PrivateIdentifier") return `#${key.name as string}`;
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "NumericLiteral") return String(key.value);
  return undefined;
}

// research.md V4 (T012 revision — see this task's final-report note): V8's
// actual `functionName` for a getter/setter is `"get <key>"`/`"set <key>"`
// (confirmed by a `node:inspector` Profiler.takePreciseCoverage probe — a
// class OR object-literal `get value(){}`/`set value(v){}` both report with
// the prefix; NOT the bare key name the naming table originally assumed).
// Applies to both `MethodDefinition` (class) and `Property` (object
// literal) accessor kinds — same V8 behavior either way.
function accessorName(kind: string, key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (kind === "get") return `get ${key}`;
  if (kind === "set") return `set ${key}`;
  return key;
}

// Generic child enumeration driven by oxc's own generated `visitorKeys`
// table (`Record<nodeType, propertyKey[]>`) — this is what lets `visit`
// below reach a named/nested function no matter how deeply it's buried
// (inside a conditional, a callback argument, a template literal, …)
// without this module having to hand-enumerate every AST node shape itself.
function genericChildren(node: AnyNode, visitorKeys: Record<string, readonly string[]>): AnyNode[] {
  const keys = visitorKeys[node.type];
  if (!keys) return [];
  const children: AnyNode[] = [];
  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const el of value) {
        if (el && typeof el === "object" && typeof (el as AnyNode).type === "string") {
          children.push(el as AnyNode);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
      children.push(value as AnyNode);
    }
  }
  return children;
}

/** The module-local `const` name every entry-stamp and the preamble's own
 * registration reference. Exported so tests can locate the exact inserted
 * fragments without duplicating the literal (T006). */
export const HITS_VAR = "__ag_hits";

/**
 * The self-contained module preamble (contracts/instrumentation-runtime.md
 * §preamble の義務): no `import`/`require`, no `await`/`import.meta`
 * (obligation 4 — evaluable under ESM or CJS), one line (no `\n` — obligation
 * 2, "行数不変"), lazily creates `globalThis[REGISTRY_KEY]` (`??=`, per the
 * contract's own §globalThis キー wording) and REPLACES this file's prior
 * registration (`modules.set`, isolate re-evaluation — research.md V3).
 * Exported so T006 can assert its shape directly (obligation 4) without
 * re-deriving it from a full `transform()` call.
 */
export function buildPreamble(relPath: string, hash: string, fns: readonly string[]): string {
  const relPathJson = JSON.stringify(relPath);
  return (
    `const ${HITS_VAR}=new Uint8Array(${fns.length});` +
    `(globalThis[${JSON.stringify(REGISTRY_KEY)}]??={version:${REGISTRY_VERSION},modules:new Map()})` +
    `.modules.set(${relPathJson},{file:${relPathJson},hash:${JSON.stringify(hash)},fns:${JSON.stringify(
      [...fns],
    )},hits:${HITS_VAR}});`
  );
}

interface InstrumentResult {
  fns: string[];
  ms: MagicString;
}

/**
 * Walks `program`, naming every statically-nameable function (research.md
 * V4) and inserting its entry stamp — a single branchless store,
 * `<HITS_VAR>[k]=1;` (contract obligation 3) — as literally the first thing
 * in its body. Functions whose name can't be determined statically
 * (anonymous callbacks, computed-key methods, …) are walked (so functions
 * nested inside them are still found) but never stamped or registered.
 */
function instrumentModule(
  code: string,
  visitorKeys: Record<string, readonly string[]>,
  program: AnyNode,
): InstrumentResult {
  const fns: string[] = [];
  const ms = new MagicString(code);

  function registerAndStamp(fn: AnyNode, name: string): void {
    const body = fn.body as AnyNode | null;
    if (!body) return; // ambient/overload signature (`declare function …`) — nothing to stamp
    const slot = fns.length;
    fns.push(name);
    const store = `${HITS_VAR}[${slot}]=1;`;
    if (fn.type === "ArrowFunctionExpression" && fn.expression === true) {
      // Concise-body arrow (`(x) => x + 1`) — there is no statement list to
      // prepend into, so the expression body is wrapped into a block:
      // `(x) => {<store>return x + 1}`. Both insertions are pure
      // `appendLeft`/`appendRight` (no `\n`), so this still adds zero lines
      // (contract obligation 2). `preserveParens: true` (below) keeps a
      // parenthesized object-literal body (`() => ({a: 1})`) syntactically
      // valid after wrapping.
      ms.appendLeft(body.start, `{${store}return `);
      ms.appendRight(body.end, `}`);
    } else {
      // Block body — `body.start` is the `{`; insert immediately after it,
      // still on the same source line (contract obligation 2).
      ms.appendLeft(body.start + 1, store);
    }
  }

  function visitClassBody(classBody: AnyNode, className: string | undefined): void {
    for (const member of (classBody.body as AnyNode[] | undefined) ?? []) {
      if (member.type === "MethodDefinition") {
        const computed = member.computed === true;
        const kind = member.kind as string;
        // V8-compatible naming (research.md V4, revised by T012): `constructor`
        // reports the CLASS's name, not the literal string "constructor";
        // `get`/`set` accessors report `"get <key>"`/`"set <key>"` (V8's actual
        // `functionName`, confirmed by probe — see accessorName's doc);
        // `method` reports the bare key name.
        const name = computed
          ? undefined
          : kind === "constructor"
            ? className
            : accessorName(kind, keyName(member.key as AnyNode));
        visit(member.value as AnyNode, name);
      } else if (member.type === "PropertyDefinition" || member.type === "AccessorProperty") {
        const computed = member.computed === true;
        const name = computed ? undefined : keyName(member.key as AnyNode);
        if (member.value) visit(member.value as AnyNode, name);
      } else {
        // StaticBlock, TSAbstractMethodDefinition/TSAbstractPropertyDefinition
        // (no instrumentable body), TSIndexSignature, … — generic walk still
        // finds any nested named function inside a static block's statements.
        visit(member, undefined);
      }
    }
  }

  function visit(node: AnyNode | null | undefined, hint: string | undefined): void {
    if (!node || typeof node.type !== "string") return;

    if (isFunctionLike(node.type)) {
      // A named function/class-method EXPRESSION's own name always wins
      // over the surrounding assignment context (`const f = function g(){}`
      // reports "g", matching V8/`Function.prototype.name`'s
      // NamedEvaluation-vs-own-id precedence) — arrows never have an own
      // `id` (grammar), so they always fall through to `hint`.
      const ownName =
        node.type !== "ArrowFunctionExpression"
          ? ((node.id as AnyNode | null | undefined)?.name as string | undefined)
          : undefined;
      const name = ownName ?? hint;
      if (name !== undefined) registerAndStamp(node, name);
    }

    switch (node.type) {
      case "VariableDeclarator": {
        const id = node.id as AnyNode;
        const declName = id?.type === "Identifier" ? (id.name as string) : undefined;
        visit(node.init as AnyNode | null, declName);
        return;
      }
      case "ExportDefaultDeclaration":
        visit(node.declaration as AnyNode, "default");
        return;
      case "Property": {
        // Object-literal property/method (`{ foo(){} }`, `{ foo: () => {} }`,
        // `{ get foo(){} }`, …) — one code path for all of them, matching
        // research.md V4's "オブジェクトリテラルのメソッド・プロパティ関数 →
        // キー名" / "getter・setter → アクセサ名". `kind` ("init"/"get"/"set")
        // distinguishes a plain method/property from an accessor (T012 —
        // accessors get the same `"get <key>"`/`"set <key>"` V8-actual prefix
        // as a class accessor, via the same `accessorName` helper).
        const computed = node.computed === true;
        const kind = node.kind as string;
        const name = computed ? undefined : accessorName(kind, keyName(node.key as AnyNode));
        visit(node.value as AnyNode, name);
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const id = node.id as AnyNode | null | undefined;
        // An anonymous default-exported class (`export default class {…}`)
        // inherits "default" as its constructor's fallback name, same as an
        // anonymous default-exported function.
        const className = (id?.name as string | undefined) ?? hint;
        visitClassBody(node.body as AnyNode, className);
        return;
      }
      default: {
        for (const child of genericChildren(node, visitorKeys)) visit(child, undefined);
      }
    }
  }

  for (const stmt of (program.body as AnyNode[] | undefined) ?? []) visit(stmt, undefined);

  return { fns, ms };
}

/**
 * Loose structural shape of the subset of a Vite `Plugin` this module
 * implements. Deliberately not `vite`'s own `Plugin` type — `vite` isn't a
 * direct dependency of this package (only `vitest`'s peer range pulls it
 * in transitively), and pinning to it would violate this file's
 * vitest/runners-free dependency boundary (see the top-of-file comment).
 * Mirrors `src/vitest/setup.ts`'s identical rationale for `WithTraceConfig`.
 */
export interface ArtgraphTracePlugin {
  name: string;
  enforce: "pre";
  configResolved(config: { root: string }): void;
  transform(code: string, id: string): { code: string; map: unknown } | undefined;
}

export const PLUGIN_NAME = "artgraph:trace-instrument";

/**
 * Factory for the v2 instrumentation plugin (contracts/config-surface.md
 * §plugin の適用範囲). `enforce: 'pre'` puts this ahead of the TS/JSX
 * transform, so its input is the on-disk original source — exactly what
 * `hashContent` re-reads for V5's contentHash rule below.
 */
export default function artgraphTracePlugin(): ArtgraphTracePlugin {
  let roots: readonly [root: string, realRoot: string] | undefined;
  // Fail-soft de-dup (contract §変換のスキップ): one stderr warning per
  // unparseable module, even across repeated `transform()` calls for the
  // same id (T006 观点4 — "2 回目の transform で警告が重複しない").
  const warnedParseFailures = new Set<string>();

  function relToRoot(abs: string): string {
    const r = roots!;
    let rel = relative(r[0], abs).split(sep).join("/");
    // Mirrors `src/vitest/runner.ts`'s `relToRoots` (not imported — see this
    // file's dependency-boundary comment; that module pulls in
    // `vitest/runners`): a project root that itself sits behind a symlink
    // (macOS `os.tmpdir()` being the canonical case) needs the realpath'd
    // spelling tried second before a hit is written off as "outside root".
    if ((rel.startsWith("..") || isAbsolute(rel)) && r[0] !== r[1]) {
      rel = relative(r[1], abs).split(sep).join("/");
    }
    return rel;
  }

  return {
    name: PLUGIN_NAME,
    enforce: "pre",
    configResolved(config) {
      let realRoot = config.root;
      try {
        realRoot = realpathSync(config.root);
      } catch {
        // Root not resolvable (should not happen for a running vite/vitest)
        // — fall back to the configured spelling only.
      }
      roots = [config.root, realRoot];
    },
    transform(code, id) {
      if (!roots) return undefined; // configResolved hasn't run yet — defensive, not expected under real vite

      const cleanId = id.split("?")[0]!;
      if (!isAbsolute(cleanId)) return undefined; // virtual module (no on-disk file) — not a project source module

      const relPath = relToRoot(cleanId);
      // contracts/config-surface.md §plugin の適用範囲: excluded paths are a
      // normal, silent no-op (no warning) — this is the common case for
      // every node_modules/test-file/out-of-root id vite ever hands the
      // pipeline.
      if (isExcludedRelPath(relPath)) return undefined;

      let diskContent: string;
      try {
        // V5: hash the ON-DISK original source (re-read by id), never the
        // `code` argument — another `enforce: 'pre'` plugin ahead of this
        // one in the user's config may have already rewritten `code`, and
        // staleness detection (spec 020 D7) must match the graph's own
        // disk-content hash.
        diskContent = readFileSync(cleanId, "utf-8");
      } catch {
        return undefined; // vanished between vite handing us `id` and this read — fail-soft, not our module to transform
      }

      let program: AnyNode;
      let visitorKeys: Record<string, readonly string[]>;
      try {
        const oxc = loadOxc();
        // `preserveParens: true` (the library default) keeps a
        // parenthesized concise-arrow body (`() => ({a: 1})`) as a single
        // node whose span includes the parens — required for the
        // concise-body wrap in `registerAndStamp` to stay syntactically
        // valid.
        const parsed = oxc.parseSync(cleanId, code, { preserveParens: true });
        if (parsed.errors.length > 0) throw new Error("oxc reported parse errors");
        program = parsed.program as unknown as AnyNode;
        visitorKeys = oxc.visitorKeys as unknown as Record<string, readonly string[]>;
      } catch {
        // contract §変換のスキップ: unparseable — pass through un-instrumented
        // rather than fail the build (FR-008, silent skip is what's
        // forbidden, not the skip itself).
        if (!warnedParseFailures.has(relPath)) {
          warnedParseFailures.add(relPath);
          process.stderr.write(
            `[artgraph] trace instrumentation: could not parse ${relPath} — passing through ` +
              `un-instrumented (contracts/instrumentation-runtime.md §変換のスキップ).\n`,
          );
        }
        return undefined;
      }

      const { fns, ms } = instrumentModule(code, visitorKeys, program);
      // §境界 (T006): a module with zero statically-nameable functions is
      // left completely untransformed and never registered — there is
      // nothing for the runner to drain.
      if (fns.length === 0) return undefined;

      const hash = hashContent(diskContent);
      ms.appendLeft(0, buildPreamble(relPath, hash, fns));

      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: "boundary" }),
      };
    },
  };
}
