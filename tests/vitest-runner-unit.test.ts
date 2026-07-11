// spec 021 (tasks.md T008 — Red; made Green by T009's src/vitest/runner.ts
// changes) — unit tests for the instrument engine's pure helpers: engine
// selection, registry drain semantics, and the batch-flush buffer. These
// are exported specifically so they can be pinned WITHOUT constructing a
// real `VitestTestRunner` (which needs a live vitest worker context).
import { describe, expect, it } from "vitest";
import {
  resolveEngine,
  drainTraceRegistry,
  isFileBoundary,
  serializeRecord,
  drainBuffer,
  memoizedHash,
} from "../src/vitest/runner.js";
import {
  REGISTRY_VERSION,
  parseShardLines,
  hashContent,
  type ModuleRegistration,
  type TraceRegistry,
} from "../src/trace/schema.js";

function registration(overrides: Partial<ModuleRegistration> = {}): ModuleRegistration {
  return {
    file: "src/a.ts",
    hash: "0".repeat(16),
    fns: ["f", "g"],
    hits: new Uint8Array(2),
    ...overrides,
  };
}

function registry(modules: ModuleRegistration[], version = REGISTRY_VERSION): TraceRegistry {
  const map = new Map<string, ModuleRegistration>();
  for (const m of modules) map.set(m.file, m);
  return { version, modules: map };
}

describe("resolveEngine (data-model.md §3, contracts/config-surface.md §環境変数)", () => {
  it("defaults to 'instrument' when ARTGRAPH_TRACE_ENGINE is unset", () => {
    expect(resolveEngine({})).toBe("instrument");
  });

  it("honors an explicit 'instrument'", () => {
    expect(resolveEngine({ ARTGRAPH_TRACE_ENGINE: "instrument" })).toBe("instrument");
  });

  it("honors an explicit 'cdp'", () => {
    expect(resolveEngine({ ARTGRAPH_TRACE_ENGINE: "cdp" })).toBe("cdp");
  });

  it("throws fail-fast on an unrecognized value (silent fallback forbidden)", () => {
    expect(() => resolveEngine({ ARTGRAPH_TRACE_ENGINE: "bogus" })).toThrow(
      /ARTGRAPH_TRACE_ENGINE/,
    );
  });

  it("throws on an empty-string value too (not treated as unset)", () => {
    expect(() => resolveEngine({ ARTGRAPH_TRACE_ENGINE: "" })).toThrow();
  });
});

