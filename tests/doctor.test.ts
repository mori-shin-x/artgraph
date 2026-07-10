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
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    expect(findFinding(report.findings, (f) => f.kind === "agents-md-present")).toBeDefined();
    expect(
      findFinding(report.findings, (f) => f.kind === "wrapper-present" && f.agent === "claude"),
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

describe("runDoctor — agents-md-body-stale", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("does NOT emit agents-md-body-stale on a fresh init (canonical body matches)", () => {
    const report = runDoctor({ rootDir: proj.dir });
    const stale = report.findings.filter((f) => f.kind === "agents-md-body-stale");
    expect(stale.length, JSON.stringify(stale, null, 2)).toBe(0);
    // And `agents-md-present` still fires as a pass.
    expect(findFinding(report.findings, (f) => f.kind === "agents-md-present")).toBeDefined();
  });

  it("emits agents-md-body-stale (severity: pass, NOTICE) when the marker body drifts", () => {
    // Simulate an outdated snippet from a previous artgraph release —
    // marker structure intact, body content drifted.
    const agentsMd = join(proj.dir, "AGENTS.md");
    const body = readFileSync(agentsMd, "utf-8");
    const drifted = body.replace(
      /(<!--\s*artgraph:begin\s*-->)([\s\S]*?)(<!--\s*artgraph:end\s*-->)/,
      "$1\n<!-- stale body from an older artgraph release -->\n$3",
    );
    writeFileSync(agentsMd, drifted, "utf-8");

    const report = runDoctor({ rootDir: proj.dir });
    const stale = findFinding(report.findings, (f) => f.kind === "agents-md-body-stale");
    expect(stale, JSON.stringify(report.findings, null, 2)).toBeDefined();
    // Severity is pass so a plain artgraph upgrade doesn't silently break CI
    // gates that treat any `fail` finding as a hard stop.
    expect(stale!.severity).toBe("pass");
    expect(stale!.agent).toBeNull();
    expect(stale!.path).toBe("AGENTS.md");
    expect(stale!.message).toContain("NOTICE");
    expect(stale!.message).toContain("--force");
    // expected/actual are sha256 hex digests for downstream diffing.
    expect(stale!.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(stale!.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(stale!.expected).not.toBe(stale!.actual);
    // Regression guard: stale body MUST NOT flip doctor exit code.
    expect(report.summary.failCount).toBe(0);
    // And `agents-md-present` must NOT also fire — the stale finding is
    // returned in its place (early return in addAgentsMdFindings).
    expect(report.findings.filter((f) => f.kind === "agents-md-present").length).toBe(0);
  });

  it("does not emit agents-md-body-stale when AGENTS.md is missing or marker is broken", () => {
    // Missing → agents-md-missing takes over.
    rmSync(join(proj.dir, "AGENTS.md"));
    const rMissing = runDoctor({ rootDir: proj.dir });
    expect(rMissing.findings.filter((f) => f.kind === "agents-md-body-stale").length).toBe(0);
    expect(findFinding(rMissing.findings, (f) => f.kind === "agents-md-missing")).toBeDefined();

    // Broken marker → agents-md-marker-broken takes over.
    initProject(proj.dir, ["claude"]);
    const agentsMd = join(proj.dir, "AGENTS.md");
    const body = readFileSync(agentsMd, "utf-8");
    writeFileSync(agentsMd, body.replace(/<!--\s*artgraph:end\s*-->/g, ""), "utf-8");
    const rBroken = runDoctor({ rootDir: proj.dir });
    expect(rBroken.findings.filter((f) => f.kind === "agents-md-body-stale").length).toBe(0);
    expect(
      findFinding(rBroken.findings, (f) => f.kind === "agents-md-marker-broken"),
    ).toBeDefined();
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
    expect(parsed.summary.passCount + parsed.summary.failCount).toBe(parsed.findings.length);
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

// ---------------------------------------------------------------------------
// PR #114 cluster D regressions — new finding kinds and defensive I/O.
// ---------------------------------------------------------------------------

describe("runDoctor — A6: wrapper-broken-marker (not wrapper-no-import)", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("flags a wrapper whose end marker is removed as `wrapper-broken-marker`, not `wrapper-no-import`", () => {
    const claudeMd = join(proj.dir, "CLAUDE.md");
    const body = readFileSync(claudeMd, "utf-8");
    // Wipe the end marker but keep the @AGENTS.md line inside the (now
    // half-broken) block. Old behavior would mis-report this as
    // `wrapper-no-import` because `bodyText` is null → blockBody = "" →
    // include check fails.
    const broken = body.replace(/<!--\s*artgraph:end\s*-->/g, "");
    writeFileSync(claudeMd, broken, "utf-8");
    const report = runDoctor({ rootDir: proj.dir });

    // Correct kind emitted.
    const brokenFinding = findFinding(
      report.findings,
      (x) => x.kind === "wrapper-broken-marker" && x.agent === "claude",
    );
    expect(brokenFinding, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(brokenFinding!.path).toBe("CLAUDE.md");

    // The obsolete `wrapper-no-import` must NOT double-fire for the same file.
    const noImport = findFinding(
      report.findings,
      (x) => x.kind === "wrapper-no-import" && x.agent === "claude",
    );
    expect(noImport).toBeUndefined();
  });
});

describe("runDoctor — A-adj-1: brokenMarkerDescription counts strays", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("reports begin/end counts when multiple strays are present", () => {
    const agentsMd = join(proj.dir, "AGENTS.md");
    // Add 2 stray begin markers on top of the canonical pair, then wipe every
    // end marker. Result: 3 begins, 0 ends.
    let body = readFileSync(agentsMd, "utf-8");
    body = `<!-- artgraph:begin -->\nstray one\n\n<!-- artgraph:begin -->\nstray two\n\n${body}`;
    body = body.replace(/<!--\s*artgraph:end\s*-->/g, "");
    writeFileSync(agentsMd, body, "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "agents-md-marker-broken");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    // Message actual field must expose the counts.
    expect(f!.actual).toMatch(/3 begin/);
    expect(f!.actual).toMatch(/0 end/);
  });
});

describe("runDoctor — C2: walk skips symlinks", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("does not recurse into a symlink loop inside a canonical Skill dir", () => {
    const impactDir = join(proj.dir, ".claude/skills/artgraph-impact");
    const loop = join(impactDir, "loop");
    // `ln -s . loop` inside the canonical dir — a naive statSync-based walk
    // would recurse until RangeError. After the fix, walk uses lstat and skips
    // symlinks entirely.
    symlinkSync(impactDir, loop, "dir");
    expect(() => runDoctor({ rootDir: proj.dir })).not.toThrow();
    const report = runDoctor({ rootDir: proj.dir });
    // Symlink is not a canonical file → must not surface as extraneous either.
    const extra = findFinding(
      report.findings,
      (x) => x.kind === "extraneous-file" && x.path.includes("loop"),
    );
    expect(extra).toBeUndefined();
  });
});

describe("runDoctor — C3: TOCTOU race on skill file read", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("treats a missing skill file (whatever the syscall order) as skill-file-missing without throwing", () => {
    // Delete several canonical files. Old code used `existsSync` + `hashFile`
    // and would surface a raw ENOENT if a concurrent process removed a file
    // between the two syscalls; the fix uses `try { hashFile } catch (ENOENT)`.
    rmSync(join(proj.dir, ".claude/skills/artgraph-verify/SKILL.md"));
    rmSync(join(proj.dir, ".claude/skills/artgraph-impact/SKILL.md"));
    expect(() => runDoctor({ rootDir: proj.dir })).not.toThrow();
    const report = runDoctor({ rootDir: proj.dir });
    const missing = report.findings.filter((x) => x.kind === "skill-file-missing");
    expect(missing.length).toBeGreaterThanOrEqual(2);
  });
});

describe("runDoctor — C4: walk-error on unreadable subtree", () => {
  let proj: ReturnType<typeof createFreshProject>;
  let chmodTarget: string | null = null;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
    chmodTarget = null;
  });

  afterEach(() => {
    // Restore perms so cleanup can remove the dir.
    if (chmodTarget && existsSync(chmodTarget)) {
      try {
        chmodSync(chmodTarget, 0o755);
      } catch {
        // best-effort
      }
    }
    proj.cleanup();
  });

  it("emits a `walk-error` finding when readdirSync throws EACCES instead of crashing", () => {
    if (process.getuid && process.getuid() === 0) {
      // Root ignores mode bits; skip this test.
      return;
    }
    // Nest an artgraph-canonical subtree we can chmod (walk() only recurses
    // into canonical top-levels). Drop an inner dir + file, then remove
    // read permission on the inner dir → walk's readdirSync throws EACCES.
    const canonicalTop = join(proj.dir, ".claude/skills/artgraph-rename");
    const innerDir = join(canonicalTop, "extra-nested");
    mkdirSync(innerDir, { recursive: true });
    writeFileSync(join(innerDir, "leaf.md"), "leaf\n", "utf-8");
    chmodSync(innerDir, 0o000);
    chmodTarget = innerDir;

    const report = runDoctor({ rootDir: proj.dir });
    const walkErr = findFinding(
      report.findings,
      (x) => x.kind === "walk-error" && x.path.includes("extra-nested"),
    );
    expect(walkErr, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(walkErr!.agent).toBe("claude");
  });
});

describe("runDoctor — D1: distribution-absent single finding", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("emits exactly one `distribution-absent` finding (not N skill-file-missing) when --agents=<uninstalled>", () => {
    // codex distribution was never provisioned (only claude was) — the old
    // code would flood N `skill-file-missing`.
    const report = runDoctor({ rootDir: proj.dir, agents: ["codex"] });
    const absent = report.findings.filter((x) => x.kind === "distribution-absent");
    expect(absent.length, JSON.stringify(report.findings, null, 2)).toBe(1);
    expect(absent[0]!.agent).toBe("codex");
    // No stray per-file findings.
    const skillMissing = report.findings.filter(
      (x) => x.kind === "skill-file-missing" && x.agent === "codex",
    );
    expect(skillMissing.length).toBe(0);
    // `codex` still shows up in the summary so JSON consumers see it.
    expect(report.summary.agents).toContain("codex");
  });
});

describe("runDoctor — D2: walk skips dot files", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("does not flag `.DS_Store` / `.gitkeep` droppings as extraneous-file", () => {
    const dsStore = join(proj.dir, ".claude/skills/artgraph-impact/.DS_Store");
    writeFileSync(dsStore, "\x00\x00\x00", "utf-8");
    const swp = join(proj.dir, ".claude/skills/artgraph-impact/.SKILL.md.swp");
    writeFileSync(swp, "editor swap", "utf-8");
    const report = runDoctor({ rootDir: proj.dir });
    const extra = report.findings.filter(
      (x) =>
        x.kind === "extraneous-file" && (x.path.includes(".DS_Store") || x.path.includes(".swp")),
    );
    expect(extra.length, JSON.stringify(extra, null, 2)).toBe(0);
  });
});

describe("runDoctor — D5: auto-detect skips empty / no-canonical dirs", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("does not treat a bare `.kiro/skills/` (no canonical top-level) as an installed distribution", () => {
    // Simulate a third-party tool (or `mkdir` typo) that created an empty
    // `.kiro/skills/` on its own. artgraph never touched it → doctor must
    // not auto-detect kiro.
    const kiroSkills = join(proj.dir, ".kiro/skills");
    mkdirSync(kiroSkills, { recursive: true });
    const report = runDoctor({ rootDir: proj.dir });
    expect(report.summary.agents).not.toContain("kiro");
  });

  it("still treats a `.kiro/skills/` with at least one canonical top-level as installed", () => {
    initProject(proj.dir, ["kiro"]);
    const report = runDoctor({ rootDir: proj.dir });
    expect(report.summary.agents).toContain("kiro");
  });
});

