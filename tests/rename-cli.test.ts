import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { CLI } from "./helpers.js";

const RENAME_FIXTURE = resolve(import.meta.dirname, "fixtures/rename");

/** Temp dirs created during tests — cleaned up in afterEach. */
const tempDirs: string[] = [];

/**
 * Copy the rename fixture into a fresh temp directory,
 * seed a .spectrace.json, generate .trace.lock via reconcile,
 * and initialise a git repo so `git ls-files` works.
 */
function prepareTempDir(): string {
  const tmp = mkdtempSync(resolve(tmpdir(), "spectrace-rename-cli-"));
  tempDirs.push(tmp);

  // Copy fixture files
  cpSync(RENAME_FIXTURE, tmp, { recursive: true });

  // Create .spectrace.json
  writeFileSync(
    resolve(tmp, ".spectrace.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );

  // Initialise git repo so git ls-files works
  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: tmp, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
    { cwd: tmp, stdio: "pipe" },
  );

  // Generate .trace.lock via reconcile
  execFileSync("node", [CLI, "reconcile"], {
    cwd: tmp,
    encoding: "utf-8",
    timeout: 30000,
  });

  // Commit the lock file so it is tracked
  execFileSync("git", ["add", ".trace.lock"], { cwd: tmp, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "add lock"],
    { cwd: tmp, stdio: "pipe" },
  );

  return tmp;
}

function runCli(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd,
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------
describe("CLI: rename --from/--to", () => {
  it("should rename REQ-001 to REQ-100 across all files", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    const { exitCode } = runCli(["rename", "--from", "REQ-001", "--to", "REQ-100"], tmp);
    expect(exitCode).toBe(0);

    // specs/feature.md: list item rewritten
    const spec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
    expect(spec).toContain("REQ-100: ユーザー認証");
    expect(spec).not.toMatch(/^- REQ-001:/m);

    // src/feature.ts: @impl tags rewritten
    const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    expect(src).toContain("@impl REQ-100");
    expect(src).not.toContain("@impl REQ-001");

    // tests/feature.test.ts: test tags rewritten
    const test = readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8");
    expect(test).toContain("[REQ-100]");
    expect(test).not.toContain("[REQ-001]");

    // .trace.lock: key renamed, dependsOn updated
    const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(lock["REQ-100"]).toBeDefined();
    expect(lock["REQ-001"]).toBeUndefined();

    // FR-007: normal sentence mention should NOT be changed
    expect(spec).toContain("REQ-001 は認証基盤の中核要件として");
  });

  it("should not modify files when --dry-run is used", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    // Snapshot originals
    const origSpec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
    const origSrc = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    const origTest = readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8");
    const origLock = readFileSync(resolve(tmp, ".trace.lock"), "utf-8");

    const { exitCode, stdout } = runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-100", "--dry-run"],
      tmp,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dry-run");

    // All files must remain unchanged
    expect(readFileSync(resolve(tmp, "specs/feature.md"), "utf-8")).toBe(origSpec);
    expect(readFileSync(resolve(tmp, "src/feature.ts"), "utf-8")).toBe(origSrc);
    expect(readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8")).toBe(origTest);
    expect(readFileSync(resolve(tmp, ".trace.lock"), "utf-8")).toBe(origLock);
  });

  it("should output valid JSON with --format json", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    const { exitCode, stdout } = runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-100", "--format", "json"],
      tmp,
    );
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.operation).toBe("rename");
    expect(result.changes).toBeDefined();
    expect(Array.isArray(result.changes)).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.applied).toBe(true);
  });

  it("should fail when source ID does not exist", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    const { exitCode, stderr } = runCli(
      ["rename", "--from", "NONEXISTENT", "--to", "REQ-100"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NONEXISTENT");
  });

  it("should fail when target ID already exists", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    const { exitCode, stderr } = runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-002"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("REQ-002");
  });
});

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------
describe("CLI: rename --split/--into", () => {
  it("should split REQ-001 into REQ-001a and REQ-001b", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    const { exitCode, stdout, stderr } = runCli(
      ["rename", "--split", "REQ-001", "--into", "REQ-001a", "REQ-001b"],
      tmp,
    );
    expect(exitCode).toBe(0);

    // specs/feature.md: old list item removed, scaffolds appended
    const spec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
    expect(spec).not.toMatch(/^- REQ-001:/m);
    expect(spec).toContain("REQ-001a");
    expect(spec).toContain("REQ-001b");

    // src/feature.ts: @impl REQ-001 should NOT be rewritten (manual assignment needed)
    const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    expect(src).toContain("@impl REQ-001");

    // Warning about manual assignment in stdout or stderr
    const combined = stdout + stderr;
    expect(combined).toMatch(/manual.*assignment|WARNING/i);

    // .trace.lock: REQ-001 deleted, new IDs created
    const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(lock["REQ-001"]).toBeUndefined();
    expect(lock["REQ-001a"]).toBeDefined();
    expect(lock["REQ-001b"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------
describe("CLI: rename --merge/--into", () => {
  it("should merge REQ-001 and REQ-002 into REQ-COMBINED", { timeout: 30000 }, () => {
    const tmp = prepareTempDir();

    const { exitCode } = runCli(
      ["rename", "--merge", "REQ-001", "REQ-002", "--into", "REQ-COMBINED"],
      tmp,
    );
    expect(exitCode).toBe(0);

    // All references replaced with REQ-COMBINED
    const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    const test = readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8");

    // Source files should have REQ-COMBINED
    expect(src).toContain("@impl REQ-COMBINED");
    expect(test).toContain("[REQ-COMBINED]");

    // Old IDs should no longer appear in @impl or test tags
    expect(src).not.toContain("@impl REQ-001");
    expect(src).not.toContain("@impl REQ-002");

    // .trace.lock: old IDs deleted, REQ-COMBINED created
    const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(lock["REQ-001"]).toBeUndefined();
    expect(lock["REQ-002"]).toBeUndefined();
    expect(lock["REQ-COMBINED"]).toBeDefined();
  });
});
