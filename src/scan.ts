import { resolve } from "node:path";
import { buildGraph } from "./graph/builder.js";
import { writeLock, buildLockFromGraph } from "./lock.js";
import type { ArtifactGraph, SpectraceConfig } from "./types.js";

export interface ScanResult {
  graph: ArtifactGraph;
  nodeCount: number;
  edgeCount: number;
  reqCount: number;
  docCount: number;
  fileCount: number;
  testCount: number;
}

export function scan(rootDir: string, config: SpectraceConfig): ScanResult {
  const absRoot = resolve(rootDir);
  const graph = buildGraph(absRoot, config);

  let reqCount = 0;
  let docCount = 0;
  let fileCount = 0;
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
      case "symbol":
        fileCount++;
        break;
      case "test":
        testCount++;
        break;
    }
  }

  return {
    graph,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    reqCount,
    docCount,
    fileCount,
    testCount,
  };
}

export function reconcile(rootDir: string, config: SpectraceConfig, graph: ArtifactGraph): void {
  const lock = buildLockFromGraph(graph);
  writeLock(rootDir, config.lockFile, lock);
}
