import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runAt } from "./helpers.js";
import {
  makeRepoWithDebt,
  makeUnbornRepo,
  introduceNewOrphan,
  makeRepoWithOrphan,
  makeRepoWithSoleImplTag,
} from "./helpers.js";

// spec 017 US1 (T011/T014) — `check --diff --gate` must be decided by NEW
// issues only, so a pre-existing debt REQ dragged into the blast radius never
// fails the gate (issue #174), while the lazy-eval path skips the baseline
// worktree entirely when the scope is clean.

const repos: string[] = [];
function repo(prefix: string): string {
  return track(makeRepoWithDebt(prefix));
}
function repoSoleImpl(prefix: string): string {
  return track(makeRepoWithSoleImplTag(prefix));
}
// Register an already-created temp repo for afterEach cleanup.
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

async function checkJson(dir: string): Promise<{ exitCode: number; json: any }> {
  const { stdout, exitCode } = await runAt(dir, ["check", "--diff", "--gate", "--format", "json"]);
  return { exitCode, json: JSON.parse(stdout) };
}

describe("check --diff --gate baseline diff (US1)", () => {
  it("(a) clean working tree → exit 0, baseline skipped (no diff)", async () => {
    const dir = repo("artgraph-debt-us1a-");
    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("skipped");
  });

  it("(b) harmless edit to the hub → exit 0, doc-sibling debt REQ excluded from scope entirely (spec 019 US3)", async () => {
    const dir = repo("artgraph-debt-us1b-");
    // spec 019 (issue #215): touching the hub reaches only its own `@impl`
    // claim (REQ-100) — the `contains` reverse edge no longer bridges
    // REQ-100 -> parent doc -> sibling REQ-200, so the pre-existing debt
    // REQ never enters scope at all (previously it leaked in "for free" via
    // the shared doc and had to be suppressed as pre-existing debt).
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless comment\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    // issue #229 — baseline is now eagerly computed for every `--diff` run
    // with a non-empty diff (the old lazy-eval short-circuit on a clean
    // scope was removed: it was never compatible with US2 AS3). Scope is
    // still fully clean (REQ-100 alone, and it's covered) — only how we got
    // there changed, not the outcome.
    expect(json.baselineStatus).toBe("computed");
    expect(json.uncovered).not.toContain("REQ-200");
    expect(json.uncovered).toEqual([]);
    expect(json.newIssues.uncovered).toEqual([]);
    expect(json.suppressedCount).toBe(0);
  });

  it("(c) editing an untracked file outside the graph → exit 0 (FR-013)", async () => {
    const dir = repo("artgraph-debt-us1c-");
    writeFileSync(join(dir, "README.md"), "# Readme\n\nunrelated change\n");
    const { stdout, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Changed files are not tracked in the graph.");
  });

  // spec 017 (Critical fix D1, issue #182 review) — the SAME scenario as (c)
  // above but `--format json`: before the fix this branch always logged plain
  // text regardless of `--format`, so a CI/Skill consumer piping the output
  // into `jq` would fail on invalid JSON. The payload shape mirrors the
  // `diffFiles.length === 0` short-circuit (E4) one branch up.
  it("(c-json) editing an untracked file outside the graph → --format json emits CheckResult-shaped payload (D1)", async () => {
    const dir = repo("artgraph-debt-us1c-json-");
    writeFileSync(join(dir, "README.md"), "# Readme\n\nunrelated change\n");
    const { stdout, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("skipped");
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
    expect(json.suppressedCount).toBe(0);
    expect(Array.isArray(json.warnings)).toBe(true);
    expect(json.message).toContain("Changed files are not tracked in the graph.");
  });

  it("(d) clean scope (covered file) → baseline still computed eagerly (issue #229 union scope)", async () => {
    const dir = repo("artgraph-debt-us1d-");
    // clean.ts's blast radius only reaches the fully-covered REQ-001 — zero
    // scoped issues. Pre-#229 this was the SC-005 lazy-eval short-circuit
    // ("skipped"); the fix makes `--diff` always build the baseline so a
    // deleted-edge diff can't silently skip it, so this is now "computed"
    // even though the outcome (no issues) is unchanged.
    appendFileSync(join(dir, "src", "clean.ts"), "\n// harmless comment\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("computed");
  });

  it("(e) hub-only edit → scope carries no pre-existing debt, baseline still computed eagerly (spec 019 US3 / issue #229)", async () => {
    const dir = repo("artgraph-debt-us1e-");
    // spec 019 (issue #215): this used to be the "pre-existing debt only"
    // scenario (REQ-200 dragged in via the shared doc, then suppressed as
    // pre-existing). With the doc-sibling leak fixed, hub.ts's blast radius
    // is just REQ-100 (covered) — there is no debt in scope to suppress.
    // issue #229 removed the SC-005 lazy-eval short-circuit this used to
    // take ("skipped"): the baseline is now always built for a non-empty
    // `--diff`, so this is "computed" even though nothing ends up scoped.
    appendFileSync(join(dir, "src", "hub.ts"), "\n// another harmless comment\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.baselineStatus).toBe("computed");
    // Nothing was ever in scope → nothing new, nothing suppressed.
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
    expect(json.suppressedCount).toBe(0);
  });
});

// spec 017 (Critical fix E1, issue #182 review) — in CI the checked-out
// working tree already matches the commit under test, so `--diff` finds an
// empty git diff on essentially every run and silently no-ops (exit 0, "no
// changes") regardless of what the PR actually changed. This does not fail
// the gate (exit code stays 0 — Phase 2 / issue #185 is the real fix) but the
// run must warn loudly that nothing was actually compared.
describe("check --diff CI shallow-clone silent no-op warning (E1)", () => {
  const prevCI = process.env.CI;
  afterEach(() => {
    if (prevCI === undefined) delete process.env.CI;
    else process.env.CI = prevCI;
  });

  it("CI=true + empty git diff → stderr warns and json warnings[] carries the same message", async () => {
    const dir = repo("artgraph-debt-us1-ci-");
    process.env.CI = "true";
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      "WARNING: gate is not active in CI without --base <ref> (Phase 2 — see #185).",
    );
    const json = JSON.parse(stdout);
    expect(json.baselineStatus).toBe("skipped");
    expect(
      (json.warnings as unknown[]).some(
        (w) => typeof w === "string" && w.includes("gate is not active in CI"),
      ),
    ).toBe(true);
  });

  it("CI=1 + empty git diff (text format) → stderr warns, exit code unchanged", async () => {
    const dir = repo("artgraph-debt-us1-ci1-");
    process.env.CI = "1";
    const { stdout, stderr, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No changes detected in git diff.");
    expect(stderr).toContain("gate is not active in CI without --base <ref>");
  });

  it("no CI env + empty git diff → no CI warning on stderr", async () => {
    const dir = repo("artgraph-debt-us1-noci-");
    delete process.env.CI;
    const { stderr, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("gate is not active in CI");
  });
});

// spec 017 US2 (T016/T017/T022) — a change that actually breaks the graph must
// fail the gate. Suppressing pre-existing debt (US1) must never fail-open on a
// newly introduced drift / orphan / uncovered (SC-002).
describe("check --diff --gate catches newly introduced issues (US2)", () => {
  it("(a) an @impl claim to a nonexistent REQ → new orphan → exit 2", async () => {
    const dir = repo("artgraph-new-orphan-");
    introduceNewOrphan(dir);

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.newIssues.orphans).toContain("file:src/hub.ts -> REQ-999 (implements)");
    // The pre-existing debt REQ is still suppressed, not conflated with the new one.
    expect(json.newIssues.uncovered).not.toContain("REQ-200");
  });

  it("(b) new REQ added to an in-scope spec with no @impl → new uncovered → exit 2", async () => {
    const dir = repo("artgraph-new-uncov-");
    // Editing debt.md pulls all its reqs into scope; REQ-201 is brand-new and
    // uncovered, while REQ-200 was already uncovered at HEAD (pre-existing).
    appendFileSync(join(dir, "specs", "debt.md"), "- REQ-201: newly added, unimplemented\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.newIssues.uncovered).toContain("REQ-201");
    expect(json.newIssues.uncovered).not.toContain("REQ-200");
  });

  it("(c) spec edited after reconcile, lock not updated → new drift → exit 2 (FR-011)", async () => {
    const dir = repo("artgraph-new-drift-");
    // Reconcile so the CURRENT lock matches HEAD content. The baseline (base
    // graph vs current lock) then shows NO drift, so the post-edit drift is new.
    const rec = await runAt(dir, ["reconcile"]);
    expect(rec.exitCode).toBe(0);
    // Edit an existing req's line → its contentHash changes → drift vs lock.
    writeFileSync(
      join(dir, "specs", "debt.md"),
      "# Debt\n\n- REQ-100: covered by the hub (edited body)\n- REQ-200: pre-existing uncovered debt\n",
    );

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.newIssues.drifted.some((d: { nodeId: string }) => d.nodeId === "REQ-100")).toBe(
      true,
    );
  });

  it("(d) pre-existing debt only, no new issue → exit 0", async () => {
    const dir = repo("artgraph-us2-preonly-");
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");
    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
  });
});

// issue #229 (spec 017 US2 AS3) — deleting the ONLY `@impl`/`@verifies` edge
// to a REQ is a code-only diff, so the pre-fix CURRENT-graph-only scope
// calculation could no longer reach the REQ at all (the edge that used to
// carry it into scope is gone from the graph being walked) and the gate
// silently passed. The fix computes scope on BOTH the current graph and the
// eagerly-built baseline graph and unions them, so the REQ still enters
// scope via the side where the edge is still present (the baseline).
// @impl 017-check-gate-baseline-diff/US2-AS3
describe("check --diff --gate catches a deleted sole @impl/@verifies edge (issue #229)", () => {
  it("(T229-1) deleting the sole @impl REQ-500 line (code-only edit) → new uncovered → exit 2", async () => {
    const dir = repoSoleImpl("artgraph-229-impl-edit-");
    const targetPath = join(dir, "src", "target.ts");
    const before = readFileSync(targetPath, "utf-8");
    // Remove ONLY the `@impl REQ-500` comment line — fnTarget's body stays,
    // so this is a pure edge deletion, not a file/symbol deletion.
    const after = before
      .split("\n")
      .filter((line) => !line.includes("@impl REQ-500"))
      .join("\n");
    expect(after).not.toEqual(before);
    writeFileSync(targetPath, after);

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.pass).toBe(false);
    expect(json.uncovered).toContain("REQ-500");
    expect(json.newIssues.uncovered).toContain("REQ-500");
    expect(json.baselineStatus).toBe("computed");
  });

  it("(T229-2) deleting the sole @verifies [REQ-501] tag does NOT spuriously flag REQ-501 (findUncovered ignores verifies)", async () => {
    const dir = repoSoleImpl("artgraph-229-verifies-edit-");
    // REQ-501 keeps its `@impl` in src/target.ts untouched — only the test
    // file's `[REQ-501]` verifies tag is removed. `findUncovered` never looks
    // at `verifies` edges, so this must NOT turn into a new uncovered/orphan
    // issue; it's a negative-control pin so the union-scope fix (which now
    // ALSO reaches REQ-501 via the baseline side) doesn't over-trigger.
    const testPath = join(dir, "tests", "target.test.ts");
    const before = readFileSync(testPath, "utf-8");
    const after = before.replace(" [REQ-501]", "");
    expect(after).not.toEqual(before);
    writeFileSync(testPath, after);

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.uncovered).not.toContain("REQ-501");
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
  });

  it("(T229-3) git rm of the sole-@impl file → new uncovered → exit 2", async () => {
    const dir = repoSoleImpl("artgraph-229-rm-");
    // Unstaged working-tree deletion (no commit) — src/target.ts is gone
    // from the CURRENT graph entirely, so `resolveStartIds` on the current
    // graph can't resolve it at all; only the baseline (HEAD) side can.
    execFileSync("git", ["rm", "src/target.ts"], { cwd: dir, stdio: "pipe" });

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.pass).toBe(false);
    expect(json.uncovered).toContain("REQ-500");
    expect(json.newIssues.uncovered).toContain("REQ-500");
    expect(json.baselineStatus).toBe("computed");
  });

  it("(T229-4) deleting an already-uncovered REQ's spec line stays suppressed → exit 0", async () => {
    const dir = repo("artgraph-229-spec-del-");
    // REQ-200 has no @impl anywhere in makeRepoWithDebt — it's pre-existing
    // uncovered debt at HEAD. Deleting its spec line entirely removes the
    // node from the CURRENT graph, so it can't be reported as newly
    // uncovered (there's no REQ-200 node left to flag) — but the union-scope
    // fix pulls REQ-200 into scope via the BASELINE side (the line still
    // exists there), so this pins that the fix doesn't turn a REQ's removal
    // into a false "new" issue.
    const specPath = join(dir, "specs", "debt.md");
    const before = readFileSync(specPath, "utf-8");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("REQ-200"))
      .join("\n");
    expect(after).not.toEqual(before);
    writeFileSync(specPath, after);

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.uncovered).not.toContain("REQ-200");
    expect(json.newIssues.uncovered).not.toContain("REQ-200");
  });

  // issue #229 review (Finding 1, PR #237, BLOCKER) — a `git mv` AND a
  // deletion of the sole `@impl` edge in the SAME diff. `getGitDiffFiles`
  // (modern git default `diff.renames = true`) reports only the NEW path
  // (`src/renamed.ts`); the current graph resolves it fine (the file still
  // exists there), but the OLD path (`src/target.ts`) is what the baseline
  // graph actually has a node for. Without rename-aware baseline entry
  // resolution, `resolveStartIds(baselineGraph, entries)` misses entirely
  // (`file:src/renamed.ts` was never in the baseline graph), so the
  // baseline-side scope never re-discovers REQ-500 either, and the gate
  // fails open exactly like the original issue #229 bug.
  it("(T229-5) git mv + delete sole @impl in same diff → new uncovered → exit 2 (rename-aware baseline resolve)", async () => {
    const dir = repoSoleImpl("artgraph-229-rename-and-delete-");
    // git mv the file THEN drop the @impl REQ-500 line — baseline (HEAD)
    // sees src/target.ts with the @impl, working tree sees src/renamed.ts
    // without.
    execFileSync("git", ["mv", "src/target.ts", "src/renamed.ts"], {
      cwd: dir,
      stdio: "pipe",
    });
    const renamedPath = join(dir, "src", "renamed.ts");
    const before = readFileSync(renamedPath, "utf-8");
    const after = before
      .split("\n")
      .filter((l) => !l.includes("@impl REQ-500"))
      .join("\n");
    expect(after).not.toEqual(before);
    writeFileSync(renamedPath, after);

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.pass).toBe(false);
    expect(json.newIssues.uncovered).toContain("REQ-500");
  });
});

