import { describe, it, expect } from "vitest";
import { renderGraphData } from "../src/graph/render.js";
import type { ArtifactGraph, CheckResult, GraphNode, GraphEdge } from "../src/types.js";

// Deterministic timestamp used across tests so meta comparisons never depend
// on wall-clock time.
const FIXED_TS = "2025-01-01T00:00:00.000Z";

function makeNode(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "kind">): GraphNode {
  return {
    filePath: `${partial.id}.md`,
    contentHash: `hash-${partial.id}`,
    ...partial,
  };
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[] = []): ArtifactGraph {
  const map = new Map<string, GraphNode>();
  for (const n of nodes) map.set(n.id, n);
  return { nodes: map, edges };
}

describe("renderGraphData: basic conversion", () => {
  it("maps a mixed req/doc/file/symbol/test graph into the 4 layers with ok state when no checkResult", () => {
    const graph = makeGraph(
      [
        makeNode({ id: "REQ-001", kind: "req", filePath: "specs/req.md" }),
        makeNode({ id: "doc:specs/plan.md", kind: "doc", filePath: "specs/plan.md" }),
        makeNode({ id: "file:src/a.ts", kind: "file", filePath: "src/a.ts" }),
        makeNode({ id: "symbol:src/a.ts#foo", kind: "symbol", filePath: "src/a.ts" }),
        makeNode({ id: "test:tests/a.test.ts", kind: "test", filePath: "tests/a.test.ts" }),
      ],
      [
        {
          source: "file:src/a.ts",
          target: "REQ-001",
          kind: "implements",
          provenances: ["code-tag"],
        },
        {
          source: "test:tests/a.test.ts",
          target: "REQ-001",
          kind: "verifies",
          provenances: ["code-tag"],
        },
      ],
    );

    const out = renderGraphData(graph, { rootDir: "/repo", generatedAt: FIXED_TS });

    expect(out.nodes).toHaveLength(5);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("REQ-001")!.layer).toBe("req");
    expect(byId.get("doc:specs/plan.md")!.layer).toBe("doc");
    expect(byId.get("file:src/a.ts")!.layer).toBe("code");
    expect(byId.get("symbol:src/a.ts#foo")!.layer).toBe("code");
    expect(byId.get("test:tests/a.test.ts")!.layer).toBe("test");
    for (const n of out.nodes) {
      expect(n.state).toBe("ok");
    }
    // Edges only carry {source,target,kind} — provenances is dropped.
    for (const e of out.edges) {
      expect(Object.keys(e).sort()).toEqual(["kind", "source", "target"]);
    }
  });
});

describe("renderGraphData: task exclusion", () => {
  it("skips task nodes and drops any edge whose source or target is a task", () => {
    const graph = makeGraph(
      [
        makeNode({ id: "REQ-001", kind: "req" }),
        makeNode({ id: "T001", kind: "task" }),
        makeNode({ id: "file:src/a.ts", kind: "file", filePath: "src/a.ts" }),
      ],
      [
        // task -> req (should be dropped)
        {
          source: "T001",
          target: "REQ-001",
          kind: "implements",
          provenances: ["task-tag"],
        },
        // doc/file -> task (should be dropped)
        {
          source: "file:src/a.ts",
          target: "T001",
          kind: "depends_on",
          provenances: ["annotation"],
        },
        // file -> req (should survive)
        {
          source: "file:src/a.ts",
          target: "REQ-001",
          kind: "implements",
          provenances: ["code-tag"],
        },
      ],
    );

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });

    expect(out.nodes.map((n) => n.id).sort()).toEqual(["REQ-001", "file:src/a.ts"]);
    expect(out.edges).toEqual([{ source: "file:src/a.ts", target: "REQ-001", kind: "implements" }]);
  });
});

describe("renderGraphData: layer mapping specifics", () => {
  it("maps symbol → code and file → code", () => {
    const graph = makeGraph([
      makeNode({ id: "file:src/x.ts", kind: "file", filePath: "src/x.ts" }),
      makeNode({ id: "symbol:src/x.ts#Foo", kind: "symbol", filePath: "src/x.ts" }),
    ]);

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });

    for (const n of out.nodes) {
      expect(n.layer).toBe("code");
    }
  });
});

