// issue #351 — resource-exhaustion (EMFILE/ENFILE) exit/diagnostic-contract
// unification across the trace chain (`buildSymbolNameTable` /
// `createTSParser().parse()` / `ingestTrace`). Before this fix:
//
//   - Window A (`buildGraph()`'s own internal `ingestTrace()` call, reached
//     via `scan()`) was caught by the generic `withFatalErrors` wrap, but
//     lost its dedicated framing, broke plain `check`'s documented exit-0
//     contract, and dropped the JSON payload entirely.
//   - Window B (`check.ts` / `impact.ts` / `trace.ts` each calling their OWN
//     independent `ingestTrace()` a SECOND time, completely unguarded) was a
//     genuine, uncaught crash — confirmed via stack trace during the Step
//     0-pre investigation.
//
// This suite pins the FIXED behavior: the trace chain degrades fail-safe
// end-to-end, `warnings` carries `system-resource-exhausted`, and every
// command's exit/diagnostic contract holds. Follows the `vi.mock("fast-glob")`
// EMFILE-simulator pattern established by
// tests/check-gate-resource-exhausted.test.ts.

const globControl = vi.hoisted(() => ({
  failCode: undefined as string | undefined,
}));

vi.mock("fast-glob", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("fast-glob") }>();
  const realDefault = actual.default as unknown as {
    sync: (...args: unknown[]) => string[];
  } & ((...args: unknown[]) => unknown);
  const wrapped = Object.assign(
    (...args: unknown[]) => (realDefault as (...a: unknown[]) => unknown)(...args),
    realDefault,
    {
      sync: (...args: unknown[]) => {
        if (globControl.failCode) {
          const err = new Error(
            `simulated ${globControl.failCode} in fast-glob.sync`,
          ) as NodeJS.ErrnoException;
          err.code = globControl.failCode;
          throw err;
        }
        return realDefault.sync(...args);
      },
    },
  );
  return { default: wrapped };
});

// Scenario 8 (single-ingest) — spy on `buildSymbolNameTable` (the trace
// chain's own re-parse) so a test can assert it runs at MOST once per CLI
// command invocation, even though `check`/`impact`/`trace status` each used
// to call `ingestTrace` (and therefore `buildSymbolNameTable`) a second,
// independent time before issue #351's "Window B" elimination.
//
// `failDuringCall`, when true, flips the (fast-glob-backed) `globControl`
// EMFILE simulator on ONLY for the duration of the real `buildSymbolNameTable`
// call and restores it immediately after — isolating the trace-chain's OWN
// re-parse as the sole EMFILE source while `buildGraph`'s earlier, unrelated
// glob calls (spec-file discovery, the main `codeFiles` glob) stay healthy.
// This reproduces a graph that resolves normally (so `impact <file>` has a
// real start node to walk) while still exercising the exact guarded code
// path this issue fixes — a blanket, everything-fails simulation (used by
// the check/trace/init suites below, where a healthy graph isn't needed)
// would otherwise leave `impact` with an empty graph and no start node to
// resolve, forcing every scenario onto the same "no matching nodes" branch.
const symbolTableControl = vi.hoisted(() => ({ calls: 0, failDuringCall: false }));
vi.mock("../src/trace/symbol-table.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trace/symbol-table.js")>();
  return {
    ...actual,
    buildSymbolNameTable: (...args: Parameters<typeof actual.buildSymbolNameTable>) => {
      symbolTableControl.calls++;
      if (!symbolTableControl.failDuringCall) {
        return actual.buildSymbolNameTable(...args);
      }
      globControl.failCode = "EMFILE";
      try {
        return actual.buildSymbolNameTable(...args);
      } finally {
        globControl.failCode = undefined;
      }
    },
  };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { runInit } from "../src/init.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  globControl.failCode = undefined;
  symbolTableControl.calls = 0;
  symbolTableControl.failDuringCall = false;
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

// Fixture: spec.md defines REQ-4301 (a plain @impl'd REQ, for the
// check-payload-shape assertions) and REQ-4302 (evidence-only — reached only
// via the trace shard's hit on `chargeFn`, so a healthy run's `--tests`
// selection / trace classification has something non-empty to assert
// against — see the "negative test" note on scenario 3 below).
function writeFixture(root: string): void {
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".artgraph", "trace"), { recursive: true });
  writeFileSync(
    join(root, "specs", "spec.md"),
    [
      "# Spec",
      "",
      "- REQ-4301: needs coverage",
      "- REQ-4302: chargeFn does the thing (evidence-only)",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "a.ts"),
    [
      "export const a = 1;",
      "// @impl REQ-4301",
      "",
      "export function chargeFn(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.ts"],
      mode: "symbol",
    }),
  );
  writeFileSync(
    join(root, ".artgraph", "trace", "w1.jsonl"),
    [
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        kind: "meta",
        runToken: "run-1",
        pool: "forks",
        vitest: "4.1.10",
        startedAt: "2026-07-18T00:00:00Z",
      }),
      JSON.stringify({
        kind: "test",
        // Built via template interpolation, not a contiguous bracket+id
        // literal, so this repo's OWN dogfood `artgraph check` never
        // mistakes this fixture for a real test-title tag — same convention
        // as `tests/helpers.ts`'s `introduceNewOrphan`/`coverDebtReq`. The
        // runtime string produced is identical either way.
        testName: `[${"REQ-4302"}] charges correctly`,
        suitePath: [],
        testFile: "tests/a.test.ts",
        passed: true,
        hits: [{ file: "src/a.ts", fn: "chargeFn" }],
        hashes: {},
      }),
    ].join("\n"),
  );
}

