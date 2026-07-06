import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import {
  impact,
  resolveStartIds,
  resolveOriginReqs,
  findOrphans,
  formatOrphan,
  findUncovered,
} from "../src/graph/traverse.js";
import type { ArtgraphConfig, ArtifactGraph, GraphNode, LockFile } from "../src/types.js";

// spec 016 — `resolveFileStartIds` was removed in favor of `resolveStartIds`.
// Provide a local compat shim so spec 014 test bodies still compile/import
// (they exercise file-unit semantics). Phase 3+4 will rewrite the
// downstream assertions; for Phase 2 only the new resolveStartIds /
// resolveOriginReqs describes below are expected to pass.
function resolveFileStartIds(graph: ArtifactGraph, inputs: string[]): string[] {
  return resolveStartIds(
    graph,
    inputs.map((path) => ({ path, line: 0 })),
  ).startIds;
}

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

    expect(result.impactReqs).toContain("AUTH-001");
    expect(result.affectedFiles).toContain("src/auth/login.ts");
    expect(result.affectedFiles).toContain("src/auth/session.ts");
  });

  it("should traverse from a file to connected REQs", () => {
    const ids = resolveFileStartIds(graph, ["src/auth/login.ts"]);
    const result = impact(graph, ids, {});

    expect(result.impactReqs).toContain("AUTH-001");
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
  it("should detect @impl pointing to nonexistent REQ (structured OrphanEdge)", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    graph.edges.push({
      source: "file:src/auth/login.ts",
      target: "FAKE-9999",
      kind: "implements",
      provenances: ["code-tag"],
    });

    // spec 017 (FR-006, data-model §2): findOrphans returns structured
    // { source, target, kind } so callers can do strict source matching.
    const orphans = findOrphans(graph);
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    const fake = orphans.find((o) => o.target === "FAKE-9999");
    expect(fake).toBeDefined();
    expect(fake).toEqual({
      source: "file:src/auth/login.ts",
      target: "FAKE-9999",
      kind: "implements",
    });
  });

  it("formatOrphan renders the canonical `source -> target (kind)` string", () => {
    expect(
      formatOrphan({ source: "file:src/auth/login.ts", target: "FAKE-9999", kind: "implements" }),
    ).toBe("file:src/auth/login.ts -> FAKE-9999 (implements)");
    expect(formatOrphan({ source: "test:src/a.test.ts", target: "REQ-1", kind: "verifies" })).toBe(
      "test:src/a.test.ts -> REQ-1 (verifies)",
    );
  });
});

describe("findUncovered", () => {
  it("should detect REQ without any @impl", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const uncovered = findUncovered(graph);

    expect(uncovered).toContain("AUTH-003");
  });
});

describe("resolveFileStartIds", () => {
  const { graph } = buildGraph(FIXTURE_DIR, config);

  it("should resolve file path to file:path", () => {
    const ids = resolveFileStartIds(graph, ["src/auth/login.ts"]);
    expect(ids).toEqual(["file:src/auth/login.ts"]);
  });

  it("should resolve a spec file path to its parsed doc + req nodes", () => {
    // auth.md has doc:auth-design and req nodes AUTH-001, AUTH-002, AUTH-003.
    // After spec 014 the direct REQ-ID / `doc:` lookups are gone, but the
    // filePath-equality branch still drags in everything parsed out of a
    // spec file when the caller passes the file path itself.
    const ids = resolveFileStartIds(graph, ["specs/auth.md"]);
    expect(ids).toContain("doc:auth-design");
    expect(ids).toContain("AUTH-001");
    expect(ids).toContain("AUTH-002");
    expect(ids).toContain("AUTH-003");
  });

  it("rejects REQ-ID inputs (file-only contract — spec 014 FR-001)", () => {
    // REQ-ID is no longer treated as a start node here; the CLI surfaces a
    // dedicated 4-path error before reaching this function. Verifying the
    // direct call returns empty pins the contract for non-CLI consumers.
    const ids = resolveFileStartIds(graph, ["AUTH-001"]);
    expect(ids).toEqual([]);
  });

  it("rejects bare `doc:` prefix inputs (file-only contract — spec 014 FR-002)", () => {
    const ids = resolveFileStartIds(graph, ["doc:auth-design"]);
    expect(ids).toEqual([]);
  });
});

