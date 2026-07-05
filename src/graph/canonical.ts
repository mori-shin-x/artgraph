import type { EdgeProvenance, GraphEdge, GraphNode } from "../types.js";

// Canonicalization vocabulary for the byte-stable lock (issue #164).
//
// This module is the single owner of the dedup/union/sort invariants that
// keep `.trace.lock` byte-identical across runs and OSes (INV-L4, INV-O1
// family). builder.ts, lock.ts and rename-lock.ts import from here instead of
// mirroring each other's idioms. Issue #163's future `finalizeDeterministic`
// pass is expected to call these helpers directly.

// PR#94 review B3: use `<`/`>` rather than `localeCompare` so the order is
// fixed UTF-16 codeunit comparison — locale-independent, byte-identical
// across Windows/macOS/Linux. `localeCompare` is forbidden anywhere the
// result feeds the lock: it varies with ICU data and OS locale, which breaks
// INV-L4 (lock byte-identity).
export function codeunitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Sorted set-union of provenances (INV-T2/T3: provenances are unique and
// sorted ascending). Also serves as defence-in-depth at serialization
// boundaries (PR#94 review C3): callers apply it even to already-canonical
// input so a future code-path that forgets to dedup cannot break INV-L2.
export function sortUniqueProvenances(provs: Iterable<EdgeProvenance>): EdgeProvenance[] {
  return [...new Set(provs)].sort(codeunitCompare);
}

// Lock schema v2 `dependsOn` element (issue #35). Shared by lock.ts and
// rename-lock.ts so both operate on the exact shape unionDeps canonicalizes.
export type DepRef = { id: string; provenances: EdgeProvenance[] };

function sortDeps(deps: DepRef[]): DepRef[] {
  return [...deps].sort((a, b) => codeunitCompare(a.id, b.id));
}

// Union dependsOn entries by `id`: collapse duplicates, set-union their
// `provenances`, and emit a single sorted array. This is the lock-level twin
// of `dedupEdges` below — the same id-based union that keeps the lock shape
// aligned with the graph-level invariants. Used by `buildLockFromGraph`
// (lock.ts) when the same target appears under both `depends_on` and
// `derives_from` (PR#94 review C4), and by rename-lock.ts so
// `scan → rename → scan` is shape-stable.
export function unionDeps(deps: DepRef[]): DepRef[] {
  const byId = new Map<string, Set<EdgeProvenance>>();
  for (const d of deps) {
    let provs = byId.get(d.id);
    if (!provs) {
      provs = new Set();
      byId.set(d.id, provs);
    }
    for (const p of d.provenances) provs.add(p);
  }
  const result: DepRef[] = [];
  for (const [id, provs] of byId) {
    result.push({ id, provenances: sortUniqueProvenances(provs) });
  }
  return sortDeps(result);
}

// Narrower replacement for the previous `as unknown as` cast: keeps the
// NonEmpty invariant visible at the type level and asserts it at runtime
// (defense-in-depth for B3/C2 from PR#94 review). A violation means the
// upstream parser handed us an edge with zero provenances — that is a bug
// in the caller, not user input, so we throw rather than swallow.
function assertNonEmpty(
  arr: readonly EdgeProvenance[],
  edge: GraphEdge,
): [EdgeProvenance, ...EdgeProvenance[]] {
  if (arr.length === 0) {
    throw new Error(
      `buildGraph: NonEmpty invariant violation — edge has empty provenances: ${JSON.stringify(edge)}`,
    );
  }
  return arr as [EdgeProvenance, ...EdgeProvenance[]];
}

// T037 / Issue #35: Edge deduplication. Same (source, target, kind) is
// collapsed into one edge whose `provenances` is the sorted set-union of all
// contributing edges. Iteration is stable on the input `edges` array so the
// kept edge always comes from the first occurrence (INV-T3 — final order is
// determined by the post-dedup sort below, not by which path inserted first
// nor by globSync/ts-morph traversal order).
//
// PR#94 review B3: the post-dedup sort makes edge order deterministic across
// OSes. Without it the result reflects Map insertion order, which traces back
// to globSync / ts-morph / per-directory Map iteration in builder.ts (its
// `inferConventionEdges` intentionally emits in insertion order and relies on
// this sort absorbing it — see the Meta-C note there). Sorting by the dedup
// key with `codeunitCompare` (never `localeCompare`) is load-bearing for
// INV-L4 (lock byte-identity) and the INV-O1 family.
export function dedupEdges(edges: GraphEdge[]): GraphEdge[] {
  const edgeKey = (e: GraphEdge) => `${e.source}|${e.target}|${e.kind}`;
  const dedupMap = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    const existing = dedupMap.get(key);
    if (!existing) {
      // Defensive copy with sorted provenances so even a single-source edge
      // satisfies INV-T2/T3.
      const sorted = sortUniqueProvenances(edge.provenances);
      dedupMap.set(key, { ...edge, provenances: assertNonEmpty(sorted, edge) });
    } else {
      const merged = sortUniqueProvenances([...existing.provenances, ...edge.provenances]);
      existing.provenances = assertNonEmpty(merged, edge);
    }
  }
  const dedupedEdges = Array.from(dedupMap.values());
  dedupedEdges.sort((a, b) => codeunitCompare(edgeKey(a), edgeKey(b)));
  return dedupedEdges;
}

// PR#94 review B3: sort the `nodes` Map by id ascending too. Map iteration
// is insertion-order, which traces back to file traversal — fine for
// single-OS runs but observably divergent cross-OS (and exposed downstream
// via `for (const [id, node] of graph.nodes)` in lock.ts / format.ts).
// Rebuilding the Map with sorted entries is the minimal surface change.
export function sortNodesById(nodes: Map<string, GraphNode>): Map<string, GraphNode> {
  return new Map([...nodes.entries()].sort(([a], [b]) => codeunitCompare(a, b)));
}
