import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import fastGlob from "fast-glob";
import type { GraphNode, GraphEdge } from "../types.js";
import { NAMESPACED_ID_TOKEN } from "../grammar/tokens.js";

// oxc-parser based TypeScript extraction layer (issue #159).
//
// This module replaced its original ts-morph backend with oxc's native
// parser. For everything the ORIGINAL ts-morph backend itself produced, the
// output contract is bit-for-bit what that backend produced — node/edge
// ARRAY ORDER and contentHash values included — so existing `.trace.lock`
// files stay byte-identical across the swap (INV-L4). That behavior was
// established by differential-testing both backends over this repository,
// the test fixtures, and edge-case probes, and is now pinned by
// tests/typescript-oxc-regression.test.ts. Three pieces of compiler behavior
// are re-derived here from those empirical probes:
//
//   1. Relative import/export specifier resolution (the checker's behavior
//      behind `getModuleSpecifierSourceFile`). The outcome depends only on
//      the tsconfig's jsx / allowJs / resolveJsonModule — NOT on
//      moduleResolution or package.json "type" (node16 strictness is not
//      enforced on that API), and the resolved target must itself be a
//      module (a script target yields no edge). See resolveRelativeImport.
//   2. Symbol-mode export enumeration (`getExportedDeclarations`). Its Map
//      iteration order is the checker's export-symbol-table order, which the
//      binder fills FUNCTIONS FIRST (top-level function statements in source
//      order, then everything else in source order — bindEachFunctionsFirst),
//      and its getText() spans differ per declaration kind (statement span
//      including `export` for functions/classes/…, declarator span excluding
//      `export const` for variables). See extractSymbols.
//   3. Import-clause enumeration for symbol-mode edges. Walked from the AST;
//      for files with fatal syntax errors (where oxc returns an empty
//      program) the parser's error-tolerant module record still carries the
//      import/export shape and is used as a fallback. Known limit: symbol
//      NODES cannot be recovered from such files (the TS compiler recovered
//      partial declarations; oxc does not).
//
// spec 021 (T024, issue #218) — class-method-grain symbols are a DELIBERATE
// divergence from that bit-for-bit contract, not a 4th re-derived behavior:
// the original ts-morph backend's `getExportedDeclarations()` only ever
// walked TOP-LEVEL exported declarations, so it never emitted a symbol node
// for a class member and there is no legacy behavior to reproduce here. For
// an inline exported `ClassDeclaration` (named or default), extractSymbols
// additionally calls extractClassMembers to synthesize one symbol node per
// named member (`symbol:<path>#ClassName.memberName`) plus a class -> method
// `contains` edge (provenance "structural") per member — see
// extractClassMembers's own doc comment for the full inclusion/exclusion
// list (FR-001/FR-004) and specs/021-class-method-grain/spec.md for the
// attribution and containment semantics. The class symbol's own id / span /
// contentHash stay untouched (still bit-for-bit with the legacy backend);
// only the ADDITIONAL member nodes/edges are new surface area. This bumped
// parse-cache's SCHEMA_VERSION (see src/parse-cache.ts) since a pre-spec-021
// cached fragment carries neither.
//
// oxc-parser is a CJS package with a native binding; loading it lazily via
// createRequire keeps this module's import cheap — combined with the parse
// cache, a fully-warm scan never loads the parser at all. `require` of a CJS
// dep is synchronous, so callers (buildGraph is sync) don't need to change
// shape.
const requireCjs = createRequire(import.meta.url);
let oxcModule: typeof import("oxc-parser") | undefined;
function loadOxc(): typeof import("oxc-parser") {
  return (oxcModule ??= requireCjs("oxc-parser") as typeof import("oxc-parser"));
}

type OxcParseResult = import("oxc-parser").ParseResult;
type OxcProgram = OxcParseResult["program"];
type OxcStatement = OxcProgram["body"][number];

// Regexes that locate requirement IDs in code/test tags. When the project sets a
// custom `reqPatterns.codeId`, these are rebuilt from that token so that @impl /
// test-bracket / `req:` annotations track the same IDs the markdown parser emits.
interface IdMatchers {
  implRe: RegExp;
  reqIdRe: RegExp;
  testReqRe: RegExp;
  testAnnotationRe: RegExp;
}

// For codeId, the whole match is the ID, so the constructed matchers below rely
// on the token having no significance beyond what it matches.
//
// implRe: one `// @impl` line carries one or more IDs, separated by line-local
// whitespace and/or commas — `@impl A B`, `@impl A, B`, `@impl A,B` are all
// equivalent (issue #214: the comma is the notation first-time users reach
// for; before it was accepted, `@impl A, B` silently dropped every ID after
// the first). A trailing comma (`@impl A,`) is consumed into the capture and
// ignored by the reqIdRe tokenization below, which extracts ID tokens
// regardless of what separates them.
function buildIdMatchers(codeId?: string): IdMatchers {
  const token = codeId ?? NAMESPACED_ID_TOKEN;
  return {
    implRe: new RegExp(`//[^\\S\\n]*@impl[^\\S\\n]+((?:(?:${token})(?:[^\\S\\n]|,)*)+)`, "gm"),
    reqIdRe: new RegExp(token, "g"),
    testReqRe: new RegExp(`\\[(?:${token})]`, "g"),
    testAnnotationRe: new RegExp(`req:\\s*["']?(${token})["']?`, "g"),
  };
}

// PR #242 review A — structured warnings the TS parser wants surfaced to the
// build layer. Mirrors markdown.ts's `ParseWarning` → `MdFragment.warnings` →
// builder.ts warning-conversion pattern exactly, so class-member collisions
// (previously a bare `console.warn` inside extractSymbols) ride the same pipe
// as every other build warning: they survive a parse-cache warm hit, show up
// in `--format json` `warnings[]`, and are never double-printed by
// `check --gate --diff`. See parse-cache.ts's `TsFragment.warnings` and
// builder.ts's TS-warning conversion loop for the rest of the wiring.
export interface TsParseWarning {
  type: "class-member-collision";
  // Fully-qualified id the warning is about (`symbol:<path>#<name>`).
  symbolId: string;
  filePath: string;
  message: string;
}

export interface ParsedTS {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: TsParseWarning[];
  // specs/018 §3 S1 side-channel. rootDir-relative resolved targets of every
  // plain `export * from "./o"` in this file, in source order, deduped by
  // first occurrence. Populated only in symbol mode on non-test files, and
  // only for plain `export *` — `export * as ns from` is materialized in the
  // parser (S2) and does not go through this channel. Consumed by builder's
  // star-expansion pass (§5) to compute exported names across module graph.
  starExports?: string[];
}

interface SymbolRange {
  name: string;
  // Declaration-group id: every sibling binding of ONE variable-declaration
  // statement shares it; every other export is its own group. resolveSymbolsAt
  // Line selects a single group and never merges across groups (D1).
  group: number;
  startLine: number;
  endLine: number;
}

export function createTSParser(
  rootDir: string,
  patterns: string[],
  mode: "file" | "symbol" = "file",
  codeId?: string,
) {
  const matchers = buildIdMatchers(codeId);
  return {
    parse: (): ParsedTS => {
      const ctx = createResolverContext(rootDir);
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const warnings: TsParseWarning[] = [];
      for (const filePath of enumerateFiles(rootDir, patterns)) {
        const parsed = parseTSFile(filePath, rootDir, mode, matchers, ctx);
        nodes.push(...parsed.nodes);
        edges.push(...parsed.edges);
        warnings.push(...parsed.warnings);
      }
      return { nodes, edges, warnings };
    },
  };
}

// Resolve the code-file set for `patterns` in one fast-glob call (cwd =
// process.cwd(), absolute results). The parse-cache path discovers the file
// set through this helper so warm runs see byte-for-byte the same set a full
// createTSParser scan enumerates, without loading the parser.
export function globCodeFiles(rootDir: string, patterns: string[]): string[] {
  return fastGlob.sync(
    patterns.map((p) => resolve(rootDir, p).replace(/\\/g, "/")),
    { cwd: resolve(), absolute: true },
  );
}

// Parse exactly the given files (used by the parse-cache path to reparse only
// changed files). Import resolution consults the real file system, so targets
// outside `filePaths` still resolve the same way they do in a full scan.
// Returns a fragment per input path.
export function parseTSFilePaths(
  rootDir: string,
  filePaths: string[],
  mode: "file" | "symbol" = "file",
  codeId?: string,
): Map<string, ParsedTS> {
  const matchers = buildIdMatchers(codeId);
  const ctx = createResolverContext(rootDir);
  const out = new Map<string, ParsedTS>();
  for (const filePath of filePaths) {
    out.set(filePath, parseTSFile(filePath, rootDir, mode, matchers, ctx));
  }
  return out;
}

