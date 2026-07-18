// issue #323 (design item 4, MUST) — `isTest` (and therefore a TS fragment's
// `file:<relPath>` node `kind`) is now derived from `testPatterns`, a CONFIG
// value, not a property of the file's own bytes. The parse cache
// (node_modules/.cache/artgraph/parse-cache.json) keys a fragment by content
// hash only, so a warm build that changes `testPatterns` ALONE — same file
// content — would otherwise keep replaying the OLD `kind` forever (a new
// staleness path the pre-#323 cache design never had to guard against).
//
// `fragmentTestKindMatches` (src/parse-cache.ts), consulted alongside
// `importTargetsExist` at every fragment-reuse decision in
// `graph/builder.ts`, closes this: a cached fragment whose `kind` disagrees
// with today's testPatterns-derived answer is treated as a cache MISS for
// that one file (not a whole-cache invalidation), forcing a cold reparse.
//
// This test pins the exact scenario the design calls out: same file
// content, testPatterns changed between two scans of the SAME (warm-cached)
// project — the second scan must (a) NOT reuse the stale fragment, (b) flip
// the node kind correctly, and (c) regenerate the `verifies` edge the new
// classification implies.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";

const CACHE_REL = join("node_modules", ".cache", "artgraph", "parse-cache.json");

describe("issue #323 (AC d) — parse-cache kind-mismatch guard on a testPatterns-only change", () => {
  let tmp: string;
  let baseConfig: ArtgraphConfig;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-323-cache-guard-"));
    mkdirSync(join(tmp, "specs", "feat"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "node_modules"), { recursive: true }); // opt into the cache
    writeFileSync(
      join(tmp, "specs", "feat", "spec.md"),
      "# Feat\n\n- REQ-001: first requirement\n",
    );
    // Content NEVER changes across the two builds below — only `testPatterns`
    // does. Filename deliberately does not look like `*.test.ts` so the
    // pre-#323 hardcoded regex would have classified it "file" regardless.
    writeFileSync(
      join(tmp, "src", "thing.ts"),
      'describe("[REQ-001] thing", () => {\n  it("works", () => {});\n});\n',
    );
    baseConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("flips kind file->test and regenerates the verifies edge on the second (warm-cache) scan", () => {
    // Build 1: testPatterns does not match thing.ts — kind "file", no
    // verifies edge (isTest false skips [REQ-x] extraction entirely).
    const first = buildGraph(tmp, baseConfig);
    expect(first.graph.nodes.get("file:src/thing.ts")?.kind).toBe("file");
    expect(
      first.graph.edges.some((e) => e.kind === "verifies" && e.source === "file:src/thing.ts"),
    ).toBe(false);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(true);

    // Build 2: SAME tmp dir (warm cache), SAME file content, ONLY
    // testPatterns changed to now match thing.ts.
    const secondConfig: ArtgraphConfig = { ...baseConfig, testPatterns: ["src/**/*.ts"] };
    const second = buildGraph(tmp, secondConfig);
    const testNode = second.graph.nodes.get("file:src/thing.ts");
    expect(testNode?.kind).toBe("test");
    const verifyEdge = second.graph.edges.find(
      (e) => e.kind === "verifies" && e.source === "file:src/thing.ts" && e.target === "REQ-001",
    );
    expect(verifyEdge).toBeDefined();
  });

  it("a THIRD scan (testPatterns flipped back) matches a fully cold rebuild of the same config (INV-L4-style equivalence)", () => {
    buildGraph(tmp, baseConfig); // build 1: file
    const testConfig: ArtgraphConfig = { ...baseConfig, testPatterns: ["src/**/*.ts"] };
    buildGraph(tmp, testConfig); // build 2: test (warm cache, kind-mismatch guard fires)

    // build 3: back to "file" — the guard must fire again in the OTHER
    // direction too, not just test->file once.
    const third = buildGraph(tmp, baseConfig);
    expect(third.graph.nodes.get("file:src/thing.ts")?.kind).toBe("file");
    expect(
      third.graph.edges.some((e) => e.kind === "verifies" && e.source === "file:src/thing.ts"),
    ).toBe(false);

    // Cross-check against a cache-disabled cold build of the same config.
    process.env.ARTGRAPH_CACHE = "0";
    let cold;
    try {
      cold = buildGraph(tmp, baseConfig);
    } finally {
      delete process.env.ARTGRAPH_CACHE;
    }
    expect([...third.graph.nodes.keys()].sort()).toEqual([...cold.graph.nodes.keys()].sort());
    expect(third.graph.nodes.get("file:src/thing.ts")?.kind).toBe(
      cold.graph.nodes.get("file:src/thing.ts")?.kind,
    );
  });
});
