import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  runInit,
  detectProject,
  generateConfig,
  installSkills,
  SkillsInstallError,
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

  it("overwrites existing .artgraph.json with --force", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, ".artgraph.json"), '{"include":["old"]}\n');

    const result = runInit(tmp, { force: true });

    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.include).toContain("src/**/*.ts");
    expect(config.include).not.toContain("old");
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

  it("supports --force combined with --no-scan", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, ".artgraph.json"), '{"include":["old"]}\n');

    const result = runInit(tmp, { force: true, noScan: true });

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.include).not.toContain("old");
  });

  it("handles empty project with no ts files", () => {
    const result = runInit(tmp);

    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(true);
    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary!.nodeCount).toBe(0);
  });
});

describe("runInit --with-skills", () => {
  let tmp: string;
  const SKILL_NAMES = [
    "artgraph-plan.md",
    "artgraph-verify.md",
    "artgraph-coverage.md",
    "artgraph-rename.md",
  ];

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("does not install skills by default", () => {
    const result = runInit(tmp, { noScan: true });

    expect(result.skillsInstalled).toBeUndefined();
    expect(existsSync(join(tmp, ".claude", "skills"))).toBe(false);
  });

  it("copies all skill templates into .claude/skills/ when --with-skills is set", () => {
    const result = runInit(tmp, { noScan: true, withSkills: true });

    expect(result.skillsInstalled).toBeDefined();
    expect(result.skillsInstalled!.length).toBe(SKILL_NAMES.length);
    for (const name of SKILL_NAMES) {
      const dest = join(tmp, ".claude", "skills", name);
      expect(existsSync(dest)).toBe(true);
      // Frontmatter sanity: each template begins with `---` block + `name:` field.
      const body = readFileSync(dest, "utf-8");
      expect(body.startsWith("---")).toBe(true);
      expect(body).toMatch(/name:\s*["']?artgraph-/);
    }
  });

  it("throws when a skill file already exists and --force is not set", () => {
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "user content\n");

    expect(() => runInit(tmp, { noScan: true, withSkills: true })).toThrow(
      /artgraph-plan\.md.*--force/,
    );

    // Existing user content must be preserved.
    expect(readFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "utf-8")).toBe(
      "user content\n",
    );
  });

  it("overwrites existing skill files when --force is set", () => {
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "user content\n");

    const result = runInit(tmp, { noScan: true, withSkills: true, force: true });

    expect(result.skillsInstalled!.length).toBe(SKILL_NAMES.length);
    const body = readFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "utf-8");
    expect(body.startsWith("---")).toBe(true);
    expect(body).not.toBe("user content\n");
  });

  it("lists all conflicting files in the error (not just the first)", () => {
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "x\n");
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-verify.md"), "y\n");

    let caught: unknown;
    try {
      runInit(tmp, { noScan: true, withSkills: true });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SkillsInstallError);
    const msg = (caught as Error).message;
    expect(msg).toContain("artgraph-plan.md");
    expect(msg).toContain("artgraph-verify.md");
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
    mkdirSync(join(tmp, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "preexisting\n");

    expect(() => runInit(tmp, { noScan: true, withSkills: true })).toThrow(SkillsInstallError);

    // Config must not exist — pre-flight check should fail before any write.
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
    // Existing user content preserved.
    expect(readFileSync(join(tmp, ".claude", "skills", "artgraph-plan.md"), "utf-8")).toBe(
      "preexisting\n",
    );
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

  it("returns paths matching every *.md template in the template directory", () => {
    const installed = installSkills(tmp);

    // Source of truth: the templates directory itself, not a hardcoded list.
    const templateDir = resolve(import.meta.dirname, "..", "templates", "skills");
    const expected = readdirSync(templateDir).filter((f) => f.endsWith(".md"));
    expect(installed.length).toBe(expected.length);
    for (const name of expected) {
      expect(installed).toContain(join(".claude", "skills", name));
      expect(existsSync(join(tmp, ".claude", "skills", name))).toBe(true);
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

  it("throws SkillsInstallError when the templates directory has no .md files", () => {
    const emptyTemplates = mkdtempSync(join(tmpdir(), "artgraph-empty-templates-"));
    // Place a non-.md file to ensure the empty check is on the filter result.
    writeFileSync(join(emptyTemplates, "README.txt"), "not a skill\n");

    try {
      expect(() => installSkills(tmp, { templateDir: emptyTemplates })).toThrow(SkillsInstallError);
      expect(() => installSkills(tmp, { templateDir: emptyTemplates })).toThrow(
        /No skill templates.*packaging/i,
      );
    } finally {
      rmSync(emptyTemplates, { recursive: true, force: true });
    }
  });

  it("throws SkillsInstallError with partiallyInstalled when a copy fails mid-loop", () => {
    const customTemplates = mkdtempSync(join(tmpdir(), "artgraph-custom-templates-"));
    writeFileSync(join(customTemplates, "only.md"), "skill body\n");

    // Place a directory at the destination so copyFileSync fails with EISDIR.
    // force: true is required so the conflict check passes and we reach the copy step.
    mkdirSync(join(tmp, ".claude", "skills", "only.md"), { recursive: true });

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
    expect(err.partiallyInstalled).toEqual([]);
    expect(err.message).toMatch(/Failed to copy only\.md/);
  });
});

describe("skill template <-> dogfood sync", () => {
  // Guards against drift between packages/artgraph/templates/skills/ (the
  // distributed source of truth) and .claude/skills/ (this repo's dogfood
  // copy). If one is updated without the other, this test fails.
  function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  const templateDir = resolve(import.meta.dirname, "..", "templates", "skills");
  // From packages/artgraph/tests/ up two levels to repo root, then into .claude/.
  const dogfoodDir = resolve(import.meta.dirname, "..", "..", "..", ".claude", "skills");

  it("every template has a matching dogfood file with identical content", () => {
    // Only run when the dogfood directory actually exists (i.e. inside this
    // repo). Consumers of the published package won't have it.
    if (!existsSync(dogfoodDir)) {
      return;
    }

    const templates = readdirSync(templateDir).filter((f) => f.endsWith(".md"));
    for (const name of templates) {
      const tHash = sha256(join(templateDir, name));
      const dPath = join(dogfoodDir, name);
      expect(existsSync(dPath), `dogfood file missing: ${dPath}`).toBe(true);
      expect(sha256(dPath), `content drift in ${name}`).toBe(tHash);
    }
  });
});
