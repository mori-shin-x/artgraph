import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import cytoscape from "cytoscape";

/**
 * Interaction regression tests for the vendored graph frontend
 * (`templates/graph/app.js`). The frontend is a classic browser IIFE with
 * no exports, so under vitest it attaches its testable internals to
 * `globalThis.__artgraphGraphApp` (guarded by `process.env.VITEST`). We drive
 * those against a *headless* cytoscape instance built with the REAL stylesheet
 * so opacity assertions reflect production style resolution.
 *
 * See issue #171: search, node-focus, and stat-tile filters must not clobber
 * one another's dim state.
 */

type GraphApp = {
  STYLE: unknown[];
  buildElements: (d: unknown) => unknown[];
  applySearch: (cy: cytoscape.Core, q: string) => void;
  applyStatFilter: (cy: cytoscape.Core, s: string) => void;
  focusNeighborhood: (cy: cytoscape.Core, node: cytoscape.NodeSingular) => void;
  clearFocus: (cy: cytoscape.Core) => void;
};

let app: GraphApp;

beforeAll(async () => {
  // @ts-expect-error side-effect import of an untyped browser template
  await import("../templates/graph/app.js");
  app = (globalThis as unknown as { __artgraphGraphApp: GraphApp }).__artgraphGraphApp;
});

/**
 * Fixture graph:
 *   A (REQ-A) --implements--> B (beta)
 *   C (gamma), D (delta) are isolated.
 * Closed neighborhood of A = {A, B, edge}. Non-neighbors of A = {C, D}.
 * Search terms: "beta"->B, "gamma"->C, "delta"->D.
 */
function makeCy() {
  const data = {
    nodes: [
      { id: "A", label: "REQ-A", layer: "req", kind: "req", state: "ok", filePath: "a.md" },
      { id: "B", label: "beta", layer: "code", kind: "file", state: "ok", filePath: "b.ts" },
      { id: "C", label: "gamma", layer: "test", kind: "test", state: "ok", filePath: "c.ts" },
      { id: "D", label: "delta", layer: "doc", kind: "doc", state: "ok", filePath: "d.md" },
    ],
    edges: [{ source: "A", target: "B", kind: "implements" }],
  };
  return cytoscape({
    headless: true,
    styleEnabled: true,
    style: app.STYLE as cytoscape.Stylesheet[],
    elements: app.buildElements(data) as cytoscape.ElementDefinition[],
  });
}

// Effective opacity as resolved by the real stylesheet. Headless cytoscape
// computes styles lazily, so read after each mutation.
const op = (cy: cytoscape.Core, id: string): number => cy.$(`#${id}`).numericStyle("opacity");

const DIM = 0.15;
const BRIGHT = 1;

describe("graph interactions (issue #171)", () => {
  let cy: cytoscape.Core;

  beforeEach(() => {
    cy = makeCy();
  });

  it("exports its testable internals under vitest", () => {
    expect(app).toBeTruthy();
    expect(Array.isArray(app.STYLE)).toBe(true);
    expect(typeof app.applySearch).toBe("function");
    expect(typeof app.focusNeighborhood).toBe("function");
  });

  // Scenario 1 (Forward break): focusing, then typing a query and clearing it,
  // must NOT wipe the focus dim.
  it("preserves focus dim after a search is typed then cleared", () => {
    app.focusNeighborhood(cy, cy.$("#A"));
    expect(op(cy, "C")).toBeCloseTo(DIM); // non-neighbor dimmed
    expect(op(cy, "B")).toBeCloseTo(BRIGHT); // neighbor highlighted
    expect(op(cy, "A")).toBeCloseTo(BRIGHT); // focused node

    app.applySearch(cy, "x"); // no match
    app.applySearch(cy, ""); // cleared

    expect(op(cy, "C")).toBeCloseTo(DIM); // focus dim survives the clear
  });

  // Scenario 2 (Reverse break): typing a query while focused must not let the
  // search recompute clobber the focus overlay.
  it("keeps focus overlay when a search runs on top of it", () => {
    app.focusNeighborhood(cy, cy.$("#A"));
    app.applySearch(cy, "gamma"); // matches non-neighbor C

    expect(op(cy, "C")).toBeCloseTo(DIM); // matching non-neighbor stays dimmed (no glow)
    expect(op(cy, "B")).toBeCloseTo(BRIGHT); // non-matching neighbor stays highlighted
  });

  // Scenario 3 (guard): tapping a search-dimmed node must reveal it. Passes
  // before and after the fix.
  it("reveals a search-dimmed node when it is focused", () => {
    app.applySearch(cy, "gamma"); // dims A, B, D
    expect(op(cy, "B")).toBeCloseTo(DIM);

    app.focusNeighborhood(cy, cy.$("#B"));
    expect(op(cy, "B")).toBeCloseTo(BRIGHT);
  });

  // Scenario 4: clearing focus must fall back to the active search filter.
  it("restores the search dim after focus is cleared", () => {
    app.applySearch(cy, "beta"); // matches B; dims A, C, D
    expect(op(cy, "C")).toBeCloseTo(DIM);

    app.focusNeighborhood(cy, cy.$("#C"));
    expect(op(cy, "C")).toBeCloseTo(BRIGHT);

    app.clearFocus(cy);
    expect(op(cy, "C")).toBeCloseTo(DIM); // search dim restored
    expect(op(cy, "B")).toBeCloseTo(BRIGHT); // matching node still bright
  });

  // Scenario 5: a stat-tile filter and a focus must coexist — clearing the
  // focus must leave the stat dim intact.
  it("keeps the stat-filter dim intact across a focus/clear cycle", () => {
    app.applyStatFilter(cy, "orphan"); // no node is orphan -> everything dims
    expect(op(cy, "C")).toBeCloseTo(DIM);
    expect(op(cy, "B")).toBeCloseTo(DIM);

    app.focusNeighborhood(cy, cy.$("#A"));
    app.clearFocus(cy);

    expect(op(cy, "C")).toBeCloseTo(DIM); // stat dim persists
    expect(op(cy, "B")).toBeCloseTo(DIM);
  });
});
