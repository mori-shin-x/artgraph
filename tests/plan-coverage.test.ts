// spec 014 — Phase 4 (US1) tests for `runPlanCoverage`.
// Contracts:
//   - specs/014-reinvent-impact-cli/contracts/plan-coverage-json.md
//   - specs/014-reinvent-impact-cli/contracts/cli-flags.md
//   - specs/014-reinvent-impact-cli/contracts/mention-semantics.md
//
// Covers:
//   - by-sourceFile axis (`implicitImpacts`) and by-FR axis
//     (`implicitImpactsByReq`) both present, internally consistent
//   - mention subtraction (tasks/plan/spec text union)
//   - --ignore one-shot suppression
//   - --gate exit codes
//   - --require-files-section diagnostics
//   - text-format dual view ("By source file:" / "By requirement:")
//
// All tests materialise an isolated Spec Kit-style fixture so the graph
// covers REQ↔file mapping in a controlled way.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlanCoverage } from "../src/plan-coverage/index.js";

interface FixtureRoot {
  root: string;
  specDir: string;
  tasksPath: string;
  planPath: string;
}

// Spin up a temp repo with a small auth-style fixture. AUTH-001 is
// implemented by src/auth/login.ts AND src/auth/session.ts; AUTH-002 by
// src/auth/session.ts only; AUTH-003 by src/auth/logout.ts. tasks.md
// declares `Files: src/auth/login.ts` only — so the implicit blast from
// that file should be AUTH-001 (mentioned only if the user wrote it in
// tasks/plan/spec) and via the doc → other-req hops, AUTH-002 and AUTH-003.
function setupFixture(opts?: {
  tasksBody?: string;
  planBody?: string;
  /**
   * Body of the spec dir's own spec.md. Default has NO REQ mentions —
   * the REQs (AUTH-001/002/003) are defined in a separate spec file
   * (`specs/auth/design.md`) so they're known to the graph but absent
   * from the source set the mention detector scans for plan-coverage.
   * Override to inject mentions and prove implicit subtraction.
   */
  specBody?: string;
}): FixtureRoot {
  const root = mkdtempSync(join(tmpdir(), "artgraph-plan-coverage-"));
  const specDir = join(root, "specs/014-test");
  mkdirSync(specDir, { recursive: true });

  // The current spec dir's spec.md — intentionally generic. The REQs are
  // defined elsewhere so the mention detector for plan-coverage starts
  // from a clean slate (mirrors real flow: tasks.md for spec 014 may
  // touch a file that @impl REQs defined in spec 005).
  const specBody = opts?.specBody ?? [
    "# Spec 014 (test fixture)",
    "",
    "This is the spec being analysed; no REQ references on purpose.",
    "",
  ].join("\n");
  writeFileSync(join(specDir, "spec.md"), specBody);

  // External spec that owns the REQ definitions. The graph builder picks
  // it up because specDirs includes `specs/` recursively; plan-coverage
  // does NOT read it (only the current spec dir's spec.md / tasks.md /
  // plan.md feed the mention detector).
  const externalSpecDir = join(root, "specs/auth");
  mkdirSync(externalSpecDir, { recursive: true });
  writeFileSync(
    join(externalSpecDir, "design.md"),
    [
      "---",
      "artgraph:",
      "  node_id: \"doc:auth-design\"",
      "---",
      "",
      "# Auth Design",
      "",
      "## Requirements",
      "",
      "- AUTH-001: login",
      "- AUTH-002: session",
      "- AUTH-003: logout",
      "",
    ].join("\n"),
  );

  // Source files with @impl tags so the graph has implements edges.
  mkdirSync(join(root, "src/auth"), { recursive: true });
  writeFileSync(
    join(root, "src/auth/login.ts"),
    "// @impl AUTH-001\nexport function login() {}\n",
  );
  writeFileSync(
    join(root, "src/auth/session.ts"),
    "// @impl AUTH-001 AUTH-002\nexport function session() {}\n",
  );
  writeFileSync(
    join(root, "src/auth/logout.ts"),
    "// @impl AUTH-003\nexport function logout() {}\n",
  );

  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );

  const tasksBody = opts?.tasksBody ?? [
    "# Tasks",
    "",
    "### T001: tweak login",
    "",
    "Files: src/auth/login.ts",
    "",
  ].join("\n");
  const tasksPath = join(specDir, "tasks.md");
  writeFileSync(tasksPath, tasksBody);

  const planBody = opts?.planBody ?? [
    "# Plan",
    "",
    "Mostly the login flow.",
    "",
  ].join("\n");
  const planPath = join(specDir, "plan.md");
  writeFileSync(planPath, planBody);

  return { root, specDir, tasksPath, planPath };
}

