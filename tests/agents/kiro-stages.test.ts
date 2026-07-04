// spec 013 T014 (C1 remediation) — Kiro 2-stage independence.
//
// Goal: prove that `--agents=kiro` (Skills stage, T010 wiring) and
// `--integrations=kiro` (existing KiroProvider stage) are independent
// responsibilities. Each stage owns one path under `.kiro/`:
//
//   Skills stage      → `.kiro/skills/...`        (this spec)
//   Integrate stage   → `.kiro/steering/artgraph.md` (spec 009 KiroProvider)
//
// FR-008 requires that both can fire in the same `init` invocation without
// either touching the other's target. Neither stage's success/failure
// affects the other's execution.
//
// Implementation note:
//   - The Skills-stage half of these scenarios uses `distribute()` directly
//     because the CLI wiring (T010) is implemented by a separate sub-agent
//     after this test file is committed. Calling `distribute()` exercises
//     the exact same code path the wired CLI will reach, so the
//     orthogonality contract is verified at the unit/contract level today
//     and remains valid once T010 wires it through `runInit`.
//   - The Integrate-stage half uses the real CLI (`runAt(tmp, [...])`) so
//     `.kiro/steering/artgraph.md` is exercised end-to-end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_DESCRIPTORS,
  type AgentDescriptor,
} from "../../src/agents/descriptors.js";
import { distribute } from "../../src/agents/distribute.js";
import { readSkillSource } from "../../src/agents/source.js";
import { runAt } from "../helpers.js";

const REPO_TEMPLATES_DIR = resolve(
  import.meta.dirname,
  "..",
  "..",
  "templates",
  "skills",
);

const KIRO_DESCRIPTOR: AgentDescriptor = AGENT_DESCRIPTORS.find(
  (d) => d.id === "kiro",
)!;

const KIRO_SKILLS_REL = ".kiro/skills";
const KIRO_STEERING_REL = ".kiro/steering/artgraph.md";

