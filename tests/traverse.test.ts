import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { impact, resolveStartIds, findOrphans, findUncovered } from "../src/graph/traverse.js";
import type { SpectraceConfig, LockFile } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: SpectraceConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("impact traversal", () => {
  const { graph } = buildGraph(FIXTURE_DIR, config);

  it("should traverse from REQ-7f3a to its implementors and tests", () => {
    const result = impact(graph, ["REQ-7f3a"], {});

    expect(result.affectedReqs).toContain("REQ-7f3a");
    expect(result.affectedFiles).toContain("src/auth/login.ts");
    expect(result.affectedFiles).toContain("src/auth/session.ts");
  });

  it("should traverse from a file to connected REQs", () => {
    const ids = resolveStartIds(graph, ["src/auth/login.ts"]);
    const result = impact(graph, ids, {});

    expect(result.affectedReqs).toContain("REQ-7f3a");
  });

  it("should detect drift when lock hash differs", () => {
    const staleLock: LockFile = {
      "REQ-7f3a": {
        contentHash: "stale_hash_value",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = impact(graph, ["REQ-7f3a"], staleLock);

    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].nodeId).toBe("REQ-7f3a");
    expect(result.drifted[0].lockedHash).toBe("stale_hash_value");
  });

  it("should report no drift when lock hash matches", () => {
    const reqNode = graph.nodes.get("REQ-7f3a")!;
    const freshLock: LockFile = {
      "REQ-7f3a": {
        contentHash: reqNode.contentHash,
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = impact(graph, ["REQ-7f3a"], freshLock);
    expect(result.drifted).toHaveLength(0);
  });
});

describe("findOrphans", () => {
  it("should detect @impl pointing to nonexistent REQ", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    graph.edges.push({
      source: "file:src/auth/login.ts",
      target: "REQ-dead",
      kind: "implements",
    });

    const orphans = findOrphans(graph);
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(orphans.some((o) => o.includes("REQ-dead"))).toBe(true);
  });
});

describe("findUncovered", () => {
  it("should detect REQ without any @impl", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const uncovered = findUncovered(graph);

    expect(uncovered).toContain("REQ-c3d4");
  });
});

describe("resolveStartIds", () => {
  const { graph } = buildGraph(FIXTURE_DIR, config);

  it("should resolve REQ-ID directly", () => {
    const ids = resolveStartIds(graph, ["REQ-7f3a"]);
    expect(ids).toEqual(["REQ-7f3a"]);
  });

  it("should resolve file path to file:path", () => {
    const ids = resolveStartIds(graph, ["src/auth/login.ts"]);
    expect(ids).toEqual(["file:src/auth/login.ts"]);
  });
});
