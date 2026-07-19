// issue #356 — custom `include` / `testPatterns` configs could leave one
// pool's node_modules protection out of sync with the other (issue #350's
// HIGH-2 gave each pool its OWN `"!**/node_modules/**"`-style negation, but
// nothing ever diagnosed a config that forgot to add it to only one of the
// two). Confirmed implementation plan (Step 0-pre + product owner sign-off):
//
//   (1) a shared helper `missingNodeModulesProtection` (`src/config.ts`) is
//       the single judge both surfaces below call into.
//   (2) `artgraph scan` emits a SILENT (JSON-only) `config-pool-protection-
//       asymmetry` warning — silent because it fires on every scan of an
//       asymmetric config regardless of whether node_modules even exists,
//       which would be noisy on the default stderr presenter.
//   (3) `artgraph doctor` reports the same issue as an advisory
//       (severity `pass`) finding, gated on Tier 1 agent detection, never
//       flipping the doctor exit code.
//   (4) the existing `node-modules-in-scan` warning's `files` sample (cap 5)
//       is now pool-balanced: any pool with offending files contributes at
//       least one sample entry, instead of unconditionally taking the first
//       5 in discovery order (which could omit a pool's sole offending file
//       entirely).
//
// PR #359 review (H1/H2/M1/M2) revisited the judge itself:
//
//   - H1: `loadConfig` (src/config.ts) now validates `include` / `testPatterns`
//     shape up front — a bare string or a non-string array element throws an
//     actionable error instead of crashing deep inside `missingNodeModulesProtection`'s
//     `.some()` / picomatch calls (or fast-glob) with an opaque TypeError.
//   - H2: the judge no longer trusts a string/path-segment heuristic. It
//     compiles each pool's negative patterns with picomatch (using the exact
//     option set fast-glob itself uses for ignore-pattern evaluation — see
//     `FAST_GLOB_IGNORE_OPTIONS`'s own comment in src/config.ts) and matches
//     them against three representative synthetic paths at increasing
//     nesting depth. A pool is "protected" only if EVERY synthetic path is
//     covered. A THIRD category, "broken exclusion", fires when a pool's
//     pattern clearly mentions node_modules but the matcher says it still
//     isn't protected at every depth — reported regardless of the other
//     pool's state.
//   - M1: a pool with no positive pattern at all (issue #266 — such a pool
//     can never match a file) is excluded from judgment entirely.
//   - M2: `formatPoolProtectionMessage` (src/config.ts) is now the single
//     shared message generator both `scan` and `doctor` render through.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig, missingNodeModulesProtection } from "../src/config.js";
import { buildGraph } from "../src/graph/builder.js";
import { runDoctor, formatDoctorReportJson, type DoctorFinding } from "../src/doctor.js";
import { runInit } from "../src/init.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { ArtgraphConfig } from "../src/types.js";
import { runAt } from "./helpers.js";
import { createFreshProject } from "./agents/helpers.js";

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// (1) missingNodeModulesProtection — unit tests
// ---------------------------------------------------------------------------