describe("runDoctor — D-adj-1: throws on unknown agent id", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, ["claude"]);
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("throws Error when opts.agents contains an unknown id (programmatic caller path)", () => {
    // Cast through unknown so we can exercise the defensive throw without
    // pushing an invalid AgentId literal into the type system.
    expect(() =>
      runDoctor({ rootDir: proj.dir, agents: ["ghost" as unknown as "claude"] }),
    ).toThrow(/Unknown agent id/);
  });
});

describe("runDoctor — config.agents cross-check (spec 013 follow-up, #158)", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(proj.dir, ".artgraph.json"), "utf-8"));
  }

  function writeConfig(patch: Record<string, unknown>): void {
    const config = readConfig();
    writeFileSync(
      join(proj.dir, ".artgraph.json"),
      JSON.stringify({ ...config, ...patch }, null, 2) + "\n",
    );
  }

  it("emits config-missing-agents-field when config has no agents and disk has at least one agent", () => {
    // initProject persists `agents` by default now (#158) — strip it back off
    // to simulate a legacy config predating this feature.
    initProject(proj.dir, ["claude"]);
    const config = readConfig();
    delete config.agents;
    writeFileSync(join(proj.dir, ".artgraph.json"), JSON.stringify(config, null, 2) + "\n");

    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-missing-agents-field");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.severity).toBe("pass");
    expect(f!.agent).toBeNull();
    expect(f!.message).toContain("--agents=<csv>");
    // Advisory only — must not flip the exit code.
    expect(report.summary.failCount).toBe(0);
  });

  it("does not emit config-missing-agents-field once the agents field is persisted", () => {
    initProject(proj.dir, ["claude"]);
    expect(readConfig().agents).toEqual(["claude"]);
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-missing-agents-field");
    expect(f).toBeUndefined();
  });

  it("fires agent-recorded-but-missing when config lists an id but disk lacks its distribution dir", () => {
    initProject(proj.dir, ["claude"]);
    writeConfig({ agents: ["claude", "codex"] }); // codex never distributed
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "agent-recorded-but-missing");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.severity).toBe("fail");
    expect(f!.agent).toBe("codex");
    expect(f!.message).toContain("codex");
    expect(f!.message).toContain("--force --agents=codex");
    expect(report.summary.failCount).toBeGreaterThanOrEqual(1);
    // The obsolete generic finding must not double-fire for the same agent.
    expect(
      findFinding(report.findings, (x) => x.kind === "distribution-absent" && x.agent === "codex"),
    ).toBeUndefined();
  });

  it("fires agent-installed-not-recorded when config lists a subset and disk has more", () => {
    initProject(proj.dir, ["claude", "codex"]);
    writeConfig({ agents: ["claude"] }); // codex is installed but not recorded
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "agent-installed-not-recorded");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.severity).toBe("pass");
    expect(f!.agent).toBe("codex");
    expect(f!.message).toContain("codex");
    // Advisory only — must not flip the exit code (codex's own distribution
    // is byte-identical, just unrecorded).
    expect(report.summary.failCount).toBe(0);
    // The unrecorded-but-installed agent still gets full diagnostics and
    // shows up in the summary, matching legacy on-disk-observation coverage.
    expect(report.summary.agents).toContain("codex");
    expect(
      report.findings.some((x) => x.agent === "codex" && x.kind === "skill-file-present"),
    ).toBe(true);
  });

  it("emits no new #158 finding kinds when config.agents matches on-disk exactly", () => {
    initProject(proj.dir, ["claude", "codex"]);
    expect(readConfig().agents).toEqual(["claude", "codex"]);
    const report = runDoctor({ rootDir: proj.dir });
    const newKinds = report.findings.filter((f) =>
      [
        "config-missing-agents-field",
        "agent-recorded-but-missing",
        "agent-installed-not-recorded",
      ].includes(f.kind),
    );
    expect(newKinds, JSON.stringify(newKinds, null, 2)).toEqual([]);
  });

  it("opts.agents explicit override skips the config cross-check entirely", () => {
    initProject(proj.dir, ["claude"]);
    // Config only records claude, but the caller explicitly asks about codex
    // (never distributed). The explicit-override path must still report the
    // legacy `distribution-absent` finding, not `agent-recorded-but-missing`,
    // and must not synthesize any #158 finding kind.
    const report = runDoctor({ rootDir: proj.dir, agents: ["codex"] });
    const newKinds = report.findings.filter((f) =>
      [
        "config-missing-agents-field",
        "agent-recorded-but-missing",
        "agent-installed-not-recorded",
      ].includes(f.kind),
    );
    expect(newKinds).toEqual([]);
    const absent = findFinding(report.findings, (x) => x.kind === "distribution-absent");
    expect(absent, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(absent!.agent).toBe("codex");
  });
});

