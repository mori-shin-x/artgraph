// spec 013 T013 — CLI error UX assertions for `--agents=<list>`.
//
// The error wording is part of the spec contract
// (specs/013-cross-agent-extensions/contracts/cli-flags.md §Error message
// spec, SC-006, A1 clarification). These tests are the canonical regression
// guard against silent wording drift.
//
// Implementation surface under test (already landed in Phase 2 Foundational):
//   - src/cli.ts        : AGENTS_REQUIRED_ERROR constant + missing-value gate
//   - src/agents/parse-agents.ts : per-token validation (uppercase, dup, empty,
//                                  unknown, empty CSV) with the "Did you mean
//                                  ...?" hint for case typos.
//
// Tests use the in-process `runCli` helper (the same shim
// `tests/cli.test.ts` uses) so we get fresh stderr per invocation without the
// ~150ms-per-spawn Node startup cost.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInit, runAt } from "./helpers.js";

describe("CLI: --agents error UX (spec 013 FR-001 / FR-002 / SC-006 / A1)", () => {
  let initTmp: string;

  beforeEach(() => {
    // Fresh tmp project so `init` validation doesn't bail on a pre-existing
    // `.artgraph.json`. We also drop one source file so the project looks
    // realistic enough to reach the agents-required gate.
    initTmp = mkdtempSync(join(tmpdir(), "artgraph-cli-err-"));
    mkdirSync(join(initTmp, "src"));
    writeFileSync(join(initTmp, "src", "app.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    rmSync(initTmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // FR-002 / SC-006: `init` with no args MUST emit the 3-option error.
  // The wording is asserted verbatim where the contract pins it (FR-001
  // supported-values list, three corrective options, example syntax).
  // ---------------------------------------------------------------------
  it("`artgraph init` without --agents fails with the 3-option error", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init"]);
    expect(exitCode).not.toBe(0);

    // Required line: opening ERROR with the flag name.
    expect(stderr).toContain("--agents=<list> is required");

    // Required line: supported values enumeration in the canonical order.
    expect(stderr).toContain("Supported values: claude, codex, copilot, cursor, kiro");

    // Required line: example flag form (FR-002 §a).
    expect(stderr).toContain("--agents=<list>");

    // Required line: §b corrective option (skip both stages).
    expect(stderr).toContain("--no-skills --no-agent-context");

    // Required line: §c corrective option (skip every extra stage).
    expect(stderr).toContain("--minimal");
  });

  // ---------------------------------------------------------------------
  // FR-001: unknown agent rejected with supported-values list (no hint).
  // ---------------------------------------------------------------------
  it("--agents=windsurf is rejected with the supported-values list", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents=windsurf"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown agent identifier(s): "windsurf"');
    expect(stderr).toContain("Supported values: claude, codex, copilot, cursor, kiro");
  });

  // ---------------------------------------------------------------------
  // A1: uppercase / mixed-case rejected with the "Did you mean ...?" hint
  // pointing at the lowercased form. No internal normalization.
  // ---------------------------------------------------------------------
  it("--agents=Claude (uppercase) rejected with a Did-you-mean hint", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents=Claude"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown agent identifier(s): "Claude"');
    expect(stderr).toContain('Did you mean "claude"?');
    expect(stderr).toContain("Supported values: claude, codex, copilot, cursor, kiro");
  });

  // ---------------------------------------------------------------------
  // FR-001 / cli-flags.md "Duplicate" row.
  // ---------------------------------------------------------------------
  it("--agents=claude,claude rejected with duplicate error", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents=claude,claude"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Duplicate agent identifier");
    expect(stderr).toContain('"claude"');
  });

  // ---------------------------------------------------------------------
  // FR-001 / cli-flags.md "Empty element" row — trailing comma.
  // ---------------------------------------------------------------------
  it("--agents=claude, (trailing comma) rejected with empty-element error", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents=claude,"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--agents=<list> requires at least one non-empty value/);
  });

  // ---------------------------------------------------------------------
  // FR-001 / cli-flags.md "Empty string" row — `--agents=` alone.
  // Commander treats `--agents=` as the empty string value.
  // ---------------------------------------------------------------------
  it("--agents= (empty string) rejected", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents="]);
    expect(exitCode).not.toBe(0);
    // Empty string travels through the parser as either the empty-CSV path
    // OR (on some commander versions) the missing-flag path. Both messages
    // are acceptable contracts here; assert on the canonical fragments.
    expect(stderr).toMatch(/--agents=<list> (requires at least one non-empty value|is required)/);
  });

  // ---------------------------------------------------------------------
  // E1: the "Did you mean ...?" hint must list EVERY uppercase/mixed-case
  // token, not just the first one that `.find` used to return.
  // ---------------------------------------------------------------------
  it("--agents=CLAUDE,CODEX (multi-uppercase) hints at both lowercased forms", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents=CLAUDE,CODEX"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown agent identifier(s): "CLAUDE", "CODEX"');
    expect(stderr).toContain('Did you mean "claude", "codex"?');
  });

  // ---------------------------------------------------------------------
  // E1: uppercase + duplicate-once-normalized must report BOTH problems in
  // a single error instead of staging them (uppercase error first, then a
  // separate duplicate error once the user "fixes" the case).
  // ---------------------------------------------------------------------
  it("--agents=Claude,claude reports the uppercase AND the case-normalized duplicate together", async () => {
    const { exitCode, stderr } = await runAt(initTmp, ["init", "--agents=Claude,claude"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown agent identifier(s): "Claude"');
    expect(stderr).toContain('Did you mean "claude"?');
    expect(stderr).toContain("Also duplicated once case is normalized");
    expect(stderr).toContain('"claude"');
  });
});

