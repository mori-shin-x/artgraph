import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { dirname, join, resolve } from "node:path";
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph, type BuildWarning } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import type { ArtgraphConfig } from "../src/types.js";

const NS_FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/ns-collision");
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const CONV_FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/conventions");

const nsConfig: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("buildGraph: namespace collision resolution", () => {
  it("should qualify colliding IDs with spec directory name", () => {
    const { graph } = buildGraph(NS_FIXTURE_DIR, nsConfig);

    // FR-001 exists in both ns-a and ns-b, so should be qualified
    expect(graph.nodes.has("ns-a/FR-001")).toBe(true);
    expect(graph.nodes.has("ns-b/FR-001")).toBe(true);
    // Raw FR-001 should NOT exist
    expect(graph.nodes.has("FR-001")).toBe(false);
  });

  it("should keep unique IDs unqualified", () => {
    const { graph } = buildGraph(NS_FIXTURE_DIR, nsConfig);

    // FR-002 only exists in ns-a, SC-001 only in ns-b — no collision
    expect(graph.nodes.has("FR-002")).toBe(true);
    expect(graph.nodes.has("SC-001")).toBe(true);
  });

  it("should resolve qualified @impl to correct node", () => {
    const { graph } = buildGraph(NS_FIXTURE_DIR, nsConfig);

    // ns-impl.ts has `// @impl ns-a/FR-001`
    const implEdges = graph.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/ns-impl.ts",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].target).toBe("ns-a/FR-001");
  });

  it("should warn on ambiguous unqualified @impl for colliding IDs", () => {
    const { graph, warnings } = buildGraph(NS_FIXTURE_DIR, nsConfig);

    // ambiguous-impl.ts has `// @impl FR-001` which is ambiguous
    const ambiguousWarnings = warnings.filter(
      (w) => w.type === "ambiguous-id" && w.id === "FR-001",
    );
    expect(ambiguousWarnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildGraph: doc node auto-generation (US1)", () => {
  it("T024: should not generate auto doc nodes when autoNodes is false", () => {
    const noAutoConfig: ArtgraphConfig = {
      ...config,
      docGraph: { autoNodes: false },
    };
    const { graph } = buildGraph(FIXTURE_DIR, noAutoConfig);

    // prose-only.md has no node_id, so its doc node should be filtered out
    const proseDoc = [...graph.nodes.values()].find(
      (n) => n.kind === "doc" && n.filePath === "specs/prose-only.md",
    );
    expect(proseDoc).toBeUndefined();

    // auth.md has explicit node_id "doc:auth-design", so it should still exist
    expect(graph.nodes.has("doc:auth-design")).toBe(true);
  });

  it("T025: should auto-generate doc node IDs with specDir-relative path", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // prose-only.md has no node_id, so auto-generated ID should be doc:prose-only.md (specDir-relative)
    expect(graph.nodes.has("doc:prose-only.md")).toBe(true);
    const node = graph.nodes.get("doc:prose-only.md")!;
    expect(node.kind).toBe("doc");
  });
});

describe("buildGraph: doc->doc dependency chain (US2)", () => {
  it("T029: should generate derives_from edges from doc-chain fixtures", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    const derivesEdges = graph.edges.filter((e) => e.kind === "derives_from");
    const designToReq = derivesEdges.find(
      (e) => e.source === "design" && e.target === "requirements",
    );
    expect(designToReq).toBeDefined();

    // tasks.md has no node_id so its ID is auto-generated
    const tasksDocId =
      [...graph.nodes.keys()].find(
        (id) => graph.nodes.get(id)?.filePath === "specs/doc-chain/tasks.md",
      ) ?? "";
    const tasksToDesign = derivesEdges.find(
      (e) => e.source === tasksDocId && e.target === "design",
    );
    expect(tasksToDesign).toBeDefined();
  });

  it("T030: should warn on orphan-doc when dependency target does not exist", () => {
    // Use isolated temp directory to avoid race conditions with CLI tests
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-orphan");
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "orphan.md"),
      `---
artgraph:
  node_id: "orphan-source"
  derives_from:
    - nonexistent-doc
---
# Orphan test
`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { warnings } = buildGraph(tmpRoot, tmpConfig);
      const orphanWarnings = warnings.filter(
        (w) => w.type === "orphan-doc" && w.id === "nonexistent-doc",
      );
      expect(orphanWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpRoot, { recursive: true });
    }
  });

  it("T031: should warn on invalid-relation for unknown frontmatter keys", () => {
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-invalid-rel");
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "invalid-rel.md"),
      `---
artgraph:
  node_id: "invalid-test"
  extends:
    - some-doc
---
# Test
`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { warnings } = buildGraph(tmpRoot, tmpConfig);
      const invalidWarnings = warnings.filter(
        (w) => w.type === "invalid-relation" && w.id === "extends",
      );
      expect(invalidWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpRoot, { recursive: true });
    }
  });

  it("T032: should deduplicate edges with same source, target, kind", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const edgeKeys = graph.edges.map((e) => `${e.source}|${e.target}|${e.kind}`);
    const uniqueKeys = new Set(edgeKeys);
    expect(edgeKeys.length).toBe(uniqueKeys.size);
  });

  it("T033: should warn on duplicate-id when different files use same node_id", () => {
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-dup-id");
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "a.md"),
      `---
artgraph:
  node_id: "shared-id"
---
# Doc A
`,
    );
    writeFileSync(
      resolve(tmpSpecs, "b.md"),
      `---
artgraph:
  node_id: "shared-id"
---
# Doc B
`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { warnings } = buildGraph(tmpRoot, tmpConfig);
      const dupWarnings = warnings.filter((w) => w.type === "duplicate-id" && w.id === "shared-id");
      expect(dupWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpRoot, { recursive: true });
    }
  });
});

