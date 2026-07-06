import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  runInit,
  detectProject,
  generateConfig,
  SkillsInstallError,
  computeStageGates,
} from "../src/init.js";
import { DistributionError } from "../src/agents/distribute.js";
import { readSkillSource } from "../src/agents/source.js";
import { AGENT_DESCRIPTORS } from "../src/agents/descriptors.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-init-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe("detectProject", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("detects src/ directory", () => {
    mkdirSync(join(tmp, "src"));
    const result = detectProject(tmp);
    expect(result.hasSrc).toBe(true);
    expect(result.hasSpecs).toBe(false);
    expect(result.hasDocs).toBe(false);
  });

  it("detects specs/ and docs/ directories", () => {
    mkdirSync(join(tmp, "specs"));
    mkdirSync(join(tmp, "docs"));
    const result = detectProject(tmp);
    expect(result.hasSpecs).toBe(true);
    expect(result.hasDocs).toBe(true);
  });

  it("detects both .specify/ and .kiro/ simultaneously", () => {
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    const result = detectProject(tmp);
    expect(result.sddTools).toHaveLength(2);
    expect(result.sddTools).toContainEqual({ name: "Spec Kit", marker: ".specify" });
    expect(result.sddTools).toContainEqual({ name: "Kiro", marker: ".kiro" });
  });

  it("returns empty sddTools when no SDD tool dirs exist", () => {
    const result = detectProject(tmp);
    expect(result.sddTools).toEqual([]);
  });

  it("returns an integrations array (one IntegrationStatus per registered provider)", () => {
    const result = detectProject(tmp);
    expect(Array.isArray(result.integrations)).toBe(true);
    // At least the two built-in providers (speckit, kiro) are registered when
    // running tests that import the CLI surface; the field itself is the
    // contract we're checking here.
    const ids = (result.integrations ?? []).map((s) => s.providerId);
    expect(ids).toContain("speckit");
    expect(ids).toContain("kiro");
  });

  it("aligns integrations[*].detected with the on-disk markers", () => {
    mkdirSync(join(tmp, ".specify"));
    const result = detectProject(tmp);
    const speckit = (result.integrations ?? []).find((s) => s.providerId === "speckit")!;
    const kiro = (result.integrations ?? []).find((s) => s.providerId === "kiro")!;
    expect(speckit.detected).toBe(true);
    expect(speckit.installed).toBe(false);
    expect(kiro.detected).toBe(false);
    expect(kiro.installed).toBe(false);
  });

  it("preserves existing sddTools field (back-compat) alongside integrations", () => {
    mkdirSync(join(tmp, ".kiro"));
    const result = detectProject(tmp);
    expect(result.sddTools).toContainEqual({ name: "Kiro", marker: ".kiro" });
    expect(result.integrations).toBeDefined();
  });
});

describe("generateConfig", () => {
  it("uses src/**/*.ts when hasSrc is true", () => {
    const config = generateConfig({ hasSrc: true, hasSpecs: false, hasDocs: false, sddTools: [] });
    expect(config.include).toContain("src/**/*.ts");
  });

  it("uses **/*.ts when hasSrc is false", () => {
    const config = generateConfig({ hasSrc: false, hasSpecs: false, hasDocs: false, sddTools: [] });
    expect(config.include).toContain("**/*.ts");
    expect(config.include).not.toContain("src/**/*.ts");
  });

  it("includes both specs and docs in specDirs when both exist", () => {
    const config = generateConfig({ hasSrc: true, hasSpecs: true, hasDocs: true, sddTools: [] });
    expect(config.specDirs).toEqual(["specs", "docs"]);
  });

  it("falls back to default specDirs when neither specs/ nor docs/ exist", () => {
    const config = generateConfig({ hasSrc: true, hasSpecs: false, hasDocs: false, sddTools: [] });
    expect(config.specDirs).toEqual(["specs", "docs"]);
  });
});

