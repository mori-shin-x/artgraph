import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
const LOCK_PATH = resolve(FIXTURE_DIR, ".trace.lock");

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd: FIXTURE_DIR,
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

function cleanup() {
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------
describe("CLI: coverage", () => {
  it("should output coverage as JSON", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["coverage", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.items).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.summary).toBeDefined();
    expect(result.summary.total).toBeGreaterThan(0);
    expect(typeof result.summary.verified).toBe("number");
    expect(typeof result.summary.implOnly).toBe("number");
    expect(typeof result.summary.untagged).toBe("number");
  });

  it("should include correct status for each REQ in JSON", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["coverage", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);

    // AUTH-001 has both impl and test -> verified
    const auth001 = result.items.find((i: any) => i.reqId === "AUTH-001");
    expect(auth001).toBeDefined();
    expect(auth001.status).toBe("verified");

    // AUTH-002 has impl but no test -> impl-only
    const auth002 = result.items.find((i: any) => i.reqId === "AUTH-002");
    expect(auth002).toBeDefined();
    expect(auth002.status).toBe("impl-only");

    // AUTH-003 has no impl -> untagged
    const auth003 = result.items.find((i: any) => i.reqId === "AUTH-003");
    expect(auth003).toBeDefined();
    expect(auth003.status).toBe("untagged");
  });

  it("should output summary counts matching items in JSON", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["coverage", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    const { items, summary } = result;

    const verifiedCount = items.filter((i: any) => i.status === "verified").length;
    const implOnlyCount = items.filter((i: any) => i.status === "impl-only").length;
    const untaggedCount = items.filter((i: any) => i.status === "untagged").length;

    expect(summary.total).toBe(items.length);
    expect(summary.verified).toBe(verifiedCount);
    expect(summary.implOnly).toBe(implOnlyCount);
    expect(summary.untagged).toBe(untaggedCount);
  });

  it("should output human-readable text by default", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["coverage"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AUTH-001");
    expect(stdout).toContain("verified");
    expect(stdout).toContain("untagged");
  });

  it("should output text with --format text", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["coverage", "--format", "text"]);
    expect(exitCode).toBe(0);
    // Should contain status lines for each REQ
    expect(stdout).toContain("AUTH-001");
    expect(stdout).toContain("AUTH-002");
    expect(stdout).toContain("AUTH-003");
    // Should contain a summary line
    expect(stdout).toMatch(/total/i);
  });

  it("should always exit 0 (no gating)", { timeout: 30000 }, () => {
    // Even with uncovered items, coverage should exit 0
    const { exitCode } = run(["coverage"]);
    expect(exitCode).toBe(0);
  });

  it("should appear in --help output", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("coverage");
  });
});