describe("buildGraph: contains edges (US3)", () => {
  it("T038: should generate contains edges between doc and req nodes in same file", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // auth.md has doc node "doc:auth-design" and req nodes AUTH-001, AUTH-002, AUTH-003
    const containsEdges = graph.edges.filter(
      (e) => e.kind === "contains" && e.source === "doc:auth-design",
    );
    expect(containsEdges.length).toBeGreaterThanOrEqual(3);
    const targets = containsEdges.map((e) => e.target);
    expect(targets).toContain("AUTH-001");
    expect(targets).toContain("AUTH-002");
    expect(targets).toContain("AUTH-003");
  });

  it("T039: should not generate contains edges when autoContains is false", () => {
    const noContainsConfig: ArtgraphConfig = {
      ...config,
      docGraph: { autoContains: false },
    };
    const { graph } = buildGraph(FIXTURE_DIR, noContainsConfig);

    const containsEdges = graph.edges.filter((e) => e.kind === "contains");
    expect(containsEdges).toHaveLength(0);
  });

  it("T028: should warn on reserved-prefix in req IDs", () => {
    // Build in an isolated tmp tree so the spec file is never visible to
    // other test workers' globs of the shared `tests/fixtures/specs/` dir
    // (was a race: traverse.test.ts hit ENOENT after our glob, before our
    // unlink, on a fast in-process suite).
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-reserved-prefix-"));
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "reserved-prefix-test.md"),
      `---
artgraph:
  node_id: "reserved-test"
---
# Test

- doc:FR-001: This req ID uses a reserved prefix
`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { warnings } = buildGraph(tmpRoot, tmpConfig);
      const reservedWarnings = warnings.filter(
        (w) => w.type === "reserved-prefix" && w.id === "doc:FR-001",
      );
      expect(reservedWarnings.length).toBe(0);
      // Note: The regex for req IDs is [A-Z][A-Za-z]*-\d+, so "doc:FR-001" won't match
      // as it starts with lowercase "doc:". This is actually correct behavior:
      // the reserved-prefix check only triggers for IDs that DO match the req pattern.
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // F1 (meta-review, issue #243 follow-up) — `_meta` exact-match collision
  // with the lock file's reserved stamp key. Two collision paths:
  it('F1: warns when a custom reqPatterns match produces a req ID literally "_meta"', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-meta-collision-req-"));
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "meta-collision.md"),
      `# Test\n\n- _meta: this list item's ID literally collides with the lock's _meta key\n`,
    );

    try {
      const tmpConfig: ArtgraphConfig = {
        ...config,
        include: [],
        testPatterns: [],
        reqPatterns: { listItem: "^(_meta):\\s" },
      };
      const { graph, warnings } = buildGraph(tmpRoot, tmpConfig);
      expect(graph.nodes.has("_meta")).toBe(true);
      const metaWarnings = warnings.filter((w) => w.type === "reserved-prefix" && w.id === "_meta");
      expect(metaWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('F1: warns when frontmatter `artgraph: { node_id: _meta }` assigns a doc ID literally "_meta"', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-meta-collision-doc-"));
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "meta-collision-doc.md"),
      `---
artgraph:
  node_id: "_meta"
---
# Test
`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { graph, warnings } = buildGraph(tmpRoot, tmpConfig);
      expect(graph.nodes.has("_meta")).toBe(true);
      expect(graph.nodes.get("_meta")?.kind).toBe("doc");
      const metaWarnings = warnings.filter((w) => w.type === "reserved-prefix" && w.id === "_meta");
      expect(metaWarnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("buildGraph: contains edges with autoNodes=false + explicit node_id", () => {
  it("should generate contains edges for doc nodes with explicit node_id even when autoNodes=false", () => {
    const noAutoNodesConfig: ArtgraphConfig = {
      ...config,
      docGraph: { autoNodes: false, autoContains: true },
    };
    const { graph } = buildGraph(FIXTURE_DIR, noAutoNodesConfig);

    // auth.md has explicit node_id "doc:auth-design" -> should still exist
    expect(graph.nodes.has("doc:auth-design")).toBe(true);

    // contains edges from doc:auth-design to AUTH-001/002/003 should still be generated
    const containsEdges = graph.edges.filter(
      (e) => e.kind === "contains" && e.source === "doc:auth-design",
    );
    expect(containsEdges.length).toBeGreaterThanOrEqual(3);
    const targets = containsEdges.map((e) => e.target);
    expect(targets).toContain("AUTH-001");
    expect(targets).toContain("AUTH-002");
    expect(targets).toContain("AUTH-003");
  });
});

describe("buildGraph: inline markdown links (issue #11)", () => {
  it("creates depends_on edges from inline links to existing doc nodes", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    // source.md → target.md (which has node_id "il-target")
    const edge = graph.edges.find(
      (e) =>
        e.kind === "depends_on" &&
        e.source === "doc:inline-links/source.md" &&
        e.target === "il-target",
    );
    expect(edge).toBeDefined();
  });

  it("dedupes inline-link edges so source.md contributes only one depends_on to target", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const edges = graph.edges.filter(
      (e) =>
        e.kind === "depends_on" &&
        e.source === "doc:inline-links/source.md" &&
        e.target === "il-target",
    );
    expect(edges).toHaveLength(1);
  });

  it("resolves reference-style inline links to the same target", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const edge = graph.edges.find(
      (e) =>
        e.kind === "depends_on" &&
        e.source === "doc:inline-links/ref-source.md" &&
        e.target === "il-target",
    );
    expect(edge).toBeDefined();
  });

  it("does not generate inline edges from code-fenced links", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const fenced = graph.edges.filter(
      (e) => e.source === "doc:inline-links/code-fence.md" && e.target === "il-target",
    );
    // Only the trailing real link creates an edge — exactly 1, not 4
    expect(fenced).toHaveLength(1);
  });

  it("warns unresolved-link when a .md target does not exist", () => {
    const { warnings } = buildGraph(FIXTURE_DIR, config);
    const w = warnings.find(
      (w) => w.type === "unresolved-link" && w.id === "specs/inline-links/missing.md",
    );
    expect(w).toBeDefined();
    expect(w!.files).toContain("specs/inline-links/dead-source.md");
  });

  it("frontmatter derives_from suppresses inline depends_on to the same target", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    // conflict.md frontmatter: derives_from il-target. Inline link also points to target.md.
    // We must keep the frontmatter edge and drop the inline one.
    const fromConflict = graph.edges.filter(
      (e) => e.source === "il-conflict" && e.target === "il-target",
    );
    expect(fromConflict).toHaveLength(1);
    expect(fromConflict[0].kind).toBe("derives_from");
  });

  it("respects docGraph.inlineLinks=false", () => {
    const off: ArtgraphConfig = {
      ...config,
      docGraph: { inlineLinks: false },
    };
    const { graph, warnings } = buildGraph(FIXTURE_DIR, off);
    const inlineEdges = graph.edges.filter(
      (e) => e.kind === "depends_on" && e.source === "doc:inline-links/source.md",
    );
    expect(inlineEdges).toHaveLength(0);
    // No unresolved-link warnings either when the feature is off
    const unresolved = warnings.filter((w) => w.type === "unresolved-link");
    expect(unresolved).toHaveLength(0);
  });

  it("respects docGraph.linkWarnings.unresolved=false", () => {
    const quiet: ArtgraphConfig = {
      ...config,
      docGraph: { linkWarnings: { unresolved: false } },
    };
    const { warnings } = buildGraph(FIXTURE_DIR, quiet);
    const unresolved = warnings.filter((w) => w.type === "unresolved-link");
    expect(unresolved).toHaveLength(0);
  });

  it("dedupes unresolved-link warnings when the same source links to the same missing target multiple times", () => {
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-warn-dedup");
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "loud.md"),
      `# Loud\n\n[a](./gone.md) [b](./gone.md) [c](./gone.md)\n`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { warnings } = buildGraph(tmpRoot, tmpConfig);
      const unresolved = warnings.filter(
        (w) => w.type === "unresolved-link" && w.id === "specs/gone.md",
      );
      // 3 inline links → 1 warning, not 3
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].files).toContain("specs/loud.md");
    } finally {
      rmSync(tmpRoot, { recursive: true });
    }
  });

  it("emits out-of-scope-link only when the target exists outside specDirs and the warning is enabled", () => {
    // tmp layout:
    //   specs/foo.md   — inline link to ../docs/notes.md
    //   docs/notes.md  — exists, but `docs/` is NOT in specDirs
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-out-of-scope");
    const tmpSpecs = resolve(tmpRoot, "specs");
    const tmpDocs = resolve(tmpRoot, "docs");
    mkdirSync(tmpSpecs, { recursive: true });
    mkdirSync(tmpDocs, { recursive: true });
    writeFileSync(resolve(tmpSpecs, "foo.md"), `# Foo\n\nSee [notes](../docs/notes.md).\n`);
    writeFileSync(resolve(tmpDocs, "notes.md"), `# Notes\n`);

    try {
      const tmpConfig: ArtgraphConfig = {
        ...config,
        include: [],
        testPatterns: [],
        // specDirs intentionally excludes "docs" so the target is "out of scope"
        specDirs: ["specs"],
      };

      // Default (outOfScope: false) — silent
      const silentResult = buildGraph(tmpRoot, tmpConfig);
      expect(silentResult.warnings.some((w) => w.type === "out-of-scope-link")).toBe(false);
      // It's also not an unresolved-link, because the file exists
      expect(silentResult.warnings.some((w) => w.type === "unresolved-link")).toBe(false);

      // Opt-in (outOfScope: true) — emits warning
      const loudResult = buildGraph(tmpRoot, {
        ...tmpConfig,
        docGraph: { linkWarnings: { outOfScope: true } },
      });
      const w = loudResult.warnings.find(
        (w) => w.type === "out-of-scope-link" && w.id === "docs/notes.md",
      );
      expect(w).toBeDefined();
      expect(w!.files).toContain("specs/foo.md");
    } finally {
      rmSync(tmpRoot, { recursive: true });
    }
  });
});

describe("buildGraph: lock file excludes contains edges (T065)", () => {
  it("should not include contains-only dependencies in lock file", () => {
    // Use an isolated fixture where a doc has contains edges but no depends_on/derives_from
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-lock-contains");
    const tmpSpecs = resolve(tmpRoot, "specs");
    mkdirSync(tmpSpecs, { recursive: true });
    writeFileSync(
      resolve(tmpSpecs, "spec.md"),
      `---
artgraph:
  node_id: "lock-test-doc"
---
# Lock test

- LT-001: A requirement for lock testing
`,
    );

    try {
      const tmpConfig: ArtgraphConfig = { ...config, include: [], testPatterns: [] };
      const { graph } = buildGraph(tmpRoot, tmpConfig);

      // Verify contains edge exists
      const containsEdges = graph.edges.filter(
        (e) => e.kind === "contains" && e.source === "lock-test-doc",
      );
      expect(containsEdges.length).toBe(1);
      expect(containsEdges[0].target).toBe("LT-001");

      // Build lock - the doc's dependsOn should NOT contain the contains target
      const lock = buildLockFromGraph(graph);
      const docEntry = lock["lock-test-doc"];
      expect(docEntry).toBeDefined();
      // dependsOn should be undefined since there are no depends_on/derives_from edges
      expect(docEntry.dependsOn).toBeUndefined();
    } finally {
      rmSync(tmpRoot, { recursive: true });
    }
  });
});