// spec 017 US2 (T021) — baselineStatus invariants (data-model §1.1). The state
// machine must never emit an incoherent combination.
describe("check --diff --gate baselineStatus invariants (T021)", () => {
  it("skipped ⇒ newIssues all-empty AND scoped arrays all-empty AND pass", async () => {
    const dir = repo("artgraph-inv-skip-");
    // issue #229 — "skipped" is reachable ONLY via the `diffFiles.length ===
    // 0` short-circuit now (no edit at all): the old SC-005 lazy-eval path
    // that reached "skipped" on a clean-but-nonempty diff was removed, since
    // it was never compatible with US2 AS3 (it's what let a deleted `@impl`
    // edge silently skip the baseline entirely).
    const { json } = await checkJson(dir);
    expect(json.baselineStatus).toBe("skipped");
    expect(json.pass).toBe(true);
    // No baseline was built because the scope carried zero issues.
    for (const arr of [json.drifted, json.orphans, json.uncovered, json.testFailures]) {
      expect(arr).toEqual([]);
    }
    expect(json.newIssues).toEqual({
      drifted: [],
      orphans: [],
      uncovered: [],
      testFailures: [],
    });
    expect(json.suppressedCount).toBe(0);
  });

  it("empty ⇒ newIssues equals the scoped issue arrays (all current is new, FR-014)", async () => {
    const dir = track(makeUnbornRepo("artgraph-inv-empty-"));
    const { exitCode, json } = await checkJson(dir);
    expect(json.baselineStatus).toBe("empty");
    // REQ-300 is uncovered and, with an empty baseline, brand-new.
    expect(json.uncovered).toContain("REQ-300");
    expect(json.newIssues.uncovered).toEqual(json.uncovered);
    expect(json.suppressedCount).toBe(0);
    expect(exitCode).toBe(2);
  });

  it("pass ⇔ every newIssues array is empty", async () => {
    const passing = repo("artgraph-inv-pass-");
    appendFileSync(join(passing, "src", "hub.ts"), "\n// harmless\n");
    const a = await checkJson(passing);
    expect(a.json.pass).toBe(newIssuesEmpty(a.json.newIssues));

    const failing = repo("artgraph-inv-fail-");
    introduceNewOrphan(failing);
    const b = await checkJson(failing);
    expect(b.json.pass).toBe(newIssuesEmpty(b.json.newIssues));
    expect(b.json.pass).toBe(false);
  });
});