describe("impact: depth limit (US3)", () => {
  it("T041: should limit traversal with maxDepth", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // Without depth limit, should reach many nodes
    const fullResult = impact(graph, ["AUTH-001"], {});
    const fullCount =
      fullResult.impactReqs.length +
      fullResult.affectedDocs.length +
      fullResult.affectedFiles.length;

    // With maxDepth=1, should reach fewer nodes
    const limitedResult = impact(graph, ["AUTH-001"], {}, 1);
    const limitedCount =
      limitedResult.impactReqs.length +
      limitedResult.affectedDocs.length +
      limitedResult.affectedFiles.length;

    expect(limitedCount).toBeLessThanOrEqual(fullCount);
    // AUTH-001 itself should always be included
    expect(limitedResult.impactReqs).toContain("AUTH-001");
  });

  it("T041b: should not traverse beyond maxDepth", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // With maxDepth=0, only start nodes themselves
    const result = impact(graph, ["AUTH-001"], {}, 0);
    expect(result.impactReqs).toContain("AUTH-001");
    // Should not reach files at depth > 0
    expect(result.affectedFiles).toHaveLength(0);
  });
});

describe("impact: ImpactSummary (US3)", () => {
  it("T044: should include summary with docs, reqs, files counts", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = impact(graph, ["AUTH-001"], {});

    expect(result.summary).toBeDefined();
    expect(result.summary!.reqs).toBe(result.impactReqs.length);
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
    expect(result.impactReqs).toContain("AUTH-001");
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
        {
          source: "doc:A",
          target: "doc:B",
          kind: "derives_from" as const,
          provenances: ["convention"] as const,
        },
        {
          source: "doc:B",
          target: "doc:C",
          kind: "derives_from" as const,
          provenances: ["convention"] as const,
        },
        {
          source: "doc:C",
          target: "doc:A",
          kind: "derives_from" as const,
          provenances: ["convention"] as const,
        },
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
        {
          source: "doc:B",
          target: "doc:A",
          kind: "derives_from" as const,
          provenances: ["convention"] as const,
        },
        {
          source: "doc:C",
          target: "doc:B",
          kind: "derives_from" as const,
          provenances: ["convention"] as const,
        },
        {
          source: "doc:D",
          target: "doc:C",
          kind: "derives_from" as const,
          provenances: ["convention"] as const,
        },
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

describe("resolveFileStartIds (symbol mode)", () => {
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
    const ids = resolveFileStartIds(graph, ["src/utils.ts"]);
    expect(ids).toContain("file:src/utils.ts");
    expect(ids).toContain("symbol:src/utils.ts#foo");
    expect(ids).toContain("symbol:src/utils.ts#bar");
  });

  it("should not include symbol nodes from other files", () => {
    const ids = resolveFileStartIds(graph, ["src/utils.ts"]);
    const defaultSymbols = ids.filter((id) => id.includes("defaults.ts"));
    expect(defaultSymbols).toHaveLength(0);
  });
});

// Meta-review remediation: task-source edges must not "cover" a req for the
// gate, must not be reported as orphans (planning artefacts), and must surface
// in impact() under their own `affectedTasks` channel rather than vanishing.
describe("task-source edge semantics (meta-review remediation)", () => {
  function makeTaskGraph() {
    return {
      nodes: new Map([
        ["FR-001", { id: "FR-001", kind: "req", filePath: "specs/auth.md", contentHash: "h1" }],
        ["T001", { id: "T001", kind: "task", filePath: "specs/auth-tasks.md", contentHash: "h2" }],
      ] as const),
      edges: [
        {
          source: "T001",
          target: "FR-001",
          kind: "implements" as const,
          provenances: ["task-tag"] as const,
        },
        // verifies edge pointing at a Kiro-style numeric ID that is NOT in the
        // node map — the task-source filter must keep this from being reported.
        {
          source: "T001",
          target: "1.1",
          kind: "verifies" as const,
          provenances: ["task-tag"] as const,
        },
      ],
    };
  }

  it("findUncovered ignores task → implements (req must still be flagged uncovered)", () => {
    const graph = makeTaskGraph();
    const uncovered = findUncovered(graph as any);
    expect(uncovered).toContain("FR-001");
  });

  it("findOrphans does not warn for task-source verifies with missing target", () => {
    const graph = makeTaskGraph();
    const orphans = findOrphans(graph as any);
    expect(orphans.some((o) => o.source === "T001" && o.target === "1.1")).toBe(false);
  });

  it("impact() places task nodes into affectedTasks and summary.tasks", () => {
    const graph = makeTaskGraph();
    const result = impact(graph as any, ["T001"], {});
    expect(result.affectedTasks).toContain("T001");
    expect(result.impactReqs).not.toContain("T001"); // not silently bucketed as req
    expect(result.summary?.tasks).toBe(1);
  });

  it("ImpactResult bookkeeping has the new affectedTasks shape", () => {
    const graph = makeTaskGraph();
    const result = impact(graph as any, ["FR-001"], {});
    expect(Array.isArray(result.affectedTasks)).toBe(true);
    expect(result.summary && typeof result.summary.tasks).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// spec 016 — resolveStartIds (replaces resolveFileStartIds)
// ---------------------------------------------------------------------------

function buildSymbolGraph(): ArtifactGraph {
  // Hand-rolled three-export fixture mirroring tests/fixtures/symbol-mode/.
  // We avoid running the scanner here so the test is hermetic and runs in
  // milliseconds; the symbol-mode E2E fixture is exercised separately in
  // Phase 3 (plan-coverage-integration).
  const nodes = new Map<string, GraphNode>();
  const reqIds = ["REQ-001", "REQ-005", "REQ-009"];
  for (const id of reqIds) {
    nodes.set(id, {
      id,
      kind: "req",
      filePath: "specs/001-symbol-demo/spec.md",
      contentHash: "h",
    });
  }
  nodes.set("file:src/auth.ts", {
    id: "file:src/auth.ts",
    kind: "file",
    filePath: "src/auth.ts",
    contentHash: "h",
  });
  for (const sym of ["validateToken", "issueToken", "revokeToken"]) {
    const id = `symbol:src/auth.ts#${sym}`;
    nodes.set(id, {
      id,
      kind: "symbol",
      filePath: "src/auth.ts",
      contentHash: "h",
      label: sym,
    });
  }
  return {
    nodes,
    edges: [
      {
        source: "symbol:src/auth.ts#validateToken",
        target: "REQ-001",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/auth.ts#issueToken",
        target: "REQ-005",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/auth.ts#revokeToken",
        target: "REQ-009",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ],
  };
}

describe("resolveStartIds (spec 016)", () => {
  it("file-unit entry resolves to file node + same-file symbol nodes", () => {
    const graph = buildSymbolGraph();
    const { startIds, unresolvedSymbols } = resolveStartIds(graph, [
      { path: "src/auth.ts", line: 1 },
    ]);
    expect(startIds).toContain("file:src/auth.ts");
    expect(startIds).toContain("symbol:src/auth.ts#validateToken");
    expect(startIds).toContain("symbol:src/auth.ts#issueToken");
    expect(startIds).toContain("symbol:src/auth.ts#revokeToken");
    expect(unresolvedSymbols).toEqual([]);
  });

  it("symbol-unit entry resolves to the symbol node WITHOUT the parent file (R-006)", () => {
    const graph = buildSymbolGraph();
    const { startIds, unresolvedSymbols } = resolveStartIds(graph, [
      { path: "src/auth.ts", symbol: "validateToken", line: 1 },
    ]);
    expect(startIds).toEqual(["symbol:src/auth.ts#validateToken"]);
    // Crucially: file node is NOT included — that's what blocks the BFS
    // from sweeping sibling symbols via the file parent.
    expect(startIds).not.toContain("file:src/auth.ts");
    expect(startIds).not.toContain("symbol:src/auth.ts#issueToken");
    expect(unresolvedSymbols).toEqual([]);
  });

  it("file + symbol mixed entries preserve input order in startIds", () => {
    const graph = buildSymbolGraph();
    const { startIds } = resolveStartIds(graph, [
      { path: "src/auth.ts", symbol: "validateToken", line: 1 },
      { path: "src/auth.ts", line: 2 },
    ]);
    // First entry produces the symbol id first; the second entry then drags
    // in the file node (and same-file symbols), preserving the input order.
    expect(startIds[0]).toBe("symbol:src/auth.ts#validateToken");
    expect(startIds).toContain("file:src/auth.ts");
  });

  it("unresolved symbols accumulate in `unresolvedSymbols[]` in input order", () => {
    const graph = buildSymbolGraph();
    const { startIds, unresolvedSymbols } = resolveStartIds(graph, [
      { path: "src/auth.ts", symbol: "doesNotExist", line: 1 },
      { path: "src/auth.ts", symbol: "alsoMissing", line: 2 },
      { path: "src/auth.ts", symbol: "validateToken", line: 3 },
    ]);
    expect(startIds).toEqual(["symbol:src/auth.ts#validateToken"]);
    expect(unresolvedSymbols).toEqual([
      { path: "src/auth.ts", symbol: "doesNotExist", line: 1 },
      { path: "src/auth.ts", symbol: "alsoMissing", line: 2 },
    ]);
  });

  it("startIds are deduplicated (INV-S2): same entry twice yields one id", () => {
    const graph = buildSymbolGraph();
    const { startIds } = resolveStartIds(graph, [
      { path: "src/auth.ts", symbol: "validateToken", line: 1 },
      { path: "src/auth.ts", symbol: "validateToken", line: 2 },
    ]);
    expect(startIds).toEqual(["symbol:src/auth.ts#validateToken"]);
  });
});

// ---------------------------------------------------------------------------
// spec 016 — resolveOriginReqs (R-015, INV-S5/INV-S6)
// ---------------------------------------------------------------------------

describe("resolveOriginReqs (spec 016)", () => {
  it("returns the REQ ids claimed by each startId via `implements`", () => {
    const graph = buildSymbolGraph();
    const reqs = resolveOriginReqs(graph, ["symbol:src/auth.ts#validateToken"]);
    expect(reqs).toEqual(["REQ-001"]);
  });

  it("returns dedup'd, reqId-asc-sorted union across multiple startIds", () => {
    const graph = buildSymbolGraph();
    const reqs = resolveOriginReqs(graph, [
      "symbol:src/auth.ts#revokeToken",
      "symbol:src/auth.ts#issueToken",
      "symbol:src/auth.ts#validateToken",
    ]);
    expect(reqs).toEqual(["REQ-001", "REQ-005", "REQ-009"]);
  });

  it("returns [] when no startId has any `@impl` claim", () => {
    const graph = buildSymbolGraph();
    // file node intentionally lacks any outbound `implements` edge.
    const reqs = resolveOriginReqs(graph, ["file:src/auth.ts"]);
    expect(reqs).toEqual([]);
  });

  it("returns [] when startIds is empty", () => {
    const graph = buildSymbolGraph();
    expect(resolveOriginReqs(graph, [])).toEqual([]);
  });

  it("dedups REQs even when two startIds claim the same REQ", () => {
    // Construct an extra `implements` edge so two symbols both claim REQ-001,
    // then verify the result has only one REQ-001 entry.
    const graph = buildSymbolGraph();
    graph.edges.push({
      source: "symbol:src/auth.ts#issueToken",
      target: "REQ-001",
      kind: "implements",
      provenances: ["code-tag"],
    });
    const reqs = resolveOriginReqs(graph, [
      "symbol:src/auth.ts#validateToken",
      "symbol:src/auth.ts#issueToken",
    ]);
    expect(reqs).toEqual(["REQ-001", "REQ-005"]);
  });

  it("ignores non-implements edges", () => {
    const graph = buildSymbolGraph();
    graph.edges.push({
      source: "symbol:src/auth.ts#validateToken",
      target: "REQ-009",
      kind: "depends_on",
      provenances: ["convention"],
    });
    const reqs = resolveOriginReqs(graph, ["symbol:src/auth.ts#validateToken"]);
    // REQ-009 must NOT appear — `depends_on` is not the `implements` axis.
    expect(reqs).toEqual(["REQ-001"]);
  });
});