describe("runDoctor — dogfood (this repo)", () => {
  // Cheap standing guard for SC-002 byte-identical distribution: run the
  // production doctor engine against the repo root itself. When template ↔
  // dogfood drift happens (any of the 5 canonical agent skills paths falls
  // out of sync with templates/skills/), the sha256 hash check inside
  // `runDoctor` catches it here — no need to invoke the CLI or a fresh
  // build.
  //
  // The scan test in tests/init.test.ts covers the same drift from a
  // byte-comparison angle; this test complements it by exercising the exact
  // codepath that `pnpm exec artgraph doctor` runs, so regressions in the
  // doctor engine itself (missing agents, wrong path, hash logic) also
  // surface here.
  it("reports zero failures on the repo root (skills byte-identical across all 5 agents)", () => {
    const report = runDoctor({ rootDir: REPO_ROOT });
    // Failures are the actionable class (missing distribution, hash drift,
    // permission bits gone). Warnings (info-only findings) are still
    // allowed — this repo may legitimately have some at any given time.
    expect(
      report.summary.failCount,
      `artgraph doctor reported ${report.summary.failCount} failure(s) on repo root; ` +
        `failing findings:\n${report.findings
          .filter((f) => f.severity === "fail")
          .map((f) => `  - [${f.kind}] ${f.message}`)
          .join("\n")}`,
    ).toBe(0);
  });
});
