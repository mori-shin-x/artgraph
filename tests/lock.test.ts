import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { writeLock, buildLockFromGraph } from "../src/lock.js";
import type { ArtifactGraph, GraphNode, GraphEdge } from "../src/types.js";

const TMP = resolve(import.meta.dirname, "fixtures/lock-test");

describe("writeLock path safety (S2)", () => {
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("writes the lock within the project root", () => {
    const root = resolve(TMP, "root");
    mkdirSync(root, { recursive: true });
    writeLock(root, ".trace.lock", {});
    expect(existsSync(resolve(root, ".trace.lock"))).toBe(true);
  });

  it("refuses to write through a symlinked directory escaping the root", () => {
    const root = resolve(TMP, "root2");
    const outside = resolve(TMP, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // The lockPath "link/.trace.lock" passes loadConfig's string-only check, but
    // "link" is a symlink pointing outside the root — writeLock must reject it.
    symlinkSync(outside, resolve(root, "link"), "dir");
    expect(() => writeLock(root, "link/.trace.lock", {})).toThrow("outside project root");
  });
});

describe("buildLockFromGraph — task sources are excluded (Issue #28 / data-model §7)", () => {
  function node(id: string, kind: GraphNode["kind"]): GraphNode {
    return { id, kind, filePath: `${id}.md`, contentHash: "abc" };
  }
  function graph(nodes: GraphNode[], edges: ArtifactGraph["edges"]): ArtifactGraph {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) map.set(n.id, n);
    return { nodes: map, edges };
  }

  it("excludes task → verifies sources from entry.tests", () => {
    const g = graph(
      [
        node("REQ-1", "req"),
        node("file:tests/foo.test.ts", "test"),
        node("T001", "task"),
      ],
      [
        { source: "file:tests/foo.test.ts", target: "REQ-1", kind: "verifies", provenances: ["code-tag"] },
        { source: "T001", target: "REQ-1", kind: "verifies", provenances: ["task-tag"] },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-1"].tests).toEqual(["file:tests/foo.test.ts"]);
  });

  it("omits entry.tests entirely when only task → verifies exists", () => {
    const g = graph(
      [node("REQ-2", "req"), node("T002", "task")],
      [{ source: "T002", target: "REQ-2", kind: "verifies", provenances: ["task-tag"] }],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-2"].tests).toBeUndefined();
  });

  it("excludes task → implements sources from entry.impl", () => {
    const g = graph(
      [
        node("REQ-3", "req"),
        node("file:src/foo.ts", "file"),
        node("T003", "task"),
      ],
      [
        { source: "file:src/foo.ts", target: "REQ-3", kind: "implements", provenances: ["code-tag"] },
        { source: "T003", target: "REQ-3", kind: "implements", provenances: ["task-tag"] },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-3"].impl).toEqual(["file:src/foo.ts"]);
  });

  it("does not write a lock entry for a task node", () => {
    const g = graph(
      [node("T100", "task")],
      [],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["T100"]).toBeUndefined();
  });
});

// Issue #35 / specs/011-edge-provenance/contracts/lock-schema-v2.md
describe("buildLockFromGraph — schema v2 dependsOn", () => {
  function node(id: string, kind: GraphNode["kind"]): GraphNode {
    return { id, kind, filePath: `${id}.md`, contentHash: "abc" };
  }
  function graph(nodes: GraphNode[], edges: GraphEdge[]): ArtifactGraph {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) map.set(n.id, n);
    return { nodes: map, edges };
  }

  it("INV-L3: dependsOn elements use {id, provenances} shape with provenances.length >= 1", () => {
    const g = graph(
      [node("REQ-1", "req"), node("REQ-2", "req")],
      [
        { source: "REQ-1", target: "REQ-2", kind: "depends_on", provenances: ["frontmatter"] },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-1"].dependsOn).toEqual([
      { id: "REQ-2", provenances: ["frontmatter"] },
    ]);
  });

  it("INV-L1/L2: dependsOn array sorts by id, provenances sorts internally", () => {
    const g = graph(
      [node("A", "req"), node("B", "req"), node("C", "req"), node("D", "req")],
      [
        { source: "A", target: "D", kind: "depends_on", provenances: ["frontmatter"] },
        { source: "A", target: "B", kind: "depends_on", provenances: ["inline-link", "annotation"] },
        { source: "A", target: "C", kind: "derives_from", provenances: ["convention"] },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["A"].dependsOn).toEqual([
      { id: "B", provenances: ["annotation", "inline-link"] },
      { id: "C", provenances: ["convention"] },
      { id: "D", provenances: ["frontmatter"] },
    ]);
  });

  it("includes annotation-derived dependsOn (issue #35: no provenance filter)", () => {
    const g = graph(
      [node("REQ-A", "req"), node("REQ-B", "req")],
      [
        { source: "REQ-A", target: "REQ-B", kind: "depends_on", provenances: ["annotation"] },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-A"].dependsOn).toEqual([
      { id: "REQ-B", provenances: ["annotation"] },
    ]);
  });

  it("INV-L4 / SC-003: byte-identical JSON output on round-trip rebuild", () => {
    const g = graph(
      [node("X", "req"), node("Y", "req"), node("Z", "req")],
      [
        { source: "X", target: "Y", kind: "depends_on", provenances: ["frontmatter", "convention"] },
        { source: "X", target: "Z", kind: "derives_from", provenances: ["annotation"] },
      ],
    );
    // Freeze time so lastReconciled differences don't mask structural diffs.
    const now = "2026-06-26T00:00:00.000Z";
    const real = global.Date;
    // @ts-expect-error - test stub
    global.Date = class extends real {
      constructor(...args: ConstructorParameters<typeof real>) {
        super(...(args.length === 0 ? [now] : args));
      }
      static now() {
        return real.parse(now);
      }
    };
    try {
      const lock1 = buildLockFromGraph(g);
      const lock2 = buildLockFromGraph(g);
      const s1 = JSON.stringify(lock1, null, 2) + "\n";
      const s2 = JSON.stringify(lock2, null, 2) + "\n";
      expect(s1).toBe(s2);
    } finally {
      global.Date = real;
    }
  });
});