describe("spec 013 FR-008 — Kiro Skills vs Integrate stage independence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-spec013-kiro-"));
    // Pre-create `.kiro/` so KiroProvider.detect() returns true (the
    // integration provider gate requires the marker directory to exist).
    mkdirSync(join(tmp, ".kiro"), { recursive: true });
    // Drop a source file so `init`'s scan stage has something to walk.
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // Scenario (a) — Both stages run, both targets populated.
  //
  // We hand-execute the two stages back-to-back to mirror what the wired
  // CLI does (Skills stage first, then integrate). Asserting both targets
  // land proves the two responsibilities co-exist without interference.
  // -------------------------------------------------------------------
  it("(a) distribute(kiro) + integrate=kiro both land", async () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    const result = distribute(KIRO_DESCRIPTOR, source, { rootDir: tmp });

    // Skills stage wrote SKILL.md(s) + `_shared/` fragments.
    expect(result.writtenPaths.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, KIRO_SKILLS_REL, "artgraph-impact", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, KIRO_SKILLS_REL, "_shared", "install-check.md"))).toBe(true);

    // Integrate stage: drive the real CLI so `.kiro/steering/artgraph.md` is
    // produced via the existing KiroProvider end-to-end. We pair it with
    // `--no-skills --no-agent-context` so the run does NOT require
    // `--agents` (which would loop back into the same Skills stage we
    // already exercised above).
    const integrate = await runAt(tmp, [
      "init",
      "--no-scan",
      "--integrations=kiro",
      "--no-skills",
      "--no-agent-context",
    ]);
    expect(integrate.exitCode).toBe(0);
    expect(existsSync(join(tmp, KIRO_STEERING_REL))).toBe(true);

    // Skills tree is untouched by the integrate run.
    expect(existsSync(join(tmp, KIRO_SKILLS_REL, "artgraph-impact", "SKILL.md"))).toBe(true);
  });

  // -------------------------------------------------------------------
  // Scenario (b) — Skills stage alone never writes `.kiro/steering/`.
  // distribute() must never touch the integrate target (FR-008).
  // -------------------------------------------------------------------
  it("(b) distribute(kiro) alone does NOT write .kiro/steering/", () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    distribute(KIRO_DESCRIPTOR, source, { rootDir: tmp });

    expect(existsSync(join(tmp, KIRO_SKILLS_REL, "artgraph-impact", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, KIRO_STEERING_REL))).toBe(false);
    expect(existsSync(join(tmp, ".kiro", "steering"))).toBe(false);
  });

  // -------------------------------------------------------------------
  // Scenario (c) — Integrate stage alone never writes `.kiro/skills/`.
  // Drives the CLI with both stages disabled except for `--integrations=kiro`.
  // -------------------------------------------------------------------
  it("(c) --integrations=kiro alone does NOT write .kiro/skills/", async () => {
    const { exitCode } = await runAt(tmp, [
      "init",
      "--no-scan",
      "--integrations=kiro",
      "--no-skills",
      "--no-agent-context",
    ]);
    expect(exitCode).toBe(0);

    expect(existsSync(join(tmp, KIRO_STEERING_REL))).toBe(true);
    // No skills directory was created anywhere under `.kiro/`.
    expect(existsSync(join(tmp, KIRO_SKILLS_REL))).toBe(false);
  });

  // -------------------------------------------------------------------
  // Scenario (d) — Idempotent re-run for both stages. Two distribute()
  // calls produce no writes the second time; two integrate calls produce
  // a noop result.
  // -------------------------------------------------------------------
  it("(d) repeated runs of both stages are idempotent (no destructive churn)", async () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);

    // Skills: 1st pass writes everything; 2nd pass writes nothing.
    const first = distribute(KIRO_DESCRIPTOR, source, { rootDir: tmp });
    expect(first.writtenPaths.length).toBeGreaterThan(0);
    expect(first.noopPaths.length).toBe(0);

    const second = distribute(KIRO_DESCRIPTOR, source, { rootDir: tmp });
    expect(second.writtenPaths.length).toBe(0);
    expect(second.noopPaths.length).toBe(first.targets.length);

    // Integrate: 1st pass writes the steering file; 2nd pass is a noop
    // (the existing KiroProvider implementation reads the on-disk content
    // and returns `noop: true` when it matches the template).
    const integrateA = await runAt(tmp, [
      "init",
      "--no-scan",
      "--integrations=kiro",
      "--no-skills",
      "--no-agent-context",
    ]);
    expect(integrateA.exitCode).toBe(0);
    expect(existsSync(join(tmp, KIRO_STEERING_REL))).toBe(true);
    const firstSteering = readFileSync(join(tmp, KIRO_STEERING_REL), "utf-8");

    const integrateB = await runAt(tmp, [
      "init",
      "--force", // bypass ".artgraph.json already exists"
      "--no-scan",
      "--integrations=kiro",
      "--no-skills",
      "--no-agent-context",
    ]);
    expect(integrateB.exitCode).toBe(0);

    // Steering file content is unchanged after the second integrate run.
    expect(readFileSync(join(tmp, KIRO_STEERING_REL), "utf-8")).toBe(firstSteering);
  });

  // -------------------------------------------------------------------
  // Scenario (e) — Independence under partial failure. distribute()
  // failing (e.g. a drifted SKILL.md without --force) does NOT prevent
  // the integrate stage from succeeding when invoked separately. This
  // is the FR-008 "両 stage が独立に試行" contract.
  //
  // We simulate this by:
  //   1. Pre-populating a drifted file at `.kiro/skills/artgraph-impact/SKILL.md`
  //   2. Verify distribute() throws (without --force).
  //   3. Verify integrate stage (driven by the CLI) still succeeds and
  //      writes `.kiro/steering/artgraph.md`.
  // -------------------------------------------------------------------
  it("(e) integrate stage runs even when Skills stage would fail (independence)", async () => {
    // Plant a drifted file under .kiro/skills/ so distribute(force=false)
    // throws on this target.
    const drifted = join(
      tmp,
      KIRO_SKILLS_REL,
      "artgraph-impact",
      "SKILL.md",
    );
    mkdirSync(join(tmp, KIRO_SKILLS_REL, "artgraph-impact"), { recursive: true });
    writeFileSync(drifted, "user-edited\n", "utf-8");

    const source = readSkillSource(REPO_TEMPLATES_DIR);
    expect(() =>
      distribute(KIRO_DESCRIPTOR, source, { rootDir: tmp }),
    ).toThrow(); // drift conflict, no --force

    // The drifted file is untouched (no rollback corruption).
    expect(readFileSync(drifted, "utf-8")).toBe("user-edited\n");

    // Integrate stage runs independently and succeeds.
    const { exitCode } = await runAt(tmp, [
      "init",
      "--no-scan",
      "--integrations=kiro",
      "--no-skills",
      "--no-agent-context",
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(join(tmp, KIRO_STEERING_REL))).toBe(true);
  });
});
