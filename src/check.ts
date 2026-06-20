import type { ArtifactGraph, LockFile, CheckResult, DriftEntry } from "./types.js";
import { findOrphans, findUncovered } from "./graph/traverse.js";
import { computeCoverage } from "./coverage.js";

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
  const coverageEntries = computeCoverage(graph);
  const coverage = coverageEntries.map((c) => ({
    reqId: c.reqId,
    slug: c.slug,
    status: c.status,
  }));

  const pass = drifted.length === 0 && orphans.length === 0 && uncovered.length === 0;

  return { drifted, orphans, uncovered, coverage, pass };
}
