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
import { runAt } from "./helpers.js";

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
    expect(stderr).toContain("Supported values: claude, codex, cursor, copilot, kiro");

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
    expect(stderr).toContain("Supported values: claude, codex, cursor, copilot, kiro");
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
    expect(stderr).toContain("Supported values: claude, codex, cursor, copilot, kiro");
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
});
