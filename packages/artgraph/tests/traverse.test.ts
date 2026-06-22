import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { impact, resolveStartIds, findOrphans, findUncovered } from "../src/graph/traverse.js";
import type { ArtgraphConfig, LockFile } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: ArtgraphConfig = {
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
    expect(ids).toContain("doc:prose-only.md");
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

describe("impact: cyclic doc-to-doc graph", () => {
  it("should terminate without infinite loop on cyclic derives_from", () => {
    const cyclicGraph = {
      nodes: new Map([
        ["doc:A", { id: "doc:A", kind: "doc" as const, filePath: "a.md", contentHash: "h1" }],
        ["doc:B", { id: "doc:B", kind: "doc" as const, filePath: "b.md", contentHash: "h2" }],
        ["doc:C", { id: "doc:C", kind: "doc" as const, filePath: "c.md", contentHash: "h3" }],
      ]),
      edges: [
        { source: "doc:A", target: "doc:B", kind: "derives_from" as const },
        { source: "doc:B", target: "doc:C", kind: "derives_from" as const },
        { source: "doc:C", target: "doc:A", kind: "derives_from" as const },
      ],
    };
    const result = impact(cyclicGraph, ["doc:A"], {});
    expect(result.affectedDocs).toContain("doc:A");
    expect(result.affectedDocs).toContain("doc:B");
    expect(result.affectedDocs).toContain("doc:C");
    expect(result.affectedDocs).toHaveLength(3);
  });

  it("should respect maxDepth in cyclic graph (bidirectional traversal)", () => {
    // Linear chain: A -> B -> C -> D (no cycle back)
    const linearGraph = {
      nodes: new Map([
        ["doc:A", { id: "doc:A", kind: "doc" as const, filePath: "a.md", contentHash: "h1" }],
        ["doc:B", { id: "doc:B", kind: "doc" as const, filePath: "b.md", contentHash: "h2" }],
        ["doc:C", { id: "doc:C", kind: "doc" as const, filePath: "c.md", contentHash: "h3" }],
        ["doc:D", { id: "doc:D", kind: "doc" as const, filePath: "d.md", contentHash: "h4" }],
      ]),
      edges: [
        { source: "doc:B", target: "doc:A", kind: "derives_from" as const },
        { source: "doc:C", target: "doc:B", kind: "derives_from" as const },
        { source: "doc:D", target: "doc:C", kind: "derives_from" as const },
      ],
    };
    // From B with depth=1: reaches A (backward via B->A) and C (forward via C->B)
    // D is at depth 2 from B and should NOT be reached
    const result = impact(linearGraph, ["doc:B"], {}, 1);
    expect(result.affectedDocs).toContain("doc:B");
    expect(result.affectedDocs).toContain("doc:A");
    expect(result.affectedDocs).toContain("doc:C");
    expect(result.affectedDocs).not.toContain("doc:D");
  });
});

describe("resolveStartIds (symbol mode)", () => {
  const SYM_FIXTURE = resolve(import.meta.dirname, "fixtures/symbol-level");
  const symConfig: ArtgraphConfig = {
    include: ["src/**/*.ts"],
    specDirs: ["specs"],
    testPatterns: [],
    lockFile: ".trace.lock",
    mode: "symbol",
  };
  const { graph } = buildGraph(SYM_FIXTURE, symConfig);

  it("should include symbol nodes when resolving file path", () => {
    const ids = resolveStartIds(graph, ["src/utils.ts"]);
    expect(ids).toContain("file:src/utils.ts");
    expect(ids).toContain("symbol:src/utils.ts#foo");
    expect(ids).toContain("symbol:src/utils.ts#bar");
  });

  it("should not include symbol nodes from other files", () => {
    const ids = resolveStartIds(graph, ["src/utils.ts"]);
    const defaultSymbols = ids.filter((id) => id.includes("defaults.ts"));
    expect(defaultSymbols).toHaveLength(0);
  });
});
