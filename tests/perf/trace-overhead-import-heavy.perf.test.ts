// spec 021 (Phase A, T017 — US4) — perf: an import-heavy fixture that
// isolates "loaded module count" as its own axis, independent of "test
// count". The existing tests/perf/trace-overhead.perf.test.ts fixture only
// varies test count against a fixed 25-module fixture, so it structurally
// cannot reproduce issue #241's finding that per-test capture cost is
// proportional to the isolate's *loaded script count*
// (docs/design/241-trace-engine-v2.md; research.md V9's probe: 25 modules
// -> 0.345ms/takePreciseCoverage call, 1,600 modules -> 1.545ms/call, x2
// calls/test). Per SC-003 and research.md V9, T017 (this file's original
// form) existed to *record* — not yet gate on — that module-count-driven
// overhead under the then-current (pre-v2) CDP capture engine (tasks.md
// T017: "この時点では現行エンジンの実測比を記録ログに残すだけ").
//
// spec 021 T018 (Phase D): "withRunner" now measures the v2 (instrument)
// engine instead of CDP, and the budget is tightened to 1.2 (SC-003) — see
// the "Spawn technique" paragraph below for what changed mechanically.
//
// Fixture shape (data-model.md §6 ImportHeavyFixture): a 3-stage import
// chain — root -> 10 branch modules -> 290 leaf modules (10 x 29 = 290
// leaves + 10 branches + 1 root = 301 modules, ~= the "300 モジュール"
// target) — so that a single test file's `import { rootFn } from
// "../src/root.js"` transitively loads virtually the entire module graph
// (data-model.md §6: "1 テストファイルの import から多数モジュールが推移的
// にロードされる構造"). 15 test files x 20 tests/file = 300 tests (the
// testCount target); no test-count reduction was needed (see stability note
// below — this shape already keeps the suite fast and the ratio safely
// under budget).
//
// Unlike the existing fixture, this one forces
// `poolOptions.forks.singleFork: true` on BOTH configs. Rationale: with the
// default multi-fork pool, vitest spreads the 15 test files across several
// worker *processes*, and each worker only ever accumulates the modules
// loaded by the file(s) it happens to be scheduled — diluting the very
// process-wide "cumulative loaded scripts" effect this fixture exists to
// expose, and making the measured ratio depend on scheduling luck. Forcing
// everything into one worker process makes the module-count-driven cost
// show up reliably. Measured locally (5 repeats): ratio ~1.31-1.44 with
// singleFork vs. a wildly bimodal ~1.1-2.8 without it depending on how the
// default pool happened to schedule the 15 files across workers — some
// configurations even measured well past the 1.5 budget, which would have
// made this fixture red for reasons unrelated to the thing it's meant to
// measure. singleFork keeps both modes on the same footing (still a fair
// comparison — see the existing fixture's file header) while keeping the
// measurement itself stable.
//
// Spawn technique, interleaved rounds, and median comparison are otherwise
// reused verbatim from tests/perf/trace-overhead.perf.test.ts (see that
// file's header for the full stabilization rationale): node_modules
// symlink, plain-object config (not `defineConfig` from "vitest/config" —
// resolving that specifier from a tmpdir config file's own location would
// never find this repo's node_modules), `node
// <repo>/node_modules/vitest/vitest.mjs run`, "withRunner" pointed at the
// BUILT `dist/vitest/runner.js` PLUS the built `dist/vitest/plugin.js`
// instrumentation plugin (spec 021 T018 — see file header), `ARTGRAPH_TRACE_DIR`
// set for the withRunner runs only, pool "forks", one discarded warmup round
// (JIT / OS page cache warm-up) followed by 3 measured rounds, each round
// interleaving one baseline run immediately followed by one withRunner run
// so ambient load spikes on this shared box hit both modes of the same
// round roughly equally, and the assertion compares medians across rounds.
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

