import { resolve } from "node:path";
import { buildGraph, type BuildWarning } from "./graph/builder.js";
import { writeLock, buildLockFromGraph } from "./lock.js";
import type { ArtifactGraph, ArtgraphConfig } from "./types.js";

export interface ScanResult {
  graph: ArtifactGraph;
  warnings: BuildWarning[];
  nodeCount: number;
  edgeCount: number;
  reqCount: number;
  docCount: number;
  fileCount: number;
  symbolCount: number;
  testCount: number;
}

export function scan(rootDir: string, config: ArtgraphConfig): ScanResult {
  const absRoot = resolve(rootDir);
  const { graph, warnings } = buildGraph(absRoot, config);

  let reqCount = 0;
  let docCount = 0;
  let fileCount = 0;
  let symbolCount = 0;
  let testCount = 0;

  for (const node of graph.nodes.values()) {
    switch (node.kind) {
      case "req":
        reqCount++;
        break;
      case "doc":
        docCount++;
        break;
      case "file":
        fileCount++;
        break;
      case "symbol":
        symbolCount++;
        break;
      case "test":
        testCount++;
        break;
    }
  }

  return {
    graph,
    warnings,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    reqCount,
    docCount,
    fileCount,
    symbolCount,
    testCount,
  };
}

export function reconcile(rootDir: string, config: ArtgraphConfig, graph: ArtifactGraph): void {
  const lock = buildLockFromGraph(graph);
  writeLock(rootDir, config.lockFile, lock);
}
