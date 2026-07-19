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

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  createTSParser,
  globCodeFiles,
  safeParseSync,
  systemResourceExhaustedMessage,
  type TsParseWarning,
} from "../parsers/typescript.js";
import { DEFAULT_CONFIG } from "../types.js";

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

// issue #323 — `testPatterns` defaults to `DEFAULT_CONFIG.testPatterns`
// (same rationale as `createTSParser`'s own default): `buildSymbolNameTable`
// discovers its file set from `includePatterns` ONLY (never `testPatterns` —
// see `ArtgraphConfig.testPatterns`'s doc comment for why), but a discovered
// file can still coincidentally match `testPatterns` (e.g. a project that
// also lists `*.test.ts` under `include`), and `createTSParser`'s symbol-mode
// extraction gate (`!isTest`) needs the SAME testPatterns-derived answer for
// that file the rest of the codebase would give it — never a hardcoded
// filename regex.
// issue #351 (Step 0-pre HIGH-1/HIGH-1b/HIGH-2) — `buildSymbolNameTable` used
// to be completely unguarded against EMFILE/ENFILE (file-descriptor
// exhaustion): the 117-line `globCodeFiles` call throws on it directly
// (`listFilesOrThrow`'s external contract), the nested `createTSParser(...).
// parse()` call could throw via its own `enumerateFiles`/`computeTestFileSet`
// (see `typescript.ts`'s own issue #351 fix), and the per-file `readFileSync`
// below already had a catch-all but never distinguished EMFILE/ENFILE from
// "just skip this file". Every caller of THIS function (`src/trace/ingest.ts`'s
// `ingestTrace`, reached from `src/graph/builder.ts`'s `buildGraph` AND —
// pre-#351 — from `check.ts`/`impact.ts`'s own independent `ingestTrace`
// calls) therefore had no protection at all, which is exactly the "Window B"
// raw-crash class the Step 0-pre investigation confirmed via stack trace.
// Degraded fail-safe now, matching this module's own documented contract
// ("never throws, only loses symbol-name PRECISION" — see the file header):
// each of the three EMFILE/ENFILE sources below degrades independently
// (empty file list / empty parser warnings/nodes / skip-this-file), and AT
// MOST ONE `system-resource-exhausted` `TsParseWarning` is returned per call
// — shared across all three sources via `resourceExhaustedWarned` so a
// caller never sees more than one entry for what is really one underlying
// condition. A genuine `OxcLoadError` (issue #263) is UNCHANGED — it still
// propagates uncaught from every call site below, exactly as before.
export function buildSymbolNameTable(
  rootDir: string,
  includePatterns: string[],
  testPatterns: string[] = DEFAULT_CONFIG.testPatterns,
): { table: SymbolNameTable; warnings: TsParseWarning[] } {
  const warnings: TsParseWarning[] = [];
  let resourceExhaustedWarned = false;
  const pushResourceExhausted = (symbolId: string, code: "EMFILE" | "ENFILE"): void => {
    if (resourceExhaustedWarned) return;
    resourceExhaustedWarned = true;
    warnings.push({
      type: "system-resource-exhausted",
      symbolId,
      filePath: symbolId,
      message: systemResourceExhaustedMessage(code),
    });
  };

  let files: string[];
  try {
    files = globCodeFiles(rootDir, includePatterns);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EMFILE" && code !== "ENFILE") throw e;
    files = [];
    pushResourceExhausted("glob:symbol-table", code);
  }
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
  // issue #351 — `createTSParser(...).parse()` now returns its own
  // `system-resource-exhausted` warnings (see `typescript.ts`'s Step 0-pre
  // HIGH-1b/HIGH-2 fix) instead of throwing past this call site. Merged into
  // this function's own `warnings` under the same `resourceExhaustedWarned`
  // one-per-call convergence used everywhere else in this function.
  const { nodes, warnings: parseWarnings } = createTSParser(
    rootDir,
    includePatterns,
    "symbol",
    undefined,
    testPatterns,
  ).parse();
  for (const tw of parseWarnings) {
    if (tw.type === "system-resource-exhausted") {
      if (resourceExhaustedWarned) continue;
      resourceExhaustedWarned = true;
    }
    warnings.push(tw);
  }
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
    } catch (e) {
      // issue #351 — same "skip this file, fail-safe" behavior as before for
      // every errno, but EMFILE/ENFILE additionally contributes to this
      // call's (at most one) `system-resource-exhausted` warning — symmetric
      // with `globCodeFiles`'s and `createTSParser().parse()`'s own guards
      // above, and with `parseTSFile`'s EMFILE/ENFILE handling in
      // `typescript.ts`.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EMFILE" || code === "ENFILE") {
        pushResourceExhausted(`file:${relPath}`, code);
      }
      continue;
    }
    // issue #269 — this used to call `loadOxc().parseSync(filePath, content)`
    // directly, via its own COPY of `loadOxc` (bypassing the bracket-depth
    // guard added for issue #247: a deeply-nested file reaching this call
    // site natively SIGSEGVs the whole process, taking down every trace
    // command with it). Routed through the shared `safeParseSync` (the same
    // choke point `parseTSFile` uses) so this call gets the depth guard for
    // free and can never drift from it. A `depthExceeded` skip is treated
    // exactly like any other unparseable file here — `buildSymbolNameTable`
    // is documented fail-safe (never throws, only loses symbol-name
    // PRECISION, see this file's header comment), so silently `continue`ing
    // past a depth-guard-skipped file is consistent with the pre-existing
    // `catch { continue; }` immediately above for a plain parse exception.
    // A genuine `OxcLoadError` (issue #263 — the native binding itself is
    // missing/broken) is deliberately NOT caught by `safeParseSync` and so
    // propagates uncaught from here too, keeping this call site fail-FAST
    // for that failure mode, consistent with every other oxc call site in
    // the codebase.
    const parsed = safeParseSync(filePath, content).parsed;
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
    table: {
      hasFile: (relPath) => relPaths.has(relPath),
      resolve: (relPath, fnName) => {
        const byName = candidates.get(relPath);
        const ids = byName?.get(fnName);
        if (ids && ids.size === 1) {
          return { kind: "symbol", id: [...ids][0]! };
        }
        return { kind: "file-fallback", id: `file:${relPath}` };
      },
    },
    warnings,
  };
}
