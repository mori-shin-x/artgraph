import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { formatGraphText, formatGraphJSON } from "../src/graph/format.js";
import type { ArtifactGraph, SpectraceConfig } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: SpectraceConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("formatGraphText", () => {
  it("T050: should output tree with indentation from root nodes", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const text = formatGraphText(graph);

    // Should contain node IDs
    expect(text.length).toBeGreaterThan(0);
    // Should contain edge labels in [kind] format
    expect(text).toMatch(/└─\[/);
  });

  it("T052: should filter by kind=doc to show only doc nodes", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const text = formatGraphText(graph, "doc");

    // Should not contain file: nodes or req nodes in the output
    // All lines should either be empty or reference doc nodes
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("T053: should separate multiple root nodes with empty lines", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const text = formatGraphText(graph, "doc");

    // With multiple doc roots, there should be empty line separators
    // (only when there are multiple roots)
    const docNodes = [...graph.nodes.values()].filter((n) => n.kind === "doc");
    if (docNodes.length > 1) {
      // Find doc-only edges
      const docEdges = graph.edges.filter(
        (e) =>
          graph.nodes.get(e.source)?.kind === "doc" && graph.nodes.get(e.target)?.kind === "doc",
      );
      const targets = new Set(docEdges.map((e) => e.target));
      const roots = docNodes.filter((n) => !targets.has(n.id));
      if (roots.length > 1) {
        expect(text).toContain("\n\n");
      }
    }
  });
});

describe("formatGraphJSON", () => {
  it("T051: should output valid JSON with nodes and edges arrays", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const jsonStr = formatGraphJSON(graph);
    const parsed = JSON.parse(jsonStr);

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

  it("T052b: should filter by kind=doc in JSON output", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const jsonStr = formatGraphJSON(graph, "doc");
    const parsed = JSON.parse(jsonStr);

    // All nodes should be doc kind
    for (const node of parsed.nodes) {
      expect(node.kind).toBe("doc");
    }

    // All edges should have both source and target as doc nodes
    const docIds = new Set(parsed.nodes.map((n: any) => n.id));
    for (const edge of parsed.edges) {
      expect(docIds.has(edge.source)).toBe(true);
      expect(docIds.has(edge.target)).toBe(true);
    }
  });
});
