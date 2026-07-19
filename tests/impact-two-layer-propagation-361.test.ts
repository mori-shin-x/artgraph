// issue #361 — two-layer propagation (strong/transitive vs weak/
// collect-terminal) + matching predicate. Regression tests for the new
// `ReachState` model in `src/graph/traverse.ts` (`classifyEdgeTraversal`),
// organized by the Step 0-pre investigation axis each closes. The baseline
// (pre-#361, main@f0510b9) behavior these differ from was measured in the
// Step 0-pre scratchpad fixtures (`fixtures.mjs`/`fixtures.test.ts`) and is
// summarized inline per axis below.
import { describe, it, expect } from "vitest";
import { impact } from "../src/graph/traverse.js";
import type { GraphNode, GraphEdge, LockFile } from "../src/types.js";

function node(id: string, kind: GraphNode["kind"], filePath: string, hash = "h"): GraphNode {
  return { id, kind, filePath, contentHash: hash };
}

// ---------------------------------------------------------------------------
// AXIS 3 — forward cascade through `exercises` is closed (issue #300).
// Baseline (pre-#361): impactReqs included REQ-902 (2-hop) / REQ-902+REQ-903
// (3-hop, unbounded). After #361: forward `exercises` is `"terminal"`, so
// the cascade stops at the first exercised node — it is still COLLECTED
// (lands in affectedFiles) but never re-opened.
// ---------------------------------------------------------------------------

