// issue #279 / issue #336 — format-aware handling of fatal errors, in three
// parts:
//
//   1. An `OxcLoadError` (oxc-parser's native binding missing/broken, issue
//      #263) used to be caught ONLY by `cli.ts`'s top-level
//      `program.parseAsync()` catch — a layer with no idea what `--format`
//      the just-parsed command requested, so it always printed plain text to
//      stderr regardless of `--format json`. Every command whose action can
//      reach `scan()`/`buildGraph()` now routes through
//      `commands/shared.ts#withFatalErrors` (scan/check/impact/reconcile/
//      trace/init) or an inline `instanceof OxcLoadError` branch in its own
//      pre-existing catch (rename/plan-coverage/doctor), so `--format json`
//      gets a parseable `{"error": ...}` envelope instead.
//   2. `plan-coverage`'s generic catch-all was plain-text-only regardless of
//      `--format`; it now branches on format the same way `rename`'s
//      original `fail()` does.
//   3. issue #336 (PR #336 meta-review F1) — `loadConfig()` (a malformed
//      `.artgraph.json`'s `Failed to parse ...`) was called OUTSIDE any
//      guarded region (or, for `trace`, inside a region whose catch only
//      narrowed on `OxcLoadError` and rethrew everything else) in every one
//      of `check`/`scan`/`impact`/`trace`/`reconcile`/`plan-coverage` — a
//      full raw Node stack trace with internal `dist/`/`src/` file paths,
//      completely ignoring `--format`. `init`'s and `doctor`'s catch-alls
//      were ALSO format-blind, and `parseAgentsFlag` (shared by both,
//      `--agents=<list>` parsing) called `process.exit(1)` directly with a
//      bare `console.error`. `withFatalErrors` (the renamed/widened
//      `withOxcLoadErrorFatal`) now catches every `Error`, not just
//      `OxcLoadError`; `init`/`doctor`'s catch-alls and `parseAgentsFlag`
//      are now format-aware too. See the "loadConfig() failure" describe
//      block below.
//
// All three are pinned end-to-end here (real CLI invocations via the
// in-process harness) PLUS at the `commands/shared.ts` helper level directly
// (mocked), per the test plan's explicit allowance for OxcLoadError being
// hard to trigger — here it IS reliably triggered via the same
// `Module._load` monkey-patch technique `tests/oxc-load-failure.test.ts`
// established, so both levels are covered.

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
    // issue #336 — `init`'s default (no `--no-scan`) flow calls `scan()` near
    // the end of `runInit` (after Skills distribution), so it can hit the
    // same poisoned oxc-parser. `--force` is required (the fixture's
    // `.artgraph.json` already exists) and `--agents=claude` is required
    // whenever the Skills/agent-context stages run (the default).
    { name: "init", args: ["init", "--force", "--agents=claude"] },
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
describe("commands/shared.ts: withFatalErrors / printOxcLoadError / printFatalCatchAll (unit, mocked)", () => {
  it('withFatalErrors: json format prints the {"error": ...} envelope to stderr and exits 1 for an OxcLoadError', async () => {
    const { withFatalErrors } = await import("../src/commands/shared.js");
    const { OxcLoadError } = await import("../src/parsers/typescript.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    const err = new OxcLoadError(new Error("simulated"));
    await expect(
      withFatalErrors("json", () => {
        throw err;
      }),
    ).rejects.toThrow("__exit_1__");

    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(printed.error).toBe(err.message);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("withFatalErrors: text format prints the bare OxcLoadError message (no envelope, no 'Error:' prefix) and exits 1", async () => {
    const { withFatalErrors } = await import("../src/commands/shared.js");
    const { OxcLoadError } = await import("../src/parsers/typescript.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    const err = new OxcLoadError(new Error("simulated"));
    await expect(
      withFatalErrors(undefined, () => {
        throw err;
      }),
    ).rejects.toThrow("__exit_1__");

    expect(errSpy).toHaveBeenCalledWith(err.message);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // issue #336 (meta-review F1) — this is the behavior CHANGE from the old
  // `withOxcLoadErrorFatal`: that helper rethrew every non-`OxcLoadError`
  // unchanged (verified by this same test, pre-#336, asserting a rethrow).
  // `withFatalErrors` now catches it too, via `printFatalCatchAll` — this is
  // exactly what closes the "loadConfig() failure produces a raw stack
  // trace" gap this issue fixes.
  it('withFatalErrors: catches every OTHER Error too — json wraps it in the {"error": ...} envelope and exits 1 (no rethrow)', async () => {
    const { withFatalErrors } = await import("../src/commands/shared.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    await expect(
      withFatalErrors("json", () => {
        throw new Error("some unrelated validation error");
      }),
    ).rejects.toThrow("__exit_1__");

    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(printed.error).toBe("some unrelated validation error");

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("withFatalErrors: catches every OTHER Error in text mode too — `Error: <msg>` line, exit 1 (no rethrow)", async () => {
    const { withFatalErrors } = await import("../src/commands/shared.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);

    await expect(
      withFatalErrors(undefined, () => {
        throw new Error("some unrelated validation error");
      }),
    ).rejects.toThrow("__exit_1__");

    expect(errSpy).toHaveBeenCalledWith("Error: some unrelated validation error");

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("withFatalErrors: returns fn()'s value on success (no error at all)", async () => {
    const { withFatalErrors } = await import("../src/commands/shared.js");
    await expect(withFatalErrors("json", () => 42)).resolves.toBe(42);
    await expect(withFatalErrors("json", async () => "async-ok")).resolves.toBe("async-ok");
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

  it('printBareFatalMessage: json wraps in {"error": ...}, text prints the message bare (no prefix)', async () => {
    const { printBareFatalMessage } = await import("../src/commands/shared.js");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    printBareFatalMessage("json", 'ERROR: Unknown agent identifier(s): "bogus".');
    expect(JSON.parse(errSpy.mock.calls[0][0] as string)).toEqual({
      error: 'ERROR: Unknown agent identifier(s): "bogus".',
    });

    printBareFatalMessage("text", 'ERROR: Unknown agent identifier(s): "bogus".');
    expect(errSpy.mock.calls[1][0]).toBe('ERROR: Unknown agent identifier(s): "bogus".');

    printBareFatalMessage(undefined, 'ERROR: Unknown agent identifier(s): "bogus".');
    expect(errSpy.mock.calls[2][0]).toBe('ERROR: Unknown agent identifier(s): "bogus".');

    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. issue #336 (PR #336 meta-review F1) — `loadConfig()` failure (a
// malformed `.artgraph.json`) is format-aware across EVERY command that
// reaches it, mirroring the OxcLoadError coverage above. This is a SEPARATE
// fixture/describe block (not reusing the OxcLoadError one above) because it
// does not depend on the `Module._load` poison — an ordinary CLI invocation
// against a genuinely malformed config file reaches the same
// `withFatalErrors`/catch-all code paths via a plain `Error`
// (`config.ts#loadConfig`'s `Failed to parse ${configPath}: ...`) instead.
// ---------------------------------------------------------------------------
function makeMalformedConfigFixture(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // Deliberately invalid JSON — `JSON.parse` throws, `loadConfig` wraps it
  // in a plain `Error("Failed to parse ...")`.
  write(dir, ".artgraph.json", "{ this is not valid json");
  // `plan-coverage --spec myspec` needs a resolvable spec dir with a
  // tasks.md to get past its own usage-error checks and reach the (now
  // reordered, see plan-coverage.ts) `loadConfig()` call inside its guarded
  // `try`. Content is irrelevant — `loadConfig()` throws before anything
  // else in this file is ever read.
  write(
    dir,
    "myspec/tasks.md",
    ["# Tasks", "", "- [ ] T001 do something", "  Files: src/feature.ts", ""].join("\n"),
  );
  return dir;
}

describe("fatal-error contract: loadConfig() failure (malformed .artgraph.json) is format-aware across every command (issue #336 F1)", () => {
  let root: string;

  beforeAll(() => {
    root = makeMalformedConfigFixture("artgraph-fatal-config-");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // A raw Node stack trace always contains an "at <fn> (<file>:<line>:<col>)"
  // frame line; a clean fatal-error message never does. Used below instead
  // of (or alongside) matching the expected message, so a regression that
  // reintroduces the stack trace fails even if the clean message ALSO
  // happens to appear somewhere in the (much longer) stack-trace output.
  const STACK_FRAME_RE = /\bat .*\(.*:\d+:\d+\)/;

  const cases: Array<{ name: string; args: string[] }> = [
    { name: "check", args: ["check"] },
    { name: "scan", args: ["scan"] },
    { name: "impact", args: ["impact", "--diff"] },
    { name: "trace status", args: ["trace", "status"] },
    { name: "trace report", args: ["trace", "report"] },
    { name: "plan-coverage", args: ["plan-coverage", "--spec", "myspec"] },
    { name: "rename", args: ["rename", "--from", "REQ-001", "--to", "REQ-100"] },
    // `.artgraph.json` already exists (malformed) — `--force` is required to
    // get past init's "already exists" guard and actually reach `loadConfig()`.
    { name: "init", args: ["init", "--force", "--agents=claude"] },
    { name: "doctor", args: ["doctor"] },
  ];

  for (const { name, args } of cases) {
    it(`${name} --format json: {"error": ...} envelope on stderr, no stack trace, empty stdout, exit 1`, async () => {
      const { exitCode, stdout, stderr } = await runAt(root, [...args, "--format", "json"]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).not.toMatch(STACK_FRAME_RE);
      expect(() => JSON.parse(stderr)).not.toThrow();
      const envelope = JSON.parse(stderr);
      expect(envelope.error).toMatch(/failed to parse/i);
    });

    it(`${name} (text mode): clean single-line diagnostic on stderr, no stack trace, empty stdout, exit 1`, async () => {
      const { exitCode, stdout, stderr } = await runAt(root, args);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).not.toMatch(STACK_FRAME_RE);
      expect(stderr).toMatch(/failed to parse/i);
      // Not a JSON envelope in text mode.
      expect(() => JSON.parse(stderr)).toThrow();
    });
  }

  // `reconcile` has no `--format` at all — always the text-mode contract.
  it("reconcile: clean single-line diagnostic on stderr, no stack trace, empty stdout, exit 1", async () => {
    const { exitCode, stdout, stderr } = await runAt(root, ["reconcile"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toMatch(STACK_FRAME_RE);
    expect(stderr).toMatch(/failed to parse/i);
  });
});

// ---------------------------------------------------------------------------
// 4. issue #336 (meta-review F1) — `parseAgentsFlag` (shared by `init` and
// `doctor`'s `--agents=<list>` parsing) is now format-aware: json wraps
// `AgentsParseError.message` in the `{"error": ...}` envelope, text stays
// byte-identical to the pre-#336 bare message.
// ---------------------------------------------------------------------------
describe("init / doctor: --agents=<bogus> is format-aware (issue #336 F1)", () => {
  it("`doctor --agents=bogus --format json`: envelope on stderr, exit 1, text unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artgraph-fatal-agents-"));
    try {
      write(
        dir,
        ".artgraph.json",
        JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
      );

      const json = await runAt(dir, ["doctor", "--agents=bogus", "--format", "json"]);
      expect(json.exitCode).toBe(1);
      expect(json.stdout).toBe("");
      const envelope = JSON.parse(json.stderr);
      expect(envelope.error).toMatch(/Unknown agent identifier/i);

      const text = await runAt(dir, ["doctor", "--agents=bogus"]);
      expect(text.exitCode).toBe(1);
      expect(text.stdout).toBe("");
      // Byte-identical pre-#336 wording: bare message, no "Error:" prefix,
      // not a JSON envelope.
      expect(text.stderr.trim()).toMatch(/^ERROR: Unknown agent identifier/);
      expect(() => JSON.parse(text.stderr)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`init --agents=bogus --format json`: envelope on stderr, exit 1, text unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artgraph-fatal-agents-init-"));
    try {
      const json = await runAt(dir, ["init", "--agents=bogus", "--format", "json"]);
      expect(json.exitCode).toBe(1);
      expect(json.stdout).toBe("");
      const envelope = JSON.parse(json.stderr);
      expect(envelope.error).toMatch(/Unknown agent identifier/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
