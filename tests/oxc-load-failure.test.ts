import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Module } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTSParser, parseTSFilePaths } from "../src/parsers/typescript.js";
import { buildSymbolNameTable } from "../src/trace/symbol-table.js";

// issue #263 — before this fix, a broken/missing oxc-parser native binding
// (the `requireCjs("oxc-parser")` call inside `loadOxc` throwing — e.g. a
// missing platform-specific optional dependency, corrupted node_modules, or
// an OS/arch mismatch) was silently swallowed by `safeParseSync`'s
// catch-all, which exists for an entirely UNRELATED reason (issue #247:
// `parseSync` itself throwing a catchable exception on some input). The
// symptom: every file in the scan came back with zero symbols/imports and
// NO warning anywhere (only the plain-text `extractImplTags` regex scan kept
// working, so the tool looked superficially alive while silently producing
// an empty graph), and — since `oxcModule ??= requireCjs(...)` never
// completes on a throw — the failing native dlopen was re-attempted on
// EVERY file.
//
// These tests simulate that failure by monkey-patching node:module's
// `Module._load`. `loadOxc` uses `createRequire(import.meta.url)` to obtain
// a genuine Node CJS `require` function, which resolves through
// `Module._load` under the hood — unlike a plain ESM import, this is NOT
// something `vi.mock("oxc-parser", …)` can intercept (verified: Vitest's
// mock registry only rewrites its own ESM/transform-based module graph, not
// a raw `Module._load` call reached via `createRequire`), so patching
// `Module._load` directly is the mechanism that actually reaches this call
// site.
//
// IMPORTANT: `loadOxc`'s failure memoization (the module-scoped
// `oxcLoadError` variable in src/parsers/typescript.ts) persists for the
// lifetime of THIS TEST FILE's module instance once poisoned by the first
// test below — every later call into the TS parser (or anything that calls
// into it, like `buildSymbolNameTable`) in this same file throws the same
// cached error, by design (issue #263's whole point: no per-file retry).
// Vitest isolates module state per test FILE by default, so this cannot leak
// into other suites; this file is deliberately kept single-purpose (every
// test here expects the poisoned/throwing state) so that isn't a problem.

function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("oxc-parser load failure (issue #263): fail-fast, not silently swallowed", () => {
  let root: string;
  let requireAttempts = 0;
  let originalLoad: (typeof Module)["_load"];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-load-fail-"));
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/b.ts", "export const b = 2;\n");

    originalLoad = Module._load;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === "oxc-parser") {
        requireAttempts++;
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

  it("parseTSFilePaths throws a clear, actionable error instead of silently returning zero symbols", () => {
    expect(() => parseTSFilePaths(root, [join(root, "src/a.ts")], "symbol")).toThrow(/oxc-parser/i);

    let caught: unknown;
    try {
      parseTSFilePaths(root, [join(root, "src/a.ts")], "symbol");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/native binding/i);
    expect(message).toMatch(/reinstall/i);
    expect(message).toMatch(/node_modules/);
  });

  it("createTSParser().parse() over multiple files also throws (does not fail-open per file)", () => {
    expect(() => createTSParser(root, ["src/**/*.ts"], "symbol").parse()).toThrow(/oxc-parser/i);
  });

  it("buildSymbolNameTable propagates the same fail-fast error (issue #269 alignment — no independent, silently-fail-open loadOxc copy)", () => {
    expect(() => buildSymbolNameTable(root, ["src/**/*.ts"])).toThrow(/oxc-parser/i);
  });

  it("never retries the native require after the first failure across every call above (negative cache)", () => {
    expect(requireAttempts).toBe(1);
  });
});
