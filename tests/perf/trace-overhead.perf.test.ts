// spec 020 (Phase D, T025) / spec 021 (Phase D, T018) — SC-005 / SC-002 perf
// budget: the `artgraph/vitest` runner's wall-clock overhead on a ~500-test
// suite MUST stay <= 20% over a runner-less baseline (spec 021 spec.md
// SC-002 — tightened from the original 50% budget once the v2 instrument
// engine landed; PoC measured ~33% on a 507-test suite under the OLD CDP
// engine — see specs/020-coverage-derived-edges/research.md).
//
// spec 021 T018: "withRunner" now measures the v2 (instrument) engine, not
// CDP — the fixture's runner config injects the built `dist/vitest/plugin.js`
// instrumentation plugin (the same one `artgraph/vitest/config`'s
// `withTrace()` wires up for real users) alongside `test.runner` pointing at
// the built `dist/vitest/runner.js`. `ARTGRAPH_TRACE_ENGINE` is left UNSET
// so the runner's own default (`resolveEngine()` in `src/vitest/runner.ts`)
// resolves to `"instrument"` — this doubles as a regression check that the
// shipped default is actually v2, not just that v2 CAN be selected.
//
// Fixture shape mirrors the PoC: ~25 source modules × 4 pure functions,
// ~25 test files × 20 tests (= 500 tests), each test a single expect()
// against one of the fixture's functions.
//
// Spawn technique reused verbatim from tests/e2e/vitest-runner.e2e.test.ts:
// the fixture's `node_modules` is a symlink to this repo's own installed
// `node_modules` (no install, no network — `import { describe, it, expect }
// from "vitest"` inside the fixture resolves to the exact vitest that spawns
// it), and vitest itself runs via `node <repo>/node_modules/vitest/vitest.mjs
// run --root <fixture> --config <plain-object config>`. "withRunner" mode
// points `test.runner` at the BUILT `dist/vitest/runner.js` (per this repo's
// perf convention — see tests/perf/global-setup.ts — the perf suite always
// measures the built bin, not in-process source).
//
// Stability: this box's load average fluctuates a lot in this shared
// multi-agent sandbox — blocking all baseline runs before all withRunner
// runs was observed to inflate the ratio well past budget whenever load
// climbed mid-measurement (withRunner is more CPU-bound, so it absorbs
// contention less gracefully than baseline's shorter, lighter-weight runs).
// Interleaving one baseline + one withRunner run per "round" instead pairs
// each measurement with a contemporaneous sample of the other mode, so a
// load spike hits both sides of the same round roughly equally. One
// discarded warmup round (JIT / OS page cache warm-up, same rationale as
// impact-symbol.perf.test.ts's `--version` warmup) is followed by 3
// measured rounds; the assertion compares medians across those rounds —
// absorbing single-run noise on top of vitest.perf.config.ts's `retry: 1`.
// Both modes use the same pool ("forks") throughout for a fair comparison.
// Measured locally: 4 rounds × (~2-5s baseline + ~3-6s withRunner) ≈
// 25-45s total even under heavy contention, well inside the ~90s budget.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RUNNER_PATH = resolve(REPO_ROOT, "dist/vitest/runner.js");
// spec 021 T018: the v2 instrumentation plugin, imported by the fixture's
// own runner config (below) — same built artifact `artgraph/vitest/config`'s
// `withTrace()` injects for real users. Rendered as a `file://` URL (not a
// bare OS path) because the fixture config is a real ESM module with a
// static `import` statement, and Node's ESM resolver only accepts relative/
// bare/URL specifiers — a plain absolute POSIX path isn't one of those.
const PLUGIN_URL = pathToFileURL(resolve(REPO_ROOT, "dist/vitest/plugin.js")).href;
const VITEST_BIN = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");

const MODULE_COUNT = 25;
const FUNCS_PER_MODULE = 4;
const TEST_FILE_COUNT = 25;
const TESTS_PER_FILE = 20; // 25 × 20 = 500 tests (PoC shape, SC-005)

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "artgraph-perf-trace-overhead-"));
  symlinkSync(resolve(REPO_ROOT, "node_modules"), join(fixtureDir, "node_modules"));
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({ name: "artgraph-perf-trace-overhead-fixture", private: true, type: "module" }),
  );
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  mkdirSync(join(fixtureDir, "tests"), { recursive: true });

  // src/modN.js — simple pure functions (PoC shape: no I/O, no async).
  for (let m = 0; m < MODULE_COUNT; m++) {
    const lines: string[] = [];
    for (let f = 0; f < FUNCS_PER_MODULE; f++) {
      lines.push(
        `export function mod${m}Fn${f}(x) {`,
        `  return x + ${m * FUNCS_PER_MODULE + f};`,
        `}`,
        "",
      );
    }
    writeFileSync(join(fixtureDir, `src/mod${m}.js`), lines.join("\n"));
  }

  // tests/modN.test.js — 20 tests/file, each a single expect() call against
  // one of two neighboring modules' functions (PoC shape: "simple pure
  // functions, expect() per test").
  let testIdx = 0;
  for (let t = 0; t < TEST_FILE_COUNT; t++) {
    const mods = [t % MODULE_COUNT, (t + 1) % MODULE_COUNT];
    const importLines = mods.map(
      (m) =>
        `import { ${Array.from({ length: FUNCS_PER_MODULE }, (_, f) => `mod${m}Fn${f}`).join(
          ", ",
        )} } from "../src/mod${m}.js";`,
    );
    const body = [
      `import { describe, it, expect } from "vitest";`,
      ...importLines,
      "",
      `describe("mod${t} suite", () => {`,
    ];
    for (let i = 0; i < TESTS_PER_FILE; i++) {
      const m = mods[i % 2]!;
      const f = i % FUNCS_PER_MODULE;
      body.push(
        `  it("[REQ-${String(testIdx).padStart(4, "0")}] test ${i} calls mod${m}Fn${f}", () => {`,
        `    expect(mod${m}Fn${f}(1)).toBe(${1 + m * FUNCS_PER_MODULE + f});`,
        `  });`,
      );
      testIdx++;
    }
    body.push("});", "");
    writeFileSync(join(fixtureDir, `tests/mod${t}.test.js`), body.join("\n"));
  }

  // Two plain-object configs (not `defineConfig` from "vitest/config" — see
  // tests/e2e/vitest-runner.e2e.test.ts's comment: resolving that specifier
  // from a tmpdir config file's own location would never find this repo's
  // node_modules). Same `include`/`pool` in both — `runner` is the only
  // difference, so the two modes are otherwise identical.
  writeFileSync(
    join(fixtureDir, "vitest.baseline.config.mjs"),
    `export default {\n  test: {\n    include: ["tests/**/*.test.js"],\n    pool: "forks",\n  },\n};\n`,
  );
  // spec 021 T018: `plugins` (top-level, not `test.*`) carries the v2
  // instrumentation plugin so the runner's default `instrument` engine (no
  // `ARTGRAPH_TRACE_ENGINE` set — see file header) actually has a registry to
  // drain, instead of measuring a no-op instrument run that never
  // instruments anything (see runner.ts's "no module was ever registered"
  // warning this would otherwise trip).
  writeFileSync(
    join(fixtureDir, "vitest.runner.config.mjs"),
    `import artgraphTracePlugin from ${JSON.stringify(PLUGIN_URL)};\n` +
      `export default {\n  test: {\n    include: ["tests/**/*.test.js"],\n    pool: "forks",\n    runner: ${JSON.stringify(
        RUNNER_PATH,
      )},\n  },\n  plugins: [artgraphTracePlugin()],\n};\n`,
  );
}, 30000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

