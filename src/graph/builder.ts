import { resolve } from "node:path";
import { globSync } from "glob";
import { parseMarkdown } from "../parsers/markdown.js";
import { createTSParser } from "../parsers/typescript.js";
import type { ArtifactGraph, GraphNode, GraphEdge, SpectraceConfig } from "../types.js";

export interface BuildWarning {
  type: "duplicate-id";
  id: string;
  files: string[];
}

export function buildGraph(
  rootDir: string,
  config: SpectraceConfig,
): { graph: ArtifactGraph; warnings: BuildWarning[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const warnings: BuildWarning[] = [];

  const specFiles = config.specDirs.flatMap((dir) => globSync(resolve(rootDir, dir, "**/*.md")));

  for (const file of specFiles) {
    const result = parseMarkdown(file, rootDir);
    for (const node of result.nodes) {
      addNodeWithDupCheck(nodes, node, warnings);
    }
    edges.push(...result.edges);
  }

  const codePatterns = [...config.include, ...config.testPatterns];
  const tsParser = createTSParser(rootDir, codePatterns);
  const tsResult = tsParser.parse();

  for (const node of tsResult.nodes) {
    addNodeWithDupCheck(nodes, node, warnings);
  }
  edges.push(...tsResult.edges);

  return { graph: { nodes, edges }, warnings };
}

function addNodeWithDupCheck(
  nodes: Map<string, GraphNode>,
  node: GraphNode,
  warnings: BuildWarning[],
) {
  const existing = nodes.get(node.id);
  if (existing && existing.filePath !== node.filePath) {
    warnings.push({
      type: "duplicate-id",
      id: node.id,
      files: [existing.filePath, node.filePath],
    });
  }
  nodes.set(node.id, node);
}
