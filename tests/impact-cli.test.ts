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

  // UX-1: REQ_ID_INPUT_RE used to be `/^[A-Z]+-\d+$/` which only matches
  // `REQ-001` / `FR-032`. README documents three more shapes as valid REQ-IDs
  // (Pascal-case `Requirement-3`, scoped `auth/FR-2`, dotted `REQ-1.2`).
  // Without the widened regex these slipped past the early reject and the
  // user got the generic "No matching nodes found" error instead of the
  // 4-path migration hint.
  it.each([
    ["REQ-001", "all-uppercase REQ-ID"],
    ["AUTH-1", "uppercase prefix + small numeric tail"],
    ["FR-32", "FR-style REQ-ID"],
    ["Requirement-3", "Pascal-case Kiro-style prefix"],
    ["auth/FR-2", "scoped prefix"],
    ["AUTH-1.2", "dotted numeric tail"],
  ])(
    "rejects %s as a REQ-ID input (UX-1: broadened regex — %s)",
    async (input, _label) => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact", input]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REQ-ID");
      expect(stderr).toContain("--from-tasks");
      expect(stderr).toContain("--from-plan");
      expect(stderr).toContain("--diff");
    },
  );

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

  // TEST-4: previously only positional + --from-tasks was tested. The full
  // forbidden pairs (C(4,2)=6) must all hard-error so a future regression on
  // any single channel is caught here. `--diff` doesn't need a real file on
  // disk; the other two channels do (--from-tasks / --from-plan call
  // existsSync before opening), so we materialize a tasks.md / plan.md.
  describe("rejects mutually exclusive start sources (TEST-4: all forbidden pairs)", () => {
    let tmpRoot: string;
    let tasksPath: string;
    let planPath: string;
    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-impact-mex-"));
      tasksPath = join(tmpRoot, "tasks.md");
      planPath = join(tmpRoot, "plan.md");
      writeFileSync(tasksPath, "Files: src/auth/login.ts\n");
      writeFileSync(planPath, "Files: src/auth/login.ts\n");
    });
    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("positional + --from-tasks", async () => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "src/auth/login.ts",
        "--from-tasks",
        tasksPath,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    });

    it("positional + --from-plan", async () => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "src/auth/login.ts",
        "--from-plan",
        planPath,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    });

    it("positional + --diff", async () => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "src/auth/login.ts",
        "--diff",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    });

    it("--from-tasks + --from-plan", async () => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "--from-tasks",
        tasksPath,
        "--from-plan",
        planPath,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    });

    it("--from-tasks + --diff", async () => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "--from-tasks",
        tasksPath,
        "--diff",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    });

    it("--from-plan + --diff", async () => {
      const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
        "impact",
        "--from-plan",
        planPath,
        "--diff",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
    });
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

  // TEST-3: regression guard against over-propagation at depth=1.
  //
  // Background: bidirectional BFS (src/graph/traverse.ts:5-11) intentionally
  // walks `req → doc → sibling reqs`, so AUTH-003 *is* reachable from
  // login.ts at the default unlimited depth — that's documented behavior.
  // The interesting "is the immediate impact correct?" check is at depth=1:
  // only direct @impl edges out of the seed file should appear. If the BFS
  // accidentally widens (e.g. starts treating file→file imports as zero-cost,
  // or follows doc-contains in the same hop) AUTH-003 will leak in here.
  it("Stage A: depth=1 narrows impact to direct @impl targets only (TEST-3)", async () => {
    const tasksPath = join(root, "tasks.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "### T001: tweak login (depth-bounded)",
        "",
        "Files: src/auth/login.ts",
        "",
      ].join("\n"),
    );

    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "--from-tasks",
      tasksPath,
      "--depth",
      "1",
      "--format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // login.ts @impl AUTH-001 — direct, depth=1 reaches this.
    expect(result.affectedReqs).toContain("AUTH-001");
    // AUTH-003 lives in tests/fixtures/specs/auth.md but is annotated on
    // *no* file that login.ts directly affects. Reaching AUTH-003 here
    // would mean the BFS leaked through the doc contains edge in a single
    // hop — that's the over-propagation we're guarding against.
    expect(result.affectedReqs).not.toContain("AUTH-003");
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

  // TEST-3 (mirrored from --from-tasks): depth=1 over-propagation guard.
  // See the matching test under "CLI: impact --from-tasks" for the rationale.
  it("depth=1 narrows --from-plan impact to direct @impl targets only (TEST-3)", async () => {
    const planPath = join(root, "plan.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "Files: src/auth/login.ts, src/auth/session.ts",
        "",
      ].join("\n"),
    );

    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "--from-plan",
      planPath,
      "--depth",
      "1",
      "--format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
    expect(result.affectedReqs).toContain("AUTH-002");
    // AUTH-003 must not leak in through the doc contains edge at depth=1.
    expect(result.affectedReqs).not.toContain("AUTH-003");
  });
});

// ---------------------------------------------------------------------------
// SPEC-2 — diagnostics surfaced as warnings from --from-tasks / --from-plan
// ---------------------------------------------------------------------------
//
// Previously the impact CLI dropped extractFiles().diagnostics entirely, so a
// tasks.md with `Files: src/auht.ts` (typo) silently fell through to the
// "no files extracted" path or — worse — a valid-looking but wrong file.
// Now every unresolvedFilePath diagnostic surfaces as a WARNING on stderr so
// the user sees the typo before relying on the (possibly empty / incorrect)
// impact result.

describe("CLI: impact --from-tasks emits diagnostics as warnings (SPEC-2)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSpecKitProject();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("warns about typo'd Files: paths but still runs when other files extract", async () => {
    const tasksPath = join(root, "tasks.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "### T001: with a typo'd path",
        "",
        "Files: src/auth/login.ts, src/auht/login.ts",
        "",
      ].join("\n"),
    );

    const { stdout, stderr, exitCode } = await runAt(root, [
      "impact",
      "--from-tasks",
      tasksPath,
      "--format",
      "json",
    ]);

    // Warning must be visible on stderr.
    expect(stderr).toContain("WARNING");
    expect(stderr).toContain("src/auht/login.ts");

    // Run still succeeds because the well-formed path (src/auth/login.ts)
    // resolves into the start set.
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.affectedReqs).toContain("AUTH-001");
  });

  it("includes the source line number when Diagnostic.line is set", async () => {
    const tasksPath = join(root, "tasks.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks",
        "",
        "### T001: with a typo",
        "",
        "Files: src/auth/login.ts, src/auht.ts",
        "",
      ].join("\n"),
    );

    const { stderr } = await runAt(root, [
      "impact",
      "--from-tasks",
      tasksPath,
      "--format",
      "json",
    ]);

    // The `Files: ...` header is on line 5 (1-based) of the tasks.md above.
    expect(stderr).toMatch(/line \d+/);
    expect(stderr).toContain("src/auht.ts");
  });
});