// One glob per pattern, deduped, then ordered the way the previous ts-morph
// backend's project.getSourceFiles() iterated. Preserving that order keeps
// node/edge output — and therefore `.trace.lock` bytes — stable across the
// backend swap.
function enumerateFiles(rootDir: string, patterns: string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = fastGlob.sync(resolve(rootDir, pattern).replace(/\\/g, "/"), {
      cwd: resolve(),
      absolute: true,
    });
    for (const filePath of matches) {
      if (!seen.has(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
    }
  }
  return orderByDirectoryDepth(files);
}

// Sibling directory / file comparator (ts-morph's LocaleStringComparer).
function compareBaseNames(a: string, b: string): number {
  const result = a.localeCompare(b, "en-us-u-kf-upper");
  return result < 0 ? -1 : result === 0 ? 0 : 1;
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

// Replicate the legacy project.getSourceFiles() iteration order: the
// DirectoryCache held the directories of added files (plus the intermediate
// directories that connect a directory to an already-cached ancestor) and
// walked them breadth-first by path depth — "orphan" root directories in
// insertion order, child directories and files sorted by base name. Files
// are added per pattern in glob order, which fixes the orphan insertion
// order.
function orderByDirectoryDepth(files: string[]): string[] {
  const filesByDir = new Map<string, string[]>();
  const cached = new Set<string>();
  const orphans: string[] = [];

  const removeOrphan = (path: string): void => {
    const idx = orphans.indexOf(path);
    if (idx !== -1) orphans.splice(idx, 1);
  };

  // DirectoryCache#addDirectory: adopt orphans that are direct children,
  // become an orphan when the parent isn't cached, then connect any orphan
  // descendants by filling the intermediate directories.
  const addDirectory = (path: string): void => {
    for (const orphan of orphans.filter((o) => o !== path && parentDir(o) === path)) {
      removeOrphan(orphan);
    }
    const parent = parentDir(path);
    if (parent !== path && !cached.has(parent) && !orphans.includes(path)) {
      orphans.push(path);
    }
    cached.add(path);
    for (const orphan of orphans.filter((o) => o !== path && o.startsWith(`${path}/`))) {
      fillParents(orphan);
    }
  };

  // DirectoryCache#fillParentsOfDirPath: create the intermediate directories
  // between `dirPath` and its nearest cached ancestor (top-down) — nothing
  // when no ancestor is cached.
  const fillParents = (dirPath: string): void => {
    const passed: string[] = [];
    let current = dirPath;
    let parent = parentDir(current);
    while (current !== parent) {
      current = parent;
      parent = parentDir(current);
      if (cached.has(current)) {
        for (const p of passed) addDirectory(p);
        break;
      }
      passed.unshift(current);
    }
  };

  for (const filePath of files) {
    const dir = parentDir(filePath);
    if (!cached.has(dir)) {
      fillParents(dir);
      addDirectory(dir);
    }
    const dirFiles = filesByDir.get(dir);
    if (dirFiles) dirFiles.push(filePath);
    else filesByDir.set(dir, [filePath]);
  }

  const childDirs = new Map<string, string[]>();
  for (const dir of cached) {
    const parent = parentDir(dir);
    if (parent === dir || !cached.has(parent)) continue;
    const siblings = childDirs.get(parent);
    if (siblings) siblings.push(dir);
    else childDirs.set(parent, [dir]);
  }
  for (const siblings of childDirs.values()) {
    siblings.sort((a, b) => compareBaseNames(baseName(a), baseName(b)));
  }

  // getSourceFilesByDirectoryDepth: BFS over depth levels, seeded with the
  // orphans (insertion order), children appended as their parent is visited.
  const depthOf = (p: string): number => p.split("/").length;
  const levels = new Map<number, string[]>();
  const enqueue = (dir: string): void => {
    const depth = depthOf(dir);
    const level = levels.get(depth);
    if (level) level.push(dir);
    else levels.set(depth, [dir]);
  };
  for (const orphan of orphans) enqueue(orphan);

  const out: string[] = [];
  if (levels.size === 0) return out;
  let depth = Math.min(...levels.keys());
  while (levels.size > 0) {
    for (const dir of levels.get(depth) ?? []) {
      const dirFiles = (filesByDir.get(dir) ?? []).sort((a, b) =>
        compareBaseNames(baseName(a), baseName(b)),
      );
      out.push(...dirFiles);
      for (const child of childDirs.get(dir) ?? []) enqueue(child);
    }
    levels.delete(depth);
    depth++;
  }
  return out;
}

function parseTSFile(
  filePath: string,
  rootDir: string,
  mode: "file" | "symbol",
  matchers: IdMatchers,
  ctx: ResolverContext,
): ParsedTS {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: TsParseWarning[] = [];

  const relPath = relative(rootDir, filePath);
  const content = stripBom(readFileSync(filePath, "utf-8"));
  const fileHash = hash(content);

  const isTest = /\.(test|spec)\.(ts|tsx)$/.test(filePath);

  nodes.push({
    id: `file:${relPath}`,
    kind: isTest ? "test" : "file",
    filePath: relPath,
    contentHash: fileHash,
  });

  // parseSync never throws on syntax errors (it reports res.errors and may
  // return an empty program); the guard covers pathological inputs only.
  let parsed: OxcParseResult | undefined;
  try {
    parsed = loadOxc().parseSync(filePath, content);
  } catch {
    parsed = undefined;
  }

  let symbolRanges: SymbolRange[] = [];
  if (parsed && mode === "symbol" && !isTest) {
    symbolRanges = extractSymbols(
      parsed.program,
      content,
      relPath,
      nodes,
      edges,
      warnings,
      parsed.comments,
    );
  }
  let starExports: string[] | undefined;
  if (parsed) {
    const result = extractImports(
      parsed,
      content,
      relPath,
      filePath,
      rootDir,
      nodes,
      edges,
      mode,
      isTest,
      ctx,
    );
    if (result.starExports.length > 0) starExports = result.starExports;
  }
  extractImplTags(content, relPath, isTest, edges, mode, symbolRanges, matchers, parsed?.comments);

  return starExports ? { nodes, edges, warnings, starExports } : { nodes, edges, warnings };
}

// The TS compiler host strips a UTF-8 BOM when reading files — the file-hash
// input and all node spans are relative to the stripped text.
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

// ---------------------------------------------------------------------------
// Symbol-mode export extraction (getExportedDeclarations semantics)
// ---------------------------------------------------------------------------

// A top-level declaration a local name can resolve to. `start`/`end` delimit
// the text ts-morph's getText() returned for the declaration node:
//   - functions/classes/interfaces/enums/namespaces/type aliases: the whole
//     statement, INCLUDING `export`/`default` when directly exported and any
//     decorators (which may sit before the `export` keyword);
//   - variables: the VariableDeclarator (`x = 1`) or the leaf BindingElement
//     of a destructuring pattern — never `export const`.
interface LocalDecl {
  isFunction: boolean;
  start: number;
  end: number;
}

interface ExportEntry {
  name: string;
  // Hash span (contentHash input) — the declarator/declaration text, unchanged.
  start: number;
  end: number;
  // Declaration group + attribution span. The attribution span is the whole
  // statement for a variable declaration (so a leading tag binds every sibling)
  // and equals start/end for every other export. Kept SEPARATE from the hash
  // span so widening never leaks into contentHash (INV-L4).
  group: number;
  attrStart: number;
  attrEnd: number;
  // spec 021 (FR-001/FR-003, issue #218) — populated ONLY for an inline
  // exported ClassDeclaration entry (named or default). Maps each target
  // member's full symbol name (`${ClassName-or-"default"}.${memberName}`) to
  // every occurrence span, in source order — get/set pairs, static+instance
  // same name, and overload signatures + implementation all converge to one
  // map entry (FR-003). `undefined` for every other entry kind.
  classMembers?: Map<string, Array<{ start: number; end: number }>>;
  // PR #242 review B — set when this entry LOST an id collision against a
  // class member's synthesized name (see the collision-resolution pass
  // below). A loser keeps its attribution RANGE (so a leading `@impl` tag
  // above it still resolves via `resolveSymbolsAtLine`) but never gets a
  // symbol NODE of its own — `resolveSymbolsAtLine` returns the collided
  // NAME, and `symbol:<path>#<name>` is exactly the id the winning class
  // member registered, so the tag re-attributes to the winner instead of
  // dangling or degrading to file grain (the pre-fix behavior, which
  // spliced the loser out of `entries` entirely and lost its range too).
  collisionLoser?: boolean;
}

function isFunctionDecl(node: { type: string } | null | undefined): boolean {
  return node?.type === "FunctionDeclaration" || node?.type === "TSDeclareFunction";
}

// Statement-text start: the export wrapper's start, widened to include class
// decorators (oxc keeps decorators that precede `export` outside the
// statement span; TS's getText() includes them).
function declTextStart(stmtStart: number, decl: unknown): number {
  let start = stmtStart;
  const decorators = (decl as { decorators?: Array<{ start: number }> }).decorators;
  if (decorators) {
    for (const d of decorators) {
      if (d.start < start) start = d.start;
    }
  }
  return start;
}

type OxcComment = OxcParseResult["comments"][number];

// spec 021 (FR-001/FR-004, issue #218) — member occurrences of ONE inline
// exported ClassDeclaration, keyed by full symbol name (`${classPrefix}.
// ${memberName}`) so same-name occurrences (get/set pairs, static+instance,
// overload signatures + implementation) converge to a single map entry, in
// source order (FR-003). `classPrefix` is the class's own entry name
// ("Sample" for `export class Sample`, "default" for `export default class`).
//
// Included (oxc's ClassBody element shapes, empirically probed): method /
// getter / setter / constructor / static forms of any of those
// (`MethodDefinition`, `kind` in {method,get,set,constructor}), and class
// properties (`PropertyDefinition`) whose `value` is an ArrowFunctionExpression
// or FunctionExpression.
//
// Excluded — falls through unnamed, so the member's `@impl` tag (if any)
// keeps the pre-existing class-attribution fallback (FR-004):
//   - computed name (`[expr]() {}`, `computed: true`) — checked first, before
//     any type-specific branch, since a computed key can otherwise still be
//     an `Identifier`-typed AST node (e.g. `[x]() {}`).
//   - private member (`#m`) — `key.type === "PrivateIdentifier"`, never
//     `"Identifier"`.
//   - data property (non-function initializer) — `value.type` fails the
//     Arrow/FunctionExpression check.
//   - `accessor` field — a STRUCTURALLY DIFFERENT ClassElement type
//     (`AccessorProperty` / `TSAbstractAccessorProperty`), never
//     `"PropertyDefinition"`; falls through the else branch untouched.
//   - abstract method — oxc types it `"TSAbstractMethodDefinition"`, a
//     DIFFERENT string from `"MethodDefinition"` (MethodDefinitionType), so
//     the `el.type === "MethodDefinition"` check excludes it by construction.
//   - abstract property — same reasoning (`"TSAbstractPropertyDefinition"`).
//   - `declare` property — SAME type string (`"PropertyDefinition"`) as a
//     normal field, so needs the explicit `declare` flag check.
//   - static block (`ClassElement` type `"StaticBlock"`) — falls through.
//   - `TSIndexSignature` — falls through (not a named member at all).
//   - EVERY member of an `export declare class` — the class node itself
//     carries `declare: true` (same flag shape as a `declare` property, just
//     one level up); guarded before the body is even walked (PR #242 review
//     D1). An ambient class has no runtime method bodies, so none of its
//     members are symbolized — all tags fall back to the class.
function extractClassMembers(
  classNode: unknown,
  classPrefix: string,
): Map<string, Array<{ start: number; end: number }>> {
  const members = new Map<string, Array<{ start: number; end: number }>>();
  if ((classNode as { declare?: boolean }).declare) return members;
  const body = (classNode as { body?: { body?: Array<Record<string, unknown>> } }).body?.body;
  if (!body) return members;

  const add = (name: string, start: number, end: number) => {
    const fullName = `${classPrefix}.${name}`;
    const list = members.get(fullName);
    if (list) list.push({ start, end });
    else members.set(fullName, [{ start, end }]);
  };

  for (const raw of body) {
    const el = raw as {
      type: string;
      computed?: boolean;
      declare?: boolean;
      key?: { type: string; name?: string };
      value?: { type: string } | null;
      start: number;
      end: number;
    };
    // Decorators sit INSIDE the member's own start/end here (unlike the
    // class-vs-`export`-wrapper case declTextStart widens for) — oxc-parser
    // includes a decorated member's decorators in its own span, empirically
    // confirmed against this repo's oxc-parser version.
    if (el.computed) continue;
    if (el.key?.type !== "Identifier" || !el.key.name) continue;

    if (el.type === "MethodDefinition") {
      add(el.key.name, el.start, el.end);
    } else if (el.type === "PropertyDefinition") {
      if (el.declare) continue;
      if (el.value?.type !== "ArrowFunctionExpression" && el.value?.type !== "FunctionExpression") {
        continue;
      }
      add(el.key.name, el.start, el.end);
    }
  }
  return members;
}

function extractSymbols(
  program: OxcProgram,
  content: string,
  relPath: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  warnings: TsParseWarning[],
  comments: readonly OxcComment[] = [],
): SymbolRange[] {
  const declMap = collectTopLevelDecls(program);
  const lookup = (name: string): LocalDecl | undefined => {
    const decls = declMap.get(name);
    if (!decls || decls.length === 0) return undefined;
    // Merged symbols (fn+namespace, overloads): the binder registers function
    // declarations first, so `symbol.declarations[0]` is the first function
    // when one exists, else the first declaration in source order.
    return decls.find((d) => d.isFunction) ?? decls[0];
  };

  const entries: ExportEntry[] = [];
  const seen = new Set<string>();
  let groupCounter = 0;
  const push = (
    name: string,
    start: number,
    end: number,
    group: number,
    attrStart = start,
    attrEnd = end,
    classMembers?: Map<string, Array<{ start: number; end: number }>>,
  ) => {
    if (seen.has(name)) {
      // PR #242 review C — this dedup ALREADY silently drops a later
      // same-name export (pre-existing first-registered-wins behavior,
      // unchanged here). That's usually benign: `export function f(){}` +
      // `export { f }` re-pushes the SAME declaration span, so it's a no-op
      // duplicate, not a real collision. But when the spans genuinely
      // differ AND either side is a class entry (carries `classMembers` —
      // e.g. two `export class Sample`, or a string-literal alias export
      // colliding with a class's own name), the drop can silently discard an
      // entire class's worth of member symbols with zero observability.
      // Surface a warning in that case; the drop itself is unchanged.
      const existing = entries.find((e) => e.name === name);
      if (
        existing &&
        (existing.start !== start || existing.end !== end) &&
        (existing.classMembers !== undefined || classMembers !== undefined)
      ) {
        warnings.push({
          type: "class-member-collision",
          symbolId: `symbol:${relPath}#${name}`,
          filePath: relPath,
          message:
            `export "${name}" collides with an earlier export of the same name in this file; ` +
            "the earlier declaration wins and this one (including any class members it would " +
            "have contributed) is dropped. Rename one of them to remove the ambiguity.",
        });
      }
      return;
    }
    seen.add(name);
    entries.push({ name, start, end, group, attrStart, attrEnd, classMembers });
  };

  // Pass 1 — top-level function statements, source order. The TS binder binds
  // FunctionDeclaration statements before everything else
  // (bindEachFunctionsFirst), which is what orders the checker's export
  // symbol table and therefore getExportedDeclarations() iteration.
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration" && isFunctionDecl(stmt.declaration)) {
      const decl = stmt.declaration as { id: { name: string } | null; end: number };
      if (decl.id) push(decl.id.name, stmt.start, decl.end, groupCounter++);
    } else if (stmt.type === "ExportDefaultDeclaration" && isFunctionDecl(stmt.declaration)) {
      push("default", stmt.start, stmt.declaration.end, groupCounter++);
    }
  }

  // Pass 2 — every other export form, source order.
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.source) continue; // re-exports resolve to foreign declarations
      const decl = stmt.declaration;
      if (decl) {
        if (isFunctionDecl(decl)) continue; // pass 1
        if (decl.type === "VariableDeclaration") {
          // One `export const a = 1, b = 2` / `export const { a, b } = …` is a
          // SINGLE group: all sibling declarators share the statement-wide
          // attribution span (stmt.start … decl.end) so a leading tag binds to
          // every one, even when declarators span multiple lines. The hash span
          // stays each declarator (s/e) — contentHash is unchanged.
          const g = groupCounter++;
          for (const declarator of decl.declarations) {
            collectBindingNames(declarator.id, declarator.start, declarator.end, (name, s, e) =>
              push(name, s, e, g, stmt.start, decl.end),
            );
          }
        } else if (decl.type === "ClassDeclaration") {
          if (decl.id) {
            const className = decl.id.name;
            push(
              className,
              declTextStart(stmt.start, decl),
              decl.end,
              groupCounter++,
              undefined,
              undefined,
              // spec 021 (FR-001, issue #218): inline named export only —
              // `export { Sample }` / alias exports resolve via `lookup()`
              // above and never reach this branch, so they stay
              // member-symbol-free (FR-001's "分離 export は対象外").
              extractClassMembers(decl, className),
            );
          }
        } else if (
          decl.type === "TSInterfaceDeclaration" ||
          decl.type === "TSTypeAliasDeclaration" ||
          decl.type === "TSEnumDeclaration"
        ) {
          push(decl.id.name, stmt.start, decl.end, groupCounter++);
        } else if (decl.type === "TSModuleDeclaration" && decl.id.type === "Identifier") {
          push(decl.id.name, stmt.start, decl.end, groupCounter++);
        }
      } else {
        // `export { a as b }` — the exported name is the alias; the
        // declaration is the local target. Imported / undeclared targets are
        // skipped (foreign declarations never became symbol nodes). Each
        // specifier is its own group.
        for (const spec of stmt.specifiers) {
          const localName = moduleExportName(spec.local);
          const target = localName === undefined ? undefined : lookup(localName);
          if (!target) continue;
          const exportedName = moduleExportName(spec.exported);
          if (exportedName !== undefined)
            push(exportedName, target.start, target.end, groupCounter++);
        }
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.declaration;
      if (isFunctionDecl(decl)) continue; // pass 1
      if (decl.type === "ClassDeclaration") {
        push(
          "default",
          declTextStart(stmt.start, decl),
          decl.end,
          groupCounter++,
          undefined,
          undefined,
          extractClassMembers(decl, "default"),
        );
      } else if (decl.type === "TSInterfaceDeclaration") {
        push("default", stmt.start, decl.end, groupCounter++);
      } else if (decl.type === "Identifier") {
        // `export default foo;` resolves to foo's local declaration (skipped
        // when foo is imported/undeclared).
        const target = lookup(decl.name);
        if (target) push("default", target.start, target.end, groupCounter++);
      } else {
        // `export default <expr>;` — the symbol hashes the expression node.
        push("default", decl.start, decl.end, groupCounter++);
      }
    }
    // ExportAllDeclaration / TSExportAssignment (`export =`): no local symbols.
  }

  // spec 021 (FR-001, issue #218): a class member's full name
  // (`ClassName.memberName`) can collide with an EXISTING export entry of the
  // same literal name — today the only way that happens is a string-literal
  // export alias (`export { helper as "Sample.methodA" }`, whose entry name
  // is the literal's VALUE via moduleExportName — see the specifier branch
  // above). The class member wins; the colliding entry is flagged as a
  // `collisionLoser` (PR #242 review B) — NOT spliced out of `entries`
  // anymore. Splicing used to delete the loser's attribution RANGE along
  // with its node, so an `@impl` tag written above the losing declaration
  // silently degraded from symbol grain to FILE grain (a regression vs.
  // main, which had no class members to collide with in the first place).
  // Keeping the range means `resolveSymbolsAtLine` still resolves the tag to
  // the collided NAME, and `symbol:<path>#<name>` is exactly the id the
  // winning class member registers below — so the tag re-attributes to the
  // class member instead of dangling or degrading. Iterates a SNAPSHOT of
  // `entries` so flagging entries mid-loop cannot skip a later class entry.
  for (const classEntry of entries.slice()) {
    if (!classEntry.classMembers) continue;
    for (const fullName of classEntry.classMembers.keys()) {
      const loserIdx = entries.findIndex((e) => e !== classEntry && e.name === fullName);
      if (loserIdx === -1) continue;
      warnings.push({
        type: "class-member-collision",
        symbolId: `symbol:${relPath}#${fullName}`,
        filePath: relPath,
        message:
          `class member symbol "symbol:${relPath}#${fullName}" collides with an existing ` +
          "export of the same name; the class member wins and the other export's symbol node " +
          "is dropped (any tag on the colliding declaration re-attributes to the class member). " +
          "Rename one of them to remove the ambiguity.",
      });
      entries[loserIdx] = { ...entries[loserIdx], collisionLoser: true };
    }
  }

  const lineStarts = buildLineStarts(content);
  // Leading-trivia attribution (issue #177). A `// @impl REQ` written on the
  // line(s) directly above `export …` (idiomatic, and what `bootstrap` emits)
  // must bind to the symbol, not the file — otherwise symbol-mode gate/impact
  // fail-opens for named imports. We widen only the symbol's ATTRIBUTION range
  // (`startLine`) upward over contiguous comment-only / blank lines, stopping
  // at the first line carrying code. The node `contentHash` still hashes the
  // ORIGINAL declaration span, so symbol lock bytes are unchanged (only the
  // `implements` edge SOURCE moves file:x -> symbol:x#name). Working at line
  // granularity — not the raw `entry.start` offset — is essential: for a
  // `export const x = …` the entry offset is the DECLARATOR (`x`, after
  // `const`), so an offset walk would hit code immediately; the line above the
  // declaration is what carries the tag. JSDoc blocks are spanned line-by-line
  // (each interior line is comment-only) so a `// @impl` above the JSDoc is
  // still reached.
  const lineHasCode = computeLineHasCode(content, comments, lineStarts);
  const ranges: SymbolRange[] = [];
  for (const entry of entries) {
    // PR #242 review B — a collision loser contributes its attribution RANGE
    // (below) but never a symbol NODE: the winning class member already
    // registers a node under the exact same id (`symbol:<path>#<name>`), so
    // pushing here would either duplicate it or (depending on push order)
    // shadow the winner. See the collision-resolution pass above.
    if (!entry.collisionLoser) {
      nodes.push({
        id: `symbol:${relPath}#${entry.name}`,
        kind: "symbol",
        filePath: relPath,
        contentHash: hash(content.slice(entry.start, entry.end)),
      });
    }
    let startLine = lineOf(lineStarts, entry.attrStart);
    while (startLine > 1 && !lineHasCode[startLine - 1]) startLine--;
    ranges.push({
      name: entry.name,
      group: entry.group,
      startLine,
      endLine: lineOf(lineStarts, entry.attrEnd),
    });

    if (entry.classMembers) {
      // spec 021 (FR-002/FR-006, FR-003, issue #218). The class's own
      // node/range were just pushed above — BEFORE any member — so a
      // same-size attribution tie (Edge Cases: 1-line class) keeps the class
      // (resolveSymbolsAtLine keeps the FIRST-registered range on a tie).
      // Member leading-trivia widening is bounded below by the class
      // declaration's own (un-widened) start line — `entry.attrStart` is
      // exactly that for a class entry, since the ClassDeclaration push()
      // call sites never pass a custom attrStart — so a tag directly above
      // the class cannot be "stolen" by a member whose declaration opens on
      // the same line as the class (FR-002's upward-widening lower-bound
      // rule).
      const classDeclLine = lineOf(lineStarts, entry.attrStart);
      const classSymbolId = `symbol:${relPath}#${entry.name}`;
      for (const [fullName, occurrences] of entry.classMembers) {
        const memberSymbolId = `symbol:${relPath}#${fullName}`;
        nodes.push({
          id: memberSymbolId,
          kind: "symbol",
          filePath: relPath,
          // FR-003: same-name convergence (get/set, static+instance,
          // overload signatures + implementation) — ONE node per full name,
          // hashing every occurrence's source text in encounter (source)
          // order, `\0`-joined (synthReexportHash precedent below) so an
          // edit to ANY occurrence drifts the shared hash while an edit to a
          // sibling member elsewhere in the class never does.
          contentHash: hash(occurrences.map((o) => content.slice(o.start, o.end)).join("\0")),
        });
        // FR-006: class -> method containment, provenance "structural". One
        // edge per unique member name (not per occurrence) — the traversal
        // direction constraint (forward-only) is spec 019's existing,
        // unmodified guard in traverse.ts.
        edges.push({
          source: classSymbolId,
          target: memberSymbolId,
          kind: "contains",
          provenances: ["structural"],
        });
        for (const occ of occurrences) {
          let memberStart = lineOf(lineStarts, occ.start);
          while (memberStart > classDeclLine && !lineHasCode[memberStart - 1]) memberStart--;
          ranges.push({
            name: fullName,
            group: groupCounter++,
            startLine: memberStart,
            endLine: lineOf(lineStarts, occ.end),
          });
        }
      }
    }
  }
  return ranges;
}

