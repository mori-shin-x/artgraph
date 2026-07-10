import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import { check } from "../src/check.js";
import type { ArtgraphConfig } from "../src/types.js";

// issue #216 — `ignoreIdPrefixes` regression suite. Spec Kit's spec-template
// mandates a `## Success Criteria` section whose `SC-NNN` ids share the
// requirement-ID grammar but are NOT implementation-trackable requirements.
// Without the setting they become permanently-UNCOVERED req nodes; with
// `"ignoreIdPrefixes": ["SC"]` they must vanish from the graph entirely —
// no req node, no code/test/task/annotation edges, no orphan warnings — while
// the default (setting absent) keeps the pre-#216 behavior byte-for-byte.

const baseConfig: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.test.ts"],
  lockFile: ".trace.lock",
};

let projectDir: string;

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "artgraph-ignore-prefix-"));
  mkdirSync(join(projectDir, "specs", "001-demo"), { recursive: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "tests"), { recursive: true });

  // Spec Kit-shaped spec.md: FR requirements + SC success criteria, plus an
  // annotation referencing an SC id and a near-miss SCX prefix.
  writeFileSync(
    join(projectDir, "specs", "001-demo", "spec.md"),
    [
      "# Demo Feature",
      "",
      "## Requirements",
      "",
      "- **FR-001**: The system MUST do the thing. (depends_on: SC-001)",
      "- **FR-002**: The system MUST do the other thing.",
      '- **SCX-001**: Prefix near-miss — must NOT be ignored by "SC".',
      "",
      "## Success Criteria",
      "",
      "- **SC-001**: Users complete the flow in under 2 minutes.",
      "- **SC-002**: 95% of tasks succeed on first try.",
      "",
    ].join("\n"),
  );

  // Code side: valid FR claims plus SC claims (bare + namespaced) that must
  // emit no edge when the prefix is ignored.
  writeFileSync(
    join(projectDir, "src", "impl.ts"),
    [
      "// @impl FR-001",
      "export function doThing(): number {",
      "  return 1;",
      "}",
      "// @impl FR-002",
      "export function doOtherThing(): number {",
      "  return 2;",
      "}",
      "// @impl SCX-001",
      "export function nearMiss(): number {",
      "  return 3;",
      "}",
      "// @impl SC-001",
      "export function scClaim(): number {",
      "  return 4;",
      "}",
      "// @impl 001-demo/SC-002",
      "export function scClaimNamespaced(): number {",
      "  return 5;",
      "}",
    ].join("\n"),
  );

  // Test side: an SC test marker that must not produce a verifies edge when
  // ignored.
  writeFileSync(
    join(projectDir, "tests", "sc.test.ts"),
    ['it("[SC-001] outcome-level marker", () => {});', ""].join("\n"),
  );
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("ignoreIdPrefixes: setting present", () => {
  const config: ArtgraphConfig = { ...baseConfig, ignoreIdPrefixes: ["SC"] };

  it("does not register req nodes for ignored-prefix ids", () => {
    const { graph } = buildGraph(projectDir, config);
    expect(graph.nodes.has("SC-001")).toBe(false);
    expect(graph.nodes.has("SC-002")).toBe(false);
    // Non-ignored ids are untouched.
    expect(graph.nodes.has("FR-001")).toBe(true);
    expect(graph.nodes.has("FR-002")).toBe(true);
  });

  it('matches the whole prefix — "SC" does not ignore SCX-001', () => {
    const { graph } = buildGraph(projectDir, config);
    expect(graph.nodes.has("SCX-001")).toBe(true);
    const scxImpl = graph.edges.filter((e) => e.kind === "implements" && e.target === "SCX-001");
    expect(scxImpl).toHaveLength(1);
  });

  it("drops code @impl and test-marker edges targeting ignored ids (bare and namespaced)", () => {
    const { graph } = buildGraph(projectDir, config);
    const scEdges = graph.edges.filter(
      (e) => e.target === "SC-001" || e.target === "SC-002" || e.target === "001-demo/SC-002",
    );
    expect(scEdges).toHaveLength(0);
  });

  it("drops annotation edges referencing ignored ids without orphan-edge noise", () => {
    const { graph, warnings } = buildGraph(projectDir, config);
    const annEdges = graph.edges.filter(
      (e) => e.provenances.includes("annotation") && e.target === "SC-001",
    );
    expect(annEdges).toHaveLength(0);
    expect(warnings.filter((w) => /SC-\d/.test(w.id))).toHaveLength(0);
  });

  it("keeps check quiet: no UNCOVERED / ORPHAN entries for ignored ids", () => {
    const { graph } = buildGraph(projectDir, config);
    const lock = buildLockFromGraph(graph);
    const result = check(graph, lock);
    expect(result.uncovered.filter((id) => id.includes("SC-"))).toHaveLength(0);
    expect(result.orphans.filter((o) => o.includes("SC-"))).toHaveLength(0);
    expect(result.coverage.some((c) => c.reqId === "SC-001" || c.reqId === "SC-002")).toBe(false);
  });
});

describe("ignoreIdPrefixes: setting absent (backward compatibility)", () => {
  it("keeps the pre-#216 behavior — SC ids are req nodes and show as UNCOVERED", () => {
    const { graph } = buildGraph(projectDir, baseConfig);
    expect(graph.nodes.has("SC-001")).toBe(true);
    expect(graph.nodes.has("SC-002")).toBe(true);

    const lock = buildLockFromGraph(graph);
    const result = check(graph, lock);
    // SC-002 has no valid code claim (the namespaced tag doesn't resolve), so
    // it stays uncovered — the exact noise issue #216 reports.
    expect(result.uncovered).toContain("SC-002");
    // SC-001 is claimed by `@impl SC-001`, so its verifies/implements edges
    // survive — proving tags are only skipped when the prefix is configured.
    expect(graph.edges.some((e) => e.kind === "implements" && e.target === "SC-001")).toBe(true);
  });

  it("treats an empty array the same as absent", () => {
    const withEmpty: ArtgraphConfig = { ...baseConfig, ignoreIdPrefixes: [] };
    const a = buildGraph(projectDir, withEmpty);
    const b = buildGraph(projectDir, baseConfig);
    expect([...a.graph.nodes.keys()]).toEqual([...b.graph.nodes.keys()]);
    expect(a.graph.edges).toEqual(b.graph.edges);
  });
});

describe("ignoreIdPrefixes: heading-derived reqs", () => {
  it("ignores Kiro-style Requirement-N headings when the prefix is listed", () => {
    const dir = mkdtempSync(join(tmpdir(), "artgraph-ignore-heading-"));
    try {
      mkdirSync(join(dir, "specs", "kiro"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "specs", "kiro", "requirements.md"),
        ["# Requirements", "", "### Requirement 1: do the thing", "", "Body text.", ""].join("\n"),
      );
      writeFileSync(join(dir, "src", "noop.ts"), "export {};\n");

      const withIgnore: ArtgraphConfig = { ...baseConfig, ignoreIdPrefixes: ["Requirement"] };
      const { graph } = buildGraph(dir, withIgnore);
      expect(graph.nodes.has("Requirement-1")).toBe(false);

      const { graph: defaultGraph } = buildGraph(dir, baseConfig);
      expect(defaultGraph.nodes.has("Requirement-1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
