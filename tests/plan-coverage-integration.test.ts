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
//   (i) --require-files-section OFF → no missingFilesSection diagnostics
//   (j) --require-files-section ON → diagnostics non-empty
//   (k) JSON output shape matches plan-coverage-json.md contract
//   (l) text output contains "By source file:" and "By requirement:"
//   (m) unresolvedFilePath from Stage A surfaces in top-level diagnostics[]

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  const specBody = opts.specBody ?? [
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
      "  node_id: \"doc:auth-design\"",
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
  writeFileSync(
    join(root, "src/auth/login.ts"),
    "// @impl INT-001\nexport function login() {}\n",
  );
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

  const tasksBody = opts.tasksBody ?? [
    "# Tasks",
    "",
    "### T001: tweak login",
    "",
    "Files: src/auth/login.ts",
    "",
  ].join("\n");
  const tasksPath = join(specDir, "tasks.md");
  writeFileSync(tasksPath, tasksBody);

  const planBody = opts.planBody ?? [
    "# Plan",
    "",
    "Mostly the login flow.",
    "",
  ].join("\n");
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
      () =>
        runCli(["plan-coverage", "--format", "json"], { cwd: fx.root }),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // login.ts @impl INT-001 → at least one implicit (INT-001 not mentioned).
    expect(result.implicitImpactsByReq.length).toBeGreaterThanOrEqual(1);
    expect(result.implicitImpactsByReq.map((r: { reqId: string }) => r.reqId)).toContain(
      "INT-001",
    );
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
    const { exitCode, stdout } = await withEnv(
      "SPECIFY_FEATURE_DIRECTORY",
      undefined,
      () =>
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
    const { exitCode, stdout } = await withEnv(
      "SPECIFY_FEATURE_DIRECTORY",
      undefined,
      () =>
        runCli(
          ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
          { cwd: fx.root },
        ),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.implicitImpactsByReq.length).toBeGreaterThanOrEqual(1);
  });

  it("Kiro path shape works with --spec (Kiro has no canonical auto-detect)", async () => {
    fx = setupFixture({ kiroStyle: true });
    const { exitCode, stdout } = await withEnv(
      "SPECIFY_FEATURE_DIRECTORY",
      undefined,
      () =>
        runCli(
          ["plan-coverage", "--spec", fx.specDirAbsolute, "--format", "json"],
          { cwd: fx.root },
        ),
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // Kiro fixture still resolves INT-001 from login.ts.
    expect(result.implicitImpactsByReq.map((r: { reqId: string }) => r.reqId)).toContain(
      "INT-001",
    );
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
    const { exitCode, stderr } = await withEnv(
      "SPECIFY_FEATURE_DIRECTORY",
      undefined,
      () => runCli(["plan-coverage", "--format", "json"], { cwd: fx.root }),
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
// (i) (j) — --require-files-section ON / OFF
// ---------------------------------------------------------------------------

describe("plan-coverage E2E — (i/j) --require-files-section toggle", () => {
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
    const missing = (
      result.diagnostics as Array<{ kind: string }>
    ).filter((d) => d.kind === "missingFilesSection");
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
    const { stdout } = await runCli(
      [
        "plan-coverage",
        "--spec",
        fx.specDirAbsolute,
        "--require-files-section",
        "--format",
        "json",
      ],
      { cwd: fx.root },
    );
    const result = JSON.parse(stdout);
    const missingIds = (
      result.diagnostics as Array<{ kind: string; taskId?: string }>
    )
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

    // implicitImpacts shape — each entry has sourceFile + reqs[{reqId, kind}].
    expect(Array.isArray(json.implicitImpacts)).toBe(true);
    for (const g of json.implicitImpacts) {
      expect(typeof g.sourceFile).toBe("string");
      expect(Array.isArray(g.reqs)).toBe(true);
      for (const r of g.reqs) {
        expect(typeof r.reqId).toBe("string");
        expect(r.kind).toBe("req");
      }
    }

    // implicitImpactsByReq is the inversion: same REQ set, REQ → sourceFile[].
    const bySrcSet = new Set<string>();
    for (const g of json.implicitImpacts) for (const r of g.reqs) bySrcSet.add(r.reqId);
    const byReqSet = new Set(
      (json.implicitImpactsByReq as Array<{ reqId: string }>).map((r) => r.reqId),
    );
    expect(byReqSet).toEqual(bySrcSet);
    expect(json.summary.implicit).toBe(json.implicitImpactsByReq.length);
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
    const { stdout, exitCode } = await runCli(
      ["plan-coverage", "--spec", fx.specDirAbsolute],
      { cwd: fx.root },
    );
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
    const unresolved = result.json.diagnostics.filter(
      (d) => d.kind === "unresolvedFilePath",
    );
    expect(unresolved.length).toBeGreaterThan(0);
    // The sourceFile field must carry the original Stage A path verbatim.
    expect(
      (unresolved[0] as { sourceFile: string }).sourceFile,
    ).toBe("src/auth/no-such-file.ts");
  });
});
