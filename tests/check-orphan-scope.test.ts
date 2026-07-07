import { describe, it, expect } from "vitest";
import { check } from "../src/check.js";
import type { ArtifactGraph } from "../src/types.js";

// spec 017 US2 (T018/T019, FR-006, R5) — orphan scoping must use STRICT source
// matching, not the old substring test `[...scope].some(s => o.includes(s))`.
// The old heuristic pulled an unrelated file's orphan line into scope whenever
// ANY scope token appeared as a substring of the rendered `source -> target
// (kind)` string — issue #174 measured 48 of 53 orphans false-matched this way.
// An orphan is causally in scope only when its `source` node is itself changed.

function graphWithOrphans(): ArtifactGraph {
  return {
    nodes: new Map([
      // A req that is in scope. Its id ("REQ-1") is a substring of the
      // unrelated orphan's target id ("REQ-100") below — the exact trap the
      // old `o.includes(s)` fell into.
      ["REQ-1", { id: "REQ-1", kind: "req", filePath: "specs/x.md", contentHash: "h1" }],
      // The changed file (in scope) with its OWN orphan → REQ-2 (not a node).
      [
        "file:src/changed.ts",
        { id: "file:src/changed.ts", kind: "file", filePath: "src/changed.ts", contentHash: "h2" },
      ],
      // An unrelated file (NOT in scope) whose @impl points at REQ-100 (not a
      // node) → a pre-existing orphan that must stay out of scope.
      [
        "file:src/unrelated.ts",
        {
          id: "file:src/unrelated.ts",
          kind: "file",
          filePath: "src/unrelated.ts",
          contentHash: "h3",
        },
      ],
    ]),
    edges: [
      {
        source: "file:src/changed.ts",
        target: "REQ-2",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "file:src/unrelated.ts",
        target: "REQ-100",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ],
  };
}

describe("check() orphan scoping is strict (FR-006 regression)", () => {
  it("only orphans whose source node is in scope are surfaced", () => {
    const graph = graphWithOrphans();
    // Scope = the changed file + a req whose id ("REQ-1") is a substring of the
    // unrelated orphan's target ("REQ-100").
    const scope = new Set(["file:src/changed.ts", "REQ-1"]);

    const result = check(graph, {}, scope);

    // The changed file's own orphan IS scoped.
    expect(result.orphans).toContain("file:src/changed.ts -> REQ-2 (implements)");
    // The unrelated orphan is NOT scoped even though "REQ-1" ⊂ "REQ-100".
    expect(result.orphans).not.toContain("file:src/unrelated.ts -> REQ-100 (implements)");
    expect(result.orphans.some((o) => o.includes("REQ-100"))).toBe(false);
    expect(result.orphans).toHaveLength(1);
  });

  it("a scoped req id that is a substring of an orphan target never pulls it in", () => {
    const graph = graphWithOrphans();
    // Scope contains ONLY the substring-trap req, not the unrelated file.
    const scope = new Set(["REQ-1"]);

    const result = check(graph, {}, scope);

    // Neither orphan's source is in scope → no orphan is scoped.
    expect(result.orphans).toEqual([]);
    // …and therefore nothing lands in newIssues either (no baseline supplied).
    expect(result.newIssues.orphans).toEqual([]);
  });

  it("without a scope (whole-graph check) every orphan is reported", () => {
    const graph = graphWithOrphans();
    const result = check(graph, {});
    expect(result.orphans).toHaveLength(2);
    expect(result.orphans).toContain("file:src/changed.ts -> REQ-2 (implements)");
    expect(result.orphans).toContain("file:src/unrelated.ts -> REQ-100 (implements)");
  });
});
