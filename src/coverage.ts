import type { ArtifactGraph, CoverageStatus, TestResultMap } from "./types.js";

export interface CoverageEntry {
  reqId: string;
  status: CoverageStatus;
  implFiles: string[];
  testFiles: string[];
}

export function computeCoverage(graph: ArtifactGraph, testResults?: TestResultMap): CoverageEntry[] {
  const entries: CoverageEntry[] = [];

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req") continue;

    const implEdges = graph.edges.filter((e) => e.kind === "implements" && e.target === id);
    const testEdges = graph.edges.filter((e) => e.kind === "verifies" && e.target === id);

    const implFiles = implEdges.map((e) => e.source);
    const testFiles = testEdges.map((e) => e.source);

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