describe("runInit", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("generates .artgraph.json with defaults for a project with src/", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.include).toContain("src/**/*.ts");
  });

  it("generates .trace.lock after scan", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(existsSync(join(tmp, ".trace.lock"))).toBe(true);
    expect(result.lockPath).toBeDefined();
  });

  it("returns scan summary with node and edge counts", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary!.nodeCount).toBeGreaterThanOrEqual(1);
    expect(typeof result.scanSummary!.edgeCount).toBe("number");
    expect(typeof result.scanSummary!.reqCount).toBe("number");
    expect(typeof result.scanSummary!.docCount).toBe("number");
    expect(typeof result.scanSummary!.fileCount).toBe("number");
    expect(typeof result.scanSummary!.testCount).toBe("number");
  });

  it("returns warnings array", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("sets specDirs to docs when only docs/ exists", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, "docs"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.specDirs).toEqual(["docs"]);
  });

  it("widens include pattern when src/ does not exist", () => {
    writeFileSync(join(tmp, "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.include).toContain("**/*.ts");
    expect(config.include).not.toContain("src/**/*.ts");
  });

  it("includes both specs and docs when both directories exist", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, "specs"));
    mkdirSync(join(tmp, "docs"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.specDirs).toEqual(["specs", "docs"]);
  });

  it("detects Spec Kit when .specify/ exists", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, ".specify"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(result.sddTools).toContainEqual({ name: "Spec Kit", marker: ".specify" });
  });

  it("detects Kiro when .kiro/ exists", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, ".kiro"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(result.sddTools).toContainEqual({ name: "Kiro", marker: ".kiro" });
  });

  it("detects both .specify/ and .kiro/ simultaneously", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(result.sddTools).toHaveLength(2);
    expect(result.sddTools).toContainEqual({ name: "Spec Kit", marker: ".specify" });
    expect(result.sddTools).toContainEqual({ name: "Kiro", marker: ".kiro" });
  });

  it("throws error when .artgraph.json already exists", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, ".artgraph.json"), "{}\n");

    expect(() => runInit(tmp)).toThrow(".artgraph.json already exists");
  });

  it("preserves user customizations on --force (merge mode, not full overwrite)", () => {
    // --force re-init must NOT clobber user-edited fields. Only the
    // detection-driven `packageManager` is refreshed; everything else
    // (include / specDirs / reqPatterns / etc.) is loaded from the existing
    // config and re-emitted as-is.
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, ".artgraph.json"), '{"include":["old"]}\n');

    runInit(tmp, { force: true });

    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.include).toEqual(["old"]);
  });

  it("generates only .artgraph.json with --no-scan", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp, { noScan: true });

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(result.scanSummary).toBeUndefined();
    expect(result.lockPath).toBeUndefined();
  });

  it("supports --force combined with --no-scan (preserves user fields)", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, ".artgraph.json"), '{"include":["old"]}\n');

    const result = runInit(tmp, { force: true, noScan: true });

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.include).toEqual(["old"]);
  });

  it("preserves every user-editable field across --force re-init (only refreshes packageManager)", () => {
    // Initial config sets every optional field that users actually customize
    // (reqPatterns / taskConventions / planCoverage / docGraph / mode / lockFile
    // / include / specDirs / testPatterns / testResultPaths). The merge path
    // must round-trip all of them; only `packageManager` may be re-detected.
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(tmp, "package-lock.json"), "{}"); // → npm
    const userConfig = {
      include: ["custom/**/*.ts"],
      specDirs: ["my-specs"],
      testPatterns: ["my-tests/**/*.test.ts"],
      lockFile: "build/.trace.lock",
      packageManager: "pnpm", // stale — should be overwritten with the npm signal
      reqPatterns: { listItem: "^(CUSTOM-\\d+)\\s" },
      docGraph: { autoNodes: false },
      mode: "symbol",
      testResultPaths: ["junit/results.xml"],
      taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" }],
      planCoverage: { requireFilesSection: true },
    };
    writeFileSync(join(tmp, ".artgraph.json"), JSON.stringify(userConfig));

    runInit(tmp, { force: true, minimal: true });

    const written = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(written.packageManager).toBe("npm"); // refreshed from lockfile signal
    expect(written.include).toEqual(["custom/**/*.ts"]);
    expect(written.specDirs).toEqual(["my-specs"]);
    expect(written.testPatterns).toEqual(["my-tests/**/*.test.ts"]);
    expect(written.lockFile).toBe("build/.trace.lock");
    expect(written.reqPatterns).toEqual({ listItem: "^(CUSTOM-\\d+)\\s" });
    expect(written.docGraph).toEqual({ autoNodes: false });
    expect(written.mode).toBe("symbol");
    expect(written.testResultPaths).toEqual(["junit/results.xml"]);
    expect(written.taskConventions).toEqual([
      { name: "openspec", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" },
    ]);
    expect(written.planCoverage).toEqual({ requireFilesSection: true });
  });

  it("keeps existing packageManager when --force re-detection is inconclusive", () => {
    // Empty dir (no package.json / lockfile / deno marker) → detection
    // returns null. The merge path must NOT clobber the previously recorded
    // packageManager with undefined in that case.
    writeFileSync(
      join(tmp, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], packageManager: "pnpm" }),
    );

    runInit(tmp, { force: true, minimal: true });

    const written = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(written.packageManager).toBe("pnpm");
  });

  it("partial-state guard: distribute() failure leaves no .artgraph.json / .trace.lock orphan", () => {
    // Force `distribute()` to fail pre-flight: place a DIRECTORY at the
    // destination path of a SKILL.md. distribute()'s pre-flight detects the
    // non-regular file and throws `DistributionError` *before* any write —
    // even with --force, since clobbering a directory with a regular file
    // would lose user content. With the order fixed (skills first, config
    // write last), neither `.artgraph.json` nor `.trace.lock` should be on
    // disk after the throw.
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), {
      recursive: true,
    });
    writeFileSync(
      join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md", "marker"),
      "user content\n",
    );

    expect(() => runInit(tmp, { force: true, noScan: true, agents: ["claude"] })).toThrow(
      DistributionError,
    );

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
  });

  it("handles empty project with no ts files", () => {
    const result = runInit(tmp);

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(true);
    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary!.nodeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runInit Skills installation (directory-format, P0 redesign)
// Skills now live at templates/skills/<name>/SKILL.md + _shared/*.md fragments,
// and init copies the entire directory tree (not flat .md files).
// ---------------------------------------------------------------------------

const EXPECTED_SKILL_DIRS = [
  "artgraph-bootstrap",
  "artgraph-impact",
  "artgraph-plan-coverage",
  "artgraph-rename",
  "artgraph-setup",
  "artgraph-verify",
] as const;

describe("runInit Skills installation (directory format)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  // Default behavior (full agent-native setup) is asserted separately
  // in the "runInit default behavior (P0)" describe below; here we focus
  // on the Skills stage specifically.

  it("copies every <name>/SKILL.md into .claude/skills/<name>/ when Skills stage runs", () => {
    const result = runInit(tmp, { noScan: true, agents: ["claude"] });

    expect(result.skillsInstalled).toBeDefined();
    for (const dir of EXPECTED_SKILL_DIRS) {
      const dest = join(tmp, ".claude", "skills", dir, "SKILL.md");
      expect(existsSync(dest), `expected ${dir}/SKILL.md to be installed`).toBe(true);
      const body = readFileSync(dest, "utf-8");
      expect(body.startsWith("---"), `${dir}/SKILL.md missing frontmatter`).toBe(true);
      expect(body).toMatch(/name:\s*["']?artgraph-/);
    }
  });

  it("copies _shared/ fragments into .claude/skills/_shared/", () => {
    runInit(tmp, { noScan: true, agents: ["claude"] });
    for (const name of ["install-check.md", "output-schema.md", "package-manager.md"]) {
      expect(existsSync(join(tmp, ".claude", "skills", "_shared", name))).toBe(true);
    }
  });

  it("throws when a skill file already exists and --force is not set", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "user content\n");

    expect(() => runInit(tmp, { noScan: true, agents: ["claude"] })).toThrow(
      /artgraph-impact[/\\]SKILL\.md.*--force/,
    );

    // Existing user content must be preserved.
    expect(
      readFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "utf-8"),
    ).toBe("user content\n");
  });

  it("overwrites existing skill files when --force is set", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "user content\n");

    const result = runInit(tmp, {
      noScan: true,
      force: true,
      agents: ["claude"],
    });

    expect(result.skillsInstalled!.length).toBeGreaterThan(0);
    const body = readFileSync(
      join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"),
      "utf-8",
    );
    expect(body.startsWith("---")).toBe(true);
    expect(body).not.toBe("user content\n");
  });

  it("lists all conflicting files in the error (not just the first)", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-verify"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "x\n");
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-verify", "SKILL.md"), "y\n");

    let caught: unknown;
    try {
      runInit(tmp, { noScan: true, agents: ["claude"] });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DistributionError);
    const msg = (caught as Error).message;
    expect(msg).toContain("artgraph-impact");
    expect(msg).toContain("artgraph-verify");
    expect(msg).toMatch(/--force/);
  });

  it("preserves user-authored skill files outside the template set on --force", () => {
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "my-custom.md"), "user skill\n");

    runInit(tmp, { noScan: true, force: true, agents: ["claude"] });

    // Custom file untouched, even when --force overwrites artgraph-* templates.
    expect(readFileSync(join(tmp, ".claude", "skills", "my-custom.md"), "utf-8")).toBe(
      "user skill\n",
    );
  });

  it("does not write .artgraph.json when skills pre-flight validation fails", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "preexisting\n");

    expect(() => runInit(tmp, { noScan: true, agents: ["claude"] })).toThrow(DistributionError);

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
    expect(
      readFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "utf-8"),
    ).toBe("preexisting\n");
  });

  // -------------------------------------------------------------------------
  // spec 013 PR #114 [B2] — cross-agent all-or-nothing pre-flight.
  // Multi-agent distribute previously had no outer try/catch: agent #3
  // failing after agents #1-2 fully wrote their trees left a partial state
  // (Skill files landed for the first two agents, but no `.artgraph.json`,
  // `.trace.lock`, or AGENTS.md ever landed). The fix runs pre-flight
  // classification for EVERY agent before any write, so a conflict on ANY
  // agent aborts init before touching disk.
  // -------------------------------------------------------------------------
  it("[B2] pre-flights every selected agent before writing any of them", () => {
    // Agent 1 (claude) has a clean tree. Agent 2 (codex) has a drift
    // conflict at .agents/skills/artgraph-impact/SKILL.md — its content
    // differs from the canonical bytes and --force is NOT set.
    mkdirSync(join(tmp, ".agents", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(
      join(tmp, ".agents", "skills", "artgraph-impact", "SKILL.md"),
      "codex user-edited content\n",
    );

    expect(() =>
      runInit(tmp, {
        noScan: true,
        agents: ["claude", "codex"],
      }),
    ).toThrow(DistributionError);

    // No config file. No trace lock. No AGENTS.md.
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(existsSync(join(tmp, "AGENTS.md"))).toBe(false);

    // Critically: agent 1 (claude) MUST NOT have any Skill files on disk.
    // Prior to the B2 fix, agent 1's distribute() ran to completion before
    // agent 2's failed, leaving `.claude/skills/artgraph-impact/SKILL.md`.
    expect(existsSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"))).toBe(false);

    // Agent 2's pre-existing user content is preserved unchanged.
    expect(
      readFileSync(join(tmp, ".agents", "skills", "artgraph-impact", "SKILL.md"), "utf-8"),
    ).toBe("codex user-edited content\n");
  });

  // -------------------------------------------------------------------------
  // spec 013 PR #114 [OPS-2 wiring] — writeGitAttributes runs after every
  // successful distribute() so the Skill dist tree is pinned to LF eol
  // (Windows-safe hash comparison in doctor).
  // -------------------------------------------------------------------------
  it("writes .gitattributes into every selected agent's skillsPath", () => {
    runInit(tmp, {
      noScan: true,
      agents: ["claude", "codex"],
    });

    for (const skillsPath of [".claude/skills", ".agents/skills"]) {
      const attrPath = join(tmp, ...skillsPath.split("/"), ".gitattributes");
      expect(existsSync(attrPath), `missing ${attrPath}`).toBe(true);
      expect(readFileSync(attrPath, "utf-8")).toBe("** text eol=lf\n");
    }
  });
});

// ---------------------------------------------------------------------------
// P0: runInit default behavior — new flag matrix
// (FR-003, FR-028, R15, contracts/cli-flags.md)
// ---------------------------------------------------------------------------

describe("runInit default behavior (P0)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("flag-less init runs the full agent-native setup (config + scan + skills + integrate-auto)", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    // spec 013: programmatic runInit caller must pass `agents` explicitly —
    // the CLI layer parses --agents=<list>, but here we wire it manually.
    const result = runInit(tmp, { agents: ["claude"] });

    // 1. .artgraph.json
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    // 2. .trace.lock from scan
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(true);
    // 3. Skills copied
    expect(result.skillsInstalled).toBeDefined();
    expect(existsSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "skills", "_shared", "install-check.md"))).toBe(true);
    // 4. integrate-auto: no SDD tools detected → no integrationResults but no error
    expect(result.integrationWarnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/error/i)]),
    );
  });

  // SC-007 (spec 014): default `artgraph init` (full agent-native setup) must
  // deploy the new artgraph-plan-coverage Skill so /speckit-tasks → plan-coverage
  // workflow works out of the box.
  it("deploys artgraph-plan-coverage Skill in default mode (spec 014 SC-007)", () => {
    const result = runInit(tmp, { agents: ["claude"] });
    const installedPath = join(tmp, ".claude", "skills", "artgraph-plan-coverage", "SKILL.md");
    expect(existsSync(installedPath)).toBe(true);
    const body = readFileSync(installedPath, "utf-8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).toMatch(/name:\s*["']?artgraph-plan-coverage/);
    expect(result.skillsInstalled).toEqual(
      expect.arrayContaining([
        expect.stringContaining(join(".claude", "skills", "artgraph-plan-coverage", "SKILL.md")),
      ]),
    );
  });

  it("--minimal generates only .artgraph.json (no scan, no skills, no integrate, no hooks, no agent-context)", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp, { minimal: true });

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(existsSync(join(tmp, ".claude"))).toBe(false);
    expect(result.skillsInstalled).toBeUndefined();
    expect(result.scanSummary).toBeUndefined();
  });

  it("--no-skills skips Skills install but keeps the rest of the default flow", () => {
    const result = runInit(tmp, { noSkills: true });
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(result.skillsInstalled).toBeUndefined();
    expect(existsSync(join(tmp, ".claude", "skills"))).toBe(false);
  });

  it("--no-integrate skips integrate-auto", () => {
    mkdirSync(join(tmp, ".specify"));
    const result = runInit(tmp, { noIntegrate: true });
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(result.integrationResults).toBeUndefined();
    expect(existsSync(join(tmp, ".specify", "extensions"))).toBe(false);
  });

  it("--minimal + agents=claude stays bare config (agents is ignored when every stage is off)", () => {
    // spec 013 (FR-013) / issue #135: --minimal disables every stage with no
    // opt-in path left; a programmatic caller passing `agents` alongside
    // `minimal` still gets bare config only.
    const result = runInit(tmp, { minimal: true, agents: ["claude"] });
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(result.skillsInstalled).toBeUndefined();
    expect(existsSync(join(tmp, ".claude"))).toBe(false);
  });

  it("integrate-auto is no-op (exit 0) when no SDD tools are detected", () => {
    expect(() => runInit(tmp)).not.toThrow();
  });

  it("integrate-auto runs speckit when only .specify/ is detected", () => {
    mkdirSync(join(tmp, ".specify"));
    const result = runInit(tmp);
    const speckitResult = (result.integrationResults ?? []).find((r) => r.providerId === "speckit");
    expect(speckitResult).toBeDefined();
  });

  it("integrate-auto runs both providers when .specify/ and .kiro/ are both detected", () => {
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    const result = runInit(tmp);
    const ids = (result.integrationResults ?? []).map((r) => r.providerId).sort();
    expect(ids).toEqual(["kiro", "speckit"]);
  });

  it("default mode creates .claude/settings.json with the Stop hook", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t", type: "module" }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");

    runInit(tmp);

    const settingsPath = join(tmp, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^pnpm exec artgraph /);
  });

  it("default mode without --agents does NOT create or modify CLAUDE.md (agent-context stage requires --agents)", () => {
    runInit(tmp);
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("--no-hooks is accepted without error in default mode", () => {
    const result = runInit(tmp, { noHooks: true });
    expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
    expect(result.hooksInstall).toBeUndefined();
  });

  it("--no-agent-context is accepted without error in default mode", () => {
    expect(() => runInit(tmp, { noAgentContext: true })).not.toThrow();
  });

  it("integrate-auto passes gate-on to speckit (before_implement hook registered)", () => {
    // Gate-on is the auto-integrate default for speckit (issue #135); the
    // standalone `artgraph integrate speckit --no-gate` is the opt-out.
    mkdirSync(join(tmp, ".specify"));
    runInit(tmp);
    const yml = readFileSync(join(tmp, ".specify", "extensions.yml"), "utf-8");
    expect(yml).toMatch(/before_implement:/);
    expect(yml).toMatch(/command:\s*artgraph\.check-gate/);
  });
});

