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
});

describe("resolveStartIds (symbol mode)", () => {
  const SYM_FIXTURE = resolve(import.meta.dirname, "fixtures/symbol-level");
  const symConfig: SpectraceConfig = {
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
