import type { ArtifactGraph, CoverageStatus, TestResultMap } from "./types.js";
import { isExclusiveNode } from "./trace/report.js";
import type { IngestedTrace } from "./trace/ingest.js";

export interface CoverageEntry {
  reqId: string;
  status: CoverageStatus;
  implFiles: string[];
  testFiles: string[];
}

// spec 020 (data-model.md §6, FR-014) — opt-in `exercised` status input.
// Callers (`src/check.ts`) build this ONLY when `trace.acceptExercises` is
// true; its mere presence is what turns the rescue on (no separate boolean
// here) — `computeCoverage` itself doesn't know or care about the config
// flag, it just answers "was a trace evidence set supplied". `trace` should
// already be staleness-filtered by the caller (`excludeStaleEvidence`) when
// `trace.staleness === "exclude"` — this module has no staleness policy of
// its own (single responsibility: exclusivity + status, not staleness).
export interface CoverageTraceOptions {
  trace: IngestedTrace;
}

export function computeCoverage(
  graph: ArtifactGraph,
  testResults?: TestResultMap,
  traceOptions?: CoverageTraceOptions,
): CoverageEntry[] {
  const entries: CoverageEntry[] = [];

  // FR-014: an untagged REQ becomes `exercised` when its trace evidence
  // includes at least one node exclusively reached by it (FR-013's
  // exclusivity rule, `isExclusiveNode` — same predicate `trace
  // report`/`check`'s `suggestedImpls` use, so a symbol that would be
  // SUGGESTED IMPL is exactly the kind of evidence that also qualifies its
  // REQ for `exercised`).
  const isExercisedEligible = (reqId: string): boolean => {
    if (!traceOptions) return false;
    const coverage = traceOptions.trace.perReq.get(reqId);
    if (!coverage) return false;
    for (const node of coverage.symbols) {
      if (isExclusiveNode(traceOptions.trace, node)) return true;
    }
    for (const node of coverage.files) {
      if (isExclusiveNode(traceOptions.trace, node)) return true;
    }
    return false;
  };

  // Index edges by target once (O(edges)) rather than re-scanning every edge for
  // each requirement (O(REQ × edges)). This matters as test-result imports grow
  // the edge set. Iteration order is preserved so impl/test file lists keep the
  // same ordering as the previous per-req filter.
  const implByTarget = new Map<string, string[]>();
  const testByTarget = new Map<string, string[]>();
  const indexEdge = (map: Map<string, string[]>, target: string, source: string) => {
    const list = map.get(target);
    if (list) list.push(source);
    else map.set(target, [source]);
  };
  for (const e of graph.edges) {
    if (e.kind === "implements") {
      // task → implements → req is a planning relation, not a code-claim. Filtering
      // here keeps a req that only has `task → implements` from being upgraded out
      // of `untagged` (data-model.md §7: task は coverage 集計対象外).
      if (graph.nodes.get(e.source)?.kind === "task") continue;
      indexEdge(implByTarget, e.target, e.source);
    } else if (e.kind === "verifies") {
      // Same rule for verifies: only code-side test sources prove a req is verified.
      if (graph.nodes.get(e.source)?.kind === "task") continue;
      indexEdge(testByTarget, e.target, e.source);
    }
  }

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req") continue;

    const implFiles = implByTarget.get(id) ?? [];
    const testFiles = testByTarget.get(id) ?? [];

    let status: CoverageStatus;
    if (implFiles.length === 0) {
      status = isExercisedEligible(id) ? "exercised" : "untagged";
    } else if (testFiles.length === 0) {
      status = "impl-only";
    } else if (testResults) {
      // When test results are provided, check actual pass/fail
      const results = testResults.get(id);
      if (results && results.length > 0 && results.every((r) => r.passed)) {
        status = "verified";
      } else {
        status = "impl-only";
      }
    } else {
      // No test results provided — legacy behavior
      status = "verified";
    }

    entries.push({
      reqId: id,
      status,
      implFiles,
      testFiles,
    });
  }

  return entries;
}
