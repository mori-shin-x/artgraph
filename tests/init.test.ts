import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit, detectProject, generateConfig } from "../src/init.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "spectrace-init-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe("init", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  // T003: basic init generates .spectrace.json
  it("generates .spectrace.json with defaults for a project with src/", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(existsSync(join(tmp, ".spectrace.json"))).toBe(true);
    const config = JSON.parse(readFileSync(join(tmp, ".spectrace.json"), "utf-8"));
    expect(config.include).toContain("src/**/*.ts");
  });

  // T004: scan produces .trace.lock
  it("generates .trace.lock after scan", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(existsSync(join(tmp, ".trace.lock"))).toBe(true);
    expect(result.lockPath).toBeDefined();
  });

  // T005: returns scan summary
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

  // T010: no specs/ but docs/ → specDirs: ["docs"]
  it("sets specDirs to docs when only docs/ exists", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, "docs"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    const config = JSON.parse(readFileSync(join(tmp, ".spectrace.json"), "utf-8"));
    expect(config.specDirs).toEqual(["docs"]);
  });

  // T011: no src/ → include widens to **/*.ts
  it("widens include pattern when src/ does not exist", () => {
    writeFileSync(join(tmp, "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    const config = JSON.parse(readFileSync(join(tmp, ".spectrace.json"), "utf-8"));
    expect(config.include).toContain("**/*.ts");
    expect(config.include).not.toContain("src/**/*.ts");
  });

  // T012: .specify/ → Spec Kit detected
  it("detects Spec Kit when .specify/ exists", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, ".specify"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(result.sddTools).toContainEqual({ name: "Spec Kit", marker: ".specify" });
  });

  // T013: .kiro/ → Kiro detected
  it("detects Kiro when .kiro/ exists", () => {
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, ".kiro"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp);

    expect(result.sddTools).toContainEqual({ name: "Kiro", marker: ".kiro" });
  });

  // T017: existing .spectrace.json without --force → error
  it("throws error when .spectrace.json already exists", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, ".spectrace.json"), "{}\n");

    expect(() => runInit(tmp)).toThrow(".spectrace.json already exists");
  });

  // T018: --force overwrites existing config
  it("overwrites existing .spectrace.json with --force", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(tmp, ".spectrace.json"), '{"include":["old"]}\n');

    const result = runInit(tmp, { force: true });

    const config = JSON.parse(readFileSync(join(tmp, ".spectrace.json"), "utf-8"));
    expect(config.include).toContain("src/**/*.ts");
    expect(config.include).not.toContain("old");
  });

  // T020: --no-scan generates config only
  it("generates only .spectrace.json with --no-scan", () => {
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");

    const result = runInit(tmp, { noScan: true });

    expect(existsSync(join(tmp, ".spectrace.json"))).toBe(true);
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(result.scanSummary).toBeUndefined();
    expect(result.lockPath).toBeUndefined();
  });
});
