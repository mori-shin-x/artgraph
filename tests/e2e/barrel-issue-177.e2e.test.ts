// Issue #177 — CLI end-to-end regression guard for the symbol-mode fail-open
// fix (PR #180). The unit-level `tests/barrel-reexport.test.ts` pins parser +
// graph behaviour by calling `parseTSFilePaths` / `buildGraph` / `impact`
// in-process. That's fast, but it does NOT exercise the CLI wiring — the
// `loadConfig` -> `scan` -> `reconcile` -> `check --gate --diff` chain that
// PR #180's body verified manually. If any glue between `mode: "symbol"` and
// those subcommands regresses (e.g. `commands/check.ts` drops the config's
// mode, or `reconcile` stops writing symbol-level `impl` sources), the unit
// suite stays green while the real user experience silently breaks.
//
// This file spawns the built `dist/cli.js` against a temp git repo that
// mirrors the PR #180 manual verification recipe verbatim, and pins:
//
//   1. `artgraph scan --format json` shows the barrel node
//      (`symbol:src/index.ts#validateToken`) actually materialized — fix (b).
//   2. `artgraph reconcile` writes
//      `REQ-001.impl = ["symbol:src/auth.ts#validateToken"]` — fix (a): a
//      bootstrap-shape `// @impl REQ-001` written ABOVE the export must bind
//      to the symbol, not the file. Prior to #177 the lock recorded
//      `["file:src/auth.ts"]` and any symbol-unit BFS through the barrel
//      dead-ended.
//   3. `artgraph check --gate --diff` exits 0 (clean) when the diff scope
//      is the barrel-linked consumer — REQ-001 is reachable through the
//      barrel chain and the gate sees no uncovered work.
//   4. `artgraph impact src/consumer.ts --format json` includes REQ-001 in
//      `impactReqs` — the closure through the barrel is the whole point of
//      the fix, so the CLI must observe it.
//
// A separate describe block verifies that the gate still bites (`--gate`
// exit non-zero) when the `@impl` tag is missing, so the fix does not add an
// over-broad "always covered" fail-safe that hides real regressions.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");

// `spawnSync` reports timeouts and spawn failures via `error`/`signal` with
// `status: null`; printing only stdout/stderr in that case yields an
// undiagnosable "exit null" failure message. Surface all four fields so a CI
// timeout or ENOENT is distinguishable from a genuine non-zero exit.
function cliFailureMessage(r: SpawnSyncReturns<string>): string {
  return `CLI failed: exit ${r.status} signal=${r.signal ?? "none"} error=${r.error?.message ?? "none"}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`;
}

function runCli(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      // Deterministic identity so `git commit` works in CI containers that
      // don't have a global git config.
      GIT_AUTHOR_NAME: "artgraph-e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "artgraph-e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });
}

