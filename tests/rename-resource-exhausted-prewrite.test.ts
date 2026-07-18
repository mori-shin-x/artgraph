// issue #351 (Step 0-pre HIGH-3) — `rename`/`split`/`merge`'s pre-write
// ID-collision validation (`existingIds.has(to)` etc.) reads `existingIds`
// from the PRE-write scan. If that scan hit file-descriptor exhaustion
// (EMFILE/ENFILE), `existingIds` can be missing an ID that actually exists
// on disk (an entire spec/code subtree failed to glob) — so the collision
// check silently passes over a REAL collision and rename-executor.ts
// proceeds to WRITE, producing a duplicate ID with no diagnostic at all.
// Worse: if no `.trace.lock` file existed yet, `postWriteWarnings` never
// even runs (the post-write safety net is itself gated on the lock
// existing), so the corruption is invisible until whatever unrelated
// `scan`/`check` happens to run next.
//
// `src/rename-executor.ts`'s `assertScanNotResourceExhausted` closes this by
// refusing outright — for BOTH `--dry-run` and a real write — whenever the
// pre-write scan's warnings carry `system-resource-exhausted`. This suite
// pins that fail-closed behavior and, critically, asserts NO file content
// changes when the refusal fires (the regression this guards against is a
// SILENT partial/duplicate write).
//
// Uses a "fails N times, then recovers" EMFILE simulator — a single
// transient hiccup during the pre-write scan is enough to trip the gate;
// the environment does not need to stay broken.

const globControl = vi.hoisted(() => ({ failRemaining: 0 }));

vi.mock("fast-glob", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("fast-glob") }>();
  const realDefault = actual.default as unknown as {
    sync: (...args: unknown[]) => string[];
  } & ((...args: unknown[]) => unknown);
  const wrapped = Object.assign(
    (...args: unknown[]) => (realDefault as (...a: unknown[]) => unknown)(...args),
    realDefault,
    {
      sync: (...args: unknown[]) => {
        if (globControl.failRemaining > 0) {
          globControl.failRemaining--;
          const err = new Error(
            "simulated transient EMFILE in fast-glob.sync",
          ) as NodeJS.ErrnoException;
          err.code = "EMFILE";
          throw err;
        }
        return realDefault.sync(...args);
      },
    },
  );
  return { default: wrapped };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  globControl.failRemaining = 0;
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

const SPEC_MD = "# Spec\n\n- REQ-100: needs a rename\n";
const A_TS = "export const a = 1;\n// @impl REQ-100\n";

function makeFixture(prefix: string): string {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs", "spec.md"), SPEC_MD);
  writeFileSync(join(root, "src", "a.ts"), A_TS);
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
  );
  return root;
}

describe("artgraph rename: pre-write resource-exhaustion gate (issue #351 HIGH-3 regression)", () => {
  it("--dry-run: refuses (exit 1) with a dedicated message when a transient EMFILE hits the pre-write scan; nothing rewritten", async () => {
    const root = makeFixture("artgraph-351-rename-dryrun-");
    globControl.failRemaining = 1;

    const result = await runCli(
      ["rename", "--from", "REQ-100", "--to", "REQ-200", "--dry-run", "--format", "json"],
      { cwd: root },
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout || result.stderr);
    expect(payload.error).toMatch(/Refusing to rename\/split\/merge/);
    expect(payload.error).toMatch(/system-resource-exhausted/);
    // File content is byte-identical to what was written by the fixture —
    // no partial/duplicate write occurred.
    expect(readFileSync(join(root, "specs", "spec.md"), "utf-8")).toBe(SPEC_MD);
    expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe(A_TS);
  });

  it("real (non-dry-run) rename: refuses (exit 1) the same way; nothing rewritten (the HIGH-3 duplicate-ID-write regression)", async () => {
    const root = makeFixture("artgraph-351-rename-real-");
    globControl.failRemaining = 1;

    const result = await runCli(
      ["rename", "--from", "REQ-100", "--to", "REQ-200", "--format", "json"],
      { cwd: root },
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout || result.stderr);
    expect(payload.error).toMatch(/Refusing to rename\/split\/merge/);
    // The critical assertion: with NO pre-write gate, this rename would have
    // proceeded (the transient EMFILE having already cleared by the time any
    // actual file read happened) and WRITTEN "REQ-200" over "REQ-100" despite the
    // scan that validated the rename being degraded. Assert byte-identical
    // content — no write of any kind occurred.
    expect(readFileSync(join(root, "specs", "spec.md"), "utf-8")).toBe(SPEC_MD);
    expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe(A_TS);
  });

  it("regression guard: the SAME rename, without any EMFILE, succeeds normally (proves the fixture itself is valid and the gate isn't unconditionally blocking)", async () => {
    const root = makeFixture("artgraph-351-rename-baseline-");
    // globControl.failRemaining left at 0 — no simulated failure.

    const result = await runCli(
      ["rename", "--from", "REQ-100", "--to", "REQ-200", "--format", "json"],
      { cwd: root },
    );

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "specs", "spec.md"), "utf-8")).toContain("REQ-200");
    expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toContain("REQ-200");
  });
});
