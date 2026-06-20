import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import type { SpectraceConfig } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/ns-collision");

const config: SpectraceConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("buildGraph: namespace collision resolution", () => {
  it("should qualify colliding IDs with spec directory name", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // FR-001 exists in both ns-a and ns-b, so should be qualified
    expect(graph.nodes.has("ns-a/FR-001")).toBe(true);
    expect(graph.nodes.has("ns-b/FR-001")).toBe(true);
    // Raw FR-001 should NOT exist
    expect(graph.nodes.has("FR-001")).toBe(false);
  });

  it("should keep unique IDs unqualified", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // FR-002 only exists in ns-a, SC-001 only in ns-b — no collision
    expect(graph.nodes.has("FR-002")).toBe(true);
    expect(graph.nodes.has("SC-001")).toBe(true);
  });

  it("should resolve qualified @impl to correct node", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // ns-impl.ts has `// @impl ns-a/FR-001`
    const implEdges = graph.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/ns-impl.ts",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].target).toBe("ns-a/FR-001");
  });

  it("should warn on ambiguous unqualified @impl for colliding IDs", () => {
    const { graph, warnings } = buildGraph(FIXTURE_DIR, config);

    // ambiguous-impl.ts has `// @impl FR-001` which is ambiguous
    const ambiguousWarnings = warnings.filter(
      (w) => w.type === "ambiguous-id" && w.id === "FR-001",
    );
    expect(ambiguousWarnings.length).toBeGreaterThanOrEqual(1);
  });
});
