// issue #303 — Option 2B (PR #299) closed the reverse-`exercises` leak but
// left a residual mechanism open: `verifies` and `imports` are still
// unconditionally bidirectional, and a TEST node is a natural pass-through
// hub for both (one test file `verifies` several sibling REQs and `imports`
// several sibling src symbols). A symbol-start BFS that reverse-walks INTO a
// test hub for one REQ's sake and then forward-walks back OUT of that SAME
// hub picks up unrelated sibling REQs — see traverse.ts's file-header
// comment (issue #303 section) for the full rationale and the two repro
// paths pinned below as AC1.
//
// Hand-built `ArtifactGraph`s + direct `impact()` calls, mirroring
// tests/impact-evidence.test.ts's (d)-(f) style — tight control over BFS
// reachability without touching tests/traverse.test.ts itself (its existing
// spec 019/#215/#286 pins must stay green, unedited; verified separately by
// the full `pnpm test` run).
import { describe, it, expect } from "vitest";
import { impact } from "../src/graph/traverse.js";
import type { GraphNode, GraphEdge, LockFile } from "../src/types.js";

function node(id: string, kind: GraphNode["kind"], filePath: string, hash = "h"): GraphNode {
  return { id, kind, filePath, contentHash: hash };
}

// ---------------------------------------------------------------------------
// AC1 — the issue's own repro, both variants (verifies-only / imports-based).
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (AC1): symbol:fnB must not leak sibling REQ-901 through the shared test hub", () => {
  it("path 1 (fwd implements -> REQ-902 -> rev verifies -> test -> fwd verifies -> REQ-901): REQ-901 excluded", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnA", node("symbol:src/sample.ts#fnA", "symbol", "src/sample.ts")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
      [
        "file:tests/sample.test.ts",
        node("file:tests/sample.test.ts", "test", "tests/sample.test.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/sample.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/sample.ts#fnB",
        target: "REQ-902",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-901",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-902",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-902"]);
    expect(result.impactReqs).not.toContain("REQ-901");
  });

  it("path 2 (rev imports -> test -> fwd verifies -> REQ-901, a BARE import declaration hubs the test): REQ-901 excluded", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnA", node("symbol:src/sample.ts#fnA", "symbol", "src/sample.ts")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
      [
        "file:tests/sample.test.ts",
        node("file:tests/sample.test.ts", "test", "tests/sample.test.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/sample.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      // NOTE: no fnB -> REQ-902 implements edge here — the ONLY route to
      // fnB from the test is a bare `import { fnA, fnB } from "../src/sample"`
      // declaration, no assertion at all.
      {
        source: "file:tests/sample.test.ts",
        target: "symbol:src/sample.ts#fnB",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-901",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).not.toContain("REQ-901");
    expect(result.affectedFiles).toContain("tests/sample.test.ts");
  });
});

// ---------------------------------------------------------------------------
// AC2 — regression pin: impact(["REQ-901"]) must still reach the test node
// that verifies it (forward reachability from the REQ side is untouched).
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (AC2 regression): impact(REQ-901) still forward-reaches its own verifying test", () => {
  it("REQ-901 -> (forward) test node stays reachable (embedder contract)", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnA", node("symbol:src/sample.ts#fnA", "symbol", "src/sample.ts")],
      [
        "file:tests/sample.test.ts",
        node("file:tests/sample.test.ts", "test", "tests/sample.test.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/sample.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-901",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["REQ-901"], {} as LockFile);
    expect(result.affectedFiles).toContain("tests/sample.test.ts");
  });
});

