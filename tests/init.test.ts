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
  installSkills,
  SkillsInstallError,
  computeStageGates,
} from "../src/init.js";

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
      taskConventions: [
        { name: "openspec", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" },
      ],
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

  it("partial-state guard: installSkills failure leaves no .artgraph.json / .trace.lock orphan", () => {
    // Force `installSkills` to fail mid-loop AFTER the conflict pre-flight
    // accepts the layout: place a DIRECTORY at the destination path of a
    // SKILL.md and pass --force. `findConflicts` flags it as a regular
    // conflict (lstat says non-symlink), `--force` lets it through, then
    // `copyFileSync` blows up with EISDIR. With the order fixed (skills first,
    // config write last), neither `.artgraph.json` nor `.trace.lock` should
    // be on disk after the throw.
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), {
      recursive: true,
    });
    // Stash a marker inside the offending dir so the rollback's `rmdirSync`
    // (which only removes empty dirs) can't accidentally tidy it away and
    // make the failure go silent next iteration.
    writeFileSync(
      join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md", "marker"),
      "user content\n",
    );

    expect(() =>
      runInit(tmp, { force: true, noScan: true, withSkills: true }),
    ).toThrow(SkillsInstallError);

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
  "artgraph-coverage",
  "artgraph-detect",
  "artgraph-impact",
  "artgraph-integrate",
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
    const result = runInit(tmp, { noScan: true, withSkills: true });

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
    runInit(tmp, { noScan: true, withSkills: true });
    for (const name of ["install-check.md", "output-schema.md", "package-manager.md"]) {
      expect(existsSync(join(tmp, ".claude", "skills", "_shared", name))).toBe(true);
    }
  });

  it("throws when a skill file already exists and --force is not set", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"),
      "user content\n",
    );

    expect(() => runInit(tmp, { noScan: true, withSkills: true })).toThrow(
      /artgraph-impact[/\\]SKILL\.md.*--force/,
    );

    // Existing user content must be preserved.
    expect(
      readFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "utf-8"),
    ).toBe("user content\n");
  });

  it("overwrites existing skill files when --force is set", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"),
      "user content\n",
    );

    const result = runInit(tmp, { noScan: true, withSkills: true, force: true });

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
      runInit(tmp, { noScan: true, withSkills: true });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SkillsInstallError);
    const msg = (caught as Error).message;
    expect(msg).toContain("artgraph-impact");
    expect(msg).toContain("artgraph-verify");
    expect(msg).toMatch(/--force/);
  });

  it("preserves user-authored skill files outside the template set on --force", () => {
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "my-custom.md"), "user skill\n");

    runInit(tmp, { noScan: true, withSkills: true, force: true });

    // Custom file untouched, even when --force overwrites artgraph-* templates.
    expect(readFileSync(join(tmp, ".claude", "skills", "my-custom.md"), "utf-8")).toBe(
      "user skill\n",
    );
  });

  it("does not write .artgraph.json when skills pre-flight validation fails", () => {
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"),
      "preexisting\n",
    );

    expect(() => runInit(tmp, { noScan: true, withSkills: true })).toThrow(SkillsInstallError);

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
    expect(
      readFileSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "utf-8"),
    ).toBe("preexisting\n");
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

    const result = runInit(tmp);

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
    const result = runInit(tmp);
    const installedPath = join(
      tmp,
      ".claude",
      "skills",
      "artgraph-plan-coverage",
      "SKILL.md",
    );
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

  it("--minimal --with-skills enables only Skills on top of bare config", () => {
    const result = runInit(tmp, { minimal: true, withSkills: true });
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(result.skillsInstalled).toBeDefined();
    expect(existsSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"))).toBe(true);
  });

  it("integrate-auto is no-op (exit 0) when no SDD tools are detected", () => {
    expect(() => runInit(tmp)).not.toThrow();
  });

  it("integrate-auto runs speckit when only .specify/ is detected", () => {
    mkdirSync(join(tmp, ".specify"));
    const result = runInit(tmp);
    const speckitResult = (result.integrationResults ?? []).find(
      (r) => r.providerId === "speckit",
    );
    expect(speckitResult).toBeDefined();
  });

  it("integrate-auto runs both providers when .specify/ and .kiro/ are both detected", () => {
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    const result = runInit(tmp);
    const ids = (result.integrationResults ?? []).map((r) => r.providerId).sort();
    expect(ids).toEqual(["kiro", "speckit"]);
  });

  it("default mode does NOT create .claude/settings.json (hooks stub no-op in P0)", () => {
    runInit(tmp);
    expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(false);
  });

  it("default mode does NOT create or modify CLAUDE.md (agent-context stub no-op in P0)", () => {
    runInit(tmp);
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(false);
  });

  it("--no-hooks is accepted without error in default mode", () => {
    expect(() => runInit(tmp, { noHooks: true })).not.toThrow();
  });

  it("--no-agent-context is accepted without error in default mode", () => {
    expect(() => runInit(tmp, { noAgentContext: true })).not.toThrow();
  });

  it("--integrations <list> overrides auto-detect (only the requested tool runs)", () => {
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    const result = runInit(tmp, { integrations: ["speckit"] });
    const ids = (result.integrationResults ?? []).map((r) => r.providerId);
    expect(ids).toEqual(["speckit"]);
    // Kiro should NOT have been integrated even though .kiro/ is present
    expect(existsSync(join(tmp, ".kiro", "steering", "artgraph.md"))).toBe(false);
  });
});

