import type {
  ArtifactGraph,
  LockFile,
  CheckResult,
  DriftEntry,
  TestResultMap,
  NewIssues,
  BaselineStatus,
  StaleEvidenceEntry,
} from "./types.js";
import { findOrphans, formatOrphan, findUncovered } from "./graph/traverse.js";
import { computeCoverage } from "./coverage.js";
import { driftKey, orphanKey, uncoveredKey, testfailKey, type BaselineIssues } from "./baseline.js";
import {
  classifyEvidence,
  excludeStaleEvidence,
  DEFAULT_SHARED_THRESHOLD,
} from "./trace/report.js";
import type { IngestedTrace } from "./trace/ingest.js";

// spec 020 (contracts/cli-surface.md §4, data-model.md §7/§8, FR-012〜015) —
// trace-derived findings input. Omitted entirely (not just `trace:
// undefined`) by callers on a trace-absent project so `check()` never even
// enters the trace branch below — FR-010's byte-identical guarantee is a
// property of the CALLER's decision to omit this argument, not of a runtime
// branch inside `check()` (mirrors `src/commands/check.ts`'s
// `hasTraceShards` gate, T011's Phase A precedent).
export interface TraceCheckOptions {
  trace: IngestedTrace;
  /** `computeStaleNodeIds(graph, trace)` — the caller already has `graph`
   * and `trace` in scope to compute this once; `check()` stays a pure
   * function of its inputs rather than re-deriving it. */
  staleNodeIds: Set<string>;
  /** `.artgraph.json`'s `trace.acceptExercises`. Default false (mirrors
   * `TraceConfig.acceptExercises`'s own documented default). */
  acceptExercises?: boolean;
  /** `.artgraph.json`'s `trace.staleness`. Default "warn". */
  staleness?: "warn" | "exclude" | "gate";
  /** `.artgraph.json`'s `trace.sharedThreshold`. Default 3
   * (`DEFAULT_SHARED_THRESHOLD`). */
  sharedThreshold?: number;
}

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
  // spec 020 (contracts/cli-surface.md §4, FR-012〜015) — trace-derived
  // findings + `exercised` status. Omitted entirely on a trace-absent
  // project (see `TraceCheckOptions` doc above) so every branch below is
  // skipped and `CheckResult` never gains the new optional keys — FR-010.
  traceOptions?: TraceCheckOptions,
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
  // issue #155 (B1) — bare orphan-source node ids, for the `--serve` renderer
  // to compare against without re-parsing the formatted `orphans` strings.
  const orphanNodeIds = Array.from(new Set(scopedOrphans.map((o) => o.source))).sort();

  // spec 020 (FR-015, US5-2) — `staleness: "exclude"` removes stale evidence
  // from EVERY downstream decision (findings below AND `exercised` status);
  // `warn`/`gate` leave the evidence intact and only change what happens
  // with the (always-computed, see `staleEvidence` below) stale REPORT.
  const staleness = traceOptions?.staleness ?? "warn";
  const evidenceTrace =
    traceOptions && staleness === "exclude"
      ? excludeStaleEvidence(traceOptions.trace, traceOptions.staleNodeIds)
      : traceOptions?.trace;

  const allUncovered = findUncovered(graph);

  // spec 020 (FR-014, US4-2) — `acceptExercises` is coverage.ts's SOLE
  // signal to compute `exercised` status: only build `CoverageTraceOptions`
  // when it's actually enabled, so `computeCoverage` never has to know about
  // the config flag itself (single-responsibility, see coverage.ts's doc).
  const acceptExercises = traceOptions?.acceptExercises ?? false;
  const allCoverage = computeCoverage(
    graph,
    testResults,
    acceptExercises && evidenceTrace ? { trace: evidenceTrace } : undefined,
  );
  const filtered = scope ? allCoverage.filter((c) => scope.has(c.reqId)) : allCoverage;
  const coverage = filtered.map((c) => ({
    reqId: c.reqId,
    status: c.status,
  }));

  // spec 020 (US4-2) — a REQ rescued to `exercised` is, by definition, no
  // longer `uncovered` (data-model.md §6: `exercised` removes it from the
  // uncovered set). `findUncovered` itself stays untouched (it only knows
  // about `implements` edges, spec 016/017's contract) — this is check()'s
  // own post-filter, driven by the SAME coverage computation used for the
  // `coverage` field above so the two never disagree on which REQs are
  // exercised.
  const exercisedReqIds = new Set(
    allCoverage.filter((c) => c.status === "exercised").map((c) => c.reqId),
  );
  const uncoveredAfterExercised = allUncovered.filter((id) => !exercisedReqIds.has(id));
  const uncovered = scope
    ? uncoveredAfterExercised.filter((id) => scope.has(id))
    : uncoveredAfterExercised;

  // spec 020 (data-model.md §7, FR-012/013/015) — the 3 new findings.
  // `unexercisedClaims`/`suggestedImpls` reuse Phase A's `classifyEvidence`
  // verbatim (staleness-filtered per the mode above); `staleEvidence` is
  // computed from the ORIGINAL (unfiltered) trace regardless of mode — the
  // mode changes whether stale evidence still counts elsewhere, not whether
  // it gets reported here.
  let unexercisedClaims: CheckResult["unexercisedClaims"];
  let suggestedImpls: CheckResult["suggestedImpls"];
  let staleEvidence: StaleEvidenceEntry[] | undefined;
  let staleGate = false;
  if (traceOptions) {
    const sharedThreshold = traceOptions.sharedThreshold ?? DEFAULT_SHARED_THRESHOLD;
    const evidence = classifyEvidence(graph, evidenceTrace!, sharedThreshold);
    unexercisedClaims = scope
      ? evidence.unexercisedClaims.filter((p) => scope.has(p.reqId))
      : evidence.unexercisedClaims;
    suggestedImpls = scope
      ? evidence.suggestedImpls.filter((p) => scope.has(p.reqId))
      : evidence.suggestedImpls;

    const staleByReq: StaleEvidenceEntry[] = [];
    for (const [reqId, cov] of traceOptions.trace.perReq) {
      if (scope && !scope.has(reqId)) continue;
      const staleNodes = [...cov.symbols, ...cov.files]
        .filter((n) => traceOptions.staleNodeIds.has(n))
        .sort();
      if (staleNodes.length > 0) staleByReq.push({ reqId, symbols: staleNodes });
    }
    staleByReq.sort((a, b) => (a.reqId < b.reqId ? -1 : a.reqId > b.reqId ? 1 : 0));
    staleEvidence = staleByReq;
    staleGate = staleness === "gate" && staleEvidence.length > 0;
  }

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
    orphanNodeIds,
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
  // spec 020 (FR-010) — only set when a trace was actually ingested. Setting
  // these keys on `result` unconditionally (even to `[]`/`false`) would grow
  // `JSON.stringify`'s output on a trace-absent project, breaking the
  // byte-identical guarantee (T019(d), T021(e)'s regression pin).
  if (traceOptions) {
    result.unexercisedClaims = unexercisedClaims;
    result.suggestedImpls = suggestedImpls;
    result.staleEvidence = staleEvidence;
    result.staleGate = staleGate;
  }
  return result;
}
