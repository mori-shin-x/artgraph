// issue #361 Step 9 retro (HIGH-3) — `src/graph/traverse.ts`'s
// `classifyEdgeTraversal` (`contains` case, R1) and `src/trace/report.ts`'s
// `reqExercises()` are two INDEPENDENT implementations of the same
// "containment only flows one way" invariant: `contains` (doc -> req|task,
// or class -> method per spec 021) is forward-only for BFS reachability
// (issue #215, spec 019 FR-001〜003), and `reqExercises`'s evidence roll-up
// only walks DOWN via `containsIndex` (a claim on a CONTAINER is
// corroborated by a CONTAINED node's evidence, never the reverse). Nothing
// in the type system enforces these two implementations agree — this test
// pins that they do, on one shared fixture, so a future change to either
// side that silently breaks the pairing fails loudly here instead of via a
// harder-to-diagnose downstream symptom. See the cross-reference comments on
// both functions for the other side of this pin.
import { describe, it, expect } from "vitest";
import { impact } from "../src/graph/traverse.js";
import { classifyEvidence } from "../src/trace/report.js";
import type { GraphNode, GraphEdge, LockFile } from "../src/types.js";
import type { IngestedTrace } from "../src/trace/ingest.js";

function node(id: string, kind: GraphNode["kind"], filePath: string, hash = "h"): GraphNode {
  return { id, kind, filePath, contentHash: hash };
}

describe("HIGH-3 pin: traverse.ts's `contains` R1 and report.ts's `reqExercises` agree on forward-only direction", () => {
  const nodes = new Map<string, GraphNode>([
    ["symbol:src/parent.ts#Parent", node("symbol:src/parent.ts#Parent", "symbol", "src/parent.ts")],
    ["symbol:src/child.ts#Child", node("symbol:src/child.ts#Child", "symbol", "src/child.ts")],
  ]);
  const containsEdge: GraphEdge = {
    source: "symbol:src/parent.ts#Parent",
    target: "symbol:src/child.ts#Child",
    kind: "contains",
    provenances: ["structural"],
  };

  it("traverse.ts: forward contains reaches the child; reverse contains does not reach the parent", () => {
    const forward = impact(
      { nodes, edges: [containsEdge] },
      ["symbol:src/parent.ts#Parent"],
      {} as LockFile,
    );
    expect(forward.affectedFiles).toContain("src/child.ts");

    const reverse = impact(
      { nodes, edges: [containsEdge] },
      ["symbol:src/child.ts#Child"],
      {} as LockFile,
    );
    expect(reverse.affectedFiles).not.toContain("src/parent.ts");
  });

  it("report.ts: a PARENT claim IS corroborated by CHILD evidence (roll down); a CHILD claim is NOT corroborated by PARENT evidence (no roll up)", () => {
    const edges: GraphEdge[] = [
      containsEdge,
      // REQ-D: claimed on the PARENT (container). Its evidence lands on the
      // CHILD (contained) — this is the roll-DOWN direction `reqExercises`
      // supports, mirroring traverse.ts's forward `contains`.
      {
        source: "symbol:src/parent.ts#Parent",
        target: "REQ-D",
        kind: "implements",
        provenances: ["code-tag"],
      },
      // REQ-U: claimed on the CHILD. Its evidence lands on the PARENT — the
      // roll-UP direction neither implementation supports, mirroring
      // traverse.ts's blocked reverse `contains`.
      {
        source: "symbol:src/child.ts#Child",
        target: "REQ-U",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const trace: IngestedTrace = {
      perReq: new Map([
        ["REQ-D", { symbols: ["symbol:src/child.ts#Child"], files: [], tests: [] }],
        ["REQ-U", { symbols: ["symbol:src/parent.ts#Parent"], files: [], tests: [] }],
      ]),
      hashesAtTrace: new Map(),
      diagnostics: { dangling: 0, corrupted: 0, skipped: 0, unknownSchema: 0, offGraph: 0 },
      reqsByNode: new Map(),
      shardCount: 1,
    };

    const result = classifyEvidence({ nodes, edges }, trace);

    expect(result.corroborated).toContainEqual({
      reqId: "REQ-D",
      node: "symbol:src/parent.ts#Parent",
    });
    expect(result.unexercisedClaims).toContainEqual({
      reqId: "REQ-U",
      node: "symbol:src/child.ts#Child",
    });
    expect(result.corroborated.some((c) => c.reqId === "REQ-U")).toBe(false);
  });
});
