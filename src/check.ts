import type {
  ArtifactGraph,
  LockFile,
  CheckResult,
  DriftEntry,
  TestResultMap,
  NewIssues,
  BaselineStatus,
} from "./types.js";
import { findOrphans, formatOrphan, findUncovered } from "./graph/traverse.js";
import { computeCoverage } from "./coverage.js";
import { driftKey, orphanKey, uncoveredKey, testfailKey, type BaselineIssues } from "./baseline.js";

// spec 017 — the gate is decided by the NEW issues only (current \ baseline),
// and orphan scoping is a strict source-id match (not a substring test).
// @impl 017-check-gate-baseline-diff/FR-001
// @impl 017-check-gate-baseline-diff/FR-006
export function check(
  graph: ArtifactGraph,
  lock: LockFile,
  scope?: Set<string>,
  testResults?: TestResultMap,
  // spec 017 (data-model §4) — base ref issue key set. When omitted (legacy /
  // non-diff callers) every scoped issue counts as new, so `pass` collapses to
  // the pre-017 "all scoped issues clear" meaning and back-compat holds.
  baseline?: BaselineIssues,
  // spec 017 (Critical fix B6/D2, issue #182 review) — `baseline === undefined`
  // is ambiguous on its own: it happens both for a plain (non-`--diff`) check
  // AND for a `--diff` run whose lazy-eval (R6) skipped baseline computation
  // because the scope already had zero issues (data-model §7). This flag is
  // the only signal that lets `check()` tell the two apart when deciding
  // `baselineStatus` — `true` → `"skipped"`, `false`/omitted → `"not_applicable"`
  // (data-model §1.1 / §4, contract cli-check-gate §3).
  diffRequested?: boolean,
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

  // spec 017 (FR-006, R5) — strict source matching. An orphan is in scope only
  // when its `source` node is itself in the diff scope; the old substring
  // `o.includes(s)` matched unrelated fixtures whose orphan line merely
  // contained a scoped token (issue #174: 48/53 false matches).
  const allOrphans = findOrphans(graph);
  const scopedOrphans = scope ? allOrphans.filter((o) => scope.has(o.source)) : allOrphans;
  const orphans = scopedOrphans.map(formatOrphan);

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

  // ── spec 017 baseline diff: new = scoped issue whose key ∉ baseline.keys ──
  const status = baseline?.status;
  const isPreExisting = (key: string): boolean => baseline?.keys.has(key) ?? false;

  let newIssues: NewIssues;
  if (status === "unavailable") {
    // Baseline undeterminable — cannot confirm any issue as new, but the gate
    // must not silently pass (contract cli-check-gate §3, FR-010). `pass` is
    // forced false below; the command surfaces this as exit 1, not exit 2.
    newIssues = { drifted: [], orphans: [], uncovered: [], testFailures: [] };
  } else {
    // baseline undefined or "empty" → key set is empty → every scoped issue is
    // new (FR-014). "computed" → subtract the pre-existing key set.
    newIssues = {
      drifted: drifted.filter((d) => !isPreExisting(driftKey(d))),
      orphans: scopedOrphans.filter((o) => !isPreExisting(orphanKey(o))).map(formatOrphan),
      uncovered: uncovered.filter((id) => !isPreExisting(uncoveredKey(id))),
      testFailures: testFailures.filter((id) => !isPreExisting(testfailKey(id))),
    };
  }

  const scopedCount = drifted.length + orphans.length + uncovered.length + testFailures.length;
  const newCount =
    newIssues.drifted.length +
    newIssues.orphans.length +
    newIssues.uncovered.length +
    newIssues.testFailures.length;
  const suppressedCount = status === "unavailable" ? 0 : scopedCount - newCount;

  // `pass` now means "no NEW issue" (= gate 合否), not "no scoped issue".
  const pass = status === "unavailable" ? false : newCount === 0;
  // spec 017 (Critical fix B6/D2) — no `baseline` supplied: `diffRequested`
  // decides whether that means a `--diff` lazy-eval skip (scope was already
  // clean, R6) or a plain non-`--diff` check where the baseline concept
  // itself doesn't apply (R8 back-compat).
  const baselineStatus: BaselineStatus = status ?? (diffRequested ? "skipped" : "not_applicable");

  const result: CheckResult = {
    drifted,
    orphans,
    uncovered,
    coverage,
    testFailures,
    pass,
    newIssues,
    suppressedCount,
    baselineStatus,
  };
  // spec 017 (Critical fix B1, issue #182 review) — propagate the baseline's
  // captured failure message so json/text consumers can see *why* the gate is
  // undetermined instead of a bare "unavailable" string.
  if (baselineStatus === "unavailable" && baseline?.error) {
    result.baselineError = baseline.error;
  }
  return result;
}
