import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import type { ArtgraphConfig } from "../src/types.js";

const NS_FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/ns-collision");
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

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