// spec 017 US2 (T022) — edge cases.
describe("check --diff --gate edge cases (T022)", () => {
  it("(c) a change touching only files outside the graph keeps legacy behavior (FR-013)", async () => {
    const dir = repo("artgraph-edge-outside-");
    writeFileSync(join(dir, "NOTES.txt"), "just some notes, not in the graph\n");
    const { stdout, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Changed files are not tracked in the graph.");
  });
});

// issue #229 review (Finding 2, PR #237, MAJOR) — a diff that touches ONLY
// files outside the graph (e.g. an untracked README) must not eagerly build
// the baseline `git worktree add` + `scan()` only to immediately discard it
// at the "not tracked" early exit — that regressed this specific case's
// latency ~5x versus pre-#229. This is a correctness test (CI can't reliably
// time itself): it asserts `baselineStatus === "skipped"` rather than
// "computed", which is only true if the baseline scan was actually skipped.
describe("check --diff --gate untracked-only diff skips eager baseline (issue #229 review, Finding 2)", () => {
  it("(T229-perf) diff touches only files outside the graph → baseline scan is skipped, not computed (perf fix)", async () => {
    const dir = repo("artgraph-229-untracked-perf-");
    writeFileSync(join(dir, "unrelated.md"), "# Notes\n");
    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.message).toContain("Changed files are not tracked in the graph.");
    // Pre-#229 lazy-eval path is restored for this specific case: no
    // baseline was built because no diff path was tracked at HEAD.
    expect(json.baselineStatus).toBe("skipped");
  });
});