// ---------------------------------------------------------------------------
// spec 013 PR #114 review — Cluster C
// (B3 atomic config write / B7 reorder / OPS-14 partial-state guard)
// ---------------------------------------------------------------------------
describe("runInit — PR #114 Cluster C (B3 / B7 / OPS-14)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  // -------------------------------------------------------------------------
  // [B3] `.artgraph.json` is now written via `atomicWriteFile` (tmp + rename)
  // instead of a raw `writeFileSync`. Observable effects:
  //   1. A successful init leaves no lingering `.artgraph-tmp-*` sibling.
  //   2. The final on-disk file parses as complete JSON — never a truncated
  //      body from a mid-write crash.
  // -------------------------------------------------------------------------
  it("[B3] writes .artgraph.json atomically (no tmp sibling lingers)", () => {
    runInit(tmp, { minimal: true });

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);

    const siblings = readdirSync(tmp);
    const stray = siblings.filter((n) => n.startsWith(".artgraph-tmp-"));
    expect(stray).toEqual([]);

    // Config must be fully-formed JSON (no truncation).
    const parsed = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(parsed).toHaveProperty("include");
    expect(parsed).toHaveProperty("lockFile");
  });

  // -------------------------------------------------------------------------
  // [B7] agent-context stage runs BEFORE the `.artgraph.json` write.
  // If a wrapper / AGENTS.md write throws, no config file is left on disk —
  // the user sees a clean failure instead of an inconsistent state where
  // `.artgraph.json` claims a completed init but AGENTS.md is missing.
  //
  // Reproduction: place a DIRECTORY at `<rootDir>/AGENTS.md`. `writeAgentsMd`
  // → `writeMarkerFile` → `readFileSync(AGENTS.md, "utf-8")` throws EISDIR.
  // EISDIR is not the tolerated ENOENT branch, so the error propagates.
  // -------------------------------------------------------------------------
  it("[B7] agent-context failure leaves no .artgraph.json orphan", () => {
    // Poison AGENTS.md: a directory here breaks readFileSync → propagates.
    mkdirSync(join(tmp, "AGENTS.md"));

    expect(() =>
      runInit(tmp, {
        noScan: true,
        agents: ["claude"],
      }),
    ).toThrow();

    // Config must NOT be written when a preceding stage throws (B7 reorder).
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // [OPS-14] The "recommended simpler approach" from the PR feedback: when
  // agent-context succeeds but a later stage fails, we do NOT unwind the
  // marker block writes. They are idempotent and get refreshed on the next
  // successful init.
  //
  // With B7's reorder the last write IS `.artgraph.json` (via
  // `atomicWriteFile`), so a real-world post-agent-context failure is rare
  // — but we assert the invariant explicitly: successful init leaves
  // both AGENTS.md and CLAUDE.md on disk with a matching config file.
  // -------------------------------------------------------------------------
  it("[OPS-14 / B7] successful init leaves AGENTS.md + CLAUDE.md + .artgraph.json all present", () => {
    runInit(tmp, {
      noScan: true,
      agents: ["claude"],
    });

    expect(existsSync(join(tmp, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);

    // AGENTS.md must contain the marker block bytes (proof it actually ran).
    const agentsMd = readFileSync(join(tmp, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("<!-- artgraph:begin -->");
    expect(agentsMd).toContain("<!-- artgraph:end -->");
  });
});

// spec 013 (T010) — the legacy `installSkills` direct-invocation tests were
// removed when distribute() became the production Skills installer. The
// packaging-fault surface (template dir missing / no skill dirs / missing
// SKILL.md) now lives behind `readSkillSource()`, asserted here.
describe("readSkillSource (packaging-fault surface)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("throws SkillsInstallError when the templates directory is missing (packaging fault)", () => {
    const missingDir = join(tmp, "does-not-exist");

    expect(() => readSkillSource(missingDir)).toThrow(SkillsInstallError);
    expect(() => readSkillSource(missingDir)).toThrow(/template directory not found.*packaging/i);
  });

  it("throws SkillsInstallError when the templates directory has no Skill directories", () => {
    const emptyTemplates = mkdtempSync(join(tmpdir(), "artgraph-empty-templates-"));
    // Place a stray file (not a directory) to ensure the empty check is on the
    // directory filter.
    writeFileSync(join(emptyTemplates, "README.txt"), "not a skill dir\n");

    try {
      expect(() => readSkillSource(emptyTemplates)).toThrow(SkillsInstallError);
      expect(() => readSkillSource(emptyTemplates)).toThrow(
        /No skill template directories.*packaging/i,
      );
    } finally {
      rmSync(emptyTemplates, { recursive: true, force: true });
    }
  });

  it("throws SkillsInstallError when a Skill directory is missing SKILL.md", () => {
    const customTemplates = mkdtempSync(join(tmpdir(), "artgraph-bad-skill-"));
    // Skill dir without SKILL.md → packaging fault.
    mkdirSync(join(customTemplates, "artgraph-broken"), { recursive: true });
    writeFileSync(join(customTemplates, "artgraph-broken", "README.md"), "no SKILL.md here\n");

    try {
      expect(() => readSkillSource(customTemplates)).toThrow(/artgraph-broken.*missing SKILL\.md/);
    } finally {
      rmSync(customTemplates, { recursive: true, force: true });
    }
  });

  // PR #114 BND-3 — `_shared/` alone is not a distributable set.
  it("throws SkillsInstallError when the only top-level dir is `_shared/`", () => {
    const sharedOnly = mkdtempSync(join(tmpdir(), "artgraph-shared-only-"));
    mkdirSync(join(sharedOnly, "_shared"), { recursive: true });
    writeFileSync(join(sharedOnly, "_shared", "helper.md"), "shared fragment\n");

    try {
      expect(() => readSkillSource(sharedOnly)).toThrow(SkillsInstallError);
      expect(() => readSkillSource(sharedOnly)).toThrow(/Only _shared.*no distributable Skills/i);
    } finally {
      rmSync(sharedOnly, { recursive: true, force: true });
    }
  });
});

describe("skill template <-> dogfood sync", () => {
  // Guards against drift between templates/skills/ (the distributed source
  // of truth) and every distributed on-disk copy under this repo's canonical
  // agent skills paths. If one is updated without the other, this test
  // fails.
  //
  // Compares raw bytes (not normalized) so CRLF injection, trailing
  // whitespace, or BOM insertion is caught — the SC-002 contract for
  // spec 013 requires byte-identical distribution across all 5 canonical
  // agent paths, verifiable by `diff -r`. A LF-pin `.gitattributes` under
  // each skills path is expected to keep Windows checkouts in line.

  const REPO_ROOT = resolve(import.meta.dirname, "..");
  const templateDir = resolve(REPO_ROOT, "templates", "skills");
  // Every canonical agent path, not just Claude. See AGENT_DESCRIPTORS.
  const dogfoodDirs = AGENT_DESCRIPTORS.map((d) => resolve(REPO_ROOT, d.skillsPath));

  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, out);
      else if (stat.isFile()) out.push(full);
    }
  }

  it("every template file has a matching dogfood file with byte-identical content in all 5 agent paths", () => {
    // Sanity: all 5 canonical dogfood paths must exist in this repo. If one
    // is missing (e.g. someone rm'd a dir), fail loud instead of silently
    // skipping — the previous silent-skip behaviour let drift merge to main
    // without CI catching it.
    const missing = dogfoodDirs.filter((d) => !existsSync(d));
    expect(
      missing,
      `dogfood skills path(s) missing from repo (SC-002 requires byte-identical distribution to every canonical agent path): ${missing.join(", ")}`,
    ).toEqual([]);

    const files: string[] = [];
    walk(templateDir, files);
    expect(files.length).toBeGreaterThan(0);

    for (const tPath of files) {
      const rel = tPath.substring(templateDir.length + 1);
      const tBytes = readFileSync(tPath);
      for (const dogfoodDir of dogfoodDirs) {
        const dPath = join(dogfoodDir, rel);
        expect(existsSync(dPath), `dogfood file missing: ${dPath}`).toBe(true);
        const dBytes = readFileSync(dPath);
        // Raw byte comparison — no CRLF/whitespace normalization. SC-002
        // demands `diff -r` clean, not "semantically identical".
        expect(
          dBytes.equals(tBytes),
          `byte drift in ${dogfoodDir.substring(REPO_ROOT.length + 1)}/${rel} (canonical templates/skills/${rel} differs)`,
        ).toBe(true);
      }
    }

    // Reverse direction: every dogfood file (in every canonical path) must
    // have a matching template file (no stale files left behind by a rename
    // or removal).
    for (const dogfoodDir of dogfoodDirs) {
      const dogfoodFiles: string[] = [];
      walk(dogfoodDir, dogfoodFiles);
      for (const dPath of dogfoodFiles) {
        const rel = dPath.substring(dogfoodDir.length + 1);
        // Skip speckit-* directories (managed by Spec Kit under .claude/
        // specifically, not artgraph templates).
        if (rel.startsWith("speckit-")) continue;
        const tPath = join(templateDir, rel);
        expect(
          existsSync(tPath),
          `stale dogfood file (no template): ${dogfoodDir.substring(REPO_ROOT.length + 1)}/${rel}`,
        ).toBe(true);
      }
    }
  });
});

