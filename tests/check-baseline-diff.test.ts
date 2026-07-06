import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runAt } from "./helpers.js";
import { makeRepoWithDebt, makeUnbornRepo, introduceNewOrphan } from "./helpers.js";

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