// spec 017 (High fix C2, issue #182 review) — `orphanKey` embeds the
// orphan's `source` path, so a pure `git mv` of a file carrying a
// pre-existing orphan (zero content change, `@impl` tag intact) used to
// compute a DIFFERENT baseline key than the current side's key (which
// always reflects the live, post-rename path) — the pre-existing orphan
// failed to suppress and the gate false-positived on a pure rename
// (SC-004; issue #174's failure mode recurring on the rename path).
// `getGitRenameMap` + baseline-side normalization (src/baseline.ts) fixes
// this by rewriting the BASELINE orphan's source onto the renamed path
// before its key is computed.
describe("check --diff --gate rename-aware baseline normalization (C2)", () => {
  it("(T-rename-1) git mv of a pre-existing-orphan file → exit 0, orphan stays suppressed", async () => {
    const dir = track(makeRepoWithOrphan("artgraph-c2-rename-1-"));
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], {
      cwd: dir,
      stdio: "pipe",
    });

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("computed");
    // The orphan is still visible in the scoped display (at its NEW path)…
    expect(json.orphans).toContain("file:src/new.ts -> REQ-999 (implements)");
    // …but must not be counted as a newly introduced issue.
    expect(json.newIssues.orphans).toEqual([]);
    expect(json.suppressedCount).toBeGreaterThanOrEqual(1);
  });

  it("(T-rename-2) rename stays suppressed even when a genuinely new orphan is introduced elsewhere → exit 2 for the new one only", async () => {
    const dir = track(makeRepoWithOrphan("artgraph-c2-rename-2-"));
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], {
      cwd: dir,
      stdio: "pipe",
    });
    // A brand-new orphan on a DIFFERENT, previously-clean file — must still
    // be caught, so the rename normalization can't be a blanket amnesty.
    // (String literal split with concatenation to avoid the artgraph scanner
    // picking this up when running `artgraph check --diff` on this repo
    // itself; the fixture repo still sees the concatenated tag.)
    appendFileSync(join(dir, "src", "clean.ts"), "// @" + "impl REQ-888\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(2);
    expect(json.pass).toBe(false);
    // Renamed pre-existing orphan: still suppressed, not new.
    expect(json.newIssues.orphans).not.toContain("file:src/new.ts -> REQ-999 (implements)");
    // Freshly introduced orphan: counted as new and fails the gate.
    expect(json.newIssues.orphans).toContain("file:src/clean.ts -> REQ-888 (implements)");
  });
});

