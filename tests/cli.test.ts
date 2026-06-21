import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { run, cleanup, CLI, FIXTURE_DIR, LOCK_PATH } from "./helpers.js";

const HOOKS_DIR = resolve(import.meta.dirname, "fixtures/hooks");
const SPECTRACE_CONFIG_PATH = resolve(FIXTURE_DIR, ".spectrace.json");

function runWithStdin(
  args: string[],
  stdin: string,
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    cwd: cwd ?? FIXTURE_DIR,
    input: stdin,
    timeout: 30000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
describe("CLI: scan", () => {
  it("should output graph summary as JSON", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["scan", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.edgeCount).toBeGreaterThan(0);
    expect(result.reqCount).toBeGreaterThanOrEqual(2);
  });

  it("should output human-readable text by default", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Nodes:\s+[1-9]/);
    expect(stdout).toMatch(/Edges:\s+[1-9]/);
    expect(stdout).toContain("req:");
    expect(stdout).toContain("file:");
  });

  it("should output text with --format text", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["scan", "--format", "text"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Nodes:");
    expect(stdout).toContain("Edges:");
  });
});

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------
describe("CLI: impact", () => {
  it("should show impact for a REQ-ID", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["impact", "AUTH-001", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedFiles.length).toBeGreaterThan(0);
    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("should show impact for a file path", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["impact", "src/auth/login.ts", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("should output human-readable text by default", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["impact", "AUTH-001"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Affected REQs:");
    expect(stdout).toContain("AUTH-001");
  });

  it("should show impact for multiple targets", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run([
      "impact",
      "AUTH-001",
      "src/auth/session.ts",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
    expect(result.affectedFiles.length).toBeGreaterThan(0);
  });

  it("should fail when no targets are given", { timeout: 30000 }, () => {
    const { exitCode, stderr } = run(["impact"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No targets specified");
  });

  it("should fail when target does not match any node", { timeout: 30000 }, () => {
    const { exitCode, stderr } = run(["impact", "NONEXISTENT-ID"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No matching nodes found");
  });

  // Smoke test: --diff depends on real git state so the result is non-deterministic.
  // A proper test would need a temporary git repo with a controlled diff.
  it("should not crash with --diff flag", { timeout: 30000 }, () => {
    const { exitCode } = run(["impact", "--diff"]);
    expect([0, 1]).toContain(exitCode);
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
describe("CLI: check", () => {
  it("should exit 2 with --gate when issues exist", { timeout: 30000 }, () => {
    cleanup();
    const { exitCode } = run(["check", "--gate"]);
    expect(exitCode).toBe(2);
  });

  it("should report issues in JSON format", { timeout: 30000 }, () => {
    cleanup();
    const { stdout } = run(["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.uncovered.length).toBeGreaterThan(0);
  });

  it("should output human-readable text by default", { timeout: 30000 }, () => {
    cleanup();
    const { stdout } = run(["check"]);
    // Without a lock file, there will be uncovered items.
    expect(stdout).toContain("UNCOVERED:");
    expect(stdout).toContain("COVERAGE:");
  });

  // Smoke test: --diff depends on real git state so the result is non-deterministic.
  // A proper test would need a temporary git repo with a controlled diff.
  it("should not crash with --diff flag", { timeout: 30000 }, () => {
    cleanup();
    const { exitCode } = run(["check", "--diff"]);
    // Without --gate, check never calls process.exit(2).
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------
describe("CLI: reconcile", () => {
  it("should create a lock file after reconcile", { timeout: 30000 }, () => {
    cleanup();
    const { exitCode, stdout } = run(["reconcile"]);
    expect(exitCode).toBe(0);
    expect(existsSync(LOCK_PATH)).toBe(true);
    expect(stdout).toContain("Lock file updated");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// reconcile -> check scenario (no drift expected)
// ---------------------------------------------------------------------------
describe("CLI: reconcile then check (no drift)", () => {
  it("should have no drift immediately after reconcile", { timeout: 30000 }, () => {
    cleanup();

    // Step 1: reconcile to create a fresh lock.
    const rec = run(["reconcile"]);
    expect(rec.exitCode).toBe(0);
    expect(existsSync(LOCK_PATH)).toBe(true);

    // Step 2: check should report zero drift and zero orphans.
    // Note: pass may still be false due to uncovered REQs in the fixture
    // (AUTH-003 has no @impl), but drift should be empty.
    const chk = run(["check", "--format", "json"]);
    expect(chk.exitCode).toBe(0);

    const result = JSON.parse(chk.stdout);
    expect(result.drifted).toEqual([]);
    expect(result.orphans).toEqual([]);
    // AUTH-003 has no @impl, so pass is false and uncovered contains it.
    expect(result.pass).toBe(false);
    expect(result.uncovered).toContain("AUTH-003");
  });

  it("should include coverage information after reconcile", { timeout: 30000 }, () => {
    cleanup();

    const rec = run(["reconcile"]);
    expect(rec.exitCode).toBe(0);

    const chk = run(["check", "--format", "json"]);
    expect(chk.exitCode).toBe(0);

    const result = JSON.parse(chk.stdout);
    expect(result.coverage.length).toBeGreaterThan(0);

    // AUTH-001 should be verified (has both impl and test).
    const req7f3a = result.coverage.find((c: any) => c.reqId === "AUTH-001");
    expect(req7f3a).toEqual(expect.objectContaining({ status: "verified" }));

    cleanup();
  });

  it("should show COVERAGE in text output after reconcile", { timeout: 30000 }, () => {
    cleanup();

    const rec = run(["reconcile"]);
    expect(rec.exitCode).toBe(0);

    const chk = run(["check"]);
    expect(chk.exitCode).toBe(0);
    expect(chk.stdout).toContain("COVERAGE:");

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
describe("CLI: init", () => {
  let initTmp: string;

  function runInit(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execFileSync("node", [CLI, "init", ...args], {
        encoding: "utf-8",
        cwd: initTmp,
        timeout: 30000,
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (e: any) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
    }
  }

  beforeEach(() => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    initTmp = mkdtempSync(join(tmpdir(), "spectrace-cli-init-"));
    mkdirSync(join(initTmp, "src"));
    writeFileSync(join(initTmp, "src", "app.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    const { rmSync } = require("node:fs");
    rmSync(initTmp, { recursive: true, force: true });
  });

  it("should create .spectrace.json and .trace.lock", { timeout: 30000 }, () => {
    const { exitCode, stdout } = runInit([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .spectrace.json");
    expect(stdout).toContain("Created .trace.lock");
    expect(stdout).toContain("Nodes:");
  });

  it("should output JSON with --format json", { timeout: 30000 }, () => {
    const { exitCode, stdout } = runInit(["--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.configPath).toBeDefined();
    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary.nodeCount).toBeGreaterThanOrEqual(0);
    expect(result.warnings).toBeDefined();
  });

  it("should fail when .spectrace.json already exists", { timeout: 30000 }, () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(initTmp, ".spectrace.json"), "{}\n");

    const { exitCode, stderr } = runInit([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("should succeed with --force when .spectrace.json exists", { timeout: 30000 }, () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(initTmp, ".spectrace.json"), "{}\n");

    const { exitCode, stdout } = runInit(["--force"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .spectrace.json");
  });

  it("should skip scan with --no-scan", { timeout: 30000 }, () => {
    const { exitCode, stdout } = runInit(["--no-scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("scan skipped");
    expect(stdout).not.toContain("Nodes:");
  });
});

// ---------------------------------------------------------------------------
// error cases
// ---------------------------------------------------------------------------
describe("CLI: error cases", () => {
  it("should show usage info when no command is given", { timeout: 30000 }, () => {
    const { stderr, exitCode } = run([]);
    // Commander exits 1 and prints usage info to stderr when no command is provided.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  it("should fail for unknown command", { timeout: 30000 }, () => {
    const { exitCode, stderr } = run(["foobar"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command");
  });

  it("should show version with --version", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should show help with --help", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("impact");
    expect(stdout).toContain("check");
    expect(stdout).toContain("reconcile");
  });
});

// ---------------------------------------------------------------------------
// symbol mode
// ---------------------------------------------------------------------------
const SYM_FIXTURE = resolve(import.meta.dirname, "fixtures/symbol-level");
const SYM_LOCK_PATH = resolve(SYM_FIXTURE, ".trace.lock");

function runSym(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd: SYM_FIXTURE,
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("CLI: symbol mode", () => {
  afterEach(() => {
    if (existsSync(SYM_LOCK_PATH)) unlinkSync(SYM_LOCK_PATH);
  });

  it("should show symbol count with --mode symbol", { timeout: 30000 }, () => {
    const { stdout, exitCode } = runSym(["scan", "--mode", "symbol"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("symbol:");
  });

  it("should not show symbol count in file mode", { timeout: 30000 }, () => {
    const { stdout, exitCode } = runSym(["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("symbol:");
  });

  it("should include symbolCount in JSON output", { timeout: 30000 }, () => {
    const { stdout, exitCode } = runSym(["scan", "--mode", "symbol", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.symbolCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// hook-pretool
// ---------------------------------------------------------------------------

function createSpectraceConfig() {
  writeFileSync(
    SPECTRACE_CONFIG_PATH,
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );
}

function cleanupConfig() {
  if (existsSync(SPECTRACE_CONFIG_PATH)) unlinkSync(SPECTRACE_CONFIG_PATH);
}

describe("CLI: hook-pretool", () => {
  afterEach(cleanupConfig);

  it("should output valid hookSpecificOutput for Edit input", { timeout: 30000 }, () => {
    createSpectraceConfig();
    const stdin = readFileSync(resolve(HOOKS_DIR, "edit-input.json"), "utf-8");
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toBe("spectrace impact: (none)");
  });

  it("should output valid hookSpecificOutput for Write input", { timeout: 30000 }, () => {
    createSpectraceConfig();
    const stdin = readFileSync(resolve(HOOKS_DIR, "write-input.json"), "utf-8");
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toBe("spectrace impact: (none)");
  });

  it("should output valid hookSpecificOutput for MultiEdit input", { timeout: 30000 }, () => {
    createSpectraceConfig();
    const stdin = readFileSync(resolve(HOOKS_DIR, "multiedit-input.json"), "utf-8");
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toBe("spectrace impact: (none)");
  });

  it("should include impact info for a tracked file", { timeout: 30000 }, () => {
    createSpectraceConfig();
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/auth/login.ts", old_string: "x", new_string: "y" },
    });
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain("spectrace impact:");
    expect(output.hookSpecificOutput.additionalContext).toContain("AUTH-001");
  });

  it("should output (none) for an untracked file like README.md", { timeout: 30000 }, () => {
    createSpectraceConfig();
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "README.md", old_string: "x", new_string: "y" },
    });
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.additionalContext).toBe("spectrace impact: (none)");
  });
});

// ---------------------------------------------------------------------------
// hook-pretool: graceful degradation
// ---------------------------------------------------------------------------
describe("CLI: hook-pretool graceful degradation", () => {
  it(
    "should exit 0 with empty additionalContext when .spectrace.json is missing",
    { timeout: 30000 },
    () => {
      const stdin = readFileSync(resolve(HOOKS_DIR, "edit-input.json"), "utf-8");
      const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin, "/tmp");
      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.hookSpecificOutput.additionalContext).toBe("");
    },
  );

  it("should exit 0 with empty additionalContext for invalid JSON", { timeout: 30000 }, () => {
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], "{not valid json}");
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.additionalContext).toBe("");
  });

  it(
    "should exit 0 with empty additionalContext when file_path is missing",
    { timeout: 30000 },
    () => {
      const stdin = JSON.stringify({ tool_name: "Edit", tool_input: {} });
      const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.hookSpecificOutput.additionalContext).toBe("");
    },
  );

  it(
    "should exit 0 with empty additionalContext when scan fails (broken config)",
    { timeout: 30000 },
    () => {
      // Write a .spectrace.json with invalid specDirs to trigger scan failure
      writeFileSync(
        resolve("/tmp", ".spectrace.json"),
        JSON.stringify({
          include: ["/nonexistent/**/*.ts"],
          specDirs: ["/nonexistent/specs"],
          testPatterns: [],
          lockFile: ".trace.lock",
        }),
      );
      try {
        const stdin = JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: "src/foo.ts", old_string: "x", new_string: "y" },
        });
        const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin, "/tmp");
        expect(exitCode).toBe(0);
        const output = JSON.parse(stdout);
        // Should either be empty or (none) — not crash
        expect(typeof output.hookSpecificOutput.additionalContext).toBe("string");
      } finally {
        if (existsSync(resolve("/tmp", ".spectrace.json"))) {
          unlinkSync(resolve("/tmp", ".spectrace.json"));
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// hook-pretool: stderr content verification
// ---------------------------------------------------------------------------
describe("CLI: hook-pretool stderr", () => {
  afterEach(cleanupConfig);

  it("should output 'failed to parse hook input' to stderr for invalid JSON", { timeout: 30000 }, () => {
    const { stderr, exitCode } = runWithStdin(["hook-pretool"], "{not valid json}");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("spectrace: failed to parse hook input");
  });

  it("should output 'completed in' to stderr on successful run", { timeout: 30000 }, () => {
    createSpectraceConfig();
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/auth/login.ts", old_string: "x", new_string: "y" },
    });
    const { stderr, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("spectrace: hook-pretool completed in");
  });
});