// ---------------------------------------------------------------------------
// HIGH-1 (most important) — an evidence-only REQ (NO implements edge
// anywhere) sharing the SAME test hub with a declared REQ must stay
// reachable via the hub's forward verifies, while the declared sibling is
// blocked. Losing this would repeat the #286 gate-false-green regression
// Option 2B fixed for reverse `exercises`.
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (HIGH-1): evidence-only REQ stays reachable through the hub; its declared sibling is blocked", () => {
  it("symbol -> rev imports -> test hub -> fwd verifies reaches REQ-EV (no @impl anywhere) but NOT REQ-IMPL (@impl on a different symbol)", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-EV", node("REQ-EV", "req", "specs/x.md")],
      ["REQ-IMPL", node("REQ-IMPL", "req", "specs/x.md")],
      ["symbol:src/x.ts#fnOwn", node("symbol:src/x.ts#fnOwn", "symbol", "src/x.ts")],
      ["symbol:src/x.ts#fnStart", node("symbol:src/x.ts#fnStart", "symbol", "src/x.ts")],
      ["file:tests/x.test.ts", node("file:tests/x.test.ts", "test", "tests/x.test.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/x.ts#fnOwn",
        target: "REQ-IMPL",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/x.test.ts",
        target: "symbol:src/x.ts#fnStart",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:tests/x.test.ts",
        target: "REQ-EV",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/x.test.ts",
        target: "REQ-IMPL",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/x.ts#fnStart"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-EV"]);
    expect(result.impactReqs).not.toContain("REQ-IMPL");
  });
});

// ---------------------------------------------------------------------------
// HIGH-2 — non-test consumer nodes stay fully unrestricted in reverse
// `imports` (the direction constraint only ever applies to `kind === "test"`
// hubs). tests/traverse.test.ts:692 (AS1-3) and :1009 ((c) class-method
// fixture) already pin this and must stay green — this is an explicit #303
// regression pin making the intent visible alongside the new restriction.
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (HIGH-2): reverse imports into a NON-test consumer stays fully unrestricted", () => {
  it("consumer (kind=symbol, not test) forward-imports a sibling after reverse-importing the changed symbol — sibling REQ still reached", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-SIB", node("REQ-SIB", "req", "specs/x.md")],
      [
        "symbol:src/target.ts#targetFn",
        node("symbol:src/target.ts#targetFn", "symbol", "src/target.ts"),
      ],
      [
        "symbol:src/consumer.ts#useThing",
        node("symbol:src/consumer.ts#useThing", "symbol", "src/consumer.ts"),
      ],
      [
        "symbol:src/sibling.ts#fnSib",
        node("symbol:src/sibling.ts#fnSib", "symbol", "src/sibling.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/consumer.ts#useThing",
        target: "symbol:src/target.ts#targetFn",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "symbol:src/consumer.ts#useThing",
        target: "symbol:src/sibling.ts#fnSib",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "symbol:src/sibling.ts#fnSib",
        target: "REQ-SIB",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/target.ts#targetFn"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-SIB"]);
    expect(result.affectedFiles).toContain("src/sibling.ts");
  });
});

// ---------------------------------------------------------------------------
// start = test file itself — a test node used directly as a startId is NOT
// restricted: both its forward `verifies` and forward `imports` stay
// unconditional, exactly like pre-#303 behavior.
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (start = test file itself): no restriction applies", () => {
  it("test file as startId reaches a declared sibling REQ (verifies) and an imported sibling file (imports), both unconditionally", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-Y", node("REQ-Y", "req", "specs/x.md")],
      ["symbol:src/owner.ts#fnOwn", node("symbol:src/owner.ts#fnOwn", "symbol", "src/owner.ts")],
      ["symbol:src/sib.ts#fnSib", node("symbol:src/sib.ts#fnSib", "symbol", "src/sib.ts")],
      [
        "file:tests/direct.test.ts",
        node("file:tests/direct.test.ts", "test", "tests/direct.test.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/owner.ts#fnOwn",
        target: "REQ-Y",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/direct.test.ts",
        target: "REQ-Y",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/direct.test.ts",
        target: "symbol:src/sib.ts#fnSib",
        kind: "imports",
        provenances: ["ts-import"],
      },
    ];
    const result = impact({ nodes, edges }, ["file:tests/direct.test.ts"], {} as LockFile);
    // REQ-Y HAS an implements edge elsewhere (fnOwn) — a restricted hub
    // would block this forward verifies, but the test file IS the startId
    // here, so it's never restricted.
    expect(result.impactReqs).toContain("REQ-Y");
    expect(result.affectedFiles).toContain("src/sib.ts");
  });
});

