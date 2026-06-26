import { resolve } from "node:path";
import { buildGraph, type BuildWarning } from "./graph/builder.js";
import { writeLock, buildLockFromGraph, readLock } from "./lock.js";
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
  taskCount: number;
}

export function scan(rootDir: string, config: ArtgraphConfig): ScanResult {
  const absRoot = resolve(rootDir);
  const { graph, warnings } = buildGraph(absRoot, config);

  let reqCount = 0;
  let docCount = 0;
  let fileCount = 0;
  let symbolCount = 0;
  let testCount = 0;
  let taskCount = 0;

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
      case "task":
        taskCount++;
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
    taskCount,
  };
}

export function reconcile(rootDir: string, config: ArtgraphConfig, graph: ArtifactGraph): void {
  // Pass the previous lock (if any) so structurally-identical entries keep
  // their lastReconciled timestamp. Without this, every `scan` writes new
  // timestamps for every entry and INV-L4 (byte-identical round-trip) is
  // broken in real use even though the test stubs `Date`. Review B1.
  const prevLock = readLock(rootDir, config.lockFile);
  const lock = buildLockFromGraph(graph, prevLock);
  writeLock(rootDir, config.lockFile, lock);
}