// Per-line (1-based) "does this line contain a non-whitespace character that
// is NOT inside a comment?" A blank line and a comment-only line both yield
// false; any real token yields true. Used by extractSymbols to bound the
// upward leading-trivia walk at the first code line (issue #177).
function computeLineHasCode(
  content: string,
  comments: readonly OxcComment[],
  lineStarts: number[],
): boolean[] {
  const inComment = new Uint8Array(content.length);
  for (const c of comments) {
    const end = Math.min(c.end, content.length);
    for (let i = Math.max(c.start, 0); i < end; i++) inComment[i] = 1;
  }
  const numLines = lineStarts.length;
  const hasCode: boolean[] = new Array(numLines + 1).fill(false);
  for (let line = 1; line <= numLines; line++) {
    const start = lineStarts[line - 1];
    const end = line < numLines ? lineStarts[line] : content.length;
    for (let i = start; i < end; i++) {
      const ch = content[i];
      // Match any Unicode whitespace (\s covers U+3000 etc.) — otherwise a
      // stray full-width space on an otherwise blank line stops the upward
      // leading-trivia walk and a `// @impl` above it silently falls back to
      // file attribution. See issue #190.
      if (/\s/.test(ch)) continue;
      if (inComment[i]) continue;
      hasCode[line] = true;
      break;
    }
  }
  return hasCode;
}

