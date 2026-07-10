// #158 review (MINOR) — init→doctor round-trip integration tests.
//
// PR #233's adversarial review found that the `runInit` unit tests and the
// `runDoctor` unit tests each mocked/constructed their own fixtures and
// never actually chained `runInit(...)` output into `runDoctor(...)`. That
// gap is exactly why the BLOCKER (persisting `config.agents` for a
// distribution stage that never ran) slipped through: no test exercised the
// combination `artgraph init --no-skills --agents=X` followed immediately by
// `artgraph doctor`.
//
// These tests close that gap by always calling `runInit` then `runDoctor`
// against the same tmp dir, mirroring what a user actually does.
//
// Two of the seven scenarios below (case 2 and case 3) deliberately assert
// something narrower than "doctor reports zero failures" — see the comments
// on each for why; that's a documented, verified compromise, not an
// oversight (see the PR trailer / session notes for the full rationale).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../src/init.js";
import { runDoctor, type DoctorFinding } from "../src/doctor.js";
import { createFreshProject } from "./agents/helpers.js";

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".artgraph.json"), "utf-8"));
}

function findFinding(
  findings: DoctorFinding[],
  pred: (f: DoctorFinding) => boolean,
): DoctorFinding | undefined {
  return findings.find(pred);
}

describe("init -> doctor integration (#158 review, MINOR)", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("1. fresh init writes agents, doctor reports zero failures", () => {
    runInit(proj.dir, { agents: ["claude"] });
    expect(readConfig(proj.dir).agents).toEqual(["claude"]);

    const report = runDoctor({ rootDir: proj.dir });
    expect(report.summary.failCount, JSON.stringify(report.findings, null, 2)).toBe(0);
    expect(
      findFinding(report.findings, (f) => f.kind === "agent-recorded-but-missing"),
    ).toBeUndefined();
  });

  // BLOCKER repro corner, precisely per Fix 1's own gating comment: persistence
  // is skipped only when BOTH the skills and agent-context stages are off
  // this invocation (`--no-skills --no-agent-context`, or `--minimal`).
  // `--no-skills` alone leaves agent-context active, so it still persists
  // (see case 3 below, and src/init.ts `anyDistributionStageActive`) — that
  // narrower case is exercised separately in tests/init.test.ts's
  // "--force --agents=cursor with --no-skills --no-agent-context ..." test.
  it("2. --no-skills --no-agent-context --agents=claude does not persist, doctor reports zero findings", () => {
    runInit(proj.dir, { agents: ["claude"], noSkills: true, noAgentContext: true });
    const config = readConfig(proj.dir);
    expect("agents" in config).toBe(false);
    expect(existsSync(join(proj.dir, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(proj.dir, "CLAUDE.md"))).toBe(false);

    // Nothing was distributed and nothing is recorded, so doctor's
    // zero-detected short-circuit applies: an empty report, not just a
    // zero fail count.
    const report = runDoctor({ rootDir: proj.dir });
    expect(report.findings).toEqual([]);
    expect(report.summary.failCount).toBe(0);
  });

  // `--no-agent-context --agents=claude` alone still runs the skills stage,
  // so per Fix 1's gating `config.agents` IS persisted (agent-context is
  // also a "distribution stage that installs per-agent artifacts" —
  // `anyDistributionStageActive = skillsStageActive || agentContextStageActive`).
  // The any-artifact check (Fix 2) then correctly treats claude as
  // "installed" (Skills present) so the config cross-check does NOT
  // false-positive `agent-recorded-but-missing`.
  //
  // Doctor's *unrelated* per-file diagnostics (Step 4 `agents-md-missing` /
  // Step 5 `wrapper-missing`) are or­thogonal to these 3 fixes — they assume
  // every detected agent has a complete distribution (skills AND
  // agent-context) and were not in scope for the #158 review's cross-check
  // fixes. They correctly still fire here since AGENTS.md/CLAUDE.md were
  // genuinely never written. This test asserts the narrow claim the fixes
  // actually make (no false-positive cross-check finding), not an overall
  // zero fail count — see PR trailer / session notes for the full
  // discrepancy writeup against the original task description.
  it("3. --no-agent-context --agents=claude persists (skills stage ran); config cross-check does not false-positive", () => {
    runInit(proj.dir, { agents: ["claude"], noAgentContext: true });
    expect(readConfig(proj.dir).agents).toEqual(["claude"]);
    expect(existsSync(join(proj.dir, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(proj.dir, "CLAUDE.md"))).toBe(false);

    const report = runDoctor({ rootDir: proj.dir });
    expect(
      findFinding(
        report.findings,
        (f) => f.kind === "agent-recorded-but-missing" && f.agent === "claude",
      ),
    ).toBeUndefined();
    expect(
      findFinding(
        report.findings,
        (f) => f.kind === "agent-installed-not-recorded" && f.agent === "claude",
      ),
    ).toBeUndefined();
    // Skills themselves are fully healthy.
    expect(
      report.findings.some((f) => f.agent === "claude" && f.kind === "skill-file-missing"),
    ).toBe(false);
  });

  it("4. deleting BOTH the skills dir and the wrapper fires agent-recorded-but-missing", () => {
    runInit(proj.dir, { agents: ["claude"] });
    rmSync(join(proj.dir, ".claude", "skills"), { recursive: true, force: true });
    rmSync(join(proj.dir, "CLAUDE.md"), { force: true });

    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(
      report.findings,
      (x) => x.kind === "agent-recorded-but-missing" && x.agent === "claude",
    );
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.severity).toBe("fail");
    expect(f!.message).toContain(".claude/skills/");
    expect(f!.message).toContain("CLAUDE.md");
    expect(f!.message).toContain("hand-edit .artgraph.json");
    expect(f!.message).toContain("#131");
  });

  it("5. deleting ONLY the skills dir does not false-positive (wrapper still covers it)", () => {
    runInit(proj.dir, { agents: ["claude"] });
    rmSync(join(proj.dir, ".claude", "skills"), { recursive: true, force: true });

    const report = runDoctor({ rootDir: proj.dir });
    expect(
      findFinding(
        report.findings,
        (x) => x.kind === "agent-recorded-but-missing" && x.agent === "claude",
      ),
    ).toBeUndefined();
  });

  it("6. manually creating .cursor/skills/ fires agent-installed-not-recorded for cursor", () => {
    runInit(proj.dir, { agents: ["claude"] });
    mkdirSync(join(proj.dir, ".cursor", "skills", "artgraph-verify"), { recursive: true });
    writeFileSync(
      join(proj.dir, ".cursor", "skills", "artgraph-verify", "SKILL.md"),
      "# not the canonical content\n",
    );

    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(
      report.findings,
      (x) => x.kind === "agent-installed-not-recorded" && x.agent === "cursor",
    );
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.severity).toBe("pass");
  });

  it("7. --minimal --agents=claude does not persist the agents field", () => {
    runInit(proj.dir, { agents: ["claude"], minimal: true });
    const config = readConfig(proj.dir);
    expect("agents" in config).toBe(false);
  });
});
