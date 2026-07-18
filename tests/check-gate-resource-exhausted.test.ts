// issue #335 (implementation 4) — `artgraph check --gate` exits 1
// ("undeterminable" — distinct from exit 0 pass and exit 2 gate fail) when
// this scan's `warnings` carries `system-resource-exhausted`: the graph may
// be missing entire spec/code trees, so neither a pass nor a fail verdict
// can be trusted. Mirrors the existing baseline-undeterminable exit-1
// pattern (spec 017 FR-010). A plain `check` (no `--gate`) is unaffected —
// the warning is already visible via the normal warning-reporting path and
// the command exits 0/2 on `result.pass` exactly as before.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

function makeFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-4301: needs coverage\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-4301\n");
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
  );
  return root;
}

afterEach(() => {
  globControl.failCode = undefined;
});

describe("artgraph check --gate: exit 1 (undeterminable) on system-resource-exhausted (issue #335)", () => {
  it("--gate + resource exhaustion → exit 1 (not 0, not 2), reason on stderr", async () => {
    const root = makeFixture("artgraph-check-gate-resx-");
    try {
      globControl.failCode = "EMFILE";

      const result = await runCli(["check", "--gate"], { cwd: root });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/system-resource-exhausted/);
      expect(result.stderr).toMatch(/undetermined/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--gate --format json + resource exhaustion → exit 1, warnings[] carries the reason", async () => {
    const root = makeFixture("artgraph-check-gate-resx-json-");
    try {
      globControl.failCode = "EMFILE";

      const result = await runCli(["check", "--gate", "--format", "json"], { cwd: root });

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(
        payload.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plain check (no --gate) + resource exhaustion → does NOT exit 1 for this reason; warning still surfaced", async () => {
    const root = makeFixture("artgraph-check-noGate-resx-");
    try {
      globControl.failCode = "EMFILE";

      const result = await runCli(["check"], { cwd: root });

      // No gate means no gate-specific "undeterminable" exit — the command
      // falls through to its normal pass/fail exit code (0 here, since
      // `check` without `--gate` never exits non-zero on `pass`).
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/file descriptor exhaustion/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--gate without resource exhaustion is unaffected (regression guard)", async () => {
    const root = makeFixture("artgraph-check-gate-ok-");
    try {
      const result = await runCli(["check", "--gate"], { cwd: root });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toMatch(/system-resource-exhausted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
