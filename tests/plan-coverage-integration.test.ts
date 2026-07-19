// spec 014 — Phase 9 (T026) E2E tests for `artgraph plan-coverage`.
//
// Contracts:
//   - specs/014-reinvent-impact-cli/contracts/cli-flags.md
//   - specs/014-reinvent-impact-cli/contracts/plan-coverage-json.md
//   - specs/014-reinvent-impact-cli/contracts/mention-semantics.md
//
// Scope: exercise the FULL CLI surface (commander parsing + spec-resolver +
// runPlanCoverage + output formatting + exit code) from physically-laid-out
// Spec Kit / Kiro fixtures on disk. The unit-level test in
// tests/plan-coverage.test.ts covers `runPlanCoverage` programmatically; this
// file complements it by driving the CLI binary (in-process via `runCli`).
//
// The 13 E2E scenarios mirror the (a)–(m) checklist in the spec 014 Phase 9
// task description:
//   (a) SPECIFY_FEATURE_DIRECTORY env auto-detect
//   (b) .specify/feature.json auto-detect
//   (c) --spec explicit (Spec Kit shape)
//   (c') --spec explicit (Kiro shape)
//   (d) Kiro fixture with no env / feature.json → auto-detect fails
//   (e) --gate absent + implicit > 0 → exit 0
//   (f) --gate + implicit > 0 → exit 1
//   (g) --gate + implicit == 0 → exit 0
//   (h) --gate + --ignore drains implicit → exit 0
//   (i) requireFilesSection OFF → no missingFilesSection diagnostics
//   (j) requireFilesSection ON (config) → diagnostics non-empty
//   (k) JSON output shape matches plan-coverage-json.md contract
//   (l) text output contains "By source file:" and "By requirement:"
//   (m) unresolvedFilePath from Stage A surfaces in top-level diagnostics[]

import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.js";
import { runPlanCoverage } from "../src/plan-coverage/index.js";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------
//
// Use INT-* REQ-IDs (not AUTH-*) so the fixture is isolated from the shared
// tests/fixtures/ tree and from collisions across other tests' tmpdirs. The
// graph is tiny: spec.md defines INT-001 / INT-002 / INT-003; login.ts @impl
// INT-001; session.ts @impl INT-001 + INT-002; logout.ts @impl INT-003.

interface FixtureOptions {
  /** Place the spec under `.kiro/specs/<name>/` instead of `.specify/specs/<name>/`. */
  kiroStyle?: boolean;
  /** Override `tasks.md` body. Default declares Files: src/auth/login.ts only. */
  tasksBody?: string;
  /** Override `plan.md` body. Default is short prose with no file refs. */
  planBody?: string;
  /** Override the spec dir's own `spec.md`. Default has no REQ mentions. */
  specBody?: string;
  /** Drop `.specify/feature.json` even in Spec Kit mode (used for auto-detect-failure tests). */
  omitFeatureJson?: boolean;
}

interface Fixture {
  root: string;
  specDir: string;
  /** Path the CLI should see in --spec / SPECIFY_FEATURE_DIRECTORY / feature.json. */
  specDirAbsolute: string;
  tasksPath: string;
  planPath: string;
}

function setupFixture(opts: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "artgraph-pc-integ-"));

  const specRelPrefix = opts.kiroStyle ? ".kiro/specs" : ".specify/specs";
  const specDir = join(root, specRelPrefix, "auth-feature");
  mkdirSync(specDir, { recursive: true });

  // spec.md inside the current spec dir — by default carries no REQ mentions
  // so the mention detector starts clean. Override via opts.specBody.
  const specBody =
    opts.specBody ??
    [
      "# Auth Feature (test fixture)",
      "",
      "This spec dir is the analysis target for plan-coverage.",
      "",
    ].join("\n");
  writeFileSync(join(specDir, "spec.md"), specBody);

  // External spec that owns the REQ definitions so the graph builder picks
  // them up when scanning `specs/**`. Lives under `specs/` so the default
  // `specDirs: ["specs"]` config in .artgraph.json reaches it.
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
      "- INT-001: login",
      "- INT-002: session",
      "- INT-003: logout",
      "",
    ].join("\n"),
  );

  // Source files with @impl tags so the graph has implements edges.
  mkdirSync(join(root, "src/auth"), { recursive: true });
  writeFileSync(join(root, "src/auth/login.ts"), "// @impl INT-001\nexport function login() {}\n");
  writeFileSync(
    join(root, "src/auth/session.ts"),
    "// @impl INT-001 INT-002\nexport function session() {}\n",
  );
  writeFileSync(
    join(root, "src/auth/logout.ts"),
    "// @impl INT-003\nexport function logout() {}\n",
  );

  // `.artgraph.json` so loadConfig sees the fixture's include / specDirs.
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );

  // Spec Kit canonical pointer file. Skipped when omitFeatureJson is set
  // (e.g. so we can test auto-detect failure) or in Kiro mode (Kiro has no
  // canonical equivalent).
  if (!opts.kiroStyle && !opts.omitFeatureJson) {
    mkdirSync(join(root, ".specify"), { recursive: true });
    writeFileSync(
      join(root, ".specify/feature.json"),
      JSON.stringify({ feature_directory: specDir }),
    );
  }

  const tasksBody =
    opts.tasksBody ??
    ["# Tasks", "", "### T001: tweak login", "", "Files: src/auth/login.ts", ""].join("\n");
  const tasksPath = join(specDir, "tasks.md");
  writeFileSync(tasksPath, tasksBody);

  const planBody = opts.planBody ?? ["# Plan", "", "Mostly the login flow.", ""].join("\n");
  const planPath = join(specDir, "plan.md");
  writeFileSync(planPath, planBody);

  return { root, specDir, specDirAbsolute: specDir, tasksPath, planPath };
}