// data-model.md §6 ImportHeavyFixture parameters.
const BRANCH_COUNT = 10;
const LEAVES_PER_BRANCH = 29; // 10 x 29 = 290 leaves + 10 branches + 1 root = 301 modules (moduleCount ~= 300)
const LEAF_COUNT = BRANCH_COUNT * LEAVES_PER_BRANCH;
const TEST_FILE_COUNT = 15;
const TESTS_PER_FILE = 20; // 15 x 20 = 300 tests (testCount ~= 300)

// rootFn(1) = sum over every leaf of (1 + leafIdx), leafIdx ranging 0..LEAF_COUNT-1.
const EXPECTED_ROOT_FN_1 = LEAF_COUNT * 1 + ((LEAF_COUNT - 1) * LEAF_COUNT) / 2;

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "artgraph-perf-trace-overhead-import-heavy-"));
  symlinkSync(resolve(REPO_ROOT, "node_modules"), join(fixtureDir, "node_modules"));
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "artgraph-perf-trace-overhead-import-heavy-fixture",
      private: true,
      type: "module",
    }),
  );
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  mkdirSync(join(fixtureDir, "tests"), { recursive: true });

  // src/leafN.js — chain leaves (stage 3): trivial pure functions, no
  // dependencies of their own (leaves of the import graph).
  let leafIdx = 0;
  const leavesByBranch: number[][] = [];
  for (let b = 0; b < BRANCH_COUNT; b++) {
    const leaves: number[] = [];
    for (let i = 0; i < LEAVES_PER_BRANCH; i++) {
      const idx = leafIdx++;
      leaves.push(idx);
      writeFileSync(
        join(fixtureDir, `src/leaf${idx}.js`),
        `export function leafFn${idx}(x) {\n  return x + ${idx};\n}\n`,
      );
    }
    leavesByBranch.push(leaves);
  }

  // src/branchN.js — chain branches (stage 2): each imports its slice of
  // leaves and sums them, so evaluating a branch module transitively
  // evaluates every leaf module underneath it.
  for (let b = 0; b < BRANCH_COUNT; b++) {
    const leaves = leavesByBranch[b]!;
    const importLines = leaves.map((idx) => `import { leafFn${idx} } from "./leaf${idx}.js";`);
    const sumExpr = leaves.map((idx) => `leafFn${idx}(x)`).join(" + ");
    writeFileSync(
      join(fixtureDir, `src/branch${b}.js`),
      [
        ...importLines,
        "",
        `export function branchFn${b}(x) {`,
        `  return ${sumExpr};`,
        "}",
        "",
      ].join("\n"),
    );
  }

  // src/root.js — chain root (stage 1): the single entry point every test
  // file imports. Importing this one module transitively loads all 10
  // branch modules and all 290 leaf modules underneath them (301 modules
  // total from one import statement).
  {
    const importLines = Array.from(
      { length: BRANCH_COUNT },
      (_, b) => `import { branchFn${b} } from "./branch${b}.js";`,
    );
    const sumExpr = Array.from({ length: BRANCH_COUNT }, (_, b) => `branchFn${b}(x)`).join(" + ");
    writeFileSync(
      join(fixtureDir, "src/root.js"),
      [...importLines, "", "export function rootFn(x) {", `  return ${sumExpr};`, "}", ""].join(
        "\n",
      ),
    );
  }

  // tests/chainN.test.js — every file imports only `rootFn`, which
  // transitively pulls in the full 301-module chain built above. 20
  // tests/file x 15 files = 300 tests, each a single expect() against the
  // fully-chained computation (mirrors the existing fixture's "simple pure
  // functions, expect() per test" shape).
  let testIdx = 0;
  for (let t = 0; t < TEST_FILE_COUNT; t++) {
    const body = [
      `import { describe, it, expect } from "vitest";`,
      `import { rootFn } from "../src/root.js";`,
      "",
      `describe("chain${t} suite", () => {`,
    ];
    for (let i = 0; i < TESTS_PER_FILE; i++) {
      body.push(
        `  it("[REQ-${String(testIdx).padStart(4, "0")}] test ${i} calls rootFn through the full chain", () => {`,
        `    expect(rootFn(1)).toBe(${EXPECTED_ROOT_FN_1});`,
        `  });`,
      );
      testIdx++;
    }
    body.push("});", "");
    writeFileSync(join(fixtureDir, `tests/chain${t}.test.js`), body.join("\n"));
  }

  // Two plain-object configs (not `defineConfig` — see file header). Same
  // `include`/`pool`/`poolOptions` in both — `runner` (and, for the v2
  // engine, `plugins` — spec 021 T018) is the only difference, so the two
  // modes are otherwise identical (fair comparison, same convention as the
  // existing fixture).
  //
  // `poolOptions.forks.singleFork: true` on both: see file header
  // "stability note" — without it, the 15 test files get scattered across
  // multiple worker processes by the default pool, and each worker's
  // isolate only ever accumulates the subset of the 301-module chain it
  // personally (re)loaded, diluting the very cumulative-module-count effect
  // this fixture exists to measure and destabilizing the ratio run to run.
  const poolOptionsSnippet = `{ forks: { singleFork: true } }`;
  writeFileSync(
    join(fixtureDir, "vitest.baseline.config.mjs"),
    `export default {\n  test: {\n    include: ["tests/**/*.test.js"],\n    pool: "forks",\n    poolOptions: ${poolOptionsSnippet},\n  },\n};\n`,
  );
  // spec 021 T018: `plugins` (top-level, not `test.*`) carries the v2
  // instrumentation plugin so the runner's default `instrument` engine (no
  // `ARTGRAPH_TRACE_ENGINE` set — see file header) actually has a registry to
  // drain.
  writeFileSync(
    join(fixtureDir, "vitest.runner.config.mjs"),
    `import artgraphTracePlugin from ${JSON.stringify(PLUGIN_URL)};\n` +
      `export default {\n  test: {\n    include: ["tests/**/*.test.js"],\n    pool: "forks",\n    poolOptions: ${poolOptionsSnippet},\n    runner: ${JSON.stringify(
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
    // Heavier fixture than the existing one (301 modules vs. 25) — a more
    // generous per-run timeout than that file's 60000ms, matching this
    // file's overall stability margin under this shared box's load swings.
    { cwd: fixtureDir, encoding: "utf-8", env, timeout: 90000 },
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

describe("Perf: vitest runner overhead on an import-heavy ~300-module fixture (SC-003)", () => {
  it("withRunner (v2 instrument engine) wall-clock median <= baseline wall-clock median * 1.2", () => {
    const traceDir = join(fixtureDir, ".artgraph-trace-perf");
    mkdirSync(traceDir, { recursive: true });

    // One discarded warmup round per mode (OS page cache / JIT warm-up —
    // same rationale as the existing perf tests' warmup calls) before the
    // measured rounds.
    runOnce("vitest.baseline.config.mjs");
    runOnce("vitest.runner.config.mjs", traceDir);

    // Interleaved rounds (see file header): each measured baseline run is
    // immediately followed by a withRunner run, so ambient load spikes on
    // this shared box hit both modes of the same round roughly equally.
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
    // module), so this asserts at least one `test` record actually carries a
    // non-empty `hits` array, guarding against silently measuring a no-op
    // instrument run.
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

    // Logged unconditionally (not just on budget slip), matching the
    // existing perf test's convention, so the actual measured ratio is on
    // record for every perf run. This is the SC-003 recording this file
    // exists for: an import-heavy (~300-module) fixture's overhead under the
    // v2 (instrument) engine (spec 021 T018 — re-pointed from the CDP engine
    // T017 originally recorded), which — unlike the existing 25-module
    // fixture — is what exercises the module-count-independence this engine
    // exists to deliver.
    console.log(
      `SC-003 perf (import-heavy fixture, v2 instrument engine): baseline median=${baselineMs.toFixed(
        0,
      )}ms, withRunner median=${withRunnerMs.toFixed(0)}ms, ratio=${ratio.toFixed(
        3,
      )} (budget <=1.2x)`,
    );

    // Hard budget: SC-003's 20% ceiling (spec 021, tightened from spec 020
    // SC-005's 50% / T017's interim 1.5).
    expect(withRunnerMs).toBeLessThanOrEqual(baselineMs * 1.2);
  }, 120000);
});