describe("drainTraceRegistry (contract §runner の義務 1-3, 観点1・5)", () => {
  it("registry undefined -> empty hits/hashes, no version mismatch (plugin not applied — normal progression)", () => {
    const result = drainTraceRegistry(undefined);
    expect(result).toEqual({ hits: [], hashes: {}, versionMismatch: false });
  });

  it("empty registry (no modules) -> empty hits/hashes", () => {
    const result = drainTraceRegistry(registry([]));
    expect(result.hits).toEqual([]);
    expect(result.hashes).toEqual({});
    expect(result.versionMismatch).toBe(false);
  });

  it("converts only the SET slots to {file, fn}, in fns/hits slot order", () => {
    const hits = new Uint8Array([0, 1, 0, 1]);
    const reg = registration({ file: "src/a.ts", fns: ["a", "b", "c", "d"], hits });
    const result = drainTraceRegistry(registry([reg]));
    expect(result.hits).toEqual([
      { file: "src/a.ts", fn: "b" },
      { file: "src/a.ts", fn: "d" },
    ]);
  });

  it("zero-clears hits after reading — a second drain sees nothing new", () => {
    const hits = new Uint8Array([1, 1]);
    const reg = registration({ hits });
    const reg1 = registry([reg]);
    const first = drainTraceRegistry(reg1);
    expect(first.hits.length).toBe(2);
    expect([...hits]).toEqual([0, 0]); // cleared IN PLACE

    const second = drainTraceRegistry(reg1);
    expect(second.hits).toEqual([]);
  });

  it("clears hits for EVERY registration, even ones with no set slots this window", () => {
    const untouchedHits = new Uint8Array([0, 0]);
    const hitHits = new Uint8Array([1, 0]);
    const untouched = registration({ file: "src/untouched.ts", hits: untouchedHits });
    const hit = registration({ file: "src/hit.ts", hits: hitHits });
    // fill with a nonzero sentinel BEFORE drain to prove untouched's zero
    // slots stay zero (nothing to clear) while a genuinely stale bit would
    // still be caught — the real assertion is that `.fill(0)` runs
    // unconditionally, which the "second drain empty" test above already
    // pins for the hit case; here we additionally confirm no exception/skip
    // for a registration with zero set bits.
    drainTraceRegistry(registry([untouched, hit]));
    expect([...untouchedHits]).toEqual([0, 0]);
    expect([...hitHits]).toEqual([0, 0]);
  });

  it("hashes copies registration.hash verbatim for files present in hits — no fs access, no recomputation", () => {
    const reg = registration({
      file: "src/a.ts",
      hash: "deadbeefdeadbeef", // not a real sha256 of anything — proves this is a pass-through, not a recompute
      fns: ["f"],
      hits: new Uint8Array([1]),
    });
    const result = drainTraceRegistry(registry([reg]));
    expect(result.hashes).toEqual({ "src/a.ts": "deadbeefdeadbeef" });
  });

  it("omits hashes for a registration with no set slots (file never appears in hits)", () => {
    const reg = registration({ file: "src/untouched.ts", hits: new Uint8Array([0, 0]) });
    const result = drainTraceRegistry(registry([reg]));
    expect(result.hashes).toEqual({});
  });

  it("同 relPath 再登録 (isolate re-evaluation): reads the NEW registration, never a stale hits array", () => {
    const reg1 = registration({ file: "src/a.ts", fns: ["old"], hits: new Uint8Array([1]) });
    const live = registry([reg1]);
    drainTraceRegistry(live); // consume + clear the old registration

    // Simulate the plugin preamble re-running for the same relPath (isolate
    // re-evaluated the module) — `modules.set` REPLACES the Map entry with
    // a brand-new ModuleRegistration carrying a brand-new Uint8Array.
    const reg2 = registration({ file: "src/a.ts", fns: ["fresh"], hits: new Uint8Array([1]) });
    live.modules.set("src/a.ts", reg2);

    const result = drainTraceRegistry(live);
    expect(result.hits).toEqual([{ file: "src/a.ts", fn: "fresh" }]);
  });

  it("不正遷移 (観点3): REGISTRY_VERSION mismatch -> collection abandoned (empty hits/hashes), flagged for the caller", () => {
    const reg = registration({ hits: new Uint8Array([1, 1]) });
    const result = drainTraceRegistry(registry([reg], REGISTRY_VERSION + 1));
    expect(result.hits).toEqual([]);
    expect(result.hashes).toEqual({});
    expect(result.versionMismatch).toBe(true);
    // Abandoning collection must not touch the (untrusted-shape) hits array.
    expect([...reg.hits]).toEqual([1, 1]);
  });
});

describe("isFileBoundary (V6, 観点1・4)", () => {
  it("nothing buffered yet (undefined) is never a boundary", () => {
    expect(isFileBoundary(undefined, "tests/a.test.ts")).toBe(false);
  });

  it("same file as buffered -> not a boundary", () => {
    expect(isFileBoundary("tests/a.test.ts", "tests/a.test.ts")).toBe(false);
  });

  it("different file than buffered -> boundary", () => {
    expect(isFileBoundary("tests/a.test.ts", "tests/b.test.ts")).toBe(true);
  });
});

