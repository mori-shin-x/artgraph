// issue #279 — format-aware handling of fatal errors, in two parts:
//
//   1. An `OxcLoadError` (oxc-parser's native binding missing/broken, issue
//      #263) used to be caught ONLY by `cli.ts`'s top-level
//      `program.parseAsync()` catch — a layer with no idea what `--format`
//      the just-parsed command requested, so it always printed plain text to
//      stderr regardless of `--format json`. Every command whose action can
//      reach `scan()`/`buildGraph()` now routes through
//      `commands/shared.ts#withOxcLoadErrorFatal` (scan/check/impact/
//      reconcile/trace) or an inline `instanceof OxcLoadError` branch in its
//      own pre-existing catch (rename/plan-coverage), so `--format json`
//      gets a parseable `{"error": ...}` envelope instead.
//   2. `plan-coverage`'s generic catch-all was plain-text-only regardless of
//      `--format`; it now branches on format the same way `rename`'s
//      original `fail()` does.
//
// Both are pinned end-to-end here (real CLI invocations via the in-process
// harness) PLUS at the `commands/shared.ts` helper level directly (mocked),
// per the test plan's explicit allowance for OxcLoadError being hard to
// trigger — here it IS reliably triggered via the same `Module._load`
// monkey-patch technique `tests/oxc-load-failure.test.ts` established, so
// both levels are covered.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Module } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAt } from "./helpers.js";

function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

// This repo's own dogfood self-scan (`check --diff` over THIS PR's diff)
// matches `@impl`/`[...]` tag-shaped text ANYWHERE in a `tests/**/*.test.ts`
// file's raw source, not just in genuinely-authored tags — see
// tests/helpers.ts's `introduceNewOrphan`/`coverDebtReq` doc comments and
// the `"REQ-" + "001"` split idiom used throughout tests/*.test.ts (e.g.
// tests/trace-method-grain.test.ts). This fixture's temp-dir content is
// UNRELATED to this repo's own graph, but it still needs the same split to
// avoid a spurious new orphan from the file you're reading right now.
function makeFixture(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  write(
    dir,
    ".artgraph.json",
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );
  write(dir, "specs/feature.md", "# Feature\n\n- REQ-" + "001: something\n");
  write(dir, "src/feature.ts", "// @impl " + "REQ-001\nexport const x = 1;\n");
  write(dir, "tests/feature.test.ts", "// [" + "REQ-001]\nexport {};\n");
  write(
    dir,
    "myspec/tasks.md",
    ["# Tasks", "", "- [ ] T001 do something", "  Files: src/feature.ts", ""].join("\n"),
  );
  return dir;
}