// Fixture layout — mirrors the PR #180 manual verification recipe:
//   src/auth.ts       — `// @impl REQ-001` written ABOVE the export, i.e. the
//                       bootstrap-generated shape (fix (a) of #177).
//   src/index.ts      — named barrel `export { validateToken } from "./auth"`
//                       (fix (b) — barrel materializes `symbol:barrel#name`).
//   src/consumer.ts   — imports the symbol through the barrel; this is the
//                       `check --gate --diff` starting point.
//   specs/req.md      — the single requirement REQ-001.
//   tests/*.test.ts   — carries the `[REQ-001]` marker so the REQ is verified.
//   .artgraph.json    — `mode: "symbol"`; the regression surface only exists
//                       in symbol mode.
//   package.json      — needed so oxc parses `src/*.ts` in the expected shape.
function writeFixture(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });

  // (a) Bootstrap shape: `// @impl REQ-001` lives on the line ABOVE the
  // export. Prior to #177 that line-position attributed the edge to the
  // file (`file:src/auth.ts`), so the barrel chain's `symbol:auth#…` target
  // had no `implements` edge and the whole REQ dropped out.
  writeFileSync(
    join(root, "src", "auth.ts"),
    "// @impl REQ-001\nexport function validateToken(token: string): boolean {\n  return token.length > 0;\n}\n",
    "utf-8",
  );
  // (b) Named barrel — the parser must materialize
  // `symbol:src/index.ts#validateToken` + an imports edge to
  // `symbol:src/auth.ts#validateToken`. Without that, any downstream
  // `import { validateToken } from "./index"` targets a phantom node.
  writeFileSync(
    join(root, "src", "index.ts"),
    'export { validateToken } from "./auth";\n',
    "utf-8",
  );
  // Consumer goes through the barrel (not directly to auth.ts). That
  // routes REQ discovery through both fixes: fix (b) turns the barrel
  // import into a real edge, fix (a) turns the barrel's target into a
  // REQ-carrying symbol.
  writeFileSync(
    join(root, "src", "consumer.ts"),
    'import { validateToken } from "./index";\nexport function useAuth(t: string): boolean {\n  return validateToken(t);\n}\n',
    "utf-8",
  );
  writeFileSync(
    join(root, "specs", "req.md"),
    "# Requirements\n\n- REQ-001: token validation.\n",
    "utf-8",
  );
  // `[REQ-001]` on an it() name is what markdown/typescript.ts treats as a
  // verifies edge (source is always the test file, never a symbol). Without
  // this the REQ would surface as impl-only and `check --gate` would fail
  // for reasons unrelated to the fix.
  writeFileSync(
    join(root, "tests", "consumer.test.ts"),
    'import { describe, it, expect } from "vitest";\n' +
      'import { useAuth } from "../src/consumer.js";\n\n' +
      'describe("consumer", () => {\n' +
      '  it("[REQ-001] uses validateToken through the barrel", () => {\n' +
      '    expect(useAuth("t")).toBe(true);\n' +
      "  });\n" +
      "});\n",
    "utf-8",
  );
  // `docGraph.autoContains: false` mirrors tests/fixtures/symbol-mode/ so
  // the REQ node is not reached via a `doc → contains → req` edge. That
  // keeps the impact BFS closure the same shape as the barrel test unit
  // suite and makes the assertions here unambiguous.
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify(
      {
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
        mode: "symbol",
        docGraph: { autoContains: false },
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "barrel-fixture", version: "0.0.0", type: "module" }, null, 2),
    "utf-8",
  );
}

describe("e2e: #177 symbol-mode barrel + bootstrap @impl (CLI trace)", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "artgraph-issue-177-"));
    writeFixture(workDir);
    // Baseline commit so `git diff` has a reference point.
    git(workDir, "init", "-q", "-b", "main");
    git(workDir, "add", ".");
    git(workDir, "commit", "-q", "-m", "baseline");
    // Modify consumer.ts so `getGitDiffFiles` returns a non-empty set —
    // otherwise `check --gate --diff` short-circuits with "No changes
    // detected" and the scope-narrowed path (the actual regression surface)
    // never runs. The change is a comment only, so REQ-001 reachability
    // through the barrel is preserved and the gate MUST stay clean.
    writeFileSync(
      join(workDir, "src", "consumer.ts"),
      'import { validateToken } from "./index";\n' +
        "// touch: exercise --diff\n" +
        "export function useAuth(t: string): boolean {\n" +
        "  return validateToken(t);\n" +
        "}\n",
      "utf-8",
    );
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("`artgraph scan --format json` materializes the barrel symbol node", () => {
    const r = runCli(workDir, ["scan", "--format", "json"]);
    expect(r.status, cliFailureMessage(r)).toBe(0);
    const graph = JSON.parse(r.stdout) as {
      nodes: Array<{ id: string; kind: string }>;
    };
    const ids = new Set(graph.nodes.map((n) => n.id));
    // (b) Barrel materialization: prior to #177 index.ts had NO symbol node
    // for `validateToken`, so any downstream import through the barrel
    // pointed at a phantom target and impact BFS dead-ended.
    expect(
      ids.has("symbol:src/index.ts#validateToken"),
      `barrel symbol missing; ids: ${[...ids].join(",")}`,
    ).toBe(true);
    // Origin symbol is the target of the barrel's imports edge; without it
    // the barrel materialization is meaningless.
    expect(ids.has("symbol:src/auth.ts#validateToken")).toBe(true);
    // The REQ itself must be a node — sanity for the spec loader.
    expect(ids.has("REQ-001")).toBe(true);
  });

  it("`artgraph reconcile` writes REQ-001.impl = [symbol:src/auth.ts#validateToken]", () => {
    // scan is a no-side-effect predecessor; reconcile writes the lock. Both
    // are exercised so a regression in either step surfaces here.
    const scanR = runCli(workDir, ["scan"]);
    expect(scanR.status, cliFailureMessage(scanR)).toBe(0);
    const recR = runCli(workDir, ["reconcile"]);
    expect(recR.status, cliFailureMessage(recR)).toBe(0);

    const lock = JSON.parse(readFileSync(join(workDir, ".trace.lock"), "utf-8")) as Record<
      string,
      { impl?: string[]; tests?: string[]; contentHash?: string }
    >;

    // (a) Bootstrap-style `@impl` (above export) attributed to the SYMBOL,
    // not the file. Prior to #177 this was `["file:src/auth.ts"]` and the
    // symbol-unit BFS through the barrel dead-ended.
    expect(lock["REQ-001"], `lock: ${JSON.stringify(lock)}`).toBeDefined();
    expect(lock["REQ-001"].impl).toEqual(["symbol:src/auth.ts#validateToken"]);
    // The `[REQ-001]` marker in the test file must produce a verifies edge
    // that reconcile emits into the lock — confirms end-to-end REQ closure
    // is intact (impl + verifies = verified) so `check --gate` can see a
    // clean pass in the next test.
    expect(lock["REQ-001"].tests).toEqual(["file:tests/consumer.test.ts"]);
  });

  it("`artgraph check --gate --diff` exits 0 (REQ-001 reached through the barrel)", () => {
    // Preconditions: reconcile from the previous test wrote the lock. The
    // diff scope (unstaged edit to `src/consumer.ts`) forces the check to
    // resolve REQ-001 through consumer -> barrel index -> auth symbol ->
    // REQ-001. With both fixes in place, REQ-001 is verified inside the
    // scoped set and the gate exits 0. Without them the barrel chain
    // dead-ends, REQ-001 falls outside the scope closure OR shows up as
    // uncovered, and the gate exits 2.
    const r = runCli(workDir, ["check", "--gate", "--diff"]);
    expect(r.status, cliFailureMessage(r)).toBe(0);
  });

  it("`artgraph impact src/consumer.ts --format json` reaches REQ-001 through the barrel", () => {
    const r = runCli(workDir, ["impact", "src/consumer.ts", "--format", "json"]);
    expect(r.status, cliFailureMessage(r)).toBe(0);
    const result = JSON.parse(r.stdout) as { impactReqs: string[] };
    // The whole point of the fix: a file-unit start on consumer.ts must
    // reach REQ-001 by chaining consumer -> barrel index -> auth symbol ->
    // REQ-001. Order-independent membership check keeps the assertion
    // stable against future BFS-ordering changes.
    expect(result.impactReqs).toContain("REQ-001");
  });
});