// ---------------------------------------------------------------------------
// 2-state visited — a node first reached `"restricted"` can be UPGRADED by a
// later `"unrestricted"` arrival within the SAME impact() call, and gets
// fully re-expanded (an edge blocked under the restricted visit becomes
// reachable after the upgrade).
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (2-state visited): a restricted test-hub visit is upgraded and re-expanded by a later unrestricted arrival", () => {
  it("REQ-904 (behind the hub's forward verifies, blocked under the restricted-only visit) becomes reachable once the hub is upgraded via a second, unrestricted path", () => {
    // Topology (see traverse.ts's BFS — this exploits the queue's FIFO
    // order, which the implementation guarantees for a fixed edges array):
    //   fnB -[1]implements-> REQ-902        (fnB's own claim)
    //   fnB -[2]imports-> fnC               (forward, ordinary)
    //   test -[3]verifies-> REQ-902         (reverse from REQ-902 hits the
    //                                         hub FIRST, at depth 2, RESTRICTED)
    //   fnC -[4]depends_on-> test           (forward from fnC hits the SAME
    //                                         hub SECOND, also at depth 2,
    //                                         UNRESTRICTED — a synthetic,
    //                                         non-verifies/imports edge used
    //                                         purely to give the hub a second
    //                                         arrival path)
    //   test -[5]verifies-> REQ-904         (blocked while restricted: REQ-904
    //                                         has an @impl elsewhere, so this
    //                                         is the #303 leak-class edge —
    //                                         only reachable AFTER upgrade)
    //   fnD -[6]implements-> REQ-904        (REQ-904's own claim, elsewhere)
    const nodes = new Map<string, GraphNode>([
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["REQ-904", node("REQ-904", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
      ["symbol:src/sample.ts#fnC", node("symbol:src/sample.ts#fnC", "symbol", "src/sample.ts")],
      ["symbol:src/other.ts#fnD", node("symbol:src/other.ts#fnD", "symbol", "src/other.ts")],
      [
        "file:tests/sample.test.ts",
        node("file:tests/sample.test.ts", "test", "tests/sample.test.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/sample.ts#fnB",
        target: "REQ-902",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/sample.ts#fnB",
        target: "symbol:src/sample.ts#fnC",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-902",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/sample.ts#fnC",
        target: "file:tests/sample.test.ts",
        kind: "depends_on",
        provenances: ["structural"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-904",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/other.ts#fnD",
        target: "REQ-904",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs.sort()).toEqual(["REQ-902", "REQ-904"]);
    expect(result.affectedFiles).toContain("src/other.ts");
  });
});

// ---------------------------------------------------------------------------
// rule (b) pin — reverse imports INTO a test, then forward imports back OUT
// of that SAME test into a sibling src file, must not reach the sibling's
// REQ. This is the 4th leak mechanism the issue calls out (a bare import
// declaration, no verifies/assertion involved anywhere).
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (rule (b) pin): forward imports out of a restricted test hub never followed", () => {
  it("symbol:fnA -> rev imports -> test -> fwd imports -> symbol:fnB (sibling file) -> REQ-B is blocked", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-B", node("REQ-B", "req", "specs/x.md")],
      ["symbol:src/a.ts#fnA", node("symbol:src/a.ts#fnA", "symbol", "src/a.ts")],
      ["symbol:src/b.ts#fnB", node("symbol:src/b.ts#fnB", "symbol", "src/b.ts")],
      ["file:tests/hub.test.ts", node("file:tests/hub.test.ts", "test", "tests/hub.test.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "file:tests/hub.test.ts",
        target: "symbol:src/a.ts#fnA",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:tests/hub.test.ts",
        target: "symbol:src/b.ts#fnB",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "symbol:src/b.ts#fnB",
        target: "REQ-B",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/a.ts#fnA"], {} as LockFile);
    expect(result.impactReqs).toEqual([]);
    expect(result.affectedFiles).not.toContain("src/b.ts");
  });
});

// ---------------------------------------------------------------------------
// MEDIUM-2 — reqProvenance: a blocked sibling REQ never appears in
// `reqProvenance` at all (it's never visited); a reached REQ keeps its
// static/evidence classification unaffected by the new restriction.
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (MEDIUM-2): reqProvenance excludes the blocked sibling, keeps the reached REQ's classification", () => {
  it("REQ-902 (reached) carries both static + evidence provenance; REQ-901 (blocked) has no entry at all", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnA", node("symbol:src/sample.ts#fnA", "symbol", "src/sample.ts")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
      [
        "file:tests/sample.test.ts",
        node("file:tests/sample.test.ts", "test", "tests/sample.test.ts"),
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/sample.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/sample.ts#fnB",
        target: "REQ-902",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-901",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/sample.test.ts",
        target: "REQ-902",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      // A coverage-derived exercises edge so `graphHasExercisesEdges` gates
      // reqProvenance ON at all (FR-010 byte-identical requirement).
      {
        source: "REQ-902",
        target: "symbol:src/sample.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-902"]);

    const byReq: Record<string, string[]> = {};
    for (const p of result.reqProvenance ?? []) byReq[p.reqId] = p.provenance;
    expect(byReq["REQ-901"]).toBeUndefined();
    expect(byReq["REQ-902"]?.sort()).toEqual(["evidence", "static"]);
  });
});

