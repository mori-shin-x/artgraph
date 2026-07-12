// spec 020 (data-model.md §3) — SymbolNameTable: (relPath, name) -> symbol id,
// built transiently at ingest time from `extractSymbols`'s output. Never
// persisted (byte-span / name-table non-persistence is an existing
// project-wide policy — see `src/parsers/typescript.ts`'s SymbolRange
// comment and data-model.md §3 "lock には保存しない").
//
// Two name sources feed one shared (relPath, name) -> Set<symbolId> table:
//
//   1. Every exported top-level symbol, via `createTSParser`'s public
//      "symbol" mode — this REUSES `extractSymbols`'s own name-resolution
//      rules (functions-first ordering, class/interface/variable handling,
//      `export { a as b }` aliasing, re-export materialization, …) instead
//      of re-deriving them here (spec 020 T009; perspective ⑦ — no
//      duplicate implementations).
//   2. Class member names. V8 reports a class method's OWN name as the
//      `functionName` (e.g. `add` on `class Cart { add() {} }`), never the
//      dotted `Class.member` form `extractClassMembers` (spec 021) registers
//      that member's OWN symbol node under, so a hit on a class method never
//      matches source (1) directly under its bare name. This is a second,
//      narrowly-scoped walk — class body member names only — that resolves a
//      bare member name to that member's OWN symbol id
//      (`symbol:<path>#Class.member`) when `extractClassMembers` actually
//      symbolized it, else falls back to the OWNING class's own exported
//      symbol id (issue #255 — a class-grain fallback stays correct for
//      members `extractClassMembers` never gives a node of their own, e.g. a
//      non-function property). Never re-implements export enumeration
//      (issue #218's "class symbol convergence" applied to execution
//      evidence).
//
// A name that resolves to more than one candidate symbol id within the same
// file (e.g. a top-level `export function add()` alongside an unrelated
// `class Cart { add() {} }` method, or two classes each defining the same
// member name) is ambiguous. The table reports this as a "file-fallback"
// resolution — the caller (`src/trace/ingest.ts`) falls back to file-grain
// attribution rather than guessing (fail-safe, FR-007 / SC-006: REQ
// reachability is never lost, only symbol PRECISION is).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { createTSParser, globCodeFiles } from "../parsers/typescript.js";

const requireCjs = createRequire(import.meta.url);
let oxcModule: typeof import("oxc-parser") | undefined;
function loadOxc(): typeof import("oxc-parser") {
  return (oxcModule ??= requireCjs("oxc-parser") as typeof import("oxc-parser"));
}

type OxcProgram = import("oxc-parser").ParseResult["program"];
type OxcStatement = OxcProgram["body"][number];

/** Resolution outcome for one (relPath, V8 functionName) lookup, ASSUMING
 * `relPath` is already known to be in scope (`hasFile(relPath) === true`) —
 * see `SymbolNameTable.resolve`'s doc for the "unknown file" case. */
export type SymbolNameResolution =
  | { kind: "symbol"; id: string }
  | { kind: "file-fallback"; id: string };

export interface SymbolNameTable {
  /** True when `relPath` matched `include` and existed on disk when this
   * table was built. Callers should check this BEFORE `resolve` — it is
   * how boundary-exclusion (out-of-`include`) and dangling (deleted-file)
   * hits are told apart upstream in `src/trace/ingest.ts`. */
  hasFile(relPath: string): boolean;
  /**
   * Resolve a (relPath, V8 functionName) pair to a symbol id when the name
   * uniquely identifies one export or class member in that file, else to a
   * `file:<relPath>` fallback id (fail-safe — never throws, never drops the
   * hit). Meaningful only when `hasFile(relPath)` is true; for an unknown
   * file this still returns a syntactically valid `file:<relPath>` fallback
   * id, but callers must not construct an edge from it (the file itself is
   * out of scope or gone).
   */
  resolve(relPath: string, fnName: string): SymbolNameResolution;
}

interface ClassLikeMember {
  type: string;
  computed?: boolean;
  kind?: string;
  key?: { type: string; name?: string };
}

interface ClassLikeDecl {
  type: string;
  id?: { name: string } | null;
  body?: { body: ClassLikeMember[] };
}

function asClassDecl(stmt: OxcStatement): ClassLikeDecl | undefined {
  if (
    stmt.type === "ExportNamedDeclaration" &&
    stmt.declaration &&
    stmt.declaration.type === "ClassDeclaration"
  ) {
    return stmt.declaration as unknown as ClassLikeDecl;
  }
  if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration.type === "ClassDeclaration") {
    return stmt.declaration as unknown as ClassLikeDecl;
  }
  return undefined;
}

function exportedClassName(stmt: OxcStatement, decl: ClassLikeDecl): string | undefined {
  if (stmt.type === "ExportDefaultDeclaration") return "default";
  return decl.id?.name;
}

