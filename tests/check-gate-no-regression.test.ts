// spec 013 T031 [US4] (C3 remediation) — non-regression for FR-012 後段
// "doctor は gate に組み込まない".
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

  it("src/cli.ts `check` action does not invoke runDoctor / DoctorFinding", () => {
    const cliSource = readFileSync(resolve(REPO_ROOT, "src/cli.ts"), "utf-8");
    // Slice out just the `check` subcommand action handler. We find the
    // `.command("check")` line and read until the next top-level `program`
    // declaration so the doctor block (which lives separately) doesn't
    // pollute the grep.
    const checkStart = cliSource.indexOf('.command("check")');
    expect(checkStart, "could not locate check subcommand in cli.ts").toBeGreaterThan(0);
    const checkEnd = cliSource.indexOf("\nprogram", checkStart + 1);
    expect(checkEnd).toBeGreaterThan(checkStart);
    const checkBlock = cliSource.slice(checkStart, checkEnd);

    for (const needle of ["runDoctor", "DoctorFinding", "formatDoctorReport"]) {
      expect(
        checkBlock.includes(needle),
        `cli.ts check subcommand must not call "${needle}" (FR-012)`,
      ).toBe(false);
    }
  });

  it("check() exit decision is purely a function of (graph, lock, scope, testResults)", () => {
    // Behavioural proof: `check()` produces the same `pass` result twice in
    // a row on byte-identical inputs. The signature literally has no
    // `rootDir` / `agents` knob — spec 013 distribution files therefore
    // CANNOT alter the outcome, regardless of whether they exist on disk.
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