describe("AXIS3 (#361): forward cascade through exercises mid-chain is closed", () => {
  it("2-hop: impact(fnA) reaches REQ-901 (its own claim) but NOT REQ-902 (behind REQ-901's incidental exercises of fnB); fnB still lands in affectedFiles", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/a.ts#fnA", node("symbol:src/a.ts#fnA", "symbol", "src/a.ts")],
      ["symbol:src/b.ts#fnB", node("symbol:src/b.ts#fnB", "symbol", "src/b.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/a.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "REQ-901",
        target: "symbol:src/b.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
      {
        source: "symbol:src/b.ts#fnB",
        target: "REQ-902",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const r = impact({ nodes, edges }, ["symbol:src/a.ts#fnA"], {} as LockFile);
    expect(r.impactReqs).toEqual(["REQ-901"]);
    expect(r.impactReqs).not.toContain("REQ-902");
    expect(r.affectedFiles).toContain("src/b.ts");
  });

  it("3-hop: the cascade does not amplify a second hop further either — REQ-903 (behind REQ-902) never even gets a chance, since REQ-902 itself never appears", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["REQ-903", node("REQ-903", "req", "specs/x.md")],
      ["symbol:src/a.ts#fnA", node("symbol:src/a.ts#fnA", "symbol", "src/a.ts")],
      ["symbol:src/b.ts#fnB", node("symbol:src/b.ts#fnB", "symbol", "src/b.ts")],
      ["symbol:src/c.ts#fnC", node("symbol:src/c.ts#fnC", "symbol", "src/c.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/a.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "REQ-901",
        target: "symbol:src/b.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
      {
        source: "symbol:src/b.ts#fnB",
        target: "REQ-902",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "REQ-902",
        target: "symbol:src/c.ts#fnC",
        kind: "exercises",
        provenances: ["coverage"],
      },
      {
        source: "symbol:src/c.ts#fnC",
        target: "REQ-903",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const r = impact({ nodes, edges }, ["symbol:src/a.ts#fnA"], {} as LockFile);
    expect(r.impactReqs).toEqual(["REQ-901"]);
    expect(r.affectedFiles).toContain("src/b.ts");
    expect(r.affectedFiles).not.toContain("src/c.ts");
  });
});

// ---------------------------------------------------------------------------
// AXIS 2 — 2-hub sibling daisy-chain is closed by the matching predicate +
// terminal semantics (issue #322). Baseline (pre-#361): both REQ-A/REQ-B
// leaked via hub1, AND REQ-C (behind hub2, zero relationship to the start
// symbol) leaked one hop further via REQ-B as a bridge; a 5-hub chain leaked
// all 5. After #361: a candidate REQ collected through a restricted hub's
// forward `verifies` needs its OWN `exercises` evidence reaching the BFS
// origin (matching predicate); even a MATCHED REQ is `"terminal"` (weak),
// so it can never bridge back out to another hub either way.
// ---------------------------------------------------------------------------

describe("AXIS2 (#361): 2-hub sibling daisy-chain closed by matching predicate + terminal semantics", () => {
  it("REQ-EV1 (matched: exercises reaches fnStart) is collected; REQ-EV2 (sibling, no exercises at all) is not; hub2's exclusive REQ-C is unreachable since REQ-EV1 is terminal", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-EV1", node("REQ-EV1", "req", "specs/x.md")],
      ["REQ-EV2", node("REQ-EV2", "req", "specs/x.md")],
      ["REQ-C", node("REQ-C", "req", "specs/x.md")],
      [
        "symbol:src/start.ts#fnStart",
        node("symbol:src/start.ts#fnStart", "symbol", "src/start.ts"),
      ],
      ["file:tests/hub1.test.ts", node("file:tests/hub1.test.ts", "test", "tests/hub1.test.ts")],
      ["file:tests/hub2.test.ts", node("file:tests/hub2.test.ts", "test", "tests/hub2.test.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "file:tests/hub1.test.ts",
        target: "symbol:src/start.ts#fnStart",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:tests/hub1.test.ts",
        target: "REQ-EV1",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/hub1.test.ts",
        target: "REQ-EV2",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      // hub2 shares REQ-EV1 (bridge, pre-#361 leak vector) and uniquely
      // verifies REQ-C (pre-#361, this leaked one hop further via REQ-EV1).
      {
        source: "file:tests/hub2.test.ts",
        target: "REQ-EV1",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/hub2.test.ts",
        target: "REQ-C",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      // Matching predicate: REQ-EV1's own exercises evidence reaches the
      // BFS origin (fnStart). REQ-EV2 deliberately has none.
      {
        source: "REQ-EV1",
        target: "symbol:src/start.ts#fnStart",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const r = impact({ nodes, edges }, ["symbol:src/start.ts#fnStart"], {} as LockFile);
    expect(r.impactReqs).toEqual(["REQ-EV1"]);
    expect(r.impactReqs).not.toContain("REQ-EV2");
    expect(r.impactReqs).not.toContain("REQ-C");
    // hub2 itself is never reached — REQ-EV1's terminal reach cannot
    // reverse-walk back out to it.
    expect(r.affectedFiles).not.toContain("tests/hub2.test.ts");
  });

  it("5-hub chain: even when the FIRST bridge REQ matches (exercises reaches fnStart), the chain halts after it — hub1..hub4 and REQ-2..REQ-5 are never reached", () => {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    nodes.set(
      "symbol:src/start.ts#fnStart",
      node("symbol:src/start.ts#fnStart", "symbol", "src/start.ts"),
    );
    nodes.set(
      "file:tests/hub0.test.ts",
      node("file:tests/hub0.test.ts", "test", "tests/hub0.test.ts"),
    );
    edges.push({
      source: "file:tests/hub0.test.ts",
      target: "symbol:src/start.ts#fnStart",
      kind: "imports",
      provenances: ["ts-import"],
    });
    const N = 5;
    for (let i = 1; i <= N; i++) {
      const reqId = `REQ-${i}`;
      nodes.set(reqId, node(reqId, "req", "specs/x.md"));
      const prevHub = `file:tests/hub${i - 1}.test.ts`;
      const nextHub = `file:tests/hub${i}.test.ts`;
      nodes.set(nextHub, node(nextHub, "test", `tests/hub${i}.test.ts`));
      edges.push({ source: prevHub, target: reqId, kind: "verifies", provenances: ["code-tag"] });
      edges.push({ source: nextHub, target: reqId, kind: "verifies", provenances: ["code-tag"] });
    }
    // Only REQ-1 (the first bridge) gets genuine matching evidence — proving
    // the halt is not simply "nothing has evidence so nothing is collected".
    edges.push({
      source: "REQ-1",
      target: "symbol:src/start.ts#fnStart",
      kind: "exercises",
      provenances: ["coverage"],
    });

    const r = impact({ nodes, edges }, ["symbol:src/start.ts#fnStart"], {} as LockFile);
    expect(r.impactReqs).toEqual(["REQ-1"]);
    expect(r.affectedFiles).not.toContain("tests/hub1.test.ts");
  });
});

// ---------------------------------------------------------------------------
// HIGH-2 — multi-origin convergence on a shared evidence-only REQ no longer
// lets one origin reach the OTHER origin's exclusive sibling (issue #322's
// structural root cause). Baseline (pre-#361): both o1 and o2 reached
// REQ-X AND each other's exclusive sibling REQ-SIB1/REQ-SIB2. The matching
// predicate is computed from EACH CALL's own frozen origin set (never from
// `visited`), so REQ-X can legitimately match for BOTH calls (it really is
// exercised from both symbols) while staying terminal either way — it can
// never become either origin's passport into the OTHER origin's hub.
// ---------------------------------------------------------------------------

describe("HIGH-2 (#361): multi-origin convergence no longer leaks a sibling through the shared REQ", () => {
  const nodes = new Map<string, GraphNode>([
    ["REQ-X", node("REQ-X", "req", "specs/x.md")],
    ["REQ-SIB1", node("REQ-SIB1", "req", "specs/x.md")],
    ["REQ-SIB2", node("REQ-SIB2", "req", "specs/x.md")],
    ["symbol:src/o1.ts#fnO1", node("symbol:src/o1.ts#fnO1", "symbol", "src/o1.ts")],
    ["symbol:src/o2.ts#fnO2", node("symbol:src/o2.ts#fnO2", "symbol", "src/o2.ts")],
    ["file:tests/hubA.test.ts", node("file:tests/hubA.test.ts", "test", "tests/hubA.test.ts")],
    ["file:tests/hubB.test.ts", node("file:tests/hubB.test.ts", "test", "tests/hubB.test.ts")],
  ]);
  const edges: GraphEdge[] = [
    {
      source: "file:tests/hubA.test.ts",
      target: "symbol:src/o1.ts#fnO1",
      kind: "imports",
      provenances: ["ts-import"],
    },
    {
      source: "file:tests/hubB.test.ts",
      target: "symbol:src/o2.ts#fnO2",
      kind: "imports",
      provenances: ["ts-import"],
    },
    {
      source: "file:tests/hubA.test.ts",
      target: "REQ-X",
      kind: "verifies",
      provenances: ["code-tag"],
    },
    {
      source: "file:tests/hubB.test.ts",
      target: "REQ-X",
      kind: "verifies",
      provenances: ["code-tag"],
    },
    {
      source: "file:tests/hubA.test.ts",
      target: "REQ-SIB1",
      kind: "verifies",
      provenances: ["code-tag"],
    },
    {
      source: "file:tests/hubB.test.ts",
      target: "REQ-SIB2",
      kind: "verifies",
      provenances: ["code-tag"],
    },
    // REQ-X is genuinely exercised by BOTH origins (a real, shared
    // infrastructure REQ) — matches for both calls independently.
    {
      source: "REQ-X",
      target: "symbol:src/o1.ts#fnO1",
      kind: "exercises",
      provenances: ["coverage"],
    },
    {
      source: "REQ-X",
      target: "symbol:src/o2.ts#fnO2",
      kind: "exercises",
      provenances: ["coverage"],
    },
    // Each sibling matches ONLY its own hub's origin.
    {
      source: "REQ-SIB1",
      target: "symbol:src/o1.ts#fnO1",
      kind: "exercises",
      provenances: ["coverage"],
    },
    {
      source: "REQ-SIB2",
      target: "symbol:src/o2.ts#fnO2",
      kind: "exercises",
      provenances: ["coverage"],
    },
  ];

  it("o1 reaches REQ-X and its own REQ-SIB1, but NOT o2's exclusive REQ-SIB2", () => {
    const r1 = impact({ nodes, edges }, ["symbol:src/o1.ts#fnO1"], {} as LockFile);
    expect(r1.impactReqs.sort()).toEqual(["REQ-SIB1", "REQ-X"]);
    expect(r1.impactReqs).not.toContain("REQ-SIB2");
  });

  it("o2 reaches REQ-X and its own REQ-SIB2, but NOT o1's exclusive REQ-SIB1 (symmetric)", () => {
    const r2 = impact({ nodes, edges }, ["symbol:src/o2.ts#fnO2"], {} as LockFile);
    expect(r2.impactReqs.sort()).toEqual(["REQ-SIB2", "REQ-X"]);
    expect(r2.impactReqs).not.toContain("REQ-SIB1");
  });
});

// ---------------------------------------------------------------------------
// AXIS 4 — inline-link `depends_on`/`derives_from` is now weak/terminal
// (issue #254). Baseline (pre-#361): a 10-doc inline-link chain reached all
// 10 docs, and a hub with ONE inline-link edge fanned out to 61 docs
// (59-sibling reproduction). After #361: an inline-link-ONLY edge collects
// its target but does not re-open it — 1-hop collection, chain/fan-out
// halted at the first hop. An edge carrying an EXPLICIT declaration
// provenance (`frontmatter`) stays fully transitive, unchanged; a MIXED
// edge (both `frontmatter` and `inline-link`, as `dedupEdges` can merge onto
// one physical edge) is still strong.
// ---------------------------------------------------------------------------

describe("AXIS4 (#361): inline-link depends_on/derives_from is weak/terminal; explicit-declaration provenance stays strong", () => {
  it("a 10-doc inline-link chain collects only doc1 (start) + doc2 (1-hop) — the chain halts there", () => {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const N = 10;
    for (let i = 1; i <= N; i++)
      nodes.set(`doc:specs/d${i}.md`, node(`doc:specs/d${i}.md`, "doc", `specs/d${i}.md`));
    for (let i = 1; i < N; i++) {
      edges.push({
        source: `doc:specs/d${i}.md`,
        target: `doc:specs/d${i + 1}.md`,
        kind: "depends_on",
        provenances: ["inline-link"],
      });
    }
    const r = impact({ nodes, edges }, ["doc:specs/d1.md"], {} as LockFile);
    expect(r.affectedDocs.sort()).toEqual(["doc:specs/d1.md", "doc:specs/d2.md"]);
    expect(r.affectedDocs.length).toBe(2);
  });

  it("the 59-doc fan-out reproduction is resolved: only hub + linked are collected, not the 59 siblings behind linked.md", () => {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    nodes.set("doc:specs/hub.md", node("doc:specs/hub.md", "doc", "specs/hub.md"));
    nodes.set("doc:specs/linked.md", node("doc:specs/linked.md", "doc", "specs/linked.md"));
    edges.push({
      source: "doc:specs/hub.md",
      target: "doc:specs/linked.md",
      kind: "depends_on",
      provenances: ["inline-link"],
    });
    const N = 59;
    for (let i = 1; i <= N; i++) {
      const id = `doc:specs/sibling${i}.md`;
      nodes.set(id, node(id, "doc", `specs/sibling${i}.md`));
      edges.push({
        source: "doc:specs/linked.md",
        target: id,
        kind: "depends_on",
        provenances: ["inline-link"],
      });
    }
    const r = impact({ nodes, edges }, ["doc:specs/hub.md"], {} as LockFile);
    expect(r.affectedDocs.sort()).toEqual(["doc:specs/hub.md", "doc:specs/linked.md"]);
    expect(r.affectedDocs.length).toBe(2);
  });

  it("a frontmatter-only depends_on chain of the same shape stays fully transitive (unchanged)", () => {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const N = 10;
    for (let i = 1; i <= N; i++)
      nodes.set(`doc:specs/d${i}.md`, node(`doc:specs/d${i}.md`, "doc", `specs/d${i}.md`));
    for (let i = 1; i < N; i++) {
      edges.push({
        source: `doc:specs/d${i}.md`,
        target: `doc:specs/d${i + 1}.md`,
        kind: "depends_on",
        provenances: ["frontmatter"],
      });
    }
    const r = impact({ nodes, edges }, ["doc:specs/d1.md"], {} as LockFile);
    expect(r.affectedDocs.length).toBe(N);
  });

  it("an edge carrying BOTH frontmatter and inline-link provenance (dedupEdges' merge case) stays strong/transitive", () => {
    const nodes = new Map<string, GraphNode>([
      ["doc:specs/a.md", node("doc:specs/a.md", "doc", "specs/a.md")],
      ["doc:specs/b.md", node("doc:specs/b.md", "doc", "specs/b.md")],
      ["doc:specs/c.md", node("doc:specs/c.md", "doc", "specs/c.md")],
    ]);
    const edges: GraphEdge[] = [
      // Simulates dedupEdges' union of provenances on one physical edge: an
      // explicit frontmatter declaration that also happens to be phrased as
      // an inline markdown link in the doc body.
      {
        source: "doc:specs/a.md",
        target: "doc:specs/b.md",
        kind: "depends_on",
        provenances: ["frontmatter", "inline-link"],
      },
      {
        source: "doc:specs/b.md",
        target: "doc:specs/c.md",
        kind: "depends_on",
        provenances: ["frontmatter", "inline-link"],
      },
    ];
    const r = impact({ nodes, edges }, ["doc:specs/a.md"], {} as LockFile);
    expect(r.affectedDocs.sort()).toEqual(["doc:specs/a.md", "doc:specs/b.md", "doc:specs/c.md"]);
  });
});

// ---------------------------------------------------------------------------
// terminal -> expandable upgrade — a node reached weakly first and strongly
// later is fully re-expanded, exactly once (no double counting).
// ---------------------------------------------------------------------------

describe("terminal -> expandable upgrade (#361): a weak-then-strong reach re-expands fully, with no double counting", () => {
  it("doc B, first collected terminal via A's inline-link, is upgraded to expandable once C's strong frontmatter edge reaches it too — B's own downstream doc D becomes reachable only because of the upgrade", () => {
    const nodes = new Map<string, GraphNode>([
      ["doc:specs/a.md", node("doc:specs/a.md", "doc", "specs/a.md")],
      ["doc:specs/b.md", node("doc:specs/b.md", "doc", "specs/b.md")],
      ["doc:specs/c.md", node("doc:specs/c.md", "doc", "specs/c.md")],
      ["doc:specs/d.md", node("doc:specs/d.md", "doc", "specs/d.md")],
    ]);
    const edges: GraphEdge[] = [
      // A's weak edge to B is processed first (array order) — B lands in
      // `visited` as "terminal" immediately, never queued.
      {
        source: "doc:specs/a.md",
        target: "doc:specs/b.md",
        kind: "depends_on",
        provenances: ["inline-link"],
      },
      // A's strong edge to C queues C for full expansion.
      {
        source: "doc:specs/a.md",
        target: "doc:specs/c.md",
        kind: "depends_on",
        provenances: ["frontmatter"],
      },
      // When C is dequeued and expanded, its strong edge to B upgrades B
      // from "terminal" to "expandable" and re-queues it.
      {
        source: "doc:specs/c.md",
        target: "doc:specs/b.md",
        kind: "depends_on",
        provenances: ["frontmatter"],
      },
      // B's own forward edge to D is only ever explored if B gets the
      // upgrade above (a purely-terminal B is never dequeued at all).
      {
        source: "doc:specs/b.md",
        target: "doc:specs/d.md",
        kind: "depends_on",
        provenances: ["frontmatter"],
      },
    ];
    const r = impact({ nodes, edges }, ["doc:specs/a.md"], {} as LockFile);
    expect(r.affectedDocs.sort()).toEqual([
      "doc:specs/a.md",
      "doc:specs/b.md",
      "doc:specs/c.md",
      "doc:specs/d.md",
    ]);
    // No double counting: exactly 4 distinct docs, each exactly once (a Set
    // under the hood, but the length assertion makes the "no dupes" claim
    // explicit and would catch a hypothetical array-based regression too).
    expect(r.affectedDocs.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Gate reachability — an evidence-only REQ that matches the predicate stays
// in `check --diff --gate`'s scope, INCLUDING when only the BASELINE side of
// the current∪baseline union reaches it (mirrors `src/commands/check.ts`'s
// `buildScope`: `[...sids, ...impactReqs, ...affectedDocs,
// ...affectedFiles.map(f => "file:" + f)]`, unioned across the current and
// baseline graphs). See tests/check-scope-test-hub-303.test.ts for the
// equivalent guarantee proven end-to-end through the real CLI (current-side
// reach); this test isolates the BASELINE-side half of the union at the
// `impact()` unit level.
// ---------------------------------------------------------------------------

describe("gate reachability (#361): evidence-only REQ survives current∪baseline scope union via the baseline side alone", () => {
  function buildScope(
    graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] },
    startIds: string[],
  ): Set<string> {
    const r = impact(graph, startIds, {} as LockFile);
    return new Set<string>([
      ...startIds,
      ...r.impactReqs,
      ...r.affectedDocs,
      ...r.affectedFiles.map((f) => `file:${f}`),
    ]);
  }

  it("REQ-902 is dropped from the CURRENT graph's own scope (evidence lost this run) but survives the union because the BASELINE graph still matches it", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
      ["file:tests/hub.test.ts", node("file:tests/hub.test.ts", "test", "tests/hub.test.ts")],
    ]);
    const hubEdges: GraphEdge[] = [
      {
        source: "file:tests/hub.test.ts",
        target: "symbol:src/sample.ts#fnB",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:tests/hub.test.ts",
        target: "REQ-902",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const currentGraph = { nodes, edges: [...hubEdges] }; // no exercises edge: matching predicate fails
    const baselineGraph = {
      nodes,
      edges: [
        ...hubEdges,
        {
          source: "REQ-902",
          target: "symbol:src/sample.ts#fnB",
          kind: "exercises" as const,
          provenances: ["coverage"] as const,
        },
      ],
    };
    const startIds = ["symbol:src/sample.ts#fnB"];

    const currentScope = buildScope(currentGraph, startIds);
    const baselineScope = buildScope(baselineGraph, startIds);
    expect(currentScope.has("REQ-902")).toBe(false);
    expect(baselineScope.has("REQ-902")).toBe(true);

    const union = new Set([...currentScope, ...baselineScope]);
    expect(union.has("REQ-902")).toBe(true);
  });
});