export function buildSymbolNameTable(rootDir: string, includePatterns: string[]): SymbolNameTable {
  const files = globCodeFiles(rootDir, includePatterns);
  const relPaths = new Set(files.map((f) => relative(rootDir, f)));

  // (relPath, name) -> candidate symbol ids. size > 1 == ambiguous.
  const candidates = new Map<string, Map<string, Set<string>>>();
  const addCandidate = (relPath: string, name: string, symbolId: string): void => {
    let byName = candidates.get(relPath);
    if (!byName) {
      byName = new Map();
      candidates.set(relPath, byName);
    }
    let ids = byName.get(name);
    if (!ids) {
      ids = new Set();
      byName.set(name, ids);
    }
    ids.add(symbolId);
  };

  // Source 1: exported top-level symbols (extractSymbols, via the parser's
  // public "symbol" mode — same file set, same name-resolution rules). This
  // ALSO includes one node per spec-021 class member (`extractClassMembers`'s
  // `symbol:<path>#Class.member` ids, registered here under their FULL dotted
  // name) — `symbolIds` below reuses this exact set as the "does this member
  // actually get its own symbol node" existence check for Source 2, instead
  // of re-deriving `extractClassMembers`'s inclusion rules a second time.
  const symbolIds = new Set<string>();
  const { nodes } = createTSParser(rootDir, includePatterns, "symbol").parse();
  for (const node of nodes) {
    if (node.kind !== "symbol") continue;
    const hashIdx = node.id.indexOf("#");
    if (hashIdx === -1) continue;
    symbolIds.add(node.id);
    addCandidate(node.filePath, node.id.slice(hashIdx + 1), node.id);
  }

  // Source 2: class member names -> the MEMBER's own symbol id when one was
  // actually synthesized for it (issue #255), else the owning class's id.
  //
  // V8 reports a class method's OWN name as the `functionName` (e.g. `add` on
  // `class Cart { add() {} }`), never the dotted `Class.member` form
  // `extractClassMembers` (spec 021) registers its symbol node under — so a
  // hit on a class method never matches Source 1's candidate table directly.
  // This walk re-derives the bare member name -> owning class mapping so such
  // a hit resolves at all, then upgrades the target to the MEMBER's own
  // symbol id (`symbol:<path>#Class.member`) whenever `extractClassMembers`
  // actually symbolized that member — checked via `symbolIds.has(...)` above,
  // not by re-deriving its inclusion rules here. That existence guard matters
  // because THIS walk's own member filter (MethodDefinition | PropertyDefinition,
  // non-computed, non-constructor) is intentionally broader than
  // `extractClassMembers`'s (e.g. a non-function `PropertyDefinition` like
  // `foo = 3`, a `declare` member, or an abstract member is never symbolized
  // by `extractClassMembers` — see its own doc comment for the full
  // exclusion list): for those, the guard falls back to the class's own id,
  // exactly as before this fix, rather than pointing at a symbol node that
  // was never created.
  for (const filePath of files) {
    const relPath = relative(rootDir, filePath);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: import("oxc-parser").ParseResult | undefined;
    try {
      parsed = loadOxc().parseSync(filePath, content);
    } catch {
      parsed = undefined;
    }
    if (!parsed) continue;

    for (const stmt of parsed.program.body) {
      const decl = asClassDecl(stmt);
      if (!decl) continue;
      const exportedName = exportedClassName(stmt, decl);
      if (exportedName === undefined) continue;

      const classSymbolId = `symbol:${relPath}#${exportedName}`;
      for (const member of decl.body?.body ?? []) {
        if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") continue;
        if (member.computed) continue;
        // issue #267: a constructor CALL is reported by V8 under the
        // CLASS's own name (never "constructor"), so registering
        // "constructor" as a candidate name here would never match a real
        // hit — it's simply not the name V8 ever reports. That is a
        // different gap from this fix (member-id resolution): a constructor
        // hit already resolves straight to the class via its own name,
        // never via a member name lookup at all, so there is nothing for
        // THIS table to fix. `report.ts`'s `contains` roll-up (`reqExercises`,
        // child-ward only) doesn't rescue it either, since the evidence
        // lands one level ABOVE a `.constructor` claim, not below it.
        // issue #267's actual fix lives entirely in `report.ts`: a narrow,
        // `.constructor`-suffixed-claim-only PARENT-ward check
        // (`ctorClassExercised`, called from `classifyEvidence`) that
        // corroborates the ctor claim when the class node itself is
        // exercised for the same reqId — see that function's doc for why
        // it's safe to special-case only constructors this way.
        if (member.kind === "constructor") continue;
        if (member.key?.type !== "Identifier" || !member.key.name) continue;
        const memberSymbolId = `symbol:${relPath}#${exportedName}.${member.key.name}`;
        const resolvedId = symbolIds.has(memberSymbolId) ? memberSymbolId : classSymbolId;
        addCandidate(relPath, member.key.name, resolvedId);
      }
    }
  }

  return {
    hasFile: (relPath) => relPaths.has(relPath),
    resolve: (relPath, fnName) => {
      const byName = candidates.get(relPath);
      const ids = byName?.get(fnName);
      if (ids && ids.size === 1) {
        return { kind: "symbol", id: [...ids][0]! };
      }
      return { kind: "file-fallback", id: `file:${relPath}` };
    },
  };
}
