// issue #335 (implementation 3, `commands/reconcile.ts`) — `artgraph
// reconcile` surfaces `ReconcileResourceExhaustedError` (thrown by
// `reconcile()` in src/scan.ts when the scan hit file-descriptor
// exhaustion) via the SAME format-aware `withFatalErrors` path every other
// fatal error in this command already uses: a clean one-line message on
// stderr, exit 1, and the lock file left untouched.
const globControl = vi.hoisted(() => ({
  failCode: undefined as string | undefined,
}));

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
        if (globControl.failCode) {
          const err = new Error(
            `simulated ${globControl.failCode} in fast-glob.sync`,
          ) as NodeJS.ErrnoException;
          err.code = globControl.failCode;
          throw err;
        }
        return realDefault.sync(...args);
      },
    },
  );
  return { default: wrapped };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

function makeFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-4201: needs coverage\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-4201\n");
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
  );
  return root;
}

afterEach(() => {
  globControl.failCode = undefined;
});

describe("artgraph reconcile: exits 1 without writing the lock when the scan hit resource exhaustion (issue #335)", () => {
  it("exit 1, clean stderr message, no lock file written", async () => {
    const root = makeFixture("artgraph-reconcile-cmd-resx-");
    try {
      globControl.failCode = "EMFILE";

      const result = await runCli(["reconcile"], { cwd: root });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/file-descriptor exhaustion|system-resource-exhausted/i);
      expect(existsSync(join(root, ".trace.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without resource exhaustion, reconcile still succeeds and writes the lock (regression guard)", async () => {
    const root = makeFixture("artgraph-reconcile-cmd-ok-");
    try {
      const result = await runCli(["reconcile"], { cwd: root });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, ".trace.lock"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