// Mutate process.env around `runCli` while making sure the prior value is
// faithfully restored — `delete` vs `=` matter to downstream tests because
// vitest shares the env between concurrent test files.
async function withEnv<T>(
  key: string,
  value: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const prev = process.env[key];
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await body();
  } finally {
    if (!had) delete process.env[key];
    else process.env[key] = prev as string;
  }
}

// ---------------------------------------------------------------------------
// (a) — SPECIFY_FEATURE_DIRECTORY env-based auto-detect
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (a) SPECIFY_FEATURE_DIRECTORY auto-detect", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("uses the env var when --spec is absent", async () => {
    fx = setupFixture({ omitFeatureJson: true });
    const { exitCode, stdout } = await withEnv(
      "SPECIFY_FEATURE_DIRECTORY",
      fx.specDirAbsolute,
      () => runCli(["plan-coverage", "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // login.ts @impl INT-001 → at least one implicit (INT-001 not mentioned).
    expect(result.implicitImpactsByReq.length).toBeGreaterThanOrEqual(1);
    expect(result.implicitImpactsByReq.map((r: { reqId: string }) => r.reqId)).toContain("INT-001");
  });
});

// ---------------------------------------------------------------------------
// (b) — .specify/feature.json auto-detect
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (b) .specify/feature.json auto-detect", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("reads feature_directory when env var is unset", async () => {
    fx = setupFixture();
    const { exitCode, stdout } = await withEnv("SPECIFY_FEATURE_DIRECTORY", undefined, () =>
      runCli(["plan-coverage", "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.implicitImpactsByReq.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// (c) — --spec explicit (Spec Kit & Kiro path shapes)
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (c) --spec explicit", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("Spec Kit path shape works with --spec", async () => {
    fx = setupFixture({ omitFeatureJson: true });
    const { exitCode, stdout } = await withEnv("SPECIFY_FEATURE_DIRECTORY", undefined, () =>
      runCli(["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.implicitImpactsByReq.length).toBeGreaterThanOrEqual(1);
  });

  it("Kiro path shape works with --spec (Kiro has no canonical auto-detect)", async () => {
    fx = setupFixture({ kiroStyle: true });
    const { exitCode, stdout } = await withEnv("SPECIFY_FEATURE_DIRECTORY", undefined, () =>
      runCli(["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // Kiro fixture still resolves INT-001 from login.ts.
    expect(result.implicitImpactsByReq.map((r: { reqId: string }) => r.reqId)).toContain("INT-001");
  });
});

// ---------------------------------------------------------------------------
// (d) — Kiro project without env / feature.json → auto-detect fails
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (d) Kiro auto-detect failure", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("errors with Kiro-aware guidance when nothing auto-resolves", async () => {
    // Kiro fixture: no .specify/feature.json, no SPECIFY_FEATURE_DIRECTORY.
    fx = setupFixture({ kiroStyle: true });
    const { exitCode, stderr } = await withEnv("SPECIFY_FEATURE_DIRECTORY", undefined, () =>
      runCli(["plan-coverage", "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(1);
    // Contract requires guidance pointing to both Spec Kit and Kiro paths.
    expect(stderr).toMatch(/--spec/);
    expect(stderr).toMatch(/\.kiro\/specs/);
    expect(stderr).toMatch(/\.specify\/specs/);
  });
});

// ---------------------------------------------------------------------------
// (e) (f) (g) (h) — --gate / --ignore exit-code matrix end-to-end
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (e/f/g/h) --gate + --ignore exit code matrix", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("(e) no --gate, implicit > 0 → exit 0", async () => {
    fx = setupFixture();
    const { exitCode, stdout } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).implicitImpactsByReq.length).toBeGreaterThan(0);
  });

  it("(f) --gate + implicit > 0 → exit 1", async () => {
    fx = setupFixture();
    const { exitCode } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--gate", "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(1);
  });

  it("(g) --gate + implicit == 0 → exit 0", async () => {
    // Mention INT-001/002/003 in tasks.md so the mention detector drains
    // every affected REQ.
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: tweak login",
        "",
        "Files: src/auth/login.ts",
        "",
        "Considered: INT-001, INT-002, INT-003",
        "",
      ].join("\n"),
    });
    const { exitCode } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--gate", "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(0);
  });

  it("(h) --gate + --ignore drains every implicit → exit 0", async () => {
    fx = setupFixture();
    const { exitCode, stdout } = await runCli(
      [
        "plan-coverage",
        "--spec",
        fx.specDirAbsolute,
        "--gate",
        "--ignore",
        "INT-001,INT-002,INT-003",
        "--format",
        "json",
      ],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.implicitImpactsByReq).toEqual([]);
    expect(result.ignored).toEqual(["INT-001", "INT-002", "INT-003"]);
  });
});

