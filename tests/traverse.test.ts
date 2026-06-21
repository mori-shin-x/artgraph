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

  it("should traverse from AUTH-001 to its implementors and tests", () => {
    const result = impact(graph, ["AUTH-001"], {});

    expect(result.affectedReqs).toContain("AUTH-001");
    expect(result.affectedFiles).toContain("src/auth/login.ts");
    expect(result.affectedFiles).toContain("src/auth/session.ts");
  });

  it("should traverse from a file to connected REQs", () => {
    const ids = resolveStartIds(graph, ["src/auth/login.ts"]);
    const result = impact(graph, ids, {});

    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("should detect drift when lock hash differs", () => {
    const staleLock: LockFile = {
      "AUTH-001": {
        contentHash: "stale_hash_value",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = impact(graph, ["AUTH-001"], staleLock);

    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].nodeId).toBe("AUTH-001");
    expect(result.drifted[0].lockedHash).toBe("stale_hash_value");
  });

  it("should report no drift when lock hash matches", () => {
    const reqNode = graph.nodes.get("AUTH-001")!;
    const freshLock: LockFile = {
      "AUTH-001": {
        contentHash: reqNode.contentHash,
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = impact(graph, ["AUTH-001"], freshLock);
    expect(result.drifted).toHaveLength(0);
  });
});

describe("findOrphans", () => {
  it("should detect @impl pointing to nonexistent REQ", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    graph.edges.push({
      source: "file:src/auth/login.ts",
      target: "FAKE-9999",
      kind: "implements",
    });

    const orphans = findOrphans(graph);
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(orphans.some((o) => o.includes("FAKE-9999"))).toBe(true);
  });
});

describe("findUncovered", () => {
  it("should detect REQ without any @impl", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const uncovered = findUncovered(graph);

    expect(uncovered).toContain("AUTH-003");
  });
});

describe("resolveStartIds", () => {
  const { graph } = buildGraph(FIXTURE_DIR, config);

  it("should resolve REQ-ID directly", () => {
    const ids = resolveStartIds(graph, ["AUTH-001"]);
    expect(ids).toEqual(["AUTH-001"]);
  });

  it("should resolve file path to file:path", () => {
    const ids = resolveStartIds(graph, ["src/auth/login.ts"]);
    expect(ids).toEqual(["file:src/auth/login.ts"]);
  });

  it("T042: should resolve doc: prefix for file paths", () => {
    const ids = resolveStartIds(graph, ["specs/prose-only.md"]);
    expect(ids).toContain("doc:specs/prose-only.md");
  });

  it("should resolve file path to both doc and req nodes in the same file", () => {
    // auth.md has doc:auth-design and req nodes AUTH-001, AUTH-002, AUTH-003
    const ids = resolveStartIds(graph, ["specs/auth.md"]);
    expect(ids).toContain("doc:auth-design");
    expect(ids).toContain("AUTH-001");
    expect(ids).toContain("AUTH-002");
    expect(ids).toContain("AUTH-003");
  });
});

describe("impact: depth limit (US3)", () => {
  it("T041: should limit traversal with maxDepth", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // Without depth limit, should reach many nodes
    const fullResult = impact(graph, ["AUTH-001"], {});
    const fullCount =
      fullResult.affectedReqs.length +
      fullResult.affectedDocs.length +
      fullResult.affectedFiles.length;

    // With maxDepth=1, should reach fewer nodes
    const limitedResult = impact(graph, ["AUTH-001"], {}, 1);
    const limitedCount =
      limitedResult.affectedReqs.length +
      limitedResult.affectedDocs.length +
      limitedResult.affectedFiles.length;

    expect(limitedCount).toBeLessThanOrEqual(fullCount);
    // AUTH-001 itself should always be included
    expect(limitedResult.affectedReqs).toContain("AUTH-001");
  });

  it("T041b: should not traverse beyond maxDepth", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // With maxDepth=0, only start nodes themselves
    const result = impact(graph, ["AUTH-001"], {}, 0);
    expect(result.affectedReqs).toContain("AUTH-001");
    // Should not reach files at depth > 0
    expect(result.affectedFiles).toHaveLength(0);
  });
});

describe("impact: ImpactSummary (US3)", () => {
  it("T044: should include summary with docs, reqs, files counts", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = impact(graph, ["AUTH-001"], {});

    expect(result.summary).toBeDefined();
    expect(result.summary!.reqs).toBe(result.affectedReqs.length);
    expect(result.summary!.docs).toBe(result.affectedDocs.length);
    expect(result.summary!.files).toBe(result.affectedFiles.length);
  });
});

describe("impact: end-to-end trace via contains (US3)", () => {
  it("T043: should traverse from doc through contains to req to impl file", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // Start from doc:auth-design (the doc node for auth.md)
    const result = impact(graph, ["doc:auth-design"], {});

    // Should reach AUTH-001 via contains edge
    expect(result.affectedReqs).toContain("AUTH-001");
    // Should reach implementation files via implements edge
    expect(result.affectedFiles).toContain("src/auth/login.ts");
  });
});
