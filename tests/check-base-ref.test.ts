// spec 023 — `check --diff --base <ref> --gate` (CI PR gating, issue #185 /
// spec 017 Phase 2). The gate is judged against `git merge-base <ref> HEAD`
// (D1): the changed-file set is the three-way working-tree union PLUS the
// committed base..HEAD range, and the baseline worktree is built at the SAME
// merge-base sha. Every `--base` failure funnels into the existing
// `baselineStatus:"unavailable"` channel (FR-012) — fail-closed, exit 1 with
// `--gate`.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { runAt } from "./helpers.js";
import { tmpdir } from "node:os";
import {
  makeRepoWithBaseBranch,
  makeRepoWithDebt,
  makeRepoWithOrphan,
  makeRepoWithSoleImplTag,
  withBaseAndFeatureBranches,
  gitCommitAll,
  gitInit,
  gitUnrelatedRootBranch,
  commitOnBase,
  coverDebtReq,
  introduceNewOrphan,
} from "./helpers.js";
import { FETCH_DEPTH_HINT } from "../src/baseline.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";

const repos: string[] = [];
function track(dir: string): string {
  repos.push(dir);
  return dir;
}
afterEach(() => {
  while (repos.length) {
    const d = repos.pop()!;
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: d, stdio: "pipe" });
    } catch {
      /* not a git repo / already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

async function gateJson(
  dir: string,
  extra: string[] = [],
): Promise<{ exitCode: number; stderr: string; json: any }> {
  const { stdout, stderr, exitCode } = await runAt(dir, [
    "check",
    "--diff",
    "--gate",
    "--format",
    "json",
    ...extra,
  ]);
  return { exitCode, stderr, json: JSON.parse(stdout) };
}

// ---------------------------------------------------------------------------
// US1 (T009) — CI main path: clean working tree, committed changes only.
// 023-check-base-ref/FR-001, FR-005, FR-006, FR-007
// ---------------------------------------------------------------------------
describe("check --diff --base <ref> --gate: CI commit-range gating (spec 023 US1)", () => {
  it("(a) committed new orphan on feature (clean tree) → exit 2 with the orphan in newIssues", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-us1a-"));
    introduceNewOrphan(dir);
    gitCommitAll(dir, "feature introduces an orphan (committed)");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(2);
    expect(json.pass).toBe(false);
    expect(json.newIssues.orphans).toContain("file:src/hub.ts -> REQ-999 (implements)");
    expect(json.baselineStatus).toBe("computed");
  });

  it("(b) harmless committed refactor only → exit 0", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-us1b-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless committed comment\n");
    gitCommitAll(dir, "harmless refactor");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("computed");
  });

  it("(c) base-side pre-existing debt in scope is suppressed, not failed", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-us1c-"));
    // Committed spec edit drags REQ-200 (pre-existing uncovered debt from
    // the branch point) into scope.
    appendFileSync(join(dir, "specs", "debt.md"), "\n<!-- committed spec touch -->\n");
    gitCommitAll(dir, "touch debt spec");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.uncovered).toContain("REQ-200"); // visible in the scoped display…
    expect(json.newIssues.uncovered).not.toContain("REQ-200"); // …but not new
    expect(json.suppressedCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T011 — moved-ahead base (D1's core case, the CI-normal state).
// 023-check-base-ref/FR-005, FR-007 / SC-002
// ---------------------------------------------------------------------------
describe("check --diff --base: moved-ahead base uses the merge-base, never the tip (spec 023 SC-002)", () => {
  it("an issue fixed on base AFTER the branch point stays suppressed (tip-baseline would exit 2)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-moved-ahead-"));
    // Base moves ahead: REQ-200 (uncovered at the branch point) gets covered
    // on base AFTER feature diverged. If the baseline were built at base's
    // TIP, REQ-200 would be covered there → its uncovered-key would be
    // missing from the baseline → the feature side's (still uncovered)
    // REQ-200 would count as NEW → false exit 2. The merge-base baseline
    // still has REQ-200 uncovered → suppressed → exit 0.
    commitOnBase(dir, () => coverDebtReq(dir), "base covers REQ-200 after the branch point");
    // Feature drags REQ-200 into scope with a committed spec touch.
    appendFileSync(join(dir, "specs", "debt.md"), "\n<!-- feature-side spec touch -->\n");
    gitCommitAll(dir, "feature touches the debt spec");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.uncovered).toContain("REQ-200");
    expect(json.newIssues.uncovered).not.toContain("REQ-200");
  });
});

// ---------------------------------------------------------------------------
// T012 — committed deletion of the sole @impl file (A1 / issue #229's
// failure mode on the committed path). 023-check-base-ref/FR-009 / SC-003
// ---------------------------------------------------------------------------
describe("check --diff --base: committed sole-@impl deletion fails the gate (spec 023 SC-003)", () => {
  it("git rm + commit of the only @impl file → REQ newly uncovered → exit 2", async () => {
    const dir = track(withBaseAndFeatureBranches(makeRepoWithSoleImplTag("artgraph-023-del-")));
    // The deletion is COMMITTED: src/target.ts exists in neither HEAD's tree
    // nor the working tree nor the current graph. Only the merge-base tree
    // probe (FR-009) keeps this from silently becoming "Changed files are
    // not tracked in the graph." exit 0.
    execFileSync("git", ["rm", "-q", "src/target.ts"], { cwd: dir, stdio: "pipe" });
    gitCommitAll(dir, "delete the sole @impl file");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(2);
    expect(json.pass).toBe(false);
    expect(json.newIssues.uncovered).toContain("REQ-500");
    expect(json.baselineStatus).toBe("computed");
  });
});

// ---------------------------------------------------------------------------
// T013 — committed pure rename (A2, 017 C2/SC-004's base-range edition).
// 023-check-base-ref/FR-008 / SC-004
// ---------------------------------------------------------------------------
describe("check --diff --base: committed renames stay rename-aware (spec 023 SC-004)", () => {
  it("committed pure `git mv` of a pre-existing-orphan file → orphan stays suppressed → exit 0", async () => {
    const dir = track(withBaseAndFeatureBranches(makeRepoWithOrphan("artgraph-023-mv-")));
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd: dir, stdio: "pipe" });
    gitCommitAll(dir, "pure rename, zero content change");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    // Visible at the NEW path, suppressed as pre-existing (orphan-key
    // normalization through the base-range rename map).
    expect(json.orphans).toContain("file:src/new.ts -> REQ-999 (implements)");
    expect(json.newIssues.orphans).toEqual([]);
    expect(json.suppressedCount).toBeGreaterThanOrEqual(1);
  });

  it("committed rename + sole-@impl deletion in the same range → still exit 2 (inverse-rename startId resolution)", async () => {
    const dir = track(withBaseAndFeatureBranches(makeRepoWithSoleImplTag("artgraph-023-mv-del-")));
    execFileSync("git", ["mv", "src/target.ts", "src/renamed.ts"], { cwd: dir, stdio: "pipe" });
    const renamedPath = join(dir, "src", "renamed.ts");
    const before = readFileSync(renamedPath, "utf-8");
    const after = before
      .split("\n")
      .filter((l) => !l.includes("@impl REQ-500"))
      .join("\n");
    expect(after).not.toEqual(before);
    writeFileSync(renamedPath, after);
    gitCommitAll(dir, "rename + delete the sole @impl edge, committed");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(2);
    expect(json.newIssues.uncovered).toContain("REQ-500");
  });
});

// ---------------------------------------------------------------------------
// US2 (T014/T016/T017) — union semantics: --base ADDS the commit range, the
// working-tree diff (untracked included) never shrinks.
// 023-check-base-ref/FR-006 / SC-007
// ---------------------------------------------------------------------------
describe("check --diff --base: union of commit range and working tree (spec 023 US2)", () => {
  it("(T014a) committed orphan + untracked new orphan file → BOTH are judged → exit 2 with both", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-union-"));
    introduceNewOrphan(dir); // src/hub.ts
    gitCommitAll(dir, "committed orphan");
    // Untracked, never committed — must still be in the changed-file set.
    // ("@"-concatenation so artgraph's own dogfood scan never reads this
    // test file's literal as a real code tag.)
    writeFileSync(join(dir, "src", "extra.ts"), "// @" + "impl REQ-888\nexport const x = 1;\n");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(2);
    expect(json.newIssues.orphans).toContain("file:src/hub.ts -> REQ-999 (implements)");
    expect(json.newIssues.orphans).toContain("file:src/extra.ts -> REQ-888 (implements)");
  });

  it("(T014b) untracked-only change outside the graph behaves exactly like plain --diff", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-union-untracked-"));
    writeFileSync(join(dir, "README.md"), "# notes outside the graph\n");

    const plain = await runAt(dir, ["check", "--diff", "--gate"]);
    const withBase = await runAt(dir, ["check", "--diff", "--base", "base", "--gate"]);
    expect(withBase.exitCode).toBe(plain.exitCode);
    expect(plain.exitCode).toBe(0);
    expect(withBase.stdout).toContain("Changed files are not tracked in the graph.");
  });

  it("(T016) non-ASCII path changed ONLY in base..HEAD enters the gate scope (SC-007)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-nonascii-"));
    writeFileSync(join(dir, "specs", "日本語.md"), "# 日本語\n\n- REQ-777: 未実装の新要件\n");
    gitCommitAll(dir, "add 日本語 spec with an uncovered REQ");

    const { exitCode, json } = await gateJson(dir, ["--base", "base"]);
    expect(exitCode).toBe(2);
    expect(json.newIssues.uncovered).toContain("REQ-777");
  });

  it("(T017) --base HEAD degenerates to the Phase-1 (HEAD-pinned) verdict", async () => {
    const dir = track(makeRepoWithDebt("artgraph-023-basehead-"));
    introduceNewOrphan(dir); // uncommitted working-tree change

    const phase1 = await gateJson(dir);
    const baseHead = await gateJson(dir, ["--base", "HEAD"]);
    expect(baseHead.exitCode).toBe(phase1.exitCode);
    expect(phase1.exitCode).toBe(2);
    expect(baseHead.json.newIssues).toEqual(phase1.json.newIssues);
    expect(baseHead.json.baselineStatus).toBe(phase1.json.baselineStatus);
  });
});

// ---------------------------------------------------------------------------
// T015 — empty merged diff + --base: legitimate "No changes", CI warning
// suppressed on stderr AND in json warnings[]. 023-check-base-ref/FR-010
// ---------------------------------------------------------------------------
describe("check --diff --base: empty merged diff suppresses the CI warning (spec 023 FR-010)", () => {
  const prevCI = process.env.CI;
  afterEach(() => {
    if (prevCI === undefined) delete process.env.CI;
    else process.env.CI = prevCI;
  });

  it("CI=true + same tip + clean tree + --base → exit 0, no CI warning anywhere", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-emptydiff-"));
    process.env.CI = "true";
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "base",
      "--gate",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.message).toContain("No changes detected in git diff.");
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("skipped");
    expect(stderr).not.toContain("gate is not active in CI");
    expect(
      (json.warnings as unknown[]).some(
        (w) => typeof w === "string" && w.includes("gate is not active in CI"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US3 (T018/T020) — fail-closed error paths. 023-check-base-ref/FR-002,
// FR-004, FR-005, FR-012 / SC-006
// ---------------------------------------------------------------------------
describe("check --base fail-closed errors (spec 023 US3)", () => {
  it("(a) --base without --diff → usage error exit 1, no JSON even with --format json (FR-002)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-usage-"));
    const text = await runAt(dir, ["check", "--base", "base", "--gate"]);
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("--base requires --diff");
    expect(text.stderr).toContain("artgraph check --diff --base <ref>");
    expect(text.stdout.trim()).toBe("");

    const asJson = await runAt(dir, ["check", "--base", "base", "--format", "json"]);
    expect(asJson.exitCode).toBe(1);
    expect(asJson.stdout.trim()).toBe(""); // a usage error is not a verdict
    expect(asJson.stderr).toContain("--base requires --diff");
  });

  // PR #304 review F1 — commander's required option-args are greedy: without
  // parse-time validation, `--base --gate` (an EMPTY ${{ github.base_ref }}
  // expanding to nothing on a push-triggered workflow) assigns ref="--gate"
  // and UNSETS the gate, so a committed orphan sails through at exit 0.
  it("(F1) --base swallowing the next flag (--base --gate) → parse-time usage error exit 1", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-f1-eaten-"));
    writeFileSync(join(dir, "src", "hub.ts"), "// @" + "impl REQ-999\nexport const hub = 1;\n");
    gitCommitAll(dir, "committed orphan");

    const { stdout, stderr, exitCode } = await runAt(dir, ["check", "--diff", "--base", "--gate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must not start with "-"');
    expect(stdout.trim()).toBe(""); // no verdict-shaped output on a usage error
  });

  // PR #304 review F2 — `--base ""` (quoted-empty CI variable) is falsy and
  // would skip every opts.base branch: clean tree → "No changes" exit 0, the
  // exact no-base no-op the feature exists to eliminate.
  it("(F2) --base with an empty-string ref → parse-time usage error exit 1", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-f2-empty-"));
    writeFileSync(join(dir, "src", "hub.ts"), "// @" + "impl REQ-999\nexport const hub = 1;\n");
    gitCommitAll(dir, "committed orphan");

    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "",
      "--gate",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("must not be empty");
    expect(stdout.trim()).toBe("");
  });

  // PR #304 review F1 (non-breaking check) — a ref that legitimately starts
  // with "-" stays usable via its full refs/... spelling, which the
  // leading-dash rejection never matches.
  it("(F1) a branch literally named '--gate' stays reachable via refs/heads/--gate", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-f1-dashref-"));
    // Porcelain `git branch` refuses leading-dash names; the ref store does not.
    execFileSync("git", ["update-ref", "refs/heads/--gate", "base"], { cwd: dir, stdio: "pipe" });
    introduceNewOrphan(dir);

    const { exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "refs/heads/--gate",
      "--gate",
    ]);
    expect(exitCode).toBe(2); // judged against the ref — parse guard did not fire
  });

  // PR #304 review F3 — a DOWNSTREAM baseline failure (here: submodules) with
  // a perfectly valid --base ref must keep spec 017's accurate headline, not
  // misattribute the failure to the ref; the true cause still follows as a
  // detail line.
  it("(F3) downstream unavailable with a valid ref → 'git worktree unavailable' headline + true cause", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-f3-headline-"));
    const subSrc = track(mkdtempSync(join(tmpdir(), "artgraph-023-f3-subsrc-")));
    gitInit(subSrc);
    writeFileSync(join(subSrc, "lib.txt"), "lib\n");
    gitCommitAll(subSrc, "lib init");
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", subSrc, "vendor/lib"],
      { cwd: dir, stdio: "pipe" },
    );
    gitCommitAll(dir, "add submodule");
    // An in-graph change so this test exercises the unavailable REPORTING
    // path through the normal scope flow. (A diff touching only non-graph
    // files now ALSO fails closed — issue #307 — pinned by its own tests in
    // tests/check-baseline-diff.test.ts; this test keeps the in-graph shape
    // so the two pins stay independent.)
    introduceNewOrphan(dir);

    const { stderr, exitCode } = await runAt(dir, ["check", "--diff", "--base", "base", "--gate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not establish a baseline (git worktree unavailable).");
    expect(stderr).not.toContain("unresolved or no merge-base");
    expect(stderr).toContain("submodules are not supported");
  });

  // PR #304 review F4 — without --gate, text mode must still surface the
  // cause + fetch-depth hint on stderr when --base was given (JSON already
  // carries baselineError; --base-less output stays byte-identical).
  it("(F4) unresolvable ref without --gate → warning + cause + fetch-depth hint on stderr, exit 0", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-f4-nogate-"));
    const { stderr, exitCode } = await runAt(dir, ["check", "--diff", "--base", "nosuchref"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("could not establish a baseline; showing all issues");
    expect(stderr).toContain('base ref "nosuchref" does not resolve');
    expect(stderr).toContain("fetch-depth: 0");
  });

  it("(b) unresolvable ref + --gate → exit 1 with the fetch-depth hint (A10)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-noref-"));
    const { stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "nosuchref",
      "--gate",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not establish a baseline");
    expect(stderr).toContain("fetch-depth: 0");
    expect(stderr).toContain("gate result is undetermined");
  });

  it("(c) unrelated histories (merge-base failure, the shallow-clone stand-in) + --gate → exit 1 + hint", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-unrelated-"));
    gitUnrelatedRootBranch(dir, "unrelated");
    const { stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "unrelated",
      "--gate",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not establish a baseline");
    expect(stderr).toContain("fetch-depth: 0");
  });

  it("(d) same failures WITHOUT --gate → warn + display-only exit 0, baselineStatus unavailable with the hint", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-noref-nogate-"));
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "nosuchref",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("could not establish a baseline");
    const json = JSON.parse(stdout);
    expect(json.baselineStatus).toBe("unavailable");
    expect(json.pass).toBe(false);
    expect(json.baselineError).toContain(FETCH_DEPTH_HINT);
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
  });

  it("(T020) --ignore cannot fail-open an unavailable --base run (FR-012)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-ignore-unavail-"));
    const { exitCode, stderr } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "nosuchref",
      "--gate",
      "--ignore",
      "REQ-200",
    ]);
    // The --ignore pass-recomputation keeps `unavailable` non-passing:
    // still the dedicated exit 1, never a recomputed pass (exit 0).
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not establish a baseline");
  });
});

// ---------------------------------------------------------------------------
// T021 — SC-005: without --base, `check --diff --gate --format json` keeps
// the pre-023 shape and values (byte-identical regression pin).
// 023-check-base-ref/FR-003
// ---------------------------------------------------------------------------
describe("check --diff without --base is byte-identical to pre-023 (spec 023 SC-005)", () => {
  const prevCI = process.env.CI;
  afterEach(() => {
    if (prevCI === undefined) delete process.env.CI;
    else process.env.CI = prevCI;
  });

  it("empty diff (no CI): the E4 short-circuit payload is exactly the pre-023 shape", async () => {
    const dir = track(makeRepoWithDebt("artgraph-023-sc005-empty-"));
    delete process.env.CI;
    const { stdout, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      drifted: [],
      orphans: [],
      orphanNodeIds: [],
      uncovered: [],
      coverage: [],
      testFailures: [],
      pass: true,
      newIssues: { drifted: [], orphans: [], uncovered: [], testFailures: [] },
      suppressedCount: 0,
      baselineStatus: "skipped",
      warnings: [],
      message: "No changes detected in git diff.",
    });
  });

  it("computed run: exact top-level key set and values are unchanged", async () => {
    const dir = track(makeRepoWithDebt("artgraph-023-sc005-computed-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");
    const { stdout, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    // Pre-023 CheckResult keys + warnings — nothing added, nothing removed
    // (no baselineError, no message, no trace keys on this fixture).
    expect(Object.keys(json).sort()).toEqual(
      [
        "drifted",
        "orphans",
        "orphanNodeIds",
        "uncovered",
        "coverage",
        "testFailures",
        "pass",
        "newIssues",
        "suppressedCount",
        "baselineStatus",
        "warnings",
      ].sort(),
    );
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("computed");
    expect(json.suppressedCount).toBe(0);
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
  });
});

// ---------------------------------------------------------------------------
// T023 — trace.staleness: "gate" × --base: the wider base-range scope can
// legitimately pull stale evidence into the independent exit-2 channel
// (spec.md Assumptions — documented, not fixed; pinned here so a future
// change is a conscious one).
// ---------------------------------------------------------------------------
describe("check --diff --base × trace.staleness gate (spec 023 documented interaction)", () => {
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

  it("stale evidence scoped in ONLY via the base range fires exit 2 (no-base run: exit 0 empty diff)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-stalegate-"));
    // Symbol-mode config with the staleness gate on; trace shards are
    // gitignored so the working tree stays clean (CI-like state).
    writeFileSync(join(dir, ".gitignore"), ".trace.lock\nnode_modules/\n.artgraph/\n");
    writeFileSync(
      join(dir, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.ts"],
        lockFile: ".trace.lock",
        mode: "symbol",
        trace: { staleness: "gate" },
      }),
    );
    writeFileSync(join(dir, "specs", "gate.md"), "# Gate\n\n- REQ-650: gateFn requirement\n");
    // "@"-concatenation: dogfood-scan hygiene (see T014a note).
    writeFileSync(
      join(dir, "src", "gatefn.ts"),
      "export function gateFn() {\n  // @" + "impl REQ-650\n}\n",
    );
    gitCommitAll(dir, "config + gateFn on feature branch-point equivalent");
    // Rebase the `base` branch marker onto this commit so the ONLY base..HEAD
    // change is the harmless gatefn edit below.
    execFileSync("git", ["branch", "-f", "base", "HEAD"], { cwd: dir, stdio: "pipe" });
    appendFileSync(join(dir, "src", "gatefn.ts"), "// harmless committed edit\n");
    gitCommitAll(dir, "feature edits gateFn (committed)");

    // A stale trace shard: recorded hash can never match the current scan.
    const shardDir = join(dir, ".artgraph", "trace");
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(
      join(shardDir, "w1.jsonl"),
      [
        metaLine(),
        JSON.stringify({
          kind: "test",
          // Bracket-tag concatenation: dogfood-scan hygiene (the fixture
          // shard still carries the bracketed REQ-650 tag at runtime).
          testName: "[REQ-" + "650] exercises gateFn",
          suitePath: [],
          testFile: "tests/req650.test.ts",
          passed: true,
          hits: [{ file: "src/gatefn.ts", fn: "gateFn" }],
          hashes: { "src/gatefn.ts": "0000000000000000" },
        }),
      ].join("\n"),
    );

    // Without --base: clean tree → empty diff → "No changes" exit 0 — the
    // stale evidence never enters any scope.
    const noBase = await runAt(dir, ["check", "--diff", "--gate"]);
    expect(noBase.exitCode).toBe(0);

    // With --base: the committed gatefn edit scopes REQ-650 in → its stale
    // evidence fires the independent staleness exit-2 channel.
    const withBase = await gateJson(dir, ["--base", "base"]);
    expect(withBase.exitCode).toBe(2);
    expect(withBase.json.staleGate).toBe(true);
    expect(withBase.json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
  });
});
