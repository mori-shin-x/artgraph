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
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseShardLines, normalizeTrace, type ParsedShard } from "../../src/trace/schema.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RUNNER_PATH = resolve(REPO_ROOT, "dist/vitest/runner.js");
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
}, 30000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runVitest(pool: "forks" | "threads", traceDir: string): RunResult {
  mkdirSync(traceDir, { recursive: true });
  const env = {
    ...process.env,
    ARTGRAPH_TRACE_DIR: traceDir,
    // Force deterministic "create missing snapshots and pass" behavior
    // regardless of the ambient CI environment this suite itself runs
    // under (vitest defaults to `updateSnapshot: "none"` — a hard fail on
    // a missing snapshot — when it detects CI).
    UPDATE_SNAPSHOT: "new",
  };
  const r = spawnSync(
    "node",
    [
      VITEST_BIN,
      "run",
      "--root",
      fixtureDir,
      "--config",
      join(fixtureDir, "vitest.config.mjs"),
      "--pool",
      pool,
    ],
    { cwd: fixtureDir, encoding: "utf-8", env, timeout: 30000 },
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
