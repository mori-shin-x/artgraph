import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  runAt,
  makeRepoWithDebt,
  makeUnbornRepo,
  blockWorktreeAdd,
  introduceNewOrphan,
} from "./helpers.js";

// spec 017 US3 (T023/T025/T026) — `check --diff` output. The text surface must
// scale with the number of NEW issues, not the width of the blast radius
// (FR-008 / SC-004): a leading summary, new-issue detail only, a suppressed
// count for pre-existing debt, and a pointer to `impact --diff`. The json
// surface keeps every existing field and adds `newIssues` / `suppressedCount`
// / `baselineStatus` (FR-009, contract cli-check-gate §3).

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

describe("check --diff text output (US3, FR-008)", () => {
  it("(a) new issues → summary + new detail; no pre-existing debt left in scope (§4.1, spec 019 US3)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-out-newa-"));
    introduceNewOrphan(dir);
    const { stdout, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);

    expect(exitCode).toBe(2);
    // Leading summary line counting NEW issues only.
    expect(stdout).toMatch(/1 new issue introduced by this change:/);
    // New-issue detail, grouped with a per-category count.
    expect(stdout).toMatch(/ORPHANS \(1\):/);
    expect(stdout).toContain("REQ-999 (implements)");
    // spec 019 (issue #215): hub.ts's blast radius no longer reaches the
    // doc-sibling debt REQ-200 (no code dependency between them) — there is
    // nothing pre-existing left in scope, so neither the suppressed-count
    // line nor the impact pointer print anymore.
    expect(stdout).not.toMatch(/pre-existing issue/);
    expect(stdout).not.toContain("artgraph impact --diff");
    // SC-004 (unchanged): the pre-existing uncovered REQ is NOT enumerated.
    expect(stdout).not.toContain("REQ-200");
  });

  it("(b) hub.ts edit → doc-sibling debt no longer in scope → bare concise line (was §4.2, spec 019 US3)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-out-preb-"));
    appendFileSync(join(dir, "src", "hub.ts"), "\n// harmless comment\n");
    const { stdout, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No new issues introduced by this change.");
    // spec 019 (issue #215): REQ-200 is no longer part of hub.ts's blast
    // radius at all (no code dependency, only same-doc siblinghood) — there
    // is nothing pre-existing left in scope to suppress, so this scenario
    // now matches the bare §4.3 shape (no parenthetical suppressed line).
    expect(stdout).not.toContain("suppressed");
    expect(stdout).not.toContain("REQ-200");
    expect(stdout).not.toContain("artgraph impact --diff");
  });

  it("(c) clean scope (baseline computed, nothing new) → bare concise line, no suppressed count (§4.3)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-out-skipc-"));
    // clean.ts's blast radius has zero scoped issues. issue #229 removed the
    // SC-005 lazy-eval short-circuit (baseline is now always computed for a
    // non-empty `--diff`), but the text output is unaffected either way —
    // "computed" with nothing new prints the same bare line as "skipped" did.
    appendFileSync(join(dir, "src", "clean.ts"), "\n// harmless comment\n");
    const { stdout, exitCode } = await runAt(dir, ["check", "--diff", "--gate"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No new issues introduced by this change.");
    expect(stdout).not.toContain("suppressed");
  });
});

describe("check --diff json output (US3, FR-009, contract §3)", () => {
  it("(C7) keeps existing fields and adds newIssues/suppressedCount/baselineStatus (spec 019 US3)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-json-c7-"));
    introduceNewOrphan(dir);
    const { stdout, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
    ]);
    const j = JSON.parse(stdout);

    expect(exitCode).toBe(2);
    // Existing fields preserved (scoped, back-compat).
    expect(Array.isArray(j.drifted)).toBe(true);
    expect(Array.isArray(j.orphans)).toBe(true);
    expect(Array.isArray(j.uncovered)).toBe(true);
    expect(Array.isArray(j.coverage)).toBe(true);
    expect(Array.isArray(j.testFailures)).toBe(true);
    expect(Array.isArray(j.warnings)).toBe(true);
    // scoped orphans include the new one.
    expect(j.orphans).toContain("file:src/hub.ts -> REQ-999 (implements)");
    // spec 019 (issue #215): REQ-200 no longer enters scope via doc-sibling
    // containment — hub.ts's blast radius is exactly REQ-100 (covered), so
    // there is no pre-existing uncovered REQ left in the scoped list either.
    expect(j.uncovered).not.toContain("REQ-200");
    expect(j.newIssues.uncovered).not.toContain("REQ-200");
    // Added fields.
    expect(j.newIssues.orphans).toEqual(["file:src/hub.ts -> REQ-999 (implements)"]);
    // Nothing pre-existing is in scope to suppress — the new orphan is the
    // only scoped issue, and it's new (not suppressed).
    expect(j.suppressedCount).toBe(0);
    // The orphan alone is still a scoped issue → baseline is still computed.
    expect(j.baselineStatus).toBe("computed");
    expect(j.pass).toBe(false);
  });

  it("json baselineStatus unavailable → pass:false, newIssues empty, exit 1 with --gate (§3 note)", async () => {
    const dir = track(makeRepoWithDebt("artgraph-json-unavail-"));
    introduceNewOrphan(dir);
    blockWorktreeAdd(dir);
    const gate = await runAt(dir, ["check", "--diff", "--gate", "--format", "json"]);
    const j = JSON.parse(gate.stdout);

    expect(gate.exitCode).toBe(1);
    expect(j.baselineStatus).toBe("unavailable");
    expect(j.pass).toBe(false);
    expect(j.newIssues).toEqual({ drifted: [], orphans: [], uncovered: [], testFailures: [] });
    // Scoped issue arrays are still fully populated (CI can inspect them).
    expect(j.orphans).toContain("file:src/hub.ts -> REQ-999 (implements)");
    expect(gate.stderr).toContain("could not establish a baseline");
  });
});

