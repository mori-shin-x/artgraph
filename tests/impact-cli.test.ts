// spec 014 — Phase 3 (US2) tests for `artgraph impact` file-only redesign.
// Mirrors the contract in `specs/014-reinvent-impact-cli/contracts/cli-flags.md`
// and FR-001 〜 FR-008 in `specs/014-reinvent-impact-cli/spec.md`.
//
// T004 — REQ-ID rejection / doc: prefix rejection / no-target / mutually
// exclusive sources / existing file path still works.
// T005 — `--from-tasks` and `--from-plan` end-to-end (Stage A + Stage B fallback).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runAt, FIXTURE_DIR } from "./helpers.js";

// ---------------------------------------------------------------------------
// T004 — flag-surface / input validation
// ---------------------------------------------------------------------------

describe("CLI: impact — file-only target validation (T004 / FR-001, FR-003)", () => {
  it("rejects REQ-ID positional input with the 4-path navigational error (exit 1)", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact", "AUTH-001"]);
    expect(exitCode).toBe(1);
    // 4 start sources must all be named so the user can pick the right one.
    expect(stderr).toContain("REQ-ID");
    expect(stderr).toContain("--from-tasks");
    expect(stderr).toContain("--from-plan");
    expect(stderr).toContain("--diff");
    // File-path guidance line: contract uses "<file>..." in the suggestion.
    expect(stderr).toMatch(/<file>|file path/i);
  });

  it("rejects `doc:` prefix positional input (FR-001 / FR-002)", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact", "doc:auth-design"]);
    expect(exitCode).toBe(1);
    // doc: prefix should hit the same 4-path navigational error so the
    // user sees the same set of supported start sources.
    expect(stderr).toContain("--from-tasks");
    expect(stderr).toContain("--from-plan");
    expect(stderr).toContain("--diff");
  });

  it("accepts an existing file path as positional input", async () => {
    const { stdout, exitCode } = await runAt(FIXTURE_DIR, [
      "impact",
      "src/auth/login.ts",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("rejects mutually exclusive start sources (positional + --from-tasks)", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-impact-mex-"));
    try {
      const tasksPath = join(tmpRoot, "tasks.md");
      writeFileSync(tasksPath, "Files: src/auth/login.ts\n");
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "src/auth/login.ts",
        "--from-tasks",
        tasksPath,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects when no start source is given (no targets, no --from-*, no --diff)", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no.*target|no start source/i);
  });
});

// ---------------------------------------------------------------------------
// T005 — --from-tasks / --from-plan end-to-end
// ---------------------------------------------------------------------------
//
// The impact CLI scans the working directory's graph, so we materialize a
// throwaway project that mirrors the auth fixture (plus a tasks.md/plan.md
// pointing at it) and run from there. Cheaper than touching the shared
// fixture tree.

function setupSpecKitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "artgraph-impact-from-"));
  // Copy the canonical auth fixture so the graph has src/auth/login.ts,
  // src/auth/session.ts, and the AUTH-* requirements.
  cpSync(join(FIXTURE_DIR, "src"), join(root, "src"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "specs"), join(root, "specs"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "tests"), join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );
  return root;
}

describe("CLI: impact --from-tasks (T005 / FR-004)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSpecKitProject();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Stage A: extracts files from a `Files:` section and feeds impact()", async () => {
    const tasksPath = join(root, "tasks.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "### T001: tweak login",
        "",
        "Files: src/auth/login.ts",
        "",
      ].join("\n"),
    );

    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "--from-tasks",
      tasksPath,
      "--format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // login.ts @impl AUTH-001 → AUTH-001 must surface in affectedReqs.
    expect(result.affectedReqs).toContain("AUTH-001");
    // The seed file itself stays in affectedFiles.
    expect(result.affectedFiles).toContain("src/auth/login.ts");
  });

  it("Stage B: regex fallback discovers file paths in free text", async () => {
    const tasksPath = join(root, "tasks.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "### T002: rework session",
        "",
        "We will need to update src/auth/session.ts to fix the refresh bug.",
        "",
      ].join("\n"),
    );

    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "--from-tasks",
      tasksPath,
      "--format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // session.ts @impl AUTH-001 AUTH-002 → both must surface.
    expect(result.affectedReqs).toContain("AUTH-001");
    expect(result.affectedReqs).toContain("AUTH-002");
    expect(result.affectedFiles).toContain("src/auth/session.ts");
  });

  it("fails (exit 1) when neither Stage A nor Stage B extract anything", async () => {
    const tasksPath = join(root, "tasks.md");
    writeFileSync(tasksPath, "# Tasks\n\nNo file references here at all.\n");

    const { exitCode, stderr } = await runAt(root, [
      "impact",
      "--from-tasks",
      tasksPath,
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no files|extract|files: section/i);
  });
});

describe("CLI: impact --from-plan (T005 / FR-006)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSpecKitProject();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the same two-stage extraction as --from-tasks", async () => {
    const planPath = join(root, "plan.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "## Files in scope",
        "",
        "Files: src/auth/login.ts, src/auth/session.ts",
        "",
      ].join("\n"),
    );

    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "--from-plan",
      planPath,
      "--format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
    expect(result.affectedReqs).toContain("AUTH-002");
    expect(result.affectedFiles).toEqual(
      expect.arrayContaining(["src/auth/login.ts", "src/auth/session.ts"]),
    );
  });
});
