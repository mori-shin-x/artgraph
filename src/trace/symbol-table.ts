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
//      declaring class's name, so a hit on a class method never matches
//      source (1) directly. `extractSymbols` only emits nodes for top-level
//      exports (no per-member nodes), so this is a second, narrowly-scoped
//      walk — class body member names only, mapped to the OWNING class's own
//      exported symbol id — rather than a re-implementation of export
//      enumeration (issue #218's "class symbol convergence" applied to
//      execution evidence).
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
  // public "symbol" mode — same file set, same name-resolution rules).
  const { nodes } = createTSParser(rootDir, includePatterns, "symbol").parse();
  for (const node of nodes) {
    if (node.kind !== "symbol") continue;
    const hashIdx = node.id.indexOf("#");
    if (hashIdx === -1) continue;
    addCandidate(node.filePath, node.id.slice(hashIdx + 1), node.id);
  }

  // Source 2: class member names -> owning class's own symbol id.
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
        if (member.kind === "constructor") continue;
        if (member.key?.type !== "Identifier" || !member.key.name) continue;
        addCandidate(relPath, member.key.name, classSymbolId);
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
