// issue #351 review + meta-review findings (this PR):
//
//  - H1: `src/trace/ingest.ts`'s `discoverShardPaths` (and `src/rename-
//    trace.ts`'s copy) used the `glob` package directly, whose `globSync`
//    does not throw on EMFILE/ENFILE (silently returns `[]`) — the one
//    shard-discovery call site `src/glob-utils.ts`'s #335 header comment
//    calls out as still unmigrated. Both are now routed through
//    `listFilesGuarded` (fast-glob), so EMFILE/ENFILE is visible.
//  - L1: `check.ts`'s two `--diff` early-exit `process.exit(0)` blocks
//    (empty-diff, "not tracked in the graph") did not consult
//    `system-resource-exhausted`, so `check --diff --gate` could false-green
//    under resource exhaustion.
//  - H2 (defense): `impact.ts`'s pre-scan `hasTraceShards` probe and
//    `scan()`'s own post-scan probe (inside `buildGraph`) must agree; a
//    structural assertion now catches any other-than-EMFILE cause of
//    disagreement (e.g. a race) that would otherwise silently drop
//    `testsToRun` / `exercises` edges at exit 0.
//
// Follows the `vi.mock("fast-glob")` / `vi.mock("node:fs")` targeted-failure
// patterns established by tests/resource-exhaustion-trace-chain.test.ts and
// tests/resource-guard-tsconfig-glob.test.ts.

const globControl = vi.hoisted(() => ({
  failCode: undefined as string | undefined,
  // Optional predicate to scope the failure to specific glob patterns (e.g.
  // only the trace-shard glob) so a test can pin ONE enumeration site's
  // guard without also degrading spec-file/code-file discovery. Undefined =
  // fail every call (broad "process is out of fds" simulation).
  failWhen: undefined as ((pattern: unknown) => boolean) | undefined,
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
        if (globControl.failCode && (!globControl.failWhen || globControl.failWhen(args[0]))) {
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

function isTraceShardPattern(pattern: unknown): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => typeof p === "string" && p.includes(".artgraph/trace"));
}

const fsFailureControl = vi.hoisted(() => ({
  // path suffix -> { code, atCall } — simulate failure on the Nth
  // readFileSync call matching that suffix (1-indexed).
  failures: new Map<string, { code: string; atCall: number }>(),
  calls: new Map<string, number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (
      ...args: Parameters<typeof actual.readFileSync>
    ): ReturnType<typeof actual.readFileSync> => {
      const path = String(args[0] ?? "");
      for (const [suffix, { code, atCall }] of fsFailureControl.failures) {
        if (path.endsWith(suffix)) {
          const n = (fsFailureControl.calls.get(suffix) ?? 0) + 1;
          fsFailureControl.calls.set(suffix, n);
          if (n === atCall) {
            const err = new Error(`simulated ${code} reading ${path}`) as NodeJS.ErrnoException;
            err.code = code;
            throw err;
          }
          break;
        }
      }
      return actual.readFileSync(...args);
    },
  };
});

// H2 defense (issue #351) simulator: force ONLY the FIRST call to
// `hasTraceShards` within a single CLI invocation to lie (`present: true`)
// while every subsequent call (including `graph/builder.ts`'s own,
// independent probe inside `buildGraph`) runs the real implementation —
// reproducing "pre-scan probe said yes, post-scan probe found nothing" via a
// race-like mismatch WITHOUT needing an actual EMFILE.
const hasTraceShardsControl = vi.hoisted(() => ({
  forceFirstCallPresent: false,
  callCount: 0,
}));

vi.mock("../src/trace/ingest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trace/ingest.js")>();
  return {
    ...actual,
    hasTraceShards: (
      ...args: Parameters<typeof actual.hasTraceShards>
    ): ReturnType<typeof actual.hasTraceShards> => {
      hasTraceShardsControl.callCount++;
      if (hasTraceShardsControl.forceFirstCallPresent && hasTraceShardsControl.callCount === 1) {
        return { present: true, resourceExhausted: false };
      }
      return actual.hasTraceShards(...args);
    },
  };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { ingestTrace } from "../src/trace/ingest.js";
import { rewriteTraceShards } from "../src/rename-trace.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";
import type { ArtgraphConfig } from "../src/types.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}

afterEach(() => {
  globControl.failCode = undefined;
  globControl.failWhen = undefined;
  fsFailureControl.failures.clear();
  fsFailureControl.calls.clear();
  hasTraceShardsControl.forceFirstCallPresent = false;
  hasTraceShardsControl.callCount = 0;
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture: a scan-shape with a real trace shard carrying evidence for a
// second, evidence-only REQ (so `impact --tests`'s negative test has real
// content to assert against — same shape as
// tests/resource-exhaustion-trace-chain.test.ts's fixture).
// ---------------------------------------------------------------------------

function writeTraceFixture(root: string): void {
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".artgraph", "trace"), { recursive: true });
  writeFileSync(
    join(root, "specs", "spec.md"),
    [
      "# Spec",
      "",
      "- REQ-5301: needs coverage",
      "- REQ-5302: chargeFn does the thing (evidence-only)",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "a.ts"),
    [
      "export const a = 1;",
      "// @impl REQ-5301",
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
        testName: `[${"REQ-5302"}] charges correctly`,
        suitePath: [],
        testFile: "tests/a.test.ts",
        passed: true,
        hits: [{ file: "src/a.ts", fn: "chargeFn" }],
        hashes: {},
      }),
    ].join("\n"),
  );
}

