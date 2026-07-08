// specs/018-reexport-symbol-precision §5 — unit tests for the pure
// `expandStarReexports` function. No filesystem I/O; every fixture is a
// hand-built `Map<string, GraphNode>` and `Map<string, string[]>` so the
// algorithmic properties (§7 shadowing, cycle cut, `#default` exclusion,
// D3/D4 ambiguity, conditional memoization) are pinned independently of
// the parser / builder wiring that arrives in Phase 2.

import { describe, it, expect } from "vitest";
import { expandStarReexports } from "../src/graph/star-expansion.js";
import type { GraphNode } from "../src/types.js";
import { synthReexportHash } from "../src/parsers/typescript.js";

// Small helper: mint a symbol node with a stable placeholder contentHash.
// Local symbol nodes always exist in ownNames (the origin's own decl), so
// their hash is opaque to the star-expansion algorithm — only the synth
// nodes' hashes come from `synthReexportHash`.
function makeSymbol(file: string, name: string): [string, GraphNode] {
  const id = `symbol:${file}#${name}`;
  return [id, { id, kind: "symbol", filePath: file, contentHash: `hash-${file}-${name}` }];
}

function mkNodes(entries: Array<[string, string]>): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const [file, name] of entries) {
    const [id, node] = makeSymbol(file, name);
    m.set(id, node);
  }
  return m;
}

// Snapshot the shape of a Map<string, GraphNode> as sorted entries so we
// can compare "no mutation" pre/post a call. Ordinary `expect(map).toEqual`
// on Maps is deep-equality but insertion-order-agnostic; snapshotting via
// sorted entries gives a value-comparable representation.
function snapshotNodes(m: ReadonlyMap<string, GraphNode>): Array<[string, GraphNode]> {
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, { ...v }]);
}

function snapshotStar(m: ReadonlyMap<string, readonly string[]>): Array<[string, string[]]> {
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, [...v]]);
}

// -----------------------------------------------------------------------
// Design §11 T1 — basic single-level star
// -----------------------------------------------------------------------