// spec 017 US4 (T027) — the gate narrowing must NOT shrink the `impact --diff`
// blast radius (FR-007 / SC-006): `check --diff`'s scope must always agree
// with plain `impact --diff`'s reach — the gate only decides new-vs-pre-
// existing, it never computes a narrower reachable set of its own.
//
// spec 019 (issue #215) update: this fixture's original demonstration relied
// on REQ-200 being reachable from hub.ts ONLY via the doc-sibling containment
// leak that spec 019 removes — REQ-100 and REQ-200 share `specs/debt.md` but
// hub.ts has zero code dependency on REQ-200. That reachability was itself
// the bug #215 reports, so "impact still reports the debt REQ the gate
// suppresses" no longer has a debt REQ to report: hub.ts's blast radius is
// now exactly REQ-100. The invariant this test protects (impact's view and
// check's scope never diverge) still holds — just with a narrower shared
// scope, which is the fix working as intended.
describe("impact --diff blast radius is preserved (US4)", () => {
  it("impact and check --diff agree: hub.ts's blast radius is REQ-100 only, doc-sibling debt is out of scope (spec 019 US3)", async () => {
    const dir = repo("artgraph-us4-impact-");
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");

    const impact = await runAt(dir, ["impact", "--diff", "--format", "json"]);
    const ij = JSON.parse(impact.stdout);
    expect(ij.impactReqs).toEqual(["REQ-100"]);
    expect(ij.impactReqs).not.toContain("REQ-200");
    expect(ij.summary.reqs).toBe(1);

    // check --diff's scope agrees: nothing pre-existing is in scope, so there
    // is no debt REQ to suppress. issue #229 removed the lazy-eval
    // short-circuit that used to keep baselineStatus "skipped" here — the
    // baseline is now always computed for a non-empty `--diff`.
    const gate = await checkJson(dir);
    expect(gate.exitCode).toBe(0);
    expect(gate.json.baselineStatus).toBe("computed");
    expect(gate.json.newIssues.uncovered).not.toContain("REQ-200");
    expect(gate.json.uncovered).not.toContain("REQ-200");
  });
});

