// Perf regression for the reverse suffix index `buildGraph` uses to resolve
// edge targets against collision-qualified requirement IDs.
//
// The index answers "which `idMapping` keys end in `/<id>`" by registering a
// key's slash boundaries up front. Registering every boundary costs
// O(Σ_key Σ_slash suffix-length): invisible under the default grammar, where a
// key is `specDir/BARE-ID` and has exactly one boundary, but quadratic per key
// as soon as a custom `reqPatterns.listItem` admits `/` inside the raw ID.
// `scan` / `check` build the graph on every run — twice over for
// `check --diff --base` — so one generated or pasted spec line is enough to
// add minutes to a CI gate. Capping the boundaries kept per key (and falling
// back to the uncapped scan for queries deeper than the cap) keeps the build
// proportional to the input instead.
//
// The shape below is ~0.6 MB of markdown, small enough that parsing is a
// rounding error and nearly all of the wall clock is index construction.
// Measured under this config: uncapped 5.1-5.3s, capped 0.48-0.51s. The 2000ms
// budget therefore fails an uncapped build by ~2.6x while leaving the capped
// build ~4x of headroom for a slow CI runner.
//
// Runs in the dedicated perf config (singleFork, no fileParallelism, retry: 1)
// so the wall-clock assertion owns the CPU during measurement.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../../src/graph/builder.js";
import type { ArtgraphConfig } from "../../src/types.js";

// A grammar `loadConfig` accepts (no nested quantifiers) that lets a raw
// requirement ID carry its own slashes.
const config: ArtgraphConfig = {
  include: [],
  specDirs: ["specs"],
  testPatterns: [],
  lockFile: ".trace.lock",
  reqPatterns: { listItem: "^([A-Za-z0-9/_-]+):" },
};

const REQ_COUNT = 40;
const SEGMENTS_PER_ID = 8000;

describe("buildGraph suffix index — deep compound ID perf regression", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("builds a graph of pathologically deep compound IDs without a quadratic blowup", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-suffix-index-"));
    mkdirSync(resolve(tmp, "specs/010-a"), { recursive: true });
    const namespace = "a/".repeat(SEGMENTS_PER_ID);
    const lines = Array.from({ length: REQ_COUNT }, (_, i) => `- ${namespace}FR-${i}: text`);
    writeFileSync(resolve(tmp, "specs/010-a/spec.md"), lines.join("\n") + "\n", "utf-8");

    const start = performance.now();
    const { graph } = buildGraph(tmp, config);
    const elapsed = performance.now() - start;

    // Sanity: the deep IDs really did become nodes, so the index really was
    // fed the keys this test means to measure.
    expect(graph.nodes.has(`${namespace}FR-${REQ_COUNT - 1}`)).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});
