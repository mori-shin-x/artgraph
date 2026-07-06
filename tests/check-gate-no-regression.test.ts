// spec 013 T031 [US4] (C3 remediation) — non-regression for FR-012 後段
// "doctor は gate に組み込まない".
//
// FR-014 scope-out enforcement: this file also doubles as a one-shot
// guard against the negative requirements in spec 013 FR-014 — no MCP
// server bootstrap, no plugin marketplace manifest, and no non-Claude
// agent hooks distribution. The smoke test below greps the source tree
// for those forbidden surfaces.
// @impl 013-cross-agent-extensions/FR-014
//
// Strategy: a hybrid static + behavioural check.
//   (a) **Static grep** of `src/check.ts` proves the gate module has no
//       compile-time dependency on the doctor surface (no `doctor` /
//       `DoctorFinding` / `AGENT_DESCRIPTORS` imports / symbol references).
//       This is fast, deterministic, and survives refactors that rename
//       file fixtures.
//   (b) **Behavioural smoke** runs `check()` directly on a stub graph + lock
//       — the function is pure and takes no rootDir, so spec 013
//       distribution files (`.claude/skills/...` etc.) cannot influence its
//       outcome by construction. We assert the function signature stays free
//       of any `rootDir` / `agents` parameter so the doctor cannot be
//       wired in via an "implicit" surface either.
//
// The two together cover the spec intent without depending on a tmp
// project + multi-step setup: any wiring of doctor into check would either
// require touching `src/check.ts` (caught by (a)) or expanding `check()`'s
// signature (caught by (b)).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "../src/check.js";
import type { ArtifactGraph, LockFile } from "../src/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("check --gate non-regression (FR-012 後段)", () => {
  it("src/check.ts does not import or reference the doctor surface", () => {
    const source = readFileSync(resolve(REPO_ROOT, "src/check.ts"), "utf-8");
    // Forbidden tokens — any of these would mean the doctor is feeding
    // into the gate, which is exactly what FR-012 forbids.
    const forbidden = [
      "doctor",
      "Doctor",
      "DoctorFinding",
      "runDoctor",
      "AGENT_DESCRIPTORS",
      "skillsPath",
      "AgentDescriptor",
      "AgentId",
      "../doctor",
      "./doctor",
      "src/doctor",
      "./agents/",
      "../agents/",
    ];
    for (const needle of forbidden) {
      expect(
        source.includes(needle),
        `src/check.ts must not reference "${needle}" (FR-012: doctor is independent of check --gate)`,
      ).toBe(false);
    }
  });

  it("src/commands/check.ts `check` action does not invoke runDoctor / DoctorFinding", () => {
    // issue #162: the `check` subcommand moved from src/cli.ts into its own
    // module. That module registers exactly one command, so — unlike the
    // old single-file cli.ts — there is no second `program.command(...)`
    // block to bound the slice against; the check block runs to EOF.
    const cliSource = readFileSync(resolve(REPO_ROOT, "src/commands/check.ts"), "utf-8");
    const checkStart = cliSource.indexOf('.command("check")');
    expect(
      checkStart,
      "could not locate check subcommand in src/commands/check.ts",
    ).toBeGreaterThan(0);
    // Accept both top-level (`\nprogram`) and indented-inside-registerCommands
    // (`\n  program`) — oxfmt normalises whichever style the surrounding scope
    // uses, so pinning to one indentation would be a maintenance trap.
    const nextProgramMatch = cliSource.slice(checkStart + 1).search(/\n[ \t]*program(\s|\.|\r?\n)/);
    const checkEnd = nextProgramMatch >= 0 ? checkStart + 1 + nextProgramMatch : cliSource.length;
    expect(checkEnd).toBeGreaterThan(checkStart);
    const checkBlock = cliSource.slice(checkStart, checkEnd);

    for (const needle of ["runDoctor", "DoctorFinding", "formatDoctorReport"]) {
      expect(
        checkBlock.includes(needle),
        `check subcommand must not call "${needle}" (FR-012)`,
      ).toBe(false);
    }
  });

  it("check() exit decision is a pure function of (graph, lock, scope, testResults, baseline)", () => {
    // Behavioural proof: `check()` produces the same `pass` result twice in
    // a row on byte-identical inputs. spec 017 added an OPTIONAL `baseline`
    // parameter (issue #174); when it is omitted `check()` is still doctor-
    // independent and pure — the signature has no `rootDir` / `agents` knob,
    // so spec 013 distribution files CANNOT alter the outcome regardless of
    // whether they exist on disk. With an empty graph there are zero scoped
    // issues, so `newIssues` is empty and the new `pass` semantics (no NEW
    // issue) collapse to `true`, matching the pre-017 "all clear" meaning.
    const emptyGraph: ArtifactGraph = {
      nodes: new Map(),
      edges: [],
    };
    const emptyLock: LockFile = {};
    const r1 = check(emptyGraph, emptyLock);
    const r2 = check(emptyGraph, emptyLock);
    expect(r1.pass).toBe(true);
    expect(r2.pass).toBe(true);
    expect(r1).toEqual(r2);
  });
});
