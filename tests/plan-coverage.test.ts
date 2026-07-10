// spec 016 — Phase 3 (US1) tests for `runPlanCoverage`.
// Contracts:
//   - specs/016-impact-plan-symbol-level/contracts/plan-coverage-json.md
//   - specs/016-impact-plan-symbol-level/contracts/sdd-files-parser.md
//   - specs/014-reinvent-impact-cli/contracts/mention-semantics.md (unchanged)
//
// Covers:
//   - by-(sourceFile, sourceSymbol?) axis (`implicitImpacts`) and by-REQ
//     axis (`implicitImpactsByReq` with `sourceLocations`) both present
//   - two-axis populate (`impactReqs` + `originReqs`) per ImpactGroup
//   - mention subtraction on `impactReqs` only (originReqs stays raw)
//   - --ignore one-shot suppression
//   - --gate exit codes
//   - requireFilesSection diagnostics
//   - text-format two-axis view ("Impact reqs:" / "Origin reqs:" /
//     conditional "Drift candidates:" section)
//   - symbol-mode features (symbol-unit dedup, file-unit sourceSymbol
//     omission, unresolvedSymbol diagnostic flattening, drift detection)
//
// File-unit tests use an AUTH-* fixture; symbol-unit tests stand up a
// separate symbol-mode fixture so the two pipelines stay isolated.

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
  const specBody =
    opts?.specBody ??
    [
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
      '  node_id: "doc:auth-design"',
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
  writeFileSync(join(root, "src/auth/login.ts"), "// @impl AUTH-001\nexport function login() {}\n");
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

  const tasksBody =
    opts?.tasksBody ??
    ["# Tasks", "", "### T001: tweak login", "", "Files: src/auth/login.ts", ""].join("\n");
  const tasksPath = join(specDir, "tasks.md");
  writeFileSync(tasksPath, tasksBody);

  const planBody = opts?.planBody ?? ["# Plan", "", "Mostly the login flow.", ""].join("\n");
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
      for (const req of group.impactReqs) reqIds.add(req.reqId);
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

  it("invariant: each implicitImpactsByReq[i].sourceLocations covers all by-sourceFile groups containing that reqId", () => {
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
    // (both files @impl AUTH-001). Verify the by-REQ axis reflects that
    // via the new `sourceLocations: Array<{file, symbol?}>` shape.
    const auth1Group = result.json.implicitImpactsByReq.find((g) => g.reqId === "AUTH-001");
    expect(auth1Group).toBeDefined();
    const auth1Files = auth1Group!.sourceLocations.map((l) => l.file);
    expect(auth1Files).toEqual(
      expect.arrayContaining(["src/auth/login.ts", "src/auth/session.ts"]),
    );

    // File-unit entries must NOT carry a `symbol` field on sourceLocations
    // (FR-020 / contracts/plan-coverage-json.md §3.1).
    for (const loc of auth1Group!.sourceLocations) {
      expect("symbol" in loc).toBe(false);
    }

    // Cross-check: the union of every implicitImpacts[].sourceFile that
    // contains AUTH-001 in its impactReqs must equal auth1Files.
    const cross = new Set<string>();
    for (const group of result.json.implicitImpacts) {
      if (group.impactReqs.some((r) => r.reqId === "AUTH-001")) cross.add(group.sourceFile);
    }
    expect(new Set(auth1Files)).toEqual(cross);

    // sourceLocations must be sorted (file ascending — INV-S4).
    expect(auth1Files).toEqual([...auth1Files].sort());
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
      for (const r of g.impactReqs) implicitIds.add(r.reqId);
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
      for (const r of g.impactReqs) implicitIds.add(r.reqId);
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
      for (const r of g.impactReqs) implicitIds.add(r.reqId);
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

describe("runPlanCoverage — requireFilesSection diagnostics", () => {
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
    const missing = result.json.diagnostics.filter((d) => d.kind === "missingFilesSection");
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
    const missing = result.json.diagnostics.filter((d) => d.kind === "missingFilesSection");
    const missingIds = missing.map((d) => (d as { taskId: string }).taskId);
    expect(missingIds).toEqual(expect.arrayContaining(["T002", "T003"]));
    expect(missingIds).not.toContain("T001");
    // Line numbers must be 1-based and non-zero.
    for (const d of missing) {
      expect((d as { line: number }).line).toBeGreaterThan(0);
    }
  });

  it("--gate + requireFilesSection ON with diagnostics → exit 1", () => {
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
    expect(result.json.diagnostics.find((d) => d.kind === "emptyExtraction")).toBeDefined();
    expect(result.json.summary.totalAffected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spec Kit standard flat checklist — issues #219 / #220
// ---------------------------------------------------------------------------

describe("runPlanCoverage — Spec Kit flat checklist (issues #219 / #220)", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  // Spec Kit's tasks-template emits a headingless flat checklist. Tasks
  // reference files that do not exist yet (greenfield), plus incidental
  // fs-existing paths like `package.json` that are NOT graph nodes.
  function setupFlatChecklistFixture(): FixtureRoot {
    const fixture = setupFixture({
      tasksBody: [
        "# Tasks: Todo CLI",
        "",
        "## Phase 1: Setup",
        "",
        "- [ ] T001 Initialize project with package.json",
        "- [ ] T002 Define Todo type in src/todo-types.ts",
        "- [ ] T003 Create CLI entry scaffold in src/todo-cli.ts",
        "",
      ].join("\n"),
    });
    // On the filesystem but not in the graph: Stage B accepts it as an
    // entry, yet it resolves to no start node — before the fix this made
    // `entries.length > 0` and skipped the emptyExtraction diagnostic
    // entirely (the issue #220 silent green).
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    return fixture;
  }

  it("#219: Files: block bounded by the next checklist task emits no bogus unresolvedFilePath", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "- [ ] T001 Tweak login in src/auth/login.ts",
        "",
        "Files: src/auth/login.ts",
        "- [ ] T002 Tweak logout (argv parsing, command dispatch table, shared",
        "  helpers) in src/auth/logout.ts",
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
    // Before the fix, the T002 line was swallowed as a Files: bullet and
    // surfaced as `unresolvedFilePath` with the task text as sourceFile.
    expect(result.json.diagnostics.filter((d) => d.kind === "unresolvedFilePath")).toEqual([]);
    expect(result.json.implicitImpacts.map((g) => g.sourceFile)).toEqual(["src/auth/login.ts"]);
  });

  it("#220: emptyExtraction fires when extracted entries resolve to no analyzable start node", () => {
    fx = setupFlatChecklistFixture();
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
    expect(result.json.summary.totalAffected).toBe(0);
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.diagnostics.find((d) => d.kind === "emptyExtraction")).toBeDefined();
  });

  it("#220: text output says 'Nothing to analyze' with the task count instead of 'No implicit impacts.'", () => {
    fx = setupFlatChecklistFixture();
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
    expect(result.text).toContain("Nothing to analyze: no Files: sections found across 3 task(s).");
    expect(result.text).not.toContain("No implicit impacts.");
  });

  it("#220: --gate trips (exit 1) on the nothing-analyzed state", () => {
    fx = setupFlatChecklistFixture();
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

  it("keeps 'No implicit impacts.' when analysis ran and every REQ is mentioned", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: tweak login",
        "",
        "Files: src/auth/login.ts",
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
    expect(result.text).toContain("No implicit impacts.");
    expect(result.text).not.toContain("Nothing to analyze");
    expect(result.json.diagnostics).toEqual([]);
  });

  it("requireFilesSection ON flags flat-checklist tasks lacking a Files: section", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "- [ ] T001 tweak login",
        "",
        "Files: src/auth/login.ts",
        "- [ ] T002 no files declared",
        "- [ ] T003 also none",
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
    const missing = result.json.diagnostics.filter((d) => d.kind === "missingFilesSection");
    expect(missing.map((d) => (d as { taskId: string }).taskId)).toEqual(["T002", "T003"]);
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

describe("runPlanCoverage — unresolvedFilePath diagnostics carry line numbers (CORR-2 / SPEC-1)", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("propagates 1-based `line` from the parser onto unresolvedFilePath", () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks", // line 1
        "", // line 2
        "### T001: typo task", // line 3
        "", // line 4
        "Files: src/typo-does-not-exist.ts", // line 5
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
    const unresolved = result.json.diagnostics.filter((d) => d.kind === "unresolvedFilePath");
    expect(unresolved.length).toBeGreaterThan(0);
    // The header carrying the typo lives at line 5 of tasks.md (1-based).
    expect(
      unresolved.find(
        (d) => d.kind === "unresolvedFilePath" && d.sourceFile === "src/typo-does-not-exist.ts",
      ),
    ).toEqual({
      kind: "unresolvedFilePath",
      sourceFile: "src/typo-does-not-exist.ts",
      line: 5,
    });
  });
});

describe("runPlanCoverage — text format hints (UX-4 / MIG-4)", () => {
  let fx: FixtureRoot;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("text output shows requireFilesSection OFF hint when the option is false", () => {
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
    // The hint nudges the user toward enabling the config option so
    // silent-green reports don't hide missing `Files:` sections.
    expect(result.text).toContain("OFF");
    expect(result.text).toContain("Enable");
    expect(result.text).toContain("planCoverage.requireFilesSection");
  });

  it("text output suppresses the OFF hint when requireFilesSection is true", () => {
    fx = setupFixture();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "text",
      gate: false,
      ignore: [],
      requireFilesSection: true,
    });
    expect(result.text).not.toContain("requireFilesSection is OFF");
  });

  it("text output shows emptyExtraction hint when no files were extracted", () => {
    fx = setupFixture({
      tasksBody: ["# Tasks", "", "Prose with no file paths at all.", ""].join("\n"),
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
    expect(result.text).toContain("no files extracted");
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
      const reqIds = group.impactReqs.map((r) => r.reqId);
      expect(reqIds).toEqual([...reqIds].sort());
      // originReqs is independently sorted; INV-S5.
      const originIds = group.originReqs.map((r) => r.reqId);
      expect(originIds).toEqual([...originIds].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// spec 016 Phase 3 — symbol-mode coverage. Standalone tmpdir fixture so the
// AUTH-* file-mode setup above stays untouched. Symbol mode uses REQ-XXX IDs
// and disables docGraph.autoContains so a symbol's BFS reaches only its own
// `@impl` claim (no doc-sibling pollution — quickstart Scenario A).
// ---------------------------------------------------------------------------

interface SymbolFixture {
  root: string;
  specDir: string;
  tasksPath: string;
  planPath: string;
}

function setupSymbolFixture(opts?: {
  tasksBody?: string;
  /** Override the spec dir's own spec.md (default has zero REQ literals). */
  specBody?: string;
  /** Append extra requirement definitions to the external REQ catalogue. */
  extraReqLines?: string[];
  /**
   * Optional `(depends_on: REQ-XYZ)` annotations to attach to a given REQ
   * definition line — used by the SC-006 drift scenario.
   */
  reqDependsOn?: Record<string, string[]>;
}): SymbolFixture {
  const root = mkdtempSync(join(tmpdir(), "artgraph-pc-symbol-"));
  const specDir = join(root, "specs/001-symbol-demo");
  mkdirSync(specDir, { recursive: true });

  // Analysis target spec.md — intentionally mention-free so the detector
  // doesn't eclipse implicit impacts when a REQ-ID happens to be literal.
  writeFileSync(
    join(specDir, "spec.md"),
    opts?.specBody ??
      [
        "# Symbol Demo Spec",
        "",
        "Intentionally REQ-ID-free body so plan-coverage's mention detector",
        "treats every REQ reached from `Files:` paths as implicit.",
        "",
      ].join("\n"),
  );

  // External REQ catalogue. autoContains is off (see .artgraph.json below)
  // so the doc node does NOT pull these REQs together via BFS — each is a
  // standalone node, reached only via its own `implements` edge.
  const reqLines = [
    "- REQ-001: validateToken must reject empty bearer tokens.",
    "- REQ-002: createSession must establish a fresh session for a user id.",
    "- REQ-005: issueToken must mint a fresh bearer token tied to a user id.",
    "- REQ-009: revokeToken must mark a token as revoked.",
    ...(opts?.extraReqLines ?? []),
  ];
  if (opts?.reqDependsOn) {
    for (let i = 0; i < reqLines.length; i++) {
      for (const [reqId, deps] of Object.entries(opts.reqDependsOn)) {
        if (!reqLines[i].startsWith(`- ${reqId}:`)) continue;
        // Append `(depends_on: REQ-X, REQ-Y)` so the markdown parser
        // builds depends_on edges (parsers/markdown.ts ANNOTATION_RE).
        reqLines[i] = `${reqLines[i]} (depends_on: ${deps.join(", ")})`;
      }
    }
  }
  const externalSpec = join(root, "specs/auth-design");
  mkdirSync(externalSpec, { recursive: true });
  writeFileSync(
    join(externalSpec, "requirements.md"),
    ["# Auth Requirements", "", "## Requirements", "", ...reqLines, ""].join("\n"),
  );

  // src/auth.ts: three exports, each `@impl` REQ-001/005/009 inside the
  // function body so the symbol-mode TS parser attributes the edge to the
  // symbol (not the file).
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/auth.ts"),
    [
      "export function validateToken(token: string): boolean {",
      "  // @impl REQ-001",
      "  return token.length > 0;",
      "}",
      "export function issueToken(userId: string): string {",
      "  // @impl REQ-005",
      "  return `token:${userId}`;",
      "}",
      "export function revokeToken(token: string): void {",
      "  // @impl REQ-009",
      "  void token;",
      "}",
      "",
    ].join("\n"),
  );
  // Companion file for cross-file symbol (US1 AS#3).
  writeFileSync(
    join(root, "src/session.ts"),
    [
      "export function createSession(userId: string): string {",
      "  // @impl REQ-002",
      "  return `session:${userId}`;",
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
      mode: "symbol",
      docGraph: { autoContains: false },
    }),
  );

  const tasksBody =
    opts?.tasksBody ??
    ["# Tasks", "", "### T001", "", "Files: src/auth.ts:validateToken", ""].join("\n");
  const tasksPath = join(specDir, "tasks.md");
  writeFileSync(tasksPath, tasksBody);

  const planPath = join(specDir, "plan.md");
  writeFileSync(planPath, "# Plan\n\nNo REQ references.\n");
  return { root, specDir, tasksPath, planPath };
}

describe("runPlanCoverage — symbol-mode US1 (Phase 3)", () => {
  let fx: SymbolFixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("symbol-unit entry produces a single ImpactGroup with sourceSymbol + two-axis populate (contract §8 case 1)", () => {
    fx = setupSymbolFixture();
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
    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    expect(g.sourceFile).toBe("src/auth.ts");
    expect(g.sourceSymbol).toBe("validateToken");
    expect(g.impactReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(g.originReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(result.json.implicitImpactsByReq).toHaveLength(1);
    expect(result.json.implicitImpactsByReq[0]).toEqual({
      reqId: "REQ-001",
      sourceLocations: [{ file: "src/auth.ts", symbol: "validateToken" }],
    });
  });

  it("file-unit entry omits sourceSymbol key and reports originReqs:[] when file-top has no @impl (contract §8 case 2/3)", () => {
    fx = setupSymbolFixture({
      tasksBody: ["# Tasks", "", "### T001", "", "Files: src/auth.ts", ""].join("\n"),
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
    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    expect(g.sourceFile).toBe("src/auth.ts");
    // JSON key must be omitted, not present-as-undefined.
    expect("sourceSymbol" in g).toBe(false);
    expect(g.impactReqs.map((r) => r.reqId).sort()).toEqual(["REQ-001", "REQ-005", "REQ-009"]);
    // file-top @impl is absent in the fixture → originReqs MUST be [].
    expect(g.originReqs).toEqual([]);
    // by-REQ sourceLocations: file-only entry must omit `symbol` key.
    for (const r of result.json.implicitImpactsByReq) {
      for (const loc of r.sourceLocations) {
        expect("symbol" in loc).toBe(false);
        expect(loc.file).toBe("src/auth.ts");
      }
    }
  });

  it("1 file × 2 symbols → 2 distinct ImpactGroups with independent origin claims (contract §8 case 4)", () => {
    fx = setupSymbolFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth.ts:validateToken, src/auth.ts:issueToken",
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
    expect(result.json.implicitImpacts).toHaveLength(2);
    const symbols = result.json.implicitImpacts.map((g) => g.sourceSymbol);
    expect(symbols.sort()).toEqual(["issueToken", "validateToken"]);
    const validateGroup = result.json.implicitImpacts.find(
      (g) => g.sourceSymbol === "validateToken",
    )!;
    const issueGroup = result.json.implicitImpacts.find((g) => g.sourceSymbol === "issueToken")!;
    expect(validateGroup.originReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(issueGroup.originReqs.map((r) => r.reqId)).toEqual(["REQ-005"]);
    expect(validateGroup.impactReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(issueGroup.impactReqs.map((r) => r.reqId)).toEqual(["REQ-005"]);
  });

  it("US1 AS#3: cross-file symbol entries produce 2 ImpactGroups in parallel", () => {
    fx = setupSymbolFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth.ts:validateToken, src/session.ts:createSession",
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
    expect(result.json.implicitImpacts).toHaveLength(2);
    const files = result.json.implicitImpacts.map((g) => g.sourceFile);
    expect(files.sort()).toEqual(["src/auth.ts", "src/session.ts"]);
    for (const g of result.json.implicitImpacts) {
      expect(g.sourceSymbol).toBeDefined();
      // Each entry's origin == its impact == single REQ for the symbol.
      expect(g.impactReqs).toEqual(g.originReqs);
      expect(g.impactReqs).toHaveLength(1);
    }
  });

  it("unresolvedSymbol entry: diagnostic emitted and entry excluded from implicitImpacts (contract §8 case 5)", () => {
    fx = setupSymbolFixture({
      tasksBody: ["# Tasks", "", "### T001", "", "Files: src/auth.ts:doesNotExist", ""].join("\n"),
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
    // entry was rejected → no implicitImpacts; diagnostic surfaces instead.
    expect(result.json.implicitImpacts).toEqual([]);
    const unresolved = result.json.diagnostics.filter((d) => d.kind === "unresolvedSymbol");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toEqual({
      kind: "unresolvedSymbol",
      sourceFile: "src/auth.ts",
      symbol: "doesNotExist",
      line: 5,
    });
  });

  it("file + symbol mixed entries produce two groups; file-unit omits sourceSymbol (contract §8 case 6)", () => {
    fx = setupSymbolFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth.ts, src/session.ts:createSession",
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
    expect(result.json.implicitImpacts).toHaveLength(2);
    const authGroup = result.json.implicitImpacts.find((g) => g.sourceFile === "src/auth.ts")!;
    const sessionGroup = result.json.implicitImpacts.find(
      (g) => g.sourceFile === "src/session.ts",
    )!;
    expect("sourceSymbol" in authGroup).toBe(false);
    expect(sessionGroup.sourceSymbol).toBe("createSession");
  });

  it("--gate trips on unresolvedSymbol-only run (contract §8 case 7)", () => {
    fx = setupSymbolFixture({
      tasksBody: ["# Tasks", "", "### T001", "", "Files: src/auth.ts:doesNotExist", ""].join("\n"),
    });
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
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.diagnostics.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  it("sourceLocations sort: file ascending; same-file `undefined` symbol precedes a string symbol (INV-S4, contract §8 case 8)", () => {
    fx = setupSymbolFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001",
        "",
        // Order intentionally jumbled to verify the sort, not preservation.
        "Files: src/session.ts:createSession, src/auth.ts:validateToken, src/auth.ts",
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
    // REQ-001 is reached by BOTH `src/auth.ts` (file unit) and
    // `src/auth.ts:validateToken`; sort must put undefined first.
    const req1 = result.json.implicitImpactsByReq.find((r) => r.reqId === "REQ-001")!;
    expect(req1.sourceLocations.length).toBeGreaterThanOrEqual(2);
    expect(req1.sourceLocations[0]).toEqual({ file: "src/auth.ts" });
    expect(req1.sourceLocations[1]).toEqual({
      file: "src/auth.ts",
      symbol: "validateToken",
    });
  });

  it("SC-006 drift: depends_on REQ-007 makes REQ-007 reachable from validateToken, surfaces in impactReqs but NOT originReqs (contract §8 case 9)", () => {
    fx = setupSymbolFixture({
      extraReqLines: ["- REQ-007: token revocation hook."],
      reqDependsOn: { "REQ-001": ["REQ-007"] },
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath, // default Files: src/auth.ts:validateToken
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    const impactIds = g.impactReqs.map((r) => r.reqId).sort();
    const originIds = g.originReqs.map((r) => r.reqId).sort();
    expect(impactIds).toEqual(["REQ-001", "REQ-007"]);
    expect(originIds).toEqual(["REQ-001"]);
    // JSON consumer computes the drift candidate themselves.
    const drift = impactIds.filter((id) => !originIds.includes(id));
    expect(drift).toEqual(["REQ-007"]);
  });

  it("--ignore applies to BOTH impactReqs and originReqs (FR-022)", () => {
    fx = setupSymbolFixture({
      tasksBody: ["# Tasks", "", "### T001", "", "Files: src/auth.ts:validateToken", ""].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDir,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: ["REQ-001"],
      requireFilesSection: false,
    });
    // The only group's only REQ is ignored → group falls out entirely.
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.implicitImpactsByReq).toEqual([]);
    expect(result.json.ignored).toEqual(["REQ-001"]);
  });

  it("text formatter renders symbol entry with `#` separator + Impact/Origin sections; omits empty Drift section", () => {
    fx = setupSymbolFixture();
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
    expect(result.text).toContain("src/auth.ts#validateToken");
    expect(result.text).toContain("Impact reqs:");
    expect(result.text).toContain("Origin reqs (@impl claims):");
    // Drift section omitted when impact == origin.
    expect(result.text).not.toContain("Drift candidates");
  });

  it("text formatter renders Drift candidates section when impactReqs \\ originReqs is non-empty", () => {
    fx = setupSymbolFixture({
      extraReqLines: ["- REQ-007: token revocation hook."],
      reqDependsOn: { "REQ-001": ["REQ-007"] },
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
    expect(result.text).toContain("Drift candidates");
    expect(result.text).toContain("REQ-007");
  });
});