function makeTraceFixture(prefix: string): string {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  writeTraceFixture(root);
  return root;
}

function makeGitFixture(prefix: string): string {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-5401: needs coverage\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-5401\n");
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
  );
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "init"], {
    cwd: root,
    stdio: "pipe",
  });
  return root;
}

// ---------------------------------------------------------------------------
// (1) shard-probe-only EMFILE (H1)
// ---------------------------------------------------------------------------

describe("shard-probe-only EMFILE (issue #351 H1): the trace-shard glob's silent-empty bug is now visible", () => {
  it("plain check: exit 0, system-resource-exhausted warning present (scoped to the shard glob only — spec/code files unaffected)", async () => {
    const root = makeTraceFixture("artgraph-351-shard-probe-check-");
    globControl.failCode = "EMFILE";
    globControl.failWhen = isTraceShardPattern;

    const result = await runCli(["check", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(
      payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
    ).toBe(true);
  });

  it("check --gate: dedicated undetermined message + exit 1 (not silently passing)", async () => {
    const root = makeTraceFixture("artgraph-351-shard-probe-gate-");
    globControl.failCode = "EMFILE";
    globControl.failWhen = isTraceShardPattern;

    const result = await runCli(["check", "--gate"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    expect(result.stderr).toMatch(/undetermined/i);
  });

  it("impact --tests: undetermined framing (NOT the 'no trace shards found' guidance) + exit 1", async () => {
    const root = makeTraceFixture("artgraph-351-shard-probe-impact-tests-");
    globControl.failCode = "EMFILE";
    globControl.failWhen = isTraceShardPattern;

    const result = await runCli(["impact", "src/a.ts", "--tests"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not determine whether trace shards exist/);
    expect(result.stderr).not.toMatch(/no trace shards found/i);
  });

  it("negative test: same fixture WITHOUT the shard-probe EMFILE → exit 0, testsToRun is provably non-empty (the trace-selection path is actually exercised)", async () => {
    const root = makeTraceFixture("artgraph-351-shard-probe-negative-");
    // globControl left unset — no EMFILE this run.

    const result = await runCli(["impact", "src/a.ts", "--tests", "--format", "json"], {
      cwd: root,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.testsToRun.length).toBeGreaterThan(0);
    expect(payload.testsToRun.some((t: { reqId: string }) => t.reqId === "REQ-5302")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (2) check --diff --gate early-exit blocks must respect resource
//     exhaustion (issue #351 L1 / 修正2)
// ---------------------------------------------------------------------------

describe("check --diff --gate: empty diff + resource exhaustion must not false-green (issue #351 L1 / 修正2a)", () => {
  it("clean working tree + blanket EMFILE → exit 1, dedicated undetermined message (was: unconditional exit 0)", async () => {
    const root = makeGitFixture("artgraph-351-check-diff-empty-gate-");
    globControl.failCode = "EMFILE";

    const result = await runCli(["check", "--diff", "--gate", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    expect(result.stderr).toMatch(/gate result is undetermined/);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toBe("No changes detected in git diff.");
    expect(
      payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
    ).toBe(true);
  });

  it("negative: clean working tree, no EMFILE → exit 0 (regression guard — proves the branch is genuinely reached)", async () => {
    const root = makeGitFixture("artgraph-351-check-diff-empty-gate-negative-");

    const result = await runCli(["check", "--diff", "--gate", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toBe("No changes detected in git diff.");
  });
});

describe("check --diff --gate: untracked-file diff + resource exhaustion must not false-green (issue #351 L1 / 修正2b)", () => {
  it("edit outside graph scope + blanket EMFILE → exit 1, same dedicated message, still reaches the 'not tracked' branch", async () => {
    const root = makeGitFixture("artgraph-351-check-diff-untracked-gate-");
    writeFileSync(join(root, "README.md"), "# Readme\n\nunrelated change\n");
    globControl.failCode = "EMFILE";

    const result = await runCli(["check", "--diff", "--gate", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    expect(result.stderr).toMatch(/gate result is undetermined/);
    const payload = JSON.parse(result.stdout);
    // Discriminates "reached THIS branch" from the diffFiles===0 branch above.
    expect(payload.message).toBe("Changed files are not tracked in the graph.");
  });

  it("negative: same edit, no EMFILE → exit 0, 'not tracked' message (regression guard)", async () => {
    const root = makeGitFixture("artgraph-351-check-diff-untracked-gate-negative-");
    writeFileSync(join(root, "README.md"), "# Readme\n\nunrelated change\n");

    const result = await runCli(["check", "--diff", "--gate", "--format", "json"], { cwd: root });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.message).toBe("Changed files are not tracked in the graph.");
  });
});

// ---------------------------------------------------------------------------
// (3) impact: pre-scan/post-scan shard-probe inconsistency (issue #351 H2
//     defense / 修正3)
// ---------------------------------------------------------------------------

describe("impact: pre-scan/post-scan trace-shard probe inconsistency (issue #351 H2 defense / 修正3)", () => {
  function writeMismatchFixture(root: string): void {
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    // No .artgraph/trace directory at all: the REAL (second) probe inside
    // buildGraph genuinely finds nothing — only the FIRST call is forced to
    // lie, reproducing "pre-scan said yes, post-scan found none" without any
    // EMFILE at all (the structural, non-EMFILE-cause backstop).
    writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-5501: needs coverage\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-5501\n");
    writeFileSync(
      join(root, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
  }

  it("pre-scan probe reports shards present but the post-scan probe finds none → exit 1, dedicated stderr, regardless of --tests", async () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-h2-mismatch-")));
    writeMismatchFixture(root);
    hasTraceShardsControl.forceFirstCallPresent = true;

    const result = await runCli(["impact", "src/a.ts"], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/trace-shard probe inconsistency/);
    // Distinct failure mode from resource exhaustion — this run never hit
    // EMFILE/ENFILE at all.
    expect(result.stderr).not.toMatch(/system-resource-exhausted/);
  });

  it("negative: without the forced mismatch, the same fixture → exit 0 (regression guard, proves the check only fires on real disagreement)", async () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-h2-mismatch-negative-")));
    writeMismatchFixture(root);
    // hasTraceShardsControl.forceFirstCallPresent left false.

    const result = await runCli(["impact", "src/a.ts"], { cwd: root });

    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (4) rename-trace: discoverShardPaths guarded via listFilesGuarded
//     (issue #351 H1, unit)
// ---------------------------------------------------------------------------

describe("rename-trace: discoverShardPaths guarded via listFilesGuarded (issue #351 H1, unit)", () => {
  function writeShardFixture(root: string): void {
    mkdirSync(join(root, ".artgraph", "trace"), { recursive: true });
    writeFileSync(
      join(root, ".artgraph", "trace", "w1.jsonl"),
      JSON.stringify({
        kind: "test",
        // Built via template interpolation, not a contiguous bracket+id
        // literal, so this repo's OWN dogfood `artgraph check` never
        // mistakes this fixture for a real test-title tag (same convention
        // as tests/helpers.ts's `introduceNewOrphan`/`coverDebtReq` and
        // tests/resource-exhaustion-trace-chain.test.ts's fixture).
        testName: `[${"REQ-1"}] does the thing`,
        suitePath: [],
        testFile: "tests/a.test.ts",
        passed: true,
        hits: [],
        hashes: {},
      }),
    );
  }

  const config: ArtgraphConfig = {
    include: [],
    specDirs: [],
    testPatterns: [],
    lockFile: ".trace.lock",
  };

  it("EMFILE on the trace-shard glob is surfaced via resourceExhaustedCode instead of silently returning nothing", () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-rename-trace-")));
    writeShardFixture(root);
    globControl.failCode = "EMFILE";
    globControl.failWhen = isTraceShardPattern;

    const result = rewriteTraceShards(root, config, [["REQ-1", "REQ-2"]]);

    expect(result.resourceExhaustedCode).toBe("EMFILE");
    // Nothing could be discovered this run — degraded fail-safe (empty
    // result), not a crash.
    expect(result.filesToWrite.size).toBe(0);
  });

  it("negative: same fixture, no EMFILE → the shard IS discovered and rewritten (regression guard, proves the code path is real)", () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-rename-trace-negative-")));
    writeShardFixture(root);

    const result = rewriteTraceShards(root, config, [["REQ-1", "REQ-2"]]);

    expect(result.resourceExhaustedCode).toBeUndefined();
    expect(result.filesToWrite.size).toBe(1);
    expect(result.changes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (5) ingestTrace: loadShards shard-file read EMFILE (issue #351 H1, unit)
// ---------------------------------------------------------------------------

describe("ingestTrace: loadShards shard-file read EMFILE (issue #351 H1, unit)", () => {
  function writeTwoShardFixture(root: string): void {
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".artgraph", "trace"), { recursive: true });
    writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-5601: needs coverage\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-5601\n");
    writeFileSync(
      join(root, ".artgraph", "trace", "w1-healthy.jsonl"),
      JSON.stringify({
        kind: "test",
        // Template interpolation — see the identical comment above.
        testName: `[${"REQ-5601"}] healthy shard`,
        suitePath: [],
        testFile: "tests/a.test.ts",
        passed: true,
        hits: [],
        hashes: {},
      }),
    );
    writeFileSync(
      join(root, ".artgraph", "trace", "w2-victim.jsonl"),
      JSON.stringify({
        kind: "test",
        testName: `[${"REQ-5601"}] victim shard`,
        suitePath: [],
        testFile: "tests/b.test.ts",
        passed: true,
        hits: [],
        hashes: {},
      }),
    );
  }

  const config: ArtgraphConfig = {
    include: ["src/**/*.ts"],
    specDirs: ["specs"],
    testPatterns: ["tests/**/*.ts"],
    lockFile: ".trace.lock",
  };

  it("EMFILE reading one shard file skips that shard and records the resource-exhaustion signal, but keeps the OTHER shard", () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-loadshards-")));
    writeTwoShardFixture(root);
    fsFailureControl.failures.set("w2-victim.jsonl", { code: "EMFILE", atCall: 1 });

    const { trace, warnings } = ingestTrace(config, root);

    expect(trace.shardCount).toBe(1); // only the healthy shard was read
    expect(
      warnings.some((w) => w.type === "system-resource-exhausted" && /EMFILE/.test(w.message)),
    ).toBe(true);
    // The healthy shard's evidence still landed.
    expect(trace.perReq.get("REQ-5601")?.tests.some((t) => t.testFile === "tests/a.test.ts")).toBe(
      true,
    );
  });

  it("negative: same fixture, no EMFILE → both shards read, no resource-exhaustion warning (regression guard)", () => {
    const root = track(mkdtempSync(join(tmpdir(), "artgraph-351-loadshards-negative-")));
    writeTwoShardFixture(root);

    const { trace, warnings } = ingestTrace(config, root);

    expect(trace.shardCount).toBe(2);
    expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
  });
});