function collectTopLevelDecls(program: OxcProgram): Map<string, LocalDecl[]> {
  const map = new Map<string, LocalDecl[]>();
  const add = (name: string, decl: LocalDecl) => {
    const list = map.get(name);
    if (list) list.push(decl);
    else map.set(name, [decl]);
  };

  for (const stmt of program.body) {
    // The declaration text of an export-wrapped node starts at the statement
    // (`export …`), so unwrap but keep the statement start.
    let decl: OxcStatement | NonNullable<unknown> = stmt;
    const stmtStart = stmt.start;
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
      decl = stmt.declaration;
    } else if (
      stmt.type === "ExportDefaultDeclaration" &&
      (isFunctionDecl(stmt.declaration) ||
        stmt.declaration.type === "ClassDeclaration" ||
        stmt.declaration.type === "TSInterfaceDeclaration")
    ) {
      decl = stmt.declaration;
    }

    const node = decl as {
      type: string;
      start: number;
      end: number;
      id?: { type: string; name?: string } | null;
      declarations?: Array<{ id: unknown; start: number; end: number }>;
    };
    switch (node.type) {
      case "FunctionDeclaration":
      case "TSDeclareFunction":
        if (node.id?.name) {
          add(node.id.name, { isFunction: true, start: stmtStart, end: node.end });
        }
        break;
      case "ClassDeclaration":
        if (node.id?.name) {
          add(node.id.name, {
            isFunction: false,
            start: declTextStart(stmtStart, node),
            end: node.end,
          });
        }
        break;
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSEnumDeclaration":
        if (node.id?.name) {
          add(node.id.name, { isFunction: false, start: stmtStart, end: node.end });
        }
        break;
      case "TSModuleDeclaration":
        if (node.id?.type === "Identifier" && node.id.name) {
          add(node.id.name, { isFunction: false, start: stmtStart, end: node.end });
        }
        break;
      case "VariableDeclaration":
        for (const declarator of node.declarations ?? []) {
          collectBindingNames(declarator.id, declarator.start, declarator.end, (name, s, e) =>
            add(name, { isFunction: false, start: s, end: e }),
          );
        }
        break;
    }
  }
  return map;
}

// Walk a declarator's binding target down to leaf binding elements, mirroring
// which node the checker reports as each name's declaration:
//   - plain `x = 1`: the whole declarator;
//   - object/array patterns: the leaf BindingElement (`a`, `b: c`, `d = 1`,
//     `...rest`), recursing through nested patterns.
function collectBindingNames(
  id: unknown,
  declaratorStart: number,
  declaratorEnd: number,
  add: (name: string, start: number, end: number) => void,
): void {
  const node = id as { type: string; name?: string; start: number; end: number };
  if (node.type === "Identifier") {
    if (node.name) add(node.name, declaratorStart, declaratorEnd);
    return;
  }
  collectPatternNames(node, add);
}

