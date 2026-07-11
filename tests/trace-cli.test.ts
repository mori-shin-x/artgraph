// spec 020 (contracts/cli-surface.md §2, tasks.md T010) — Red tests for
// `artgraph trace status` / `artgraph trace report` (Phase A, US2). Fixtures
// are temp projects with hand-written TS sources + specs + hand-written
// shard JSONL (no real vitest execution needed — `src/trace/schema.ts`'s
// `parseShardLines` is the only consumer of the wire shape, exactly like
// `tests/trace-ingest.test.ts`'s T008 fixtures). Follows the CLI-test style
// of `tests/impact-cli.test.ts` (temp-dir-per-describe, `runAt` in-process
// harness).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runAt } from "./helpers.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";
import { TRACE_NO_SHARDS_GUIDANCE } from "../src/commands/shared.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function makeRepo(
  files: Record<string, string>,
  configExtra: Record<string, unknown> = {},
): string {
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-trace-cli-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      mode: "symbol",
      ...configExtra,
    }),
    "utf-8",
  );
  return tmp;
}

function metaLine(): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "meta",
    runToken: "run-1",
    pool: "forks",
    vitest: "4.1.10",
    startedAt: "2026-07-10T14:00:00Z",
  });
}

function testLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "test",
    testName: "[REQ-900] a test",
    suitePath: [],
    testFile: "tests/x.test.ts",
    passed: true,
    hits: [],
    hashes: {},
    ...overrides,
  });
}

