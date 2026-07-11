import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { writeLock, readLock, buildLockFromGraph } from "../src/lock.js";
import type { ArtifactGraph, GraphNode, GraphEdge, LockFile } from "../src/types.js";

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
      [node("REQ-1", "req"), node("file:tests/foo.test.ts", "test"), node("T001", "task")],
      [
        {
          source: "file:tests/foo.test.ts",
          target: "REQ-1",
          kind: "verifies",
          provenances: ["code-tag"],
        },
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
      [node("REQ-3", "req"), node("file:src/foo.ts", "file"), node("T003", "task")],
      [
        {
          source: "file:src/foo.ts",
          target: "REQ-3",
          kind: "implements",
          provenances: ["code-tag"],
        },
        { source: "T003", target: "REQ-3", kind: "implements", provenances: ["task-tag"] },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-3"].impl).toEqual(["file:src/foo.ts"]);
  });

  it("does not write a lock entry for a task node", () => {
    const g = graph([node("T100", "task")], []);
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
      [{ source: "REQ-1", target: "REQ-2", kind: "depends_on", provenances: ["frontmatter"] }],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-1"].dependsOn).toEqual([{ id: "REQ-2", provenances: ["frontmatter"] }]);
  });

  it("INV-L1/L2: dependsOn array sorts by id, provenances sorts internally", () => {
    const g = graph(
      [node("A", "req"), node("B", "req"), node("C", "req"), node("D", "req")],
      [
        { source: "A", target: "D", kind: "depends_on", provenances: ["frontmatter"] },
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenances: ["inline-link", "annotation"],
        },
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

  // E4 (PR#94 review): the 2-element case above only proves a single swap. Pin
  // the sort across larger cardinalities so a future "stable sort short-circuit"
  // micro-optimisation can't silently regress INV-L2 for >2 elements.
  it("INV-L2 E4: 3-element provenances sort ascending (frontmatter+convention+annotation)", () => {
    const g = graph(
      [node("A", "req"), node("B", "req")],
      [
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenances: ["frontmatter", "convention", "annotation"],
        },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["A"].dependsOn).toEqual([
      { id: "B", provenances: ["annotation", "convention", "frontmatter"] },
    ]);
  });

  it("INV-L2 E4: 4-element provenances sort ascending (ts-import+code-tag+structural+task-tag)", () => {
    // Note: this is an artificial DepRef cardinality — annotation/structural
    // edges normally don't carry a ts-import provenance — but the sort
    // contract is provenance-agnostic and must hold for any non-empty
    // tuple. Locking this in catches a "sort by category bucket" regression.
    const g = graph(
      [node("A", "req"), node("B", "req")],
      [
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenances: ["ts-import", "code-tag", "structural", "task-tag"],
        },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["A"].dependsOn).toEqual([
      { id: "B", provenances: ["code-tag", "structural", "task-tag", "ts-import"] },
    ]);
  });

  it("INV-L2 E4: all-eight provenances sort to canonical alphabetical order", () => {
    // The maximal case: every EdgeProvenance value present once. Pins the
    // canonical sort order so type-union expansion has a concrete expectation
    // to update against. If `EDGE_PROVENANCE_VALUES` grows past 8, this test
    // must be updated alongside `req-req-invariants.test.ts SC-008`.
    const g = graph(
      [node("A", "req"), node("B", "req")],
      [
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenances: [
            "task-tag",
            "structural",
            "ts-import",
            "code-tag",
            "annotation",
            "convention",
            "inline-link",
            "frontmatter",
          ],
        },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["A"].dependsOn).toEqual([
      {
        id: "B",
        provenances: [
          "annotation",
          "code-tag",
          "convention",
          "frontmatter",
          "inline-link",
          "structural",
          "task-tag",
          "ts-import",
        ],
      },
    ]);
  });

  it("includes annotation-derived dependsOn (issue #35: no provenance filter)", () => {
    const g = graph(
      [node("REQ-A", "req"), node("REQ-B", "req")],
      [{ source: "REQ-A", target: "REQ-B", kind: "depends_on", provenances: ["annotation"] }],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-A"].dependsOn).toEqual([{ id: "REQ-B", provenances: ["annotation"] }]);
  });

  it("INV-L4 / SC-003: byte-identical JSON output on round-trip rebuild", () => {
    const g = graph(
      [node("X", "req"), node("Y", "req"), node("Z", "req")],
      [
        {
          source: "X",
          target: "Y",
          kind: "depends_on",
          provenances: ["frontmatter", "convention"],
        },
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

// spec 020 (tasks.md T016, data-model.md §5, FR-011) — `LockEntry.exercises`:
// target nodeIds of a req's `exercises` edges, same dedupe+sort convention as
// `impl`/`tests` (`[...new Set()].sort()`), omitted from the entry when
// empty.
describe("buildLockFromGraph — exercises (spec 020 T016)", () => {
  function node(id: string, kind: GraphNode["kind"]): GraphNode {
    return { id, kind, filePath: `${id}.md`, contentHash: "abc" };
  }
  function graph(nodes: GraphNode[], edges: GraphEdge[]): ArtifactGraph {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) map.set(n.id, n);
    return { nodes: map, edges };
  }

  it("①境界: populates `exercises` with deduped, sorted target nodeIds", () => {
    const g = graph(
      [
        node("REQ-1", "req"),
        node("symbol:src/a.ts#fn2", "symbol"),
        node("symbol:src/a.ts#fn1", "symbol"),
      ],
      [
        {
          source: "REQ-1",
          target: "symbol:src/a.ts#fn2",
          kind: "exercises",
          provenances: ["coverage"],
        },
        {
          source: "REQ-1",
          target: "symbol:src/a.ts#fn1",
          kind: "exercises",
          provenances: ["coverage"],
        },
        // Duplicate target (defensive — dedupEdges should already have
        // collapsed this upstream, but buildLockFromGraph must not assume
        // its input is always post-dedup).
        {
          source: "REQ-1",
          target: "symbol:src/a.ts#fn1",
          kind: "exercises",
          provenances: ["coverage"],
        },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-1"].exercises).toEqual(["symbol:src/a.ts#fn1", "symbol:src/a.ts#fn2"]);
  });

  it("①境界: `exercises` is omitted (not an empty array) when the req has no exercises edges", () => {
    const g = graph([node("REQ-2", "req")], []);
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-2"].exercises).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(lock["REQ-2"], "exercises")).toBe(false);
  });

  it("only edges SOURCED from this req are counted (exercises is req -> node, forward only)", () => {
    const g = graph(
      [node("REQ-3", "req"), node("REQ-4", "req")],
      [
        {
          source: "REQ-3",
          target: "symbol:src/a.ts#fn",
          kind: "exercises",
          provenances: ["coverage"],
        },
        {
          source: "REQ-4",
          target: "symbol:src/b.ts#fn",
          kind: "exercises",
          provenances: ["coverage"],
        },
      ],
    );
    const lock = buildLockFromGraph(g);
    expect(lock["REQ-3"].exercises).toEqual(["symbol:src/a.ts#fn"]);
    expect(lock["REQ-4"].exercises).toEqual(["symbol:src/b.ts#fn"]);
  });

  it("idempotency: rebuilding with an unchanged `exercises` set preserves prevLock's lastReconciled", () => {
    const g = graph(
      [node("REQ-5", "req")],
      [
        {
          source: "REQ-5",
          target: "symbol:src/a.ts#fn",
          kind: "exercises",
          provenances: ["coverage"],
        },
      ],
    );
    const lock1 = buildLockFromGraph(g);
    const firstStamp = lock1["REQ-5"].lastReconciled;

    // Rebuild from the SAME graph (structurally unchanged, including
    // `exercises`) with `lock1` as prevLock — the second reconcile must be
    // byte-identical and preserve lastReconciled (no vacuous timestamp
    // churn on a no-op scan).
    const lock2 = buildLockFromGraph(g, lock1);
    expect(lock2["REQ-5"].lastReconciled).toBe(firstStamp);
    expect(JSON.stringify(lock2)).toBe(JSON.stringify(lock1));
  });

  it("a CHANGED `exercises` set (staleness resolved / evidence gained) is NOT treated as unchanged — lastReconciled advances", () => {
    const before = graph(
      [node("REQ-6", "req")],
      [
        {
          source: "REQ-6",
          target: "symbol:src/a.ts#fn1",
          kind: "exercises",
          provenances: ["coverage"],
        },
      ],
    );
    const after = graph(
      [node("REQ-6", "req")],
      [
        {
          source: "REQ-6",
          target: "symbol:src/a.ts#fn1",
          kind: "exercises",
          provenances: ["coverage"],
        },
        {
          source: "REQ-6",
          target: "symbol:src/a.ts#fn2",
          kind: "exercises",
          provenances: ["coverage"],
        },
      ],
    );
    const lock1 = buildLockFromGraph(before);

    // Freeze time so the second build's fresh stamp is observably different
    // from the first (a real clock could tick the same millisecond).
    const now = "2026-07-10T01:00:00.000Z";
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
    let lock2: LockFile;
    try {
      lock2 = buildLockFromGraph(after, lock1);
    } finally {
      global.Date = real;
    }
    expect(lock2["REQ-6"].exercises).toEqual(["symbol:src/a.ts#fn1", "symbol:src/a.ts#fn2"]);
    expect(lock2["REQ-6"].lastReconciled).toBe(now);
    expect(lock2["REQ-6"].lastReconciled).not.toBe(lock1["REQ-6"].lastReconciled);
  });

  it("⑦回帰: a req WITHOUT exercises edges round-trips byte-identical to pre-spec-020 lock output", () => {
    const g = graph(
      [node("REQ-7", "req"), node("file:src/a.ts", "file")],
      [{ source: "file:src/a.ts", target: "REQ-7", kind: "implements", provenances: ["code-tag"] }],
    );
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
    let stamped: LockFile;
    try {
      stamped = buildLockFromGraph(g);
    } finally {
      global.Date = real;
    }
    // Exact pre-spec-020 shape: no `exercises` key at all in the serialized
    // JSON — field set/order matches the pre-existing entry-building order
    // (contentHash, lastReconciled, specFile, impl).
    expect(JSON.stringify(stamped["REQ-7"])).toBe(
      JSON.stringify({
        contentHash: "abc",
        lastReconciled: now,
        specFile: "REQ-7.md",
        impl: ["file:src/a.ts"],
      }),
    );
  });
});

// E1 (PR#94 review): the INV-L4 test above only exercises the in-memory
// `buildLockFromGraph` twice. It does NOT round-trip through the disk. The
// reviewer's concern is that `writeLock → readLock → writeLock` must also
// produce byte-identical output, without any Date stub — because the Phase 1
// idempotency fix in `buildLockFromGraph(graph, prevLock?)` preserves
// `lastReconciled` from `prevLock` when nothing structural changed. The test
// below proves that property end-to-end on the real filesystem.
describe("INV-L4 / SC-003 round-trip via fs (PR#94 E1)", () => {
  const TMP = resolve(import.meta.dirname, "fixtures/_lock-roundtrip-tmp");
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  function node(id: string, kind: GraphNode["kind"]): GraphNode {
    return { id, kind, filePath: `${id}.md`, contentHash: "abc" };
  }
  function graph(nodes: GraphNode[], edges: GraphEdge[]): ArtifactGraph {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) map.set(n.id, n);
    return { nodes: map, edges };
  }

  it("writeLock → readLock → buildLockFromGraph(g, prev) → writeLock yields byte-identical files (NO Date stub)", () => {
    const g = graph(
      [node("X", "req"), node("Y", "req"), node("Z", "req")],
      [
        {
          source: "X",
          target: "Y",
          kind: "depends_on",
          provenances: ["frontmatter", "convention"],
        },
        { source: "X", target: "Z", kind: "derives_from", provenances: ["annotation"] },
      ],
    );

    // Set up two sibling output dirs so we can write twice and `Buffer.compare`
    // both files independently.
    const dirA = resolve(TMP, "a");
    const dirB = resolve(TMP, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    // Pass 1: build from scratch and persist.
    const lock1 = buildLockFromGraph(g);
    writeLock(dirA, ".trace.lock", lock1);

    // Pass 2: read back from disk, then rebuild using prevLock — the
    // idempotency contract is what makes lastReconciled survive verbatim.
    const prev = readLock(dirA, ".trace.lock");
    const lock2 = buildLockFromGraph(g, prev);
    writeLock(dirB, ".trace.lock", lock2);

    // Byte-level comparison: anything weaker (e.g. JSON.stringify of the
    // in-memory objects) would not catch a trailing-newline or whitespace
    // regression in `writeLock`.
    const bufA = readFileSync(resolve(dirA, ".trace.lock"));
    const bufB = readFileSync(resolve(dirB, ".trace.lock"));
    expect(Buffer.compare(bufA, bufB)).toBe(0);

    // Belt-and-suspenders: the same property at the parsed-object level.
    // If this passed but the buffer compare failed we'd know the difference
    // is whitespace / formatting and not structure.
    expect(JSON.parse(bufA.toString("utf-8"))).toEqual(JSON.parse(bufB.toString("utf-8")));
  });
});
