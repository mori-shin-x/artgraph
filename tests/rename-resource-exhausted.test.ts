// issue #335 (implementation 3, `rename-executor.ts`'s `reconcileAfterWrite`)
// — by the time the post-write re-scan runs, `applyWrites` has ALREADY
// rewritten every source file to disk. If THAT scan hits file-descriptor
// exhaustion, `reconcile()` refuses to update the lock
// (`ReconcileResourceExhaustedError`) — but the rewrite itself must NOT be
// rolled back or reported as a failure: `reconcileAfterWrite` catches the
// rejection and surfaces recovery guidance through the existing
// `postWriteWarnings` channel instead of letting the command crash.
//
// The failure is armed to start ONLY after the first real file write (via
// the `node:fs` mock below), so the PRE-write scan/enumeration — which must
// succeed for the rename to have anything to rewrite in the first place —
// is completely unaffected; only the POST-write re-scan inside
// `reconcileAfterWrite` observes the simulated EMFILE.
const control = vi.hoisted(() => ({
  armed: false,
  failCode: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (
      ...args: Parameters<typeof actual.writeFileSync>
    ): ReturnType<typeof actual.writeFileSync> => {
      const result = actual.writeFileSync(...args);
      if (control.armed) control.failCode = "EMFILE";
      return result;
    },
  };
});

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
        if (control.failCode) {
          const err = new Error(
            `simulated ${control.failCode} in fast-glob.sync`,
          ) as NodeJS.ErrnoException;
          err.code = control.failCode;
          throw err;
        }
        return realDefault.sync(...args);
      },
    },
  );
  return { default: wrapped };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAt } from "./helpers.js";

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", message],
    { cwd, stdio: "pipe" },
  );
}

async function prepareFixture(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "artgraph-rename-resx-"));
  mkdirSync(join(tmp, "specs"), { recursive: true });
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"], testPatterns: [] }),
  );
  writeFileSync(join(tmp, "specs", "a.md"), "# Spec A\n\n- REQ-001: alpha\n");
  writeFileSync(join(tmp, "src", "feature.ts"), "// @impl REQ-001\nexport const x = 1;\n");
  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
  gitCommit(tmp, "init");
  // Real reconcile, real fast-glob — establishes the lock BEFORE arming the
  // failure, exactly like `reconcileAfterWrite`'s own "no-op unless a lock
  // already exists" precondition.
  await runAt(tmp, ["reconcile"]);
  gitCommit(tmp, "add lock");
  return tmp;
}

afterEach(() => {
  control.armed = false;
  control.failCode = undefined;
});

describe("rename: post-write reconcile() resource-exhaustion rejection (issue #335)", () => {
  it("files are still rewritten, the command does not crash, and postWriteWarnings explains the lock was not updated", async () => {
    const tmp = await prepareFixture();
    try {
      const lockBefore = readFileSync(resolve(tmp, ".trace.lock"), "utf-8");

      control.armed = true;
      const { exitCode, stdout } = await runAt(tmp, [
        "rename",
        "--from",
        "REQ-001",
        "--to",
        "REQ-100",
        "--format",
        "json",
      ]);

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);

      // The rewrite itself succeeded — this is the crucial "not rolled
      // back" assertion.
      expect(result.applied).toBe(true);
      const spec = readFileSync(resolve(tmp, "specs/a.md"), "utf-8");
      expect(spec).toContain("REQ-100");
      expect(spec).not.toMatch(/REQ-001/);
      const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
      expect(src).toContain("@impl REQ-100");

      // The lock, however, was NOT updated — still whatever it was before
      // this rename (still keyed under the OLD id).
      const lockAfter = readFileSync(resolve(tmp, ".trace.lock"), "utf-8");
      expect(lockAfter).toBe(lockBefore);
      expect(JSON.parse(lockAfter)["REQ-100"]).toBeUndefined();

      // Recovery guidance surfaced through the existing postWriteWarnings
      // channel. The underlying scan may ALSO carry the generic
      // "file descriptor exhaustion" warning `graph/builder.ts` produces —
      // the rename-specific one is the entry that mentions the rewrite.
      expect(result.postWriteWarnings).toBeDefined();
      const resxEntries = result.postWriteWarnings.filter(
        (w: { type: string }) => w.type === "system-resource-exhausted",
      );
      expect(resxEntries.length).toBeGreaterThan(0);
      const resx = resxEntries.find((w: { message: string }) => /rewritten/i.test(w.message));
      expect(resx).toBeDefined();
      expect(resx.message).toMatch(/lock.*not/i);
      expect(resx.message).toMatch(/artgraph reconcile/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints the recovery guidance in text mode via the existing postWriteWarnings block", async () => {
    const tmp = await prepareFixture();
    try {
      control.armed = true;
      const { exitCode, stderr } = await runAt(tmp, [
        "rename",
        "--from",
        "REQ-001",
        "--to",
        "REQ-100",
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toMatch(/new warnings detected by the post-rename re-scan/);
      expect(stderr).toMatch(/rewritten/i);
      expect(stderr).toMatch(/artgraph reconcile/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("without resource exhaustion, rename still updates the lock normally (regression guard)", async () => {
    const tmp = await prepareFixture();
    try {
      // control.armed stays false — no simulated failure at all.
      const { exitCode, stdout } = await runAt(tmp, [
        "rename",
        "--from",
        "REQ-001",
        "--to",
        "REQ-100",
        "--format",
        "json",
      ]);

      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(
        (result.postWriteWarnings ?? []).some(
          (w: { type: string }) => w.type === "system-resource-exhausted",
        ),
      ).toBe(false);
      const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
      expect(lock["REQ-100"]).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