function makeFixture(prefix: string): string {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  writeFixture(root);
  return root;
}

// ---------------------------------------------------------------------------
// (1)/(2) plain `check` / `check --gate` + chain EMFILE
// ---------------------------------------------------------------------------

describe("artgraph check: trace-chain EMFILE (issue #351 HIGH-1a/1b regression)", () => {
  it("plain check: exit 0 (docs' exit-0 contract holds), warnings carries system-resource-exhausted, JSON payload complete", async () => {
    const root = makeFixture("artgraph-351-check-plain-");
    globControl.failCode = "EMFILE";

    const result = await runCli(["check", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    // Complete payload — every documented top-level field present and
    // correctly typed, not truncated/crashed mid-way.
    expect(Array.isArray(payload.drifted)).toBe(true);
    expect(Array.isArray(payload.orphans)).toBe(true);
    expect(Array.isArray(payload.uncovered)).toBe(true);
    expect(Array.isArray(payload.coverage)).toBe(true);
    expect(Array.isArray(payload.testFailures)).toBe(true);
    expect(typeof payload.pass).toBe("boolean");
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect(
      payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
    ).toBe(true);
  });

  it("check --gate: exit 1 (undeterminable), dedicated stderr message, JSON payload still present", async () => {
    const root = makeFixture("artgraph-351-check-gate-");
    globControl.failCode = "EMFILE";

    const result = await runCli(["check", "--gate", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    expect(result.stderr).toMatch(/undetermined/i);
    const payload = JSON.parse(result.stdout);
    expect(
      payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) `impact` — basic / --diff / --tests, early-exit paths included
// ---------------------------------------------------------------------------

describe("artgraph impact: trace-chain EMFILE (issue #351 exit/diagnostic contract)", () => {
  it("basic mode (explicit target): exit 1, undetermined stderr, payload preserved (graph resolves normally — only the trace-chain re-parse hits EMFILE)", async () => {
    const root = makeFixture("artgraph-351-impact-basic-");
    symbolTableControl.failDuringCall = true;

    const result = await runCli(["impact", "src/a.ts", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    expect(result.stderr).toMatch(/undetermined/i);
    const payload = JSON.parse(result.stdout);
    // The main scan was healthy (only buildSymbolNameTable's own re-parse
    // failed) — src/a.ts still resolves as a real start node, so the payload
    // is the FULL, normal impact result, not an early-exit stub.
    expect(payload.affectedFiles).toEqual(["src/a.ts"]);
    expect(payload.impactReqs).toContain("REQ-4301");
  });

  it("--tests mode: exit 1 even on the trace-selection path, payload preserved", async () => {
    const root = makeFixture("artgraph-351-impact-tests-");
    symbolTableControl.failDuringCall = true;

    const result = await runCli(["impact", "src/a.ts", "--tests", "--format", "json"], {
      cwd: root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    const payload = JSON.parse(result.stdout);
    expect(payload.affectedFiles).toEqual(["src/a.ts"]);
    // `--tests` selection itself is necessarily empty/unreliable (the trace
    // re-parse that would have produced it is exactly what failed) — the
    // point of this test is that the REST of the payload (and the exit code)
    // still reflects "undetermined", not that testsToRun has real content.
    expect(Array.isArray(payload.testsToRun)).toBe(true);
  });

  it("--diff early-exit ('no changes detected' path): still forced to exit 1 under resource exhaustion", async () => {
    const root = makeFixture("artgraph-351-impact-diff-noop-");
    // No git repo at all — getGitDiffFiles resolves an empty diff without
    // git being present is NOT guaranteed, so make this a real (clean) repo.
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "init"], {
      cwd: root,
      stdio: "pipe",
    });
    globControl.failCode = "EMFILE";

    const result = await runCli(["impact", "--diff", "--format", "json"], { cwd: root });

    // The diff itself is genuinely empty (clean tree) — this early-exit path
    // used to be an unconditional exit 0. Resource exhaustion must still win.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toBe("No changes detected in git diff.");
  });

  it("negative test: same fixture WITHOUT resource exhaustion → exit 0, and the trace-selection path is provably exercised (testsToRun non-empty)", async () => {
    const root = makeFixture("artgraph-351-impact-negative-");
    // globControl.failCode left undefined — no EMFILE this run.

    const result = await runCli(["impact", "src/a.ts", "--tests", "--format", "json"], {
      cwd: root,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/system-resource-exhausted/);
    const payload = JSON.parse(result.stdout);
    // Discriminates "the code path was actually reached and produced real
    // trace evidence" from "exited early for an unrelated reason" — a
    // vacuous negative test (e.g. one that early-exits before ever reaching
    // the trace chain) would leave this empty regardless of the fix under
    // test.
    expect(payload.testsToRun.length).toBeGreaterThan(0);
    expect(payload.testsToRun.some((t: { reqId: string }) => t.reqId === "REQ-4302")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (5) `trace status` / `trace report`
// ---------------------------------------------------------------------------

describe("artgraph trace status/report: trace-chain EMFILE (issue #351)", () => {
  it("trace status: does not crash, warnings[] carries the reason, dedicated stderr notice, exit code unchanged (0)", async () => {
    const root = makeFixture("artgraph-351-trace-status-");
    globControl.failCode = "EMFILE";

    const result = await runCli(["trace", "status", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(typeof payload.shardCount).toBe("number");
    expect(
      payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
    ).toBe(true);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
  });

  // issue #351 (H1 follow-on) — this test used to assert exit 0 here: before
  // H1's fix, `discoverShardPaths` (`src/trace/ingest.ts`) called the `glob`
  // package directly, which this suite's `vi.mock("fast-glob")` does NOT
  // intercept — so a blanket EMFILE simulation left shard DISCOVERY
  // unaffected (only `buildSymbolNameTable`'s fast-glob-based re-parse
  // degraded), and this fixture's real shard was still found. Now that
  // `discoverShardPaths` is fast-glob-based too (the whole point of H1), a
  // blanket EMFILE genuinely prevents confirming the shard exists —
  // `ingested.shardCount` degrades to 0, and `trace report`'s own
  // pre-existing "zero shards is a hard error" contract
  // (`src/commands/trace.ts`) correctly fires exit 1 instead of silently
  // reporting success it can no longer back up. This is the intended,
  // stricter behavior H1 introduces, not a regression.
  it("trace report: EMFILE that genuinely blinds shard discovery correctly refuses to report (exit 1, no silent success)", async () => {
    const root = makeFixture("artgraph-351-trace-report-");
    globControl.failCode = "EMFILE";

    const result = await runCli(["trace", "report", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no trace shards found/i);
  });
});

// ---------------------------------------------------------------------------
// (7) `init` — stage-continuation regression (HIGH-1d)
// ---------------------------------------------------------------------------

describe("runInit: trace-chain EMFILE (issue #351 HIGH-1d regression)", () => {
  it("scan() no longer throws on the trace-chain EMFILE; every stage still runs; lock write is skipped, not the whole init", async () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-init-")));
    // No .artgraph.json here — runInit generates its own via
    // `generateConfig`/`detectProject` (specs/ + src/ presence is enough for
    // it to produce a config that scans this fixture correctly).
    const { existsSync } = await import("node:fs");
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".artgraph", "trace"), { recursive: true });
    writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-4301: needs coverage\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-4301\n");
    writeFileSync(
      join(root, ".artgraph", "trace", "w1.jsonl"),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        kind: "meta",
        runToken: "run-1",
        pool: "forks",
        vitest: "4.1.10",
        startedAt: "2026-07-18T00:00:00Z",
      }),
    );

    globControl.failCode = "EMFILE";

    // Pre-#351, a chain EMFILE inside buildGraph's internal ingestTrace()
    // call made scan() throw uncaught, which propagated straight past
    // runInit's `reconcile()`-only try/catch and aborted the whole init
    // before the final `.artgraph.json` write below ever ran.
    const result = runInit(root, {});

    // The run completed (did not throw) and reached its LAST stage (the
    // config write) — proof every stage in between (scan/reconcile catch,
    // integrate, hooks, agent-context) also ran to completion.
    expect(existsSync(result.configPath)).toBe(true);
    expect(result.warnings.some((w) => w.type === "system-resource-exhausted")).toBe(true);
    // Lock write was skipped (reconcile refused), not init as a whole.
    expect(result.reconcileResourceExhausted).toBeDefined();
    expect(result.lockPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (8) single-ingest: buildSymbolNameTable runs at most once per invocation
// ---------------------------------------------------------------------------

describe("single-ingest (issue #351 Window B elimination)", () => {
  it("check: buildSymbolNameTable is called exactly once", async () => {
    const root = makeFixture("artgraph-351-single-ingest-check-");
    const result = await runCli(["check", "--format", "json"], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(symbolTableControl.calls).toBe(1);
  });

  it("impact --tests: buildSymbolNameTable is called exactly once", async () => {
    const root = makeFixture("artgraph-351-single-ingest-impact-");
    const result = await runCli(["impact", "src/a.ts", "--tests", "--format", "json"], {
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
    expect(symbolTableControl.calls).toBe(1);
  });

  it("trace status: buildSymbolNameTable is called exactly once (even though 'trace status' used to call ingestTrace directly)", async () => {
    const root = makeFixture("artgraph-351-single-ingest-trace-");
    const result = await runCli(["trace", "status", "--format", "json"], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(symbolTableControl.calls).toBe(1);
  });
});