// spec 021 (T025, issue #218) — the renderer is generic over node.kind /
// edge.kind (layerFor + the task-exclusion filter are the only kind-specific
// branches); a class -> method `contains` edge (symbol -> symbol, provenance
// "structural") is just another `symbol`-kind node pair and an edge whose
// kind happens to be `contains` — no renderer code path special-cases doc ->
// req/task containment, so this confirms no crash / no silent drop for the
// method-grain shape.
describe("renderGraphData: class -> method `contains` (symbol -> symbol) — spec 021 / issue #218", () => {
  it("both the class and method symbols map to the `code` layer, and the `contains` edge survives unmodified", () => {
    const graph = makeGraph(
      [
        makeNode({ id: "symbol:src/sample.ts#Sample", kind: "symbol", filePath: "src/sample.ts" }),
        makeNode({
          id: "symbol:src/sample.ts#Sample.methodA",
          kind: "symbol",
          filePath: "src/sample.ts",
        }),
        makeNode({ id: "REQ-902", kind: "req", filePath: "specs/req.md" }),
      ],
      [
        {
          source: "symbol:src/sample.ts#Sample",
          target: "symbol:src/sample.ts#Sample.methodA",
          kind: "contains",
          provenances: ["structural"],
        },
        {
          source: "symbol:src/sample.ts#Sample.methodA",
          target: "REQ-902",
          kind: "implements",
          provenances: ["code-tag"],
        },
      ],
    );

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });

    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("symbol:src/sample.ts#Sample")!.layer).toBe("code");
    expect(byId.get("symbol:src/sample.ts#Sample.methodA")!.layer).toBe("code");
    expect(out.edges).toContainEqual({
      source: "symbol:src/sample.ts#Sample",
      target: "symbol:src/sample.ts#Sample.methodA",
      kind: "contains",
    });
    // Dotted symbol ids don't confuse the determinism sort (string `<`/`>`).
    expect(out.nodes.map((n) => n.id)).toEqual([
      "REQ-902",
      "symbol:src/sample.ts#Sample",
      "symbol:src/sample.ts#Sample.methodA",
    ]);
  });

  it("check-result state (drift/orphan/uncovered) applies to a method symbol id exactly like any other node id", () => {
    const graph = makeGraph(
      [
        makeNode({ id: "symbol:src/sample.ts#Sample", kind: "symbol", filePath: "src/sample.ts" }),
        makeNode({
          id: "symbol:src/sample.ts#Sample.methodA",
          kind: "symbol",
          filePath: "src/sample.ts",
        }),
      ],
      [
        {
          source: "symbol:src/sample.ts#Sample",
          target: "symbol:src/sample.ts#Sample.methodA",
          kind: "contains",
          provenances: ["structural"],
        },
      ],
    );

    const checkResult: CheckResult = {
      drifted: [
        {
          nodeId: "symbol:src/sample.ts#Sample.methodA",
          kind: "symbol",
          lockedHash: "old",
          currentHash: "new",
        },
      ],
      orphans: [],
      orphanNodeIds: [],
      uncovered: [],
      coverage: [],
      testFailures: [],
      pass: false,
    };

    const out = renderGraphData(graph, { rootDir: ".", checkResult, generatedAt: FIXED_TS });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("symbol:src/sample.ts#Sample.methodA")!.state).toBe("drift");
    // The class symbol itself carries no lock entry drift of its own here —
    // it stays ok (drift is per-node, not inherited through `contains`).
    expect(byId.get("symbol:src/sample.ts#Sample")!.state).toBe("ok");
  });
});

describe("renderGraphData: label fallback", () => {
  it("uses basename(filePath) for non-req nodes without label", () => {
    const graph = makeGraph([
      makeNode({ id: "file:src/nested/deep/a.ts", kind: "file", filePath: "src/nested/deep/a.ts" }),
      makeNode({
        id: "doc:specs/plan.md",
        kind: "doc",
        filePath: "specs/plan.md",
      }),
    ]);

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("file:src/nested/deep/a.ts")!.label).toBe("a.ts");
    expect(byId.get("doc:specs/plan.md")!.label).toBe("plan.md");
  });

  it("uses node.id for req nodes without label", () => {
    const graph = makeGraph([makeNode({ id: "REQ-042", kind: "req", filePath: "specs/req.md" })]);

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });
    expect(out.nodes[0].label).toBe("REQ-042");
  });

  it("prefers node.label when present", () => {
    const graph = makeGraph([
      makeNode({
        id: "REQ-042",
        kind: "req",
        filePath: "specs/req.md",
        label: "User can log in",
      }),
    ]);

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });
    expect(out.nodes[0].label).toBe("User can log in");
  });
});

describe("renderGraphData: state precedence", () => {
  const baseGraph = makeGraph([
    makeNode({ id: "REQ-A", kind: "req" }),
    makeNode({ id: "REQ-B", kind: "req" }),
    makeNode({ id: "REQ-C", kind: "req" }),
    makeNode({ id: "REQ-D", kind: "req" }),
  ]);

  it("drift wins over orphan and uncovered", () => {
    const checkResult: CheckResult = {
      drifted: [{ nodeId: "REQ-A", kind: "req", lockedHash: "old", currentHash: "new" }],
      orphans: [],
      orphanNodeIds: ["REQ-A"],
      uncovered: ["REQ-A"],
      coverage: [],
      testFailures: [],
      pass: false,
    };

    const out = renderGraphData(baseGraph, {
      rootDir: ".",
      checkResult,
      generatedAt: FIXED_TS,
    });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("REQ-A")!.state).toBe("drift");
  });

  it("orphan wins over uncovered when node is not drifted", () => {
    const checkResult: CheckResult = {
      drifted: [],
      orphans: [],
      orphanNodeIds: ["REQ-B"],
      uncovered: ["REQ-B"],
      coverage: [],
      testFailures: [],
      pass: false,
    };

    const out = renderGraphData(baseGraph, {
      rootDir: ".",
      checkResult,
      generatedAt: FIXED_TS,
    });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("REQ-B")!.state).toBe("orphan");
  });

  it("uncovered is assigned when the node is only in uncovered", () => {
    const checkResult: CheckResult = {
      drifted: [],
      orphans: [],
      orphanNodeIds: [],
      uncovered: ["REQ-C"],
      coverage: [],
      testFailures: [],
      pass: false,
    };

    const out = renderGraphData(baseGraph, {
      rootDir: ".",
      checkResult,
      generatedAt: FIXED_TS,
    });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get("REQ-C")!.state).toBe("uncovered");
    // REQ-D, which is in no bucket, stays ok.
    expect(byId.get("REQ-D")!.state).toBe("ok");
  });
});

