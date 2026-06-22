import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit, detectProject, generateConfig } from "../src/init.js";

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
});
