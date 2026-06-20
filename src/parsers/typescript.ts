import { Project, type SourceFile } from "ts-morph";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { GraphNode, GraphEdge } from "../types.js";

const IMPL_RE =
  /\/\/[^\S\n]*@impl[^\S\n]+((?:(?:[\w-]+\/)?(?:[A-Z][A-Za-z]*-\d+|Requirement-\d+)[^\S\n]*)+)/gm;
const REQ_ID_RE = /(?:[\w-]+\/)?(?:[A-Z][A-Za-z]*-\d+|Requirement-\d+)/g;

const TEST_REQ_RE = /\[(?:[A-Z][A-Za-z]*-\d+|Requirement-\d+)]/g;
const TEST_ANNOTATION_RE =
  /req:\s*["']?((?:[\w-]+\/)?(?:[A-Z][A-Za-z]*-\d+|Requirement-\d+))["']?/g;

interface ParsedTS {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function createTSParser(rootDir: string, patterns: string[]) {
  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  const projectOpts = existsSync(tsconfigPath)
    ? { tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: true }
    : { skipAddingFilesFromTsConfig: true };
  const project = new Project(projectOpts);

  for (const pattern of patterns) {
    project.addSourceFilesAtPaths(resolve(rootDir, pattern));
  }

  return { project, parse: () => parseProject(project, rootDir) };
}

function parseProject(project: Project, rootDir: string): ParsedTS {
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

    extractImports(sourceFile, relPath, rootDir, edges);
    extractImplTags(fileContent, relPath, isTest, edges);
  }

  return { nodes, edges };
}

function extractImports(
  sourceFile: SourceFile,
  relPath: string,
  rootDir: string,
  edges: GraphEdge[],
) {
  const sourceId = `file:${relPath}`;

  for (const decl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = decl.getModuleSpecifierValue();
    if (moduleSpecifier.startsWith(".")) {
      const resolved = resolveImport(sourceFile, decl);
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

function extractImplTags(content: string, relPath: string, isTest: boolean, edges: GraphEdge[]) {
  const sourceId = `file:${relPath}`;

  let match: RegExpExecArray | null;

  IMPL_RE.lastIndex = 0;
  while ((match = IMPL_RE.exec(content)) !== null) {
    const reqIds = match[1].match(REQ_ID_RE);
    if (reqIds) {
      for (const reqId of reqIds) {
        edges.push({
          source: sourceId,
          target: reqId,
          kind: "implements",
        });
      }
    }
  }

  if (isTest) {
    TEST_REQ_RE.lastIndex = 0;
    while ((match = TEST_REQ_RE.exec(content)) !== null) {
      const reqId = match[0].slice(1, -1);
      edges.push({
        source: sourceId,
        target: reqId,
        kind: "verifies",
      });
    }

    TEST_ANNOTATION_RE.lastIndex = 0;
    while ((match = TEST_ANNOTATION_RE.exec(content)) !== null) {
      edges.push({
        source: sourceId,
        target: match[1],
        kind: "verifies",
      });
    }
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
