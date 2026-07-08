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
// parser. The output contract is bit-for-bit what the ts-morph backend
// produced — node/edge ARRAY ORDER and contentHash values included — so
// existing `.trace.lock` files stay byte-identical across the swap (INV-L4).
// That behavior was established by differential-testing both backends over
// this repository, the test fixtures, and edge-case probes, and is now
// pinned by tests/typescript-oxc-regression.test.ts. Three pieces of
// compiler behavior are re-derived here from those empirical probes:
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
function buildIdMatchers(codeId?: string): IdMatchers {
  const token = codeId ?? NAMESPACED_ID_TOKEN;
  return {
    implRe: new RegExp(`//[^\\S\\n]*@impl[^\\S\\n]+((?:(?:${token})[^\\S\\n]*)+)`, "gm"),
    reqIdRe: new RegExp(token, "g"),
    testReqRe: new RegExp(`\\[(?:${token})]`, "g"),
    testAnnotationRe: new RegExp(`req:\\s*["']?(${token})["']?`, "g"),
  };
}

export interface ParsedTS {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
      for (const filePath of enumerateFiles(rootDir, patterns)) {
        const parsed = parseTSFile(filePath, rootDir, mode, matchers, ctx);
        nodes.push(...parsed.nodes);
        edges.push(...parsed.edges);
      }
      return { nodes, edges };
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
    symbolRanges = extractSymbols(parsed.program, content, relPath, nodes, parsed.comments);
  }
  if (parsed) {
    extractImports(parsed, content, relPath, filePath, rootDir, nodes, edges, mode, isTest, ctx);
  }
  extractImplTags(content, relPath, isTest, edges, mode, symbolRanges, matchers, parsed?.comments);

  return { nodes, edges };
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

function extractSymbols(
  program: OxcProgram,
  content: string,
  relPath: string,
  nodes: GraphNode[],
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
  ) => {
    if (seen.has(name)) return;
    seen.add(name);
    entries.push({ name, start, end, group, attrStart, attrEnd });
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
          if (decl.id)
            push(decl.id.name, declTextStart(stmt.start, decl), decl.end, groupCounter++);
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
        push("default", declTextStart(stmt.start, decl), decl.end, groupCounter++);
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
    nodes.push({
      id: `symbol:${relPath}#${entry.name}`,
      kind: "symbol",
      filePath: relPath,
      contentHash: hash(content.slice(entry.start, entry.end)),
    });
    let startLine = lineOf(lineStarts, entry.attrStart);
    while (startLine > 1 && !lineHasCode[startLine - 1]) startLine--;
    ranges.push({
      name: entry.name,
      group: entry.group,
      startLine,
      endLine: lineOf(lineStarts, entry.attrEnd),
    });
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
// parse time and stay file-grain).
interface ReexportRef {
  specifier: string;
  named: Array<{ local: string; exported: string }>;
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
): void {
  const importRefs: ImportRef[] = [];
  const reexportRefs: ReexportRef[] = [];

  if (parsed.program.body.length > 0) {
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
        // `export *` / `export * as ns` — no per-name specifiers; stays
        // file-grain. Named imports through a star barrel are closed at file
        // grain by the builder's phantom-repair pass (issue #177 follow-up
        // tracks true per-symbol star precision).
        reexportRefs.push({ specifier: stmt.source.value, named: [] });
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
  // real symbol node with a re-export pass-through of the same id.
  const localSymbolIds = new Set(nodes.filter((n) => n.kind === "symbol").map((n) => n.id));

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
        // the consumer's blast radius). Per-symbol hash uses the resolved
        // origin path + local + exported (\0-joined) so adding/removing a
        // sibling specifier in the same `export { … } from` statement does
        // not drift the surviving names' hashes (INV-L4 noise).
        if (!localSymbolIds.has(barrelSymId)) {
          nodes.push({
            id: barrelSymId,
            kind: "symbol",
            filePath: relPath,
            contentHash: hash([targetRel, local, exported].join("\0")),
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
    } else {
      edges.push({
        source: sourceId,
        target: `file:${targetRel}`,
        kind: "imports",
        provenances: ["ts-import"],
      });
    }
  }
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