// ---------------------------------------------------------------------------
// (i) (j) — planCoverage.requireFilesSection ON / OFF
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (i/j) requireFilesSection config toggle", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("(i) OFF (default): no missingFilesSection diagnostics for blocks without Files:", async () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: has files",
        "",
        "Files: src/auth/login.ts",
        "",
        "### T002: prose only",
        "",
        "No Files: header here.",
        "",
      ].join("\n"),
    });
    const { stdout } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
      { cwd: fx.root },
    );
    const result = JSON.parse(stdout);
    const missing = (result.diagnostics as Array<{ kind: string }>).filter(
      (d) => d.kind === "missingFilesSection",
    );
    expect(missing).toEqual([]);
  });

  it("(j) ON: every block without Files: emits a missingFilesSection diagnostic", async () => {
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: has files",
        "",
        "Files: src/auth/login.ts",
        "",
        "### T002: prose only",
        "",
        "No Files: header.",
        "",
        "### T003: also prose",
        "",
        "Likewise.",
        "",
      ].join("\n"),
    });
    // requireFilesSection is config-only: flip it on in `.artgraph.json`.
    writeFileSync(
      join(fx.root, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
        planCoverage: { requireFilesSection: true },
      }),
    );
    const { stdout } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
      { cwd: fx.root },
    );
    const result = JSON.parse(stdout);
    const missingIds = (result.diagnostics as Array<{ kind: string; taskId?: string }>)
      .filter((d) => d.kind === "missingFilesSection")
      .map((d) => d.taskId);
    expect(missingIds).toEqual(expect.arrayContaining(["T002", "T003"]));
    expect(missingIds).not.toContain("T001");
  });
});

// ---------------------------------------------------------------------------
// (k) — JSON output shape per contracts/plan-coverage-json.md
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (k) JSON output shape per contract", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("emits the full top-level shape (both axes + summary + diagnostics + ignored)", async () => {
    fx = setupFixture();
    const { stdout, exitCode } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);

    // Mandatory top-level keys (contracts/plan-coverage-json.md §Top-level).
    expect(json).toHaveProperty("implicitImpacts");
    expect(json).toHaveProperty("implicitImpactsByReq");
    expect(json).toHaveProperty("summary");
    expect(json).toHaveProperty("diagnostics");
    expect(json).toHaveProperty("ignored");

    // summary shape — every counter present and numeric.
    for (const k of ["totalAffected", "mentioned", "implicit", "ignored"]) {
      expect(typeof json.summary[k]).toBe("number");
    }

    // spec 016 contract §2: each entry has sourceFile + impactReqs +
    // originReqs (both ReqEntry[]). file-unit entries omit sourceSymbol.
    expect(Array.isArray(json.implicitImpacts)).toBe(true);
    for (const g of json.implicitImpacts) {
      expect(typeof g.sourceFile).toBe("string");
      expect(Array.isArray(g.impactReqs)).toBe(true);
      expect(Array.isArray(g.originReqs)).toBe(true);
      for (const r of g.impactReqs) {
        expect(typeof r.reqId).toBe("string");
        expect(r.kind).toBe("req");
      }
    }

    // implicitImpactsByReq is the inversion of impactReqs only.
    const bySrcSet = new Set<string>();
    for (const g of json.implicitImpacts) for (const r of g.impactReqs) bySrcSet.add(r.reqId);
    const byReqSet = new Set(
      (json.implicitImpactsByReq as Array<{ reqId: string }>).map((r) => r.reqId),
    );
    expect(byReqSet).toEqual(bySrcSet);
    expect(json.summary.implicit).toBe(json.implicitImpactsByReq.length);
    // contract §3: sourceLocations[] is mandatory, sourceFiles[] is gone.
    for (const r of json.implicitImpactsByReq) {
      expect(Array.isArray(r.sourceLocations)).toBe(true);
      expect("sourceFiles" in r).toBe(false);
      for (const loc of r.sourceLocations) {
        expect(typeof loc.file).toBe("string");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (l) — text output dual view
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (l) text output dual view", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("contains both 'By source file:' and 'By requirement:' sections when implicit > 0", async () => {
    fx = setupFixture();
    const { stdout, exitCode } = await runCli(["plan-coverage", "--spec", fx.specDirAbsolute], {
      cwd: fx.root,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("By source file:");
    expect(stdout).toContain("By requirement:");
  });
});

// ---------------------------------------------------------------------------
// (m) — unresolvedFilePath flattened from sdd-files-parser diagnostics
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (m) unresolvedFilePath diagnostic flattening", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("surfaces parser unresolved paths in the top-level diagnostics[]", () => {
    // Stage A accepts the explicit Files: entry even when the path is missing
    // on disk, but emits an `unresolvedFilePath` parser diagnostic that
    // plan-coverage must flatten into its own diagnostics[] (per FR-005
    // soft-validation behaviour).
    fx = setupFixture({
      tasksBody: [
        "# Tasks",
        "",
        "### T001: typo path",
        "",
        "Files: src/auth/no-such-file.ts",
        "",
      ].join("\n"),
    });
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDirAbsolute,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    const unresolved = result.json.diagnostics.filter((d) => d.kind === "unresolvedFilePath");
    expect(unresolved.length).toBeGreaterThan(0);
    // The sourceFile field must carry the original Stage A path verbatim.
    expect((unresolved[0] as { sourceFile: string }).sourceFile).toBe("src/auth/no-such-file.ts");
  });
});

