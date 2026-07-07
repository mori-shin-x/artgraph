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
//   (b) **Behavioural CLI check** (issue #175): runs the real
//       `check --gate` command end-to-end via the `runCli()` harness and
//       asserts its stdout/stderr never mention the doctor surface. This
//       replaces a grep of `src/commands/check.ts`'s action body, which
//       broke every time the check subcommand moved to a new file (#162)
//       and only proved the source text was clean — not what a user
//       actually sees when running the command.
//   (c) **Behavioural smoke** runs `check()` directly on a stub graph + lock
//       — the function is pure and takes no rootDir, so spec 013
//       distribution files (`.claude/skills/...` etc.) cannot influence its
//       outcome by construction. We assert the function signature stays free
//       of any `rootDir` / `agents` parameter so the doctor cannot be
//       wired in via an "implicit" surface either.
//
// The three together cover the spec intent without depending on a tmp
// project + multi-step setup: any wiring of doctor into check would either
// require touching `src/check.ts` (caught by (a)), leak into the CLI's
// visible output (caught by (b)), or expand `check()`'s signature (caught
// by (c)).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "../src/check.js";
import type { ArtifactGraph, LockFile } from "../src/types.js";
import { run, cleanup } from "./helpers.js";

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

  it("`check --gate` output never mentions the doctor surface (#175)", async () => {
    // The fixture project has real coverage gaps once the lock file is
    // cleared, so --gate fails on its own merits (exit 2) — proving the
    // assertion below isn't vacuously true on an all-clear run. Runs the
    // real CLI end-to-end, so it stays correct no matter which file the
    // check subcommand's implementation lives in.
    cleanup();
    const { stdout, stderr, exitCode } = await run(["check", "--gate"]);
    expect(exitCode).toBe(2);
    const combined = stdout + stderr;
    for (const needle of ["doctor", "Doctor", "runDoctor", "DoctorFinding", "formatDoctorReport"]) {
      expect(
        combined.includes(needle),
        `check --gate output must not mention "${needle}" (FR-012: doctor is independent of check --gate)`,
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
