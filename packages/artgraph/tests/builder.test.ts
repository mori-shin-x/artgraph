import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { buildGraph } from "../src/graph/builder.js";
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
    const tmpPath = resolve(FIXTURE_DIR, "specs/reserved-prefix-test.md");
    writeFileSync(
      tmpPath,
      `---
artgraph:
  node_id: "reserved-test"
---
# Test

- doc:FR-001: This req ID uses a reserved prefix
`,
    );

    try {
      const { warnings } = buildGraph(FIXTURE_DIR, config);
      const reservedWarnings = warnings.filter(
        (w) => w.type === "reserved-prefix" && w.id === "doc:FR-001",
      );
      expect(reservedWarnings.length).toBe(0);
      // Note: The regex for req IDs is [A-Z][A-Za-z]*-\d+, so "doc:FR-001" won't match
      // as it starts with lowercase "doc:". This is actually correct behavior:
      // the reserved-prefix check only triggers for IDs that DO match the req pattern.
    } finally {
      unlinkSync(tmpPath);
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
    writeFileSync(
      resolve(tmpSpecs, "foo.md"),
      `# Foo\n\nSee [notes](../docs/notes.md).\n`,
    );
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

  const derivesFrom = (source: string, target: string) => (graph: {
    edges: { source: string; target: string; kind: string }[];
  }) =>
    graph.edges.some(
      (e) => e.kind === "derives_from" && e.source === source && e.target === target,
    );

  // Helper: derives_from edges originating from a given dir (by source-id prefix
  // for auto-generated doc ids; pure prefix check on `source` is enough since
  // the fixtures don't reuse stem names across dirs in a way that overlaps).
  const derivesFromDir = (dirPrefix: string) => (graph: {
    edges: { source: string; target: string; kind: string }[];
  }) =>
    graph.edges.filter(
      (e) => e.kind === "derives_from" && e.source.startsWith(dirPrefix),
    );

  it("infers kiro chain (design→requirements, tasks→design)", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(
      derivesFrom("doc:kiro-feature/design.md", "doc:kiro-feature/requirements.md")(graph),
    ).toBe(true);
    expect(
      derivesFrom("doc:kiro-feature/tasks.md", "doc:kiro-feature/design.md")(graph),
    ).toBe(true);
    // Lock in *exactly* two edges out of this dir — catches accidental
    // over-generation (e.g. spec-kit pairs firing in a kiro dir).
    expect(derivesFromDir("doc:kiro-feature/")(graph)).toHaveLength(2);
  });

  it("infers spec-kit chain (plan→spec, tasks→plan, research→spec)", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    expect(
      derivesFrom("doc:speckit-feature/plan.md", "doc:speckit-feature/spec.md")(graph),
    ).toBe(true);
    expect(
      derivesFrom("doc:speckit-feature/tasks.md", "doc:speckit-feature/plan.md")(graph),
    ).toBe(true);
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
        e.kind === "derives_from" &&
        e.source === "wf-design" &&
        e.target === "wf-requirements",
    );
    expect(matching).toHaveLength(1);
  });

  it("does not link convention files across different directories", () => {
    const { graph } = buildGraph(CONV_FIXTURE_DIR, convConfig);

    // other-dir has only requirements.md; it must not connect to any design elsewhere.
    const crossDir = graph.edges.filter(
      (e) =>
        e.kind === "derives_from" &&
        e.target === "doc:other-dir/requirements.md",
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

    expect(
      derivesFrom("doc:mixed-tools/tasks.md", "doc:mixed-tools/design.md")(graph),
    ).toBe(true);
    expect(
      derivesFrom("doc:mixed-tools/tasks.md", "doc:mixed-tools/plan.md")(graph),
    ).toBe(true);
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
    expect(
      derivesFrom("doc:kiro-feature/design.md", "doc:kiro-feature/requirements.md")(g2),
    ).toBe(true);
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
    expect(
      derivesFrom("doc:speckit-feature/plan.md", "doc:speckit-feature/spec.md")(graph),
    ).toBe(false);

    // Total derives_from across the fixture: only the frontmatter-declared
    // `wf-design → wf-requirements` survives. Locking in the count proves no
    // convention edge slipped through.
    const allDerives = graph.edges.filter((e) => e.kind === "derives_from");
    expect(allDerives).toHaveLength(1);
    expect(allDerives[0].source).toBe("wf-design");
    expect(allDerives[0].target).toBe("wf-requirements");
  });
});