function collectPatternNames(
  pattern: unknown,
  add: (name: string, start: number, end: number) => void,
): void {
  const node = pattern as {
    type: string;
    start: number;
    end: number;
    properties?: unknown[];
    elements?: unknown[];
  };
  if (node.type === "ObjectPattern") {
    for (const prop of node.properties ?? []) {
      collectPatternMember(prop, add);
    }
  } else if (node.type === "ArrayPattern") {
    for (const element of node.elements ?? []) {
      if (element) collectPatternMember(element, add);
    }
  }
}

// One pattern member: a Property (object), a positional element (array), or a
// RestElement. The member's own span is the BindingElement text that gets
// hashed ("a", "b: c", "d = 1", "...rest"); nested patterns recurse to their
// leaves instead.
function collectPatternMember(
  member: unknown,
  add: (name: string, start: number, end: number) => void,
): void {
  const node = member as {
    type: string;
    start: number;
    end: number;
    name?: string;
    value?: unknown;
    argument?: unknown;
    left?: unknown;
  };
  const leaf = (target: unknown) => {
    const t = target as { type: string; name?: string; left?: unknown };
    if (t.type === "Identifier") {
      if (t.name) add(t.name, node.start, node.end);
    } else if (t.type === "AssignmentPattern") {
      const left = t.left as { type: string; name?: string };
      if (left.type === "Identifier") {
        if (left.name) add(left.name, node.start, node.end);
      } else {
        collectPatternNames(left, add);
      }
    } else {
      collectPatternNames(t, add);
    }
  };

  if (node.type === "Property") {
    leaf(node.value);
  } else if (node.type === "RestElement") {
    leaf(node.argument);
  } else {
    leaf(node);
  }
}

// `export { a as b }` names can be identifiers or string literals
// (`export { a as "b-c" }`); the symbol name is the literal's VALUE.
function moduleExportName(node: unknown): string | undefined {
  const n = node as { type: string; name?: string; value?: unknown };
  if (n.type === "Identifier") return n.name;
  return typeof n.value === "string" ? n.value : undefined;
}

// ---------------------------------------------------------------------------
// Import / re-export edges
// ---------------------------------------------------------------------------

interface ImportRef {
  specifier: string;
  hasDefault: boolean;
  hasNamespace: boolean;
  // Original (pre-alias) names of named imports, as source text —
  // string-literal import names keep their quotes.
  named: string[];
}

// A `export … from "./x"` re-export. `named` carries the per-specifier
// `{ local, exported }` name pairs for `export { local as exported } from`
// (empty for `export *` / `export * as ns`, which have no enumerable names at
// parse time). specs/018: `export * as ns from` sets `nsName` (S2 — parser
// materializes `symbol:B#ns → file:O` per-symbol on top of the file-grain
// edge). Plain `export * from` sets `isPlainStar` (§3 side-channel candidate,
// consumed by builder star-expansion). The two flags are mutually exclusive
// and both come strictly from the well-formed AST path — the fatal-syntax
// fallback below cannot distinguish `export *` from `export { x } from`, so
// it leaves both flags off and stays file-grain (§10 known limit).
interface ReexportRef {
  specifier: string;
  named: Array<{ local: string; exported: string }>;
  nsName?: string;
  isPlainStar?: boolean;
}

// specs/018 §6: per-file import binding table used by S3 materialization
// (source-null `export { x }` and `export default X` forms). Keyed by the
// LOCAL name introduced into the file's scope; the origin's export name is
// captured separately for the "named" kind so `import { y as z } from …;
// export { z }` maps correctly to origin export `y`.
type ImportBinding =
  | { kind: "default"; specifier: string }
  | { kind: "namespace"; specifier: string }
  | { kind: "named"; specifier: string; imported: string };

// A source-null `export { … }` statement (specs/018 §6 S3-C4). Materialized
// after the reexport loop so shadowing / origin resolution can consult the
// same `importBindings` table and reuse the existing resolveRelativeImport +
// synthReexportHash helpers.
interface SourceNullNamedReexport {
  specifiers: Array<{ localName: string; exportedName: string }>;
}

