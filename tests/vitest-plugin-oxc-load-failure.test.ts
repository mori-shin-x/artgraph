// issue #278 — before this fix, `src/vitest/plugin.ts`'s `loadOxc()`
// (`oxcModule ??= requireCjs("oxc-parser")`) retried the native dlopen for
// EVERY transformed file once oxc-parser's binding failed to load, and each
// retry's failure was swallowed by `transform()`'s single catch block
// together with ordinary per-file parse failures — producing a misleading
// "[artgraph] trace instrumentation: could not parse <file>" warning, once
// per file, instead of a single diagnostic naming the real cause.
//
// These tests mirror `tests/oxc-load-failure.test.ts`'s `Module._load`
// monkey-patch technique (see that file's doc comment for why this is the
// only mechanism that actually reaches `createRequire(...).require`'s call
// site) but drive `src/vitest/plugin.ts`'s `transform()` hook directly,
// covering the decided design for #278: negative-cache the load failure,
// warn exactly once per PROCESS (not per file) with a dedicated diagnostic,
// then pass every subsequent module through un-instrumented.
//
// (d) from the design ("an ordinary per-file parse failure — broken syntax,
// oxc itself loads fine — keeps the pre-existing per-file 'could not parse'
// warning") is NOT re-tested here: it's already covered by
// tests/vitest-plugin.test.ts's "fail-soft" describe block, which runs in a
// separate test-file module instance where oxc genuinely loads. That
// separation is required, not incidental — see the IMPORTANT note below.
//
// IMPORTANT: like `tests/oxc-load-failure.test.ts`, this file's
// module-scope `oxcLoadFailure` / `warnedOxcLoadFailure` state in
// `src/vitest/plugin.ts` is poisoned for the lifetime of THIS test file's
// module instance once the first test below fails to load oxc — every
// later `transform()` call in this file passes through un-instrumented by
// design (the negative cache has no "unpoison" path, by design). Vitest
// isolates module state per test file, so this cannot leak into other
// suites; this file is kept single-purpose (every test here expects the
// poisoned state) for the same reason as that file.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Module } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import artgraphTracePlugin, { type ArtgraphTracePlugin } from "../src/vitest/plugin.js";

function write(rootDir: string, relPath: string, content: string): string {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

function makePlugin(root: string): ArtgraphTracePlugin {
  const plugin = artgraphTracePlugin();
  plugin.configResolved({ root });
  return plugin;
}

describe("vitest plugin: oxc-parser load failure (issue #278) — negative cache + dedicated once-per-process warning", () => {
  let root: string;
  let requireAttempts = 0;
  let originalLoad: (typeof Module)["_load"];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-vitest-plugin-oxc-load-fail-"));

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

  // Restoring in `afterEach` (rather than at the tail of each `it`) means a
  // failed assertion mid-test still detaches the `process.stderr.write` spy
  // before the next test runs — otherwise a thrown assertion leaves a stale
  // spy installed and the next test's own `vi.spyOn` wraps IT instead of the
  // real `process.stderr.write`, corrupting that test's call count.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a)+(b)+(c): warns once on stderr across multiple files' transform() calls, each transform is an un-instrumented pass-through, and dlopen is never retried", () => {
    const plugin = makePlugin(root);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const srcA = "export function a() { return 1; }\n";
    const absA = write(root, "src/oxc-fail-a.js", srcA);
    const srcB = "export function b() { return 2; }\n";
    const absB = write(root, "src/oxc-fail-b.js", srcB);
    const srcC = "export function c() { return 3; }\n";
    const absC = write(root, "src/oxc-fail-c.js", srcC);

    const resultA = plugin.transform(srcA, absA);
    const resultB = plugin.transform(srcB, absB);
    const resultC = plugin.transform(srcC, absC);

    // (b): every transform is an un-instrumented pass-through (undefined).
    expect(resultA).toBeUndefined();
    expect(resultB).toBeUndefined();
    expect(resultC).toBeUndefined();

    // (a): exactly one dedicated warning, not one per file.
    const calls = warn.mock.calls.map((c) => String(c[0]));
    const loadFailureWarnings = calls.filter((msg) =>
      msg.includes("failed to load the oxc-parser native binding"),
    );
    expect(loadFailureWarnings.length).toBe(1);

    // Distinguishable from the ordinary per-file parse warning: that
    // warning's unique, fixed substring (its `§変換のスキップ` contract
    // reference) never appears in the dedicated load-failure diagnostic.
    expect(loadFailureWarnings[0]).not.toContain("§変換のスキップ");
    expect(loadFailureWarnings[0]).toMatch(/un-instrumented/);
    expect(loadFailureWarnings[0]).toMatch(/ARTGRAPH_TRACE_ENGINE=cdp/);

    // No stray per-file "could not parse <file>" warnings were emitted
    // instead (that warning's fixed suffix, keyed on the same substring).
    expect(calls.some((msg) => msg.includes("§変換のスキップ"))).toBe(false);

    // (c): dlopen was attempted exactly once despite 3 transform() calls.
    expect(requireAttempts).toBe(1);
  });

  it("a later transform() call (new plugin instance, same process) still doesn't re-warn or retry dlopen", () => {
    // A fresh plugin instance (as a real second vitest project/config would
    // create) still shares the module-scope negative cache and warned-once
    // flag — the design's unit is the PROCESS, not the plugin instance.
    const plugin = makePlugin(root);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const src = "export function d() { return 4; }\n";
    const abs = write(root, "src/oxc-fail-d.js", src);
    const result = plugin.transform(src, abs);

    expect(result).toBeUndefined();
    expect(warn).not.toHaveBeenCalled(); // already warned once earlier in this process
    expect(requireAttempts).toBe(1); // still no retry
  });
});