// ---------------------------------------------------------------------------
// Phase 9 (TEST-5 / CORR-1) — explicit-flag failure modes
// ---------------------------------------------------------------------------
//
// These guard the failure paths that the happy-path scenarios (a–m) above
// don't exercise. Each block is independent and uses the same setupFixture
// helper so the graph shape stays consistent across the file.

describe("plan-coverage E2E — --plan with non-existent path (CORR-1)", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("exits 1 with a clear error when --plan points at a missing file", async () => {
    // Sanity: tasks.md is fine (default fixture), only --plan is bogus.
    // Otherwise we'd be testing the tasks.md branch instead.
    fx = setupFixture();
    const bogusPlan = join(fx.root, "does-not-exist-plan.md");
    const { exitCode, stderr } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--plan", bogusPlan, "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(1);
    // Contract (src/cli.ts CORR-1 block): "error: --plan path not found: ..."
    expect(stderr).toMatch(/--plan path not found/);
    expect(stderr).toContain(bogusPlan);
  });
});

describe("plan-coverage E2E — --tasks with non-existent path", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("exits 1 with a clear error when --tasks points at a missing file", async () => {
    fx = setupFixture();
    const bogusTasks = join(fx.root, "does-not-exist-tasks.md");
    const { exitCode, stderr } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--tasks", bogusTasks, "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(1);
    // src/cli.ts emits "error: tasks.md not found: <path>".
    expect(stderr).toMatch(/tasks\.md not found/);
    expect(stderr).toContain(bogusTasks);
  });
});

describe("plan-coverage E2E — --ignore tolerates unknown REQ-IDs", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("silently accepts a REQ-ID that is not in the affected set", async () => {
    // The one-shot --ignore list is best-effort suppression: IDs that
    // wouldn't have been flagged anyway shouldn't fail the command.
    // Per src/plan-coverage/index.ts:399, summary.ignored only counts IDs
    // that *were* in the affected set; bogus IDs still appear in
    // `ignored[]` for transparency but contribute 0 to summary.ignored.
    fx = setupFixture();
    const { exitCode, stdout } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--ignore", "NOSUCH-999", "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.ignored).toContain("NOSUCH-999");
    expect(result.summary.ignored).toBe(0);
    // The real implicit set (INT-001 etc.) is untouched by the bogus ID.
    expect(result.implicitImpactsByReq.length).toBeGreaterThan(0);
  });
});

describe("plan-coverage E2E — BOM + CRLF tasks.md", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("extracts Files: from a tasks.md with UTF-8 BOM and CRLF line endings", async () => {
    // Real-world tasks.md files frequently arrive from Windows editors or
    // tools that emit BOM-prefixed UTF-8. The Stage A header trim path
    // ought to handle both cleanly; this is a regression guard.
    const bom = "﻿";
    fx = setupFixture({
      tasksBody:
        bom +
        ["# Tasks", "", "### T001: bom+crlf", "", "Files: src/auth/login.ts", ""].join("\r\n"),
    });
    const { exitCode, stdout } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
      { cwd: fx.root },
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // login.ts @impl INT-001 → INT-001 must surface as implicit (no
    // mention of INT-001 in the spec trio of this fixture).
    const reqIds = (result.implicitImpactsByReq as Array<{ reqId: string }>).map((r) => r.reqId);
    expect(reqIds).toContain("INT-001");
  });
});

