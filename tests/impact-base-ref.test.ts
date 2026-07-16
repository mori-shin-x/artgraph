// spec 024 — `impact --diff --base <ref>` (+ `--tests`): CI test selection
// (issue #305, the spec 023 D3 follow-up). In CI the checked-out tree matches
// the commit exactly, so plain `impact --diff --tests` is a permanent
// "No changes detected" no-op; `--base <ref>` widens the changed-file set to
// the merged diff (working-tree three-way union ∪ merge-base..HEAD range),
// sharing spec 023's `resolveMergeBase` / `getGitDiffFiles(rootDir, baseSha)`
// pipeline with `check --base` (agreement (i), 024-impact-base-ref/FR-013).
// impact stays current-graph-only — no baseline worktree, no rename map
// (024-impact-base-ref/FR-007, FR-011) — and every `--base` failure is
// fail-closed: stderr + exit 1, never JSON (024-impact-base-ref/FR-004).
//
// NOTE (dogfood-scan hygiene): bracket REQ tags and `@impl` literals inside
// this file are string-concatenated so artgraph's OWN scan of this repo never
// mistakes fixture text for a real tag (same convention as
// tests/check-base-ref.test.ts).
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  runAt,
  makeRepoWithBaseBranch,
  makeRepoWithDebt,
  makeRepoWithSoleImplTag,
  makeRepoWithTraceAndBaseBranch,
  withBaseAndFeatureBranches,
  gitCommitAll,
  gitUnrelatedRootBranch,
} from "./helpers.js";
import { FETCH_DEPTH_HINT } from "../src/baseline.js";
import { TRACE_NO_SHARDS_GUIDANCE } from "../src/commands/shared.js";

const repos: string[] = [];
function track(dir: string): string {
  repos.push(dir);
  return dir;
}
afterEach(() => {
  while (repos.length) {
    rmSync(repos.pop()!, { recursive: true, force: true });
  }
});

// The trace fixture's tagged test (see helpers.ts `makeRepoWithTraceAndBaseBranch`).
const TRACE_TEST_NAME = "[REQ-" + "601] charge bills a positive amount";
const TRACE_REQ_ID = "REQ-" + "601";

