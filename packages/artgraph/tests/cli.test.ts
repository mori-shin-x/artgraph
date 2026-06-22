import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { run, cleanup, CLI, FIXTURE_DIR, LOCK_PATH } from "./helpers.js";

const HOOKS_DIR = resolve(import.meta.dirname, "fixtures/hooks");

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
// graph
// ---------------------------------------------------------------------------
describe("CLI: graph", () => {
  it("T054: should output text format by default", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["graph"]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("T054b: should output JSON format with --format json", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["graph", "--format", "json"]);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.nodes).toBeDefined();
    expect(parsed.edges).toBeDefined();
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
  });

  it("T054c: should filter by --kind doc", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["graph", "--format", "json", "--kind", "doc"]);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout);
    for (const node of parsed.nodes) {
      expect(node.kind).toBe("doc");
    }
  });
});

// ---------------------------------------------------------------------------
// impact --depth
// ---------------------------------------------------------------------------
describe("CLI: impact --depth", () => {
  it("T058: should accept --depth option", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["impact", "AUTH-001", "--depth", "1", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("T059: should show summary in text output", { timeout: 30000 }, () => {
    const { stdout, exitCode } = run(["impact", "AUTH-001"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Summary:");
    expect(stdout).toMatch(/\d+ docs/);
    expect(stdout).toMatch(/\d+ reqs/);
    expect(stdout).toMatch(/\d+ files/);
  });
});

// ---------------------------------------------------------------------------
// impact --depth validation
// ---------------------------------------------------------------------------
describe("CLI: impact --depth validation", () => {
  it("should error on NaN --depth value", { timeout: 30000 }, () => {
    const { exitCode, stderr } = run(["impact", "AUTH-001", "--depth", "abc"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid --depth value");
  });

  it("should error on negative --depth value", { timeout: 30000 }, () => {
    const { exitCode, stderr } = run(["impact", "AUTH-001", "--depth", "-1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid --depth value");
  });
});

// ---------------------------------------------------------------------------
// graph --kind validation
// ---------------------------------------------------------------------------
describe("CLI: graph --kind validation", () => {
  it("should error on invalid --kind value", { timeout: 30000 }, () => {
    const { exitCode, stderr } = run(["graph", "--kind", "invalid"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/allowed choices|invalid/i);
  });
});

// ---------------------------------------------------------------------------
// impact: 3-stage dependency chain E2E
// ---------------------------------------------------------------------------
describe("CLI: impact 3-stage dependency chain", () => {
  it("should trace through full doc derives_from chain", { timeout: 30000 }, () => {
    // requirements -> design -> tasks (via derives_from chain in doc-chain fixtures)
    // Starting from "requirements" should reach the whole chain including tasks
    const { stdout, exitCode } = run(["impact", "requirements", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedDocs).toContain("requirements");
    expect(result.affectedDocs).toContain("design");
    // tasks.md (auto-generated doc ID) should also be reached via design -> tasks chain
    const hasTasksDoc = result.affectedDocs.some((d: string) => d.includes("tasks"));
    expect(hasTasksDoc).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// impact: contains reverse + --depth limit
// ---------------------------------------------------------------------------
describe("CLI: impact contains reverse + --depth limit", () => {
  it("should reach req from doc via contains within depth limit", { timeout: 30000 }, () => {
    // doc:auth-design --contains--> AUTH-001
    // With depth=1, starting from doc:auth-design should reach AUTH-001
    const { stdout, exitCode } = run([
      "impact",
      "doc:auth-design",
      "--depth",
      "1",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("should not reach impl files from doc with --depth 1", { timeout: 30000 }, () => {
    // doc:auth-design --contains(depth1)--> AUTH-001 --implements(depth2)--> file:src/auth/login.ts
    // With depth=1, should NOT reach the implementation files (they are at depth 2)
    const { stdout, exitCode } = run([
      "impact",
      "doc:auth-design",
      "--depth",
      "1",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.affectedFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLI warnings (orphan-doc, invalid-relation)
// ---------------------------------------------------------------------------
describe("CLI: warning output", () => {
  it("should output orphan-doc warning to stderr", { timeout: 30000 }, () => {
    const { mkdirSync, writeFileSync, rmSync: rm } = require("node:fs");
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-warn-"));
    mkdirSync(join(tmpRoot, "specs"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
    writeFileSync(
      join(tmpRoot, "specs", "orphan.md"),
      `---\nartgraph:\n  node_id: "orphan-src"\n  derives_from:\n    - nonexistent-target\n---\n# Orphan\n`,
    );

    try {
      const proc = spawnSync("node", [CLI, "scan"], {
        encoding: "utf-8",
        cwd: tmpRoot,
        timeout: 30000,
      });
      expect(proc.status).toBe(0);
      expect(proc.stderr).toContain("orphan-doc");
      expect(proc.stderr).toContain("nonexistent-target");
    } finally {
      rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("should output invalid-relation warning to stderr", { timeout: 30000 }, () => {
    const { mkdirSync, writeFileSync, rmSync: rm } = require("node:fs");
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-warn-"));
    mkdirSync(join(tmpRoot, "specs"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
    writeFileSync(
      join(tmpRoot, "specs", "invalid.md"),
      `---\nartgraph:\n  node_id: "inv-src"\n  extends:\n    - some-doc\n---\n# Invalid\n`,
    );

    try {
      const proc = spawnSync("node", [CLI, "scan"], {
        encoding: "utf-8",
        cwd: tmpRoot,
        timeout: 30000,
      });
      expect(proc.status).toBe(0);
      expect(proc.stderr).toContain("invalid relation");
      expect(proc.stderr).toContain("extends");
    } finally {
      rm(tmpRoot, { recursive: true, force: true });
    }
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
    initTmp = mkdtempSync(join(tmpdir(), "artgraph-cli-init-"));
    mkdirSync(join(initTmp, "src"));
    writeFileSync(join(initTmp, "src", "app.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    const { rmSync } = require("node:fs");
    rmSync(initTmp, { recursive: true, force: true });
  });

  it("should create .artgraph.json and .trace.lock", { timeout: 30000 }, () => {
    const { exitCode, stdout } = runInit([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .artgraph.json");
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

  it("should fail when .artgraph.json already exists", { timeout: 30000 }, () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(initTmp, ".artgraph.json"), "{}\n");

    const { exitCode, stderr } = runInit([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("should succeed with --force when .artgraph.json exists", { timeout: 30000 }, () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(initTmp, ".artgraph.json"), "{}\n");

    const { exitCode, stdout } = runInit(["--force"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .artgraph.json");
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
    expect(stdout).toContain("graph");
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
// test-results integration
// ---------------------------------------------------------------------------
const TEST_RESULTS_DIR = resolve(import.meta.dirname, "fixtures/test-results");
const ALL_VERIFIED_DIR = resolve(import.meta.dirname, "fixtures/all-verified");
const ALL_VERIFIED_LOCK = resolve(ALL_VERIFIED_DIR, ".trace.lock");

function runAllVerified(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd: ALL_VERIFIED_DIR,
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("CLI: test-results integration", () => {
  afterEach(() => {
    if (existsSync(ALL_VERIFIED_LOCK)) unlinkSync(ALL_VERIFIED_LOCK);
  });

  it("should accept --test-results option on check command without crash", { timeout: 30000 }, () => {
    const vitestPath = resolve(TEST_RESULTS_DIR, "vitest-pass.json");
    const { exitCode } = runAllVerified(["check", "--test-results", vitestPath]);
    // Without --gate, check always exits 0 even with issues
    expect(exitCode).toBe(0);
  });

  it("should accept --test-results option on coverage command without crash", { timeout: 30000 }, () => {
    const vitestPath = resolve(TEST_RESULTS_DIR, "vitest-pass.json");
    const { exitCode } = runAllVerified(["coverage", "--test-results", vitestPath]);
    expect(exitCode).toBe(0);
  });

  it("should accept --test-results option on scan command without crash", { timeout: 30000 }, () => {
    const vitestPath = resolve(TEST_RESULTS_DIR, "vitest-pass.json");
    const { exitCode } = runAllVerified(["scan", "--test-results", vitestPath]);
    expect(exitCode).toBe(0);
  });

  it("should include testResultStats in scan JSON output", { timeout: 30000 }, () => {
    const vitestPath = resolve(TEST_RESULTS_DIR, "vitest-mixed.json");
    const { stdout, exitCode } = runAllVerified(["scan", "--format", "json", "--test-results", vitestPath]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.testResultStats).toBeDefined();
    expect(result.testResultStats.totalTests).toBe(2);
    expect(result.testResultStats.passedTests).toBe(1);
    expect(result.testResultStats.failedTests).toBe(1);
  });

  it("should show test result stats in scan text output", { timeout: 30000 }, () => {
    const vitestPath = resolve(TEST_RESULTS_DIR, "vitest-mixed.json");
    const { stdout, exitCode } = runAllVerified(["scan", "--test-results", vitestPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Results:");
    expect(stdout).toContain("passed=1");
    expect(stdout).toContain("failed=1");
  });

  it("should report all REQs verified without --test-results (legacy)", { timeout: 30000 }, () => {
    const { stdout } = runAllVerified(["coverage", "--format", "json"]);
    const cov = JSON.parse(stdout);
    const byId = Object.fromEntries(cov.items.map((i: any) => [i.reqId, i.status]));
    expect(byId["VER-001"]).toBe("verified");
    expect(byId["VER-002"]).toBe("verified");
  });

  it("should keep status verified when --test-results show all passing", { timeout: 30000 }, () => {
    const passPath = resolve(TEST_RESULTS_DIR, "all-verified-pass.json");
    const { stdout } = runAllVerified(["coverage", "--format", "json", "--test-results", passPath]);
    const cov = JSON.parse(stdout);
    const byId = Object.fromEntries(cov.items.map((i: any) => [i.reqId, i.status]));
    expect(byId["VER-001"]).toBe("verified");
    expect(byId["VER-002"]).toBe("verified");
  });

  it("should downgrade a REQ to impl-only when its test fails (verified -> impl-only)", { timeout: 30000 }, () => {
    const failPath = resolve(TEST_RESULTS_DIR, "all-verified-fail.json");
    const { stdout } = runAllVerified(["coverage", "--format", "json", "--test-results", failPath]);
    const cov = JSON.parse(stdout);
    const byId = Object.fromEntries(cov.items.map((i: any) => [i.reqId, i.status]));
    // VER-001's test failed -> must transition away from "verified".
    expect(byId["VER-001"]).toBe("impl-only");
    // VER-002's test still passes -> stays verified.
    expect(byId["VER-002"]).toBe("verified");
  });

  it("should pass check --gate when all tests pass", { timeout: 30000 }, () => {
    const passPath = resolve(TEST_RESULTS_DIR, "all-verified-pass.json");
    const { exitCode } = runAllVerified(["check", "--gate", "--test-results", passPath]);
    expect(exitCode).toBe(0);
  });

  it("should fail check --gate (exit 2) when a test fails", { timeout: 30000 }, () => {
    const failPath = resolve(TEST_RESULTS_DIR, "all-verified-fail.json");
    const { stdout, exitCode } = runAllVerified(["check", "--gate", "--test-results", failPath]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("TEST FAILURES:");
    expect(stdout).toContain("VER-001");
  });

  it("should not fail check --gate for test failures when --test-results is absent", { timeout: 30000 }, () => {
    // Legacy: without test results the gate ignores pass/fail entirely.
    const { exitCode } = runAllVerified(["check", "--gate"]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hook-pretool
// ---------------------------------------------------------------------------

describe("CLI: hook-pretool", () => {
  it("should output valid hookSpecificOutput for Edit input", { timeout: 30000 }, () => {
    const stdin = readFileSync(resolve(HOOKS_DIR, "edit-input.json"), "utf-8");
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toBe("artgraph impact: (none)");
  });

  it("should output valid hookSpecificOutput for Write input", { timeout: 30000 }, () => {
    const stdin = readFileSync(resolve(HOOKS_DIR, "write-input.json"), "utf-8");
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toBe("artgraph impact: (none)");
  });

  it("should output valid hookSpecificOutput for MultiEdit input", { timeout: 30000 }, () => {
    const stdin = readFileSync(resolve(HOOKS_DIR, "multiedit-input.json"), "utf-8");
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput.additionalContext).toBe("artgraph impact: (none)");
  });

  it("should include impact info for a tracked file", { timeout: 30000 }, () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/auth/login.ts", old_string: "x", new_string: "y" },
    });
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain("artgraph impact:");
    expect(output.hookSpecificOutput.additionalContext).toContain("AUTH-001");
  });

  it("should output (none) for an untracked file like README.md", { timeout: 30000 }, () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "README.md", old_string: "x", new_string: "y" },
    });
    const { stdout, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.additionalContext).toBe("artgraph impact: (none)");
  });
});

// ---------------------------------------------------------------------------
// hook-pretool: graceful degradation
// ---------------------------------------------------------------------------
describe("CLI: hook-pretool graceful degradation", () => {
  it(
    "should exit 0 with empty additionalContext when .artgraph.json is missing",
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
      // Write a .artgraph.json with invalid specDirs to trigger scan failure
      writeFileSync(
        resolve("/tmp", ".artgraph.json"),
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
        if (existsSync(resolve("/tmp", ".artgraph.json"))) {
          unlinkSync(resolve("/tmp", ".artgraph.json"));
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// hook-pretool: stderr content verification
// ---------------------------------------------------------------------------
describe("CLI: hook-pretool stderr", () => {
  it("should output 'failed to parse hook input' to stderr for invalid JSON", { timeout: 30000 }, () => {
    const { stderr, exitCode } = runWithStdin(["hook-pretool"], "{not valid json}");
    expect(exitCode).toBe(0);
    expect(stderr).toContain("artgraph: failed to parse hook input");
  });

  it("should output 'completed in' to stderr on successful run", { timeout: 30000 }, () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/auth/login.ts", old_string: "x", new_string: "y" },
    });
    const { stderr, exitCode } = runWithStdin(["hook-pretool"], stdin);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("artgraph: hook-pretool completed in");
  });
});