// ---------------------------------------------------------------------------
// issue #306 (PR #304 review F6/F7) — value-required options on GATE-relevant
// commands must reject option-like and (for paths) empty values at parse
// time. commander's required option-args are greedy, so `--ignore --gate`
// consumes `--gate` as the CSV and silently DISARMS the gate — the run then
// exits 0 with the issue printed but not judged (fail-open). Same class as
// spec 023's `--base --gate` guard (contracts/cli-check-base.md §1).
// Parse-time errors need no real project fixture — commander rejects the
// argv before the action ever runs — but we still run inside a tmp dir so a
// stray `.artgraph.json` in the repo can't leak in.
// ---------------------------------------------------------------------------
describe("CLI: gate-relevant option-value swallow guards (issue #306)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-306-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("check --diff --ignore --gate → parse error exit 1 (F6: gate must not be swallowed)", async () => {
    const { exitCode, stderr, stdout } = await runAt(tmp, [
      "check",
      "--diff",
      "--ignore",
      "--gate",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must not start with "-"');
    expect(stdout.trim()).toBe("");
  });

  it('check --diff --ignore "" stays legal (T178-4 contract preserved)', async () => {
    // Minimal git repo so the action reaches its normal "no changes" exit —
    // the point is the PARSER accepts the empty CSV (no InvalidArgumentError).
    gitInit(tmp);
    const { exitCode, stderr } = await runAt(tmp, ["check", "--diff", "--ignore", ""]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("must not be empty");
    expect(stderr).not.toContain('must not start with "-"');
  });

  it("check --diff --format --gate → parse error exit 1 (F7: swallowed flag rejected by choices)", async () => {
    const { exitCode, stderr } = await runAt(tmp, ["check", "--diff", "--format", "--gate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Allowed choices are json, text");
  });

  it("check --format bogus → exit 1 (F7: no more silent fall-through to text)", async () => {
    const { exitCode, stderr } = await runAt(tmp, ["check", "--format", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Allowed choices are json, text");
  });

  it("plan-coverage --tasks --gate → parse error exit 1 (was: gate silently disarmed, exit 0)", async () => {
    const { exitCode, stderr } = await runAt(tmp, ["plan-coverage", "--tasks", "--gate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must not start with "-"');
  });

  it('plan-coverage --spec "" --gate → parse error exit 1 (empty path can only be an unset variable)', async () => {
    const { exitCode, stderr } = await runAt(tmp, ["plan-coverage", "--spec", "", "--gate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("must not be empty");
  });

  it('plan-coverage --ignore --gate → parse error exit 1; --ignore "" stays legal', async () => {
    const swallowed = await runAt(tmp, ["plan-coverage", "--ignore", "--gate"]);
    expect(swallowed.exitCode).toBe(1);
    expect(swallowed.stderr).toContain('must not start with "-"');

    const empty = await runAt(tmp, ["plan-coverage", "--ignore", ""]);
    expect(empty.stderr).not.toContain("must not be empty");
    expect(empty.stderr).not.toContain('must not start with "-"');
  });

  it("plan-coverage --plan --gate → parse error exit 1", async () => {
    const { exitCode, stderr } = await runAt(tmp, ["plan-coverage", "--plan", "--gate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('must not start with "-"');
  });
});