// ---------------------------------------------------------------------------
// T003 — parse layer is fail-closed. 024-impact-base-ref/FR-001, FR-010 /
// contract I11, I13. 〔観点: 実運用事故 (CI 変数の空展開)・境界条件〕
// ---------------------------------------------------------------------------
describe("impact parse layer: --format choices + --base value guard (spec 024 FR-001/FR-010)", () => {
  it("(I11a) --format with a bogus value → exit 1 via .choices(), no silent text fallback", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-fmt-bogus-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");
    const { stdout, stderr, exitCode } = await runAt(dir, ["impact", "--diff", "--format", "yaml"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Allowed choices are json, text");
    expect(stdout.trim()).toBe("");
  });

  it("(I11b) --format swallowing the next flag (--format --diff) → exit 1, never a lost start source", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-fmt-eaten-"));
    const { stdout, stderr, exitCode } = await runAt(dir, ["impact", "--format", "--diff"]);
    expect(exitCode).toBe(1);
    // Pre-024, "--diff" was silently consumed as the format value and the run
    // fell through to the unrelated "no start source specified" error.
    expect(stderr).toContain("Allowed choices are json, text");
    expect(stderr).not.toContain("no start source specified");
    expect(stdout.trim()).toBe("");
  });

  it("(I11c) --format json / --format text keep working unchanged", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-fmt-ok-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");
    const asJson = await runAt(dir, ["impact", "--diff", "--format", "json"]);
    expect(asJson.exitCode).toBe(0);
    expect(() => JSON.parse(asJson.stdout)).not.toThrow();
    const asText = await runAt(dir, ["impact", "--diff", "--format", "text"]);
    expect(asText.exitCode).toBe(0);
  });

  it('(I13a) --base "" (quoted-empty CI variable) → parse-time usage error exit 1', async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-base-empty-"));
    const { stdout, stderr, exitCode } = await runAt(dir, ["impact", "--diff", "--base", ""]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("must not be empty");
    expect(stdout.trim()).toBe("");
  });

  it("(I13b) --base swallowing the next flag (--base --tests) → parse-time usage error exit 1", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-base-eaten-"));
    // Pre-guard, an empty CI base-ref variable would assign ref="--tests" and
    // UNSET --tests — test selection silently becomes a plain impact run.
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "--tests",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must not start with "-"');
    expect(stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// T005 — validation order (contract §2 / D-3). 024-impact-base-ref/FR-002 /
// contract I1. 〔観点: 条件分岐の組み合わせ・不正な状態遷移 (エラー優先順位)〕
// ---------------------------------------------------------------------------
describe("impact --base requires --diff, positioned between rejection and exclusivity (spec 024 FR-002)", () => {
  const REQUIRES_DIFF = "--base requires --diff";

  it("(I1a) --base without --diff and without targets → requires-diff usage error, exit 1, stdout empty", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-req-diff-a-"));
    const { stdout, stderr, exitCode } = await runAt(dir, ["impact", "--base", "base"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(REQUIRES_DIFF);
    expect(stderr).toContain("artgraph impact --diff --base <ref> [--tests]");
    expect(stdout.trim()).toBe("");
  });

  it("(I1b) targets + --base without --diff → the SAME requires-diff error, NOT the exclusivity error", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-req-diff-b-"));
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "src/hub.ts",
      "--base",
      "base",
    ]);
    expect(exitCode).toBe(1);
    // D-3 priority pin: the user's mistake is "forgot --diff", not "two start
    // sources" — --base is a modifier, not a start source.
    expect(stderr).toContain(REQUIRES_DIFF);
    expect(stderr).not.toContain("mutually exclusive");
    expect(stdout.trim()).toBe("");
  });

  it("(I1c) targets + --diff + --base → the existing exclusivity error (requires-diff passed)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-req-diff-c-"));
    const { stderr, exitCode } = await runAt(dir, [
      "impact",
      "src/hub.ts",
      "--diff",
      "--base",
      "base",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "error: start sources are mutually exclusive (specify only one): targets, --diff",
    );
    expect(stderr).not.toContain(REQUIRES_DIFF);
  });

  it("(I1d) REQ-ID target + --base → the existing REQ-ID rejection fires FIRST (rejection precedes requires-diff)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-req-diff-d-"));
    const { stderr, exitCode } = await runAt(dir, ["impact", "REQ-001", "--base", "base"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error: REQ-ID inputs are not accepted by `artgraph impact`.");
    expect(stderr).not.toContain(REQUIRES_DIFF);
  });

  it("(I1e) requires-diff emits NO JSON even under --format json (a usage error is not a verdict)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-req-diff-e-"));
    const noTargets = await runAt(dir, ["impact", "--base", "base", "--format", "json"]);
    expect(noTargets.exitCode).toBe(1);
    expect(noTargets.stdout.trim()).toBe("");
    const withTargets = await runAt(dir, [
      "impact",
      "src/hub.ts",
      "--base",
      "base",
      "--format",
      "json",
    ]);
    expect(withTargets.exitCode).toBe(1);
    expect(withTargets.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// T007 — US1 main path: committed change, clean tree, trace shards →
// testsToRun from the commit range. 024-impact-base-ref/FR-006 / SC-001 /
// contract I3. 〔観点: 条件分岐の組み合わせ (CI の主経路)〕
// ---------------------------------------------------------------------------
describe("impact --diff --base --tests: CI commit-range test selection (spec 024 US1)", () => {
  it("(I3a) committed symbol edit (clean tree) + --base → testsToRun lists the exercising REQ's tagged test, exit 0", async () => {
    const dir = track(makeRepoWithTraceAndBaseBranch("artgraph-024-us1a-"));
    const { stdout, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.testsToRun).toEqual([
      {
        testFile: "tests/billing.test.ts",
        testName: TRACE_TEST_NAME,
        reqId: TRACE_REQ_ID,
      },
    ]);
  });

  it("(I3b) the SAME repo without --base → 'No changes detected' (the CI dead-end this feature removes)", async () => {
    const dir = track(makeRepoWithTraceAndBaseBranch("artgraph-024-us1b-"));
    const { stdout, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).message).toBe("No changes detected in git diff.");
  });

  it("(I3c) --base without --tests also widens impactReqs to the commit range (not a test-selection-only flag)", async () => {
    const dir = track(makeRepoWithTraceAndBaseBranch("artgraph-024-us1c-"));
    const { stdout, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).impactReqs).toContain(TRACE_REQ_ID);
  });
});