// Regression guard for the fix's negative half: the parser widening (a) +
// the barrel materialization (b) must not add an over-broad "always covered"
// fail-safe that hides missing tags. This isolated fixture drops `@impl
// REQ-001` from auth.ts and asserts `check --gate` still fails — so the gate
// stays honest.
describe("e2e: #177 symbol-mode — check --gate still bites when @impl is missing", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "artgraph-issue-177-uncovered-"));
    writeFixture(workDir);
    // Overwrite auth.ts with the tag REMOVED. REQ-001 now has no impl edge
    // anywhere in the graph, so a well-behaved gate must report it as
    // uncovered and exit non-zero.
    writeFileSync(
      join(workDir, "src", "auth.ts"),
      "export function validateToken(token: string): boolean {\n  return token.length > 0;\n}\n",
      "utf-8",
    );
    git(workDir, "init", "-q", "-b", "main");
    git(workDir, "add", ".");
    git(workDir, "commit", "-q", "-m", "baseline");
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("`check --gate` exits non-zero when REQ-001 has no @impl anywhere", () => {
    const scanR = runCli(workDir, ["scan"]);
    expect(scanR.status, cliFailureMessage(scanR)).toBe(0);
    const recR = runCli(workDir, ["reconcile"]);
    expect(recR.status, cliFailureMessage(recR)).toBe(0);
    const r = runCli(workDir, ["check", "--gate"]);
    // `check --gate` exits 2 on any issue (drift / orphan / uncovered).
    // Assert non-zero rather than an exact code so a future extension of
    // the gate exit code space (e.g. distinguishing uncovered from drift)
    // doesn't force a test rewrite.
    expect(r.status, `expected non-zero exit; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).not.toBe(
      0,
    );
    // The failure MUST implicate REQ-001 specifically — otherwise the test
    // might be catching a different problem in the fixture.
    expect(r.stdout + r.stderr).toContain("REQ-001");
  });
});