describe("runPlanCoverage — by-sourceFile + by-FR dual axis", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("emits implicitImpacts (by-sourceFile) and implicitImpactsByReq (by-FR) together", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.exitCode).toBe(0);

    expect(result.json.implicitImpacts).toBeDefined();
    expect(result.json.implicitImpactsByReq).toBeDefined();

    // Login.ts brings AUTH-001 + (via doc:auth-design containment) AUTH-002
    // and AUTH-003. None are mentioned in tasks/plan/spec text → all implicit.
    const reqIds = new Set<string>();
    for (const group of result.json.implicitImpacts) {
      for (const req of group.reqs) reqIds.add(req.reqId);
    }
    expect(reqIds.has("AUTH-001")).toBe(true);
    expect(reqIds.has("AUTH-002")).toBe(true);
    expect(reqIds.has("AUTH-003")).toBe(true);

    // by-FR axis is the inversion of the by-sourceFile axis.
    const byReqIds = result.json.implicitImpactsByReq.map((r) => r.reqId);
    // Invariants: same set of REQs as the by-sourceFile axis.
    expect(new Set(byReqIds)).toEqual(reqIds);
    // summary.implicit equals implicitImpactsByReq.length (unique count).
    expect(result.json.summary.implicit).toBe(byReqIds.length);
    // Lexicographic ascending for byReqIds.
    expect(byReqIds).toEqual([...byReqIds].sort());
  });

  it("invariant: each implicitImpactsByReq[i].sourceFiles covers all by-sourceFile groups containing that reqId", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: tweak login",
        "",
        "Files: src/auth/login.ts, src/auth/session.ts",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    // AUTH-001 should show up under at least both login.ts and session.ts
    // (both files @impl AUTH-001). Verify the by-FR axis reflects that.
    const auth1Group = result.json.implicitImpactsByReq.find(
      (g) => g.reqId === "AUTH-001",
    );
    expect(auth1Group).toBeDefined();
    expect(auth1Group?.sourceFiles).toEqual(
      expect.arrayContaining(["src/auth/login.ts", "src/auth/session.ts"]),
    );

    // Cross-check: the union of every implicitImpacts[].sourceFile that
    // contains AUTH-001 in its reqs must equal auth1Group.sourceFiles.
    const cross = new Set<string>();
    for (const group of result.json.implicitImpacts) {
      if (group.reqs.some((r) => r.reqId === "AUTH-001")) cross.add(group.sourceFile);
    }
    expect(new Set(auth1Group!.sourceFiles)).toEqual(cross);

    // implicitImpactsByReq sourceFiles must be sorted.
    expect(auth1Group!.sourceFiles).toEqual(
      [...auth1Group!.sourceFiles].sort(),
    );
  });
});

describe("runPlanCoverage — mention subtraction", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("REQ mentioned anywhere in tasks/plan/spec is excluded from implicit", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: tweak login",
        "",
        "Files: src/auth/login.ts",
        "",
        "Considered: AUTH-002 — investigated, no impact",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    const implicitIds = new Set<string>();
    for (const g of result.json.implicitImpacts) {
      for (const r of g.reqs) implicitIds.add(r.reqId);
    }
    // AUTH-002 was mentioned (any-mention, label-agnostic) → not implicit.
    expect(implicitIds.has("AUTH-002")).toBe(false);
    // summary.mentioned reflects the mention count.
    expect(result.json.summary.mentioned).toBeGreaterThanOrEqual(1);
  });

  it("REQ-30 is not confused with REQ-3 (boundary match)", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: edit login",
        "",
        "Files: src/auth/login.ts",
        "",
        "Touched AUTH-0010 but not the real one.",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    const implicitIds = new Set<string>();
    for (const g of result.json.implicitImpacts) {
      for (const r of g.reqs) implicitIds.add(r.reqId);
    }
    // AUTH-001 must still be implicit even though `AUTH-0010` appeared.
    expect(implicitIds.has("AUTH-001")).toBe(true);
  });
});