// ---------------------------------------------------------------------------
// spec 019 (US3, T007) — dedicated pin for the spec's Independent Test:
// same-doc REQ-A (REQ-100, implemented) / REQ-B (REQ-200, uncovered) via
// `tests/helpers.ts`'s `makeRepoWithDebt` fixture. A code-only diff must NOT
// pull REQ-B into the scoped `uncovered` array; diffing the spec file itself
// must (spec-change path stays unretouched — FR-011 / Edge Case).
// ---------------------------------------------------------------------------
describe("check --diff scope purification — same-spec REQ-A/REQ-B (spec 019 US3, T007)", () => {
  it("AS3-1: code-only diff (hub.ts) → scoped uncovered excludes the sibling debt REQ-B", async () => {
    const dir = repo("artgraph-019-us3-code-");
    appendFileSync(join(dir, "src", "hub.ts"), "\n// spec 019 US3 pin — code-only diff\n");
    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.uncovered).not.toContain("REQ-200");
  });

  it("AS3-2: spec-file diff (specs/debt.md) → REQ-B enters scope as (pre-existing) uncovered", async () => {
    const dir = repo("artgraph-019-us3-spec-");
    appendFileSync(join(dir, "specs", "debt.md"), "\n<!-- spec 019 US3 pin — spec-file diff -->\n");
    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    // resolveStartIds' filePath fallback seeds the doc + every req parsed
    // from it directly (no `contains` traversal needed) — unaffected by the
    // direction constraint, per spec 019 Edge Cases.
    expect(json.uncovered).toContain("REQ-200");
    // Still pre-existing (REQ-100/REQ-200 content unchanged) → suppressed,
    // not new.
    expect(json.newIssues.uncovered).not.toContain("REQ-200");
  });
});

