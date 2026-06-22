import { Project, type SourceFile } from "ts-morph";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { GraphNode, GraphEdge } from "../types.js";
import { NAMESPACED_ID_TOKEN } from "../req-id.js";

// Default requirement-ID *token* used when no custom `reqPatterns.codeId` is set.
// The token matches the whole ID (e.g. `FR-001`, `auth/AUTH-2`, `Requirement-3`).
// Shared with src/test-results.ts via src/req-id.ts so code tags and test-result
// REQ tags recognize the same ID shapes.
const DEFAULT_ID_TOKEN = NAMESPACED_ID_TOKEN;

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
  const token = codeId ?? DEFAULT_ID_TOKEN;
  return {
    implRe: new RegExp(`//[^\\S\\n]*@impl[^\\S\\n]+((?:(?:${token})[^\\S\\n]*)+)`, "gm"),
    reqIdRe: new RegExp(token, "g"),
    testReqRe: new RegExp(`\\[(?:${token})]`, "g"),
    testAnnotationRe: new RegExp(`req:\\s*["']?(${token})["']?`, "g"),
  };
}

interface ParsedTS {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface SymbolRange {
  name: string;
  startLine: number;
  endLine: number;
}

export function createTSParser(
  rootDir: string,
  patterns: string[],
  mode: "file" | "symbol" = "file",
  codeId?: string,
) {
  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  const projectOpts = existsSync(tsconfigPath)
    ? { tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: true }
    : { skipAddingFilesFromTsConfig: true };
  const project = new Project(projectOpts);

  for (const pattern of patterns) {
    project.addSourceFilesAtPaths(resolve(rootDir, pattern));
  }

  const matchers = buildIdMatchers(codeId);
  return { project, parse: () => parseProject(project, rootDir, mode, matchers) };
}

function parseProject(
  project: Project,
  rootDir: string,
  mode: "file" | "symbol",
  matchers: IdMatchers,
): ParsedTS {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    const relPath = relative(rootDir, filePath);

    const fileContent = sourceFile.getFullText();
    const fileHash = hash(fileContent);

    const isTest = /\.(test|spec)\.(ts|tsx)$/.test(filePath);

    nodes.push({
      id: `file:${relPath}`,
      kind: isTest ? "test" : "file",
      filePath: relPath,
      contentHash: fileHash,
    });

    let symbolRanges: SymbolRange[] = [];

    if (mode === "symbol" && !isTest) {
      symbolRanges = extractSymbols(sourceFile, relPath, nodes);
    }

    extractImports(sourceFile, relPath, rootDir, edges, mode, isTest);
    extractImplTags(fileContent, relPath, isTest, edges, mode, symbolRanges, matchers);
  }

  return { nodes, edges };
}

function extractSymbols(
  sourceFile: SourceFile,
  relPath: string,
  nodes: GraphNode[],
): SymbolRange[] {
  const ranges: SymbolRange[] = [];
  const exported = sourceFile.getExportedDeclarations();
  const seen = new Set<string>();

  for (const [name, declarations] of exported) {
    const symbolName = name === "default" ? "default" : name;
    if (seen.has(symbolName)) continue;

    const localDecl = declarations.find((d) => d.getSourceFile() === sourceFile);
    if (!localDecl) continue;

    seen.add(symbolName);
    const symbolId = `symbol:${relPath}#${symbolName}`;
    const symbolHash = hash(localDecl.getText());

    nodes.push({
      id: symbolId,
      kind: "symbol",
      filePath: relPath,
      contentHash: symbolHash,
    });

    ranges.push({
      name: symbolName,
      startLine: localDecl.getStartLineNumber(),
      endLine: localDecl.getEndLineNumber(),
    });
  }

  return ranges;
}

