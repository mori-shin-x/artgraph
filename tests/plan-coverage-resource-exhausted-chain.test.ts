// issue #351 (Step 0-pre "plan-coverage --gate false-green") — regression
// test for `runPlanCoverage`'s `tripGate` computation, which used to check
// only `implicitImpacts.length > 0 || diagnostics.length > 0` and never
// consulted `warnings` at all. When file-descriptor exhaustion (EMFILE)
// silently shrinks the scanned spec-doc set (an entire `specDirs` entry
// fails to glob), the REQs that would have made `implicitImpacts`/
// `diagnostics` non-empty can simply never have existed in the graph in the
// first place — so a `--gate` run reports a clean, empty result even though
// the scan was demonstrably incomplete. This is the ONE case the Step 0-pre
// investigation flagged as still exposed after issue #335's own EMFILE
// fixes: trace-shard projects also trip the (already-fixed) Window A
// general-catch path and fail closed anyway, so this false-green ONLY
// surfaces in a plain (no trace shards) plan-coverage run — see the fixture
// below, which deliberately has none.
//
// Uses a PATTERN-SPECIFIC EMFILE simulator (unlike the blanket
// tests/check-gate-resource-exhausted.test.ts precedent): of the fixture's
// TWO `specDirs` entries, only ONE fails to glob, so the graph still
// resolves normally for the OTHER spec dir and for `src/util.ts` — isolating
// "one spec dir's REQs silently vanished" as the sole failure, exactly the
// shape the Step 0-pre investigation reproduced.

const globControl = vi.hoisted(() => ({
  failSubstring: undefined as string | undefined,
}));

vi.mock("fast-glob", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("fast-glob") }>();
  const realDefault = actual.default as unknown as {
    sync: (...args: unknown[]) => string[];
  } & ((...args: unknown[]) => unknown);
  const matches = (pattern: unknown): boolean => {
    const needle = globControl.failSubstring;
    if (!needle) return false;
    if (typeof pattern === "string") return pattern.includes(needle);
    if (Array.isArray(pattern))
      return pattern.some((p) => typeof p === "string" && p.includes(needle));
    return false;
  };
  const wrapped = Object.assign(
    (...args: unknown[]) => (realDefault as (...a: unknown[]) => unknown)(...args),
    realDefault,
    {
      sync: (...args: unknown[]) => {
        if (matches(args[0])) {
          const err = new Error("simulated EMFILE in fast-glob.sync") as NodeJS.ErrnoException;
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  globControl.failSubstring = undefined;
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

/**
 * Two `specDirs` entries (`specs-a` defines REQ-100, `specs-b` defines
 * REQ-200 — `specs-b`'s glob is the one the test fails), no trace shards
 * (`.artgraph/trace/` is never created — this false-green is specific to the
 * no-trace-shards plan-coverage path, per this file's header comment).
 * `tasks.md` references `src/util.ts`, which carries NO `@impl` tag at all —
 * `implicitImpacts`/`diagnostics` are genuinely empty regardless of the
 * EMFILE simulation, so a naive reader would call this "clean". The
 * regression this test pins is that the fix must NOT rely on
 * `implicitImpacts`/`diagnostics` becoming non-empty — `warnings` alone
 * must be enough to trip `--gate`.
 */
function makeFixture(prefix: string): string {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "specs-a"), { recursive: true });
  mkdirSync(join(root, "specs-b"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".specify", "specs", "feature"), { recursive: true });
  writeFileSync(join(root, "specs-a", "alpha.md"), "# A\n\n- REQ-100: alpha requirement\n");
  writeFileSync(join(root, "specs-b", "beta.md"), "# B\n\n- REQ-200: beta requirement\n");
  writeFileSync(join(root, "src", "util.ts"), "export function util(): number {\n  return 1;\n}\n");
  writeFileSync(
    join(root, ".specify", "specs", "feature", "tasks.md"),
    ["## T001", "", "Files: src/util.ts", "", "Do the thing.", ""].join("\n"),
  );
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs-a", "specs-b"] }),
  );
  return root;
}

describe("artgraph plan-coverage --gate: false-green regression on partial spec-dir EMFILE (issue #351)", () => {
  it("--gate + one specDir's EMFILE, empty implicitImpacts/diagnostics → exit 1 (was a false-green exit 0)", async () => {
    const root = makeFixture("artgraph-351-plan-coverage-gate-");
    globControl.failSubstring = "specs-b";

    const result = await runCli(
      [
        "plan-coverage",
        "--spec",
        join(root, ".specify", "specs", "feature"),
        "--gate",
        "--format",
        "json",
      ],
      { cwd: root },
    );

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    // The false-green shape itself: genuinely empty implicit findings.
    expect(payload.implicitImpacts).toEqual([]);
    expect(payload.diagnostics).toEqual([]);
    expect(
      payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
    ).toBe(true);
    // Dedicated stderr diagnostic (src/commands/plan-coverage.ts), distinct
    // from a genuine gate-fail — plan-coverage has no separate exit code for
    // "undeterminable" vs "gate failed", so this message is the only way a
    // reader tells them apart.
    expect(result.stderr).toMatch(/system-resource-exhausted/);
    expect(result.stderr).toMatch(/undetermined/i);
  });

  it("non-gate, same condition → exit 0, warnings still surfaced (text mode)", async () => {
    const root = makeFixture("artgraph-351-plan-coverage-nogate-");
    globControl.failSubstring = "specs-b";

    const result = await runCli(
      ["plan-coverage", "--spec", join(root, ".specify", "specs", "feature")],
      { cwd: root },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/file descriptor exhaustion/i);
    // No dedicated undetermined diagnostic without --gate — see
    // src/commands/plan-coverage.ts's own comment.
    expect(result.stderr).not.toMatch(/undetermined/i);
  });

  it("regression guard: without the EMFILE simulation, the same fixture is genuinely clean (exit 0, no warnings)", async () => {
    const root = makeFixture("artgraph-351-plan-coverage-clean-");
    // globControl.failSubstring left undefined.

    const result = await runCli(
      [
        "plan-coverage",
        "--spec",
        join(root, ".specify", "specs", "feature"),
        "--gate",
        "--format",
        "json",
      ],
      { cwd: root },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.implicitImpacts).toEqual([]);
    expect(payload.warnings).toEqual([]);
  });
});
