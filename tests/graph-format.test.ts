import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { graphToJSON } from "../src/graph/format.js";
import type { ArtifactGraph, ArtgraphConfig } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("graphToJSON", () => {
  it("T051: should produce nodes and edges arrays", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const parsed = graphToJSON(graph);

    expect(parsed.nodes).toBeDefined();
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.edges).toBeDefined();
    expect(Array.isArray(parsed.edges)).toBe(true);

    // Each node should have id, kind, filePath
    for (const node of parsed.nodes) {
      expect(node.id).toBeDefined();
      expect(node.kind).toBeDefined();
      expect(node.filePath).toBeDefined();
    }

    // Each edge should have source, target, kind
    for (const edge of parsed.edges) {
      expect(edge.source).toBeDefined();
      expect(edge.target).toBeDefined();
      expect(edge.kind).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #35 — provenance output invariants (INV-O1..O4)
// ---------------------------------------------------------------------------

describe("graphToJSON: provenances field", () => {
  it("INV-O2: an edge whose every provenance is forward-incompatible is omitted", () => {
    // An edge whose every provenance is unknown to EDGE_PROVENANCE_VALUES
    // must be dropped from the output entirely so the NonEmpty invariant
    // survives the wire (cli-output-format.md §INV-O2).
    const graph: ArtifactGraph = {
      nodes: new Map([
        ["doc:A", { id: "doc:A", kind: "doc", filePath: "a.md", contentHash: "h1" }],
        ["doc:B", { id: "doc:B", kind: "doc", filePath: "b.md", contentHash: "h2" }],
      ]),
      edges: [
        {
          source: "doc:B",
          target: "doc:A",
          kind: "derives_from",
          // `as any` simulates a future EdgeProvenance value not yet known
          // to this build (forward-incompatible payload).
          provenances: ["__future__"] as any,
        },
      ],
    };
    const json = graphToJSON(graph);
    expect(json.edges).toEqual([]);
  });

  it("INV-O3: every edge has provenances length>=1", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const out = graphToJSON(graph);
    for (const edge of out.edges) {
      expect(Array.isArray(edge.provenances)).toBe(true);
      expect(edge.provenances.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("INV-O4: legacy singular `provenance` field absent from JSON", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const out = graphToJSON(graph);
    for (const edge of out.edges) {
      expect(edge).not.toHaveProperty("provenance");
    }
  });

  it("INV-O1: provenances are sorted in JSON output", () => {
    const graph: ArtifactGraph = {
      nodes: new Map([
        ["doc:A", { id: "doc:A", kind: "doc", filePath: "a.md", contentHash: "h1" }],
        ["doc:B", { id: "doc:B", kind: "doc", filePath: "b.md", contentHash: "h2" }],
      ]),
      edges: [
        {
          source: "doc:B",
          target: "doc:A",
          kind: "derives_from",
          provenances: ["frontmatter", "convention"],
        },
      ],
    };
    const out = graphToJSON(graph);
    expect(out.edges[0].provenances).toEqual(["convention", "frontmatter"]);
  });
});

describe("graphToJSON: empty graph", () => {
  it("should return empty arrays for graph with no nodes", () => {
    const graph: ArtifactGraph = {
      nodes: new Map(),
      edges: [],
    };
    const parsed = graphToJSON(graph);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.edges).toEqual([]);
  });
});