describe("plan-coverage E2E — feature.json pointing at missing dir", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("does not error inside resolveSpecDir when feature.json points at a non-existent dir, but downstream tasks.md lookup fails clearly", async () => {
    // resolveSpecDir trusts the path it's handed — existence checks happen
    // in the CLI handler (tasks.md / plan.md). A stale feature.json
    // pointing at a deleted spec dir should therefore surface as a
    // tasks.md-not-found error with the bogus dir path embedded.
    fx = setupFixture({ omitFeatureJson: true });
    // Overwrite the stale .specify/feature.json that omitFeatureJson omitted.
    mkdirSync(join(fx.root, ".specify"), { recursive: true });
    writeFileSync(
      join(fx.root, ".specify/feature.json"),
      JSON.stringify({ feature_directory: ".specify/specs/no-such-dir" }),
    );
    const { exitCode, stderr } = await withEnv("SPECIFY_FEATURE_DIRECTORY", undefined, () =>
      runCli(["plan-coverage", "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(1);
    // The tasks.md path inside the bogus spec dir should appear in the error.
    expect(stderr).toMatch(/tasks\.md not found/);
    expect(stderr).toMatch(/no-such-dir/);
  });
});

describe("plan-coverage E2E — large tasks.md (perf scale)", () => {
  let fx: Fixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("handles a tasks.md with 1000 task blocks within a reasonable time budget", () => {
    // Build a 1000-block tasks.md that points every block at login.ts so
    // the impact graph stays small (one source file → INT-001) while the
    // parser is forced to walk 1000 heading scopes. Programmatic invocation
    // via runPlanCoverage is enough — we don't need the runCli env mock.
    const blocks: string[] = ["# Tasks", ""];
    for (let i = 1; i <= 1000; i++) {
      const id = `T${String(i).padStart(4, "0")}`;
      blocks.push(`### ${id}: bulk task`);
      blocks.push("");
      blocks.push("Files: src/auth/login.ts");
      blocks.push("");
    }
    fx = setupFixture({ tasksBody: blocks.join("\n") });

    const start = Date.now();
    const result = runPlanCoverage({
      repoRoot: fx.root,
      specDir: fx.specDirAbsolute,
      tasksPath: fx.tasksPath,
      planPath: fx.planPath,
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });
    const elapsed = Date.now() - start;

    // INT-001 implements login.ts, no mention in spec trio → at least
    // one implicit impact must surface.
    expect(result.json.summary.totalAffected).toBeGreaterThan(0);
    // Loose perf budget. Node + ts-morph scan dominates; the 1000-block
    // parse should add tens of ms, not seconds. Tuned generously so the
    // assertion catches accidental O(n^2) regressions without flaking
    // under CI load.
    expect(elapsed).toBeLessThan(5000);
  }, 10000);
});

// ---------------------------------------------------------------------------
// spec 016 Phase 3 (T024, T025) — symbol-mode E2E using the static fixture.
//
// The on-disk fixture (`tests/fixtures/symbol-mode/`) is the authoritative
// quickstart Scenario A target: three exports in src/auth.ts, each `@impl`
// REQ-001 / REQ-005 / REQ-009 inside the function body, plus src/session.ts
// `createSession @impl REQ-002`. `.artgraph.json` sets `mode: symbol` and
// `docGraph.autoContains: false` so doc→REQ contains edges don't pull in
// sibling REQs (R-006 — single-symbol BFS reach is exactly one REQ).
//
// T024 (SC-001): symbol-unit vs file-unit implicit count comparison on the
//                fixture's tasks.md (which exercises both entries in one
//                tasks.md, T001 = symbol unit, T002 = file unit).
// T025 (SC-006): copy the fixture into a tmpdir, append `(depends_on: REQ-007)`
//                to REQ-001, scan + run, and verify the drift candidate
//                surfaces as `impactReqs \ originReqs`.
// ---------------------------------------------------------------------------

const STATIC_SYMBOL_FIXTURE = resolvePath(import.meta.dirname, "fixtures/symbol-mode");

describe("plan-coverage symbol-mode E2E — static fixture (T024 / SC-001)", () => {
  it("symbol-unit entry yields exactly 1 impact REQ; file-unit entry yields 3 — ≥50% reduction (SC-001)", () => {
    const fixtureRoot = STATIC_SYMBOL_FIXTURE;
    const result = runPlanCoverage({
      repoRoot: fixtureRoot,
      specDir: resolvePath(fixtureRoot, "specs/001-symbol-demo"),
      tasksPath: resolvePath(fixtureRoot, "specs/001-symbol-demo/tasks.md"),
      planPath: resolvePath(fixtureRoot, "specs/001-symbol-demo/plan.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    // Tasks.md declares two entries:
    //   T001 → Files: src/auth.ts:validateToken (symbol unit, REQ-001)
    //   T002 → Files: src/auth.ts                (file unit, REQ-001/005/009)
    // The two surface as two distinct ImpactGroups under the same sourceFile.
    expect(result.json.implicitImpacts.length).toBeGreaterThanOrEqual(2);

    const symbolGroup = result.json.implicitImpacts.find((g) => g.sourceSymbol === "validateToken");
    const fileGroup = result.json.implicitImpacts.find(
      (g) => g.sourceFile === "src/auth.ts" && g.sourceSymbol === undefined,
    );
    expect(symbolGroup).toBeDefined();
    expect(fileGroup).toBeDefined();

    const symbolReqs = symbolGroup!.impactReqs.map((r) => r.reqId);
    const fileReqs = fileGroup!.impactReqs.map((r) => r.reqId);
    expect(symbolReqs).toEqual(["REQ-001"]);
    expect(fileReqs.sort()).toEqual(["REQ-001", "REQ-005", "REQ-009"]);

    // SC-001 acceptance: file → 3 REQs, symbol → 1 REQ ⇒ 2/3 ≈ 66% reduction.
    // (Cast guards against future tightening of the spec threshold.)
    const reduction = (fileReqs.length - symbolReqs.length) / fileReqs.length;
    expect(reduction).toBeGreaterThanOrEqual(0.5);
  });

  it("symbol-unit ImpactGroup carries `sourceSymbol` and matching `originReqs`; file-unit omits the key and has originReqs:[]", () => {
    const fixtureRoot = STATIC_SYMBOL_FIXTURE;
    const result = runPlanCoverage({
      repoRoot: fixtureRoot,
      specDir: resolvePath(fixtureRoot, "specs/001-symbol-demo"),
      tasksPath: resolvePath(fixtureRoot, "specs/001-symbol-demo/tasks.md"),
      planPath: resolvePath(fixtureRoot, "specs/001-symbol-demo/plan.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    const symbolGroup = result.json.implicitImpacts.find(
      (g) => g.sourceSymbol === "validateToken",
    )!;
    expect(symbolGroup.originReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);

    const fileGroup = result.json.implicitImpacts.find(
      (g) => g.sourceFile === "src/auth.ts" && g.sourceSymbol === undefined,
    )!;
    expect("sourceSymbol" in fileGroup).toBe(false);
    // File-top has no `@impl` tag in the fixture; originReqs MUST be [].
    expect(fileGroup.originReqs).toEqual([]);
  });
});

describe("plan-coverage symbol-mode E2E — barrel entry originReqs (#191)", () => {
  // Regression: an entry pointing at a barrel symbol (`Files: src/index.ts:x`
  // where index.ts is `export { x } from "./origin"`) used to return
  // originReqs=[] because the barrel node carries no `implements` edge.
  // impact() still crosses the barrel and reaches origin's REQ, so the
  // group was flagged as a drift candidate (impactReqs \ originReqs) — a
  // false positive. entryOriginIds now 1-hop-follows `imports` so the
  // origin's authorship claim reaches originReqs.
  let tmpRoot: string;
  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("barrel symbol entry inherits origin's @impl into originReqs (no false-positive drift)", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-pc-barrel-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    mkdirSync(join(tmpRoot, "specs/auth"), { recursive: true });
    mkdirSync(join(tmpRoot, ".specify/specs/barrel-demo"), { recursive: true });

    writeFileSync(
      join(tmpRoot, "src/auth.ts"),
      "// @impl BRL-001\nexport function validateToken(t: string) { return !!t; }\n",
    );
    writeFileSync(join(tmpRoot, "src/index.ts"), 'export { validateToken } from "./auth";\n');

    writeFileSync(
      join(tmpRoot, "specs/auth/design.md"),
      [
        "---",
        "artgraph:",
        '  node_id: "doc:barrel-design"',
        "---",
        "",
        "# Barrel Design",
        "",
        "## Requirements",
        "",
        "- BRL-001: validateToken must reject empty bearer tokens.",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(tmpRoot, ".specify/specs/barrel-demo/tasks.md"),
      [
        "# Tasks",
        "",
        "### T001: touch the barrel",
        "",
        "Files: src/index.ts:validateToken",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmpRoot, ".specify/specs/barrel-demo/spec.md"),
      "# Barrel Demo\n\n(no mentions)\n",
    );

    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        mode: "symbol",
      }),
    );

    const result = runPlanCoverage({
      repoRoot: tmpRoot,
      specDir: join(tmpRoot, ".specify/specs/barrel-demo"),
      tasksPath: join(tmpRoot, ".specify/specs/barrel-demo/tasks.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    expect(g.sourceFile).toBe("src/index.ts");
    expect(g.sourceSymbol).toBe("validateToken");
    expect(g.impactReqs.map((r) => r.reqId)).toEqual(["BRL-001"]);
    // Before the fix originReqs was []; drift = impactReqs \ originReqs
    // therefore surfaced BRL-001 as a false-positive drift candidate.
    expect(g.originReqs.map((r) => r.reqId)).toEqual(["BRL-001"]);
  });

  it("multi-hop barrel chain (index → sub → origin) still reaches origin's @impl (no residual false-positive drift)", () => {
    // Regression for the multi-hop case flagged in review: a 1-hop-only
    // walk from `index.ts#x` stops at `sub.ts#x` — itself a mid-barrel
    // with no `implements` edge — so origin's REQ still fails to surface
    // in originReqs while impact() BFS reaches it. Two-file barrel
    // chains are common in package layouts (top-level `index.ts` re-
    // exports a submodule's `index.ts` which re-exports leaves).
    tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-pc-barrel-multi-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    mkdirSync(join(tmpRoot, "specs/auth"), { recursive: true });
    mkdirSync(join(tmpRoot, ".specify/specs/barrel-multi-demo"), { recursive: true });

    writeFileSync(
      join(tmpRoot, "src/origin.ts"),
      "// @impl BRL-002\nexport function validateToken(t: string) { return !!t; }\n",
    );
    writeFileSync(join(tmpRoot, "src/sub.ts"), 'export { validateToken } from "./origin";\n');
    writeFileSync(join(tmpRoot, "src/index.ts"), 'export { validateToken } from "./sub";\n');

    writeFileSync(
      join(tmpRoot, "specs/auth/design.md"),
      [
        "---",
        "artgraph:",
        '  node_id: "doc:barrel-multi-design"',
        "---",
        "",
        "# Barrel Multi Design",
        "",
        "## Requirements",
        "",
        "- BRL-002: validateToken must reject empty bearer tokens.",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(tmpRoot, ".specify/specs/barrel-multi-demo/tasks.md"),
      [
        "# Tasks",
        "",
        "### T001: touch the top-level barrel",
        "",
        "Files: src/index.ts:validateToken",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmpRoot, ".specify/specs/barrel-multi-demo/spec.md"),
      "# Barrel Multi Demo\n\n(no mentions)\n",
    );

    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        mode: "symbol",
      }),
    );

    const result = runPlanCoverage({
      repoRoot: tmpRoot,
      specDir: join(tmpRoot, ".specify/specs/barrel-multi-demo"),
      tasksPath: join(tmpRoot, ".specify/specs/barrel-multi-demo/tasks.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    expect(g.sourceSymbol).toBe("validateToken");
    expect(g.impactReqs.map((r) => r.reqId)).toEqual(["BRL-002"]);
    expect(g.originReqs.map((r) => r.reqId)).toEqual(["BRL-002"]);
  });
});

describe("plan-coverage symbol-mode E2E — depends_on drift (T025 / SC-006)", () => {
  // Copy the static fixture into a tmpdir, mutate the REQ catalogue to
  // append `(depends_on: REQ-007)` + define REQ-007, and confirm the
  // forward BFS reaches REQ-007 while the symbol's `@impl` claim does not
  // — so `impactReqs \ originReqs = [REQ-007]` falls out as a drift hint.
  let tmpRoot: string;
  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("appending REQ-001 depends_on REQ-007 surfaces REQ-007 in impactReqs but not originReqs", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-pc-drift-"));
    cpSync(STATIC_SYMBOL_FIXTURE, tmpRoot, { recursive: true });
    // Force tasks.md to a single symbol-unit entry so the assertion below
    // is unambiguous (the default fixture also includes a file-unit task
    // that would add three more groups).
    const tasksPath = join(tmpRoot, "specs/001-symbol-demo/tasks.md");
    writeFileSync(
      tasksPath,
      [
        "# Tasks: Symbol Demo (drift variant)",
        "",
        "### T001: depends_on drift",
        "",
        "Files: src/auth.ts:validateToken",
        "",
      ].join("\n"),
    );
    // Append the depends_on annotation + introduce REQ-007 as a sibling.
    const reqsPath = join(tmpRoot, "specs/auth-design/requirements.md");
    const reqsContent = readFileSync(reqsPath, "utf-8");
    const patched = reqsContent
      .replace(
        "- REQ-001: validateToken must reject empty bearer tokens.",
        "- REQ-001: validateToken must reject empty bearer tokens. (depends_on: REQ-007)",
      )
      .replace(
        "- REQ-009: revokeToken must mark a token as revoked.",
        "- REQ-009: revokeToken must mark a token as revoked.\n- REQ-007: token revocation hook lifecycle.",
      );
    writeFileSync(reqsPath, patched);

    const result = runPlanCoverage({
      repoRoot: tmpRoot,
      specDir: join(tmpRoot, "specs/001-symbol-demo"),
      tasksPath,
      planPath: join(tmpRoot, "specs/001-symbol-demo/plan.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    expect(g.sourceSymbol).toBe("validateToken");
    const impactIds = g.impactReqs.map((r) => r.reqId).sort();
    const originIds = g.originReqs.map((r) => r.reqId).sort();
    expect(impactIds).toEqual(["REQ-001", "REQ-007"]);
    expect(originIds).toEqual(["REQ-001"]);
    const drift = impactIds.filter((id) => !originIds.includes(id));
    expect(drift).toEqual(["REQ-007"]);
  });
});

// ---------------------------------------------------------------------------
// specs/018 T13 — `plan-coverage` with a `path:symbol` entry pointing at a
// symbol reached ONLY through a plain `export *` chain. Before the builder
// star-expansion pass (Phase 2), such an entry would either error as
// `unresolvedSymbol` (barrel node absent) or, if resolved via file-grain
// fail-safe, drift-flag the origin's REQ because `entryOriginIds` could not
// follow the `imports` chain past a file→file edge. With star expansion the
// barrel symbol is materialised and `entryOriginIds` walks `symbol→symbol`
// hops to origin's `@impl`, so no false-positive drift.
// ---------------------------------------------------------------------------

describe("plan-coverage symbol-mode E2E — `export *` chain entry (specs/018 T13)", () => {
  let tmpRoot: string;
  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("`Files: src/star.ts:validateToken` (star barrel) → originReqs contains origin's REQ, no drift", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-pc-star-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    mkdirSync(join(tmpRoot, "specs/auth"), { recursive: true });
    mkdirSync(join(tmpRoot, ".specify/specs/star-demo"), { recursive: true });

    // Origin symbol carries the `@impl`, and the barrel re-exports EVERY
    // name via `export * from "./auth"`. Before specs/018 there was no
    // `symbol:src/star.ts#validateToken` node and the entry either
    // unresolved-symbolled or drift-flagged; now star expansion emits it.
    writeFileSync(
      join(tmpRoot, "src/auth.ts"),
      "// @impl STAR-001\nexport function validateToken(t: string) { return !!t; }\n",
    );
    writeFileSync(join(tmpRoot, "src/star.ts"), 'export * from "./auth";\n');

    writeFileSync(
      join(tmpRoot, "specs/auth/design.md"),
      [
        "---",
        "artgraph:",
        '  node_id: "doc:star-design"',
        "---",
        "",
        "# Star Design",
        "",
        "## Requirements",
        "",
        "- STAR-001: validateToken must reject empty bearer tokens.",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(tmpRoot, ".specify/specs/star-demo/tasks.md"),
      [
        "# Tasks",
        "",
        "### T001: touch the star barrel",
        "",
        "Files: src/star.ts:validateToken",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmpRoot, ".specify/specs/star-demo/spec.md"),
      "# Star Demo\n\n(no mentions)\n",
    );

    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        mode: "symbol",
      }),
    );

    const result = runPlanCoverage({
      repoRoot: tmpRoot,
      specDir: join(tmpRoot, ".specify/specs/star-demo"),
      tasksPath: join(tmpRoot, ".specify/specs/star-demo/tasks.md"),
      format: "json",
      gate: false,
      ignore: [],
      requireFilesSection: false,
    });

    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];
    expect(g.sourceFile).toBe("src/star.ts");
    expect(g.sourceSymbol).toBe("validateToken");
    // impactReqs reaches STAR-001 via barrel → origin.
    expect(g.impactReqs.map((r) => r.reqId)).toEqual(["STAR-001"]);
    // Before specs/018 this was []; with star expansion + `entryOriginIds`
    // symbol-hop traversal, the origin's @impl reaches originReqs.
    expect(g.originReqs.map((r) => r.reqId)).toEqual(["STAR-001"]);
    const drift = g.impactReqs
      .map((r) => r.reqId)
      .filter((id) => !g.originReqs.map((o) => o.reqId).includes(id));
    expect(drift).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// build warnings surfaced (meta-review F2 — issue #265 follow-up gap)
// ---------------------------------------------------------------------------
//
// `runPlanCoverage` used to discard `scan()`'s `BuildWarning[]` entirely
// (`const { graph } = scan(...)`), so `artgraph plan-coverage` was the one
// graph-building command issue #265's warning-wiring pass missed. Mirrors
// the equivalent coverage for `artgraph impact` in
// tests/impact-cli.test.ts's "build warnings surfaced (issue #265)" block —
// same fixture shape (a string-literal export alias colliding with a class
// member's synthesized symbol name), same two assertions (text → stderr,
// json → payload).
describe("plan-coverage E2E — build warnings surfaced (meta-review F2)", () => {
  function makeCollisionFixture(): Fixture {
    const fx = setupFixture();
    // Switch the fixture's graph to symbol mode and add a colliding file —
    // scan() warns about this regardless of what tasks.md's `Files:` list
    // references, since the warning comes from building the whole graph.
    writeFileSync(
      join(fx.root, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
        mode: "symbol",
      }),
    );
    mkdirSync(join(fx.root, "src/other"), { recursive: true });
    writeFileSync(
      join(fx.root, "src/other/collision.ts"),
      [
        "function helper(): void {}",
        'export { helper as "Sample.methodA" };',
        "",
        "export class Sample {",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    return fx;
  }

  it("text mode: prints the class-member-collision warning to stderr", async () => {
    const fx = makeCollisionFixture();
    try {
      const { stderr, exitCode } = await runCli(["plan-coverage", "--spec", fx.specDirAbsolute], {
        cwd: fx.root,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain("WARNING:");
      expect(stderr).toContain("collides with an existing export");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("--format json: embeds warnings[] in the payload and does not also print to stderr", async () => {
    const fx = makeCollisionFixture();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
        { cwd: fx.root },
      );
      expect(exitCode).toBe(0);
      const json = JSON.parse(stdout);
      expect(json.warnings.some((w: { type: string }) => w.type === "class-member-collision")).toBe(
        true,
      );
      // scan/init/check convention: json mode doesn't ALSO print to stderr.
      expect(stderr).not.toContain("WARNING:");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// issue #279 (item 1) — the generic catch-all in commands/plan-coverage.ts
// (an error thrown from inside `runPlanCoverage`/`scan`, distinct from the
// `--spec`/`--tasks`/`--plan` early exits above which are pre-existing and
// unaffected) used to be plain-text-only regardless of `--format`. It now
// mirrors `rename`'s original `fail()`: json → `{"error": ...}` on stderr,
// text → the pre-existing `Error: <msg>` line on stderr — both exit 1, both
// with an EMPTY stdout (a fatal error is not a verdict payload).
//
// A malformed `.trace.lock` (a JSON array, not an object) reliably reaches
// this catch: `readLockWithMeta` → `validateLockSchema` throws
// `LockSchemaError` from deep inside `runPlanCoverage`, uncaught until this
// command's own catch-all.
// ---------------------------------------------------------------------------
describe("CLI: plan-coverage's generic catch-all is format-aware (issue #279 item 1)", () => {
  function makeFixtureWithCorruptLock(): Fixture {
    const fx = setupFixture();
    writeFileSync(join(fx.root, ".trace.lock"), "[]");
    return fx;
  }

  it('--format json: {"error": ...} envelope on stderr, empty stdout, exit 1', async () => {
    const fx = makeFixtureWithCorruptLock();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
        { cwd: fx.root },
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(() => JSON.parse(stderr)).not.toThrow();
      expect(JSON.parse(stderr).error).toMatch(/JSON object at the top level/i);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("text mode: `Error: <msg>` on stderr, empty stdout, exit 1 (pre-existing text behavior unchanged)", async () => {
    const fx = makeFixtureWithCorruptLock();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["plan-coverage", "--spec", fx.specDirAbsolute],
        { cwd: fx.root },
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/^Error: .*JSON object at the top level/i);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
