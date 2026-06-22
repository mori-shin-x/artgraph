import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { computeCoverage, type CoverageEntry } from "../src/coverage.js";
import type {
  ArtifactGraph,
  EdgeKind,
  NodeKind,
  SpectraceConfig,
  TestResultMap,
  TestResultRecord,
} from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: SpectraceConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

/* ------------------------------------------------------------------ */
/*  Helper                                                            */
/* ------------------------------------------------------------------ */

function makeGraph(
  nodes: Array<{ id: string; kind: NodeKind }>,
  edges: Array<{ source: string; target: string; kind: EdgeKind }>,
): ArtifactGraph {
  const nodeMap = new Map();
  for (const n of nodes) {
    nodeMap.set(n.id, {
      id: n.id,
      kind: n.kind,
      filePath: `${n.id}.ts`,
      contentHash: "abc",
    });
  }
  return { nodes: nodeMap, edges };
}

/* ------------------------------------------------------------------ */
/*  Integration tests (existing)                                      */
/* ------------------------------------------------------------------ */

describe("computeCoverage", () => {
  const { graph } = buildGraph(FIXTURE_DIR, config);

  it("should mark REQ with @impl and test as verified", () => {
    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "AUTH-001");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("verified");
    expect(entry!.implFiles.length).toBeGreaterThan(0);
    expect(entry!.testFiles.length).toBeGreaterThan(0);
  });

  it("should mark REQ with @impl but no test as impl-only", () => {
    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "AUTH-002");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("impl-only");
    expect(entry!.implFiles.length).toBeGreaterThan(0);
    expect(entry!.testFiles).toHaveLength(0);
  });

  it("should mark REQ without @impl as untagged", () => {
    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "AUTH-003");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("untagged");
    expect(entry!.implFiles).toHaveLength(0);
    expect(entry!.testFiles).toHaveLength(0);
  });

  it("should return entries for all REQs", () => {
    const coverage = computeCoverage(graph);
    expect(coverage.length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Unit tests for testResults integration                            */
/* ------------------------------------------------------------------ */

describe("computeCoverage with testResults", () => {
  it("verifies edge + no testResults arg → backward compat verified", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "impl-1", kind: "file" },
        { id: "test-1", kind: "test" },
      ],
      [
        { source: "impl-1", target: "REQ-1", kind: "implements" },
        { source: "test-1", target: "REQ-1", kind: "verifies" },
      ],
    );

    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("verified");
  });

  it("verifies edge + testResults undefined → backward compat verified", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "impl-1", kind: "file" },
        { id: "test-1", kind: "test" },
      ],
      [
        { source: "impl-1", target: "REQ-1", kind: "implements" },
        { source: "test-1", target: "REQ-1", kind: "verifies" },
      ],
    );

    const coverage = computeCoverage(graph, undefined);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("verified");
  });

  it("verifies edge + all tests pass → verified", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "impl-1", kind: "file" },
        { id: "test-1", kind: "test" },
      ],
      [
        { source: "impl-1", target: "REQ-1", kind: "implements" },
        { source: "test-1", target: "REQ-1", kind: "verifies" },
      ],
    );

    const testResults: TestResultMap = new Map([
      [
        "REQ-1",
        [
          { reqId: "REQ-1", testName: "test A", passed: true },
          { reqId: "REQ-1", testName: "test B", passed: true },
        ],
      ],
    ]);

    const coverage = computeCoverage(graph, testResults);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("verified");
  });

  it("verifies edge + one test fails → impl-only", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "impl-1", kind: "file" },
        { id: "test-1", kind: "test" },
      ],
      [
        { source: "impl-1", target: "REQ-1", kind: "implements" },
        { source: "test-1", target: "REQ-1", kind: "verifies" },
      ],
    );

    const testResults: TestResultMap = new Map([
      [
        "REQ-1",
        [
          { reqId: "REQ-1", testName: "test A", passed: true },
          { reqId: "REQ-1", testName: "test B", passed: false },
        ],
      ],
    ]);

    const coverage = computeCoverage(graph, testResults);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("impl-only");
  });

  it("verifies edge + REQ not in testResults map → impl-only", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "impl-1", kind: "file" },
        { id: "test-1", kind: "test" },
      ],
      [
        { source: "impl-1", target: "REQ-1", kind: "implements" },
        { source: "test-1", target: "REQ-1", kind: "verifies" },
      ],
    );

    // Map exists but does not contain REQ-1
    const testResults: TestResultMap = new Map([
      ["REQ-OTHER", [{ reqId: "REQ-OTHER", testName: "other", passed: true }]],
    ]);

    const coverage = computeCoverage(graph, testResults);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("impl-only");
  });

  it("no verifies edge + testResults present → impl-only", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "impl-1", kind: "file" },
      ],
      [{ source: "impl-1", target: "REQ-1", kind: "implements" }],
    );

    const testResults: TestResultMap = new Map([
      ["REQ-1", [{ reqId: "REQ-1", testName: "test A", passed: true }]],
    ]);

    const coverage = computeCoverage(graph, testResults);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("impl-only");
  });

  it("no implements edge → untagged regardless of testResults", () => {
    const graph = makeGraph(
      [{ id: "REQ-1", kind: "req" }],
      [],
    );

    const testResults: TestResultMap = new Map([
      ["REQ-1", [{ reqId: "REQ-1", testName: "test A", passed: true }]],
    ]);

    const coverage = computeCoverage(graph, testResults);
    const entry = coverage.find((c) => c.reqId === "REQ-1");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("untagged");
  });

  it("multiple REQs mixed → correct statuses", () => {
    const graph = makeGraph(
      [
        { id: "REQ-A", kind: "req" },
        { id: "REQ-B", kind: "req" },
        { id: "REQ-C", kind: "req" },
        { id: "impl-a", kind: "file" },
        { id: "impl-b", kind: "file" },
        { id: "test-a", kind: "test" },
        { id: "test-b", kind: "test" },
      ],
      [
        { source: "impl-a", target: "REQ-A", kind: "implements" },
        { source: "test-a", target: "REQ-A", kind: "verifies" },
        { source: "impl-b", target: "REQ-B", kind: "implements" },
        { source: "test-b", target: "REQ-B", kind: "verifies" },
        // REQ-C has no edges at all → untagged
      ],
    );

    const testResults: TestResultMap = new Map([
      // REQ-A: all pass → verified
      ["REQ-A", [{ reqId: "REQ-A", testName: "test A", passed: true }]],
      // REQ-B: one fails → impl-only
      [
        "REQ-B",
        [
          { reqId: "REQ-B", testName: "test B1", passed: true },
          { reqId: "REQ-B", testName: "test B2", passed: false },
        ],
      ],
    ]);

    const coverage = computeCoverage(graph, testResults);

    const entryA = coverage.find((c) => c.reqId === "REQ-A");
    const entryB = coverage.find((c) => c.reqId === "REQ-B");
    const entryC = coverage.find((c) => c.reqId === "REQ-C");

    expect(entryA).toBeDefined();
    expect(entryA!.status).toBe("verified");

    expect(entryB).toBeDefined();
    expect(entryB!.status).toBe("impl-only");

    expect(entryC).toBeDefined();
    expect(entryC!.status).toBe("untagged");
  });
});