describe("missingNodeModulesProtection — shared judge", () => {
  it("returns [] for DEFAULT_CONFIG (both pools protected)", () => {
    expect(missingNodeModulesProtection(DEFAULT_CONFIG)).toEqual([]);
  });

  it("returns [] when both pools lack the negation (symmetric, deliberate choice — not reported)", () => {
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts"],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual([]);
  });

  it("reports testPatterns as unprotected when only include is (matcher-)protected", () => {
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual([{ pool: "testPatterns", reason: "unprotected" }]);
  });

  it("reports include as unprotected when only testPatterns is (matcher-)protected", () => {
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual([{ pool: "include", reason: "unprotected" }]);
  });

  it("does not false-positive on a literal file/dir named node_modules-like without the exact segment", () => {
    // "!**/node_modules_backup/**" does NOT contain "node_modules" as a whole
    // path segment (it's "node_modules_backup") and doesn't match any
    // synthetic node_modules path either, so it counts as plain
    // "unprotected", never "broken exclusion" (no mention).
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!**/node_modules_backup/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual([{ pool: "include", reason: "unprotected" }]);
  });

  // -------------------------------------------------------------------------
  // H2 regression — real glob semantics replace the old string/path-segment
  // heuristic. Both scenarios below were MEASURED to misjudge under the old
  // heuristic (see src/config.ts's own doc comment on `missingNodeModulesProtection`).
  // -------------------------------------------------------------------------

  it('H2 false-positive fix: "!node_modules/**" (no `**/` prefix) only protects the repo root, not nested paths — old heuristic misjudged it as fully protecting the pool', () => {
    // Old string/segment heuristic: "node_modules/**" contains the exact
    // segment "node_modules" → judged protected. Real matcher: only matches
    // depth 0 ("node_modules/x.ts"), NOT "a/node_modules/x.ts" or
    // "a/b/node_modules/x.ts" → not actually protected, and since the
    // pattern DOES mention node_modules, this is a "broken exclusion", not a
    // plain "unprotected".
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!node_modules/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual([{ pool: "include", reason: "broken-exclusion" }]);
  });

  it('H2 false-negative fix: "!**/*node_modules*/**" (wildcarded segment) DOES protect every nesting depth — old heuristic misjudged it as unprotected and silently swallowed a real leak', () => {
    // Old string/segment heuristic: split("/") gives ["**", "*node_modules*",
    // "**"], none of which equals the literal "node_modules" → judged
    // unprotected → the (silent) advisory would have fired even though the
    // pool is actually fully protected. Real matcher: "*node_modules*"
    // matches the "node_modules" segment at every depth → protected, no
    // issue reported for either pool (both protected, by different valid
    // patterns).
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!**/*node_modules*/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual([]);
  });

  it("broken exclusion fires even when the OTHER pool is also unprotected (symmetry does not suppress it)", () => {
    // include mentions node_modules but doesn't cover nested depths (broken);
    // testPatterns doesn't mention node_modules at all (plain, silent
    // unprotected). Per H2's rule (b), the broken-exclusion pool is reported
    // regardless of the other pool's state — this is NOT the
    // both-pools-silent case docs/configuration.md describes as
    // indistinguishable from an intentional vendor scan.
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!node_modules/**"],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual([{ pool: "include", reason: "broken-exclusion" }]);
  });

  // -------------------------------------------------------------------------
  // M1 — pools with no positive pattern (issue #266: matches nothing) are
  // excluded from judgment entirely.
  // -------------------------------------------------------------------------

  it("M1: an empty pool is excluded from judgment — no report even though its counterpart is unprotected", () => {
    expect(
      missingNodeModulesProtection({
        include: [],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual([]);
  });

  it("M1: an all-negative pool is excluded from judgment, even if its sole pattern mentions node_modules", () => {
    expect(
      missingNodeModulesProtection({
        include: ["!**/node_modules/**"],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual([]);
  });

  it("M1: an all-negative pool does not itself get flagged as a broken exclusion", () => {
    // include has ONLY negative patterns (degenerate — matches nothing per
    // issue #266) and one of them, in isolation, would be a broken exclusion
    // ("!node_modules/**" doesn't cover nested depths). M1 excludes it from
    // judgment before that check ever runs.
    expect(
      missingNodeModulesProtection({
        include: ["!node_modules/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (1b) H1 — loadConfig shape validation for include / testPatterns
// ---------------------------------------------------------------------------

describe("loadConfig — H1 regression: include / testPatterns shape validation", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("throws an actionable error for a bare string include (would otherwise crash missingNodeModulesProtection's .some())", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-h1-bare-string-"));
    write(tmp, ".artgraph.json", JSON.stringify({ include: "src/**/*.ts" }));
    expect(() => loadConfig(tmp)).toThrow(/Invalid "include" in \.artgraph\.json/);
  });

  it("throws an actionable error for a non-string element inside testPatterns", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-h1-mixed-array-"));
    write(tmp, ".artgraph.json", JSON.stringify({ testPatterns: ["**/*.test.ts", 42] }));
    expect(() => loadConfig(tmp)).toThrow(/Invalid "testPatterns\[1\]" in \.artgraph\.json/);
  });

  it("H1 regression: a bare string include surfaces as a clean, actionable CLI failure — exit 1, not an opaque crash", async () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-h1-cli-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    write(tmp, ".artgraph.json", JSON.stringify({ include: "src/**/*.ts", specDirs: ["specs"] }));

    const { stderr, exitCode } = await runAt(tmp, ["scan"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid "include" in .artgraph.json');
    // The pre-fix crash surfaced as an opaque TypeError from deep inside
    // `.some()` / fast-glob — assert we do NOT regress to that.
    expect(stderr).not.toContain("is not a function");
  });
});

