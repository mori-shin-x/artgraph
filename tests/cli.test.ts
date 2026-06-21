import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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
    const tmpRoot = mkdtempSync(join(tmpdir(), "spectrace-warn-"));
    mkdirSync(join(tmpRoot, "specs"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, ".spectrace.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
    writeFileSync(
      join(tmpRoot, "specs", "orphan.md"),
      `---\nspectrace:\n  node_id: "orphan-src"\n  derives_from:\n    - nonexistent-target\n---\n# Orphan\n`,
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
    const tmpRoot = mkdtempSync(join(tmpdir(), "spectrace-warn-"));
    mkdirSync(join(tmpRoot, "specs"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, ".spectrace.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
    writeFileSync(
      join(tmpRoot, "specs", "invalid.md"),
      `---\nspectrace:\n  node_id: "inv-src"\n  extends:\n    - some-doc\n---\n# Invalid\n`,
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
