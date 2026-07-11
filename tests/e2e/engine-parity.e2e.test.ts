// spec 021 (tasks.md T011-T013, research.md V4/V7, US2) — differential E2E:
// the SAME fixture, spawned through a REAL vitest run under BOTH capture
// engines (`instrument` = v2, `cdp` = legacy inspector), asserting the
// ingest-normalized edge set (NOT raw shard bytes — research.md V7's "生
// shard のバイト比較はしない", the contract puts interpretation on ingest's
// side) is IDENTICAL between engines. Also pins same-engine determinism
// (two runs of the same engine, byte-identical normalized output) and
// downstream invariance (scan/check/trace CLI commands + staleness) on top
// of a v2-captured shard (T013).
//
// Follows `tests/e2e/vitest-runner.e2e.test.ts`'s established spawn
// technique: a tmpdir fixture with `node_modules` symlinked to this repo's
// own install (no network, no per-run `npm install`), `--root`/`--config`
// pointed at hand-written vitest config files, `dist/vitest/{runner,plugin,
// setup}.js` as the built artifacts under test, `ARTGRAPH_TRACE_ENGINE` /
// `ARTGRAPH_TRACE_DIR` env vars to select the engine and isolate each run's
// shard directory.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ingestTrace, type IngestedTrace } from "../../src/trace/ingest.js";
import type { ArtgraphConfig } from "../../src/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RUNNER_PATH = resolve(REPO_ROOT, "dist/vitest/runner.js");
const PLUGIN_PATH = resolve(REPO_ROOT, "dist/vitest/plugin.js");
const SETUP_PATH = resolve(REPO_ROOT, "dist/vitest/setup.js");
const VITEST_BIN = resolve(REPO_ROOT, "node_modules/vitest/vitest.mjs");
const CLI_PATH = resolve(REPO_ROOT, "dist/cli.js");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RunVitestOptions {
  configPath: string;
  extraEnv?: Record<string, string>;
}