// spec 017 (T026) — representative sweep of
// `--gate {on,off}` × `--format {json,text}` × baselineStatus.
describe("check --diff matrix: gate × format × baselineStatus", () => {
  type Case = {
    name: string;
    make: () => string;
    edit?: (dir: string) => void;
    status: "computed" | "empty" | "skipped" | "unavailable";
    hasNew: boolean;
  };

  const cases: Case[] = [
    {
      // spec 019 (issue #215): hub.ts's blast radius no longer reaches the
      // doc-sibling debt REQ-200 (no code dependency) — the scope is fully
      // clean (REQ-100 alone, covered). issue #229 removed the SC-005
      // lazy-eval short-circuit that used to make this "skipped": `--diff`
      // now always builds the baseline for a non-empty diff, so this is
      // "computed" even though nothing ends up new.
      name: "computed (hub edit — doc-sibling debt out of scope, spec 019)",
      make: () => makeRepoWithDebt("artgraph-mx-comp-clean-"),
      edit: (d) => appendFileSync(join(d, "src", "hub.ts"), "\n// noop\n"),
      status: "computed",
      hasNew: false,
    },
    {
      name: "computed + new orphan",
      make: () => makeRepoWithDebt("artgraph-mx-comp-new-"),
      edit: introduceNewOrphan,
      status: "computed",
      hasNew: true,
    },
    {
      // issue #229 — same eager-baseline change as the case above: this used
      // to be the SC-005 lazy-eval "skipped" path (scope carries zero
      // issues), now always "computed".
      name: "computed (clean scope)",
      make: () => makeRepoWithDebt("artgraph-mx-skip-"),
      edit: (d) => appendFileSync(join(d, "src", "clean.ts"), "\n// noop\n"),
      status: "computed",
      hasNew: false,
    },
    {
      name: "empty (unborn HEAD → all new)",
      make: () => makeUnbornRepo("artgraph-mx-empty-"),
      status: "empty",
      hasNew: true,
    },
    {
      name: "unavailable (worktree blocked)",
      make: () => makeRepoWithDebt("artgraph-mx-unavail-"),
      edit: (d) => {
        introduceNewOrphan(d);
        blockWorktreeAdd(d);
      },
      status: "unavailable",
      hasNew: true, // undeterminable → treated as not-pass, never silent pass
    },
  ];

  for (const c of cases) {
    for (const gate of [true, false]) {
      it(`${c.name} — ${gate ? "--gate" : "no-gate"} json`, async () => {
        const dir = track(c.make());
        c.edit?.(dir);
        const args = ["check", "--diff", ...(gate ? ["--gate"] : []), "--format", "json"];
        const { stdout, exitCode } = await runAt(dir, args);
        const j = JSON.parse(stdout);

        expect(j.baselineStatus).toBe(c.status);

        if (c.status === "unavailable") {
          // Undeterminable: never a silent pass; gate → exit 1, no-gate → 0.
          expect(j.pass).toBe(false);
          expect(exitCode).toBe(gate ? 1 : 0);
          return;
        }

        // Deterministic statuses: pass ⇔ no new issue.
        expect(j.pass).toBe(!c.hasNew);
        if (gate) {
          expect(exitCode).toBe(c.hasNew ? 2 : 0);
        } else {
          expect(exitCode).toBe(0);
        }
      });

      it(`${c.name} — ${gate ? "--gate" : "no-gate"} text`, async () => {
        const dir = track(c.make());
        c.edit?.(dir);
        const args = ["check", "--diff", ...(gate ? ["--gate"] : [])];
        const { exitCode } = await runAt(dir, args);

        if (c.status === "unavailable") {
          expect(exitCode).toBe(gate ? 1 : 0);
          return;
        }
        if (gate) {
          expect(exitCode).toBe(c.hasNew ? 2 : 0);
        } else {
          expect(exitCode).toBe(0);
        }
      });
    }
  }
});