describe("runPlanCoverage — --ignore one-shot suppression", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("removes the REQ from implicit and records it in ignored[]", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: ["AUTH-002", "AUTH-003"],
      requireFilesSection: false,
    });
    const implicitIds = new Set<string>();
    for (const g of result.json.implicitImpacts) {
      for (const r of g.reqs) implicitIds.add(r.reqId);
    }
    expect(implicitIds.has("AUTH-002")).toBe(false);
    expect(implicitIds.has("AUTH-003")).toBe(false);
    expect(result.json.ignored).toEqual(["AUTH-002", "AUTH-003"]);
    expect(result.json.summary.ignored).toBeGreaterThanOrEqual(1);

    // by-FR axis must also reflect the filter.
    const byReqIds = result.json.implicitImpactsByReq.map((r) => r.reqId);
    expect(byReqIds).not.toContain("AUTH-002");
    expect(byReqIds).not.toContain("AUTH-003");
  });
});

describe("runPlanCoverage — --gate exit codes", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("returns exitCode 0 when --gate is false even with implicit impacts", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json.implicitImpacts.length).toBeGreaterThan(0);
  });

  it("returns exitCode 1 when --gate is true and implicitImpacts is non-empty", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: true,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.exitCode).toBe(1);
  });

  it("returns exitCode 0 when --gate is true but --ignore drains every implicit REQ", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: true,
      ignore: ["AUTH-001", "AUTH-002", "AUTH-003"],
      requireFilesSection: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.implicitImpactsByReq).toEqual([]);
  });
});

describe("runPlanCoverage — --require-files-section diagnostics", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("emits no diagnostic when every task block has Files: (default behaviour)", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    const missing = result.json.diagnostics.filter(
      (d) => d.kind === "missingFilesSection",
    );
    expect(missing).toEqual([]);
  });

  it("ON: emits missingFilesSection for every block without Files:", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: has files",
        "",
        "Files: src/auth/login.ts",
        "",
        "### T002: no files",
        "",
        "Prose only, no Files: header.",
        "",
        "### T003: also no files",
        "",
        "Likewise.",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: true,
    });
    const missing = result.json.diagnostics.filter(
      (d) => d.kind === "missingFilesSection",
    );
    const missingIds = missing.map((d) => (d as { taskId: string }).taskId);
    expect(missingIds).toEqual(expect.arrayContaining(["T002", "T003"]));
    expect(missingIds).not.toContain("T001");
    // Line numbers must be 1-based and non-zero.
    for (const d of missing) {
      expect((d as { line: number }).line).toBeGreaterThan(0);
    }
  });

  it("--gate + --require-files-section ON with diagnostics → exit 1", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: has files",
        "",
        "Files: src/auth/login.ts",
        "Considered: AUTH-001, AUTH-002, AUTH-003",
        "",
        "### T002: no files",
        "",
        "Prose only.",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: true,
      ignore: [],
      requireFilesSection: true,
    });
    // Even though every REQ is mentioned (implicit empty), the diagnostic
    // alone trips the --gate exit-1.
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.diagnostics.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });
});

describe("runPlanCoverage — empty extraction", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("emits emptyExtraction diagnostic when both Files: and regex fallback are empty", () => {
    fx = setupFixture({
      tasksBody: ["# Tasks", "", "Prose with no file paths.", ""].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.implicitImpactsByReq).toEqual([]);
    expect(
      result.json.diagnostics.find((d) => d.kind === "emptyExtraction"),
    ).toBeDefined();
    expect(result.json.summary.totalAffected).toBe(0);
  });
});

describe("runPlanCoverage — text format dual view", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("text output contains both 'By source file:' and 'By requirement:' sections", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "text",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.text).toContain("By source file:");
    expect(result.text).toContain("By requirement:");
  });

  it("clean (no implicit) text output communicates the empty state clearly", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: edit login",
        "",
        "Files: src/auth/login.ts",
        "",
        "Considered: AUTH-001, AUTH-002, AUTH-003",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "text",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.json.implicitImpacts).toEqual([]);
    // Convey the empty state in human-readable form.
    expect(result.text.toLowerCase()).toMatch(/no implicit|none/);
  });
});

describe("runPlanCoverage — sort stability", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("implicitImpacts is sorted by sourceFile ascending; each reqs[] by reqId ascending", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth/session.ts, src/auth/login.ts, src/auth/logout.ts",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    const sourceFiles = result.json.implicitImpacts.map((g) => g.sourceFile);
    expect(sourceFiles).toEqual([...sourceFiles].sort());
    for (const group of result.json.implicitImpacts) {
      const reqIds = group.reqs.map((r) => r.reqId);
      expect(reqIds).toEqual([...reqIds].sort());
    }
  });
});