// ---------------------------------------------------------------------------
// T009 — graph-untracked files in the base range contribute nothing,
// silently (D-1's non-deletion side). 024-impact-base-ref/FR-007.
// 〔観点: エッジケース (silent contribution ゼロ)〕
// ---------------------------------------------------------------------------
describe("impact --diff --base: graph-untracked changed files are silently tolerated (spec 024 FR-007)", () => {
  it("README change + code change mixed in the base range → selection from the code side only, no error/warning", async () => {
    const dir = track(makeRepoWithTraceAndBaseBranch("artgraph-024-untracked-"));
    writeFileSync(join(dir, "README.md"), "# notes outside the graph\n");
    gitCommitAll(dir, "feature adds a README (outside the graph)");

    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("ERROR");
    expect(stderr).not.toContain("WARNING");
    const json = JSON.parse(stdout);
    expect(json.testsToRun.map((t: { reqId: string }) => t.reqId)).toContain(TRACE_REQ_ID);
    expect(json.affectedFiles).not.toContain("README.md");
  });
});

// ---------------------------------------------------------------------------
// T010 — committed deletion of the sole @impl file: impact contributes
// nothing (declared selection limitation), check --base --gate catches the
// uncovered fall-out (check-scope ⊇ impact-reach). 024-impact-base-ref/FR-007
// / SC-003 / contract I5. 〔観点: 例外系・実運用事故 (宣言された選択限界の境界)〕
// ---------------------------------------------------------------------------
describe("impact --diff --base: committed sole-@impl deletion — division of labor with check (spec 024 SC-003)", () => {
  function makeDeletionRepo(prefix: string): string {
    const dir = track(withBaseAndFeatureBranches(makeRepoWithSoleImplTag(prefix)));
    execFileSync("git", ["rm", "-q", "src/target.ts"], { cwd: dir, stdio: "pipe" });
    return dir;
  }

  it("(I5a) deletion + spec touch in the base range → impact resolves the survivors, deleted path contributes zero, no error", async () => {
    const dir = makeDeletionRepo("artgraph-024-del-a-");
    appendFileSync(join(dir, "specs", "target.md"), "\n<!-- feature-side spec touch -->\n");
    gitCommitAll(dir, "delete the sole @impl file + touch the spec");

    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("ERROR");
    const json = JSON.parse(stdout);
    // The deleted file exists in neither HEAD, the working tree, nor the
    // current graph — it resolves no startId and appears nowhere (D-1).
    expect(json.affectedFiles).not.toContain("src/target.ts");
    // The surviving spec touch still resolves (REQ-500 lives in target.md).
    expect(json.impactReqs).toContain("REQ-500");
  });

  it("(I5b) the SAME deletion under check --diff --base --gate → exit 2 (the gate, not the selection, owns correctness)", async () => {
    const dir = makeDeletionRepo("artgraph-024-del-b-");
    gitCommitAll(dir, "delete the sole @impl file");

    const { stdout, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--base",
      "base",
      "--gate",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(2);
    const json = JSON.parse(stdout);
    expect(json.newIssues.uncovered).toContain("REQ-500");
  });
});

// ---------------------------------------------------------------------------
// T012 — US2 union semantics: --base ADDS the commit range; the working-tree
// diff (untracked included) never shrinks. 024-impact-base-ref/FR-006 /
// contract I9. 〔観点: 境界条件 (union の両端)〕
// ---------------------------------------------------------------------------
describe("impact --diff --base: union of commit range and working tree (spec 024 US2)", () => {
  it("(I9a) committed change + untracked new graph file → both lineages reach impactReqs", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-union-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// committed harmless edit\n");
    gitCommitAll(dir, "feature edits the hub (committed)");
    // Untracked, never committed — must still be in the changed-file set.
    // ("@"-concatenation: dogfood-scan hygiene, see the file header.)
    writeFileSync(join(dir, "src", "extra.ts"), "// @" + "impl REQ-200\nexport const x = 1;\n");

    const { stdout, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.impactReqs).toContain("REQ-100"); // committed lineage (hub.ts @impl)
    expect(json.impactReqs).toContain("REQ-200"); // untracked lineage (extra.ts @impl)
  });

  it("(I9b) untracked-only change + --base → byte-identical to plain --diff", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-union-untracked-"));
    writeFileSync(join(dir, "src", "extra.ts"), "// @" + "impl REQ-200\nexport const x = 1;\n");

    const plain = await runAt(dir, ["impact", "--diff", "--format", "json"]);
    const withBase = await runAt(dir, ["impact", "--diff", "--base", "base", "--format", "json"]);
    expect(withBase.exitCode).toBe(plain.exitCode);
    expect(withBase.stdout).toBe(plain.stdout);
  });
});