// ---------------------------------------------------------------------------
// Known limitation (issue #322) pin — the HIGH-1 shape above proved a
// declared REQ is blocked while an evidence-only REQ stays reachable through
// a shared restricted hub. This block pins the residual gap left OPEN on
// purpose: rule (a)'s evidence-only exemption (traverse.ts) is a per-EDGE
// predicate, not a per-hub one, so when the SAME hub is `verifies`-incident
// to MORE THAN ONE evidence-only REQ, a BFS that legitimately needs one of
// them still leaks its evidence-only SIBLING(s) too — even a sibling with
// zero relationship to the start symbol. This is accepted/documented, not
// fixed, by PR #321/#303 — see traverse.ts's file-header "Known residual
// limitation" note and rule (a)'s comment. If this assertion ever starts
// failing (REQ-EV2 no longer appears), it means issue #322 landed a fix and
// this pin should be revisited/removed, not "repaired" back to green.
// ---------------------------------------------------------------------------

describe("impact-test-hub-303 (known limitation, issue #322 pin): sibling evidence-only REQs both leak through one shared hub", () => {
  it("two evidence-only REQs (no @impl anywhere) verified by the SAME test hub: both land in impactReqs even though the start symbol has zero relationship to REQ-EV2", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-EV1", node("REQ-EV1", "req", "specs/x.md")],
      ["REQ-EV2", node("REQ-EV2", "req", "specs/x.md")],
      ["symbol:src/y.ts#fnStart", node("symbol:src/y.ts#fnStart", "symbol", "src/y.ts")],
      ["file:tests/y.test.ts", node("file:tests/y.test.ts", "test", "tests/y.test.ts")],
    ]);
    const edges: GraphEdge[] = [
      // The ONLY route from fnStart to the hub is a bare import declaration —
      // fnStart has no `implements` edge to either REQ-EV1 or REQ-EV2, and no
      // relationship to REQ-EV2 at all beyond sharing this hub.
      {
        source: "file:tests/y.test.ts",
        target: "symbol:src/y.ts#fnStart",
        kind: "imports",
        provenances: ["ts-import"],
      },
      // Neither REQ has an `implements` edge anywhere in this graph — both
      // are evidence-only, so rule (a) leaves the hub's forward `verifies`
      // OPEN for both, per-edge.
      {
        source: "file:tests/y.test.ts",
        target: "REQ-EV1",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/y.test.ts",
        target: "REQ-EV2",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/y.ts#fnStart"], {} as LockFile);
    // Accepted current behavior (NOT the desired end state): both evidence-only
    // REQs leak through, including the one (REQ-EV2) unrelated to fnStart.
    expect(result.impactReqs.sort()).toEqual(["REQ-EV1", "REQ-EV2"]);
  });
});
