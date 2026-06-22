import type { ArtifactGraph, CoverageStatus, TestResultMap } from "./types.js";

export interface CoverageEntry {
  reqId: string;
  status: CoverageStatus;
  implFiles: string[];
  testFiles: string[];
}

export function computeCoverage(graph: ArtifactGraph, testResults?: TestResultMap): CoverageEntry[] {
  const entries: CoverageEntry[] = [];

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
    if (e.kind === "implements") indexEdge(implByTarget, e.target, e.source);
    else if (e.kind === "verifies") indexEdge(testByTarget, e.target, e.source);
  }

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req") continue;

    const implFiles = implByTarget.get(id) ?? [];
    const testFiles = testByTarget.get(id) ?? [];

    let status: CoverageStatus;
    if (implFiles.length === 0) {
      status = "untagged";
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
