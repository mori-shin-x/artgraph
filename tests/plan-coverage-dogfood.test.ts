// spec 014 — Phase 9 (T027) self-dogfooding regression guard.
//
// Runs `plan-coverage` against THIS repo's spec 014 dir. The expectation:
// every REQ that the modified files touch is already documented somewhere
// in tasks.md / plan.md / spec.md (either as a bare mention in the task
// body, or as a `Considered:` line in the qualified-ID appendix that
// covers cross-spec ID collisions).
//
// If anyone changes a tracked file in a way that pulls in a NEW REQ-ID
// not yet referenced by the spec 014 source trio, this test fails — a
// useful guard against silent spec drift.
//
// Implementation note: invoked via the programmatic `runPlanCoverage`
// API (in-process) so we share the scan/graph build with the other unit
// tests rather than spawning the CLI. This keeps the test fast and
// avoids depending on a built dist/ in CI.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPlanCoverage } from "../src/plan-coverage/index.js";

// `__dirname` equivalent for ESM — the test file lives in `tests/`, repo
// root is one level up. Hard-coded relative jump is safe because vitest
// runs from the project root and the test path is stable.
const REPO_ROOT = resolve(import.meta.dirname, "..");
const SPEC_DIR = join(REPO_ROOT, "specs/014-reinvent-impact-cli");

describe("plan-coverage self-dogfood — spec 014 has zero implicit impacts (T027)", () => {
  it("(precondition) the spec 014 directory exists and has tasks.md / spec.md", () => {
    expect(existsSync(SPEC_DIR)).toBe(true);
    expect(existsSync(join(SPEC_DIR, "tasks.md"))).toBe(true);
    expect(existsSync(join(SPEC_DIR, "spec.md"))).toBe(true);
  });

  it("every REQ reached from spec 014's tracked files is mentioned in tasks/plan/spec", () => {
    const result = runPlanCoverage({
      repoRoot: REPO_ROOT,
      specDir: SPEC_DIR,
      tasksPath: join(SPEC_DIR, "tasks.md"),
      planPath: join(SPEC_DIR, "plan.md"),
      format: "json",
      // --gate-equivalent: the assertion below enforces the same contract,
      // and we want a useful diff in the failure message rather than just
      // exit-code 1.
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    // PRECONDITION: this assertion is only meaningful if the dogfood actually
    // reached some REQs. A vacuous pass (totalAffected === 0) would silently
    // hide a regression in Files: extraction or graph resolution. Pin a non-
    // trivial lower bound so future regressions surface as a precondition
    // failure with a clear message — and require that the mention path was
    // actually exercised (i.e. mentioned > 0), so we know `detectMentions`
    // ran against a non-empty affected set.
    expect(result.json.summary.totalAffected).toBeGreaterThan(0);
    expect(result.json.summary.mentioned).toBeGreaterThan(0);

    // If new implicits appear, surface them in the assertion message so the
    // PR author can either (a) add a bare/qualified mention to the spec
    // trio, or (b) decide the file's impact tag is wrong and adjust it.
    if (result.json.summary.implicit !== 0) {
      const newImplicits = result.json.implicitImpactsByReq.map((r) => r.reqId);
      // Diagnostic printf so test output makes the next-step obvious.
      console.error(
        "[dogfood] new implicit impacts detected — add a `Considered: <id>` line in",
        "tasks.md / plan.md / spec.md for each:\n  " + newImplicits.join("\n  "),
      );
    }
    expect(result.json.summary.implicit).toBe(0);
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.implicitImpactsByReq).toEqual([]);
  });

  it("exits 0 with --gate (CI-style invocation passes)", () => {
    const result = runPlanCoverage({
      repoRoot: REPO_ROOT,
      specDir: SPEC_DIR,
      tasksPath: join(SPEC_DIR, "tasks.md"),
      planPath: join(SPEC_DIR, "plan.md"),
      format: "json",
      gate: true,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.exitCode).toBe(0);
  });

  it("(T027 audit-trail) tasks.md has Files: section for every task block — requireFilesSection clean", () => {
    // T027 claims "本 tasks.md は全 FR を mention 済みかつ Files: セクション完備".
    // The other dogfood tests above run with requireFilesSection: false, which
    // means a regression that drops a `Files:` line on some task block would
    // pass silently. This variant flips strict-mode ON so the audit-trail
    // claim is actually verified.
    const result = runPlanCoverage({
      repoRoot: REPO_ROOT,
      specDir: SPEC_DIR,
      tasksPath: join(SPEC_DIR, "tasks.md"),
      planPath: join(SPEC_DIR, "plan.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: true,
    });

    const missing = result.json.diagnostics.filter((d) => d.kind === "missingFilesSection");
    if (missing.length > 0) {
      console.error(
        "[dogfood/strict] tasks.md task blocks missing `Files:` section:\n  " +
          missing
            .map(
              (m) =>
                `${(m as { taskId: string; line: number }).taskId} (line ${
                  (m as { line: number }).line
                })`,
            )
            .join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });
});
