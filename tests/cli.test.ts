import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const LOCK_PATH = resolve(FIXTURE_DIR, ".trace.lock");

function run(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd: FIXTURE_DIR,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

function cleanup() {
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
}

describe("CLI: scan", () => {
  it("should output graph summary as JSON", () => {
    const { stdout, exitCode } = run(["scan", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.edgeCount).toBeGreaterThan(0);
    expect(result.reqCount).toBeGreaterThanOrEqual(2);
  });
});

describe("CLI: impact", () => {
  it("should show impact for a REQ-ID", () => {
    const { stdout, exitCode } = run(["impact", "REQ-7f3a", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedFiles.length).toBeGreaterThan(0);
    expect(result.affectedReqs).toContain("REQ-7f3a");
  });

  it("should show impact for a file path", () => {
    const { stdout, exitCode } = run(["impact", "src/auth/login.ts", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("REQ-7f3a");
  });
});

describe("CLI: check", () => {
  it("should exit 2 with --gate when issues exist", () => {
    cleanup();
    const { exitCode } = run(["check", "--gate"]);
    expect(exitCode).toBe(2);
  });

  it("should report issues in JSON format", () => {
    cleanup();
    const { stdout } = run(["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.uncovered.length).toBeGreaterThan(0);
  });
});

describe("CLI: reconcile", () => {
  it("should create a lock file after reconcile", () => {
    cleanup();
    const { exitCode } = run(["reconcile"]);
    expect(exitCode).toBe(0);
    expect(existsSync(LOCK_PATH)).toBe(true);
    cleanup();
  });
});