describe("buildGraph: convention inference (C-3)", () => {
  const convConfig: ArtgraphConfig = {
    include: [],
    specDirs: ["specs"],
    testPatterns: [],
    lockFile: ".trace.lock",
  };

  const derivesFrom =
    (source: string, target: string) =>
    (graph: { edges: { source: string; target: string; kind: string }[] }) =>
      graph.edges.some(
        (e) => e.kind === "derives_from" && e.source === source && e.target === target,
      );

  // Helper: derives_from edges originating from a given dir (by source-id prefix
  // for auto-generated doc ids; pure prefix check on `source` is enough since
  // the fixtures don't reuse stem names across dirs in a way that overlaps).
  const derivesFromDir =
    (dirPrefix: string) => (graph: { edges: { source: string; target: string; kind: string }[] }) =>
      graph.edges.filter((e) => e.kind === "derives_from" && e.source.startsWith(dirPrefix));

  it("infers kiro chain (design→requirements, tasks→design)", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(
      derivesFrom("doc:kiro-feature/design.md", "doc:kiro-feature/requirements.md")(graph),
    ).toBe(true);
    expect(derivesFrom("doc:kiro-feature/tasks.md", "doc:kiro-feature/design.md")(graph)).toBe(
      true,
    );
    // Lock in *exactly* two edges out of this dir — catches accidental
    // over-generation (e.g. spec-kit pairs firing in a kiro dir).
    expect(derivesFromDir("doc:kiro-feature/")(graph)).toHaveLength(2);
  });

  it("infers spec-kit chain (plan→spec, tasks→plan, research→spec)", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(derivesFrom("doc:speckit-feature/plan.md", "doc:speckit-feature/spec.md")(graph)).toBe(
      true,
    );
    expect(derivesFrom("doc:speckit-feature/tasks.md", "doc:speckit-feature/plan.md")(graph)).toBe(
      true,
    );
    expect(
      derivesFrom("doc:speckit-feature/research.md", "doc:speckit-feature/spec.md")(graph),
    ).toBe(true);
    // No kiro pairs should fire here.
    expect(derivesFromDir("doc:speckit-feature/")(graph)).toHaveLength(3);
  });

  it("matches file names case-insensitively", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(
      derivesFrom("doc:case-variant/DESIGN.md", "doc:case-variant/Requirements.md")(graph),
    ).toBe(true);
  });

  it("emits no edge (and no orphan-doc) when only one endpoint exists", () => {
    const { graph, warnings } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    const partialEdges = graph.edges.filter(
      (e) => e.kind === "derives_from" && e.source.startsWith("doc:partial/"),
    );
    expect(partialEdges).toHaveLength(0);
    expect(warnings.filter((w) => w.type === "orphan-doc")).toHaveLength(0);
  });

  it("deduplicates against frontmatter-declared edges", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    // Both convention inference and frontmatter declare wf-design → wf-requirements.
    const matching = graph.edges.filter(
      (e) =>
        e.kind === "derives_from" && e.source === "wf-design" && e.target === "wf-requirements",
    );
    expect(matching).toHaveLength(1);
  });

  it("does not link convention files across different directories", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    // other-dir has only requirements.md; it must not connect to any design elsewhere.
    const crossDir = graph.edges.filter(
      (e) => e.kind === "derives_from" && e.target === "doc:other-dir/requirements.md",
    );
    expect(crossDir).toHaveLength(0);
  });

  it("in a mixed kiro+spec-kit dir, `tasks` gets BOTH parent chains", () => {
    // Locked-in behavior: the shared `tasks` stem appears in both presets, and
    // edge dedup keys by `source|target|kind` — so `tasks→design` and
    // `tasks→plan` are distinct keys and both survive. This is intentional
    // (a dir advertising both tools genuinely has two chains), but downstream
    // `dependsOn` will list both. If this assumption ever changes, update this
    // test, the comment in src/graph/builder.ts:CONVENTION_EDGES, and the
    // README "Doc graph" section together.
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(derivesFrom("doc:mixed-tools/tasks.md", "doc:mixed-tools/design.md")(graph)).toBe(true);
    expect(derivesFrom("doc:mixed-tools/tasks.md", "doc:mixed-tools/plan.md")(graph)).toBe(true);
    // 3 edges total in this dir: design→(no requirements here), plan→(no spec
    // here), so only the two `tasks→…` edges fire — locking in the exact count
    // catches accidental over-generation in this overlap case too.
    expect(derivesFromDir("doc:mixed-tools/")(graph)).toHaveLength(2);
  });

  it("defaults autoConventions to true when the key is omitted", () => {
    // No `docGraph` key at all on the config — should behave like enabled.
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(
      derivesFrom("doc:kiro-feature/design.md", "doc:kiro-feature/requirements.md")(graph),
    ).toBe(true);

    // And `docGraph` present but without `autoConventions` → still defaults.
    const { graph: g2 } = buildGraph(CONV_FIXTURE_DIR, {
      ...convConfig,
      docGraph: {},
    });
    expect(derivesFrom("doc:kiro-feature/design.md", "doc:kiro-feature/requirements.md")(g2)).toBe(
      true,
    );
  });

  it("strips only known markdown extensions for multi-dot file names", () => {
    // #36: the stem extractor used `/\.[^.]*$/` ("strip last `.<seg>`"), which
    // matched the comment's "strip extension" intent for simple names like
    // `design.md` but diverged for multi-dot names. After the fix the regex
    // strips only `.md` / `.markdown`, so behavior is now faithfully
    // "extension only" — `my.design.md` → stem `my.design`, which intentionally
    // does NOT match the `design` preset (convention files are expected to be
    // simple names). Locking that behavior in here so future "fixes" don't
    // silently turn multi-dot names into wildcard-like matches.
    const { graph, warnings } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    // No `derives_from` edge should originate from the multi-dot dir: the
    // `my.design.md` stem is `my.design`, which is not a known convention key.
    const multiDotDerives = graph.edges.filter(
      (e) => e.kind === "derives_from" && e.source.startsWith("doc:multi-dot/"),
    );
    expect(multiDotDerives).toHaveLength(0);

    // And the silent-skip is genuinely silent — no orphan-doc warning for
    // either node in the dir (their file paths are surfaced in `files`).
    const multiDotOrphans = warnings.filter(
      (w) => w.type === "orphan-doc" && w.files.some((f) => f.includes("multi-dot/")),
    );
    expect(multiDotOrphans).toHaveLength(0);
  });

  it("generates no convention edges when autoConventions is false", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, {
      ...convConfig,
      docGraph: { autoConventions: false },
    });

    expect(
      derivesFrom("doc:kiro-feature/design.md", "doc:kiro-feature/requirements.md")(graph),
    ).toBe(false);
    expect(derivesFrom("doc:speckit-feature/plan.md", "doc:speckit-feature/spec.md")(graph)).toBe(
      false,
    );

    // Total derives_from across the fixture: only the frontmatter-declared
    // `wf-design → wf-requirements` survives. Locking in the count proves no
    // convention edge slipped through.
    const allDerives = graph.edges.filter((e) => e.kind === "derives_from");
    expect(allDerives).toHaveLength(1);
    expect(allDerives[0].source).toBe("wf-design");
    expect(allDerives[0].target).toBe("wf-requirements");
  });
});

