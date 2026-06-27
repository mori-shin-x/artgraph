import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import * as atomicWriteMod from "../src/integrate/atomic-write.js";
import { SpecKitProvider } from "../src/integrate/providers/speckit.js";
import { runAt } from "./helpers.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures/integrate");

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], cwd: string): Promise<SpawnResult> {
  // Delegate to the shared in-process helper so each call avoids the
  // ~150–300 ms Node spawn + ts-morph reload that this file used to pay
  // per invocation. The SC-004 wall-clock budget tests still spawn the
  // real bin — they live in tests/perf/ and run under vitest.perf.config.ts.
  return runAt(cwd, args);
}

const SEED_EXTENSIONS_YAML = `installed:
- agent-context
settings:
  auto_execute_hooks: true
hooks:
  after_specify:
  - extension: agent-context
    command: speckit.agent-context.update
    enabled: true
    optional: true
    priority: 10
    prompt: Execute speckit.agent-context.update?
    description: Refresh agent context after specification
    condition: null
`;

function seedSpecKitRepo(root: string): void {
  mkdirSync(join(root, ".specify"), { recursive: true });
  writeFileSync(join(root, ".specify/extensions.yml"), SEED_EXTENSIONS_YAML);
}

describe("E2E: artgraph integrate speckit — quickstart Scenario 1", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us1-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Step 1: integrates on a fresh .specify/ repo", async () => {
    seedSpecKitRepo(tmp);
    const r = await runCli(["integrate", "speckit"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Integrated: speckit (Spec Kit)");
    expect(r.stdout).toMatch(/Created \(/);
    expect(r.stdout).toMatch(/Modified \(/);

    // Extension dir + commands generated
    expect(existsSync(join(tmp, ".specify/extensions/artgraph/extension.yml"))).toBe(true);
    expect(existsSync(join(tmp, ".specify/extensions/artgraph/README.md"))).toBe(true);
    expect(
      existsSync(join(tmp, ".specify/extensions/artgraph/commands/artgraph.scan-reconcile.md")),
    ).toBe(true);
    expect(
      existsSync(join(tmp, ".specify/extensions/artgraph/commands/artgraph.check-diff.md")),
    ).toBe(true);
    expect(
      existsSync(join(tmp, ".specify/extensions/artgraph/commands/artgraph.check-gate.md")),
    ).toBe(true);

    // extensions.yml has installed: artgraph + after_tasks/after_implement hooks
    const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(yml).toMatch(/installed:[\s\S]*- artgraph/);
    expect(yml).toMatch(/after_tasks:/);
    expect(yml).toMatch(/after_implement:/);
    // Other extension's entry preserved
    expect(yml).toMatch(/command: speckit\.agent-context\.update/);
    // M-H1 regression: must be block style YAML, not single-line flow style.
    // (The seed `hooks: {}` previously caused the entire hooks block to be
    // emitted as `hooks: { after_tasks: [ ... ] }` on one line.)
    expect(yml).not.toMatch(/hooks:\s*\{/);
    expect(yml).toMatch(
      /hooks:\n {2}(?:[a-z_]+:\n {2}- extension: [a-z-]+\n[\s\S]+?)*after_tasks:\n {2}- extension: artgraph\n/,
    );
  });

  it("Step 2: idempotent re-run — second invocation reports 'Already integrated' and disk unchanged", async () => {
    seedSpecKitRepo(tmp);
    const r1 = await runCli(["integrate", "speckit"], tmp);
    expect(r1.exitCode).toBe(0);
    const ymlAfter1 = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    const extAfter1 = readFileSync(
      join(tmp, ".specify/extensions/artgraph/extension.yml"),
      "utf-8",
    );

    const r2 = await runCli(["integrate", "speckit"], tmp);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("✓ Already integrated: speckit (Spec Kit) — no changes");
    const ymlAfter2 = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    const extAfter2 = readFileSync(
      join(tmp, ".specify/extensions/artgraph/extension.yml"),
      "utf-8",
    );
    expect(ymlAfter2).toBe(ymlAfter1);
    expect(extAfter2).toBe(extAfter1);
  });

  it("Step 3: --gate adds a before_implement hook entry", async () => {
    seedSpecKitRepo(tmp);
    await runCli(["integrate", "speckit"], tmp);
    const r = await runCli(["integrate", "speckit", "--gate"], tmp);
    expect(r.exitCode).toBe(0);
    const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(yml).toMatch(/before_implement:/);
    expect(yml).toMatch(/command: artgraph\.check-gate/);
  });

  it("Step 4: --no-gate removes only artgraph's before_implement entry, preserving others", async () => {
    seedSpecKitRepo(tmp);
    // Inject an additional non-artgraph before_implement entry so we can
    // verify it survives the --no-gate removal.
    writeFileSync(
      join(tmp, ".specify/extensions.yml"),
      `installed:
- agent-context
settings:
  auto_execute_hooks: true
hooks:
  before_implement:
  - extension: agent-context
    command: speckit.agent-context.warm
    enabled: true
    optional: true
    priority: 10
    prompt: warm?
    description: x
    condition: null
`,
    );

    // First add gate, then remove it.
    await runCli(["integrate", "speckit", "--gate"], tmp);
    const r = await runCli(["integrate", "speckit", "--no-gate"], tmp);
    expect(r.exitCode).toBe(0);
    const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    // M-H5: parse the YAML and assert structural shape. The previous regex
    // crossed trigger boundaries, so a bug that nuked the whole
    // before_implement array would still pass.
    const parsed = parseYaml(yml) as {
      hooks: {
        before_implement?: Array<{ extension: string; command: string }>;
        after_tasks?: Array<{ extension: string; command: string }>;
        after_implement?: Array<{ extension: string; command: string }>;
      };
    };
    expect(parsed.hooks.before_implement).toBeDefined();
    expect(parsed.hooks.before_implement).toHaveLength(1);
    expect(parsed.hooks.before_implement![0]!.extension).toBe("agent-context");
    expect(parsed.hooks.before_implement![0]!.command).toBe("speckit.agent-context.warm");
    expect(parsed.hooks.after_tasks?.some((e) => e.extension === "artgraph")).toBe(true);
    expect(parsed.hooks.after_implement?.some((e) => e.extension === "artgraph")).toBe(true);
  });

  it("Step 5: --uninstall removes installed marker, extension dir, and all artgraph hooks", async () => {
    seedSpecKitRepo(tmp);
    await runCli(["integrate", "speckit"], tmp);
    expect(existsSync(join(tmp, ".specify/extensions/artgraph"))).toBe(true);
    const r = await runCli(["integrate", "speckit", "--uninstall"], tmp);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(tmp, ".specify/extensions/artgraph"))).toBe(false);
    const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(yml).not.toMatch(/- artgraph/);
    expect(yml).not.toMatch(/extension: artgraph/);
    // The original agent-context entry is unchanged.
    expect(yml).toMatch(/command: speckit\.agent-context\.update/);
  });

  it("fails (exit 1) when .specify/ is absent, leaving disk unchanged", async () => {
    const r = await runCli(["integrate", "speckit"], tmp);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not detected/i);
    // Nothing was written
    expect(existsSync(join(tmp, ".specify"))).toBe(false);
  });

  it("--format=json emits a parseable IntegrateResult", async () => {
    seedSpecKitRepo(tmp);
    const r = await runCli(["integrate", "speckit", "--format", "json"], tmp);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.providerId).toBe("speckit");
    expect(Array.isArray(parsed.created)).toBe(true);
    expect(Array.isArray(parsed.modified)).toBe(true);
    expect(typeof parsed.noop).toBe("boolean");
  });
});