function extractImports(
  parsed: OxcParseResult,
  content: string,
  relPath: string,
  filePath: string,
  rootDir: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  mode: "file" | "symbol",
  isTest: boolean,
  ctx: ResolverContext,
): { starExports: string[] } {
  const importRefs: ImportRef[] = [];
  const reexportRefs: ReexportRef[] = [];
  // specs/018 §6: build the local-name → origin-binding table BEFORE the main
  // statement walk. S3 branches below consult this to look up the origin
  // module of every locally-defined name that is later re-exported without a
  // `from` clause. Bare-specifier / unresolvable bindings are still recorded
  // here so lookups return the correct binding kind; the specifier-relative
  // check is applied at materialization time (§6 "実体化の前提ガード").
  //
  // The wrapped CJS-style `import m = require(...)` binding is deliberately
  // omitted: its origin uses `export =` which extractSymbols cannot emit
  // symbol nodes for, so S3-C3/C4 through it would only synthesize edges to
  // a `symbol:m#*` id that will never exist. The existing #187 file-grain
  // fail-safe (via the `namespace` ImportRef) still applies.
  const importBindings = new Map<string, ImportBinding>();
  const sourceNullNamedReexports: SourceNullNamedReexport[] = [];
  const defaultIdentReexports: string[] = [];

  if (parsed.program.body.length > 0) {
    // Pass 0 (specs/018 §6): collect importBindings from every
    // ImportDeclaration. `import type` (`importKind: "type"`) is treated
    // identically — an `export type { X }` re-export of a `import type { X }`
    // binding is a valid pass-through and origin type symbols exist.
    for (const stmt of parsed.program.body) {
      if (stmt.type !== "ImportDeclaration") continue;
      const specifier = stmt.source.value;
      for (const spec of stmt.specifiers ?? []) {
        if (spec.type === "ImportDefaultSpecifier") {
          if (spec.local.name) {
            importBindings.set(spec.local.name, { kind: "default", specifier });
          }
        } else if (spec.type === "ImportNamespaceSpecifier") {
          if (spec.local.name) {
            importBindings.set(spec.local.name, { kind: "namespace", specifier });
          }
        } else {
          // ImportSpecifier. `imported` is the origin's export name (the
          // pre-alias half of `import { y as z }` — `y`); `local.name` is the
          // in-scope name (`z`). String-literal import names are handled by
          // moduleExportName, which returns the literal's value.
          const imported = moduleExportName(spec.imported);
          const localName = spec.local.name;
          if (imported !== undefined && localName) {
            importBindings.set(localName, { kind: "named", specifier, imported });
          }
        }
      }
    }

    for (const stmt of parsed.program.body) {
      if (stmt.type === "ImportDeclaration") {
        const ref: ImportRef = {
          specifier: stmt.source.value,
          hasDefault: false,
          hasNamespace: false,
          named: [],
        };
        for (const spec of stmt.specifiers ?? []) {
          if (spec.type === "ImportDefaultSpecifier") ref.hasDefault = true;
          else if (spec.type === "ImportNamespaceSpecifier") ref.hasNamespace = true;
          else ref.named.push(content.slice(spec.imported.start, spec.imported.end));
        }
        importRefs.push(ref);
      } else if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
        // `export { a as b } from "./x"` — capture the local (origin export
        // name) → exported (barrel export name) pairs so the barrel can be
        // materialized per-symbol. `export type { … } from` re-exports the
        // same way (origin type symbols exist), so it is NOT filtered out.
        const named: Array<{ local: string; exported: string }> = [];
        for (const spec of stmt.specifiers ?? []) {
          const local = moduleExportName(spec.local);
          const exported = moduleExportName(spec.exported);
          if (local !== undefined && exported !== undefined) named.push({ local, exported });
        }
        reexportRefs.push({ specifier: stmt.source.value, named });
      } else if (stmt.type === "ExportAllDeclaration") {
        // `export *` / `export * as ns`. Both keep the pre-existing file-grain
        // edge (`file:B → file:O`) as an additive fail-safe. specs/018:
        //   - `export * as ns from "./o"` → nsName carries the ns identifier
        //     so the materialization loop can emit `symbol:B#ns → file:O`
        //     (S2, contentHash = synthReexportHash(O, "*", ns));
        //   - plain `export * from "./o"` → isPlainStar flags it as an
        //     exportedNames provider for the builder's star-expansion pass
        //     (§5). The resolved rootDir-relative target is captured into
        //     the `starExports` side-channel below.
        let nsName: string | undefined;
        if (stmt.exported) nsName = moduleExportName(stmt.exported);
        reexportRefs.push({
          specifier: stmt.source.value,
          named: [],
          nsName,
          isPlainStar: nsName === undefined,
        });
      } else if (
        stmt.type === "ExportNamedDeclaration" &&
        !stmt.source &&
        stmt.specifiers.length > 0
      ) {
        // specs/018 §6 S3-C4: `import { x } from "./m"; export { x as y };`
        // (also `import X from "./a"; export { X };` and namespace forms).
        // Collected here in source order; per-specifier materialization —
        // which consults `importBindings` and applies the shadowing /
        // relative-specifier / resolver guards — runs after the main reexport
        // loop below.
        //
        // The `stmt.specifiers.length > 0` clause deliberately excludes the
        // #187 `export import m = require(...)` shape: its wrapped
        // ExportNamedDeclaration has empty specifiers, so it falls through
        // to the TSImportEqualsDeclaration branch below where it's mapped to
        // a namespace ImportRef.
        const specs: Array<{ localName: string; exportedName: string }> = [];
        for (const spec of stmt.specifiers) {
          const localName = moduleExportName(spec.local);
          const exportedName = moduleExportName(spec.exported);
          if (localName !== undefined && exportedName !== undefined) {
            specs.push({ localName, exportedName });
          }
        }
        if (specs.length > 0) sourceNullNamedReexports.push({ specifiers: specs });
      } else if (
        stmt.type === "ExportDefaultDeclaration" &&
        stmt.declaration.type === "Identifier"
      ) {
        // specs/018 §6 S3-C3: `import X from "./a"; export default X;` (and
        // named / namespace forms). extractSymbols only pushes
        // `symbol:B#default` when the identifier resolves to a LOCAL
        // top-level declaration (its L484-488 branch); when the identifier
        // was imported, `lookup` returns undefined and no local symbol node
        // exists — so materializing `symbol:B#default → symbol:origin#…`
        // here does not clobber anything. Collected in source order for
        // materialization after the reexport loop.
        defaultIdentReexports.push(stmt.declaration.name);
      } else {
        // `import m = require("./m")` (CJS-style TS). Treat as a namespace
        // import so symbol mode falls back to a file-grain edge — the
        // require target has no named specifiers to route per-symbol
        // through, and its origin uses `export =` which extractSymbols
        // does not materialize (no local symbols on TSExportAssignment),
        // so the origin's `@impl` stays at file grain regardless. Closes
        // issue #187's fail-open.
        //
        // The declaration appears in TWO AST shapes: as a top-level
        // `TSImportEqualsDeclaration`, and — when written as `export
        // import m = require(...)` — wrapped in `ExportNamedDeclaration
        // { declaration: TSImportEqualsDeclaration, source: null }`. The
        // wrapped form is not caught by the earlier `stmt.source` branch
        // (source is null) so it needs its own path here.
        //
        // Known limit: files with fatal syntax errors take the
        // `staticImports` fallback below, and oxc's module record only
        // tracks ESM shape — CJS-style `import = require` in a broken
        // file still fails open. Acceptable regression baseline: the
        // pre-fix behavior was ALWAYS fail-open, so this is strictly no
        // worse.
        const eq =
          stmt.type === "TSImportEqualsDeclaration"
            ? stmt
            : stmt.type === "ExportNamedDeclaration" &&
                stmt.declaration?.type === "TSImportEqualsDeclaration"
              ? stmt.declaration
              : undefined;
        if (eq && eq.moduleReference.type === "TSExternalModuleReference") {
          const specifier = eq.moduleReference.expression?.value;
          if (typeof specifier === "string") {
            importRefs.push({ specifier, hasDefault: false, hasNamespace: true, named: [] });
          }
        }
      }
    }
  } else {
    // Fatal syntax error: the AST is empty but oxc's module record still
    // carries the import/export shape — use it so import edges survive for
    // files that are temporarily unparseable. Re-export names are not
    // recovered here (best-effort), so barrels in a broken file stay
    // file-grain until the file parses again.
    for (const staticImport of parsed.module.staticImports) {
      const ref: ImportRef = {
        specifier: staticImport.moduleRequest.value,
        hasDefault: false,
        hasNamespace: false,
        named: [],
      };
      for (const entry of staticImport.entries) {
        if (entry.importName.kind === "NamespaceObject") ref.hasNamespace = true;
        else if (entry.importName.kind === "Default") ref.hasDefault = true;
        else if (entry.importName.kind === "Name") {
          ref.named.push(
            entry.importName.start != null
              ? content.slice(entry.importName.start, entry.importName.end ?? undefined)
              : (entry.importName.name ?? ""),
          );
        }
      }
      importRefs.push(ref);
    }
    for (const staticExport of parsed.module.staticExports) {
      const request = staticExport.entries.find((e) => e.moduleRequest != null)?.moduleRequest;
      if (request) reexportRefs.push({ specifier: request.value, named: [] });
    }
  }

  const sourceId = `file:${relPath}`;
  const useSymbol = mode === "symbol" && !isTest;

  // All import edges first, then re-export edges (two separate statement
  // loops — matching the original backend's edge order).
  for (const ref of importRefs) {
    if (!ref.specifier.startsWith(".")) continue;
    const resolved = resolveRelativeImport(filePath, ref.specifier, ctx);
    if (!resolved) continue;
    const targetRel = relative(rootDir, resolved);

    if (useSymbol) {
      if (ref.hasNamespace) {
        edges.push({
          source: sourceId,
          target: `file:${targetRel}`,
          kind: "imports",
          provenances: ["ts-import"],
        });
      } else {
        if (ref.hasDefault) {
          edges.push({
            source: sourceId,
            target: `symbol:${targetRel}#default`,
            kind: "imports",
            provenances: ["ts-import"],
          });
        }
        for (const importName of ref.named) {
          edges.push({
            source: sourceId,
            target: `symbol:${targetRel}#${importName}`,
            kind: "imports",
            provenances: ["ts-import"],
          });
        }
        if (!ref.hasDefault && ref.named.length === 0) {
          edges.push({
            source: sourceId,
            target: `file:${targetRel}`,
            kind: "imports",
            provenances: ["ts-import"],
          });
        }
      }
    } else {
      edges.push({
        source: sourceId,
        target: `file:${targetRel}`,
        kind: "imports",
        provenances: ["ts-import"],
      });
    }
  }

  // Names already declared locally in this file win over a same-name
  // re-export (legal shadowing / illegal duplicate export) — never overwrite a
  // real symbol node with a re-export pass-through of the same id. Every
  // synthesized S2/S3 node adds its id to the set as it is emitted, so a
  // later synth in the same file (rare — typically an illegal duplicate
  // export) cannot overwrite an earlier one.
  const localSymbolIds = new Set(nodes.filter((n) => n.kind === "symbol").map((n) => n.id));

  // specs/018 §3 side-channel. Populated below only for plain `export *`
  // sources in symbol mode on a non-test file whose specifier resolves to a
  // real module (relative + resolved). Deduped by first occurrence so a
  // duplicate `export * from "./o"` (or two specifiers that resolve to the
  // same file) collapses into a single provider — the design's §5 dedup
  // rationale for the builder starMap holds here too.
  const starExports: string[] = [];
  const starExportsSeen = new Set<string>();

  for (const rex of reexportRefs) {
    if (!rex.specifier.startsWith(".")) continue;
    const resolved = resolveRelativeImport(filePath, rex.specifier, ctx);
    if (!resolved) continue;
    const targetRel = relative(rootDir, resolved);

    if (useSymbol && rex.named.length > 0) {
      // Materialize the barrel's re-exported symbols and point each at the
      // origin symbol, so `file:consumer --imports--> symbol:barrel#name`
      // (emitted by the consumer's import loop above) resolves to a real node
      // and forward BFS chains barrel -> origin -> REQ. Multi-level barrels
      // chain naturally because each origin file materializes its own nodes.
      for (const { local, exported } of rex.named) {
        const barrelSymId = `symbol:${relPath}#${exported}`;
        // Node AND edge are guarded together: a local declaration that
        // shadows a same-name re-export wins the node identity, and the
        // re-export edge is dropped along with it (impact BFS is
        // bidirectional — a spurious `symbol:barrel#foo -> symbol:origin#foo`
        // edge on a shadowed name would false-positive the origin's REQ into
        // the consumer's blast radius). Per-symbol hash uses the specs/018
        // §4 SSOT (`synthReexportHash`) so adding/removing a sibling specifier
        // in the same `export { … } from` statement does not drift the
        // surviving names' hashes (INV-L4 noise).
        if (!localSymbolIds.has(barrelSymId)) {
          nodes.push({
            id: barrelSymId,
            kind: "symbol",
            filePath: relPath,
            contentHash: synthReexportHash(targetRel, local, exported),
          });
          localSymbolIds.add(barrelSymId);
          edges.push({
            source: barrelSymId,
            target: `symbol:${targetRel}#${local}`,
            kind: "imports",
            provenances: ["ts-import"],
          });
        }
      }
    } else if (useSymbol && rex.nsName !== undefined) {
      // specs/018 §6 S2: `export * as ns from "./o"`. The file-grain edge
      // (`file:B → file:O`) is preserved as an additive fail-safe (an
      // exported namespace is by definition a whole-module binding, and
      // `entryOriginIds` / impact BFS still route file-unit inputs through
      // it); on top of that a `symbol:B#ns → file:O` symbol node/edge lets
      // consumer named/namespace imports of `ns` resolve at symbol grain.
      // The single edge target is `file:O` — not a per-name symbol — because
      // `ns` binds the whole module (no origin export name in play).
      edges.push({
        source: sourceId,
        target: `file:${targetRel}`,
        kind: "imports",
        provenances: ["ts-import"],
      });
      const barrelSymId = `symbol:${relPath}#${rex.nsName}`;
      if (!localSymbolIds.has(barrelSymId)) {
        nodes.push({
          id: barrelSymId,
          kind: "symbol",
          filePath: relPath,
          contentHash: synthReexportHash(targetRel, "*", rex.nsName),
        });
        localSymbolIds.add(barrelSymId);
        edges.push({
          source: barrelSymId,
          target: `file:${targetRel}`,
          kind: "imports",
          provenances: ["ts-import"],
        });
      }
    } else {
      // Everything else: plain `export *` in symbol mode, or ANY re-export in
      // file mode / test files. Emit only the file-grain edge; per-name
      // precision for star (§5) is the builder star-expansion's job. Plain
      // `export *` is captured into the side-channel here so the builder
      // sees the origin resolved rel path, which matters for warm cache
      // correctness (an origin file's rel path can only be computed with
      // the resolver context this parse owns).
      edges.push({
        source: sourceId,
        target: `file:${targetRel}`,
        kind: "imports",
        provenances: ["ts-import"],
      });
      if (useSymbol && rex.isPlainStar) {
        if (!starExportsSeen.has(targetRel)) {
          starExportsSeen.add(targetRel);
          starExports.push(targetRel);
        }
      }
    }
  }

  // specs/018 §6 S3-C4: source-null `export { … }` synthesizes barrel-side
  // symbol nodes/edges that consumer named imports can resolve against, so
  // `import { x } from m; export { x }` becomes lock-byte equivalent to
  // `export { x } from m` (§4 refactor-equivalence). Runs only in symbol
  // mode on non-test files (matches the useSymbol gate all per-symbol
  // materialization uses).
  if (useSymbol) {
    for (const { specifiers } of sourceNullNamedReexports) {
      for (const { localName, exportedName } of specifiers) {
        const barrelSymId = `symbol:${relPath}#${exportedName}`;
        // Shadowing: a real local declaration OR an earlier synth (source
        // order — pass 1 functions-first, then any #177/S2 synth above) with
        // the same exported name wins. Prevents spurious edges from an
        // illegal duplicate export.
        if (localSymbolIds.has(barrelSymId)) continue;
        const binding = importBindings.get(localName);
        if (!binding) continue;
        // Bare-specifier / unresolvable guard (§6). §4 hash-input pin: the
        // resolved rootDir-relative target must exist — a bare or
        // node_modules specifier is skipped exactly as consumer imports of
        // the same specifier are today.
        if (!binding.specifier.startsWith(".")) continue;
        const resolved = resolveRelativeImport(filePath, binding.specifier, ctx);
        if (!resolved) continue;
        const targetRel = relative(rootDir, resolved);
        const { originBinding, edgeTarget } = mapS3OriginBinding(binding, targetRel);
        nodes.push({
          id: barrelSymId,
          kind: "symbol",
          filePath: relPath,
          contentHash: synthReexportHash(targetRel, originBinding, exportedName),
        });
        localSymbolIds.add(barrelSymId);
        edges.push({
          source: barrelSymId,
          target: edgeTarget,
          kind: "imports",
          provenances: ["ts-import"],
        });
      }
    }

    // specs/018 §6 S3-C3: `export default <Identifier>` where the identifier
    // is imported. The exported name is unconditionally `"default"`; the
    // rest of the resolution / shadowing / bare-specifier logic is identical
    // to S3-C4 above.
    for (const localName of defaultIdentReexports) {
      const barrelSymId = `symbol:${relPath}#default`;
      if (localSymbolIds.has(barrelSymId)) continue;
      const binding = importBindings.get(localName);
      if (!binding) continue;
      if (!binding.specifier.startsWith(".")) continue;
      const resolved = resolveRelativeImport(filePath, binding.specifier, ctx);
      if (!resolved) continue;
      const targetRel = relative(rootDir, resolved);
      const { originBinding, edgeTarget } = mapS3OriginBinding(binding, targetRel);
      nodes.push({
        id: barrelSymId,
        kind: "symbol",
        filePath: relPath,
        contentHash: synthReexportHash(targetRel, originBinding, "default"),
      });
      localSymbolIds.add(barrelSymId);
      edges.push({
        source: barrelSymId,
        target: edgeTarget,
        kind: "imports",
        provenances: ["ts-import"],
      });
    }
  }

  return { starExports };
}