function runVitest(root: string, traceDir: string, opts: RunVitestOptions): RunResult {
  mkdirSync(traceDir, { recursive: true });
  const env = {
    ...process.env,
    ARTGRAPH_TRACE_DIR: traceDir,
    UPDATE_SNAPSHOT: "new",
    ...opts.extraEnv,
  };
  const r = spawnSync(
    "node",
    [VITEST_BIN, "run", "--root", root, "--config", opts.configPath, "--pool", "forks"],
    { cwd: root, encoding: "utf-8", env, timeout: 30000 },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runCli(cwd: string, args: string[]): RunResult {
  const r = spawnSync("node", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Reads every `*.jsonl` shard produced by ONE `runVitest` call and ingests
 * it via the real `src/trace/ingest.ts` (the same module `artgraph trace
 * report` / `check` / `scan` consume) — this is deliberately the comparison
 * point research.md V7 calls out, not the raw shard bytes. */
function ingestFromTraceDir(root: string, traceDir: string): IngestedTrace {
  const traceGlob = `${traceDir
    .slice(root.length + 1)
    .split("\\")
    .join("/")}/*.jsonl`;
  const config: ArtgraphConfig = {
    include: ["src/**/*.js"],
    specDirs: ["specs"],
    testPatterns: ["**/*.test.js"],
    lockFile: ".trace.lock",
    trace: { artifacts: [traceGlob] },
  };
  return ingestTrace(config, root);
}

/** Deterministic string form of an `IngestedTrace` for equality comparisons
 * — Maps sorted by key, `Set`s sorted, `shardCount` optionally included
 * (excluded for cross-engine comparisons: worker fan-out bookkeeping, not a
 * correctness signal research.md V7 cares about; included for the
 * same-engine determinism pin, where it's expected to be stable too). */
function serializeIngested(trace: IngestedTrace, includeShardCount: boolean): string {
  const byKey = <K extends string, V>(entries: Iterable<[K, V]>) =>
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(
    {
      perReq: byKey(trace.perReq.entries()),
      hashesAtTrace: byKey(trace.hashesAtTrace.entries()),
      reqsByNode: byKey(
        [...trace.reqsByNode.entries()].map(([k, v]) => [k, [...v].sort()] as const),
      ),
      diagnostics: trace.diagnostics,
      ...(includeShardCount ? { shardCount: trace.shardCount } : {}),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// T011 — naming-taxonomy fixture, shared by both engines and the
// determinism check.
// ---------------------------------------------------------------------------

let namingFixtureDir: string;

beforeAll(() => {
  namingFixtureDir = mkdtempSync(join(tmpdir(), "artgraph-engine-parity-e2e-"));
  symlinkSync(resolve(REPO_ROOT, "node_modules"), join(namingFixtureDir, "node_modules"));
  writeFileSync(
    join(namingFixtureDir, "package.json"),
    JSON.stringify({ name: "artgraph-engine-parity-fixture", private: true, type: "module" }),
  );
  mkdirSync(join(namingFixtureDir, "src"), { recursive: true });
  mkdirSync(join(namingFixtureDir, "tests"), { recursive: true });

  // research.md V4's naming table, one category per top-level construct:
  // exported function, non-exported function (called from an exported
  // wrapper), arrow assigned to a const export, class constructor/method/
  // getter/setter, a nested named function, a throwing function, an async
  // function, and a generator function.
  writeFileSync(
    join(namingFixtureDir, "src/mixed.js"),
    [
      "export function exportedFn() {",
      '  return "exported";',
      "}",
      "",
      "function nonExportedHelper() {",
      '  return "helper";',
      "}",
      "export function callsHelper() {",
      "  return nonExportedHelper();",
      "}",
      "",
      "export const arrowExport = (x) => x + 1;",
      "",
      "export class Widget {",
      "  constructor() {",
      "    this.ready = true;",
      "  }",
      "  method() {",
      '    return "method";',
      "  }",
      "  get value() {",
      '    return "value";',
      "  }",
      "  set value(v) {",
      "    this._v = v;",
      "  }",
      "}",
      "",
      "function outer() {",
      "  function inner() {",
      '    return "inner";',
      "  }",
      "  return inner();",
      "}",
      "export function callsOuter() {",
      "  return outer();",
      "}",
      "",
      "export function throwsFn() {",
      '  throw new Error("boom");',
      "}",
      "",
      "export async function asyncFn() {",
      '  return "async";',
      "}",
      "",
      "export function* genFn() {",
      '  yield "gen";',
      '  return "done";',
      "}",
      "",
    ].join("\n"),
  );

  // Category: named default export.
  writeFileSync(
    join(namingFixtureDir, "src/named-default.js"),
    ["export default function namedDefault() {", '  return "named-default";', "}", ""].join("\n"),
  );

  // Category: anonymous default export.
  writeFileSync(
    join(namingFixtureDir, "src/anon-default.js"),
    ["export default function () {", '  return "anon-default";', "}", ""].join("\n"),
  );

  // Category (edge case, research.md V4's own callout): a module where the
  // ONLY function ever hit is unnameable (array-literal elements have no
  // naming hint per V4 — not a `VariableDeclarator` init). Both engines
  // must therefore record ZERO hits from this file: `instrument`'s plugin
  // never registers it at all (`fns.length === 0` — `src/vitest/plugin.ts`),
  // and `cdp`'s runner filters V8's empty-`functionName` entries
  // (`src/vitest/runner.ts`'s `onAfterRunTask`).
  writeFileSync(
    join(namingFixtureDir, "src/anon-only.js"),
    ["export const handlers = [(x) => x + 1, (x) => x + 2];", ""].join("\n"),
  );

  writeFileSync(
    join(namingFixtureDir, "tests/parity.test.js"),
    [
      'import { describe, it, expect } from "vitest";',
      "import {",
      "  exportedFn,",
      "  callsHelper,",
      "  arrowExport,",
      "  Widget,",
      "  callsOuter,",
      "  throwsFn,",
      "  asyncFn,",
      "  genFn,",
      '} from "../src/mixed.js";',
      'import namedDefault from "../src/named-default.js";',
      'import anonDefault from "../src/anon-default.js";',
      'import { handlers } from "../src/anon-only.js";',
      "",
      'describe("naming taxonomy", () => {',
      '  it("[REQ-101] exported function", () => {',
      '    expect(exportedFn()).toBe("exported");',
      "  });",
      "",
      '  it("[REQ-102] non-exported function, reached via an exported wrapper", () => {',
      '    expect(callsHelper()).toBe("helper");',
      "  });",
      "",
      '  it("[REQ-103] arrow function assigned to a const export", () => {',
      "    expect(arrowExport(1)).toBe(2);",
      "  });",
      "",
      '  it("[REQ-104] class constructor", () => {',
      "    const w = new Widget();",
      "    expect(w.ready).toBe(true);",
      "  });",
      "",
      '  it("[REQ-105] class method", () => {',
      "    const w = new Widget();",
      '    expect(w.method()).toBe("method");',
      "  });",
      "",
      '  it("[REQ-106] class getter", () => {',
      "    const w = new Widget();",
      '    expect(w.value).toBe("value");',
      "  });",
      "",
      '  it("[REQ-107] class setter", () => {',
      "    const w = new Widget();",
      "    w.value = 42;",
      "    expect(w._v).toBe(42);",
      "  });",
      "",
      '  it("[REQ-108] named default export", () => {',
      '    expect(namedDefault()).toBe("named-default");',
      "  });",
      "",
      '  it("[REQ-109] anonymous default export", () => {',
      '    expect(anonDefault()).toBe("anon-default");',
      "  });",
      "",
      '  it("[REQ-110] nested named function", () => {',
      '    expect(callsOuter()).toBe("inner");',
      "  });",
      "",
      '  it("[REQ-111] a module where only an anonymous function is hit", () => {',
      "    expect(handlers[0](1)).toBe(2);",
      "  });",
      "",
      '  it("[REQ-112] a function that throws — entry stamp still records (V8 entered semantics)", () => {',
      '    expect(() => throwsFn()).toThrow("boom");',
      "  });",
      "",
      '  it("[REQ-113] an async function", async () => {',
      '    await expect(asyncFn()).resolves.toBe("async");',
      "  });",
      "",
      '  it("[REQ-114] a generator function", () => {',
      "    const it2 = genFn();",
      '    expect(it2.next().value).toBe("gen");',
      "  });",
      "});",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(namingFixtureDir, "vitest.config.cdp.mjs"),
    `export default {\n  test: {\n    include: ["tests/**/*.test.js"],\n    runner: ${JSON.stringify(
      RUNNER_PATH,
    )},\n  },\n};\n`,
  );

  writeFileSync(
    join(namingFixtureDir, "vitest.config.instrument.mjs"),
    [
      `import tracePlugin from ${JSON.stringify(PLUGIN_PATH)};`,
      "export default {",
      "  plugins: [tracePlugin()],",
      "  test: {",
      '    include: ["tests/**/*.test.js"],',
      `    runner: ${JSON.stringify(RUNNER_PATH)},`,
      `    globalSetup: [${JSON.stringify(SETUP_PATH)}],`,
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}, 30000);

afterAll(() => {
  if (namingFixtureDir) rmSync(namingFixtureDir, { recursive: true, force: true });
});

describe("engine parity (T011/T012, research.md V7): instrument vs cdp, ingest-normalized edge sets", () => {
  let instrumentTrace: IngestedTrace;
  let cdpTrace: IngestedTrace;
  let instrumentTraceRerun: IngestedTrace;

  beforeAll(() => {
    const instrumentDir = join(namingFixtureDir, ".trace-instrument");
    const cdpDir = join(namingFixtureDir, ".trace-cdp");
    const instrumentRerunDir = join(namingFixtureDir, ".trace-instrument-rerun");

    const runInstrument = runVitest(namingFixtureDir, instrumentDir, {
      configPath: join(namingFixtureDir, "vitest.config.instrument.mjs"),
      extraEnv: { ARTGRAPH_TRACE_ENGINE: "instrument" },
    });
    expect(runInstrument.status === 0 || runInstrument.status === 1, runInstrument.stderr).toBe(
      true,
    );

    const runCdp = runVitest(namingFixtureDir, cdpDir, {
      configPath: join(namingFixtureDir, "vitest.config.cdp.mjs"),
      extraEnv: { ARTGRAPH_TRACE_ENGINE: "cdp" },
    });
    expect(runCdp.status === 0 || runCdp.status === 1, runCdp.stderr).toBe(true);

    // Second, independent `instrument` run (fresh shard dir) — same-engine
    // determinism pin (tasks.md T011: "同一エンジン 2 回実行の … byte-identical").
    const runInstrumentRerun = runVitest(namingFixtureDir, instrumentRerunDir, {
      configPath: join(namingFixtureDir, "vitest.config.instrument.mjs"),
      extraEnv: { ARTGRAPH_TRACE_ENGINE: "instrument" },
    });
    expect(
      runInstrumentRerun.status === 0 || runInstrumentRerun.status === 1,
      runInstrumentRerun.stderr,
    ).toBe(true);

    instrumentTrace = ingestFromTraceDir(namingFixtureDir, instrumentDir);
    cdpTrace = ingestFromTraceDir(namingFixtureDir, cdpDir);
    instrumentTraceRerun = ingestFromTraceDir(namingFixtureDir, instrumentRerunDir);
  }, 60000);

  it("both engines produced at least one shard with usable records", () => {
    expect(instrumentTrace.shardCount).toBeGreaterThan(0);
    expect(cdpTrace.shardCount).toBeGreaterThan(0);
    expect(instrumentTrace.perReq.size).toBeGreaterThan(0);
    expect(cdpTrace.perReq.size).toBeGreaterThan(0);
  });

  // research.md V4 (T012 addendum — see this task's final-report note for
  // the full node:inspector probe that found these) — TWO naming-taxonomy
  // categories in this fixture are confirmed to genuinely diverge between
  // engines, for reasons that have NOTHING to do with `src/vitest/plugin.ts`'s
  // naming table being wrong:
  //
  //  - REQ-109 (anonymous default export, `src/anon-default.js`): vite-node's
  //    own SSR transform RENAMES the anonymous function to a synthetic
  //    `__vite_ssr_export_default__` binding before V8 ever sees it. The
  //    `instrument` engine's plugin runs `enforce: 'pre'` — BEFORE that
  //    rename — so it statically determines "default" (V4's own rule,
  //    correct for the source AST); the `cdp` engine has no such visibility
  //    and observes whatever vite-node handed to V8, which is the renamed
  //    binding. Confirmed reproducible: a real `cdp`-engine run's raw shard
  //    records `"fn":"__vite_ssr_export_default__"` for this exact case (a
  //    NAMED default export, `namedDefault`, is unaffected — vite-node has
  //    no need to rename an already-named binding, confirmed by the same
  //    probe: `"fn":"namedDefault"`).
  //  - REQ-111 (a module where only an anonymous function is hit,
  //    `src/anon-only.js`'s `handlers` array): V8 has an internal
  //    `FuncNameInferrer` heuristic (distinct from `Function.prototype.name`
  //    / spec NamedEvaluation, which — confirmed via a direct `.name` check
  //    — is `""` for an array-literal element) that infers a debugging name
  //    for an anonymous function nested inside an array literal from its
  //    ENCLOSING variable's name, walking through container literals
  //    (confirmed by probe: `const x = { list: [() => 1] }` names the
  //    element `"x.list"`; a bare `const handlers = [() => 1]` names it
  //    `"handlers"` — which happens to collide with this fixture's exported
  //    `handlers` symbol and resolve to it). This is a V8-internal
  //    stack-trace/profiler convenience beyond the ECMAScript-spec naming
  //    table V4 scopes itself to, and reimplementing V8's parser-internal
  //    `FuncNameInferrer` algorithm (which also walks through
  //    `MemberExpression` chains, nested arrays, etc.) is out of proportion
  //    to this feature's value — V4's own fail-safe philosophy already
  //    covers this: `instrument` recording NO edge here is conservative,
  //    not wrong (SC-006: never a false claim, only occasionally coarser or
  //    absent precision).
  //
  // Both nodes are therefore EXCLUDED from the blanket cross-engine
  // equality assertion below and PINNED individually per engine instead
  // (research.md V4/V7 carry this same writeup).
  const KNOWN_DIVERGENT_REQS = new Set(["REQ-109", "REQ-111"]);
  const KNOWN_DIVERGENT_NODES = new Set([
    "symbol:src/anon-default.js#default",
    "file:src/anon-default.js",
    "symbol:src/anon-only.js#handlers",
  ]);

  function sanitizeForCrossEngineComparison(trace: IngestedTrace): IngestedTrace {
    return {
      ...trace,
      perReq: new Map([...trace.perReq].filter(([reqId]) => !KNOWN_DIVERGENT_REQS.has(reqId))),
      hashesAtTrace: new Map(
        [...trace.hashesAtTrace].filter(([node]) => !KNOWN_DIVERGENT_NODES.has(node)),
      ),
      reqsByNode: new Map(
        [...trace.reqsByNode].filter(([node]) => !KNOWN_DIVERGENT_NODES.has(node)),
      ),
    };
  }

  it("the ingest-normalized edge set (perReq/hashesAtTrace/reqsByNode/diagnostics) is IDENTICAL across engines, aside from the two documented divergent nodes (SC-004)", () => {
    expect(serializeIngested(sanitizeForCrossEngineComparison(instrumentTrace), false)).toBe(
      serializeIngested(sanitizeForCrossEngineComparison(cdpTrace), false),
    );
  });

  it("two independent runs of the SAME engine produce a byte-identical normalized trace (determinism)", () => {
    expect(serializeIngested(instrumentTrace, true)).toBe(
      serializeIngested(instrumentTraceRerun, true),
    );
  });

  // Targeted per-category assertions — redundant with the blanket equality
  // above for every category EXCEPT the two documented-divergent ones, but
  // pin the exact expected shape so a regression's failure message names
  // the naming category instead of a giant JSON diff.
  function bothEngineIt(name: string, fn: (trace: IngestedTrace) => void): void {
    it(`[instrument] ${name}`, () => fn(instrumentTrace));
    it(`[cdp] ${name}`, () => fn(cdpTrace));
  }

  bothEngineIt("REQ-101 exported function resolves to a symbol edge", (trace) => {
    expect(trace.perReq.get("REQ-101")?.symbols).toEqual(["symbol:src/mixed.js#exportedFn"]);
  });

  bothEngineIt(
    "REQ-102's non-exported helper falls back to a file edge (both exported wrapper AND helper hit)",
    (trace) => {
      const cov = trace.perReq.get("REQ-102");
      expect(cov?.symbols).toEqual(["symbol:src/mixed.js#callsHelper"]);
      expect(cov?.files).toEqual(["file:src/mixed.js"]);
    },
  );

  bothEngineIt("REQ-104 constructor resolves to the class's own symbol id", (trace) => {
    expect(trace.perReq.get("REQ-104")?.symbols).toEqual(["symbol:src/mixed.js#Widget"]);
  });

  bothEngineIt(
    'REQ-106 getter — V8-actual "get value" name falls back to file grain (T012 fix)',
    (trace) => {
      const cov = trace.perReq.get("REQ-106");
      // `new Widget()` in this test's body also hits the constructor — that
      // resolves to a symbol edge as usual (REQ-104's category); the getter
      // ITSELF ("get value") is what falls back to file grain (T012).
      expect(cov?.symbols).toEqual(["symbol:src/mixed.js#Widget"]);
      expect(cov?.files).toEqual(["file:src/mixed.js"]);
    },
  );

  bothEngineIt(
    'REQ-107 setter — V8-actual "set value" name falls back to file grain (T012 fix)',
    (trace) => {
      const cov = trace.perReq.get("REQ-107");
      // Same overlap as REQ-106 above — `new Widget()` also hits the
      // constructor; the setter ITSELF ("set value") falls back to file grain.
      expect(cov?.symbols).toEqual(["symbol:src/mixed.js#Widget"]);
      expect(cov?.files).toEqual(["file:src/mixed.js"]);
    },
  );

  bothEngineIt(
    "REQ-112's throwing function still records an entry hit (V8 entered semantics)",
    (trace) => {
      expect(trace.perReq.get("REQ-112")?.symbols).toEqual(["symbol:src/mixed.js#throwsFn"]);
    },
  );

  bothEngineIt("REQ-113 async function resolves to a symbol edge", (trace) => {
    expect(trace.perReq.get("REQ-113")?.symbols).toEqual(["symbol:src/mixed.js#asyncFn"]);
  });

  bothEngineIt("REQ-114 generator function resolves to a symbol edge", (trace) => {
    expect(trace.perReq.get("REQ-114")?.symbols).toEqual(["symbol:src/mixed.js#genFn"]);
  });

  // The two DOCUMENTED-divergent categories, pinned per engine (not shared
  // — see the writeup above KNOWN_DIVERGENT_REQS).
  it("[instrument] REQ-109 anonymous default export resolves to a symbol edge (pre-transform AST naming, V4)", () => {
    const cov = instrumentTrace.perReq.get("REQ-109");
    expect(cov?.symbols).toEqual(["symbol:src/anon-default.js#default"]);
    expect(cov?.files).toEqual([]);
  });

  it('[cdp] REQ-109 anonymous default export falls back to a file edge (observes vite-node\'s "__vite_ssr_export_default__" rename)', () => {
    const cov = cdpTrace.perReq.get("REQ-109");
    expect(cov?.symbols).toEqual([]);
    expect(cov?.files).toEqual(["file:src/anon-default.js"]);
  });

  it("[instrument] REQ-111 anon-only module contributes NO symbol/file edges (no statically-nameable function to stamp, V4)", () => {
    const cov = instrumentTrace.perReq.get("REQ-111");
    expect(cov).toBeDefined();
    expect(cov?.symbols).toEqual([]);
    expect(cov?.files).toEqual([]);
    // The tagged test still registers as "ran" (impact --tests material)
    // even though none of its hits resolved to a node (contract §ingest 側
    // の義務, ReqCoverage.tests doc).
    expect(cov?.tests.length).toBe(1);
  });

  it("[cdp] REQ-111 anon-only module DOES resolve to a symbol edge (V8's FuncNameInferrer names the array element after its enclosing const)", () => {
    const cov = cdpTrace.perReq.get("REQ-111");
    expect(cov?.symbols).toEqual(["symbol:src/anon-only.js#handlers"]);
    expect(cov?.files).toEqual([]);
  });

  it("no diagnostics.dangling on either engine (every hit resolves to a known in-scope file)", () => {
    expect(instrumentTrace.diagnostics.dangling).toBe(0);
    expect(cdpTrace.diagnostics.dangling).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T013 — downstream invariance + staleness, on a v2 (instrument-engine)
// shard. A dedicated, smaller fixture (own tmpdir) so CLI commands
// (`scan`/`check`/`trace`) see a clean `.artgraph.json` + `specs/` +
// default `.artgraph/trace/` shard location, independent of the T011
// naming-taxonomy fixture above.
// ---------------------------------------------------------------------------

describe("downstream invariance + staleness on a v2 shard (T013)", () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "artgraph-engine-parity-downstream-e2e-"));
    symlinkSync(resolve(REPO_ROOT, "node_modules"), join(fixtureDir, "node_modules"));
    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "artgraph-downstream-fixture", private: true, type: "module" }),
    );
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    mkdirSync(join(fixtureDir, "tests"), { recursive: true });
    mkdirSync(join(fixtureDir, "specs"), { recursive: true });

    writeFileSync(
      join(fixtureDir, "src/target.js"),
      ["export function doStuff() {", "  return 42;", "}", ""].join("\n"),
    );
    writeFileSync(
      join(fixtureDir, "specs/spec.md"),
      ["# Spec", "", "## Requirements", "", "- REQ-700: doStuff does a thing.", ""].join("\n"),
    );
    writeFileSync(
      join(fixtureDir, "tests/target.test.js"),
      [
        'import { describe, it, expect } from "vitest";',
        'import { doStuff } from "../src/target.js";',
        "",
        'describe("target", () => {',
        '  it("[REQ-700] doStuff works", () => {',
        "    expect(doStuff()).toBe(42);",
        "  });",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureDir, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.js"], specDirs: ["specs"], mode: "symbol" }),
    );
    writeFileSync(
      join(fixtureDir, "vitest.config.instrument.mjs"),
      [
        `import tracePlugin from ${JSON.stringify(PLUGIN_PATH)};`,
        "export default {",
        "  plugins: [tracePlugin()],",
        "  test: {",
        '    include: ["tests/**/*.test.js"],',
        `    runner: ${JSON.stringify(RUNNER_PATH)},`,
        `    globalSetup: [${JSON.stringify(SETUP_PATH)}],`,
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    // Deliberately NO `ARTGRAPH_TRACE_DIR` override — writes to this
    // fixture's default `.artgraph/trace/` (contract's documented default,
    // and what a bare `.artgraph.json` without a custom `trace.artifacts`
    // resolves to), exactly what `scan`/`check`/`trace` read out of the box.
    const run = spawnSync(
      "node",
      [
        VITEST_BIN,
        "run",
        "--root",
        fixtureDir,
        "--config",
        join(fixtureDir, "vitest.config.instrument.mjs"),
        "--pool",
        "forks",
      ],
      {
        cwd: fixtureDir,
        encoding: "utf-8",
        env: { ...process.env, ARTGRAPH_TRACE_ENGINE: "instrument", UPDATE_SNAPSHOT: "new" },
        timeout: 30000,
      },
    );
    expect(run.status === 0 || run.status === 1, run.stderr ?? "").toBe(true);
    const shardFiles = readdirSync(join(fixtureDir, ".artgraph/trace")).filter((f) =>
      f.endsWith(".jsonl"),
    );
    expect(shardFiles.length).toBeGreaterThan(0);
  }, 30000);

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  // (a) `trace report` works normally against the v2 shard.
  it("(a) `node dist/cli.js trace report` runs cleanly and cross-checks the v2 shard's evidence", () => {
    const result = runCli(fixtureDir, ["trace", "report", "--format", "json"]);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      suggestedImpls: { reqId: string; node: string }[];
      diagnostics: { stale: number };
    };
    expect(parsed.suggestedImpls).toEqual([
      { reqId: "REQ-700", node: "symbol:src/target.js#doStuff" },
    ]);
    expect(parsed.diagnostics.stale).toBe(0);
  });

  // (b) `scan --format json` run twice is byte-identical.
  it("(b) `node dist/cli.js scan --format json` run twice is byte-identical", () => {
    const first = runCli(fixtureDir, ["scan", "--format", "json"]);
    const second = runCli(fixtureDir, ["scan", "--format", "json"]);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.length).toBeGreaterThan(0);
  });

  // (c) trace recorded, THEN the source is edited — staleness must still be
  // detected (the shard's `hashes` entry was computed at v2 TRANSFORM time
  // from disk content, research.md V5 — this proves that hash still lines
  // up with the graph's own contentHash for staleness comparison, D7).
  it("(c) editing the traced function's source after capture is detected as stale evidence", () => {
    const before = runCli(fixtureDir, ["trace", "status", "--format", "json"]);
    expect(before.status, before.stderr).toBe(0);
    expect(
      (JSON.parse(before.stdout) as { diagnostics: { stale: number } }).diagnostics.stale,
    ).toBe(0);

    writeFileSync(
      join(fixtureDir, "src/target.js"),
      [
        "export function doStuff() {",
        "  // edited after trace capture",
        "  return 43;",
        "}",
        "",
      ].join("\n"),
    );

    const after = runCli(fixtureDir, ["trace", "status", "--format", "json"]);
    expect(after.status, after.stderr).toBe(0);
    const parsed = JSON.parse(after.stdout) as {
      diagnostics: { stale: number };
      staleRate: number;
    };
    expect(parsed.diagnostics.stale).toBe(1);
    expect(parsed.staleRate).toBeGreaterThan(0);

    const checkResult = runCli(fixtureDir, ["check", "--format", "json"]);
    expect(checkResult.status === 0 || checkResult.status === 1, checkResult.stderr).toBe(true);
    const checked = JSON.parse(checkResult.stdout) as {
      staleEvidence?: { reqId: string; symbols: string[] }[];
    };
    expect(checked.staleEvidence).toEqual([
      { reqId: "REQ-700", symbols: ["symbol:src/target.js#doStuff"] },
    ]);
  });

  // (d) trace absence changes `scan`'s output relative to trace presence —
  // the premise spec 020's SC-007 regression tests rely on (full unit-level
  // coverage of "no trace dir vs empty trace dir" already lives in
  // `tests/trace-graph.test.ts`'s T014c describe block; this is a light e2e
  // sanity check specific to a v2-captured shard, not a duplicate).
  it("(d) removing the v2 shard changes scan's output relative to trace-present (exercises edges disappear)", () => {
    const withTrace = runCli(fixtureDir, ["scan", "--format", "json"]);
    expect(withTrace.status, withTrace.stderr).toBe(0);

    const traceDir = join(fixtureDir, ".artgraph/trace");
    for (const f of readdirSync(traceDir)) {
      if (f.endsWith(".jsonl")) rmSync(join(traceDir, f));
    }

    const withoutTrace = runCli(fixtureDir, ["scan", "--format", "json"]);
    expect(withoutTrace.status, withoutTrace.stderr).toBe(0);

    expect(withoutTrace.stdout).not.toBe(withTrace.stdout);
  });
});
