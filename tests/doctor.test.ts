// spec 013 T029 [US4] — unit tests for src/doctor.ts.
//
// Covers every `DoctorFindingKind` (PASS path + each FAIL path) plus the
// empty-distribution short-circuit and JSON schema conformance from
// `specs/013-cross-agent-extensions/contracts/doctor-output.md`.
//
// All fixtures use `runInit` to provision a real distribution so the
// engine's filesystem reads exercise the same byte layout the production
// CLI produces. Fault injection (sed-style edits / deletions) happens
// directly on the tmp tree.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  runDoctor,
  formatDoctorReportJson,
  formatDoctorReportText,
  type DoctorFinding,
  type DoctorReport,
} from "../src/doctor.js";
import { runInit } from "../src/init.js";
import { createFreshProject } from "./agents/helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function initProject(dir: string, agents: ("claude" | "codex" | "cursor" | "copilot" | "kiro")[]) {
  runInit(dir, { agents, noScan: true, noIntegrate: true, noHooks: true, force: true });
}

function findFinding(
  findings: DoctorFinding[],
  pred: (f: DoctorFinding) => boolean,
): DoctorFinding | undefined {
  return findings.find(pred);
}

describe("runDoctor — PASS path", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude", "codex"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("reports zero failures on a freshly initialized project", () => {
    const report = runDoctor({ rootDir: proj.dir });
    expect(report.summary.failCount, JSON.stringify(report.findings, null, 2)).toBe(0);
    expect(report.summary.passCount).toBeGreaterThan(0);
    expect(report.summary.totalFindings).toBe(report.findings.length);
    expect(report.summary.agents).toEqual(["claude", "codex"]);
  });

  it("emits a `skill-file-present` finding for every canonical SKILL.md / _shared file per agent", () => {
    const report = runDoctor({ rootDir: proj.dir });
    const claudeFiles = report.findings.filter(
      (f) => f.agent === "claude" && f.kind === "skill-file-present",
    );
    expect(claudeFiles.length).toBeGreaterThan(5);
    // _shared is part of the canonical contract (R1).
    expect(claudeFiles.some((f) => f.path.includes("_shared/"))).toBe(true);
  });

  it("emits `agents-md-present` and `wrapper-present` for AGENTS.md + CLAUDE.md", () => {
    const report = runDoctor({ rootDir: proj.dir });
    expect(
      findFinding(report.findings, (f) => f.kind === "agents-md-present"),
    ).toBeDefined();
    expect(
      findFinding(
        report.findings,
        (f) => f.kind === "wrapper-present" && f.agent === "claude",
      ),
    ).toBeDefined();
  });
});

describe("runDoctor — FAIL: skill-file-missing", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("flags a deleted SKILL.md", () => {
    const skill = join(proj.dir, ".claude/skills/artgraph-impact/SKILL.md");
    rmSync(skill);
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "skill-file-missing");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.agent).toBe("claude");
    expect(f!.expected).toBe("present");
    expect(f!.actual).toBe("missing");
    expect(f!.path).toContain("artgraph-impact/SKILL.md");
    expect(report.summary.failCount).toBeGreaterThanOrEqual(1);
  });
});

describe("runDoctor — FAIL: skill-file-drift", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("flags a tampered SKILL.md with sha256 mismatch", () => {
    const skill = join(proj.dir, ".claude/skills/artgraph-verify/SKILL.md");
    appendFileSync(skill, "\n<!-- tampered -->\n", "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "skill-file-drift");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.agent).toBe("claude");
    expect(f!.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(f!.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(f!.expected).not.toBe(f!.actual);
    expect(f!.path).toContain("artgraph-verify/SKILL.md");
  });
});

describe("runDoctor — FAIL: extraneous-file", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("flags an extra file dropped inside a canonical artgraph Skill dir", () => {
    // Inside a canonical top-level dir (`artgraph-impact/`) — any file that
    // doesn't match the canonical set is an artgraph remnant we should warn
    // about. Mirrors quickstart §3-6.
    const extra = join(proj.dir, ".claude/skills/artgraph-impact/extra-file.md");
    writeFileSync(extra, "remnant\n", "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "extraneous-file");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.agent).toBe("claude");
    expect(f!.path).toContain("artgraph-impact/extra-file.md");
    expect(f!.expected).toBe("not present");
    expect(f!.actual).toBe("present");
  });

  it("ignores third-party Skill dirs that artgraph never owned (spec 013 FR-011 (d) scope)", () => {
    // Non-artgraph top-level dir (e.g. spec kit skills shipped by another
    // tool) — doctor must NOT flag these. Mirrors the polish-phase fault
    // where 11 `.claude/skills/speckit-*/SKILL.md` files were incorrectly
    // reported as extraneous.
    const speckitDir = join(proj.dir, ".claude/skills/speckit-implement");
    mkdirSync(speckitDir, { recursive: true });
    writeFileSync(join(speckitDir, "SKILL.md"), "third-party\n", "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(
      report.findings,
      (x) => x.kind === "extraneous-file" && x.path.includes("speckit-implement"),
    );
    expect(f, `unexpected finding for third-party dir: ${JSON.stringify(f)}`).toBeUndefined();
    // And no other agents' extraneous flag should trip on it either.
    expect(report.summary.failCount).toBe(0);
  });

  it("ignores a non-canonical artgraph-prefixed dir (treated as third-party)", () => {
    // `artgraph-old/` is NOT in the canonical top-level set. Under the
    // tightened FR-011 (d) scope, doctor only walks subtrees rooted at
    // canonical top-level dirs, so this is left alone.
    const obsoleteDir = join(proj.dir, ".claude/skills/artgraph-old");
    mkdirSync(obsoleteDir, { recursive: true });
    writeFileSync(join(obsoleteDir, "SKILL.md"), "obsolete\n", "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(
      report.findings,
      (x) => x.kind === "extraneous-file" && x.path.includes("artgraph-old"),
    );
    expect(f).toBeUndefined();
  });
});

describe("runDoctor — FAIL: wrapper-missing / wrapper-no-import", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("flags a missing CLAUDE.md when claude is distributed", () => {
    rmSync(join(proj.dir, "CLAUDE.md"));
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(
      report.findings,
      (x) => x.kind === "wrapper-missing" && x.agent === "claude",
    );
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.path).toBe("CLAUDE.md");
  });

  it("flags CLAUDE.md without @AGENTS.md inside the marker block", () => {
    const claudeMd = join(proj.dir, "CLAUDE.md");
    const body = readFileSync(claudeMd, "utf-8");
    // Remove the @AGENTS.md import line(s) but keep the marker block intact.
    const stripped = body
      .split("\n")
      .filter((l) => l.trim() !== "@AGENTS.md")
      .join("\n");
    writeFileSync(claudeMd, stripped, "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(
      report.findings,
      (x) => x.kind === "wrapper-no-import" && x.agent === "claude",
    );
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.path).toBe("CLAUDE.md");
  });
});

