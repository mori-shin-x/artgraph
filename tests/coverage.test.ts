import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { computeCoverage, type CoverageEntry } from "../src/coverage.js";
import type {
  ArtifactGraph,
  EdgeKind,
  NodeKind,
  ArtgraphConfig,
  TestResultMap,
  TestResultRecord,
} from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: ArtgraphConfig = {
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
  // Issue #35: every edge now requires a non-empty `provenances`. For these
  // unit-test fixtures the value is informational only (coverage logic ignores
  // it), so pick a kind-appropriate default per the mapping in
  // contracts/edge-provenance-type.md.
  const provDefault: Record<
    EdgeKind,
    | "annotation"
    | "frontmatter"
    | "convention"
    | "code-tag"
    | "task-tag"
    | "inline-link"
    | "ts-import"
    | "structural"
  > = {
    depends_on: "annotation",
    derives_from: "frontmatter",
    implements: "code-tag",
    verifies: "code-tag",
    imports: "ts-import",
    contains: "structural",
  };
  return {
    nodes: nodeMap,
    edges: edges.map((e) => ({ ...e, provenances: [provDefault[e.kind]] })),
  };
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
    const graph = makeGraph([{ id: "REQ-1", kind: "req" }], []);

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

describe("computeCoverage — task sources are excluded (Issue #28 / data-model §7)", () => {
  it("a req with only task → implements is `untagged`", () => {
    const graph = makeGraph(
      [
        { id: "REQ-1", kind: "req" },
        { id: "T001", kind: "task" },
      ],
      [{ source: "T001", target: "REQ-1", kind: "implements" }],
    );
    const cov = computeCoverage(graph);
    expect(cov.find((c) => c.reqId === "REQ-1")?.status).toBe("untagged");
  });

  it("a req with task → verifies but no real test stays `impl-only` (not upgraded)", () => {
    const graph = makeGraph(
      [
        { id: "REQ-2", kind: "req" },
        { id: "file:src/foo.ts", kind: "file" },
        { id: "T002", kind: "task" },
      ],
      [
        { source: "file:src/foo.ts", target: "REQ-2", kind: "implements" },
        { source: "T002", target: "REQ-2", kind: "verifies" },
      ],
    );
    const cov = computeCoverage(graph);
    // With a real impl but only a task-source verifies, the req must NOT be
    // labelled "verified" — task verifies are planning artefacts, not test runs.
    expect(cov.find((c) => c.reqId === "REQ-2")?.status).toBe("impl-only");
  });

  it("a req with real test verifies stays `verified` even when a task also verifies", () => {
    const graph = makeGraph(
      [
        { id: "REQ-3", kind: "req" },
        { id: "file:src/foo.ts", kind: "file" },
        { id: "file:tests/foo.test.ts", kind: "test" },
        { id: "T003", kind: "task" },
      ],
      [
        { source: "file:src/foo.ts", target: "REQ-3", kind: "implements" },
        { source: "file:tests/foo.test.ts", target: "REQ-3", kind: "verifies" },
        { source: "T003", target: "REQ-3", kind: "verifies" },
      ],
    );
    const cov = computeCoverage(graph);
    expect(cov.find((c) => c.reqId === "REQ-3")?.status).toBe("verified");
    // testFiles must list the real test only, not the task.
    expect(cov.find((c) => c.reqId === "REQ-3")?.testFiles).toEqual(["file:tests/foo.test.ts"]);
  });
});
