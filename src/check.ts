import type { ArtifactGraph, LockFile, CheckResult, DriftEntry } from "./types.js";
import { findOrphans, findUncovered } from "./graph/traverse.js";

export function check(graph: ArtifactGraph, lock: LockFile): CheckResult {
  const drifted: DriftEntry[] = [];

  for (const [id, entry] of Object.entries(lock)) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (node.contentHash !== entry.contentHash) {
      drifted.push({
        nodeId: id,
        kind: node.kind,
        lockedHash: entry.contentHash,
        currentHash: node.contentHash,
      });
    }
  }

  const orphans = findOrphans(graph);
  const uncovered = findUncovered(graph);

  const pass = drifted.length === 0 && orphans.length === 0 && uncovered.length === 0;

  return { drifted, orphans, uncovered, pass };
}