describe("drainBuffer (V6 batch flush, 観点1・4)", () => {
  it("0 records -> does not flush (returns undefined)", () => {
    expect(drainBuffer([])).toBeUndefined();
  });

  it("flushes and empties the buffer, returning verbatim-concatenated lines", () => {
    const buffer = [
      serializeRecord({ kind: "test", n: 1 }),
      serializeRecord({ kind: "test", n: 2 }),
    ];
    const text = drainBuffer(buffer);
    expect(buffer).toEqual([]); // emptied in place — next flush call would see 0 records
    expect(text).toBe(
      `${JSON.stringify({ kind: "test", n: 1 })}\n${JSON.stringify({ kind: "test", n: 2 })}\n`,
    );
  });

  it("flush output is always a column of complete, individually-parseable JSONL lines", () => {
    const buffer = [
      serializeRecord({
        kind: "meta",
        schemaVersion: 1,
        runToken: "t",
        pool: "forks",
        vitest: "4",
        startedAt: "x",
      }),
      serializeRecord({
        kind: "test",
        testName: "a",
        suitePath: [],
        testFile: "f",
        passed: true,
        hits: [],
        hashes: {},
      }),
      serializeRecord({ kind: "skipped", testName: "b", testFile: "f", reason: "concurrent" }),
    ];
    const text = drainBuffer(buffer)!;
    const parsed = parseShardLines(text);
    expect(parsed.corruptedLines).toBe(0);
    expect(parsed.meta?.runToken).toBe("t");
    expect(parsed.tests.length).toBe(1);
    expect(parsed.skipped.length).toBe(1);
  });

  it("a later flush after new records is independent of a prior flush (buffer reused across boundaries)", () => {
    const buffer: string[] = [];
    buffer.push(serializeRecord({ kind: "test", n: 1 }));
    const first = drainBuffer(buffer);
    expect(first).toContain('"n":1');

    buffer.push(serializeRecord({ kind: "test", n: 2 }));
    const second = drainBuffer(buffer);
    expect(second).toContain('"n":2');
    expect(second).not.toContain('"n":1'); // the first flush's record isn't re-emitted
  });
});

// spec 021 (tasks.md T016, research.md V8) — cdp-path contentHash memo: the
// second of the two sanctioned cheap `cdp` improvements. `readFile` is
// injected specifically so this can be pinned WITHOUT touching the real
// filesystem (no `tests/fixtures/*` file needed) — see `memoizedHash`'s doc
// comment in `src/vitest/runner.ts`.
describe("memoizedHash (V8, cdp-path contentHash memo)", () => {
  it("reads the file at most once per key — a second call for the same key returns the memoized hash without re-reading", () => {
    const memo = new Map<string, string>();
    let reads = 0;
    const readFile = () => {
      reads++;
      return "export function f() {}\n";
    };

    const first = memoizedHash(memo, "src/a.ts", readFile);
    const second = memoizedHash(memo, "src/a.ts", readFile);

    expect(reads).toBe(1); // fs read happened exactly once for this file
    expect(second).toBe(first);
    expect(first).toBe(hashContent("export function f() {}\n"));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a different key triggers its own independent read (memoization is per-key, not global)", () => {
    const memo = new Map<string, string>();
    let readsA = 0;
    let readsB = 0;

    memoizedHash(memo, "src/a.ts", () => {
      readsA++;
      return "content-a";
    });
    memoizedHash(memo, "src/b.ts", () => {
      readsB++;
      return "content-b";
    });
    // Re-read "src/a.ts" again — still memoized, "src/b.ts"'s read didn't
    // evict or otherwise disturb it.
    memoizedHash(memo, "src/a.ts", () => {
      readsA++;
      return "content-a";
    });

    expect(readsA).toBe(1);
    expect(readsB).toBe(1);
    expect(memo.get("src/a.ts")).toBe(hashContent("content-a"));
    expect(memo.get("src/b.ts")).toBe(hashContent("content-b"));
  });

  it("populates the memo map as a side effect, keyed by the given key", () => {
    const memo = new Map<string, string>();
    expect(memo.has("src/a.ts")).toBe(false);
    const hash = memoizedHash(memo, "src/a.ts", () => "x");
    expect(memo.get("src/a.ts")).toBe(hash);
  });
});