describe("computeStageGates (P0 flag matrix truth table)", () => {
  it("default (no flags) enables every stage", () => {
    expect(computeStageGates({})).toEqual({
      scan: true,
      skills: true,
      integrate: true,
      hooks: true,
      agentContext: true,
    });
  });

  it("--minimal disables every stage", () => {
    expect(computeStageGates({ minimal: true })).toEqual({
      scan: false,
      skills: false,
      integrate: false,
      hooks: false,
      agentContext: false,
    });
  });

  it("--no-skills disables only Skills in default mode", () => {
    expect(computeStageGates({ noSkills: true })).toEqual({
      scan: true,
      skills: false,
      integrate: true,
      hooks: true,
      agentContext: true,
    });
  });

  it("--no-integrate + --no-hooks + --no-agent-context leaves only config + scan + skills", () => {
    expect(computeStageGates({ noIntegrate: true, noHooks: true, noAgentContext: true })).toEqual({
      scan: true,
      skills: true,
      integrate: false,
      hooks: false,
      agentContext: false,
    });
  });
});

describe("runInit — packageManager recording (spec 015, FR-007/008, SC-002)", () => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir();
    // The undetectable-PM case warns to stderr by design; silence it so the
    // test output stays clean (the warning content is asserted in
    // package-manager-detection.test.ts).
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    cleanup(tmp);
  });

  const readPm = (): unknown =>
    JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8")).packageManager;

  it("records pnpm for a package.json-only project (default PM)", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    runInit(tmp, { minimal: true });
    expect(readPm()).toBe("pnpm");
  });

  it("records bun when bun.lockb is present", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(tmp, "bun.lockb"), "");
    runInit(tmp, { minimal: true });
    expect(readPm()).toBe("bun");
  });

  it("records npm for an explicit package-lock.json signal", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(tmp, "package-lock.json"), "{}");
    runInit(tmp, { minimal: true });
    expect(readPm()).toBe("npm");
  });

  it("records deno when only a deno.json is present (no package.json)", () => {
    writeFileSync(join(tmp, "deno.json"), "{}");
    runInit(tmp, { minimal: true });
    expect(readPm()).toBe("deno");
  });

  it("omits packageManager and still exits cleanly when undetectable", () => {
    // Empty dir: no package.json / lockfile / deno marker → detection returns null.
    const result = runInit(tmp, { minimal: true });
    expect(result.configPath).toBeTruthy();
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(readPm()).toBeUndefined();
  });

  it("re-detects and overwrites packageManager on --force re-init", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(tmp, "package-lock.json"), "{}");
    runInit(tmp, { minimal: true });
    expect(readPm()).toBe("npm");

    // Switch the signal to pnpm and re-init with --force.
    rmSync(join(tmp, "package-lock.json"));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    runInit(tmp, { minimal: true, force: true });
    expect(readPm()).toBe("pnpm");
  });
});
