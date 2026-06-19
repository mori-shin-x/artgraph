import { resolve } from "node:path";
import { globSync } from "glob";
import { parseMarkdown } from "../parsers/markdown.js";
import { createTSParser } from "../parsers/typescript.js";
import type { ArtifactGraph, GraphNode, GraphEdge, SpectraceConfig } from "../types.js";

export function buildGraph(rootDir: string, config: SpectraceConfig): ArtifactGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const specFiles = config.specDirs.flatMap((dir) => globSync(resolve(rootDir, dir, "**/*.md")));

  for (const file of specFiles) {
    const result = parseMarkdown(file);
    for (const node of result.nodes) {
      nodes.set(node.id, node);
    }
    edges.push(...result.edges);
  }

  const codePatterns = [...config.include, ...config.testPatterns];
  const tsParser = createTSParser(rootDir, codePatterns);
  const tsResult = tsParser.parse();

  for (const node of tsResult.nodes) {
    nodes.set(node.id, node);
  }
  edges.push(...tsResult.edges);

  return { nodes, edges };
}