// ---------------------------------------------------------------------------
// (1c) L1 — loadConfig's `??` fallback path (issue #356's core scenario:
// only ONE of include/testPatterns set explicitly, the other silently picks
// up DEFAULT_CONFIG's own value via `??`)
// ---------------------------------------------------------------------------

describe("loadConfig `??` fallback — E2E (issue #356 core path)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("include set (unprotected) + testPatterns key omitted entirely: loadConfig's `??` fallback picks up DEFAULT_CONFIG's protected testPatterns, and the asymmetry fires end-to-end through scan --format json", async () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-l1-fallback-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    // testPatterns key is entirely absent — loadConfig's `raw.testPatterns ??
    // DEFAULT_CONFIG.testPatterns` fallback must supply the DEFAULT (already
    // protected) value.
    write(
      tmp,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
      }),
    );

    const config = loadConfig(tmp);
    expect(config.testPatterns).toEqual(DEFAULT_CONFIG.testPatterns);
    expect(missingNodeModulesProtection(config)).toEqual([
      { pool: "include", reason: "unprotected" },
    ]);

    const { stdout } = await runAt(tmp, ["scan", "--format", "json"]);
    const parsed = JSON.parse(stdout) as {
      warnings: Array<{ type: string; id: string; message?: string }>;
    };
    const w = parsed.warnings.find((x) => x.type === "config-pool-protection-asymmetry");
    expect(w, JSON.stringify(parsed.warnings, null, 2)).toBeDefined();
    expect(w!.id).toBe("include");
  });
});

// ---------------------------------------------------------------------------
// (2) scan — silent config-pool-protection-asymmetry warning
// ---------------------------------------------------------------------------

describe("scan — config-pool-protection-asymmetry (silent, JSON-only)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("asymmetric config (include protected, testPatterns not): warning appears in buildGraph's warnings[]", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-asym-include-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "!**/node_modules/**"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(tmp, config);
    const w = warnings.find((x) => x.type === "config-pool-protection-asymmetry");
    expect(w, JSON.stringify(warnings, null, 2)).toBeDefined();
    expect(w?.message).toContain("testPatterns");
    expect(w?.id).toBe("testPatterns");
  });

  it("asymmetric config (testPatterns protected, include not): warning names include as the unprotected pool", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-asym-testpatterns-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(tmp, config);
    const w = warnings.find((x) => x.type === "config-pool-protection-asymmetry");
    expect(w, JSON.stringify(warnings, null, 2)).toBeDefined();
    expect(w?.id).toBe("include");
  });

  it("symmetric config (both protected, DEFAULT_CONFIG): no warning", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-sym-both-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");

    const config: ArtgraphConfig = { ...DEFAULT_CONFIG, specDirs: ["specs"] };
    const { warnings } = buildGraph(tmp, config);
    expect(warnings.some((x) => x.type === "config-pool-protection-asymmetry")).toBe(false);
  });

  it("symmetric config (neither protected): no warning — deliberate/indistinguishable choice", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-sym-neither-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(tmp, config);
    expect(warnings.some((x) => x.type === "config-pool-protection-asymmetry")).toBe(false);
  });

  it("H2: broken-exclusion config surfaces a pool-specific remediation message through buildGraph's warnings[]", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-broken-exclusion-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");

    const config: ArtgraphConfig = {
      // Looks intentional (mentions node_modules) but only ever protects the
      // repo root, not nested paths.
      include: ["src/**/*.ts", "!node_modules/**"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(tmp, config);
    const w = warnings.find((x) => x.type === "config-pool-protection-asymmetry");
    expect(w, JSON.stringify(warnings, null, 2)).toBeDefined();
    expect(w!.id).toBe("include");
    expect(w!.message).toContain("does not cover every nesting");
    expect(w!.message).toContain('"!**/node_modules/**"');
  });

  it("scan --format json surfaces the warning in warnings[]", async () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-cli-json-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    write(
      tmp,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
      }),
    );

    const { stdout } = await runAt(tmp, ["scan", "--format", "json"]);
    const parsed = JSON.parse(stdout) as { warnings: Array<{ type: string }> };
    expect(parsed.warnings.some((w) => w.type === "config-pool-protection-asymmetry")).toBe(true);
  });

  it("default (text) scan output stays silent for config-pool-protection-asymmetry, but NOT for a real node-modules-in-scan hit in the same run (reachability: proves the stderr presenter actually ran the warning-printing path and deliberately skipped ours)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-cli-text-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    // Also plant an actual node_modules file so the SAME run additionally
    // fires the non-silent `node-modules-in-scan` warning.
    write(tmp, "node_modules/pkg/foo.test.ts", `describe("[${"REQ-001"}] foo", () => {});\n`);
    write(
      tmp,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
      }),
    );

    const { stderr } = await runAt(tmp, ["scan"]);
    expect(stderr).toContain("scanned file(s) are under node_modules/");
    expect(stderr).not.toContain("config-pool-protection-asymmetry");
    expect(stderr).not.toContain("excludes node_modules");
  });
});

