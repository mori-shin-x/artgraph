import type { ArtifactGraph, LockFile, CheckResult, DriftEntry, TestResultMap } from "./types.js";
import { findOrphans, findUncovered } from "./graph/traverse.js";
import { computeCoverage } from "./coverage.js";

export function check(
  graph: ArtifactGraph,
  lock: LockFile,
  scope?: Set<string>,
  testResults?: TestResultMap,
): CheckResult {
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

  // issue #155 (B1) — `findOrphans` now returns structured `OrphanEntry[]`
  // so the `--serve` renderer can compare bare node ids. The scope filter
  // preserves its previous substring semantics against the same descriptor
  // string the text CLI prints, so the `check --diff` gate behaviour is
  // byte-identical. NOTE (meta-B-B): the `.includes(s)` prefix-collision
  // dormant bug (e.g. scope `{REQ-1}` matching descriptor `REQ-10`) is
  // NOT fixed here — it existed before this PR and belongs in a follow-up.
  const allOrphans = findOrphans(graph);
  const scopedOrphans = scope
    ? allOrphans.filter((o) => {
        const descriptor = `${o.source} -> ${o.target} (${o.kind})`;
        return [...scope].some((s) => descriptor.includes(s));
      })
    : allOrphans;
  const orphans = scopedOrphans.map((o) => `${o.source} -> ${o.target} (${o.kind})`);
  const orphanNodeIds = Array.from(new Set(scopedOrphans.map((o) => o.source))).sort();

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
    ? filtered.filter((c) => c.status === "impl-only" && c.testFiles.length > 0).map((c) => c.reqId)
    : [];

  const pass =
    drifted.length === 0 &&
    orphans.length === 0 &&
    uncovered.length === 0 &&
    testFailures.length === 0;

  return { drifted, orphans, orphanNodeIds, uncovered, coverage, testFailures, pass };
}