// specs/018 §4 origin-binding table for S3 (both C3 and C4 forms). Maps the
// resolved ImportBinding to (originBinding-name, edge target-id) exactly per
// the design's table:
//   default    → "default" / `symbol:target#default`
//   named y    → y         / `symbol:target#y`
//   namespace  → "*"        / `file:target`
// Kept as one helper so the two S3 loops share a single mapping and the
// hash-input contract (`[targetRel, originBinding, exportedName]`) never
// drifts between them.
function mapS3OriginBinding(
  binding: ImportBinding,
  targetRel: string,
): { originBinding: string; edgeTarget: string } {
  if (binding.kind === "default") {
    return { originBinding: "default", edgeTarget: `symbol:${targetRel}#default` };
  }
  if (binding.kind === "namespace") {
    return { originBinding: "*", edgeTarget: `file:${targetRel}` };
  }
  return {
    originBinding: binding.imported,
    edgeTarget: `symbol:${targetRel}#${binding.imported}`,
  };
}

// ---------------------------------------------------------------------------
// Relative module specifier resolution
// ---------------------------------------------------------------------------

// Differential probing against the TS checker (via ts-morph) across tsconfig
// variants showed the resolution outcome depends only on these three options.
// In particular moduleResolution (node16 vs node10 vs bundler) and
// package.json "type" do NOT change it — the checker resolves extensionless
// relative specifiers even under node16, and .tsx / .js / .json availability
// is gated purely by jsx / allowJs / resolveJsonModule.
interface ResolverContext {
  jsx: boolean;
  allowJs: boolean;
  resolveJsonModule: boolean;
  moduleCheckCache: Map<string, boolean>;
}

function createResolverContext(rootDir: string): ResolverContext {
  // Only <rootDir>/tsconfig.json is consulted (no upward walk); without it,
  // compiler defaults apply (all three off).
  const options = readTsconfigResolveOptions(resolve(rootDir, "tsconfig.json"));
  return { ...options, moduleCheckCache: new Map() };
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  ctx: ResolverContext,
): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  // `./dir/` is directory-only; `./x` tries file forms first, then directory
  // (a directory literally named `x.js` still resolves via its index).
  let resolved = specifier.endsWith("/") ? undefined : resolveAsFile(base, ctx);
  if (resolved === undefined && isDirectory(base)) {
    resolved = resolveAsDirectory(base, ctx);
  }
  if (resolved === undefined) return undefined;
  // The checker only hands out a symbol for MODULE targets: a script target
  // (no import/export syntax) produces no edge. JSON modules are implicit.
  if (!resolved.endsWith(".json") && !isModuleFile(resolved, ctx)) return undefined;
  return resolved;
}

// Extension probe order replicated from TS resolution behavior:
// .ts, .tsx, .d.ts, .js (allowJs), .jsx (jsx AND allowJs). `.tsx` is ALWAYS
// probed, but without the jsx option a .tsx match is discarded — and shadows
// every lower-priority candidate (an x.tsx on disk hides x.d.ts and x.js).
function probeSubstitution(base: string, ctx: ResolverContext): string | undefined {
  const extensions = [".ts", ".tsx", ".d.ts"];
  if (ctx.allowJs) extensions.push(".js");
  if (ctx.allowJs && ctx.jsx) extensions.push(".jsx");
  for (const extension of extensions) {
    if (isFile(base + extension)) {
      if (extension === ".tsx" && !ctx.jsx) return undefined;
      return base + extension;
    }
  }
  return undefined;
}

function probeExtensions(base: string, extensions: string[]): string | undefined {
  for (const extension of extensions) {
    if (isFile(base + extension)) return base + extension;
  }
  return undefined;
}

function resolveAsFile(candidate: string, ctx: ResolverContext): string | undefined {
  if (candidate.endsWith(".tsx")) {
    return ctx.jsx && isFile(candidate) ? candidate : undefined;
  }
  if (/\.[mc]?ts$/.test(candidate)) {
    // .ts / .mts / .cts (and .d.ts / .d.mts / .d.cts): exact file only.
    return isFile(candidate) ? candidate : undefined;
  }
  if (candidate.endsWith(".json")) {
    return ctx.resolveJsonModule && isFile(candidate) ? candidate : undefined;
  }
  if (/\.jsx?$/.test(candidate)) {
    return probeSubstitution(candidate.replace(/\.jsx?$/, ""), ctx);
  }
  if (candidate.endsWith(".mjs")) {
    const extensions = [".mts", ".d.mts"];
    if (ctx.allowJs) extensions.push(".mjs");
    return probeExtensions(candidate.slice(0, -".mjs".length), extensions);
  }
  if (candidate.endsWith(".cjs")) {
    const extensions = [".cts", ".d.cts"];
    if (ctx.allowJs) extensions.push(".cjs");
    return probeExtensions(candidate.slice(0, -".cjs".length), extensions);
  }
  // Extensionless (or an unrecognized extension): append and probe.
  // .mts/.cts are deliberately NOT probed here — tsc doesn't either.
  return probeSubstitution(candidate, ctx);
}

function resolveAsDirectory(dir: string, ctx: ResolverContext): string | undefined {
  const pkgPath = resolve(dir, "package.json");
  if (isFile(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      pkg = undefined;
    }
    if (pkg && typeof pkg === "object") {
      const fields = pkg as { types?: unknown; typings?: unknown; main?: unknown };
      const types =
        typeof fields.types === "string"
          ? fields.types
          : typeof fields.typings === "string"
            ? fields.typings
            : undefined;
      // A present-but-unresolvable "types" field suppresses "main" and falls
      // through to index resolution (tsc consults main only when no types
      // field exists at all).
      const target = types ?? (typeof fields.main === "string" ? fields.main : undefined);
      if (target !== undefined) {
        const resolved = resolveAsFile(resolve(dir, target), ctx);
        if (resolved) return resolved;
      }
    }
  }
  return probeSubstitution(resolve(dir, "index"), ctx);
}