describe("runDoctor — FAIL: agents-md-missing / agents-md-marker-broken", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("flags a deleted AGENTS.md when distributions exist", () => {
    rmSync(join(proj.dir, "AGENTS.md"));
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "agents-md-missing");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.agent).toBeNull();
    expect(f!.path).toBe("AGENTS.md");
  });

  it("flags AGENTS.md with a broken marker block (end marker removed)", () => {
    const agentsMd = join(proj.dir, "AGENTS.md");
    const body = readFileSync(agentsMd, "utf-8");
    const broken = body.replace(/<!--\s*artgraph:end\s*-->/g, "");
    writeFileSync(agentsMd, broken, "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "agents-md-marker-broken");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.agent).toBeNull();
    expect(f!.path).toBe("AGENTS.md");
    expect(f!.expected).toBe("single matched pair");
  });
});

describe("runDoctor — empty / no distribution detected", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("returns an empty report on a pristine tmp dir", () => {
    const report = runDoctor({ rootDir: proj.dir });
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({
      totalFindings: 0,
      passCount: 0,
      failCount: 0,
      agents: [],
    });
    expect(report.version).toBe(1);
  });
});

describe("formatDoctorReportJson — schema conformance", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude", "codex"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("produces the contracts/doctor-output.md JSON shape", () => {
    const report = runDoctor({ rootDir: proj.dir });
    const json = formatDoctorReportJson(report);
    const parsed = JSON.parse(json) as DoctorReport;
    expect(parsed.version).toBe(1);
    expect(parsed.summary.totalFindings).toBe(parsed.findings.length);
    expect(parsed.summary.passCount + parsed.summary.failCount).toBe(
      parsed.findings.length,
    );
    expect(Array.isArray(parsed.summary.agents)).toBe(true);
    for (const f of parsed.findings) {
      expect(typeof f.severity).toBe("string");
      expect(["pass", "fail"]).toContain(f.severity);
      expect(typeof f.kind).toBe("string");
      expect(typeof f.path).toBe("string");
      expect(typeof f.message).toBe("string");
      // `expected` / `actual` are `string | null`.
      expect(f.expected === null || typeof f.expected === "string").toBe(true);
      expect(f.actual === null || typeof f.actual === "string").toBe(true);
      // `agent` is `string | null`.
      expect(f.agent === null || typeof f.agent === "string").toBe(true);
    }
  });

  it("text formatter includes the per-agent header + summary line", () => {
    const report = runDoctor({ rootDir: proj.dir });
    const text = formatDoctorReportText(report);
    expect(text).toContain("artgraph doctor");
    expect(text).toContain("[claude]");
    expect(text).toContain("[codex]");
    expect(text).toMatch(/Summary:\s+\d+ pass,\s+\d+ fail/);
  });

  it("text formatter shows the soft-success message on empty distribution", () => {
    // Use a fresh project so detection yields zero agents.
    const empty = createFreshProject();
    try {
      const report = runDoctor({ rootDir: empty.dir });
      const text = formatDoctorReportText(report);
      expect(text).toContain("No Tier 1 distribution detected");
    } finally {
      empty.cleanup();
    }
  });
});

describe("runDoctor — explicit --agents filter", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude", "codex"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("restricts findings to the explicitly requested agents", () => {
    const report = runDoctor({ rootDir: proj.dir, agents: ["claude"] });
    expect(report.summary.agents).toEqual(["claude"]);
    // No codex-keyed findings should leak through.
    expect(report.findings.some((f) => f.agent === "codex")).toBe(false);
  });
});

// Touch REPO_ROOT to silence the unused-binding lint while keeping the
// reference handy for future tests that want to compare against the live
// templates tree.
void REPO_ROOT;
