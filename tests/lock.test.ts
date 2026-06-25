import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { writeLock, buildLockFromGraph } from "../src/lock.js";
import type { ArtifactGraph, GraphNode } from "../src/types.js";

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
        { source: "file:tests/foo.test.ts", target: "REQ-1", kind: "verifies" },
        { source: "T001", target: "REQ-1", kind: "verifies" },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-1"].tests).toEqual(["file:tests/foo.test.ts"]);
  });

  it("omits entry.tests entirely when only task → verifies exists", () => {
    const g = graph(
      [node("REQ-2", "req"), node("T002", "task")],
      [{ source: "T002", target: "REQ-2", kind: "verifies" }],
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
        { source: "file:src/foo.ts", target: "REQ-3", kind: "implements" },
        { source: "T003", target: "REQ-3", kind: "implements" },
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
