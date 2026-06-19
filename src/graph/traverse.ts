import type { ArtifactGraph, ImpactResult, DriftEntry } from "../types.js";
import type { LockFile } from "../types.js";

export function impact(graph: ArtifactGraph, startIds: string[], lock: LockFile): ImpactResult {
  const visited = new Set<string>();
  const queue = [...startIds];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    for (const edge of graph.edges) {
      if (edge.source === id && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
      if (edge.target === id && !visited.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }

  const affectedFiles: string[] = [];
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
        affectedFiles.push(node.filePath);
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

  const orphans = findOrphans(graph);
  const uncovered = findUncovered(graph);

  return { affectedFiles, affectedDocs, affectedReqs, drifted, orphans, uncovered };
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
      continue;
    }

    for (const [id, node] of graph.nodes) {
      if (node.filePath === input) {
        ids.push(id);
      }
    }
  }

  return ids;
}