// ---------------------------------------------------------------------------
// (3) doctor — config-pool-protection-asymmetry advisory
// ---------------------------------------------------------------------------

describe("doctor — config-pool-protection-asymmetry advisory", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  function findFinding(
    findings: DoctorFinding[],
    pred: (f: DoctorFinding) => boolean,
  ): DoctorFinding | undefined {
    return findings.find(pred);
  }

  it("fires as an advisory (severity pass) when config is asymmetric, agent installed", () => {
    runInit(proj.dir, {
      agents: ["claude"],
      noScan: true,
      noIntegrate: true,
      noHooks: true,
      force: true,
    });
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
        agents: ["claude"],
      }),
    );

    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-pool-protection-asymmetry");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.severity).toBe("pass");
    expect(f!.agent).toBeNull();
    expect(f!.message).toContain("testPatterns");
    // Advisory only — must not flip the exit code.
    expect(report.summary.failCount).toBe(0);

    // JSON presenter carries the same finding through untouched.
    const json = JSON.parse(formatDoctorReportJson(report));
    expect(
      json.findings.some((x: DoctorFinding) => x.kind === "config-pool-protection-asymmetry"),
    ).toBe(true);
  });

  it("H2: reports a broken-exclusion pool with the dedicated remediation wording, and its message matches scan's own formatPoolProtectionMessage output byte-for-byte", () => {
    runInit(proj.dir, {
      agents: ["claude"],
      noScan: true,
      noIntegrate: true,
      noHooks: true,
      force: true,
    });
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!node_modules/**"], // mentions but doesn't cover nesting
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
        agents: ["claude"],
      }),
    );

    const doctorReport = runDoctor({ rootDir: proj.dir });
    const doctorFinding = findFinding(
      doctorReport.findings,
      (x) => x.kind === "config-pool-protection-asymmetry",
    );
    expect(doctorFinding, JSON.stringify(doctorReport.findings, null, 2)).toBeDefined();
    expect(doctorFinding!.message).toContain("does not cover every nesting");

    write(proj.dir, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(proj.dir, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "!node_modules/**"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(proj.dir, config);
    const scanWarning = warnings.find((x) => x.type === "config-pool-protection-asymmetry");
    expect(scanWarning!.message).toBe(doctorFinding!.message);
  });

  it("does NOT fire when no Tier 1 agent is installed at all — gated the same way as config-missing-agents-field, so doctor's empty-report short-circuit (and its exit-code guarantee) stays intact", () => {
    // No `runInit` at all — a bare project with a hand-authored, asymmetric
    // .artgraph.json but zero Tier 1 distribution on disk.
    write(proj.dir, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    );

    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-pool-protection-asymmetry");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeUndefined();
    // The empty-report short-circuit must still apply: zero findings, exit
    // code unaffected (same behavior as before this feature existed).
    expect(report.findings).toEqual([]);
    expect(report.summary.failCount).toBe(0);
  });

  it("does not fire for a symmetric config (both protected)", () => {
    runInit(proj.dir, {
      agents: ["claude"],
      noScan: true,
      noIntegrate: true,
      noHooks: true,
      force: true,
    });
    // runInit's default config already protects both pools.
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-pool-protection-asymmetry");
    expect(f).toBeUndefined();
  });

  it("does not fire for a symmetric config (neither protected)", () => {
    write(proj.dir, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
      }),
    );
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-pool-protection-asymmetry");
    expect(f).toBeUndefined();
  });

  it("M1: does not fire when the only asymmetric-looking pool is degenerate (all-negative)", () => {
    runInit(proj.dir, {
      agents: ["claude"],
      noScan: true,
      noIntegrate: true,
      noHooks: true,
      force: true,
    });
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        // include is all-negative (issue #266: matches nothing) — excluded
        // from judgment even though testPatterns is unprotected.
        include: ["!**/node_modules/**"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts"],
        agents: ["claude"],
      }),
    );
    const report = runDoctor({ rootDir: proj.dir });
    const f = findFinding(report.findings, (x) => x.kind === "config-pool-protection-asymmetry");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // L2 — the advisory must also fire via doctor's "backward mutation" path:
  // `detectedDescriptors` starts EMPTY (config.agents is `[]`, so Step 1's
  // config-agents cross-check loop iterates zero ids) and is grown ONLY by
  // the later `agent-installed-not-recorded` pass (an on-disk-but-unrecorded
  // agent gets pushed into `detectedDescriptors` there). The pool-protection
  // gate (`detectedDescriptors.length > 0`) is evaluated AFTER that push, so
  // it must still see the mutation and fire.
  // ---------------------------------------------------------------------
  it("L2: fires via the agent-installed-not-recorded backward-mutation path (detectedDescriptors starts empty, grown only by that later pass)", () => {
    runInit(proj.dir, {
      agents: ["claude"],
      noScan: true,
      noIntegrate: true,
      noHooks: true,
      force: true,
    });
    // config.agents is an explicit EMPTY array (defined, not undefined) —
    // Step 1's config-agents cross-check loop has nothing to iterate, so
    // `detectedDescriptors` starts at length 0. claude is installed on disk
    // but entirely unrecorded.
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
        agents: [],
      }),
    );

    const report = runDoctor({ rootDir: proj.dir });
    // Confirm the mutation path actually fired (sanity — proves
    // `detectedDescriptors` was grown by `agent-installed-not-recorded`, not
    // by Step 1).
    const installedNotRecorded = findFinding(
      report.findings,
      (x) => x.kind === "agent-installed-not-recorded" && x.agent === "claude",
    );
    expect(installedNotRecorded, JSON.stringify(report.findings, null, 2)).toBeDefined();

    const f = findFinding(report.findings, (x) => x.kind === "config-pool-protection-asymmetry");
    expect(f, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(f!.message).toContain("include");
    expect(report.summary.failCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (4) node-modules-in-scan `files` sample is pool-balanced
// ---------------------------------------------------------------------------

describe("node-modules-in-scan — pool-balanced files sample (issue #356)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("include matches many node_modules files, testPatterns matches exactly one — the testPatterns file must appear in the (cap 5) sample", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-356-sample-balance-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");

    // 6 plain include-pool matches under node_modules (neither pool negated),
    // deliberately named so alphabetical/discovery order puts them ALL ahead
    // of the lone testPatterns-only file below.
    for (let i = 0; i < 6; i++) {
      write(tmp, `node_modules/pkg/a-plain-${i}.ts`, "export const x = 1;\n");
    }
    // The ONLY file discoverable via the testPatterns pool.
    write(tmp, "node_modules/pkg/z-only.test.ts", `describe("[${"REQ-001"}] z", () => {});\n`);

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(tmp, config);
    const w = warnings.find((x) => x.type === "node-modules-in-scan");
    expect(w, JSON.stringify(warnings, null, 2)).toBeDefined();
    expect(w!.files.length).toBeLessThanOrEqual(5);
    expect(w!.files).toContain("node_modules/pkg/z-only.test.ts");
    // Sanity: the count in the message still reflects the FULL offending
    // set, not just the capped sample.
    expect(w!.message).toContain("7 scanned file(s)");
  });
});
