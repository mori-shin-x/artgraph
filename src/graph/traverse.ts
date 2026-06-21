import type { ArtifactGraph, ImpactResult, DriftEntry } from "../types.js";
import type { LockFile } from "../types.js";

export function impact(
  graph: ArtifactGraph,
  startIds: string[],
  lock: LockFile,
  maxDepth?: number,
): ImpactResult {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = startIds.map((id) => ({ id, depth: 0 }));

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    // If maxDepth is set and we've reached it, don't explore further from this node
    if (maxDepth !== undefined && depth >= maxDepth) continue;

    const node = graph.nodes.get(id);
    if (node && node.kind === "file") {
      for (const [symId, symNode] of graph.nodes) {
        if (symNode.kind === "symbol" && symNode.filePath === node.filePath && !visited.has(symId)) {
          queue.push({ id: symId, depth: depth + 1 });
        }
      }
    }

    for (const edge of graph.edges) {
      if (edge.source === id && !visited.has(edge.target)) {
        queue.push({ id: edge.target, depth: depth + 1 });
      }
      if (edge.target === id && !visited.has(edge.source)) {
        queue.push({ id: edge.source, depth: depth + 1 });
      }
    }
  }

  const affectedFileSet = new Set<string>();
  const affectedDocs: string[] = [];
  const affectedReqs: string[] = [];
  const drifted: DriftEntry[] = [];

  for (const id of visited) {
    const node = graph.nodes.get(id);
    if (!node) continue;

    switch (node.kind) {
      case "file":
      case "symbol":
      case "test":
        affectedFileSet.add(node.filePath);
        break;
      case "doc":
        affectedDocs.push(id);
        break;
      case "req":
        affectedReqs.push(id);
        break;
    }

    if ((node.kind === "req" || node.kind === "doc") && lock[id]) {
      if (lock[id].contentHash !== node.contentHash) {
        drifted.push({
          nodeId: id,
          kind: node.kind,
          lockedHash: lock[id].contentHash,
          currentHash: node.contentHash,
        });
      }
    }
  }

  const affectedFiles = [...affectedFileSet];
  return {
    affectedFiles,
    affectedDocs,
    affectedReqs,
    drifted,
    summary: {
      docs: affectedDocs.length,
      reqs: affectedReqs.length,
      files: affectedFiles.length,
    },
  };
}

export function findOrphans(graph: ArtifactGraph): string[] {
  const orphans: string[] = [];

  for (const edge of graph.edges) {
    if (edge.kind === "implements" || edge.kind === "verifies") {
      if (!graph.nodes.has(edge.target)) {
        orphans.push(`${edge.source} -> ${edge.target} (${edge.kind})`);
      }
    }
  }

  return orphans;
}

export function findUncovered(graph: ArtifactGraph): string[] {
  const uncovered: string[] = [];

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req") continue;

    const hasImpl = graph.edges.some((e) => e.kind === "implements" && e.target === id);
    if (!hasImpl) {
      uncovered.push(id);
    }
  }

  return uncovered;
}

export function resolveStartIds(graph: ArtifactGraph, inputs: string[]): string[] {
  const ids: string[] = [];

  for (const input of inputs) {
    if (graph.nodes.has(input)) {
      ids.push(input);
      continue;
    }

    const fileId = `file:${input}`;
    if (graph.nodes.has(fileId)) {
      ids.push(fileId);
      for (const [id, node] of graph.nodes) {
        if (node.kind === "symbol" && node.filePath === input) {
          ids.push(id);
        }
      }
      continue;
    }

    // T048: doc: prefix resolution
    const docId = `doc:${input}`;
    if (graph.nodes.has(docId)) {
      ids.push(docId);
      // Do NOT continue — fall through to filePath match so that
      // req/file nodes sharing the same filePath are also collected.
    }

    for (const [id, node] of graph.nodes) {
      if (node.filePath === input && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }

  return ids;
}
