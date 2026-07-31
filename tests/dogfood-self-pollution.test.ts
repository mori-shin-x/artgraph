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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { loadConfig } from "../src/config.js";
import type { ArtifactGraph } from "../src/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

// This builds the graph of the REPOSITORY ITSELF, which means it would also
// write the repository's real `node_modules/.cache/artgraph/parse-cache.json`.
// That cache is keyed by file content, not by which binary produced the
// fragment, so a cache warmed by the test run (`src/`, via vite-node) is then
// READ by the CLI (`dist/`) — the same src-vs-dist replay hazard (INV-L4) that
// made issue #387 bump SCHEMA_VERSION.
//
// Disable the cache for the duration of THIS FILE only: vitest reuses a worker
// process across files, and several suites (tests/barrel-reexport.test.ts's
// INV-L4 pair among them) require the cache to be live, so the flag is
// restored in `afterAll` rather than left set.
//
// This is not the only self-scanning suite — tests/plan-coverage-dogfood.test.ts
// builds the repo graph too and still warms that cache (measured). Closing
// that one is out of scope here; it predates issue #387.
let previousCacheEnv: string | undefined;

describe("dogfood self-pollution (#387)", () => {
  let graph: ArtifactGraph;

  // Built in `beforeAll`, not in the describe body: at collection time a throw
  // from `loadConfig` / `buildGraph` is reported as a FILE-COLLECTION error
  // rather than a test failure, which hides which invariant broke.
  // The explicit timeout is required, not defensive: `testTimeout: 30000` in
  // vitest.config.ts does not cover hooks, which keep vitest's 10s default.
  // Scanning this whole repository cold takes a few seconds locally and 13s+ on
  // a loaded CI runner, so the default kills this hook there while every local
  // run passes. Same trap vitest.e2e.config.ts documents for its own hooks.
  beforeAll(() => {
    previousCacheEnv = process.env.ARTGRAPH_CACHE;
    process.env.ARTGRAPH_CACHE = "0";
    graph = buildGraph(REPO_ROOT, loadConfig(REPO_ROOT)).graph;
    // Cheap insurance that the build below is a real one. The per-test
    // preconditions are about specific edge kinds; this one catches the case
    // where the scan pool collapsed entirely.
    expect(graph.nodes.size).toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    if (previousCacheEnv === undefined) delete process.env.ARTGRAPH_CACHE;
    else process.env.ARTGRAPH_CACHE = previousCacheEnv;
  });

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
