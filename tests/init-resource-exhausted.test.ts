// issue #335 (implementation 3, `src/init.ts`) — when the initial scan hits
// file-descriptor exhaustion, `reconcile()` refuses to write the lock
// (`ReconcileResourceExhaustedError`). `runInit` catches ONLY that specific
// error and keeps going: every other stage (Skills / integrate / hooks /
// agent-context / the final `.artgraph.json` write) still completes, and
// `InitResult.reconcileResourceExhausted` reports the one skipped write.
// Every OTHER error `reconcile()` can throw (e.g. `LockSchemaVersionError`)
// is unaffected — still aborts the whole `init`, unchanged from before this
// fix.
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-init-resx-"));
}

describe("runInit: reconcile() resource-exhaustion rejection does not abort other stages (issue #335)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    mkdirSync(join(tmp, "specs"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "specs", "spec.md"), "# Spec\n\n- REQ-4401: needs coverage\n");
    writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;\n// @impl REQ-4401\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    globControl.failCode = undefined;
  });

  it("scan stage still reports a summary, lock is NOT written, other stages (Skills) still complete, and the failure is reported", () => {
    globControl.failCode = "EMFILE";

    const result = runInit(tmp, { agents: ["claude"] });

    // The lock write specifically was skipped...
    expect(result.lockPath).toBeUndefined();
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(false);
    expect(result.reconcileResourceExhausted).toBeDefined();
    expect(result.reconcileResourceExhausted).toMatch(/artgraph reconcile/);
    expect(result.warnings.some((w) => w.type === "system-resource-exhausted")).toBe(true);

    // ...but the scan itself ran (scanSummary reflects it)...
    expect(result.scanSummary).toBeDefined();

    // ...and every OTHER stage still completed: Skills distribution actually
    // wrote files to disk, and the final config write happened.
    expect(result.skillsInstalled).toBeDefined();
    expect(existsSync(join(tmp, ".claude", "skills", "artgraph-impact", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
  });

  it("without resource exhaustion, init still writes the lock normally (regression guard)", () => {
    const result = runInit(tmp, { agents: ["claude"] });

    expect(result.lockPath).toBeDefined();
    expect(result.reconcileResourceExhausted).toBeUndefined();
    expect(existsSync(join(tmp, ".trace.lock"))).toBe(true);
  });
});