// ---------------------------------------------------------------------------
// T013 — --base HEAD (merge-base == HEAD) degenerates to plain --diff.
// 024-impact-base-ref/SC-007 / contract I10. 〔観点: 境界条件〕
// ---------------------------------------------------------------------------
describe("impact --diff --base HEAD degenerates to plain --diff (spec 024 SC-007)", () => {
  it("(I10) uncommitted working-tree edit: --base HEAD output is byte-identical to no --base", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-basehead-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// uncommitted edit\n");

    const plain = await runAt(dir, ["impact", "--diff", "--format", "json"]);
    const baseHead = await runAt(dir, ["impact", "--diff", "--base", "HEAD", "--format", "json"]);
    expect(baseHead.exitCode).toBe(plain.exitCode);
    expect(plain.exitCode).toBe(0);
    expect(baseHead.stdout).toBe(plain.stdout);
  });
});

// ---------------------------------------------------------------------------
// T014 — empty merged diff + --base: a legitimate clean verdict, E4 JSON
// shape pinned field-for-field. 024-impact-base-ref/FR-006 / contract I8.
// 〔観点: エッジケース (正当な clean 判定)〕
// ---------------------------------------------------------------------------
describe("impact --diff --base: empty merged diff keeps the existing E4 early exit (spec 024 FR-006)", () => {
  it("(I8) same tip + clean tree + --base → exit 0 with the exact pre-024 E4 payload (no field added)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-emptydiff-"));
    const { stdout, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      affectedFiles: [],
      affectedDocs: [],
      impactReqs: [],
      affectedTasks: [],
      drifted: [],
      originReqs: [],
      summary: { docs: 0, reqs: 0, files: 0, tasks: 0 },
      warnings: [],
      message: "No changes detected in git diff.",
    });
  });
});

// ---------------------------------------------------------------------------
// T015 — US3 fail-closed environment errors: unresolvable ref / merge-base
// failure → stderr + FETCH_DEPTH_HINT, exit 1, NEVER JSON.
// 024-impact-base-ref/FR-004 / SC-004 / contract I6.
// 〔観点: 例外系・実運用事故 (shallow clone)〕
// ---------------------------------------------------------------------------
describe("impact --base fail-closed environment errors (spec 024 US3)", () => {
  it("(I6a) unresolvable ref → exit 1, 'does not resolve' + fetch-depth hint on stderr, stdout empty", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-noref-"));
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "nosuchref",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('base ref "nosuchref" does not resolve');
    expect(stderr).toContain(FETCH_DEPTH_HINT);
    expect(stdout).toBe("");
  });

  it("(I6b) unrelated histories (merge-base failure, the shallow-clone stand-in) → exit 1 + resolveMergeBase diagnostic", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-unrelated-"));
    gitUnrelatedRootBranch(dir, "unrelated");
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "unrelated",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("could not determine merge-base");
    expect(stderr).toContain(FETCH_DEPTH_HINT);
    expect(stdout).toBe("");
  });

  it("(I6c) both failures emit ZERO bytes of stdout even under --format json (SC-004)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-noref-json-"));
    gitUnrelatedRootBranch(dir, "unrelated");
    const noRef = await runAt(dir, ["impact", "--diff", "--base", "nosuchref", "--format", "json"]);
    expect(noRef.exitCode).toBe(1);
    expect(noRef.stdout).toBe("");
    const noMergeBase = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "unrelated",
      "--format",
      "json",
    ]);
    expect(noMergeBase.exitCode).toBe(1);
    expect(noMergeBase.stdout).toBe("");
  });

  it("(I6d) --tests + unresolvable ref: the shard guard passes first, then the base failure exits 1 (contract §2 order 5→6)", async () => {
    const dir = track(makeRepoWithTraceAndBaseBranch("artgraph-024-noref-tests-"));
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "nosuchref",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('base ref "nosuchref" does not resolve');
    expect(stdout).toBe("");
  });

  it("(I6e) --tests with ZERO shards + unresolvable ref → the shard guidance fires, not the base error (guard precedes base validation)", async () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-024-shards-first-"));
    const { stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "nosuchref",
      "--tests",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr.trim()).toBe(TRACE_NO_SHARDS_GUIDANCE);
  });
});