function seedKiroRepo(root: string): void {
  mkdirSync(join(root, ".kiro/steering"), { recursive: true });
}

describe("E2E: artgraph integrate kiro — quickstart Scenario 2", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us2-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("Step 1: integrates on a fresh .kiro/ repo (creates .kiro/steering/artgraph.md)", async () => {
    seedKiroRepo(tmp);
    const r = await runCli(["integrate", "kiro"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Integrated: kiro (Kiro)");
    expect(r.stdout).toMatch(/Created \(1\):/);
    expect(r.stdout).toContain(".kiro/steering/artgraph.md");

    const dest = join(tmp, ".kiro/steering/artgraph.md");
    expect(existsSync(dest)).toBe(true);
    const body = readFileSync(dest, "utf-8");
    expect(body).toMatch(/artgraph — Kiro integration/);
    expect(body).toMatch(/## When to run artgraph/);
    expect(body).toMatch(/artgraph impact/);
    expect(body).toMatch(/artgraph check --diff/);
    expect(body).toMatch(/artgraph reconcile/);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("Step 2: idempotent re-run — second invocation reports 'Already integrated' and disk unchanged", async () => {
    seedKiroRepo(tmp);
    const r1 = await runCli(["integrate", "kiro"], tmp);
    expect(r1.exitCode).toBe(0);
    const before = readFileSync(join(tmp, ".kiro/steering/artgraph.md"), "utf-8");

    const r2 = await runCli(["integrate", "kiro"], tmp);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("✓ Already integrated: kiro (Kiro) — no changes");
    const after = readFileSync(join(tmp, ".kiro/steering/artgraph.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("Step 3: --force regenerates a hand-edited artgraph.md (Modified, not Created)", async () => {
    seedKiroRepo(tmp);
    const dest = join(tmp, ".kiro/steering/artgraph.md");
    writeFileSync(dest, "# manually edited\n");

    const r = await runCli(["integrate", "kiro", "--force"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ Integrated: kiro (Kiro)");
    expect(r.stdout).toMatch(/Modified \(1\):/);
    expect(r.stdout).toContain(".kiro/steering/artgraph.md");

    const body = readFileSync(dest, "utf-8");
    expect(body).not.toContain("manually edited");
    expect(body).toMatch(/artgraph — Kiro integration/);
  });

  it("Step 4: fails (exit 1) when .kiro/ is absent, leaving disk unchanged", async () => {
    const r = await runCli(["integrate", "kiro"], tmp);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Kiro not detected/i);
    expect(existsSync(join(tmp, ".kiro"))).toBe(false);
  });

  it("--format=json emits a parseable IntegrateResult", async () => {
    seedKiroRepo(tmp);
    const r = await runCli(["integrate", "kiro", "--format", "json"], tmp);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.providerId).toBe("kiro");
    expect(parsed.created).toContain(".kiro/steering/artgraph.md");
    expect(parsed.noop).toBe(false);
  });

  it("warns (but exits 0) on a hand-edited artgraph.md without --force", async () => {
    seedKiroRepo(tmp);
    const dest = join(tmp, ".kiro/steering/artgraph.md");
    writeFileSync(dest, "# user wrote this\n");

    const r = await runCli(["integrate", "kiro"], tmp);
    expect(r.exitCode).toBe(0);
    // No changes were made to the file
    expect(readFileSync(dest, "utf-8")).toBe("# user wrote this\n");
    // A warning surfaces in stdout (text format) so the user understands why
    // nothing changed.
    expect(r.stdout).toMatch(/Warnings/i);
    expect(r.stdout).toMatch(/--force/);
  });
});

// ---------------------------------------------------------------------------
// US3 — Scenario 3: integrate list
// ---------------------------------------------------------------------------

// T007 (spec 012-skills-expansion): `integrate list` must surface every
// registered provider (speckit, kiro) with correct detected/installed flags.
// Coverage below is sufficient — no new tests required.
describe("E2E: artgraph integrate list — quickstart Scenario 3", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us3-list-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists both providers in registration order on an empty repo (all not detected)", async () => {
    const r = await runCli(["integrate", "list"], tmp);
    expect(r.exitCode).toBe(0);
    // Text format: header + speckit row above kiro row (registration order).
    expect(r.stdout).toMatch(/Available integrations:/);
    const speckitIdx = r.stdout.indexOf("speckit");
    const kiroIdx = r.stdout.indexOf("kiro");
    expect(speckitIdx).toBeGreaterThanOrEqual(0);
    expect(kiroIdx).toBeGreaterThan(speckitIdx);
    expect(r.stdout).toMatch(/detected:\s*no/);
  });

  it("reflects detect+install state for both providers", async () => {
    seedSpecKitRepo(tmp);
    seedKiroRepo(tmp);
    // Integrate speckit so installed=yes for that one.
    await runCli(["integrate", "speckit"], tmp);

    const r = await runCli(["integrate", "list"], tmp);
    expect(r.exitCode).toBe(0);
    // speckit: detected yes, installed yes
    expect(r.stdout).toMatch(/speckit[\s\S]*detected:\s*yes[\s\S]*installed:\s*yes/);
    // kiro: detected yes, installed no, plus a "run" hint
    expect(r.stdout).toMatch(/kiro[\s\S]*detected:\s*yes[\s\S]*installed:\s*no/);
    expect(r.stdout).toMatch(/artgraph integrate kiro/);
  });

  it("emits a JSON payload matching the IntegrationStatus[] schema", async () => {
    seedSpecKitRepo(tmp);
    const r = await runCli(["integrate", "list", "--format", "json"], tmp);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      providers: Array<{
        id: string;
        displayName: string;
        marker: string;
        detected: boolean;
        installed: boolean;
      }>;
    };
    expect(Array.isArray(parsed.providers)).toBe(true);
    expect(parsed.providers.map((p) => p.id)).toEqual(["speckit", "kiro"]);
    const speckit = parsed.providers.find((p) => p.id === "speckit")!;
    expect(speckit.displayName).toBe("Spec Kit");
    expect(speckit.marker).toBe(".specify");
    expect(speckit.detected).toBe(true);
    expect(speckit.installed).toBe(false);
    const kiro = parsed.providers.find((p) => p.id === "kiro")!;
    expect(kiro.detected).toBe(false);
    expect(kiro.installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US3 — Scenario 5: init Tip output (FR-012 / FR-013)
// ---------------------------------------------------------------------------

describe("E2E: artgraph init — integrate Tip lines (Scenario 5)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us3-tip-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Tip lines fire only when init's integrate stage is suppressed (auto-integrate
  // under default would already wire the tool up, removing the need for the Tip).
  // The Tip flow is preserved for `--no-integrate` and `--minimal` runs.

  it("shows a Tip when Spec Kit is detected but not yet integrated (--no-integrate)", async () => {
    mkdirSync(join(tmp, ".specify"));
    const r = await runCli(["init", "--no-scan", "--no-integrate"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Tip:\s*Spec Kit detected\..*artgraph integrate speckit/);
  });

  it("suppresses the Spec Kit Tip once the integration is installed", async () => {
    seedSpecKitRepo(tmp);
    // Install artgraph into the Spec Kit project first.
    await runCli(["integrate", "speckit"], tmp);
    // Now re-run init — the Tip line must not appear (already installed).
    const r = await runCli(["init", "--no-scan", "--no-integrate", "--force"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/Tip:\s*Spec Kit detected/);
  });

  it("shows separate Tip lines for both Spec Kit and Kiro when both are detected (--no-integrate)", async () => {
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    const r = await runCli(["init", "--no-scan", "--no-integrate"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Tip:\s*Spec Kit detected/);
    expect(r.stdout).toMatch(/Tip:\s*Kiro detected/);
  });
});

// ---------------------------------------------------------------------------
// US3 — Scenario 4: init --integrate=<tools> one-shot
// ---------------------------------------------------------------------------

describe("E2E: artgraph init --integrations — one-shot integration (Scenario 4)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us3-oneshot-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs only the requested provider with --integrate=speckit", async () => {
    seedSpecKitRepo(tmp);
    const r = await runCli(["init", "--no-scan", "--integrations", "speckit"], tmp);
    expect(r.exitCode).toBe(0);
    // Section heading
    expect(r.stdout).toMatch(/=== Integration: speckit ===/);
    // speckit files were generated
    expect(existsSync(join(tmp, ".specify/extensions/artgraph/extension.yml"))).toBe(true);
    // No kiro section
    expect(r.stdout).not.toMatch(/=== Integration: kiro ===/);
  });

  it("runs only the requested provider with --integrate=kiro", async () => {
    mkdirSync(join(tmp, ".kiro"));
    const r = await runCli(["init", "--no-scan", "--integrations", "kiro"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/=== Integration: kiro ===/);
    expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
    expect(r.stdout).not.toMatch(/=== Integration: speckit ===/);
  });

  it("runs every detected provider with --integrate=all and shows per-tool sections", async () => {
    seedSpecKitRepo(tmp);
    mkdirSync(join(tmp, ".kiro"));
    const r = await runCli(["init", "--no-scan", "--integrations", "all"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/=== Integration: speckit ===/);
    expect(r.stdout).toMatch(/=== Integration: kiro ===/);
    // Both providers produced output (file written).
    expect(existsSync(join(tmp, ".specify/extensions/artgraph/extension.yml"))).toBe(true);
    expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
    // Section ordering: speckit appears before kiro (registry order).
    const sp = r.stdout.indexOf("=== Integration: speckit ===");
    const ki = r.stdout.indexOf("=== Integration: kiro ===");
    expect(sp).toBeGreaterThan(-1);
    expect(ki).toBeGreaterThan(sp);
  });

  it("warns and skips (but still exits 0) when an unrequested provider is missing", async () => {
    // Only kiro on disk; ask for both → kiro succeeds, speckit warns.
    mkdirSync(join(tmp, ".kiro"));
    const r = await runCli(["init", "--no-scan", "--integrations", "speckit,kiro"], tmp);
    expect(r.exitCode).toBe(0);
    // Warning is surfaced for the missing tool (either id or displayName).
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/WARNING.*(speckit|Spec Kit).*not detected/i);
    // kiro still runs successfully.
    expect(r.stdout).toMatch(/=== Integration: kiro ===/);
    expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
  });

  it("propagates --integrate-gate to the speckit provider", async () => {
    seedSpecKitRepo(tmp);
    const r = await runCli(["init", "--no-scan", "--integrations", "speckit", "--integrate-gate"], tmp);
    expect(r.exitCode).toBe(0);
    const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(yml).toMatch(/before_implement:/);
    expect(yml).toMatch(/command:\s*artgraph\.check-gate/);
  });

  it("ignores --integrate-gate for non-speckit providers without warning or error", async () => {
    mkdirSync(join(tmp, ".kiro"));
    const r = await runCli(["init", "--no-scan", "--integrations", "kiro", "--integrate-gate"], tmp);
    expect(r.exitCode).toBe(0);
    // kiro still installed normally
    expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
  });

  // M-H2 regression: `--force` on the outer `init` command must reach the
  // integration provider, otherwise a drifted extension/steering file silently
  // survives. This violates FR-024 (`--force` is supposed to overwrite
  // anything the init touches, including the one-shot integrations).
  it("propagates --force to the integration provider (overwrites drifted extension.yml)", async () => {
    cpSync(join(FIXTURES, "specify-with-drift"), tmp, { recursive: true });
    const extYmlPath = join(tmp, ".specify/extensions/artgraph/extension.yml");
    // Sanity: fixture really is drifted.
    expect(readFileSync(extYmlPath, "utf-8")).toMatch(/USER EDITED/);

    const r = await runCli(["init", "--no-scan", "--integrations", "speckit", "--force"], tmp);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/=== Integration: speckit ===/);

    // The hand-edited content is gone; canonical template took its place.
    const after = readFileSync(extYmlPath, "utf-8");
    expect(after).not.toMatch(/USER EDITED/);
    expect(after).not.toMatch(/0\.0\.0-drift/);
    expect(after).toMatch(/id:\s*artgraph/);
    expect(after).toMatch(/artgraph\.scan-reconcile/);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — Scenario 6: rollback (T055)
//
// The quickstart admits this scenario is hard to reproduce end-to-end via a
// child process (we cannot mock `fs.renameSync` across the spawn boundary).
// We exercise the *same* SpecKitProvider.install path that the CLI handler
// invokes, mock `atomicWriteFile` so the second write throws, and assert
// that every previously-created file was rolled back and the on-disk state
// matches the pre-install snapshot.
// ---------------------------------------------------------------------------

describe("E2E: SpecKitProvider rollback on partial failure — quickstart Scenario 6", () => {
  let tmp: string;
  let provider: SpecKitProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-rollback-"));
    provider = new SpecKitProvider();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rolls back every prior write when the second atomicWriteFile call throws", () => {
    // Seed a real Spec Kit repo so detect() passes.
    cpSync(join(FIXTURES, "specify-empty"), tmp, { recursive: true });

    // Snapshot the pre-install state so we can compare byte-for-byte.
    const ymlBefore = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(existsSync(join(tmp, ".specify/extensions/artgraph"))).toBe(false);

    // Spy on the atomic-write namespace so we can fail the *second* successful
    // write. We use call==2 so the first file is on disk when the throw fires
    // (this is the precise "mid-way failure" the quickstart describes).
    let call = 0;
    const real = atomicWriteMod.atomicWriteFile;
    const spy = vi
      .spyOn(atomicWriteMod, "atomicWriteFile")
      .mockImplementation((dest: string, content: string) => {
        call++;
        if (call === 2) {
          throw new Error("simulated EACCES on second file");
        }
        return real(dest, content);
      });

    expect(() => provider.install(tmp, {})).toThrow(/simulated|EACCES/);
    spy.mockRestore();

    // The whole extension dir created by install() should be reversed.
    expect(existsSync(join(tmp, ".specify/extensions/artgraph"))).toBe(false);

    // extensions.yml must be byte-for-byte identical to the seed (the YAML
    // edit happens after the file writes, so it should never have changed
    // here — but we assert it explicitly to lock in the contract).
    const ymlAfter = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(ymlAfter).toBe(ymlBefore);
  });

  it("rolls back the extensions.yml edit too when the YAML write fails after files were created", () => {
    cpSync(join(FIXTURES, "specify-empty"), tmp, { recursive: true });
    const ymlBefore = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");

    // Let the 5 EXT_FILES writes succeed (calls 1..5), fail on the 6th
    // which is the extensions.yml atomic-write. The provider must reverse
    // every previously-created file before re-throwing.
    let call = 0;
    const real = atomicWriteMod.atomicWriteFile;
    const spy = vi
      .spyOn(atomicWriteMod, "atomicWriteFile")
      .mockImplementation((dest: string, content: string) => {
        call++;
        if (call === 6) {
          throw new Error("simulated EACCES on extensions.yml");
        }
        return real(dest, content);
      });

    expect(() => provider.install(tmp, {})).toThrow(/simulated|EACCES/);
    spy.mockRestore();

    // The extension dir + every file inside it must be gone.
    expect(existsSync(join(tmp, ".specify/extensions/artgraph"))).toBe(false);
    // extensions.yml byte-for-byte unchanged.
    expect(readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8")).toBe(ymlBefore);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — T063: SC-006 / FR-017 gate halt verification
//
// After `artgraph integrate speckit --gate` registers the before_implement
// hook, calling the actual `artgraph check --gate` command on a repo that
// has uncovered REQs must exit with code 2 and surface a reconcile hint —
// this is the exact condition that stops Spec Kit's /speckit-implement
// workflow.
// ---------------------------------------------------------------------------

describe("E2E: artgraph check --gate halts on uncovered REQs (SC-006 / FR-017)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-gate-halt-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 2 from `check --gate` after `integrate speckit --gate` registers the hook", async () => {
    // (a) Stage the gate-failure fixture (uncovered REQs + seeded extensions.yml).
    cpSync(join(FIXTURES, "specify-with-gate-failure"), tmp, { recursive: true });

    // (b) Install the artgraph gate via `integrate speckit --gate`. We also
    // run `init --no-scan` so .artgraph.json exists for subsequent scan/check.
    const integrate = await runCli(
      ["init", "--no-scan", "--integrations", "speckit", "--integrate-gate"],
      tmp,
    );
    expect(integrate.exitCode).toBe(0);
    // The gate hook is registered in extensions.yml.
    const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
    expect(yml).toMatch(/before_implement:/);
    expect(yml).toMatch(/command:\s*artgraph\.check-gate/);

    // (c) Run the *exact* command Spec Kit's before_implement hook would fire.
    const gate = await runCli(["check", "--gate"], tmp);

    // (d) Halt condition: exit code 2 (artgraph's gate-fail signal) — this is
    // what stops Spec Kit /speckit-implement (FR-017 / SC-006).
    expect(gate.exitCode).toBe(2);
    // stdout enumerates the failing artifacts so the user can act.
    expect(gate.stdout).toMatch(/UNCOVERED:/);
    expect(gate.stdout).toMatch(/GATE-001/);
    expect(gate.stdout).toMatch(/GATE-002/);
  });

  it("`check --gate` JSON output exposes the failing artifacts for downstream hook consumers", async () => {
    cpSync(join(FIXTURES, "specify-with-gate-failure"), tmp, { recursive: true });
    await runCli(["init", "--no-scan", "--integrations", "speckit", "--integrate-gate"], tmp);
    const gate = await runCli(["check", "--gate", "--format", "json"], tmp);
    expect(gate.exitCode).toBe(2);
    const parsed = JSON.parse(gate.stdout);
    expect(parsed.pass).toBe(false);
    expect(Array.isArray(parsed.uncovered)).toBe(true);
    // M-M13: exact comparison so a future fixture / parser change that
    // smuggles extra "uncovered" entries into the list is caught immediately
    // (the previous `arrayContaining` would have silently accepted them).
    expect(parsed.uncovered.slice().sort()).toEqual(["GATE-001", "GATE-002"]);
  });
});

// SC-004 wall-clock budget tests moved to `tests/perf/integrate-detect.perf.test.ts`.
// They run under `vitest.perf.config.ts` in a single forked process so the
// spawned bin owns the CPU during measurement.
