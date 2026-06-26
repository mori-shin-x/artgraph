// SC-004 wall-clock budget for `artgraph integrate <tool>` detect-failure.
//
// This file is intentionally separated from the rest of the suite and is
// run through `vitest.perf.config.ts` with `singleFork: true` /
// `fileParallelism: false`, so the spawned bin is the only CPU-heavy work
// on the box during measurement. Mixing it into the in-process suite
// caused 14 parallel workers to contend with the spawn, inflating the
// measured wall-clock to ~2s and turning the assertion flaky.
//
// `pnpm test` runs the main suite first, then re-invokes vitest with the
// perf config — see `package.json`'s `test` script.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "../helpers.js";

describe("Perf: `artgraph integrate <tool>` detect-failure wall-clock (SC-004)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-sc004-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function measure(args: string[]): { exitCode: number; stderr: string; elapsedMs: number } {
    const t0 = process.hrtime.bigint();
    const res = spawnSync("node", [CLI, ...args], { encoding: "utf-8", cwd: tmp, timeout: 30000 });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    return { exitCode: res.status ?? 1, stderr: res.stderr ?? "", elapsedMs };
  }

  it("integrate speckit exits with detect-failure in <1500ms when .specify/ is absent", () => {
    // Warm the loader once so subsequent runs see a warm Node module cache
    // (matches the spec's "warm cache" reference environment).
    measure(["--version"]);

    const r = measure(["integrate", "speckit"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not detected/i);
    expect(r.elapsedMs).toBeLessThan(1500);
    if (r.elapsedMs > 1000) {
      console.warn(
        `SC-004 soft target slip: integrate speckit detect-fail took ${r.elapsedMs.toFixed(0)}ms (expected <1000ms)`,
      );
    }
  });

  it("integrate kiro exits with detect-failure in <1500ms when .kiro/ is absent", () => {
    measure(["--version"]);

    const r = measure(["integrate", "kiro"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not detected/i);
    expect(r.elapsedMs).toBeLessThan(1500);
    if (r.elapsedMs > 1000) {
      console.warn(
        `SC-004 soft target slip: integrate kiro detect-fail took ${r.elapsedMs.toFixed(0)}ms (expected <1000ms)`,
      );
    }
  });
});
