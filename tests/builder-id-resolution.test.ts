import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildGraph, type BuildWarning } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";

// Pins the collision-aware ID resolution buildGraph applies to edge targets:
// the frontmatter (`nonReqEdges`) remap and the specDir-aware annotation /
// task-tag resolution, including the cross-specDir suffix lookup that neither
// path had a fixture for before.
//
// Bracketed IDs are assembled at runtime rather than written literally: the
// TypeScript parser scans a *test* file's whole text for `[<id>]` markers
// (parsers/typescript.ts `testReqRe`), so a bracketed ID spelled out here —
// in a fixture string or in this very comment — would emit a real `verifies`
// edge into artgraph's own graph.
const tag = (id: string) => "[" + id + "]";

const TMP_BASE = resolve(import.meta.dirname, "fixtures/_id_resolution_tmp");

function setupTmp(files: Record<string, string>): string {
  if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
  mkdirSync(TMP_BASE, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(TMP_BASE, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return TMP_BASE;
}

const baseConfig: ArtgraphConfig = {
  include: [],
  specDirs: ["specs"],
  testPatterns: [],
  lockFile: ".trace.lock",
};

// Raw IDs that carry their own `/` are reachable only through a custom
// `reqPatterns.listItem`, and they are what makes a qualified key hold more
// than one slash boundary.
const compoundConfig: ArtgraphConfig = {
  ...baseConfig,
  reqPatterns: { listItem: "^((?:[a-z]+/){1,2}[A-Z][A-Za-z]*-\\d+)[:\\s]" },
};

const optionalNsConfig: ArtgraphConfig = {
  ...baseConfig,
  reqPatterns: { listItem: "^((?:[a-z]+/)?[A-Z][A-Za-z]*-\\d+)[:\\s]" },
};

function ambiguousFor(warnings: BuildWarning[], id: string) {
  return warnings.filter((w) => w.type === "ambiguous-id" && w.id === id);
}

describe("buildGraph: frontmatter edge target remap", () => {
  afterEach(() => {
    if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
  });

  it("keeps a colliding frontmatter target unqualified and warns once", () => {
    setupTmp({
      "specs/010-a/spec.md": "- AUTH-001: alpha\n",
      "specs/010-b/spec.md": "- AUTH-001: beta\n",
      "specs/010-c/design.md": `---
artgraph:
  node_id: "design-c"
  depends_on:
    - AUTH-001
---
# Design C
`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    const fmEdges = graph.edges.filter(
      (e) => e.source === "design-c" && e.provenances?.includes("frontmatter"),
    );
    expect(fmEdges).toHaveLength(1);
    expect(fmEdges[0].kind).toBe("depends_on");
    // Two spec dirs claim AUTH-001, so the target stays bare — no dir wins.
    expect(fmEdges[0].target).toBe("AUTH-001");
    expect(graph.nodes.has("AUTH-001")).toBe(false);

    const ambiguous = ambiguousFor(warnings, "AUTH-001");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].files).toEqual(["010-a", "010-b"]);
  });

  it("counts an unrelated compound ID that ends in the colliding ID", () => {
    // `010-z/zz/AUTH-001` also ends in `/AUTH-001`, so the remap sees three
    // candidates instead of two. The extra candidate must not turn the
    // ambiguous target into a unique one, and must not reach the warning's
    // file list (which is keyed on the raw ID's own spec dirs).
    setupTmp({
      "specs/010-a/spec.md": "- AUTH-001: alpha\n",
      "specs/010-b/spec.md": "- AUTH-001: beta\n",
      "specs/010-z/spec.md": "- zz/AUTH-001: unrelated\n",
      "specs/010-c/design.md": `---
artgraph:
  node_id: "design-c"
  depends_on:
    - AUTH-001
---
# Design C
`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, optionalNsConfig);

    expect(graph.nodes.has("zz/AUTH-001")).toBe(true);
    const fmEdges = graph.edges.filter(
      (e) => e.source === "design-c" && e.provenances?.includes("frontmatter"),
    );
    expect(fmEdges).toHaveLength(1);
    expect(fmEdges[0].target).toBe("AUTH-001");

    const ambiguous = ambiguousFor(warnings, "AUTH-001");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].files).toEqual(["010-a", "010-b"]);
  });

  it("lists every spec dir on a three-way collision", () => {
    setupTmp({
      "specs/010-a/spec.md": "- AUTH-001: alpha\n",
      "specs/010-b/spec.md": "- AUTH-001: beta\n",
      "specs/010-c/spec.md": "- AUTH-001: gamma\n",
      "specs/010-d/design.md": `---
artgraph:
  node_id: "design-d"
  derives_from:
    - AUTH-001
---
# Design D
`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    const fmEdges = graph.edges.filter(
      (e) => e.source === "design-d" && e.provenances?.includes("frontmatter"),
    );
    expect(fmEdges).toHaveLength(1);
    expect(fmEdges[0].kind).toBe("derives_from");
    expect(fmEdges[0].target).toBe("AUTH-001");

    const ambiguous = ambiguousFor(warnings, "AUTH-001");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].files).toEqual(["010-a", "010-b", "010-c"]);
  });
});

describe("buildGraph: annotation and task-tag target resolution", () => {
  afterEach(() => {
    if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
  });

  it("resolves a non-colliding annotation target declared in another spec dir", () => {
    setupTmp({
      "specs/010-a/spec.md": "- SUP-100: supporting\n",
      "specs/010-b/spec.md": "- AUTH-001: beta (depends_on: SUP-100)\n",
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    const annEdges = graph.edges.filter(
      (e) => e.source === "AUTH-001" && e.provenances?.includes("annotation"),
    );
    expect(annEdges).toHaveLength(1);
    expect(annEdges[0].target).toBe("SUP-100");
    expect(graph.nodes.has("SUP-100")).toBe(true);
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toHaveLength(0);
  });

  it("routes spec-kit bracket tags by spec dir", () => {
    setupTmp({
      "specs/ns-a/spec.md": "- FR-1: alpha\n",
      "specs/ns-b/spec.md": "- FR-1: beta\n",
      "specs/ns-a/tasks.md": `- T001 cross dir ${tag("ns-b/FR-1")}\n- T002 same dir ${tag("FR-1")}\n`,
      "specs/010-c/tasks.md": `- T003 no home dir ${tag("FR-1")}\n`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    const verifies = (source: string) =>
      graph.edges.filter((e) => e.source === source && e.kind === "verifies");

    // Already qualified: passes through untouched and lands on a real node.
    expect(verifies("T001").map((e) => e.target)).toEqual(["ns-b/FR-1"]);
    expect(graph.nodes.has("ns-b/FR-1")).toBe(true);
    // Bare and colliding: the task's own spec dir wins.
    expect(verifies("T002").map((e) => e.target)).toEqual(["ns-a/FR-1"]);
    // Bare, colliding, and no same-dir candidate: no edge at all.
    expect(verifies("T003")).toHaveLength(0);

    const ambiguous = ambiguousFor(warnings, "FR-1");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].files).toEqual(["ns-a", "ns-b"]);
  });

  it("resolves a tag naming a trailing segment of a compound colliding ID", () => {
    // `mod/sub/FR-1` collides, so both nodes are spec-dir qualified. The tag
    // names `sub/FR-1`, which is a slash-boundary suffix of both qualified
    // keys but is not itself a declared ID: the first key in registration
    // order wins, with no ambiguity warning.
    setupTmp({
      "specs/010-a/spec.md": "- mod/sub/FR-1: alpha\n",
      "specs/010-b/spec.md": "- mod/sub/FR-1: beta\n",
      "specs/010-c/tasks.md": `- T001 trailing segment ${tag("sub/FR-1")}\n`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, compoundConfig);

    expect(graph.nodes.has("010-a/mod/sub/FR-1")).toBe(true);
    expect(graph.nodes.has("010-b/mod/sub/FR-1")).toBe(true);

    const verifies = graph.edges.filter((e) => e.source === "T001" && e.kind === "verifies");
    expect(verifies).toHaveLength(1);
    expect(verifies[0].target).toBe("010-a/mod/sub/FR-1");
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toHaveLength(0);
  });

  it("prefers the same spec dir over a trailing-segment match", () => {
    setupTmp({
      "specs/010-a/spec.md": "- mod/FR-1: alpha\n",
      "specs/010-b/spec.md": "- mod/FR-1: beta\n- ex/CROSS-1: gamma (depends_on: mod/FR-1)\n",
    });
    const { graph } = buildGraph(TMP_BASE, {
      ...compoundConfig,
      reqPatterns: { ...compoundConfig.reqPatterns, codeId: "(?:[a-z]+/){1,2}[A-Z][A-Za-z]*-\\d+" },
    });

    const annEdges = graph.edges.filter(
      (e) => e.source === "ex/CROSS-1" && e.provenances?.includes("annotation"),
    );
    expect(annEdges).toHaveLength(1);
    expect(annEdges[0].target).toBe("010-b/mod/FR-1");
  });
});