// A resolved target only yields an import edge when TS treats it as a module:
// it has ESM syntax (import/export/import.meta — tracked by oxc's
// error-tolerant module record even for broken files), `export =`, or
// `import x = require(...)`.
function isModuleFile(filePath: string, ctx: ResolverContext): boolean {
  const cached = ctx.moduleCheckCache.get(filePath);
  if (cached !== undefined) return cached;

  let result = false;
  try {
    const content = stripBom(readFileSync(filePath, "utf-8"));
    const parsed = loadOxc().parseSync(filePath, content);
    result =
      parsed.module.hasModuleSyntax ||
      parsed.program.body.some(
        (stmt) =>
          stmt.type === "TSExportAssignment" ||
          (stmt.type === "TSImportEqualsDeclaration" &&
            stmt.moduleReference.type === "TSExternalModuleReference"),
      );
  } catch {
    result = false;
  }
  ctx.moduleCheckCache.set(filePath, result);
  return result;
}

// ---------------------------------------------------------------------------
// tsconfig reading (jsx / allowJs / resolveJsonModule only)
// ---------------------------------------------------------------------------

const JSX_VALUES = new Set(["preserve", "react", "react-native", "react-jsx", "react-jsxdev"]);

interface ResolveOptions {
  jsx: boolean;
  allowJs: boolean;
  resolveJsonModule: boolean;
}

function readTsconfigResolveOptions(tsconfigPath: string): ResolveOptions {
  // Collect the extends chain leaf-first, then apply base-to-leaf so nearer
  // configs override. Known limit: "extends" is resolved best-effort
  // (relative paths and a node_modules walk for package-style values);
  // exotic setups (extends arrays, "rootDirs", package "exports"-mapped
  // configs) are not followed.
  const chain: Array<Record<string, unknown>> = [];
  const visited = new Set<string>();
  let current: string | undefined = tsconfigPath;
  while (current !== undefined && !visited.has(current) && isFile(current)) {
    visited.add(current);
    const parsed = parseJsonc(readFileSync(current, "utf-8"));
    if (!parsed || typeof parsed !== "object") break;
    const config = parsed as Record<string, unknown>;
    chain.push(config);
    current =
      typeof config.extends === "string"
        ? resolveExtendsPath(dirname(current), config.extends)
        : undefined;
  }

  const options: ResolveOptions = { jsx: false, allowJs: false, resolveJsonModule: false };
  for (let i = chain.length - 1; i >= 0; i--) {
    const compilerOptions = chain[i].compilerOptions;
    if (!compilerOptions || typeof compilerOptions !== "object") continue;
    const co = compilerOptions as Record<string, unknown>;
    if (co.jsx !== undefined) {
      options.jsx = typeof co.jsx === "string" && JSX_VALUES.has(co.jsx.toLowerCase());
    }
    if (co.allowJs !== undefined) options.allowJs = co.allowJs === true;
    if (co.resolveJsonModule !== undefined) {
      options.resolveJsonModule = co.resolveJsonModule === true;
    }
  }
  return options;
}

function resolveExtendsPath(fromDir: string, extendsValue: string): string | undefined {
  const tryJson = (p: string): string | undefined =>
    isFile(p) ? p : !p.endsWith(".json") && isFile(`${p}.json`) ? `${p}.json` : undefined;
  if (extendsValue.startsWith(".") || extendsValue.startsWith("/")) {
    return tryJson(resolve(fromDir, extendsValue));
  }
  // Package-style extends ("@tsconfig/node22"): best-effort node_modules
  // lookup from the config's directory upward.
  let dir = fromDir;
  for (;;) {
    const base = resolve(dir, "node_modules", extendsValue);
    const found = tryJson(base) ?? tryJson(resolve(base, "tsconfig.json"));
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// tsconfig.json is JSONC: strip comments (string-aware), then parse; retry
// with trailing commas removed if strict parsing fails.
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < text.length) {
        out += text[i];
        if (text[i] === "\\") {
          out += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  try {
    return JSON.parse(out);
  } catch {
    try {
      return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Requirement-ID tag extraction (plain-text regex — needs no AST)
// ---------------------------------------------------------------------------

function extractImplTags(
  content: string,
  relPath: string,
  isTest: boolean,
  edges: GraphEdge[],
  mode: "file" | "symbol" = "file",
  symbolRanges: SymbolRange[] = [],
  matchers: IdMatchers = buildIdMatchers(),
  comments?: readonly OxcComment[],
) {
  const { implRe, reqIdRe, testReqRe, testAnnotationRe } = matchers;
  const fileSourceId = `file:${relPath}`;

  let match: RegExpExecArray | null;

  implRe.lastIndex = 0;
  while ((match = implRe.exec(content)) !== null) {
    // D6: a `// @impl …` counts only when its `//` is a REAL line comment. The
    // same text inside a string / template / JSX attribute (no comment span at
    // all) or inside a block/JSDoc comment (e.g. a backtick-quoted `// @impl`
    // in docs, type "Block") is not a tag and must not emit an edge. `comments`
    // is undefined only for pathological unparseable input; there we keep the
    // regex-only behavior so a broken file's tags still survive.
    if (comments && !matchInLineComment(comments, match.index)) continue;

    const reqIds = match[1].match(reqIdRe);
    if (!reqIds) continue;

    let sourceIds = [fileSourceId];

    if (mode === "symbol" && !isTest && symbolRanges.length > 0) {
      const line = lineNumberAt(content, match.index);
      // D1: resolveSymbolsAtLine groups siblings by declaration STATEMENT and
      // returns one group. A leading tag above `export const a = 1, b = 2` /
      // `export const { a, b } = …` binds to every sibling of that one
      // statement; a tag above separate exports (even on the same physical
      // line) lands only on the innermost/first group, never across statements.
      const resolved = resolveSymbolsAtLine(symbolRanges, line);
      if (resolved.length > 0) {
        sourceIds = resolved.map((name) => `symbol:${relPath}#${name}`);
      }
    }

    for (const sourceId of sourceIds) {
      for (const reqId of reqIds) {
        edges.push({
          source: sourceId,
          target: reqId,
          kind: "implements",
          provenances: ["code-tag"],
        });
      }
    }
  }

  if (isTest) {
    testReqRe.lastIndex = 0;
    while ((match = testReqRe.exec(content)) !== null) {
      const reqId = match[0].slice(1, -1);
      edges.push({
        source: fileSourceId,
        target: reqId,
        kind: "verifies",
        provenances: ["code-tag"],
      });
    }

    testAnnotationRe.lastIndex = 0;
    while ((match = testAnnotationRe.exec(content)) !== null) {
      edges.push({
        source: fileSourceId,
        target: match[1],
        kind: "verifies",
        provenances: ["code-tag"],
      });
    }
  }
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// The names of the symbol GROUP whose attribution range encloses `line`,
// narrowed to the smallest (innermost) enclosing range. Grouping is per
// declaration STATEMENT: every sibling binding of one `export const a = 1, b =
// 2` / `export const { a, b } = …` shares one group and one statement-wide
// attribution span, so a leading tag binds to all of them; every other export
// (function, class, specifier, default, a separate statement) is its own group.
// Exactly ONE group is selected — never merged across groups — and a same-size
// tie keeps the group found FIRST in source order. This closes two boundary
// gaps of the old line-range approximation: same-line distinct exports no
// longer over-broadcast (different groups, only the first wins), and a
// multi-line multi-declarator no longer drops later siblings (one group spans
// the whole statement).
function resolveSymbolsAtLine(ranges: SymbolRange[], line: number): string[] {
  let bestGroup: number | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (line < range.startLine || line > range.endLine) continue;
    const size = range.endLine - range.startLine;
    if (size < bestSize) {
      bestSize = size;
      bestGroup = range.group;
    }
    // Same-size tie: keep the first group found (source order) — do nothing.
  }
  if (bestGroup === null) return [];
  return ranges
    .filter((r) => r.group === bestGroup && line >= r.startLine && line <= r.endLine)
    .map((r) => r.name);
}

// True when `index` (the `//` offset of an @impl match) lands inside a real
// LINE comment. Block/JSDoc comments (type "Block") and string / template /
// JSX-attribute literals (no comment span covering the offset) are excluded,
// so a `// @impl` appearing there is not treated as a tag (D6).
function matchInLineComment(comments: readonly OxcComment[], index: number): boolean {
  for (const c of comments) {
    if (c.type === "Line" && index >= c.start && index < c.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Line numbers (1-based, counted at the trivia-free span offsets) and misc
// ---------------------------------------------------------------------------

function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// specs/018 §4 SSOT — single deterministic contentHash for every synthesized
// re-export symbol node (barrel-side #177 named/aliased re-exports, S1 star
// expansion in builder.ts, S2 `export * as ns`, S3 imported-identifier
// re-export). Input is resolved rootDir-relative target path, origin-side
// binding name (`"default"` | `"*"` | origin export name), and the name the
// barrel exposes. Determinism (no file-walk order, no OS variance) is the
// pin behind INV-L4 and the §4 refactor-equivalence property
// (`export *` ⇔ enumerated `export { x } from`, `import { x }; export { x }`
// ⇔ `export { x } from` all yield byte-identical lock).
export function synthReexportHash(
  targetRel: string,
  originBinding: string,
  exportedName: string,
): string {
  return hash([targetRel, originBinding, exportedName].join("\0"));
}
