// spec 020 (Phase A-1, US1, T005 — Red; made Green by T006's
// src/vitest/runner.ts) — e2e: spawns a REAL vitest run (the repo's own
// `node_modules/vitest`, via `node .../vitest.mjs run`) against a
// synthesized temp fixture project, with `test.runner` pointed at the built
// `dist/vitest/runner.js`, and asserts the resulting TraceShard JSONL
// matches contracts/trace-artifact.md.
//
// Avoids `npm install` in the temp project (no network, no per-run cost):
// the fixture's `node_modules` is a symlink to this repo's own
// `node_modules`, so `import { describe, it, expect } from "vitest"` inside
// the fixture resolves to the exact same vitest that spawns it. The fixture
// never touches `.artgraph.json` / `withTrace()` — it sets `test.runner`
// directly, so this suite's Green doesn't depend on T007 (setup.ts) landing
// first (tasks.md Dependencies: T005 → T006 → T007, strictly sequential).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseShardLines,
  normalizeTrace,
  hashContent,
  type ParsedShard,
} from "../../src/trace/schema.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RUNNER_PATH = resolve(REPO_ROOT, "dist/vitest/runner.js");
// spec 021 (tasks.md T010) — the v2 engine's two build artifacts: the
// instrumentation plugin (main-process half) and this package's own
// globalSetup (generation cleanup, unrelated to engine choice — reused
// directly here rather than through `withTrace()`, which is out of this
// task's scope, T015).
const PLUGIN_PATH = resolve(REPO_ROOT, "dist/vitest/plugin.js");
const SETUP_PATH = resolve(REPO_ROOT, "dist/vitest/setup.js");
const VITEST_BIN = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "artgraph-vitest-runner-e2e-"));
  // Reuse the repo's own installed vitest instead of `npm install`-ing one
  // into the fixture (no network access, no per-run install cost).
  symlinkSync(resolve(REPO_ROOT, "node_modules"), join(fixtureDir, "node_modules"));
  writeFileSync(
    join(fixtureDir, "package.json"),
    JSON.stringify({ name: "artgraph-vitest-runner-fixture", private: true, type: "module" }),
  );
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  mkdirSync(join(fixtureDir, "tests"), { recursive: true });

  // src/util.js — a shared helper, exercised by both signIn and
  // resetPassword (the "noise" research.md R1 documented: shared helpers
  // legitimately show up in more than one REQ's hits; only ingest's
  // sharedThreshold, not the runner, is responsible for downgrading it).
  writeFileSync(
    join(fixtureDir, "src/util.js"),
    'export function validateEmail(email) {\n  return typeof email === "string" && email.includes("@");\n}\n',
  );

  // src/auth.js — signIn/resetPassword both call validateEmail; chargeCard
  // is never called by REQ-001/REQ-002's tests, so it's the negative-control
  // function for the per-test-isolation assertions (a)/(b).
  writeFileSync(
    join(fixtureDir, "src/auth.js"),
    [
      'import { validateEmail } from "./util.js";',
      "",
      "export function signIn(email, password) {",
      '  return validateEmail(email) && typeof password === "string" && password.length > 0;',
      "}",
      "",
      "export function resetPassword(email) {",
      "  return validateEmail(email);",
      "}",
      "",
      "export function chargeCard(amountCents) {",
      '  if (amountCents < 0) throw new Error("amount must be non-negative");',
      "  return true;",
      "}",
      "",
    ].join("\n"),
  );

  // tests/auth.test.js — one file covering every T005 perspective: tagged
  // pass (REQ-001/002), tagged fail (REQ-003), untagged pass, a test whose
  // BODY throws (not just a failed assertion), `it.concurrent`
  // (REQ-004, must NOT get a test/coverage record), a test that calls
  // nothing tracked (REQ-005, module-init-only ⇒ empty hits), and a
  // snapshot test (⑦/G2 — runner-active snapshot behavior must be
  // unaffected).
  writeFileSync(
    join(fixtureDir, "tests/auth.test.js"),
    [
      'import { describe, it, expect } from "vitest";',
      'import { signIn, resetPassword } from "../src/auth.js";',
      "",
      'describe("auth", () => {',
      '  it("[REQ-001] signIn accepts valid credentials", () => {',
      '    expect(signIn("user@example.com", "hunter2")).toBe(true);',
      "  });",
      "",
      '  it("[REQ-002] resetPassword accepts a valid email", () => {',
      '    expect(resetPassword("user@example.com")).toBe(true);',
      "  });",
      "",
      '  it("[REQ-003] a deliberately failing assertion", () => {',
      '    expect(signIn("user@example.com", "hunter2")).toBe(false);',
      "  });",
      "",
      '  it("an untagged test that also exercises signIn", () => {',
      '    expect(signIn("user@example.com", "hunter2")).toBe(true);',
      "  });",
      "",
      '  it("a genuinely throwing test", () => {',
      '    throw new Error("boom");',
      "  });",
      "",
      '  it.concurrent("[REQ-004] concurrent test is not attributed", async () => {',
      '    expect(signIn("user@example.com", "hunter2")).toBe(true);',
      "  });",
      "",
      '  it("[REQ-005] module-init only, no library calls", () => {',
      "    expect(1 + 1).toBe(2);",
      "  });",
      "",
      '  it("a snapshot test", () => {',
      '    expect({ a: 1, b: "two" }).toMatchSnapshot();',
      "  });",
      "});",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(fixtureDir, "vitest.config.mjs"),
    // Plain object, not `defineConfig` from "vitest/config" — resolving
    // that specifier from the config file's own location would walk up
    // from a tmpdir path and never find this repo's node_modules (only the
    // *test files* benefit from the symlink above; the config file is
    // loaded by Vite's own config loader, before that symlink is on its
    // resolution path in every environment).
    `export default {\n  test: {\n    include: ["tests/**/*.test.js"],\n    runner: ${JSON.stringify(
      RUNNER_PATH,
    )},\n  },\n};\n`,
  );

  // spec 021 (tasks.md T010) — the SAME fixture (auth.js/util.js/
  // auth.test.js above) run through the `instrument` engine instead: the
  // plugin is injected via `plugins` (an actual Plugin instance — unlike
  // `runner`/`globalSetup`, which are plain path strings Vitest resolves
  // itself, `plugins` needs a real object, so this config file DOES import
  // the plugin factory — an absolute `dist/` path, so it resolves
  // regardless of the tmpdir fixture's own module-resolution path). Also
  // wires this package's `globalSetup` directly (generation cleanup — spec
  // 020, unrelated to engine choice) to prove it still works without
  // `withTrace()` (T015, out of scope here).
  writeFileSync(
    join(fixtureDir, "vitest.config.instrument.mjs"),
    [
      `import tracePlugin from ${JSON.stringify(PLUGIN_PATH)};`,
      "export default {",
      "  plugins: [tracePlugin()],",
      "  test: {",
      '    include: ["tests/**/*.test.js"],',
      `    runner: ${JSON.stringify(RUNNER_PATH)},`,
      `    globalSetup: [${JSON.stringify(SETUP_PATH)}],`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  // spec 021 (tasks.md T010) — dedicated fixture for the worker-kill /
  // partial-shard scenario: two test files so a within-worker file-boundary
  // flush (V6) actually occurs, isolated under its own `include` glob (and
  // its own directory, `partial-tests/`) so this scenario never mixes with
  // — or adds noise to — the `tests/**` fixtures the other describe blocks
  // (including the untouched `cdp` ones) rely on.
  mkdirSync(join(fixtureDir, "partial-tests"), { recursive: true });
  writeFileSync(
    join(fixtureDir, "partial-tests/a.test.js"),
    [
      'import { describe, it, expect } from "vitest";',
      'describe("partial a", () => {',
      '  it("a1", () => { expect(1 + 1).toBe(2); });',
      '  it("a2", () => { expect(2 + 2).toBe(4); });',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureDir, "partial-tests/b.test.js"),
    [
      'import { describe, it, expect } from "vitest";',
      'describe("partial b", () => {',
      '  it("b1 fast", () => { expect(true).toBe(true); });',
      "  it(",
      '    "b2 slow",',
      "    async () => {",
      "      await new Promise((r) => setTimeout(r, 8000));",
      "      expect(true).toBe(true);",
      "    },",
      "    20000,",
      "  );",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureDir, "vitest.config.partial-instrument.mjs"),
    [
      `import { BaseSequencer } from "vitest/node";`,
      `import tracePlugin from ${JSON.stringify(PLUGIN_PATH)};`,
      "",
      // Vitest's default sequencer order is NOT filename-alphabetical (it's
      // a size/duration-cache heuristic) — this scenario needs file `a`
      // (fast) to run, flush, and complete BEFORE file `b` (slow) starts,
      // so the boundary flush this test polls for is deterministic across
      // runs/environments rather than depending on that heuristic.
      "class AlphaSequencer extends BaseSequencer {",
      "  async sort(files) {",
      "    return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));",
      "  }",
      "}",
      "",
      "export default {",
      "  plugins: [tracePlugin()],",
      "  test: {",
      '    include: ["partial-tests/**/*.test.js"],',
      `    runner: ${JSON.stringify(RUNNER_PATH)},`,
      // Force both files into ONE worker, sequentially, WITHOUT per-file
      // re-isolation (`isolate: false`) — otherwise vitest gives each test
      // file its own fresh runner instance (its own shard/meta line), and
      // the within-worker file-BOUNDARY flush this scenario is built to
      // exercise would never happen (each file's only flush would be its
      // own final `onAfterRunFiles`, `b`'s worker never reaching one
      // before the kill). `poolOptions.*.singleFork`/`singleThread` were
      // removed in Vitest 4 (now top-level `forks.singleFork` /
      // `threads.singleThread`).
      "    fileParallelism: false,",
      "    isolate: false,",
      '    pool: "forks",',
      "    forks: { singleFork: true },",
      "    sequence: { sequencer: AlphaSequencer },",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}, 30000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RunVitestOptions {
  /** Absolute path to a config file, defaulting to the `cdp`-path fixture's
   * `vitest.config.mjs` — every pre-021 call site keeps that default. */
  configPath?: string;
  /** Extra env vars layered on top of the base env (e.g.
   * `ARTGRAPH_TRACE_ENGINE`) — spec 021 T010's instrument-engine scenarios
   * use this; no pre-021 call site passes it. */
  extraEnv?: Record<string, string>;
}

function runVitest(
  pool: "forks" | "threads",
  traceDir: string,
  root = fixtureDir,
  opts: RunVitestOptions = {},
): RunResult {
  mkdirSync(traceDir, { recursive: true });
  const env = {
    ...process.env,
    ARTGRAPH_TRACE_DIR: traceDir,
    // spec 021: the runner's engine now defaults to `instrument`, but this
    // fixture's `vitest.config.mjs` sets ONLY `test.runner` (no plugin) —
    // exactly the "従来どおり動作する" `test.runner`-direct configuration
    // contracts/config-surface.md documents, which now REQUIRES this pin to
    // keep exercising the `cdp`/inspector path every pre-021 call site here
    // was written to test. `extraEnv` (spec 021's instrument-engine call
    // sites) overrides this below.
    ARTGRAPH_TRACE_ENGINE: "cdp",
    // Force deterministic "create missing snapshots and pass" behavior
    // regardless of the ambient CI environment this suite itself runs
    // under (vitest defaults to `updateSnapshot: "none"` — a hard fail on
    // a missing snapshot — when it detects CI).
    UPDATE_SNAPSHOT: "new",
    ...opts.extraEnv,
  };
  const r = spawnSync(
    "node",
    [
      VITEST_BIN,
      "run",
      "--root",
      root,
      "--config",
      opts.configPath ?? join(root, "vitest.config.mjs"),
      "--pool",
      pool,
    ],
    { cwd: root, encoding: "utf-8", env, timeout: 30000 },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readShards(traceDir: string): ParsedShard[] {
  return readdirSync(traceDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => parseShardLines(readFileSync(join(traceDir, f), "utf-8")));
}

// (b) ②分岐組合せ: pool {forks, threads} × テスト {pass, fail} × タグ
// {あり, なし} の行列 — running the full assertion set under both pools
// covers the matrix; each pool gets its own trace dir so runs never mix.
describe.each(["forks", "threads"] as const)("vitest runner e2e — pool=%s", (pool) => {
  let traceDir: string;
  let shards: ParsedShard[];
  let trace: ReturnType<typeof normalizeTrace>;
  let run: RunResult;

  beforeAll(() => {
    traceDir = join(fixtureDir, `.trace-${pool}`);
    run = runVitest(pool, traceDir);
    shards = readShards(traceDir);
    trace = normalizeTrace(shards);
  }, 30000);

  it("ran (and the fixture's intentional failures are the only reason for a nonzero exit)", () => {
    // REQ-003 and the throwing test are DESIGNED to fail — vitest itself
    // exits non-zero for that. The assertion here is just that the process
    // actually completed (didn't crash before writing any shard).
    expect(run.status === 0 || run.status === 1).toBe(true);
  });

  it("produced at least one shard, none corrupted or on an unknown schema", () => {
    expect(shards.length).toBeGreaterThan(0);
    for (const shard of shards) {
      expect(shard.corruptedLines).toBe(0);
      expect(shard.unknownSchema).toBe(false);
    }
  });

  // (a) per-test 分離: REQ-001 レコードの hits に signIn を含み
  // resetPassword/chargeCard を含まない
  it("REQ-001's record hits signIn but never resetPassword/chargeCard", () => {
    const rec = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
    expect(rec).toBeDefined();
    expect(rec!.hits.some((h) => h.fn === "signIn")).toBe(true);
    expect(rec!.hits.some((h) => h.fn === "resetPassword")).toBe(false);
    expect(rec!.hits.some((h) => h.fn === "chargeCard")).toBe(false);
  });

  it("REQ-002's record hits resetPassword but never signIn/chargeCard", () => {
    const rec = trace.tests.find((t) => t.testName.includes("[REQ-002]"));
    expect(rec).toBeDefined();
    expect(rec!.hits.some((h) => h.fn === "resetPassword")).toBe(true);
    expect(rec!.hits.some((h) => h.fn === "signIn")).toBe(false);
    expect(rec!.hits.some((h) => h.fn === "chargeCard")).toBe(false);
  });

  // (b) pass/fail フラグ正確性、タグあり/なし双方の記録
  it("records passed:true for a passing tagged test, passed:false for a failing tagged test", () => {
    const passing = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
    const failing = trace.tests.find((t) => t.testName.includes("[REQ-003]"));
    expect(passing?.passed).toBe(true);
    expect(failing?.passed).toBe(false);
  });

  it("records an untagged passing test with its real hits", () => {
    const rec = trace.tests.find(
      (t) => t.testName === "an untagged test that also exercises signIn",
    );
    expect(rec).toBeDefined();
    expect(rec!.passed).toBe(true);
    expect(rec!.hits.some((h) => h.fn === "signIn")).toBe(true);
  });

  // (c) ③不正遷移: it.concurrent → skipped/concurrent, カバレッジレコードは出ない
  it("records it.concurrent as skipped/concurrent with no coverage/test record", () => {
    const skipped = trace.skipped.find((s) => s.testName.includes("[REQ-004]"));
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toBe("concurrent");
    const testRec = trace.tests.find((t) => t.testName.includes("[REQ-004]"));
    expect(testRec).toBeUndefined();
  });

  // (d) ⑥エッジ: module-init のみ実行するテスト → hits 空
  it("records an empty hits array for a test that calls no tracked functions", () => {
    const rec = trace.tests.find((t) => t.testName.includes("[REQ-005]"));
    expect(rec).toBeDefined();
    expect(rec!.hits).toEqual([]);
  });

  // (d) テストファイル自身・node_modules が hits に現れない(全レコード横断)
  it("never records a hit inside a test file or node_modules", () => {
    let checked = 0;
    for (const t of trace.tests) {
      for (const hit of t.hits) {
        checked++;
        expect(hit.file).not.toMatch(/\.test\.js$/);
        expect(hit.file).not.toContain("node_modules");
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // (e) ④失敗時: テストが throw してもランナーが shard を壊さない
  it("still yields a parseable shard after a test throws synchronously", () => {
    const thrown = trace.tests.find((t) => t.testName === "a genuinely throwing test");
    expect(thrown).toBeDefined();
    expect(thrown!.passed).toBe(false);
    // A record for a LATER test (in source order) is present too — proving
    // the throw didn't truncate/corrupt the shard for subsequent tests
    // (corroborated by the zero-corruptedLines assertion above).
    const later = trace.tests.find((t) => t.testName.includes("[REQ-005]"));
    expect(later).toBeDefined();
  });

  // ⑦/G2: 既存スナップショットテストの作成・照合挙動が runner 有効時も不変
  it("a snapshot test passes with the runner active (create on first run, match thereafter)", () => {
    const rec = trace.tests.find((t) => t.testName === "a snapshot test");
    expect(rec).toBeDefined();
    expect(rec!.passed).toBe(true);
  });

  // FR-005: hashes は runner が記録し、既存の file-mode contentHash アルゴリズム
  // (sha256, BOM-stripped, 16 hex chars) と一致する形式
  it("records a hashes entry for every hit file, in the file-mode contentHash format", () => {
    const rec = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
    expect(rec).toBeDefined();
    expect(Object.keys(rec!.hashes).length).toBeGreaterThan(0);
    for (const hit of rec!.hits) {
      expect(rec!.hashes[hit.file]).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

// macOS CI regression (PR #240) — `os.tmpdir()` on macOS is itself a symlink
// (`/var/folders/…` → `/private/var/folders/…`), so vitest's configured
// `root` and the symlink-RESOLVED paths V8 reports in coverage URLs spell
// the same directory two different ways. Pre-fix, `toRelPath` relativized
// against the configured spelling only, every hit walked out via `..`, and
// the runner silently recorded zero hits. Reproduced portably by running the
// same fixture through an explicit symlinked root.
describe("vitest runner e2e — symlinked project root (macOS tmpdir regression)", () => {
  let linkRoot: string;

  afterAll(() => {
    if (linkRoot) rmSync(linkRoot, { recursive: false, force: true });
  });

  it("still records hits when --root is a symlink to the real fixture", () => {
    linkRoot = `${fixtureDir}-link`;
    symlinkSync(fixtureDir, linkRoot);
    const traceDir = join(fixtureDir, ".trace-symlink-root");
    const run = runVitest("forks", traceDir, linkRoot);
    expect(run.status === 0 || run.status === 1).toBe(true);

    const trace = normalizeTrace(readShards(traceDir));
    const rec = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
    expect(rec).toBeDefined();
    expect(rec!.hits.length).toBeGreaterThan(0);
    expect(rec!.hits.some((h) => h.fn === "signIn")).toBe(true);
  });
});

// spec 021 (tasks.md T010) — instrument engine (v2) E2E: the SAME auth
// fixture as the `pool=%s` suite above, run through `vitest.config.
// instrument.mjs` (plugin injected via `plugins`, `ARTGRAPH_TRACE_ENGINE=
// instrument`) instead of `test.runner` alone. The `cdp` suite above is
// untouched — this is a parallel scenario, not a replacement (T016's
// engine-matrix generalization is a separate, later task).
describe.each(["forks", "threads"] as const)(
  "vitest runner e2e — instrument engine, pool=%s",
  (pool) => {
    let traceDir: string;
    let shards: ParsedShard[];
    let trace: ReturnType<typeof normalizeTrace>;
    let run: RunResult;

    beforeAll(() => {
      traceDir = join(fixtureDir, `.trace-instrument-${pool}`);
      run = runVitest(pool, traceDir, fixtureDir, {
        configPath: join(fixtureDir, "vitest.config.instrument.mjs"),
        extraEnv: { ARTGRAPH_TRACE_ENGINE: "instrument" },
      });
      shards = readShards(traceDir);
      trace = normalizeTrace(shards);
    }, 30000);

    it("ran (the fixture's intentional failures are the only reason for a nonzero exit)", () => {
      expect(run.status === 0 || run.status === 1).toBe(true);
    });

    it("produced at least one shard, none corrupted or on an unknown schema, meta first", () => {
      expect(shards.length).toBeGreaterThan(0);
      for (const shard of shards) {
        expect(shard.corruptedLines).toBe(0);
        expect(shard.unknownSchema).toBe(false);
        expect(shard.meta).toBeDefined();
      }
    });

    it("REQ-001's record hits signIn but never resetPassword/chargeCard (same per-test isolation as cdp)", () => {
      const rec = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
      expect(rec).toBeDefined();
      expect(rec!.hits.some((h) => h.fn === "signIn")).toBe(true);
      expect(rec!.hits.some((h) => h.fn === "resetPassword")).toBe(false);
      expect(rec!.hits.some((h) => h.fn === "chargeCard")).toBe(false);
    });

    it("records passed:true/false correctly for tagged tests", () => {
      const passing = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
      const failing = trace.tests.find((t) => t.testName.includes("[REQ-003]"));
      expect(passing?.passed).toBe(true);
      expect(failing?.passed).toBe(false);
    });

    it("records it.concurrent as skipped/concurrent, no coverage/test record", () => {
      const skipped = trace.skipped.find((s) => s.testName.includes("[REQ-004]"));
      expect(skipped).toBeDefined();
      expect(skipped!.reason).toBe("concurrent");
      expect(trace.tests.find((t) => t.testName.includes("[REQ-004]"))).toBeUndefined();
    });

    it("records an empty hits array for a test that calls no tracked functions", () => {
      const rec = trace.tests.find((t) => t.testName.includes("[REQ-005]"));
      expect(rec).toBeDefined();
      expect(rec!.hits).toEqual([]);
    });

    it("never records a hit inside a test file or node_modules", () => {
      let checked = 0;
      for (const t of trace.tests) {
        for (const hit of t.hits) {
          checked++;
          expect(hit.file).not.toMatch(/\.test\.js$/);
          expect(hit.file).not.toContain("node_modules");
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("still yields a parseable shard after a test throws synchronously", () => {
      const thrown = trace.tests.find((t) => t.testName === "a genuinely throwing test");
      expect(thrown).toBeDefined();
      expect(thrown!.passed).toBe(false);
    });

    it("a snapshot test passes with the instrument engine active", () => {
      const rec = trace.tests.find((t) => t.testName === "a snapshot test");
      expect(rec).toBeDefined();
      expect(rec!.passed).toBe(true);
    });

    // V5 / FR-005: hashes match the file-mode contentHash algorithm — for the
    // instrument engine this is computed at TRANSFORM time from disk content
    // (not per-test), so this also confirms the plugin's V5 hash reached the
    // shard unchanged through the registry → drain → shard pipeline.
    it("records a hashes entry for every hit file, matching sha256(disk content) truncated to 16 hex chars", () => {
      const rec = trace.tests.find((t) => t.testName.includes("[REQ-001]"));
      expect(rec).toBeDefined();
      expect(Object.keys(rec!.hashes).length).toBeGreaterThan(0);
      for (const hit of rec!.hits) {
        const hash = rec!.hashes[hit.file];
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
        expect(hash).toBe(hashContent(readFileSync(resolve(fixtureDir, hit.file), "utf-8")));
      }
    });
  },
);

// spec 021 (tasks.md T010) — generation management (spec 020's globalSetup
// shard cleanup) still works when wired directly (no `withTrace()`) under
// the instrument engine: a stale leftover `*.jsonl` from a hypothetical
// prior interrupted run must be gone once a fresh run starts.
describe("vitest runner e2e — instrument engine, generation management (globalSetup cleanup)", () => {
  it("deletes a stale leftover shard before writing this run's own shards", () => {
    const traceDir = join(fixtureDir, ".trace-instrument-generation");
    mkdirSync(traceDir, { recursive: true });
    const staleShard = join(traceDir, "stale-leftover-run.jsonl");
    writeFileSync(staleShard, '{"kind":"meta","schemaVersion":1}\n', "utf-8");
    expect(existsSync(staleShard)).toBe(true);

    const run = runVitest("forks", traceDir, fixtureDir, {
      configPath: join(fixtureDir, "vitest.config.instrument.mjs"),
      extraEnv: { ARTGRAPH_TRACE_ENGINE: "instrument" },
    });
    expect(run.status === 0 || run.status === 1).toBe(true);

    expect(existsSync(staleShard)).toBe(false); // globalSetup deleted it before this run wrote anything
    const shards = readShards(traceDir);
    expect(shards.length).toBeGreaterThan(0);
    for (const shard of shards) expect(shard.corruptedLines).toBe(0);
  });
});

// spec 021 (tasks.md T010, research.md V6, 観点5) — worker kill mid-run: the
// batch-flush design means a kill can only lose the still-buffered batch
// (at most one test file's worth since the last flush) — everything
// flushed before the kill must remain a column of complete, individually-
// parseable JSONL lines. `partial-tests/{a,b}.test.js` + the
// `singleFork`/`singleThread` config force both files into ONE worker so a
// within-worker file-boundary flush (V6) actually happens before the kill.
describe("vitest runner e2e — instrument engine, worker kill mid-run (partial shard integrity)", () => {
  it("the shard content flushed before a SIGKILL is still a column of complete JSONL lines", async () => {
    const traceDir = join(fixtureDir, ".trace-partial-kill");
    mkdirSync(traceDir, { recursive: true });
    const env = {
      ...process.env,
      ARTGRAPH_TRACE_DIR: traceDir,
      ARTGRAPH_TRACE_ENGINE: "instrument",
      UPDATE_SNAPSHOT: "new",
    };
    const child = spawn(
      "node",
      [
        VITEST_BIN,
        "run",
        "--root",
        fixtureDir,
        "--config",
        join(fixtureDir, "vitest.config.partial-instrument.mjs"),
        "--pool",
        "forks",
      ],
      // `detached: true` puts the CLI process in its OWN process group, so
      // `process.kill(-pgid, …)` below reaches its `--pool forks` WORKER
      // child too — SIGKILL to the CLI process alone leaves the worker (a
      // grandchild) orphaned and free to keep running to completion in the
      // background, which would let `b2 slow` finish and flush anyway,
      // defeating the entire scenario.
      { cwd: fixtureDir, env, detached: true },
    );

    // Poll for evidence that file `a`'s records were flushed at the
    // boundary into file `b` (i.e. `b`'s first test has already run) —
    // this is well before `b`'s SECOND test's 8s sleep completes, giving a
    // wide, non-flaky window to kill inside.
    const sawBoundaryFlush = await waitForShardContaining(traceDir, '"a2"', 15000);
    try {
      process.kill(-child.pid!, "SIGKILL"); // negative pid = the whole process group
    } catch {
      child.kill("SIGKILL"); // fallback, e.g. if the group already exited
    }
    await new Promise<void>((res) => child.on("exit", () => res()));

    expect(sawBoundaryFlush).toBe(true);
    const shards = readShards(traceDir);
    expect(shards.length).toBeGreaterThan(0);
    for (const shard of shards) {
      expect(shard.corruptedLines).toBe(0); // every flushed byte is a complete JSONL line
    }

    const trace = normalizeTrace(shards);
    expect(trace.tests.some((t) => t.testName === "a2")).toBe(true);
    // The slow test's record was never flushed — killed well before it
    // could finish (let alone reach a boundary/final flush) — proving we
    // lose AT MOST the still-buffered batch, not the whole shard.
    expect(trace.tests.some((t) => t.testName === "b2 slow")).toBe(false);
  }, 30000);
});

function waitForShardContaining(
  traceDir: string,
  marker: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolvePromise) => {
    const check = () => {
      if (existsSync(traceDir)) {
        for (const f of readdirSync(traceDir)) {
          if (!f.endsWith(".jsonl")) continue;
          if (readFileSync(join(traceDir, f), "utf-8").includes(marker)) {
            resolvePromise(true);
            return;
          }
        }
      }
      if (Date.now() - start >= timeoutMs) {
        resolvePromise(false);
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}
