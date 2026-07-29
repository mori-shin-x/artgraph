import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildGraph, type BuildWarning } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";

// Pins the collision-aware ID resolution buildGraph applies to edge targets:
// the frontmatter (`nonReqEdges`) remap and the specDir-aware annotation /
// task-tag resolution.
//
// The suffix lookup itself — a target that matches an `idMapping` key only at
// a slash boundary — is pinned by the trailing-segment cases below, which are
// the ones whose expected target differs from the raw text of the reference.
// When a non-colliding ID resolves to itself, hitting the lookup and skipping
// it produce the same edge, so such a case is an integration smoke test rather
// than a pin on the lookup.
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
// than one slash boundary. These patterns are deliberately ones `loadConfig`
// accepts: `validateReqPatterns` rejects nested quantifiers, so a grammar
// written as `(?:[a-z]+/){1,2}...` would describe a project that cannot exist.
const COMPOUND_LIST_ITEM = "^([A-Za-z0-9/_-]+):";
// Whole-match ID shape for annotation targets, widened the same way so a
// `(depends_on: mod/FR-1)` target isn't rejected as an invalid annotation ID.
const COMPOUND_CODE_ID = "^[A-Za-z0-9/_-]+$";

const compoundConfig: ArtgraphConfig = {
  ...baseConfig,
  reqPatterns: { listItem: COMPOUND_LIST_ITEM },
};

