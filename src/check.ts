import type { ArtifactGraph, LockFile, CheckResult, DriftEntry, TestResultMap } from "./types.js";
import { findOrphans, findUncovered } from "./graph/traverse.js";
import { computeCoverage } from "./coverage.js";

export function check(graph: ArtifactGraph, lock: LockFile, scope?: Set<string>, testResults?: TestResultMap): CheckResult {
  const drifted: DriftEntry[] = [];

  for (const [id, entry] of Object.entries(lock)) {
    if (scope && !scope.has(id)) continue;
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

  const allOrphans = findOrphans(graph);
  const orphans = scope
    ? allOrphans.filter((o) => [...scope].some((s) => o.includes(s)))
    : allOrphans;

  const allUncovered = findUncovered(graph);
  const uncovered = scope ? allUncovered.filter((id) => scope.has(id)) : allUncovered;

  const allCoverage = computeCoverage(graph, testResults);
  const filtered = scope ? allCoverage.filter((c) => scope.has(c.reqId)) : allCoverage;
  const coverage = filtered.map((c) => ({
    reqId: c.reqId,
    status: c.status,
  }));

  // When test results are supplied, a requirement that has verifies edges but
  // ends up impl-only means its tests ran and failed (or were skipped) — that is
  // a regression the gate must catch, not just display. Without test results
  // this set is always empty, preserving the legacy gate behavior.
  const testFailures = testResults
    ? filtered
        .filter((c) => c.status === "impl-only" && c.testFiles.length > 0)
        .map((c) => c.reqId)
    : [];

  const pass =
    drifted.length === 0 &&
    orphans.length === 0 &&
    uncovered.length === 0 &&
    testFailures.length === 0;

  return { drifted, orphans, uncovered, coverage, testFailures, pass };
}