// ---------------------------------------------------------------------------
// 1. End-to-end: a genuinely broken oxc-parser native binding (same
// `Module._load` monkey-patch as tests/oxc-load-failure.test.ts), driven
// through real command actions via the in-process CLI harness.
//
// IMPORTANT (mirrors oxc-load-failure.test.ts's own warning): `loadOxc`'s
// failure is memoized module-wide once the first call fails (issue #263's
// negative cache — no per-call retry), so this file is deliberately
// single-purpose: every test below expects the poisoned/throwing state.
// Vitest isolates module state per test FILE, so this cannot leak into
// other suites.
// ---------------------------------------------------------------------------
describe("fatal-error contract: OxcLoadError is format-aware across every scan()-backed command (issue #279)", () => {
  let root: string;
  let originalLoad: (typeof Module)["_load"];

  beforeAll(() => {
    root = makeFixture("artgraph-fatal-oxc-");
    originalLoad = Module._load;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === "oxc-parser") {
        throw new Error("simulated missing native binding (ERR_DLOPEN_FAILED)");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalLoad as any).apply(Module, [request, ...rest]);
    };
  });

  afterAll(() => {
    Module._load = originalLoad;
    rmSync(root, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; args: string[] }> = [
    { name: "scan", args: ["scan"] },
    { name: "check", args: ["check"] },
    { name: "impact", args: ["impact", "src/feature.ts"] },
    { name: "trace status", args: ["trace", "status"] },
    { name: "trace report", args: ["trace", "report"] },
    { name: "rename", args: ["rename", "--from", "REQ-001", "--to", "REQ-100"] },
    { name: "plan-coverage", args: ["plan-coverage", "--spec", "myspec"] },
  ];

  for (const { name, args } of cases) {
    it(`${name} --format json: {"error": ...} envelope on stderr, empty stdout, exit 1`, async () => {
      const { exitCode, stdout, stderr } = await runAt(root, [...args, "--format", "json"]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(() => JSON.parse(stderr)).not.toThrow();
      const envelope = JSON.parse(stderr);
      expect(envelope.error).toMatch(/oxc-parser/i);
      expect(envelope.error).toMatch(/native binding/i);
    });

    it(`${name} (text mode): plain diagnostic on stderr, empty stdout, exit 1`, async () => {
      const { exitCode, stdout, stderr } = await runAt(root, args);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/oxc-parser/i);
      expect(stderr).toMatch(/native binding/i);
      // Not a JSON envelope in text mode.
      expect(() => JSON.parse(stderr)).toThrow();
    });
  }

  // `reconcile` has no `--format` at all — always the text-mode contract.
  it("reconcile: plain diagnostic on stderr, empty stdout, exit 1", async () => {
    const { exitCode, stdout, stderr } = await runAt(root, ["reconcile"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/oxc-parser/i);
  });
});

// plan-coverage's OWN generic catch-all (a DIFFERENT throw than OxcLoadError
// above — e.g. a corrupted `.trace.lock`) being format-aware (issue #279
// item 1) is pinned in tests/plan-coverage-integration.test.ts instead of
// here: that catch-all's error (`LockSchemaError` from a malformed
// `.trace.lock`) is reached via `scan()`, which in THIS file's module
// instance is permanently poisoned by the `Module._load` patch above
// (loadOxc's negative cache — see the file-level doc comment), so it would
// only ever observe the OxcLoadError branch spliced in AHEAD of the generic
// catch-all, never the generic catch-all itself. Keeping that scenario in a
// separate, oxc-unpoisoned test file is what actually exercises it.

// ---------------------------------------------------------------------------
// 2. Unit-level coverage of the shared helper itself (mocked `process.exit`
// / `OxcLoadError`), independent of any command wiring — the test plan's
// explicit fallback for "hard to trigger for real", included here alongside
// (not instead of) the end-to-end coverage above for a second, narrower
// point of verification directly against `commands/shared.ts`'s contract.
// ---------------------------------------------------------------------------
describe("commands/shared.ts: withOxcLoadErrorFatal / printOxcLoadError / printFatalCatchAll (unit, mocked)", () => {
  it('withOxcLoadErrorFatal: json format prints the {"error": ...} envelope to stderr and exits 1', async () => {
    const { withOxcLoadErrorFatal } = await import("../src/commands/shared.js");
    const { OxcLoadError } = await import("../src/parsers/typescript.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    const err = new OxcLoadError(new Error("simulated"));
    await expect(
      withOxcLoadErrorFatal("json", () => {
        throw err;
      }),
    ).rejects.toThrow("__exit_1__");

    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(printed.error).toBe(err.message);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("withOxcLoadErrorFatal: text format prints the bare message (no envelope, no 'Error:' prefix) and exits 1", async () => {
    const { withOxcLoadErrorFatal } = await import("../src/commands/shared.js");
    const { OxcLoadError } = await import("../src/parsers/typescript.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    const err = new OxcLoadError(new Error("simulated"));
    await expect(
      withOxcLoadErrorFatal(undefined, () => {
        throw err;
      }),
    ).rejects.toThrow("__exit_1__");

    expect(errSpy).toHaveBeenCalledWith(err.message);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("withOxcLoadErrorFatal: rethrows every OTHER error unchanged (no swallowing, no exit)", async () => {
    const { withOxcLoadErrorFatal } = await import("../src/commands/shared.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit should not have been called");
    });

    await expect(
      withOxcLoadErrorFatal("json", () => {
        throw new Error("some unrelated validation error");
      }),
    ).rejects.toThrow("some unrelated validation error");

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("withOxcLoadErrorFatal: returns fn()'s value on success (no error at all)", async () => {
    const { withOxcLoadErrorFatal } = await import("../src/commands/shared.js");
    await expect(withOxcLoadErrorFatal("json", () => 42)).resolves.toBe(42);
    await expect(withOxcLoadErrorFatal("json", async () => "async-ok")).resolves.toBe("async-ok");
  });

  it('printFatalCatchAll: json wraps in {"error": ...}, text keeps the pre-existing `Error: <msg>` line', async () => {
    const { printFatalCatchAll } = await import("../src/commands/shared.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    printFatalCatchAll("json", "boom");
    expect(JSON.parse(errSpy.mock.calls[0][0] as string)).toEqual({ error: "boom" });

    printFatalCatchAll("text", "boom");
    expect(errSpy.mock.calls[1][0]).toBe("Error: boom");

    printFatalCatchAll(undefined, "boom");
    expect(errSpy.mock.calls[2][0]).toBe("Error: boom");

    errSpy.mockRestore();
  });
});
