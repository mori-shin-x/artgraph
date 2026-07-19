// issue #356 — custom `include` / `testPatterns` configs could leave one
// pool's node_modules protection out of sync with the other (issue #350's
// HIGH-2 gave each pool its OWN `"!**/node_modules/**"`-style negation, but
// nothing ever diagnosed a config that forgot to add it to only one of the
// two). Confirmed implementation plan (Step 0-pre + product owner sign-off):
//
//   (1) a shared helper `missingNodeModulesProtection` (`src/config.ts`) is
//       the single judge both surfaces below call into — fires ONLY on
//       asymmetry (one pool protected, the other not); both-protected and
//       both-unprotected both return `[]` (a symmetric config is an
//       intentional, indistinguishable choice — see docs/configuration.md).
//   (2) `artgraph scan` emits a SILENT (JSON-only) `config-pool-protection-
//       asymmetry` warning — silent because it fires on every scan of an
//       asymmetric config regardless of whether node_modules even exists,
//       which would be noisy on the default stderr presenter.
//   (3) `artgraph doctor` reports the same asymmetry as an advisory
//       (severity `pass`) finding, independent of Tier 1 agent detection,
//       never flipping the doctor exit code.
//   (4) the existing `node-modules-in-scan` warning's `files` sample (cap 5)
//       is now pool-balanced: any pool with offending files contributes at
//       least one sample entry, instead of unconditionally taking the first
//       5 in discovery order (which could omit a pool's sole offending file
//       entirely).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { missingNodeModulesProtection } from "../src/config.js";
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

  it('returns ["testPatterns"] when only include is protected', () => {
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual(["testPatterns"]);
  });

  it('returns ["include"] when only testPatterns is protected', () => {
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual(["include"]);
  });

  it("recognizes a node_modules negation nested under a non-root prefix (path-segment check, not just a trailing suffix)", () => {
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!packages/*/node_modules/**"],
        testPatterns: ["**/*.test.ts"],
      }),
    ).toEqual(["testPatterns"]);
  });

  it("does not false-positive on a literal file/dir named node_modules-like without the exact segment", () => {
    // "!**/node_modules_backup/**" does NOT contain "node_modules" as a whole
    // path segment (it's "node_modules_backup"), so it must NOT count as
    // protection.
    expect(
      missingNodeModulesProtection({
        include: ["src/**/*.ts", "!**/node_modules_backup/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      }),
    ).toEqual(["include"]);
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
