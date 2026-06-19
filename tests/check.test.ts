import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { check } from "../src/check.js";
import type { SpectraceConfig, LockFile } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: SpectraceConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("check", () => {
  it("should pass when lock matches current state and all REQs are covered", () => {
    const graph = buildGraph(FIXTURE_DIR, config);
    const reqNode = graph.nodes.get("REQ-7f3a")!;
    const req2Node = graph.nodes.get("REQ-a1b2")!;
    const req3Node = graph.nodes.get("REQ-c3d4")!;

    graph.edges.push({
      source: "file:src/auth/logout.ts",
      target: "REQ-c3d4",
      kind: "implements",
    });

    const lock: LockFile = {
      "REQ-7f3a": {
        contentHash: reqNode.contentHash,
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-a1b2": {
        contentHash: req2Node.contentHash,
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-c3d4": {
        contentHash: req3Node.contentHash,
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = check(graph, lock);
    expect(result.pass).toBe(true);
    expect(result.drifted).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it("should detect drift when spec content changed", () => {
    const graph = buildGraph(FIXTURE_DIR, config);

    const lock: LockFile = {
      "REQ-7f3a": {
        contentHash: "old_hash_value_x",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = check(graph, lock);
    expect(result.pass).toBe(false);
    expect(result.drifted.length).toBeGreaterThanOrEqual(1);
    expect(result.drifted[0].nodeId).toBe("REQ-7f3a");
  });

  it("should detect orphan @impl tags", () => {
    const graph = buildGraph(FIXTURE_DIR, config);
    graph.edges.push({
      source: "file:src/auth/login.ts",
      target: "REQ-ffff",
      kind: "implements",
    });

    const result = check(graph, {});
    expect(result.orphans.length).toBeGreaterThanOrEqual(1);
    expect(result.orphans.some((o) => o.includes("REQ-ffff"))).toBe(true);
  });

  it("should report uncovered REQs", () => {
    const graph = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});

    expect(result.uncovered).toContain("REQ-c3d4");
  });

  it("should fail when there are any issues", () => {
    const graph = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});

    expect(result.pass).toBe(false);
  });
});
