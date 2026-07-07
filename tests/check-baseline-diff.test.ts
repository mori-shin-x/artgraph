import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runAt } from "./helpers.js";
import {
  makeRepoWithDebt,
  makeUnbornRepo,
  introduceNewOrphan,
  makeRepoWithOrphan,
} from "./helpers.js";

// spec 017 US1 (T011/T014) — `check --diff --gate` must be decided by NEW
// issues only, so a pre-existing debt REQ dragged into the blast radius never
// fails the gate (issue #174), while the lazy-eval path skips the baseline
// worktree entirely when the scope is clean.

const repos: string[] = [];
function repo(prefix: string): string {
  return track(makeRepoWithDebt(prefix));
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

  it("(b) harmless edit to a debt-connected file → exit 0, pre-existing REQ NOT new", async () => {
    const dir = repo("artgraph-debt-us1b-");
    // Touch the hub: its blast radius reaches the sibling pre-existing debt
    // REQ-200 via the shared doc, but the edit introduces nothing new.
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless comment\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("computed");
    // REQ-200 is in scope (pre-existing) but must NOT be flagged as new.
    expect(json.uncovered).toContain("REQ-200");
    expect(json.newIssues.uncovered).not.toContain("REQ-200");
    expect(json.newIssues.uncovered).toEqual([]);
    expect(json.suppressedCount).toBeGreaterThanOrEqual(1);
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
    expect(json.newIssues).toEqual({ drifted: [], orphans: [], uncovered: [], testFailures: [] });
    expect(json.suppressedCount).toBe(0);
    expect(Array.isArray(json.warnings)).toBe(true);
    expect(json.message).toContain("Changed files are not tracked in the graph.");
  });

  it("(d) clean scope (covered file) → baseline skipped, no worktree built (SC-005)", async () => {
    const dir = repo("artgraph-debt-us1d-");
    // clean.ts's blast radius only reaches the fully-covered REQ-001 — zero
    // scoped issues, so the lazy-eval short-circuit must fire.
    appendFileSync(join(dir, "src", "clean.ts"), "\n// harmless comment\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);
    expect(json.baselineStatus).toBe("skipped");
  });

  it("(e) scope with pre-existing debt only → baseline computed and subtracted → exit 0", async () => {
    const dir = repo("artgraph-debt-us1e-");
    appendFileSync(join(dir, "src", "hub.ts"), "\n// another harmless comment\n");

    const { exitCode, json } = await checkJson(dir);
    expect(exitCode).toBe(0);
    expect(json.baselineStatus).toBe("computed");
    // Every scoped issue was pre-existing → nothing new → gate passes.
    expect(json.newIssues).toEqual({ drifted: [], orphans: [], uncovered: [], testFailures: [] });
    expect(json.suppressedCount).toBeGreaterThanOrEqual(1);
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
    expect(json.newIssues).toEqual({ drifted: [], orphans: [], uncovered: [], testFailures: [] });
  });
});

// spec 017 US2 (T021) — baselineStatus invariants (data-model §1.1). The state
// machine must never emit an incoherent combination.
describe("check --diff --gate baselineStatus invariants (T021)", () => {
  it("skipped ⇒ newIssues all-empty AND scoped arrays all-empty AND pass", async () => {
    const dir = repo("artgraph-inv-skip-");
    appendFileSync(join(dir, "src", "clean.ts"), "\n// harmless\n");
    const { json } = await checkJson(dir);
    expect(json.baselineStatus).toBe("skipped");
    expect(json.pass).toBe(true);
    // No baseline was built because the scope carried zero issues.
    for (const arr of [json.drifted, json.orphans, json.uncovered, json.testFailures]) {
      expect(arr).toEqual([]);
    }
    expect(json.newIssues).toEqual({ drifted: [], orphans: [], uncovered: [], testFailures: [] });
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
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd: dir, stdio: "pipe" });

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
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd: dir, stdio: "pipe" });
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
// blast radius (FR-007 / SC-006). `impact` still reports the pre-existing debt
// REQ that `check --gate` suppresses.
describe("impact --diff blast radius is preserved (US4)", () => {
  it("impact still reports the debt REQ that the gate suppresses", async () => {
    const dir = repo("artgraph-us4-impact-");
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless\n");

    const impact = await runAt(dir, ["impact", "--diff", "--format", "json"]);
    const ij = JSON.parse(impact.stdout);
    // Blast radius reaches BOTH reqs via the shared doc — unchanged by spec 017.
    expect(ij.impactReqs).toContain("REQ-100");
    expect(ij.impactReqs).toContain("REQ-200");
    expect(ij.summary.reqs).toBe(2);

    // …yet the same change's gate treats the pre-existing REQ-200 as suppressed.
    const gate = await checkJson(dir);
    expect(gate.exitCode).toBe(0);
    expect(gate.json.newIssues.uncovered).not.toContain("REQ-200");
    expect(gate.json.uncovered).toContain("REQ-200"); // still visible in scoped output
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