const compoundAnnotationConfig: ArtgraphConfig = {
  ...baseConfig,
  reqPatterns: { listItem: COMPOUND_LIST_ITEM, codeId: COMPOUND_CODE_ID },
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

  // Smoke test, not a lookup pin: `SUP-100` is unique, so its mapping is the
  // identity and the edge lands on `SUP-100` whether the cross-dir lookup fires
  // or the target passes through unregistered. The trailing-segment cases below
  // are what pin the lookup.
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

  it("resolves an annotation naming a segment deep inside a compound colliding ID", () => {
    // Same shape as the case above, one level deeper: the reference is the
    // third slash boundary counted from the end of `010-a/mod/sub/deep/FR-1`.
    // An index that only remembers a key's last boundaries would drop the
    // candidate and leak the raw text through as an orphan target.
    setupTmp({
      "specs/010-a/spec.md": "- mod/sub/deep/FR-1: alpha\n",
      "specs/010-b/spec.md": "- mod/sub/deep/FR-1: beta\n",
      "specs/010-c/spec.md": "- CROSS-1: gamma (depends_on: sub/deep/FR-1)\n",
    });
    const { graph, warnings } = buildGraph(TMP_BASE, compoundAnnotationConfig);

    expect(graph.nodes.has("010-a/mod/sub/deep/FR-1")).toBe(true);
    expect(graph.nodes.has("010-b/mod/sub/deep/FR-1")).toBe(true);

    const annEdges = graph.edges.filter(
      (e) => e.source === "CROSS-1" && e.provenances?.includes("annotation"),
    );
    expect(annEdges).toHaveLength(1);
    expect(annEdges[0].target).toBe("010-a/mod/sub/deep/FR-1");
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toHaveLength(0);
  });

  it("resolves a trailing segment far deeper than any ordinary namespace", () => {
    // 40 namespace segments ahead of the ID, with the reference naming the last
    // 35 of them. Depth on its own must not change the answer — this is the
    // same trailing-segment resolution as above, past any depth a pre-computed
    // suffix index would keep on hand.
    const segs = Array.from({ length: 40 }, (_, i) => `s${i}`);
    const rawId = [...segs, "FR-1"].join("/");
    const ref = [...segs.slice(6), "FR-1"].join("/");
    setupTmp({
      "specs/010-a/spec.md": `- ${rawId}: alpha\n`,
      "specs/010-b/spec.md": `- ${rawId}: beta\n`,
      "specs/010-c/spec.md": `- CROSS-1: gamma (depends_on: ${ref})\n`,
    });
    const { graph } = buildGraph(TMP_BASE, compoundAnnotationConfig);

    const annEdges = graph.edges.filter(
      (e) => e.source === "CROSS-1" && e.provenances?.includes("annotation"),
    );
    expect(annEdges).toHaveLength(1);
    expect(annEdges[0].target).toBe(`010-a/${rawId}`);
  });

  it("treats an empty segment in a compound ID as two ordinary boundaries", () => {
    // `mod//FR-1` puts two slashes back to back, so the qualified key offers
    // both `/FR-1` and `FR-1` as trailing-segment references. An `endsWith`
    // scan matches both; skipping either as a degenerate boundary would strand
    // that reference on the raw text.
    setupTmp({
      "specs/010-a/spec.md": "- mod//FR-1: alpha\n",
      "specs/010-b/spec.md": "- mod//FR-1: beta\n",
      "specs/010-c/spec.md":
        "- CROSS-1: gamma (depends_on: /FR-1)\n- CROSS-2: delta (depends_on: FR-1)\n",
    });
    const { graph } = buildGraph(TMP_BASE, compoundAnnotationConfig);

    const annTarget = (source: string) =>
      graph.edges
        .filter((e) => e.source === source && e.provenances?.includes("annotation"))
        .map((e) => e.target);

    expect(annTarget("CROSS-1")).toEqual(["010-a/mod//FR-1"]);
    expect(annTarget("CROSS-2")).toEqual(["010-a/mod//FR-1"]);
  });

  it("prefers the same spec dir when a compound ID collides across dirs", () => {
    // Colliding target with a same-dir definition: resolution stops at that
    // definition, so no trailing-segment candidate is ever consulted.
    setupTmp({
      "specs/010-a/spec.md": "- mod/FR-1: alpha\n",
      "specs/010-b/spec.md": "- mod/FR-1: beta\n- ex/CROSS-1: gamma (depends_on: mod/FR-1)\n",
    });
    const { graph } = buildGraph(TMP_BASE, compoundAnnotationConfig);

    const annEdges = graph.edges.filter(
      (e) => e.source === "ex/CROSS-1" && e.provenances?.includes("annotation"),
    );
    expect(annEdges).toHaveLength(1);
    expect(annEdges[0].target).toBe("010-b/mod/FR-1");
  });

  it("prefers the same spec dir over another dir's trailing-segment match", () => {
    // `FR-1` is unique (only 010-b declares it), so the colliding branch never
    // runs. It is still a trailing segment of `010-a/mod/FR-1`, which registers
    // first — without the same-dir shortcut the task would silently verify the
    // other dir's requirement instead of its own.
    setupTmp({
      "specs/010-a/spec.md": "- mod/FR-1: alpha\n",
      "specs/010-b/spec.md": "- FR-1: beta\n",
      "specs/010-b/tasks.md": `- T001 same dir ${tag("FR-1")}\n`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, compoundConfig);

    expect(graph.nodes.has("mod/FR-1")).toBe(true);
    expect(graph.nodes.has("FR-1")).toBe(true);

    const verifies = graph.edges.filter((e) => e.source === "T001" && e.kind === "verifies");
    expect(verifies).toHaveLength(1);
    expect(verifies[0].target).toBe("FR-1");
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toHaveLength(0);
  });

  it("leaves a spec-dir-qualified reference to a unique ID unresolved", () => {
    // `SUP-100` is unique, so its node keeps the bare ID and the qualified form
    // the task wrote is not a key of anything. Only a key's *proper* trailing
    // segments are candidates — the whole key is not one of them — so the
    // reference stays verbatim and surfaces downstream as an orphan edge
    // instead of quietly binding to the bare node.
    setupTmp({
      "specs/010-a/spec.md": "- SUP-100: only here\n",
      "specs/010-c/tasks.md": `- T001 qualified ref ${tag("010-a/SUP-100")}\n`,
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    expect(graph.nodes.has("SUP-100")).toBe(true);
    expect(graph.nodes.has("010-a/SUP-100")).toBe(false);

    const verifies = graph.edges.filter((e) => e.source === "T001" && e.kind === "verifies");
    expect(verifies).toHaveLength(1);
    expect(verifies[0].target).toBe("010-a/SUP-100");
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toHaveLength(0);
  });
});
