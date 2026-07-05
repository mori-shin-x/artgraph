// Incremental parse cache (src/parse-cache.ts). The cache memoizes per-file
// parser fragments under node_modules/.cache/artgraph/parse-cache.json; these
// tests pin the contract that a warm build is OBSERVABLY IDENTICAL to a cold
// one (graph nodes/edges, lock bytes) and that every invalidation path falls
// back to a correct re-parse.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import type { ArtifactGraph, ArtgraphConfig } from "../src/types.js";

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.test.ts"],
  lockFile: ".trace.lock",
};

const CACHE_REL = join("node_modules", ".cache", "artgraph", "parse-cache.json");

// Serialize everything a downstream consumer can observe. Map iteration order
// is part of the contract (builder sorts nodes/edges), so JSON order captures
// it too. `lastReconciled` is stamped with the wall clock on every
// buildLockFromGraph call, so normalize it — everything else in the lock must
// be byte-identical between warm and cold builds.
function snapshotGraph(graph: ArtifactGraph): string {
  const lock = buildLockFromGraph(graph);
  for (const entry of Object.values(lock)) {
    entry.lastReconciled = "<normalized>";
  }
  return JSON.stringify({
    nodes: [...graph.nodes.entries()],
    edges: graph.edges,
    lock,
  });
}

// Reference result: what a cache-less build of the CURRENT tree produces.
function buildWithoutCache(dir: string): string {
  process.env.ARTGRAPH_CACHE = "0";
  try {
    return snapshotGraph(buildGraph(dir, config).graph);
  } finally {
    delete process.env.ARTGRAPH_CACHE;
  }
}

describe("parse cache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-parse-cache-"));
    mkdirSync(join(tmp, "specs", "feat"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(
      join(tmp, "specs", "feat", "spec.md"),
      "# Feat\n\n- REQ-001: first requirement\n- REQ-002: second requirement\n",
    );
    writeFileSync(join(tmp, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(
      join(tmp, "src", "a.ts"),
      '// @impl REQ-001\nimport { b } from "./b.js";\nexport const a = b;\n',
    );
    writeFileSync(
      join(tmp, "tests", "a.test.ts"),
      '// [REQ-001]\nimport { a } from "../src/a.js";\nexport const t = a;\n',
    );
    // The cache only activates when node_modules exists (real installs have
    // one; tmp fixtures normally don't — that keeps every other suite on the
    // cold path). Opt this fixture in explicitly.
    mkdirSync(join(tmp, "node_modules"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.ARTGRAPH_CACHE;
  });

  it("writes the cache file under node_modules/.cache and reuses it warm", () => {
    const cold = snapshotGraph(buildGraph(tmp, config).graph);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(true);

    const warm = snapshotGraph(buildGraph(tmp, config).graph);
    expect(warm).toBe(cold);
  });

  it("warm build equals a cache-disabled build (nodes, edges, lock bytes)", () => {
    buildGraph(tmp, config); // populate cache
    const warm = snapshotGraph(buildGraph(tmp, config).graph);
    expect(warm).toBe(buildWithoutCache(tmp));
  });

  it("does not create a cache file when node_modules is absent", () => {
    rmSync(join(tmp, "node_modules"), { recursive: true, force: true });
    buildGraph(tmp, config);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(false);
  });

  it("does not create a cache file when ARTGRAPH_CACHE=0", () => {
    process.env.ARTGRAPH_CACHE = "0";
    buildGraph(tmp, config);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(false);
  });

  it("picks up a changed TS file (new @impl edge) on a warm build", () => {
    buildGraph(tmp, config); // populate cache
    appendFileSync(join(tmp, "src", "b.ts"), "// @impl REQ-002\n");

    const { graph } = buildGraph(tmp, config);
    const edge = graph.edges.find(
      (e) => e.source === "file:src/b.ts" && e.target === "REQ-002" && e.kind === "implements",
    );
    expect(edge).toBeDefined();
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
  });

  it("picks up a changed spec file (new req node) on a warm build", () => {
    buildGraph(tmp, config); // populate cache
    appendFileSync(join(tmp, "specs", "feat", "spec.md"), "- REQ-003: third requirement\n");

    const { graph } = buildGraph(tmp, config);
    expect(graph.nodes.has("REQ-003")).toBe(true);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
  });

  it("invalidates TS fragments when a file is deleted (import edge to it disappears)", () => {
    const { graph: before } = buildGraph(tmp, config); // populate cache
    expect(
      before.edges.some((e) => e.source === "file:src/a.ts" && e.target === "file:src/b.ts"),
    ).toBe(true);

    rmSync(join(tmp, "src", "b.ts"));
    const { graph } = buildGraph(tmp, config);
    expect(
      graph.edges.some((e) => e.source === "file:src/a.ts" && e.target === "file:src/b.ts"),
    ).toBe(false);
    expect(graph.nodes.has("file:src/b.ts")).toBe(false);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
  });

  it("invalidates when the analysis config changes (mode file -> symbol)", () => {
    buildGraph(tmp, config); // populate cache in file mode
    const symbolConfig: ArtgraphConfig = { ...config, mode: "symbol" };

    const { graph } = buildGraph(tmp, symbolConfig);
    expect(graph.nodes.has("symbol:src/a.ts#a")).toBe(true);

    process.env.ARTGRAPH_CACHE = "0";
    const reference = snapshotGraph(buildGraph(tmp, symbolConfig).graph);
    delete process.env.ARTGRAPH_CACHE;
    expect(snapshotGraph(graph)).toBe(reference);
  });

  it("falls back to a cold parse when the cache file is corrupt", () => {
    buildGraph(tmp, config); // populate cache
    writeFileSync(join(tmp, CACHE_REL), "{ not json !!");

    const { graph } = buildGraph(tmp, config);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
    // and the corrupt file was replaced with a fresh valid cache
    const warmAgain = snapshotGraph(buildGraph(tmp, config).graph);
    expect(warmAgain).toBe(snapshotGraph(graph));
  });
});