// ---------------------------------------------------------------------------
// T017 — merged diff with every path unresolved keeps the existing
// "No matching nodes found" exit 1, byte-identical (no new early exit).
// 024-impact-base-ref/FR-008 / contract I7.
// 〔観点: 変更外影響 (既存エラー経路の不変)〕
// ---------------------------------------------------------------------------
describe("impact --diff --base: fully-unresolved merged diff reuses the existing exit-1 path (spec 024 FR-008)", () => {
  it("(I7a) graph-external-only base range → 'No matching nodes found' byte-identical to the no-base path", async () => {
    const withBaseDir = track(makeRepoWithBaseBranch("artgraph-024-nomatch-base-"));
    writeFileSync(join(withBaseDir, "README.md"), "# notes outside the graph\n");
    gitCommitAll(withBaseDir, "feature adds a README (outside the graph)");
    const withBase = await runAt(withBaseDir, ["impact", "--diff", "--base", "base"]);

    const plainDir = track(makeRepoWithDebt("artgraph-024-nomatch-plain-"));
    writeFileSync(join(plainDir, "README.md"), "# notes outside the graph\n");
    const plain = await runAt(plainDir, ["impact", "--diff"]);

    expect(withBase.exitCode).toBe(1);
    expect(plain.exitCode).toBe(1);
    expect(withBase.stderr).toContain("No matching nodes found for: README.md");
    // Byte-identical wording AND path: --base adds no new early exit (D-4).
    expect(withBase.stderr).toBe(plain.stderr);
    expect(withBase.stdout).toBe(plain.stdout);
  });

  it("(I7b) deletion-only base range → the same existing exit 1, no --base-specific message", async () => {
    const dir = track(withBaseAndFeatureBranches(makeRepoWithSoleImplTag("artgraph-024-delonly-")));
    execFileSync("git", ["rm", "-q", "src/target.ts"], { cwd: dir, stdio: "pipe" });
    gitCommitAll(dir, "delete the sole @impl file (nothing else changes)");

    const { stdout, stderr, exitCode } = await runAt(dir, ["impact", "--diff", "--base", "base"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No matching nodes found for: src/target.ts");
    expect(stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// T018 — D-9: --tests × --base × trace.staleness "exclude" inverts the
// feature's purpose (changed code's evidence is stale by construction) →
// one non-fatal stderr WARNING, path unchanged. 024-impact-base-ref/FR-012 /
// SC-006 / contract I12. 〔観点: 条件分岐の組み合わせ (3 変数の全周辺)〕
// ---------------------------------------------------------------------------
describe("impact --tests --base × staleness exclude warning (spec 024 FR-012)", () => {
  const WARNING_HEAD = 'WARNING: --tests with --base under trace.staleness "exclude"';

  function countWarnings(stderr: string): number {
    return stderr.split(WARNING_HEAD).length - 1;
  }

  it("(I12a) all three conditions co-occur → the warning appears exactly once; exit code and stdout unchanged", async () => {
    const dir = track(
      makeRepoWithTraceAndBaseBranch("artgraph-024-d9-all-", { staleness: "exclude" }),
    );
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(countWarnings(stderr)).toBe(1);
    expect(stderr).toContain("its tests may be dropped from the selection");
    // Non-fatal: stdout is still the normal JSON verdict.
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("(I12b) any one condition missing → no warning", async () => {
    // exclude + --tests, but no --base.
    const noBase = track(
      makeRepoWithTraceAndBaseBranch("artgraph-024-d9-nobase-", { staleness: "exclude" }),
    );
    const a = await runAt(noBase, ["impact", "--diff", "--tests", "--format", "json"]);
    expect(a.exitCode).toBe(0);
    expect(countWarnings(a.stderr)).toBe(0);

    // exclude + --base, but no --tests.
    const noTests = track(
      makeRepoWithTraceAndBaseBranch("artgraph-024-d9-notests-", { staleness: "exclude" }),
    );
    const b = await runAt(noTests, ["impact", "--diff", "--base", "base", "--format", "json"]);
    expect(b.exitCode).toBe(0);
    expect(countWarnings(b.stderr)).toBe(0);

    // --tests + --base, but staleness "warn" (the CI-recommended setting).
    const warnMode = track(
      makeRepoWithTraceAndBaseBranch("artgraph-024-d9-warn-", { staleness: "warn" }),
    );
    const c = await runAt(warnMode, [
      "impact",
      "--diff",
      "--base",
      "base",
      "--tests",
      "--format",
      "json",
    ]);
    expect(c.exitCode).toBe(0);
    expect(countWarnings(c.stderr)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T019 — SC-005: every --base-less path is byte-identical to pre-024 (the
// sole declared exception, --format bogus values, is pinned in the parse
// describe above). 024-impact-base-ref/FR-003 / contract I2.
// 〔観点: 変更外影響 (byte-identical)〕
// ---------------------------------------------------------------------------
describe("impact without --base is byte-identical to pre-024 (spec 024 SC-005)", () => {
  it("--diff --format json: the exact pre-024 top-level key set (no field added on a trace-less repo)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-sc005-json-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");
    const { stdout, exitCode } = await runAt(dir, ["impact", "--diff", "--format", "json"]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(Object.keys(json).sort()).toEqual(
      [
        "affectedFiles",
        "affectedDocs",
        "impactReqs",
        "affectedTasks",
        "drifted",
        "originReqs",
        "summary",
        "warnings",
      ].sort(),
    );
    expect(json.impactReqs).toEqual(["REQ-100"]);
  });

  it("targets text path: unchanged exit 0", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-sc005-text-"));
    const { exitCode } = await runAt(dir, ["impact", "src/hub.ts"]);
    expect(exitCode).toBe(0);
  });

  it("REQ-ID rejection wording is unchanged — --base does NOT appear in the start-source menu (FR-003)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-sc005-rej-"));
    const { stderr, exitCode } = await runAt(dir, ["impact", "REQ-001"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error: REQ-ID inputs are not accepted by `artgraph impact`.");
    expect(stderr).toContain("artgraph impact <file>...");
    expect(stderr).toContain("artgraph impact --diff ");
    // --base is a --diff modifier, not a start source — it must not be
    // enumerated as one.
    expect(stderr).not.toContain("--base");
  });

  it("doc: prefix rejection wording is unchanged and --base-free", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-sc005-doc-"));
    const { stderr, exitCode } = await runAt(dir, ["impact", "doc:specs/debt.md"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error: `doc:` prefix inputs are not accepted by `artgraph impact`.");
    expect(stderr).not.toContain("--base");
  });

  it("no-source and exclusivity errors are unchanged and --base-free", async () => {
    const dir = track(makeRepoWithDebt("artgraph-024-sc005-src-"));
    const noSource = await runAt(dir, ["impact"]);
    expect(noSource.exitCode).toBe(1);
    expect(noSource.stderr.trim()).toBe(
      "error: no start source specified. pass file paths or --diff.",
    );

    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");
    const exclusive = await runAt(dir, ["impact", "src/hub.ts", "--diff"]);
    expect(exclusive.exitCode).toBe(1);
    expect(exclusive.stderr.trim()).toBe(
      "error: start sources are mutually exclusive (specify only one): targets, --diff",
    );
  });
});
