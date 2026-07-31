// issue #387 — self-pollution guard for THIS repository's own graph.
//
// artgraph scans itself. Its `[REQ-…]` / `@impl` scanners are plain-text
// regexes over every file in the scan pool, so a requirement ID written
// anywhere in a test file — an `it.each` data row, a fixture string, a
// sentence in a comment — becomes a real `verifies` / `implements` edge.
//
// Most of those point at IDs that do not exist, and `check` already reports
// them as orphans. The dangerous ones are the IDs that DO resolve: a fixture
// that happens to name a real requirement silently marks it as verified.
// `orphans` cannot see that (the edge is not dangling), no warning fires, and
// `check --gate` stays green — the requirement's `impl-only` status just flips
// to `verified` on the strength of a test that never tested it.
//
// The invariant below is what makes that observable. It is narrow on purpose:
// it does NOT pin the orphan count (that changes on every PR and would be
// noise), only the property that no code-tag `verifies` edge in this
// repository resolves to a real requirement node.
//
// Why zero is the right number HERE: artgraph's own suite deliberately does
// not tag test titles with `[REQ-…]`; its coverage story is execution
// evidence (`artgraph/vitest` trace shards) plus `@impl` tags in `src/`. So
// every resolving code-tag `verifies` edge in this repo is, by construction,
// a fixture leak.
//
// If artgraph ever adopts genuine `[REQ-…]` test-title tagging for its own
// requirements, this test SHOULD be updated deliberately (to an allowlist of
// intentional pairs, say) rather than deleted — the point is that a leak has
// to be argued for, not merely not-noticed.

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { loadConfig } from "../src/config.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("dogfood self-pollution (#387)", () => {
  const { graph } = buildGraph(REPO_ROOT, loadConfig(REPO_ROOT));

  it("no code-tag `verifies` edge resolves to a real requirement node", () => {
    const codeTagVerifies = graph.edges.filter(
      (e) => e.kind === "verifies" && e.provenances.includes("code-tag"),
    );

    // PRECONDITION: a build that produced no code-tag verifies edges at all
    // (a broken scan, an empty file pool) would make the assertion below
    // vacuously true. artgraph's test files quote bracket notation in plenty
    // of prose and fixtures, so this pool is never empty in practice.
    expect(codeTagVerifies.length).toBeGreaterThan(0);

    const resolving = codeTagVerifies
      .filter((e) => graph.nodes.get(e.target)?.kind === "req")
      .map((e) => `${e.source} --verifies--> ${e.target}`)
      .sort();

    if (resolving.length > 0) {
      console.error(
        "[dogfood] a test file's text names a REAL requirement id, which silently\n" +
          "marks that requirement verified. Rewrite the occurrence (split the\n" +
          'literal, e.g. "[" + "REQ-1" + "]") or pick an id that does not exist:\n  ' +
          resolving.join("\n  "),
      );
    }
    expect(resolving).toEqual([]);
  });

  it("every `impl-only` requirement stays impl-only — no fixture flips one to verified", () => {
    // The consequence the edge-level invariant above exists to prevent, stated
    // at the level `check` reports it. `verified` is reached only through a
    // `verifies` edge, and this repo has no legitimate source of those, so the
    // count must be exactly zero — while `impl-only` must NOT be, otherwise a
    // scan that lost every `@impl` tag would also satisfy the first half.
    const reqs = [...graph.nodes.values()].filter((n) => n.kind === "req");
    const verifiedTargets = new Set(
      graph.edges.filter((e) => e.kind === "verifies").map((e) => e.target),
    );
    const implementedTargets = new Set(
      graph.edges.filter((e) => e.kind === "implements").map((e) => e.target),
    );
    const implemented = reqs.filter((n) => implementedTargets.has(n.id));

    expect(implemented.length).toBeGreaterThan(0);
    expect(implemented.filter((n) => verifiedTargets.has(n.id)).map((n) => n.id)).toEqual([]);
  });
});