// issue #178 — `check --diff --gate --ignore <csv>` is a one-shot escape
// hatch so an in-progress SDD implementation (tasks.md-driven, REQs landing
// one at a time) doesn't get gate-blocked on a REQ that legitimately isn't
// implemented yet. Same CSV-parsing contract as `plan-coverage --ignore`
// (trim + silent empty-entry drop); no persistence.
describe("check --diff --gate --ignore suppresses newIssues.uncovered (issue #178)", () => {
  it("(T178-1) --ignore REQ-500 suppresses new uncovered REQ-500 → exit 0", async () => {
    const dir = repoSoleImpl("artgraph-178-ignore-");
    const targetPath = join(dir, "src", "target.ts");
    const before = readFileSync(targetPath, "utf-8");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("@impl REQ-500"))
      .join("\n");
    expect(after).not.toEqual(before);
    writeFileSync(targetPath, after);

    // --ignore なし: exit 2 (既存 T229-1 挙動)
    const noIgnore = await checkJson(dir);
    expect(noIgnore.exitCode).toBe(2);
    expect(noIgnore.json.newIssues.uncovered).toContain("REQ-500");

    // --ignore REQ-500: exit 0
    const withIgnore = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
      "--ignore",
      "REQ-500",
    ]);
    expect(withIgnore.exitCode).toBe(0);
    const json = JSON.parse(withIgnore.stdout);
    expect(json.pass).toBe(true);
    expect(json.newIssues.uncovered).not.toContain("REQ-500");
    expect(withIgnore.stderr).toContain("--ignore suppressed 1 REQ");
    expect(withIgnore.stderr).toContain("REQ-500");
  });

  it("(T178-2) multiple REQ-IDs via CSV are all suppressed (trim + trailing comma)", async () => {
    const dir = repoSoleImpl("artgraph-178-ignore-multi-");
    const targetPath = join(dir, "src", "target.ts");
    const before = readFileSync(targetPath, "utf-8");
    // Drop BOTH sole @impl edges so REQ-500 and REQ-501 are both newly
    // uncovered (deleting only the [REQ-501] verifies tag, per T229-2,
    // would NOT make REQ-501 uncovered — findUncovered ignores verifies).
    const after = before
      .split("\n")
      .filter((line) => !line.includes("@impl REQ-500") && !line.includes("@impl REQ-501"))
      .join("\n");
    expect(after).not.toEqual(before);
    writeFileSync(targetPath, after);

    const noIgnore = await checkJson(dir);
    expect(noIgnore.exitCode).toBe(2);
    expect(noIgnore.json.newIssues.uncovered).toEqual(
      expect.arrayContaining(["REQ-500", "REQ-501"]),
    );

    // Trailing comma + surrounding whitespace must be tolerated, same as
    // `plan-coverage --ignore`'s CSV contract.
    const withIgnore = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
      "--ignore",
      " REQ-500 ,REQ-501,",
    ]);
    expect(withIgnore.exitCode).toBe(0);
    const json = JSON.parse(withIgnore.stdout);
    expect(json.pass).toBe(true);
    expect(json.newIssues.uncovered).not.toContain("REQ-500");
    expect(json.newIssues.uncovered).not.toContain("REQ-501");
    expect(withIgnore.stderr).toContain("--ignore suppressed 2 REQ");
    expect(withIgnore.stderr).toContain("REQ-500");
    expect(withIgnore.stderr).toContain("REQ-501");
  });

  it("(T178-3) --ignore without --diff emits a WARNING and has no effect on plain check", async () => {
    const dir = repoSoleImpl("artgraph-178-no-diff-");
    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--ignore",
      "REQ-500",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("WARNING: --ignore is only effective with --diff; ignoring.");
    const json = JSON.parse(stdout);
    // Plain check: REQ-500 has a live @impl, nothing uncovered.
    expect(json.uncovered).not.toContain("REQ-500");
  });

  it('(T178-4) --ignore "" (empty) has no effect and no warning/info', async () => {
    const dir = repoSoleImpl("artgraph-178-empty-ignore-");
    const targetPath = join(dir, "src", "target.ts");
    const before = readFileSync(targetPath, "utf-8");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("@impl REQ-500"))
      .join("\n");
    writeFileSync(targetPath, after);

    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
      "--ignore",
      "",
    ]);
    expect(exitCode).toBe(2);
    const json = JSON.parse(stdout);
    expect(json.newIssues.uncovered).toContain("REQ-500");
    expect(stderr).not.toContain("--ignore suppressed");
    expect(stderr).not.toContain("WARNING: --ignore is only effective with --diff");
  });

  it("(T178-5) --ignore of a REQ not present in newIssues.uncovered is silent (no INFO)", async () => {
    const dir = repoSoleImpl("artgraph-178-noop-ignore-");
    const targetPath = join(dir, "src", "target.ts");
    const before = readFileSync(targetPath, "utf-8");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("@impl REQ-500"))
      .join("\n");
    writeFileSync(targetPath, after);

    const { stdout, stderr, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
      "--ignore",
      "REQ-999",
    ]);
    // REQ-999 doesn't match the actual new uncovered REQ-500, so it's
    // unaffected — the gate still catches REQ-500.
    expect(exitCode).toBe(2);
    const json = JSON.parse(stdout);
    expect(json.newIssues.uncovered).toContain("REQ-500");
    expect(stderr).not.toContain("--ignore suppressed");
  });
});

function newIssuesEmpty(n: {
  drifted: unknown[];
  orphans: unknown[];
  uncovered: unknown[];
  testFailures: unknown[];
}): boolean {
  return (
    n.drifted.length === 0 &&
    n.orphans.length === 0 &&
    n.uncovered.length === 0 &&
    n.testFailures.length === 0
  );
}