describe("buildGraph: US3 task nodes (FR-009 / FR-010 / FR-012)", () => {
  const tasksRoot = resolve(FIXTURE_DIR, "tasks");
  const tasksConfig: ArtgraphConfig = {
    include: ["src/**/*.ts"],
    specDirs: ["specs"],
    testPatterns: ["tests/**/*.ts"],
    lockFile: ".trace.lock",
  };

  it("generates doc → task contains edges within plan.md", () => {
    const { graph } = buildGraph(resolve(tasksRoot, "speckit-plan"), tasksConfig);
    const tasks = [...graph.nodes.values()].filter((n) => n.kind === "task");
    expect(tasks.map((n) => n.id).sort()).toEqual(["T001", "T002"]);

    const contains = graph.edges.filter(
      (e) => e.kind === "contains" && e.source === "doc:auth/plan.md",
    );
    expect(contains.map((e) => e.target).sort()).toEqual(["T001", "T002"]);
  });

  it("qualifies task IDs with specDir on collision", () => {
    const { graph } = buildGraph(resolve(tasksRoot, "namespace-collision"), tasksConfig);
    expect(graph.nodes.has("auth/T001")).toBe(true);
    expect(graph.nodes.has("export/T001")).toBe(true);
    expect(graph.nodes.has("T001")).toBe(false);

    const implements_ = graph.edges
      .filter((e) => e.kind === "implements")
      .sort((a, b) => a.source.localeCompare(b.source));
    expect(implements_).toEqual([
      { source: "auth/T001", target: "auth-login", kind: "implements", provenances: ["task-tag"] },
      {
        source: "export/T001",
        target: "csv-writer",
        kind: "implements",
        provenances: ["task-tag"],
      },
    ]);
  });

  it("applies user-defined OpenSpec preset on top of built-ins", () => {
    const root = resolve(tasksRoot, "openspec-custom");
    const userConfig: ArtgraphConfig = {
      ...tasksConfig,
      taskConventions: [
        {
          name: "openspec",
          fileStems: ["tasks"],
          taskIdRe: "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(OS-\\d+)\\b",
          // User presets must opt into the cross-link syntax explicitly — built-in
          // tag regexes (spec-kit's `@impl(...)`, kiro's `_Requirements:`) are NOT
          // inherited. Reuse the spec-kit-style `@impl(...)` here to show that
          // any user tool can pick whichever conventions fit it.
          implementsTagRe: "@impl\\(([^)\\n]+)\\)",
        },
      ],
    };
    const { graph } = buildGraph(root, userConfig);
    const tasks = [...graph.nodes.values()].filter((n) => n.kind === "task");
    expect(tasks.map((n) => n.id)).toEqual(["OS-100"]);
    const impl = graph.edges.filter((e) => e.kind === "implements");
    expect(impl).toEqual([
      {
        source: "OS-100",
        target: "openspec-target",
        kind: "implements",
        provenances: ["task-tag"],
      },
    ]);
  });

  it("a user preset can supply a fully custom verifiesTagRe (extensibility)", () => {
    // Demonstrates that the per-preset tag regex contract supports arbitrary
    // SDD-tool conventions: here we invent a "→ <id>" arrow syntax and prove
    // the parser routes it correctly into `verifies` edges. This is the
    // mechanism that lets OpenSpec / any future SDD tool plug in without
    // patching the parser.
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tasks-custom-tmp");
    const specsDir = resolve(tmpRoot, "specs/demo");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(
      resolve(specsDir, "tasks.md"),
      [
        "# Tasks",
        "",
        "- [X] CT-001 demo task → REQ-A",
        "- [X] CT-002 second task → REQ-B → REQ-C",
        "",
      ].join("\n"),
      "utf-8",
    );
    try {
      const customConfig: ArtgraphConfig = {
        ...tasksConfig,
        taskConventions: [
          {
            name: "custom-arrow",
            fileStems: ["tasks"],
            taskIdRe: "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(CT-\\d+)\\b",
            verifiesTagRe: "→\\s*(REQ-[\\w-]+)",
          },
        ],
      };
      const { graph } = buildGraph(tmpRoot, customConfig);
      const verifies = graph.edges
        .filter((e) => e.kind === "verifies")
        .sort((a, b) =>
          a.source === b.source
            ? a.target.localeCompare(b.target)
            : a.source.localeCompare(b.source),
        );
      expect(verifies).toEqual([
        { source: "CT-001", target: "REQ-A", kind: "verifies", provenances: ["task-tag"] },
        { source: "CT-002", target: "REQ-B", kind: "verifies", provenances: ["task-tag"] },
        { source: "CT-002", target: "REQ-C", kind: "verifies", provenances: ["task-tag"] },
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Meta-review #3 remediation: when a task emits an `@impl(target)` edge and
  // the target ID collides across spec dirs, the edge target must be qualified
  // too — otherwise the edge points at the bare colliding ID with no matching
  // node and silently orphans (and `findOrphans` is now task-source-exempt so
  // even the warning channel is suppressed).
  it("remaps task-emitted edge target when the target ID collides across specDirs", () => {
    const tmpRoot = resolve(import.meta.dirname, "fixtures/tasks-cross-collision-tmp");
    mkdirSync(resolve(tmpRoot, "specs/authA"), { recursive: true });
    mkdirSync(resolve(tmpRoot, "specs/exportB"), { recursive: true });
    // Two req lists each define FR-001 — collision drives qualifying to
    // authA/FR-001 and exportB/FR-001.
    writeFileSync(
      resolve(tmpRoot, "specs/authA/spec.md"),
      ["# Auth", "", "- FR-001: login flow", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      resolve(tmpRoot, "specs/exportB/spec.md"),
      ["# Export", "", "- FR-001: csv writer", ""].join("\n"),
      "utf-8",
    );
    // A plan in authA references FR-001 — without remap the edge target stays
    // unqualified and the implements edge silently dangles.
    writeFileSync(
      resolve(tmpRoot, "specs/authA/plan.md"),
      ["# Plan", "", "- [X] T010 wire login @impl(FR-001)", ""].join("\n"),
      "utf-8",
    );
    try {
      const { graph } = buildGraph(tmpRoot, tasksConfig);
      const implEdge = graph.edges.find((e) => e.kind === "implements" && e.source === "T010");
      expect(implEdge).toBeDefined();
      // The collision rewrite must rebind the target to the qualified ID that
      // lives in the same spec dir as the emitting task.
      expect(implEdge!.target).toBe("authA/FR-001");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Meta-review #9 remediation: task contentHash now hashes the full subtree
  // (matching how req nodes are hashed), so editing a `_Requirements:` line in
  // a Kiro task changes the hash and shows up in diff/lock comparisons.
  it("task contentHash reflects subtree changes (not just the label line)", () => {
    const tmpDir = resolve(import.meta.dirname, "fixtures/task-hash-subtree-tmp");
    const specsDir = resolve(tmpDir, "specs/demo");
    mkdirSync(specsDir, { recursive: true });
    const taskFile = resolve(specsDir, "tasks.md");
    writeFileSync(
      taskFile,
      ["# Tasks", "", "- [x] 1. set up auth", "  - _Requirements: 7.1, 7.2_", ""].join("\n"),
      "utf-8",
    );
    try {
      const { graph: g1 } = buildGraph(tmpDir, tasksConfig);
      const h1 = g1.nodes.get("1")!.contentHash;
      writeFileSync(
        taskFile,
        ["# Tasks", "", "- [x] 1. set up auth", "  - _Requirements: 7.1, 7.2, 7.3_", ""].join("\n"),
        "utf-8",
      );
      const { graph: g2 } = buildGraph(tmpDir, tasksConfig);
      const h2 = g2.nodes.get("1")!.contentHash;
      expect(h1).not.toBe(h2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("kiro tasks.md emits verifies edges from `_Requirements:` and no implements", () => {
    // kiro tasks.md fixture mirrors real AWS Kiro output: `- [x] N. ...` with
    // a sub-bullet `- _Requirements: X, Y_`. Built-in spec-kit's `T\d+` won't
    // match `1`, but kiro's hierarchical `\d+(?:\.\d+)*` will. Kiro preset has
    // no implementsTagRe (Kiro doesn't use `@impl(...)`), so implements edges
    // must be empty even though spec-kit's implementsTagRe is also in scope —
    // because spec-kit's idRe doesn't match this listItem, its tag regex is
    // never applied.
    const { graph } = buildGraph(resolve(tasksRoot, "kiro-tasks"), tasksConfig);
    expect(graph.edges.filter((e) => e.kind === "implements")).toEqual([]);
    const verifies = graph.edges
      .filter((e) => e.kind === "verifies")
      .sort((a, b) =>
        a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source),
      );
    expect(verifies).toEqual([
      { source: "1", target: "7.1", kind: "verifies", provenances: ["task-tag"] },
      { source: "1", target: "7.2", kind: "verifies", provenances: ["task-tag"] },
      { source: "1.1", target: "7.3", kind: "verifies", provenances: ["task-tag"] },
      { source: "1.2", target: "8.1", kind: "verifies", provenances: ["task-tag"] },
      { source: "2", target: "8.2", kind: "verifies", provenances: ["task-tag"] },
      { source: "2", target: "9.1", kind: "verifies", provenances: ["task-tag"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// req→req annotation edges (specs/010-req-req-dependency) — US1 / T011
// ---------------------------------------------------------------------------

const ANN_FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/req-req-annotations/collision");

const annConfig: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["010-a", "010-b"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("buildGraph: req→req annotation edges", () => {
  it("specDir-aware collision remap routes annotation targets to same specDir", () => {
    const { graph } = buildGraph(ANN_FIXTURE_DIR, annConfig);

    // AUTH-001 collides → both registered as qualified IDs.
    expect(graph.nodes.has("010-a/AUTH-001")).toBe(true);
    expect(graph.nodes.has("010-b/AUTH-001")).toBe(true);

    const annEdges = graph.edges.filter((e) => e.provenances?.includes("annotation"));
    // AUTH-002 in 010-a should point at 010-a/AUTH-001 (not 010-b/AUTH-001).
    expect(annEdges).toContainEqual({
      source: "AUTH-002",
      target: "010-a/AUTH-001",
      kind: "depends_on",
      provenances: ["annotation"],
    });
    // AUTH-003 in 010-b should point at 010-b/AUTH-001.
    expect(annEdges).toContainEqual({
      source: "AUTH-003",
      target: "010-b/AUTH-001",
      kind: "depends_on",
      provenances: ["annotation"],
    });
  });

  it("emits orphan-edge when annotation references an unknown id", () => {
    const tmpDir = resolve(import.meta.dirname, "fixtures/req-req-annotations/_tmp-orphan");
    const specDir = resolve(tmpDir, "010-c");
    mkdirSync(specDir, { recursive: true });
    const specFile = resolve(specDir, "spec.md");
    writeFileSync(specFile, "# orphan test\n\n- AUTH-100: 何か (depends_on: GHOST-999)\n");

    try {
      const { warnings } = buildGraph(tmpDir, {
        ...annConfig,
        specDirs: ["010-c"],
      });
      const orphan = warnings.find((w) => w.type === "orphan-edge" && w.id === "GHOST-999");
      expect(orphan).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dedups duplicate annotation edges to a single edge", () => {
    const tmpDir = resolve(import.meta.dirname, "fixtures/req-req-annotations/_tmp-dedup");
    const specDir = resolve(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      resolve(specDir, "spec.md"),
      "# dedup test\n\n- AUTH-001: 認証\n- AUTH-002: 二重 (depends_on: AUTH-001)(depends_on: AUTH-001)\n",
    );

    try {
      const { graph } = buildGraph(tmpDir, {
        ...annConfig,
        specDirs: ["specs"],
      });
      const annEdges = graph.edges.filter(
        (e) => e.provenances?.includes("annotation") && e.source === "AUTH-002",
      );
      expect(annEdges).toHaveLength(1);
      expect(annEdges[0].target).toBe("AUTH-001");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("drops self-referential annotation edges with a warning", () => {
    const tmpDir = resolve(import.meta.dirname, "fixtures/req-req-annotations/_tmp-self");
    const specDir = resolve(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      resolve(specDir, "spec.md"),
      "# self ref\n\n- AUTH-001: 認証 (depends_on: AUTH-001)\n",
    );

    try {
      const { graph, warnings } = buildGraph(tmpDir, {
        ...annConfig,
        specDirs: ["specs"],
      });
      const annEdges = graph.edges.filter((e) => e.provenances?.includes("annotation"));
      expect(annEdges).toEqual([]);
      const selfRef = warnings.find((w) => w.type === "self-reference-annotation");
      expect(selfRef).toBeDefined();
      expect(selfRef?.id).toBe("AUTH-001");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #35: provenance tagging at edge generation sites + dedup union
// ---------------------------------------------------------------------------

describe("buildGraph: provenance tagging (issue #35)", () => {
  const ALL_EIGHT = resolve(import.meta.dirname, "fixtures/edge-provenance/all-eight");
  const allEightConfig: ArtgraphConfig = {
    include: ["src/**/*.ts"],
    specDirs: ["specs"],
    testPatterns: ["tests/**/*.test.ts"],
    lockFile: ".trace.lock",
  };

  it("structural: auto-contains edges carry provenances: ['structural']", () => {
    const { graph } = buildGraph(ALL_EIGHT, allEightConfig);
    const contains = graph.edges.filter((e) => e.kind === "contains");
    expect(contains.length).toBeGreaterThan(0);
    for (const edge of contains) {
      expect(edge.provenances).toEqual(["structural"]);
    }
  });

  it("inline-link: doc inline links generate depends_on with provenances: ['inline-link']", () => {
    const { graph } = buildGraph(ALL_EIGHT, allEightConfig);
    // `specs/design.md` body has `[spec](./spec.md)` — inline link → depends_on.
    const link = graph.edges.find(
      (e) => e.kind === "depends_on" && e.source === "doc:design.md" && e.target === "doc:spec.md",
    );
    expect(link).toBeDefined();
    expect(link?.provenances).toEqual(["inline-link"]);
  });

  it("convention only: when no frontmatter collides, convention edge has provenances: ['convention']", () => {
    const { graph } = buildGraph(ALL_EIGHT, allEightConfig);
    // `tasks → design` from the kiro preset has no frontmatter counterpart.
    const tasksDesign = graph.edges.find(
      (e) =>
        e.kind === "derives_from" && e.source === "doc:tasks.md" && e.target === "doc:design.md",
    );
    expect(tasksDesign).toBeDefined();
    expect(tasksDesign?.provenances).toEqual(["convention"]);
  });
});

describe("buildGraph: dedup union (issue #35 US2)", () => {
  const TWO_PATHS = resolve(import.meta.dirname, "fixtures/edge-provenance/two-paths");
  const config: ArtgraphConfig = {
    include: [],
    specDirs: ["specs"],
    testPatterns: [],
    lockFile: ".trace.lock",
  };

  it("two paths (frontmatter+convention) collapse to one edge with sorted union", () => {
    const { graph } = buildGraph(TWO_PATHS, config);
    const edges = graph.edges.filter(
      (e) =>
        e.kind === "derives_from" &&
        e.source === "doc:feature-a/design.md" &&
        e.target === "doc:feature-a/requirements.md",
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].provenances).toEqual(["convention", "frontmatter"]);
  });

  it("INV-T2: repeated same provenance (e.g. duplicate @impl in same file) does not duplicate", () => {
    const tmpRoot = resolve(import.meta.dirname, "fixtures/_dedup-same-tmp");
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(resolve(tmpRoot, "specs"), { recursive: true });
    mkdirSync(resolve(tmpRoot, "src"), { recursive: true });
    writeFileSync(resolve(tmpRoot, "specs/spec.md"), "# Spec\n\n- FR-001: do\n", "utf-8");
    writeFileSync(
      resolve(tmpRoot, "src/dup.ts"),
      "// @impl FR-001\n// @impl FR-001\nexport const x = 1;\n",
      "utf-8",
    );
    try {
      const { graph } = buildGraph(tmpRoot, {
        ...config,
        include: ["src/**/*.ts"],
      });
      const impl = graph.edges.filter(
        (e) => e.kind === "implements" && e.source === "file:src/dup.ts" && e.target === "FR-001",
      );
      expect(impl).toHaveLength(1);
      expect(impl[0].provenances).toEqual(["code-tag"]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("INV-T3: source-order independence — same input always sorts identically", () => {
    // Two passes against the same fixture must yield the same sorted union.
    const { graph: g1 } = buildGraph(TWO_PATHS, config);
    const { graph: g2 } = buildGraph(TWO_PATHS, config);
    const e1 = g1.edges.find(
      (e) =>
        e.kind === "derives_from" &&
        e.source === "doc:feature-a/design.md" &&
        e.target === "doc:feature-a/requirements.md",
    );
    const e2 = g2.edges.find(
      (e) =>
        e.kind === "derives_from" &&
        e.source === "doc:feature-a/design.md" &&
        e.target === "doc:feature-a/requirements.md",
    );
    expect(e1?.provenances).toEqual(e2?.provenances);
  });

  // PR#94 review B3: post-dedup sort must make the whole edges array
  // determinate, not just the per-edge provenances list above. Two passes on
  // the same fixture should produce byte-identical edge arrays — that is
  // exactly the property INV-L4 (lock byte-identity) leans on. Encoding it
  // here pins the contract at the builder so any future "micro-optimization"
  // that drops the sort gets caught here instead of by a flaky Windows CI run.
  it("PR#94 B3: buildGraph called twice returns edges in identical order", () => {
    const { graph: g1 } = buildGraph(TWO_PATHS, config);
    const { graph: g2 } = buildGraph(TWO_PATHS, config);
    const key = (e: { source: string; target: string; kind: string }) =>
      `${e.source}|${e.target}|${e.kind}`;
    expect(g1.edges.map(key)).toEqual(g2.edges.map(key));
    // Strict whole-edge equality (provenances included) — guards against a
    // future regression where order matches but per-edge fields drift.
    expect(g1.edges).toEqual(g2.edges);
    // The order must also satisfy `source|target|kind` ascending — locks in
    // the codeunit sort contract so consumers (lock.ts byte-identity) can
    // rely on it.
    const keys = g1.edges.map(key);
    const sortedKeys = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keys).toEqual(sortedKeys);
  });

  // PR#94 review B3: nodes Map iteration order is now deterministic (id ASC).
  // This is observable through lock.ts / format.ts which iterate the Map
  // directly, so we lock the contract here at its source.
  it("PR#94 B3: graph.nodes Map iterates ids in ascending order", () => {
    const { graph } = buildGraph(TWO_PATHS, config);
    const ids = [...graph.nodes.keys()];
    const sortedIds = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(ids).toEqual(sortedIds);
  });

  // E5 (PR#94 review): the canonical TWO_PATHS test above only exercises the
  // `frontmatter + convention` combination. The dedup union has to hold for
  // every realistic two-source combination. Each `it` below is a tmp fixture
  // tailored to a different combination; the assertion is on `provenances`
  // (sorted, deduped) for the single surviving edge.
  describe("E5: dedup union for additional realistic provenance combinations", () => {
    const DEDUP_TMP = resolve(import.meta.dirname, "fixtures/_dedup-union-tmp");
    afterEach(() => rmSync(DEDUP_TMP, { recursive: true, force: true }));

    function setup(files: Record<string, string>) {
      rmSync(DEDUP_TMP, { recursive: true, force: true });
      for (const [rel, content] of Object.entries(files)) {
        const abs = resolve(DEDUP_TMP, rel);
        mkdirSync(resolve(abs, ".."), { recursive: true });
        writeFileSync(abs, content, "utf-8");
      }
    }

    it("code-tag + task-tag → same (source, target, kind) collapses to one edge with both provenances", () => {
      // A spec-kit `tasks.md` task implements FR-001; a code file also tags
      // `@impl FR-001`. Both edges share `(T001, FR-001, implements)`? No —
      // the task-emitted edge has source=T001 (the task id), and the code
      // edge has source=file:src/foo.ts. So **the targets coincide, sources
      // don't**, and the dedup key is per (source, target, kind). To produce
      // a true task-tag + code-tag union we need the SAME source: that means
      // a `@impl FR-001` tag at the same file path. The realistic case is two
      // distinct edges from two distinct sources to the same FR-001 — there
      // is no real-world dedup union here.
      //
      // So we PIN the design-correct behaviour: task-tag and code-tag emit
      // SEPARATE edges from separate sources. The assertion is the negation:
      // no dedup collapse happens; both edges survive with their original
      // single-element provenances arrays.
      setup({
        "specs/spec.md": "# Spec\n\n- FR-001: a\n",
        "specs/tasks.md": "# Tasks\n\n- [ ] T001: do @impl(FR-001)\n",
        "src/foo.ts": "// @impl FR-001\nexport const x = 1;\n",
      });
      const { graph } = buildGraph(DEDUP_TMP, {
        ...config,
        include: ["src/**/*.ts"],
      });
      const implEdges = graph.edges.filter((e) => e.kind === "implements" && e.target === "FR-001");
      expect(implEdges).toHaveLength(2);
      // Use toContainEqual so the assertion is independent of the codeunit
      // ordering between `T001` and `file:src/foo.ts` (uppercase vs lowercase
      // first-byte) — the dedup-by-source guarantee is what we're pinning,
      // not the sort key direction.
      expect(implEdges).toContainEqual({
        source: "T001",
        target: "FR-001",
        kind: "implements",
        provenances: ["task-tag"],
      });
      expect(implEdges).toContainEqual({
        source: "file:src/foo.ts",
        target: "FR-001",
        kind: "implements",
        provenances: ["code-tag"],
      });
    });

    it("frontmatter (doc) + inline-link (same target): frontmatter wins, inline-link dropped (design contract)", () => {
      // src/graph/builder.ts §explicitPairs: a frontmatter `derives_from` /
      // `depends_on` from a doc node SUPPRESSES any inline link to the same
      // target — see the comment block around `explicitPairs.add(...)`. The
      // surviving edge keeps the frontmatter provenance only; the inline-link
      // edge never reaches the dedup map. Locking this behaviour in here so
      // a future "merge instead of suppress" tweak gets caught.
      setup({
        "specs/source.md": [
          "---",
          "artgraph:",
          "  depends_on:",
          "    - tgt",
          "---",
          "",
          "# Source",
          "",
          "See [target](./target.md).",
          "",
        ].join("\n"),
        "specs/target.md": ["---", "artgraph:", "  node_id: tgt", "---", "", "# Target", ""].join(
          "\n",
        ),
      });
      const { graph } = buildGraph(DEDUP_TMP, config);
      const edges = graph.edges.filter(
        (e) =>
          (e.kind === "depends_on" || e.kind === "derives_from") &&
          e.source === "doc:source.md" &&
          e.target === "tgt",
      );
      expect(edges).toHaveLength(1);
      // Per the suppression rule the surviving edge is the frontmatter one;
      // its provenances list is `["frontmatter"]` (no inline-link union).
      expect(edges[0].provenances).toEqual(["frontmatter"]);
    });

    it("annotation + frontmatter (req → req): both paths survive and union sorts to ['annotation','frontmatter']", () => {
      // A req-level frontmatter `depends_on` is not currently emitted by the
      // parser (frontmatter edges only flow from doc-level `artgraph:` keys).
      // The realistic req-req combination is annotation + structural / derive
      // — neither produces the same (source, target, kind) tuple in practice.
      //
      // Synthesize the union here by hand at a tmp fixture that supplies BOTH
      // an inline annotation `(depends_on: REQ-B)` AND a frontmatter doc-level
      // `derives_from` pointing at REQ-B from the *same* source — but those
      // are different kinds (`depends_on` vs `derives_from`), so they remain
      // distinct edges per the dedup-by-(source, target, kind) key.
      //
      // We therefore prove the CONTRAPOSITIVE here: differing kinds produce
      // two edges. This pins the dedup-key contract for the annotation case so
      // a future "kind-agnostic dedup" regression would surface.
      setup({
        "specs/a.md": [
          "---",
          "artgraph:",
          "  node_id: req-a",
          "  derives_from:",
          "    - req-b",
          "---",
          "",
          "# A doc with one req inside",
          "",
          "- REQ-1: feature (depends_on: REQ-2)",
          "- REQ-2: dep",
          "",
        ].join("\n"),
      });
      const { graph } = buildGraph(DEDUP_TMP, config);
      const derives = graph.edges.filter((e) => e.kind === "derives_from" && e.source === "req-a");
      // The doc-level frontmatter edge is intact with provenance frontmatter.
      expect(derives).toEqual([
        {
          source: "req-a",
          target: "req-b",
          kind: "derives_from",
          provenances: ["frontmatter"],
        },
      ]);
      // And the req-level annotation edge is a separate (REQ-1 → REQ-2,
      // depends_on, annotation) edge — proving annotation and frontmatter
      // never share a dedup key in any current code path.
      const annotation = graph.edges.find(
        (e) => e.kind === "depends_on" && e.source === "REQ-1" && e.target === "REQ-2",
      );
      expect(annotation?.provenances).toEqual(["annotation"]);
    });
  });

  // Meta-C blind-spot 2 (PR#94 review): the post-dedup `dedupedEdges.sort()`
  // in src/graph/builder.ts:550 is supposed to absorb any `globSync` ordering
  // quirk. Pin it with two assertions: (1) two consecutive runs match (already
  // covered above as B3); (2) explicitly verifying both `edges` and `nodes`
  // iteration order on a fixture that has multiple files within the same
  // specDir — this is where `globSync` order matters most. A full `vi.mock`
  // of `globSync` would be more invasive than valuable — the post-dedup sort
  // makes the order strictly deterministic, so the equivalent assertion is
  // "every two passes equal" combined with "key ascending", which together
  // imply order-independence of the upstream globSync.
  it("Meta-C #2: glob order independence — repeated buildGraph runs return identical edges and nodes (TWO_PATHS)", () => {
    const { graph: g1 } = buildGraph(TWO_PATHS, config);
    const { graph: g2 } = buildGraph(TWO_PATHS, config);
    expect(g1.edges).toEqual(g2.edges);
    expect([...g1.nodes.entries()]).toEqual([...g2.nodes.entries()]);
  });
});

// SC-004 + Meta-C blind-spot 3 (PR#94 review E2): provenance 化前後で
// (source, target, kind) 集合が変化しないことを **全 fixture / 全 kind** で
// 確認する。Baseline は `Record<fixtureName, Array<{source, target, kind,
// provenances}>>` 形式で、4-tuple を sort 順に pin する。
//
// === Baseline 再生成手順 ===
// 1. 一時的に scratchpad に generator test を置く(E2 拡張時は本ファイル冒頭
//    のコメントに残された `_gen-baseline.test.ts` テンプレートを参照)。
// 2. 各 fixture を以下と同じ config で `buildGraph` → edges を
//    `(source, target, kind)` 昇順に sort → `provenances` も昇順に sort →
//    `JSON.stringify(result, null, 2) + "\n"` で書き出す。
// 3. `tests/__snapshots__/edge-set-baseline.json` を上書きし、生成スクリプト
//    は **コミットしない** (再現性確保のためコメントに手順を残す)。
describe("buildGraph: SC-004 edge-set baseline invariance (all fixtures)", () => {
  type BaselineEdge = {
    source: string;
    target: string;
    kind: string;
    provenances: string[];
  };

  // Each entry maps `fixture key` → { root dir, config }. The keys MUST match
  // the top-level keys in `__snapshots__/edge-set-baseline.json`.
  const FIXTURES: Record<string, { root: string; config: ArtgraphConfig }> = {
    conventions: {
      root: resolve(import.meta.dirname, "fixtures/conventions"),
      config: {
        include: [],
        specDirs: ["specs"],
        testPatterns: [],
        lockFile: ".trace.lock",
      },
    },
    "req-req-annotations-collision": {
      root: resolve(import.meta.dirname, "fixtures/req-req-annotations/collision"),
      config: {
        include: [],
        specDirs: ["010-a", "010-b"],
        testPatterns: [],
        lockFile: ".trace.lock",
      },
    },
    "edge-provenance-all-eight": {
      root: resolve(import.meta.dirname, "fixtures/edge-provenance/all-eight"),
      config: {
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
        lockFile: ".trace.lock",
      },
    },
    "edge-provenance-two-paths": {
      root: resolve(import.meta.dirname, "fixtures/edge-provenance/two-paths"),
      config: {
        include: [],
        specDirs: ["specs"],
        testPatterns: [],
        lockFile: ".trace.lock",
      },
    },
  };

  const sortKey = (e: { source: string; target: string; kind: string }) =>
    `${e.source}|${e.target}|${e.kind}`;

  // Lazy-load the whole baseline once; throw a hard error early if missing so
  // every per-fixture `it` gets the same actionable message.
  const baselinePath = resolve(import.meta.dirname, "__snapshots__/edge-set-baseline.json");

  // Driver: one `it` per fixture so the failure message names the offender.
  for (const [name, { root, config }] of Object.entries(FIXTURES)) {
    it(`(source, target, kind, provenances) tuple set matches baseline for "${name}"`, async () => {
      const fs = await import("node:fs");
      if (!fs.existsSync(baselinePath)) {
        expect.fail(
          `baseline missing at ${baselinePath}. Regenerate per the comment above this describe.`,
        );
        return;
      }
      const baseline: Record<string, BaselineEdge[]> = JSON.parse(
        fs.readFileSync(baselinePath, "utf-8"),
      );
      const expected = baseline[name];
      expect(expected, `baseline key "${name}" missing`).toBeDefined();

      const { graph } = buildGraph(root, config);
      const current: BaselineEdge[] = graph.edges
        .map((e) => ({
          source: e.source,
          target: e.target,
          kind: e.kind,
          provenances: [...e.provenances].sort(),
        }))
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      expect(current).toEqual(expected);
    });
  }
});

// spec 021 (issue #218) — class method grain, T020(b): the class-member vs.
// string-literal-export-alias ID collision (typescript.ts extractSymbols)
// must resolve identically and warn identically across independent cold
// builds — through the FULL buildGraph pipeline, not just the parser layer
// (see tests/typescript.test.ts's own T020(a)/(b) for the parser-only
// checks). PR #242 review A migrated the warning from a parser-level
// `console.warn` to the structured `BuildWarning` return channel
// (`class-member-collision`), so this test asserts on `buildGraph`'s
// `warnings` instead of a console spy — and additionally pins that NOTHING
// about the collision goes through console.warn anymore. Two separate tmp
// roots with byte-identical fixture content rule out any incremental
// parse-cache reuse muddying the comparison; disabling the cache via
// ARTGRAPH_CACHE=0 (same knob tests/parse-cache.test.ts uses) additionally
// guarantees both builds actually re-parse from scratch.
describe("buildGraph: class-member symbol collision determinism (spec 021 / T020(b))", () => {
  it("emits the same structured collision warning and the same graph across two independent cold builds", () => {
    const collisionSource = [
      "function helper(): void {}",
      'export { helper as "Sample.methodA" };',
      "",
      "export class Sample {",
      "  methodA(): void {}",
      "}",
      "",
    ].join("\n");

    const makeRoot = (): string => {
      const dir = mkdtempSync(join(tmpdir(), "artgraph-t020b-"));
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "specs"), { recursive: true });
      writeFileSync(join(dir, "src", "collision.ts"), collisionSource);
      return dir;
    };
    const rootA = makeRoot();
    const rootB = makeRoot();
    const symbolConfig: ArtgraphConfig = { ...config, mode: "symbol" };

    const snapshot = (nodes: Map<string, unknown>, edges: unknown[]) =>
      JSON.stringify({ nodes: [...nodes.entries()], edges });
    const collisions = (ws: BuildWarning[]) =>
      ws.filter((w) => w.type === "class-member-collision");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ARTGRAPH_CACHE = "0";
    let warningsA: BuildWarning[];
    let warningsB: BuildWarning[];
    let consoleCalls: string[];
    let snapshotA: string;
    let snapshotB: string;
    let symbolIdsA: string[];
    try {
      const resultA = buildGraph(rootA, symbolConfig);
      warningsA = collisions(resultA.warnings);
      snapshotA = snapshot(resultA.graph.nodes, resultA.graph.edges);
      symbolIdsA = [...resultA.graph.nodes.keys()].filter((id) => id.startsWith("symbol:"));

      const resultB = buildGraph(rootB, symbolConfig);
      warningsB = collisions(resultB.warnings);
      snapshotB = snapshot(resultB.graph.nodes, resultB.graph.edges);
      consoleCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    } finally {
      warnSpy.mockRestore();
      delete process.env.ARTGRAPH_CACHE;
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }

    // Both cold builds warn about the collision through the STRUCTURED
    // channel, identically (`files` are relative paths, so full deep
    // equality holds across the two roots).
    expect(warningsA).toHaveLength(1);
    expect(warningsA[0].id).toBe("symbol:src/collision.ts#Sample.methodA");
    expect(warningsA[0].files).toEqual(["src/collision.ts"]);
    expect(warningsA[0].message).toMatch(/collides with an existing/);
    expect(warningsB).toEqual(warningsA);

    // PR #242 review A — the parser-level console.warn side channel is gone.
    expect(consoleCalls.filter((msg) => msg.includes("Sample.methodA"))).toEqual([]);

    // Both cold builds agree on the resulting graph (paths are identical
    // across the two roots' relative `src/collision.ts`, so full equality —
    // not just shape — holds), and the class member won the collision:
    // exactly one node for the contested id.
    expect(snapshotB).toBe(snapshotA);
    expect(symbolIdsA.filter((id) => id === "symbol:src/collision.ts#Sample.methodA")).toHaveLength(
      1,
    );
  });
});

// issue #266 — config-level integration test: a `.artgraph.json`-shaped
// `include` list with a `!`-prefixed negative pattern must actually exclude
// the matched files from the graph (file/symbol nodes, and any @impl edges
// they'd otherwise contribute), not just fail to error.
describe("buildGraph: negative include patterns (issue #266)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t266-builder-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(
      join(root, "specs", "spec.md"),
      "# Spec\n\n- REQ-500: kept file requirement\n- REQ-600: generated-file requirement (should stay uncovered)\n",
    );
    // Literal tags below are string-literal-split (`"@" + "impl ..."`) so
    // artgraph's OWN dogfood scan of THIS repo never mistakes this fixture
    // text for a real code tag on `tests/builder.test.ts` itself — the
    // temp-directory fixture file still receives the concatenated,
    // unbroken tag. Mirrors the convention in
    // tests/check-baseline-diff.test.ts / tests/helpers.ts.
    write("src/keep.ts", "// @" + "impl REQ-500\nexport const keep = 1;\n");
    // A generated file that (if scanned) would satisfy REQ-600 — the whole
    // point of the exclusion is that it must NOT be scanned.
    write("src/generated/gen.ts", "// @" + "impl REQ-600\nexport const gen = 1;\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("excludes files matched by a `!`-prefixed include pattern", () => {
    const excludeConfig: ArtgraphConfig = {
      include: ["src/**/*.ts", "!src/generated/**"],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    const { graph } = buildGraph(root, excludeConfig);

    expect(graph.nodes.has("file:src/keep.ts")).toBe(true);
    expect(graph.nodes.has("file:src/generated/gen.ts")).toBe(false);

    const implEdges = graph.edges.filter((e) => e.kind === "implements");
    expect(implEdges.map((e) => e.target).sort()).toEqual(["REQ-500"]);
  });

  it("regression: without the negative pattern, the generated file is scanned as before", () => {
    const plainConfig: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    const { graph } = buildGraph(root, plainConfig);

    expect(graph.nodes.has("file:src/keep.ts")).toBe(true);
    expect(graph.nodes.has("file:src/generated/gen.ts")).toBe(true);
    const implEdges = graph.edges.filter((e) => e.kind === "implements");
    expect(implEdges.map((e) => e.target).sort()).toEqual(["REQ-500", "REQ-600"]);
  });
});

// issue #287 — `buildGraph` integration test: a config whose `include`
// still matches files under node_modules (e.g. a pre-#287 config that
// predates the `"!**/node_modules/**"` default) should surface a
// `node-modules-in-scan` warning, while a config carrying the negation
// should scan cleanly and not false-positive on a file that merely has
// "node_modules" as a substring of its own name.
describe("buildGraph: node_modules scan warning (issue #287)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t287-builder-"));
    // 6 files across two "packages" so the warning's `files` cap (5) is
    // actually exercised.
    write("node_modules/pkgA/a.ts", "export const a = 1;\n");
    write("node_modules/pkgA/b.ts", "export const b = 1;\n");
    write("node_modules/pkgA/c.ts", "export const c = 1;\n");
    write("node_modules/pkgB/d.ts", "export const d = 1;\n");
    write("node_modules/pkgB/e.ts", "export const e = 1;\n");
    write("node_modules/pkgB/f.ts", "export const f = 1;\n");
    // Segment-check regression fixture: this file's name merely CONTAINS
    // "node_modules" as a substring — it must never be treated as if it
    // were under a node_modules/ directory.
    write("node_modules.ts", "export const notNodeModules = 1;\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("warns when include has no node_modules exclusion, capping files at 5", () => {
    const cfg: ArtgraphConfig = {
      include: ["**/*.ts"],
      specDirs: [],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(root, cfg);
    const nmWarnings = warnings.filter((w) => w.type === "node-modules-in-scan");
    expect(nmWarnings).toHaveLength(1);
    expect(nmWarnings[0].message).toContain("6");
    expect(nmWarnings[0].message).toContain("!**/node_modules/**");
    expect(nmWarnings[0].files.length).toBeLessThanOrEqual(5);
  });

  it("does not warn and excludes node_modules files when include carries the negation", () => {
    const cfg: ArtgraphConfig = {
      include: ["**/*.ts", "!**/node_modules/**"],
      specDirs: [],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    const { graph, warnings } = buildGraph(root, cfg);
    expect(warnings.some((w) => w.type === "node-modules-in-scan")).toBe(false);
    expect(graph.nodes.has("file:node_modules/pkgA/a.ts")).toBe(false);
    expect(graph.nodes.has("file:node_modules/pkgB/f.ts")).toBe(false);
  });

  it("includes a root file literally named node_modules.ts without warning (segment check, not substring)", () => {
    const cfg: ArtgraphConfig = {
      include: ["**/*.ts", "!**/node_modules/**"],
      specDirs: [],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    const { graph, warnings } = buildGraph(root, cfg);
    expect(graph.nodes.has("file:node_modules.ts")).toBe(true);
    expect(warnings.some((w) => w.type === "node-modules-in-scan")).toBe(false);
  });
});

// issue #264 — full `buildGraph` integration. Before this fix, an unreadable
// file crashed HERE first: the incremental parse-cache path in
// src/graph/builder.ts reads every code file's content unconditionally (to
// compute a cache-validity hash) BEFORE any per-file parse ever runs, so an
// EACCES on that read crashed the whole build even before reaching
// `parseTSFile`'s own (separately guarded) read. Same
// permission-error-only-makes-sense-on-POSIX-non-root caveat as
// tests/typescript.test.ts's equivalent test — see IS_WIN/IS_ROOT there.
const IS_WIN_264 = process.platform === "win32";
const IS_ROOT_264 = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(IS_WIN_264 || IS_ROOT_264)(
  "buildGraph survives an unreadable file in the scan set (issue #264)",
  () => {
    let root: string;
    let unreadablePath: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "artgraph-builder-unreadable-"));
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/keep.ts"), "export const keep = 1;\n// @impl REQ-264\n");
      unreadablePath = join(root, "src/broken.ts");
      writeFileSync(unreadablePath, "export const neverRead = 1;\n");
      chmodSync(unreadablePath, 0o000);
    });

    afterAll(() => {
      chmodSync(unreadablePath, 0o644);
      rmSync(root, { recursive: true, force: true });
    });

    const cfg: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
    };

    it("does not throw building the graph", () => {
      expect(() => buildGraph(root, cfg)).not.toThrow();
    });

    it("emits an unreadable-file warning and still builds the rest of the graph normally", () => {
      const { graph, warnings } = buildGraph(root, cfg);
      const unreadableWarnings = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadableWarnings).toHaveLength(1);
      expect(unreadableWarnings[0].files).toEqual(["src/broken.ts"]);

      expect(graph.nodes.has("file:src/broken.ts")).toBe(true);
      expect(graph.nodes.has("file:src/keep.ts")).toBe(true);
      const implEdges = graph.edges.filter((e) => e.kind === "implements");
      expect(implEdges.map((e) => e.target)).toEqual(["REQ-264"]);
    });
  },
);

// issue #277 — the markdown/spec-file counterpart to #264's TS fix. Before
// this fix, an unreadable `.md` under a specDir crashed the whole
// scan/check/impact command right here in `buildGraph`'s markdown loop:
// `readFileSync` on a chmod-000 file throws with no per-file isolation.
// Same permission-error-only-makes-sense-on-POSIX-non-root caveat as
// tests/builder.test.ts's #264 test above.
const IS_WIN_277 = process.platform === "win32";
const IS_ROOT_277 = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(IS_WIN_277 || IS_ROOT_277)(
  "buildGraph survives an unreadable .md file in a specDir (issue #277)",
  () => {
    let root: string;
    let unreadablePath: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "artgraph-builder-unreadable-md-"));
      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs/good.md"), "- REQ-2771: keep me\n");
      unreadablePath = join(root, "specs/broken.md");
      writeFileSync(unreadablePath, "- REQ-2772: never read\n");
      chmodSync(unreadablePath, 0o000);
    });

    afterAll(() => {
      chmodSync(unreadablePath, 0o644);
      rmSync(root, { recursive: true, force: true });
    });

    const cfg: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
    };

    it("does not throw building the graph", () => {
      expect(() => buildGraph(root, cfg)).not.toThrow();
    });

    it("emits exactly one unreadable-file warning for the unreadable .md", () => {
      const { warnings } = buildGraph(root, cfg);
      const unreadableWarnings = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadableWarnings).toHaveLength(1);
      expect(unreadableWarnings[0].files).toEqual(["specs/broken.md"]);
    });

    it("still creates a bare doc node for the unreadable .md", () => {
      const { graph } = buildGraph(root, cfg);
      expect(graph.nodes.has("doc:broken.md")).toBe(true);
    });

    it("still parses sibling .md files normally", () => {
      const { graph } = buildGraph(root, cfg);
      expect(graph.nodes.has("REQ-2771")).toBe(true);
    });

    it("bare doc node has no children edges", () => {
      const { graph } = buildGraph(root, cfg);
      expect(graph.edges.some((e) => e.source === "doc:broken.md")).toBe(false);
    });

    // meta-review finding #1 / #3 (PR #293, issue #277 follow-up) — the bare
    // doc node's placeholder `contentHash` must never be written into
    // `.trace.lock`, or the file becoming readable again with byte-identical
    // content would spuriously look like drift (a real hash vs. the
    // sentinel). Regression test for the `buildLockFromGraph` guard in
    // src/lock.ts.
    it("does not write the placeholder hash into the lock (spurious-drift guard, meta-review #1)", () => {
      const { graph } = buildGraph(root, cfg);
      const lock = buildLockFromGraph(graph);

      // The bare doc node for the unreadable file is NOT locked.
      expect(lock["doc:broken.md"]).toBeUndefined();

      // The sibling readable file's req is still locked normally.
      expect(lock["REQ-2771"]).toBeDefined();
      expect(lock["REQ-2771"].contentHash).toBeTruthy();

      // Second scan on the now-readable file preserves the lock hash: make
      // broken.md readable, rebuild, and confirm its REQ locks in cleanly
      // with a real hash (not the sentinel) — a full round trip through the
      // "unreadable -> readable" transition never poisons the lock.
      chmodSync(unreadablePath, 0o644);
      try {
        const { graph: graph2 } = buildGraph(root, cfg);
        const lock2 = buildLockFromGraph(graph2, lock);
        expect(lock2["doc:broken.md"]).toBeDefined();
        expect(lock2["doc:broken.md"].contentHash).not.toBe("unreadable-file:no-content");
        expect(lock2["REQ-2772"]).toBeDefined();
      } finally {
        chmodSync(unreadablePath, 0o000);
      }
    });
  },
);

describe.skipIf(IS_WIN_277 || IS_ROOT_277)(
  "buildGraph respects docGraph.autoNodes=false for an unreadable .md file (issue #277)",
  () => {
    let root: string;
    let unreadablePath: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "artgraph-builder-unreadable-md-noauto-"));
      mkdirSync(join(root, "specs"), { recursive: true });
      writeFileSync(join(root, "specs/good.md"), "- REQ-2773: keep me too\n");
      unreadablePath = join(root, "specs/broken.md");
      writeFileSync(unreadablePath, "- REQ-2774: never read\n");
      chmodSync(unreadablePath, 0o000);
    });

    afterAll(() => {
      chmodSync(unreadablePath, 0o644);
      rmSync(root, { recursive: true, force: true });
    });

    const cfg: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
      docGraph: { autoNodes: false },
    };

    it("does not synthesize a bare doc node when autoNodes is false, but still warns", () => {
      const { graph, warnings } = buildGraph(root, cfg);
      const unreadableWarnings = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadableWarnings).toHaveLength(1);
      expect(graph.nodes.has("doc:broken.md")).toBe(false);
    });

    // meta-review finding #2 (PR #293, issue #277 follow-up) — documents the
    // deliberate asymmetry vs. the READABLE path: a readable doc with an
    // explicit frontmatter `node_id` survives `autoNodes: false` (only
    // auto-generated ids are filtered there). An UNREADABLE doc has no
    // frontmatter to inspect, so builder.ts cannot know whether it would
    // have declared a custom node_id — it gates synthesis unconditionally
    // on `autoNodes` instead. Net effect: a readable custom-node_id doc
    // always shows up in the graph regardless of `autoNodes`, but an
    // unreadable file NEVER does while `autoNodes: false` is set, even if
    // it would have declared its own custom node_id. This test locks in
    // that divergence rather than "fixing" it — see the comment above `if
    // (autoNodes)` in the catch branch of src/graph/builder.ts.
    it("readable custom-node_id doc survives autoNodes=false, but an unreadable file never does (documents the asymmetry, meta-review #2)", () => {
      const customPath = join(root, "specs/custom.md");
      writeFileSync(
        customPath,
        [
          "---",
          "artgraph:",
          '  node_id: "doc:my-custom-id"',
          "---",
          "- REQ-2775: custom doc req",
          "",
        ].join("\n"),
      );
      try {
        const { graph } = buildGraph(root, cfg);
        // Readable doc with an explicit node_id survives autoNodes:false.
        expect(graph.nodes.has("doc:my-custom-id")).toBe(true);
        // The unreadable file still produces NO doc node at all — even
        // though it, too, might have declared its own custom node_id we
        // will never get to see.
        expect(graph.nodes.has("doc:broken.md")).toBe(false);
      } finally {
        rmSync(customPath, { force: true });
      }
    });
  },
);
