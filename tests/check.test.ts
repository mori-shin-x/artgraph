import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { check } from "../src/check.js";
import type {
  ArtgraphConfig,
  LockFile,
  TestResultMap,
  ArtifactGraph,
} from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("check", () => {
  it("should pass when lock matches current state and all REQs are covered", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // Cover all req nodes with fake @impl edges
    for (const [id, node] of graph.nodes) {
      if (node.kind !== "req") continue;
      const hasImpl = graph.edges.some((e) => e.kind === "implements" && e.target === id);
      if (!hasImpl) {
        graph.edges.push({
          source: "file:fake-impl.ts",
          target: id,
          kind: "implements",
        });
      }
    }

    // Lock all req and doc nodes
    const lock: LockFile = {};
    for (const [id, node] of graph.nodes) {
      if (node.kind === "req" || node.kind === "doc") {
        lock[id] = {
          contentHash: node.contentHash,
          lastReconciled: "2025-01-01T00:00:00Z",
        };
      }
    }

    const result = check(graph, lock);
    expect(result.pass).toBe(true);
    expect(result.drifted).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it("should detect drift when spec content changed", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    const lock: LockFile = {
      "AUTH-001": {
        contentHash: "old_hash_value_x",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = check(graph, lock);
    expect(result.pass).toBe(false);
    expect(result.drifted.length).toBeGreaterThanOrEqual(1);
    expect(result.drifted[0].nodeId).toBe("AUTH-001");
  });

  it("should detect orphan @impl tags", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    graph.edges.push({
      source: "file:src/auth/login.ts",
      target: "FAKE-9999",
      kind: "implements",
    });

    const result = check(graph, {});
    expect(result.orphans.length).toBeGreaterThanOrEqual(1);
    expect(result.orphans.some((o) => o.includes("FAKE-9999"))).toBe(true);
  });

  it("should report uncovered REQs", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});

    expect(result.uncovered).toContain("AUTH-003");
  });

  it("should fail when there are any issues", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});

    expect(result.pass).toBe(false);
  });

  // A minimal, fully-covered graph: one REQ with both an implements and a
  // verifies edge, locked so drift/orphans/uncovered are all clean. This
  // isolates the gate's reaction to test pass/fail.
  function coveredGraph(reqId = "REQ-100"): { graph: ArtifactGraph; lock: LockFile } {
    const graph: ArtifactGraph = {
      nodes: new Map([
        [reqId, { id: reqId, kind: "req", filePath: "specs/x.md", contentHash: "h1" }],
      ]),
      edges: [
        { source: "file:impl.ts", target: reqId, kind: "implements" },
        { source: "file:impl.test.ts", target: reqId, kind: "verifies" },
      ],
    };
    const lock: LockFile = {
      [reqId]: { contentHash: "h1", lastReconciled: "2025-01-01T00:00:00Z" },
    };
    return { graph, lock };
  }

  it("should fail the gate when a covered REQ's test fails", () => {
    const reqId = "REQ-100";

    // Passing results: gate clean.
    const { graph, lock } = coveredGraph(reqId);
    const passing: TestResultMap = new Map([
      [reqId, [{ reqId, testName: "t", passed: true }]],
    ]);
    const passed = check(graph, lock, undefined, passing);
    expect(passed.pass).toBe(true);
    expect(passed.testFailures).toEqual([]);

    // Failing results: gate fails and the REQ is listed under testFailures.
    const failing: TestResultMap = new Map([
      [reqId, [{ reqId, testName: "t", passed: false }]],
    ]);
    const failed = check(graph, lock, undefined, failing);
    expect(failed.pass).toBe(false);
    expect(failed.testFailures).toContain(reqId);
  });

  it("should leave testFailures empty (and pass) when no test results are supplied", () => {
    const { graph, lock } = coveredGraph();
    const result = check(graph, lock);
    expect(result.testFailures).toEqual([]);
    expect(result.pass).toBe(true);
  });
});