describe("renderGraphData: stats counting", () => {
  it("counts drift/orphan/uncovered/ok correctly and reports total", () => {
    const graph = makeGraph([
      makeNode({ id: "REQ-1", kind: "req" }),
      makeNode({ id: "REQ-2", kind: "req" }),
      makeNode({ id: "REQ-3", kind: "req" }),
      makeNode({ id: "REQ-4", kind: "req" }),
      makeNode({ id: "REQ-5", kind: "req" }),
      makeNode({ id: "REQ-6", kind: "req" }),
      makeNode({ id: "REQ-7", kind: "req" }),
    ]);

    const checkResult: CheckResult = {
      drifted: [
        { nodeId: "REQ-1", kind: "req", lockedHash: "a", currentHash: "b" },
        { nodeId: "REQ-2", kind: "req", lockedHash: "a", currentHash: "b" },
      ],
      orphans: [],
      orphanNodeIds: ["REQ-3"],
      uncovered: ["REQ-4"],
      coverage: [],
      testFailures: [],
      pass: false,
    };

    const out = renderGraphData(graph, {
      rootDir: ".",
      checkResult,
      generatedAt: FIXED_TS,
    });
    expect(out.meta.stats).toEqual({ total: 7, drift: 2, orphan: 1, uncovered: 1 });
  });
});

describe("renderGraphData: determinism", () => {
  it("sorts nodes by id ascending and edges by (source, target, kind)", () => {
    // Insertion order intentionally reversed to make the sort observable.
    const graph = makeGraph(
      [
        makeNode({ id: "REQ-C", kind: "req" }),
        makeNode({ id: "REQ-A", kind: "req" }),
        makeNode({ id: "REQ-B", kind: "req" }),
      ],
      [
        {
          source: "REQ-C",
          target: "REQ-A",
          kind: "depends_on",
          provenances: ["frontmatter"],
        },
        {
          source: "REQ-A",
          target: "REQ-B",
          kind: "derives_from",
          provenances: ["frontmatter"],
        },
        // Two edges sharing (source, target) — sort must fall through to kind.
        {
          source: "REQ-B",
          target: "REQ-C",
          kind: "depends_on",
          provenances: ["frontmatter"],
        },
        {
          source: "REQ-B",
          target: "REQ-C",
          kind: "derives_from",
          provenances: ["frontmatter"],
        },
      ],
    );

    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });

    expect(out.nodes.map((n) => n.id)).toEqual(["REQ-A", "REQ-B", "REQ-C"]);
    expect(out.edges).toEqual([
      { source: "REQ-A", target: "REQ-B", kind: "derives_from" },
      { source: "REQ-B", target: "REQ-C", kind: "depends_on" },
      { source: "REQ-B", target: "REQ-C", kind: "derives_from" },
      { source: "REQ-C", target: "REQ-A", kind: "depends_on" },
    ]);
  });
});

describe("renderGraphData: empty graph", () => {
  it("returns empty arrays and zeroed stats", () => {
    const graph = makeGraph([]);
    const out = renderGraphData(graph, { rootDir: ".", generatedAt: FIXED_TS });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.meta.stats).toEqual({ total: 0, drift: 0, orphan: 0, uncovered: 0 });
  });
});

describe("renderGraphData: meta passthrough", () => {
  it("passes generatedAt through verbatim when provided", () => {
    const graph = makeGraph([]);
    const out = renderGraphData(graph, {
      rootDir: ".",
      generatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(out.meta.generatedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("defaults generatedAt to current time when omitted", () => {
    const graph = makeGraph([]);
    const before = Date.now();
    const out = renderGraphData(graph, { rootDir: "." });
    const after = Date.now();
    const t = Date.parse(out.meta.generatedAt);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("passes rootDir through to meta.rootDir", () => {
    const graph = makeGraph([]);
    const out = renderGraphData(graph, {
      rootDir: "/some/absolute/path",
      generatedAt: FIXED_TS,
    });
    expect(out.meta.rootDir).toBe("/some/absolute/path");
  });
});