function runOnce(configName: string, traceDir?: string): number {
  const env = traceDir ? { ...process.env, ARTGRAPH_TRACE_DIR: traceDir } : process.env;
  const t0 = process.hrtime.bigint();
  const res = spawnSync(
    "node",
    [
      VITEST_BIN,
      "run",
      "--root",
      fixtureDir,
      "--config",
      join(fixtureDir, configName),
      "--pool",
      "forks",
    ],
    { cwd: fixtureDir, encoding: "utf-8", env, timeout: 60000 },
  );
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
  if (res.status !== 0) {
    throw new Error(
      `vitest run (${configName}) exited ${res.status}: ${res.stderr}\n${res.stdout}`,
    );
  }
  return elapsedMs;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

describe("Perf: vitest runner overhead on a ~500-test suite (SC-005 / SC-002)", () => {
  it("withRunner (v2 instrument engine) wall-clock median <= baseline wall-clock median * 1.2", () => {
    const traceDir = join(fixtureDir, ".artgraph-trace-perf");
    mkdirSync(traceDir, { recursive: true });

    // One discarded warmup round per mode (OS page cache / JIT warm-up —
    // same rationale as this suite's other perf tests' `--version`
    // warmup calls) before the measured rounds.
    runOnce("vitest.baseline.config.mjs");
    runOnce("vitest.runner.config.mjs", traceDir);

    // Interleaved rounds (see file header): each measured baseline run is
    // immediately followed by a withRunner run, so ambient load spikes on
    // this shared box hit both modes of the same round roughly equally
    // instead of skewing whichever mode happened to run during the spike.
    const baselineRuns: number[] = [];
    const withRunnerRuns: number[] = [];
    for (let round = 0; round < 3; round++) {
      baselineRuns.push(runOnce("vitest.baseline.config.mjs"));
      withRunnerRuns.push(runOnce("vitest.runner.config.mjs", traceDir));
    }

    // Positive control: the withRunner mode actually produced shard
    // output — guards against a config typo silently degrading
    // "withRunner" into another runner-less baseline run.
    const shards = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
    expect(shards.length).toBeGreaterThan(0);

    // spec 021 T018: a SECOND positive control, specific to the v2 engine —
    // shard files existing is not enough (the instrument engine always
    // writes a `meta` record even when the plugin never registered a single
    // module, e.g. a config typo that drops `plugins`), so this asserts at
    // least one `test` record actually carries a non-empty `hits` array,
    // guarding against silently measuring a no-op instrument run that never
    // instruments anything.
    const anyHit = shards.some((f) =>
      readFileSync(join(traceDir, f), "utf-8")
        .split("\n")
        .filter(Boolean)
        .some((line) => {
          const rec = JSON.parse(line) as { kind?: string; hits?: unknown[] };
          return rec.kind === "test" && Array.isArray(rec.hits) && rec.hits.length > 0;
        }),
    );
    expect(anyHit).toBe(true);

    const baselineMs = median(baselineRuns);
    const withRunnerMs = median(withRunnerRuns);
    const ratio = withRunnerMs / baselineMs;

    // Logged unconditionally (not just on budget slip) so the actual
    // measured ratio is on record for every perf run, matching this
    // task's requirement to log the ratio "for the record".
    console.log(
      `SC-002 perf (v2 instrument engine): baseline median=${baselineMs.toFixed(
        0,
      )}ms, withRunner median=${withRunnerMs.toFixed(0)}ms, ratio=${ratio.toFixed(
        3,
      )} (budget <=1.2x)`,
    );

    // Hard budget: SC-002's 20% ceiling (spec 021, tightened from spec 020
    // SC-005's 50%).
    expect(withRunnerMs).toBeLessThanOrEqual(baselineMs * 1.2);
  }, 80000);
});