describe("installSkills (direct invocation)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("returns paths covering every <name>/SKILL.md plus _shared/*.md fragments", () => {
    const installed = installSkills(tmp);

    const templateDir = resolve(import.meta.dirname, "..", "templates", "skills");
    const topDirs = readdirSync(templateDir).filter((name) => !name.startsWith("."));
    // At least every top-level directory must have produced at least one file.
    for (const dir of topDirs) {
      expect(installed.some((p) => p.startsWith(join(".claude", "skills", dir)))).toBe(true);
    }
    // Every SKILL.md must exist at its mirrored destination.
    for (const dir of topDirs) {
      if (dir === "_shared") continue;
      expect(existsSync(join(tmp, ".claude", "skills", dir, "SKILL.md"))).toBe(true);
    }
  });

  it("creates .claude/skills/ recursively when it does not exist", () => {
    expect(existsSync(join(tmp, ".claude"))).toBe(false);
    installSkills(tmp);
    expect(existsSync(join(tmp, ".claude", "skills"))).toBe(true);
  });

  it("throws SkillsInstallError when the templates directory is missing (packaging fault)", () => {
    const missingDir = join(tmp, "does-not-exist");

    expect(() => installSkills(tmp, { templateDir: missingDir })).toThrow(SkillsInstallError);
    expect(() => installSkills(tmp, { templateDir: missingDir })).toThrow(
      /template directory not found.*packaging/i,
    );
  });

  it("throws SkillsInstallError when the templates directory has no Skill directories", () => {
    const emptyTemplates = mkdtempSync(join(tmpdir(), "artgraph-empty-templates-"));
    // Place a stray file (not a directory) to ensure the empty check is on the
    // directory filter.
    writeFileSync(join(emptyTemplates, "README.txt"), "not a skill dir\n");

    try {
      expect(() => installSkills(tmp, { templateDir: emptyTemplates })).toThrow(SkillsInstallError);
      expect(() => installSkills(tmp, { templateDir: emptyTemplates })).toThrow(
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
      expect(() => installSkills(tmp, { templateDir: customTemplates })).toThrow(
        /artgraph-broken.*missing SKILL\.md/,
      );
    } finally {
      rmSync(customTemplates, { recursive: true, force: true });
    }
  });

  it("throws SkillsInstallError with the failing path when copy fails mid-loop", () => {
    const customTemplates = mkdtempSync(join(tmpdir(), "artgraph-custom-templates-"));
    mkdirSync(join(customTemplates, "artgraph-only"), { recursive: true });
    writeFileSync(join(customTemplates, "artgraph-only", "SKILL.md"), "skill body\n");

    // Place a directory at the destination so copyFileSync fails with EISDIR.
    mkdirSync(join(tmp, ".claude", "skills", "artgraph-only", "SKILL.md"), { recursive: true });

    let caught: unknown;
    try {
      installSkills(tmp, { templateDir: customTemplates, force: true });
    } catch (e) {
      caught = e;
    } finally {
      rmSync(customTemplates, { recursive: true, force: true });
    }

    expect(caught).toBeInstanceOf(SkillsInstallError);
    const err = caught as SkillsInstallError;
    expect(err.message).toMatch(/Failed to copy .*SKILL\.md/);
  });
});

describe("skill template <-> dogfood sync", () => {
  // Guards against drift between templates/skills/ (the distributed source
  // of truth) and .claude/skills/ (this repo's dogfood copy). If one is
  // updated without the other, this test fails.
  //
  // The check normalises line endings (CRLF → LF) and per-line trailing
  // whitespace before comparing so an editor that silently re-saves with a
  // different EOL convention or a stray trailing space doesn't break CI. The
  // intent — "every byte that semantically matters must match" — is preserved.
  function normalize(content: string): string {
    return content
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t ]+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  }
  function readNormalized(path: string): string {
    return normalize(readFileSync(path, "utf-8"));
  }

  const templateDir = resolve(import.meta.dirname, "..", "templates", "skills");
  // From tests/ up one level to repo root, then into .claude/.
  const dogfoodDir = resolve(import.meta.dirname, "..", ".claude", "skills");

  it("every template file has a matching dogfood file with identical content", () => {
    // Only run when the dogfood directory actually exists (i.e. inside this
    // repo). Consumers of the published package won't have it.
    if (!existsSync(dogfoodDir)) {
      return;
    }

    // Walk templates/skills/ recursively. Each .md file (SKILL.md under a
    // skill directory, or fragments under _shared/) must mirror exactly into
    // .claude/skills/ at the same relative path.
    function walk(dir: string, out: string[]): void {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, out);
        else if (stat.isFile()) out.push(full);
      }
    }
    const files: string[] = [];
    walk(templateDir, files);
    expect(files.length).toBeGreaterThan(0);

    for (const tPath of files) {
      const rel = tPath.substring(templateDir.length + 1);
      const dPath = join(dogfoodDir, rel);
      expect(existsSync(dPath), `dogfood file missing: ${dPath}`).toBe(true);
      expect(readNormalized(dPath), `content drift in ${rel}`).toBe(
        readNormalized(tPath),
      );
    }

    // Reverse direction: every dogfood file must have a matching template (no stale files)
    const dogfoodFiles: string[] = [];
    walk(dogfoodDir, dogfoodFiles);
    for (const dPath of dogfoodFiles) {
      const rel = dPath.substring(dogfoodDir.length + 1);
      // Skip speckit-* directories (managed by Spec Kit, not artgraph templates)
      if (rel.startsWith("speckit-")) continue;
      const tPath = join(templateDir, rel);
      expect(existsSync(tPath), `stale dogfood file (no template): ${rel}`).toBe(true);
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

  it("--minimal --with-skills enables only Skills", () => {
    expect(computeStageGates({ minimal: true, withSkills: true })).toEqual({
      scan: false,
      skills: true,
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

  it("--minimal + explicit integrations enables integrate stage", () => {
    expect(computeStageGates({ minimal: true, integrations: ["speckit"] })).toEqual({
      scan: false,
      skills: false,
      integrate: true,
      hooks: false,
      agentContext: false,
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