function extractImports(
  sourceFile: SourceFile,
  relPath: string,
  rootDir: string,
  edges: GraphEdge[],
  mode: "file" | "symbol" = "file",
  isTest: boolean = false,
) {
  const sourceId = `file:${relPath}`;
  const useSymbol = mode === "symbol" && !isTest;

  for (const decl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = decl.getModuleSpecifierValue();
    if (!moduleSpecifier.startsWith(".")) continue;

    const resolved = resolveImport(sourceFile, decl);
    if (!resolved) continue;

    const targetRel = relative(rootDir, resolved);

    if (useSymbol) {
      const namedImports = decl.getNamedImports();
      const defaultImport = decl.getDefaultImport();
      const namespaceImport = decl.getNamespaceImport();

      if (namespaceImport) {
        edges.push({ source: sourceId, target: `file:${targetRel}`, kind: "imports" });
      } else {
        if (defaultImport) {
          edges.push({ source: sourceId, target: `symbol:${targetRel}#default`, kind: "imports" });
        }
        for (const named of namedImports) {
          const importName = named.getAliasNode() ? named.getNameNode().getText() : named.getName();
          edges.push({
            source: sourceId,
            target: `symbol:${targetRel}#${importName}`,
            kind: "imports",
          });
        }
        if (!defaultImport && namedImports.length === 0 && !namespaceImport) {
          edges.push({ source: sourceId, target: `file:${targetRel}`, kind: "imports" });
        }
      }
    } else {
      edges.push({ source: sourceId, target: `file:${targetRel}`, kind: "imports" });
    }
  }

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = exportDecl.getModuleSpecifierValue();
    if (moduleSpecifier?.startsWith(".")) {
      const resolved = resolveImport(sourceFile, exportDecl);
      if (resolved) {
        const targetRel = relative(rootDir, resolved);
        edges.push({
          source: sourceId,
          target: `file:${targetRel}`,
          kind: "imports",
        });
      }
    }
  }
}

function resolveImport(sourceFile: SourceFile, decl: any): string | undefined {
  try {
    const resolved = decl.getModuleSpecifierSourceFile?.();
    return resolved?.getFilePath();
  } catch {
    return undefined;
  }
}

function extractImplTags(
  content: string,
  relPath: string,
  isTest: boolean,
  edges: GraphEdge[],
  mode: "file" | "symbol" = "file",
  symbolRanges: SymbolRange[] = [],
  matchers: IdMatchers = buildIdMatchers(),
) {
  const { implRe, reqIdRe, testReqRe, testAnnotationRe } = matchers;
  const fileSourceId = `file:${relPath}`;

  let match: RegExpExecArray | null;

  implRe.lastIndex = 0;
  while ((match = implRe.exec(content)) !== null) {
    const reqIds = match[1].match(reqIdRe);
    if (!reqIds) continue;

    let sourceId = fileSourceId;

    if (mode === "symbol" && !isTest && symbolRanges.length > 0) {
      const line = lineNumberAt(content, match.index);
      const resolved = resolveSymbolAtLine(symbolRanges, line);
      if (resolved) {
        sourceId = `symbol:${relPath}#${resolved}`;
      }
    }

    for (const reqId of reqIds) {
      edges.push({ source: sourceId, target: reqId, kind: "implements" });
    }
  }

  if (isTest) {
    testReqRe.lastIndex = 0;
    while ((match = testReqRe.exec(content)) !== null) {
      const reqId = match[0].slice(1, -1);
      edges.push({ source: fileSourceId, target: reqId, kind: "verifies" });
    }

    testAnnotationRe.lastIndex = 0;
    while ((match = testAnnotationRe.exec(content)) !== null) {
      edges.push({ source: fileSourceId, target: match[1], kind: "verifies" });
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

function resolveSymbolAtLine(ranges: SymbolRange[], line: number): string | null {
  let best: SymbolRange | null = null;
  for (const range of ranges) {
    if (line >= range.startLine && line <= range.endLine) {
      if (!best || range.endLine - range.startLine < best.endLine - best.startLine) {
        best = range;
      }
    }
  }
  return best?.name ?? null;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