function writeShard(tmp: string, name: string, lines: string[]): void {
  const dir = join(tmp, ".artgraph/trace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// (a) / (c) — main classification fixture. One repo exercising every branch
// of FR-012/013 at once:
//   REQ-001 -> signIn          : no @impl, exclusive        -> suggestedImpls
//   REQ-002 -> resetPassword   : no @impl, exclusive        -> suggestedImpls
//   REQ-003 -> oldSignIn       : FALSE @impl, REQ-003's test never hits it
//                                                            -> unexercisedClaims
//   REQ-004 -> corroboratedFn  : real @impl AND REQ-004's test hits it
//                                                            -> corroborated
//   REQ-005/006/007 -> sharedHelper (3 reqs, default threshold)
//                                                            -> infrastructure
//   REQ-008/009 -> silentHelper (2 reqs, below threshold)   -> appears nowhere
// ---------------------------------------------------------------------------

const SPEC_MD = [
  "# Fixture spec",
  "",
  "## Requirements",
  "",
  "- REQ-001: signIn authenticates a user.",
  "- REQ-002: resetPassword resets a user's password.",
  "- REQ-003: oldSignIn is the legacy sign-in path.",
  "- REQ-004: corroboratedFn does the thing it claims to do.",
  "- REQ-005: uses sharedHelper (a).",
  "- REQ-006: uses sharedHelper (b).",
  "- REQ-007: uses sharedHelper (c).",
  "- REQ-008: uses silentHelper (a).",
  "- REQ-009: uses silentHelper (b).",
  "",
].join("\n");

const APP_TS = [
  "export function signIn() {}",
  "",
  "export function resetPassword() {}",
  "",
  "export function oldSignIn() {",
  "  // @impl REQ-003",
  "}",
  "",
  "export function corroboratedFn() {",
  "  // @impl REQ-004",
  "}",
  "",
  "export function sharedHelper() {}",
  "",
  "export function silentHelper() {}",
  "",
].join("\n");

function mainFixtureShardLines(): string[] {
  return [
    metaLine(),
    testLine({
      testName: "[REQ-001] signs in",
      testFile: "tests/req001.test.ts",
      hits: [{ file: "src/app.ts", fn: "signIn" }],
    }),
    testLine({
      testName: "[REQ-002] resets password",
      testFile: "tests/req002.test.ts",
      hits: [{ file: "src/app.ts", fn: "resetPassword" }],
    }),
    testLine({
      // Tagged REQ-003 test runs but never touches oldSignIn — the claim
      // planted in APP_TS is false (SC-003's Phase A version).
      testName: "[REQ-003] legacy sign-in path is exercised elsewhere",
      testFile: "tests/req003.test.ts",
      hits: [],
    }),
    testLine({
      testName: "[REQ-004] corroboratedFn does the thing",
      testFile: "tests/req004.test.ts",
      hits: [{ file: "src/app.ts", fn: "corroboratedFn" }],
    }),
    testLine({
      testName: "[REQ-005] a",
      testFile: "tests/req005.test.ts",
      hits: [{ file: "src/app.ts", fn: "sharedHelper" }],
    }),
    testLine({
      testName: "[REQ-006] b",
      testFile: "tests/req006.test.ts",
      hits: [{ file: "src/app.ts", fn: "sharedHelper" }],
    }),
    testLine({
      testName: "[REQ-007] c",
      testFile: "tests/req007.test.ts",
      hits: [{ file: "src/app.ts", fn: "sharedHelper" }],
    }),
    testLine({
      testName: "[REQ-008] a",
      testFile: "tests/req008.test.ts",
      hits: [{ file: "src/app.ts", fn: "silentHelper" }],
    }),
    testLine({
      testName: "[REQ-009] b",
      testFile: "tests/req009.test.ts",
      hits: [{ file: "src/app.ts", fn: "silentHelper" }],
    }),
  ];
}

function makeMainFixture(): string {
  const tmp = makeRepo({ "src/app.ts": APP_TS, "specs/spec.md": SPEC_MD });
  writeShard(tmp, "w1.jsonl", mainFixtureShardLines());
  return tmp;
}

describe("CLI: trace report classification (T010 (a)/(c))", () => {
  it("--format json: corroborated / unexercisedClaims / suggestedImpls / infrastructure, silent band omitted", async () => {
    const tmp = makeMainFixture();
    const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.unexercisedClaims).toEqual([
      { reqId: "REQ-003", node: "symbol:src/app.ts#oldSignIn" },
    ]);

    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-001", node: "symbol:src/app.ts#signIn" },
      { reqId: "REQ-002", node: "symbol:src/app.ts#resetPassword" },
    ]);

    expect(result.corroborated).toEqual([
      { reqId: "REQ-004", node: "symbol:src/app.ts#corroboratedFn" },
    ]);

    expect(result.infrastructure).toEqual([
      { node: "symbol:src/app.ts#sharedHelper", reqCount: 3 },
    ]);

    // (c) sharedHelper must NOT also show up as a suggestion.
    expect(
      result.suggestedImpls.some((p: { node: string }) => p.node.includes("sharedHelper")),
    ).toBe(false);

    // Silent band (exactly 2 reqs, below default sharedThreshold=3):
    // silentHelper appears in NONE of the four lists.
    const allNodes = [
      ...result.corroborated.map((p: { node: string }) => p.node),
      ...result.unexercisedClaims.map((p: { node: string }) => p.node),
      ...result.suggestedImpls.map((p: { node: string }) => p.node),
      ...result.infrastructure.map((i: { node: string }) => i.node),
    ];
    expect(allNodes).not.toContain("symbol:src/app.ts#silentHelper");

    // diagnostics shape per contracts/cli-surface.md §2.
    expect(result.diagnostics).toMatchObject({
      dangling: 0,
      skipped: 0,
      unknownSchema: 0,
      stale: 0,
    });
  });

  it("--format text: headings match the check-style UPPER-CASE convention", async () => {
    const tmp = makeMainFixture();
    const { stdout, exitCode } = await runAt(tmp, ["trace", "report"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("UNEXERCISED CLAIM:");
    expect(stdout).toContain("REQ-003 -> symbol:src/app.ts#oldSignIn");
    expect(stdout).toContain("SUGGESTED IMPL:");
    expect(stdout).toContain("REQ-001 -> symbol:src/app.ts#signIn");
    expect(stdout).toContain("INFRASTRUCTURE:");
    expect(stdout).toContain("symbol:src/app.ts#sharedHelper (3 reqs)");
    expect(stdout).not.toContain("silentHelper");
    expect(stdout).toContain("CORROBORATED:");
    expect(stdout).toContain("REQ-004 -> symbol:src/app.ts#corroboratedFn");
  });
});

// ---------------------------------------------------------------------------
// (b) zero shards -> exit 1 + FR-018-shared guidance
// ---------------------------------------------------------------------------

describe("CLI: trace report — zero shards (T010 (b), FR-018 symmetry)", () => {
  it("exits 1 with the shared no-shards guidance when no shard files exist at all", async () => {
    const tmp = makeRepo({ "src/app.ts": "export function foo() {}\n" });
    // No `.artgraph/trace/` directory created at all.
    const { stdout, stderr, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(TRACE_NO_SHARDS_GUIDANCE);
    // Guidance must point at runner setup.
    expect(stderr).toContain("artgraph/vitest/config");
    expect(stderr).toContain("withTrace");
  });

  it("exits 1 the same way when the trace dir exists but is empty", async () => {
    const tmp = makeRepo({ "src/app.ts": "export function foo() {}\n" });
    mkdirSync(join(tmp, ".artgraph", "trace"), { recursive: true });
    const { exitCode, stderr } = await runAt(tmp, ["trace", "report"]);
    expect(exitCode).toBe(1);
    expect(stderr.trim()).toBe(TRACE_NO_SHARDS_GUIDANCE);
  });

  it("`trace status` does NOT error on zero shards — it's a diagnostic read, not a hard requirement", async () => {
    const tmp = makeRepo({ "src/app.ts": "export function foo() {}\n" });
    const { exitCode, stdout } = await runAt(tmp, ["trace", "status", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.shardCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (d) stale mixing — hashesAtTrace disagrees with current file content
// (⑤事故パターン): report still produces a full result, plus a stale count.
// ---------------------------------------------------------------------------

describe("CLI: trace report — stale evidence mixed in (T010 (d))", () => {
  it("counts stale evidence in diagnostics.stale and still reports everything else", async () => {
    const tmp = makeRepo({
      "src/x.ts": "export function foo() {}\n",
      "specs/spec.md": "# Spec\n\n## Requirements\n\n- REQ-500: foo does a thing.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-500] foo",
        testFile: "tests/req500.test.ts",
        hits: [{ file: "src/x.ts", fn: "foo" }],
        // Deliberately wrong — trace-capture-time hash for src/x.ts no
        // longer matches the file's current content (edited after capture).
        hashes: { "src/x.ts": "0000000000000000" },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.diagnostics.stale).toBe(1);
    // The rest of the report still works despite the staleness (report is
    // not gated in Phase A — that policy is FR-015 / Phase C).
    expect(result.suggestedImpls).toEqual([{ reqId: "REQ-500", node: "symbol:src/x.ts#foo" }]);
  });

  it("`trace status` surfaces the same stale count and a non-zero stale rate", async () => {
    const tmp = makeRepo({
      "src/x.ts": "export function foo() {}\n",
      "specs/spec.md": "# Spec\n\n## Requirements\n\n- REQ-500: foo does a thing.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-500] foo",
        testFile: "tests/req500.test.ts",
        hits: [{ file: "src/x.ts", fn: "foo" }],
        hashes: { "src/x.ts": "0000000000000000" },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["trace", "status", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.diagnostics.stale).toBe(1);
    expect(result.staleRate).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Graph / lock non-mutation (Phase A contract) — `trace report` must never
// write `.trace.lock`.
// ---------------------------------------------------------------------------

describe("CLI: trace report is read-only (Phase A contract)", () => {
  it("does not create .trace.lock", async () => {
    const tmp = makeMainFixture();
    const { exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
  });
});