describe("expandStarReexports — T1 basic", () => {
  it("materializes a synth node + edge for each origin export", () => {
    const nodes = mkNodes([
      ["C.ts", "x"],
      ["C.ts", "y"],
    ]);
    const starMap = new Map<string, readonly string[]>([["B.ts", ["C.ts"]]]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    expect(outNodes).toEqual([
      {
        id: "symbol:B.ts#x",
        kind: "symbol",
        filePath: "B.ts",
        contentHash: synthReexportHash("C.ts", "x", "x"),
      },
      {
        id: "symbol:B.ts#y",
        kind: "symbol",
        filePath: "B.ts",
        contentHash: synthReexportHash("C.ts", "y", "y"),
      },
    ]);
    expect(outEdges).toEqual([
      {
        source: "symbol:B.ts#x",
        target: "symbol:C.ts#x",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "symbol:B.ts#y",
        target: "symbol:C.ts#y",
        kind: "imports",
        provenances: ["ts-import"],
      },
    ]);
  });
});

// -----------------------------------------------------------------------
// Design §11 T2 — multi-hop chain, each hop 1-provider apart (D4)
// -----------------------------------------------------------------------

describe("expandStarReexports — T2 chain (edge target is the direct provider)", () => {
  it("emits one hop per barrel, never collapsing to the ultimate origin", () => {
    const nodes = mkNodes([["C.ts", "x"]]);
    const starMap = new Map<string, readonly string[]>([
      ["A.ts", ["B.ts"]],
      ["B.ts", ["C.ts"]],
    ]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    // Barrels are emitted rel-path asc, so A first, then B.
    expect(outNodes.map((n) => n.id)).toEqual(["symbol:A.ts#x", "symbol:B.ts#x"]);
    expect(outEdges).toEqual([
      {
        source: "symbol:A.ts#x",
        target: "symbol:B.ts#x",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "symbol:B.ts#x",
        target: "symbol:C.ts#x",
        kind: "imports",
        provenances: ["ts-import"],
      },
    ]);
    // Design §4 D4: contentHash inputs use the DIRECT provider, not the
    // ultimate origin — A#x's hash uses B, not C.
    expect(outNodes[0].contentHash).toBe(synthReexportHash("B.ts", "x", "x"));
    expect(outNodes[1].contentHash).toBe(synthReexportHash("C.ts", "x", "x"));
  });
});

// -----------------------------------------------------------------------
// Design §11 T3 — mutual cycle terminates + propagates each side's name
// -----------------------------------------------------------------------

describe("expandStarReexports — T3 A↔B cycle", () => {
  it("terminates and materializes each side's foreign name without duplicating own names", () => {
    const nodes = mkNodes([
      ["A.ts", "a"],
      ["B.ts", "b"],
    ]);
    const starMap = new Map<string, readonly string[]>([
      ["A.ts", ["B.ts"]],
      ["B.ts", ["A.ts"]],
    ]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    // A already has `a` locally, B already has `b` locally — those names
    // are NOT re-emitted (design §7: ownNames wins). Star only carries
    // the OTHER side's name across.
    expect(outNodes.map((n) => n.id).sort()).toEqual(["symbol:A.ts#b", "symbol:B.ts#a"]);
    // Edges target the direct provider on the OTHER side.
    expect(outEdges.find((e) => e.source === "symbol:A.ts#b")?.target).toBe("symbol:B.ts#b");
    expect(outEdges.find((e) => e.source === "symbol:B.ts#a")?.target).toBe("symbol:A.ts#a");
  });
});

// -----------------------------------------------------------------------
// Design §11 T4 — `default` never re-exports through `export *`
// -----------------------------------------------------------------------

describe("expandStarReexports — T4 default exclusion", () => {
  it("skips a `#default` origin symbol but propagates its siblings", () => {
    const nodes = mkNodes([
      ["C.ts", "default"],
      ["C.ts", "x"],
    ]);
    const starMap = new Map<string, readonly string[]>([["B.ts", ["C.ts"]]]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    expect(outNodes.map((n) => n.id)).toEqual(["symbol:B.ts#x"]);
    expect(outEdges.map((e) => e.target)).toEqual(["symbol:C.ts#x"]);
    // Belt-and-braces: verify no synth `#default` snuck in.
    expect(outNodes.some((n) => n.id.endsWith("#default"))).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Design §11 T5 — local decl / earlier synth shadows the star
// -----------------------------------------------------------------------

describe("expandStarReexports — T5 shadowing (local wins over star)", () => {
  it("does not re-emit an ownNames symbol even when a starred origin also provides it", () => {
    const nodes = mkNodes([
      ["B.ts", "x"], // local decl on B
      ["C.ts", "x"], // C also has x
    ]);
    const starMap = new Map<string, readonly string[]>([["B.ts", ["C.ts"]]]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    expect(outNodes).toEqual([]);
    expect(outEdges).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// Design §11 T6 — a named re-export synth node also wins over star
// (ownNames is populated by parser-side #177 barrel synth too)
// -----------------------------------------------------------------------

describe("expandStarReexports — T6 named re-export synth wins over star", () => {
  it("treats a pre-existing symbol:B#x (whatever its origin) as ownNames", () => {
    // B#x is imagined to be a #177 named re-export synth node. We do not
    // model its origin edge here — the star expansion only reads ownNames
    // and starMap. What matters: B has x in ownNames, so the star from o2
    // (which also has x) does not trigger a duplicate synth.
    const nodes = mkNodes([
      ["B.ts", "x"], // pre-existing synth from named re-export of o1.x
      ["o1.ts", "x"],
      ["o2.ts", "x"],
    ]);
    const starMap = new Map<string, readonly string[]>([["B.ts", ["o2.ts"]]]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    expect(outNodes).toEqual([]);
    expect(outEdges).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// Design §11 T7 — two star providers for the same name → drop as ambiguous
// -----------------------------------------------------------------------

describe("expandStarReexports — T7 ambiguous star", () => {
  it("drops a name that has two distinct providers (D3)", () => {
    const nodes = mkNodes([
      ["o1.ts", "x"],
      ["o2.ts", "x"],
    ]);
    const starMap = new Map<string, readonly string[]>([["B.ts", ["o1.ts", "o2.ts"]]]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);

    expect(outNodes).toEqual([]);
    expect(outEdges).toEqual([]);
  });

  it("propagates ambiguity up the chain (a barrel whose child is ambiguous is also ambiguous)", () => {
    // TOP -> [B]; B -> [o1, o2]; o1.x, o2.x. B is ambiguous → TOP is
    // ambiguous → nothing emitted for TOP either.
    const nodes = mkNodes([
      ["o1.ts", "x"],
      ["o2.ts", "x"],
    ]);
    const starMap = new Map<string, readonly string[]>([
      ["B.ts", ["o1.ts", "o2.ts"]],
      ["TOP.ts", ["B.ts"]],
    ]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);
    expect(outNodes.some((n) => n.id === "symbol:TOP.ts#x")).toBe(false);
    expect(outEdges.some((e) => e.source === "symbol:TOP.ts#x")).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Design §11 T18 — duplicate-star dedup is the CALLER's contract; test
// that the module works correctly given properly-deduped input.
// -----------------------------------------------------------------------

describe("expandStarReexports — T18 deduped duplicate-star input", () => {
  it("treats [o] (dedup'd from `export * from o` × 2) as one provider", () => {
    const nodes = mkNodes([["o.ts", "x"]]);
    // Two source-level `export * from "./o"` statements collapse to a
    // single ["o.ts"] entry per the caller's contract — verify that
    // resolution succeeds instead of falsely flagging ambiguous.
    const starMap = new Map<string, readonly string[]>([["B.ts", ["o.ts"]]]);
    const { nodes: outNodes } = expandStarReexports(nodes, starMap);
    expect(outNodes.map((n) => n.id)).toEqual(["symbol:B.ts#x"]);
  });
});

// -----------------------------------------------------------------------
// Design §11 T20 — diamond DAG: memoization keeps the walk polynomial
// even when the same substructure is queried through many paths.
// -----------------------------------------------------------------------

describe("expandStarReexports — T20 diamond DAG memoization", () => {
  it("expands correctly at unambiguous levels + drops ambiguous top; N=100 completes fast", () => {
    // Layer 0 (leaf): L holds N local names.
    // Layer 1 (mid): M1, M2 both `export * from L`.
    // Layer 2 (top): T1, T2 both `export * from M1, M2` — each name is
    //                supplied through two distinct providers (M1 and M2)
    //                so the top-level result is `ambiguous` per D3/D4.
    //
    // Without memoization, resolve(L, xi) is re-entered from every leaf
    // reachable through the diamond, and exportedNames(L) is re-walked
    // per barrel. The polynomial-bound assertion below is the memoization
    // pin — an exponential O(2^depth * N) blow-up would either time out
    // or take multiple seconds even for these modest numbers.
    const N = 100;
    const nodes = new Map<string, GraphNode>();
    for (let i = 0; i < N; i++) {
      const [id, node] = makeSymbol("L.ts", `x${i}`);
      nodes.set(id, node);
    }
    const starMap = new Map<string, readonly string[]>([
      ["M1.ts", ["L.ts"]],
      ["M2.ts", ["L.ts"]],
      ["T1.ts", ["M1.ts", "M2.ts"]],
      ["T2.ts", ["M1.ts", "M2.ts"]],
    ]);
    const start = Date.now();
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);
    const elapsed = Date.now() - start;

    // Sanity: this should complete in well under a second on any dev
    // machine even for N=100. Loose bound to avoid CI flakiness while
    // still catching the O(2^k) regression.
    expect(elapsed).toBeLessThan(2000);

    // M1 and M2 each unambiguously provide all N names (single-provider
    // chain: M -> L -> local). Every name emits a synth node per M-barrel.
    const m1Nodes = outNodes.filter((n) => n.filePath === "M1.ts");
    const m2Nodes = outNodes.filter((n) => n.filePath === "M2.ts");
    expect(m1Nodes).toHaveLength(N);
    expect(m2Nodes).toHaveLength(N);
    // Their edges point at the direct provider L (D4 — 1-hop, not the
    // ultimate origin, which is the same thing here since L is the leaf).
    for (const n of m1Nodes) {
      const name = n.id.split("#")[1];
      const edge = outEdges.find((e) => e.source === n.id);
      expect(edge?.target).toBe(`symbol:L.ts#${name}`);
    }

    // T1 and T2: every name is supplied by both M1 and M2 → ambiguous →
    // nothing emitted at the top.
    const t1Nodes = outNodes.filter((n) => n.filePath === "T1.ts");
    const t2Nodes = outNodes.filter((n) => n.filePath === "T2.ts");
    expect(t1Nodes).toHaveLength(0);
    expect(t2Nodes).toHaveLength(0);
  });

  it("multi-level chain with shared submodule terminates and stays polynomial (memoization warm-up)", () => {
    // A repeat-reference pattern with memoization exercise: multiple
    // barrels each `export *` from the same shared leaf; expansion
    // should reuse the exportedNames cache.
    //
    // L holds N names. B1..B10 each `export * from L`. TOP `export * from B1`.
    // TOP -> B1 -> L is a single-provider chain; TOP emits N names,
    // B1..B10 each emit N names (10*N + N synth nodes total).
    const N = 50;
    const K = 10;
    const nodes = new Map<string, GraphNode>();
    for (let i = 0; i < N; i++) {
      const [id, node] = makeSymbol("L.ts", `x${i}`);
      nodes.set(id, node);
    }
    const starEntries: Array<[string, readonly string[]]> = [];
    for (let k = 0; k < K; k++) starEntries.push([`B${k}.ts`, ["L.ts"]]);
    starEntries.push(["TOP.ts", ["B0.ts"]]);
    const starMap = new Map<string, readonly string[]>(starEntries);

    const start = Date.now();
    const { nodes: outNodes } = expandStarReexports(nodes, starMap);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    // K B-barrels + 1 TOP each emit N names.
    expect(outNodes).toHaveLength((K + 1) * N);
  });
});

// -----------------------------------------------------------------------
// Determinism / purity — the properties Phase 2 depends on
// -----------------------------------------------------------------------

describe("expandStarReexports — determinism + purity", () => {
  it("emits nodes/edges in barrel-asc / name-asc order (deterministic)", () => {
    const nodes = mkNodes([
      ["c.ts", "b"],
      ["c.ts", "a"],
      ["c.ts", "c"],
      ["z.ts", "z"],
    ]);
    // Reverse insertion order deliberately — the emit order must NOT
    // reflect Map insertion.
    const starMap = new Map<string, readonly string[]>([
      ["zbarrel.ts", ["z.ts"]],
      ["abarrel.ts", ["c.ts"]],
    ]);
    const { nodes: outNodes } = expandStarReexports(nodes, starMap);
    // abarrel first (alpha), then zbarrel. Within abarrel: a, b, c.
    expect(outNodes.map((n) => n.id)).toEqual([
      "symbol:abarrel.ts#a",
      "symbol:abarrel.ts#b",
      "symbol:abarrel.ts#c",
      "symbol:zbarrel.ts#z",
    ]);
  });

  it("is idempotent — a second call with the same inputs yields identical output", () => {
    const nodes = mkNodes([
      ["o.ts", "x"],
      ["o.ts", "y"],
    ]);
    const starMap = new Map<string, readonly string[]>([["B.ts", ["o.ts"]]]);

    const first = expandStarReexports(nodes, starMap);
    const second = expandStarReexports(nodes, starMap);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  it("does not mutate its `nodes` or `starMap` inputs", () => {
    const nodes = mkNodes([
      ["o.ts", "x"],
      ["o.ts", "y"],
    ]);
    const starMap = new Map<string, readonly string[]>([
      ["A.ts", ["B.ts"]],
      ["B.ts", ["o.ts"]],
    ]);
    const nodesBefore = snapshotNodes(nodes);
    const starBefore = snapshotStar(starMap);

    expandStarReexports(nodes, starMap);

    expect(snapshotNodes(nodes)).toEqual(nodesBefore);
    expect(snapshotStar(starMap)).toEqual(starBefore);
  });

  it("does not emit `#default` even when a chain forwards it via ownNames", () => {
    // If an intermediate barrel has a local `default` (unusual but valid
    // — e.g. a barrel that also happens to `export default …`), the
    // star expansion of a parent should NOT propagate the `default` name
    // to the parent (design §5 excludes `default` from every union step).
    const nodes = mkNodes([
      ["C.ts", "default"],
      ["C.ts", "x"],
    ]);
    const starMap = new Map<string, readonly string[]>([
      ["A.ts", ["B.ts"]],
      ["B.ts", ["C.ts"]],
    ]);
    const { nodes: outNodes } = expandStarReexports(nodes, starMap);
    expect(outNodes.some((n) => n.id.endsWith("#default"))).toBe(false);
    // But `x` still propagates through both hops.
    expect(outNodes.map((n) => n.id).sort()).toEqual(["symbol:A.ts#x", "symbol:B.ts#x"]);
  });

  it("emits nothing for a barrel whose starMap targets have no exportable names", () => {
    // starMap entry points at a file we have zero nodes for. The barrel
    // simply emits nothing rather than crashing.
    const nodes = new Map<string, GraphNode>();
    const starMap = new Map<string, readonly string[]>([["B.ts", ["missing.ts"]]]);
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);
    expect(outNodes).toEqual([]);
    expect(outEdges).toEqual([]);
  });

  it("handles an empty starMap as a no-op", () => {
    const nodes = mkNodes([["a.ts", "x"]]);
    const starMap = new Map<string, readonly string[]>();
    const { nodes: outNodes, edges: outEdges } = expandStarReexports(nodes, starMap);
    expect(outNodes).toEqual([]);
    expect(outEdges).toEqual([]);
  });
});
