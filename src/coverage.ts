import type { ArtifactGraph, CoverageStatus, GraphEdge, TestResultMap } from "./types.js";
import { isExclusiveNode } from "./trace/report.js";
import type { IngestedTrace } from "./trace/ingest.js";

export interface CoverageEntry {
  reqId: string;
  status: CoverageStatus;
  implFiles: string[];
  testFiles: string[];
}

// issue #285 — the "claim-eligible" rule: a `implements` edge counts as a
// code-claim on its TARGET req only when its SOURCE is not a task node
// (`task → implements → req` is a planning relation, data-model.md §7 —
// `check`'s `implByTarget`/`implFiles` below has always excluded it). Shared
// by `computeCoverage`'s `implByTarget` construction AND
// `src/trace/report.ts`'s `classifyEvidence` (`suggestedImpls` suppression)
// so the two can never drift on what "this REQ is already claimed" means —
// before this fix `classifyEvidence` used a NODE-scoped `claimedNodes` set
// (suppressing a REQ's suggestion whenever the shared symbol/file happened
// to carry ANY REQ's claim, even a completely different one) while `check`
// used this REQ-scoped rule, so a foreign `@impl` on an exclusively-evidenced
// node silently hid a legitimately-unclaimed REQ's suggestion (issue #285).
export function isClaimEdge(graph: ArtifactGraph, edge: GraphEdge): boolean {
  return edge.kind === "implements" && graph.nodes.get(edge.source)?.kind !== "task";
}

/**
 * The set of REQ ids that already have at least one code-claim (per
 * `isClaimEdge` above) anywhere in the graph — REQ-grain, independent of
 * which node(s) carry the claim. `src/trace/report.ts`'s `classifyEvidence`
 * calls this ONCE (O(edges)) to build its `suggestedImpls` suppression set,
 * matching `computeCoverage`'s own `implFiles.length === 0` ⟺ "uncovered by
 * @impl" rule below exactly.
 */
export function buildClaimedReqIds(graph: ArtifactGraph): Set<string> {
  const claimed = new Set<string>();
  for (const e of graph.edges) {
    if (isClaimEdge(graph, e)) claimed.add(e.target);
  }
  return claimed;
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
      // task → implements → req is a planning relation, not a code-claim
      // (data-model.md §7: task は coverage 集計対象外) — `isClaimEdge`
      // (issue #285) is the shared definition `src/trace/report.ts`'s
      // `classifyEvidence` also uses, so the two can never drift on what
      // "this REQ is already claimed" means.
      if (!isClaimEdge(graph, e)) continue;
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
