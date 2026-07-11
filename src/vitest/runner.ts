// spec 020 (Phase A-1, US1, T006) — `artgraph/vitest` custom Vitest runner:
// per-test precise V8 coverage via a worker-local `node:inspector` session,
// emitted as TraceShard JSONL
// (specs/020-coverage-derived-edges/contracts/trace-artifact.md). Implements
// research.md D1 ("Profiler.takePreciseCoverage" bracketing each test via
// `onBeforeRunTask`/`onAfterRunTask`, PoC in R1) and D2 (`detailed: false` —
// function-granularity boolean hit, not block-level).
//
// Dependency boundary (plan.md Structure Decision): this module imports
// ONLY `vitest/runners` (the optional peer dependency), node builtins, and
// `src/trace/schema.ts` (the dependency-free shard SSOT) — never another
// `src/` module, so the CLI bundle stays vitest-agnostic. `pnpm knip`
// verifies no CLI entry point reaches into `src/vitest/`.
import { VitestTestRunner } from "vitest/runners";
import inspector from "node:inspector";
import { threadId } from "node:worker_threads";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  SCHEMA_VERSION,
  REGISTRY_KEY,
  REGISTRY_VERSION,
  hashContent,
  isExcludedRelPath,
  type CoverageHit,
  type TraceRegistry,
} from "../trace/schema.js";

// The Task type isn't re-exported by `vitest/runners`'s public `.d.ts` (only
// the two runner classes + `VitestRunner` are). Deriving it from the
// method's own parameter keeps this module honest to whatever the installed
// vitest (peer range `>=3 <5`) actually declares, instead of importing a
// second, possibly-version-drifted type from `@vitest/runner` directly.
type RunnerTask = Parameters<VitestTestRunner["onAfterRunTask"]>[0];

const nodeRequire = createRequire(import.meta.url);

// A minimal structural view of the inspector session's CDP `post`, typed
// just enough for the two `Profiler.*` calls this module makes.
interface CdpSession {
  post(method: "Profiler.enable"): Promise<void>;
  post(method: "Profiler.startPreciseCoverage", params: Record<string, unknown>): Promise<void>;
  post(method: "Profiler.takePreciseCoverage"): Promise<{ result: ScriptCoverage[] }>;
}

interface FunctionCoverage {
  functionName: string;
  ranges: { startOffset: number; endOffset: number; count: number }[];
}

interface ScriptCoverage {
  url: string;
  functions: FunctionCoverage[];
}

// spec 022 (tasks.md T004, research.md V5): `stripBom` / `hashContent` and
// the exclusion rule (`isExcludedRelPath` / `TEST_FILE_RE`) used to be
// hand-duplicated here against `src/parsers/typescript.ts`'s file-mode
// contentHash. Both are now hoisted to `src/trace/schema.ts` (this module's
// one allowed `src/` import) so the plugin (`src/vitest/plugin.ts`, main
// process) and this runner (worker, both engines) share a single
// definition instead of drifting copies. `hashContent` is re-exported below
// for compatibility with existing importers of this module.
export { hashContent } from "../trace/schema.js";

// V8 script URLs come back as `file://` (possibly with a vite/vitest
// transform query string, e.g. `?v=…`); anything else (`node:`, synthetic
// eval sources, data URLs) isn't one of the project's own source files.
//
// `roots` carries BOTH the configured project root and its realpath: V8
// reports symlink-RESOLVED paths, so when the project root itself sits
// behind a symlink (macOS `os.tmpdir()` → `/private/var/…` is the canonical
// case) `relative(configuredRoot, abs)` walks out via `..` and every hit
// would be dropped as "outside the project". Trying the realpath'd root
// second keeps both spellings working without an fs call per script.
export function toRelPath(
  roots: readonly [root: string, realRoot: string],
  url: string,
): string | undefined {
  if (!url.startsWith("file://")) return undefined;
  let abs: string;
  try {
    abs = fileURLToPath(url.split("?")[0]!);
  } catch {
    return undefined;
  }
  return absToRelPath(roots, abs);
}

export function relToRoots(roots: readonly [root: string, realRoot: string], abs: string): string {
  let rel = relative(roots[0], abs).split(sep).join("/");
  if ((rel.startsWith("..") || isAbsolute(rel)) && roots[0] !== roots[1]) {
    rel = relative(roots[1], abs).split(sep).join("/");
  }
  return rel;
}

export function absToRelPath(
  roots: readonly [root: string, realRoot: string],
  abs: string,
): string | undefined {
  const rel = relToRoots(roots, abs);
  return isExcludedRelPath(rel) ? undefined : rel;
}

// Default trace dir mirrors `TraceConfig.artifacts`'s documented default
// (`src/types.ts`: `.artgraph/trace/*.jsonl`), resolved against the vitest
// project root. `ARTGRAPH_TRACE_DIR` is this runner's own override point —
// primarily for the e2e suite, which needs each pool invocation to write
// into an isolated directory without touching `.artgraph.json`.
function resolveTraceDir(root: string): string {
  const override = process.env.ARTGRAPH_TRACE_DIR;
  if (!override) return resolve(root, ".artgraph/trace");
  return isAbsolute(override) ? override : resolve(root, override);
}

function randomToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function suitePathOf(test: RunnerTask): string[] {
  const names: string[] = [];
  // `suite` walks up to (and including) the file's own root suite, which
  // carries `filepath` (see `@vitest/runner`'s `File extends Suite`) — stop
  // there, it isn't a user-authored `describe()` name.
  let current: { name?: string; suite?: unknown } | undefined = (
    test as { suite?: { name?: string; suite?: unknown } }
  ).suite;
  while (current && !("filepath" in current)) {
    if (current.name) names.unshift(current.name);
    current = current.suite as typeof current;
  }
  return names;
}

// ---------------------------------------------------------------------------
// spec 022 (tasks.md T009, research.md V1/V3/V6) — instrument-engine (v2)
// support: engine selection, registry drain, and the batch-flush buffer.
// Exported as pure functions (no `this`, no vitest types) so
// `tests/vitest-runner-unit.test.ts` (T008) can pin their behavior directly
// without constructing a real `VitestTestRunner`.
// ---------------------------------------------------------------------------

export type Engine = "instrument" | "cdp";

/**
 * data-model.md §3 決定優先順位: `ARTGRAPH_TRACE_ENGINE` env var (worker-
 * visible; `withTrace`/`test.env` is how it gets there — spec 022 T015,
 * out of this task's scope) > default `'instrument'`. An unrecognized value
 * throws immediately (fail-fast, silent fallback forbidden — contracts/
 * config-surface.md), which — called from the runner constructor — fails
 * worker initialization loudly rather than silently degrading to a wrong
 * engine.
 */
export function resolveEngine(env: NodeJS.ProcessEnv = process.env): Engine {
  const raw = env.ARTGRAPH_TRACE_ENGINE;
  if (raw === undefined) return "instrument";
  if (raw === "instrument" || raw === "cdp") return raw;
  throw new Error(
    `[artgraph] invalid ARTGRAPH_TRACE_ENGINE="${raw}" — expected "instrument" or "cdp" ` +
      `(contracts/config-surface.md §環境変数).`,
  );
}

export interface DrainResult {
  hits: CoverageHit[];
  hashes: Record<string, string>;
  /** `true` when `registry.version` didn't match this build's
   * `REGISTRY_VERSION` — collection was abandoned for this call (`hits`/
   * `hashes` are empty) and the CALLER is responsible for the
   * once-per-worker stderr warning (contract §globalThis キー). */
  versionMismatch: boolean;
}

/**
 * contract §runner の義務 1-3: walk every `ModuleRegistration`'s `hits`,
 * convert set slots to `{file, fn}` pairs, zero-clear EVERY registration's
 * `hits` (regardless of whether it had any set slots — the clear is what
 * starts the next test's capture window, obligation 1: "クリアが次テストの
 * 採取窓の開始を兼ねる"), and copy `hash` only for files that actually
 * appear in `hits` (obligation 3, no fs access). A missing registry (plugin
 * not applied) or an empty one both yield empty results — normal
 * progression, not an error (obligation 4).
 */
export function drainTraceRegistry(registry: TraceRegistry | undefined): DrainResult {
  if (!registry) return { hits: [], hashes: {}, versionMismatch: false };
  if (registry.version !== REGISTRY_VERSION) return { hits: [], hashes: {}, versionMismatch: true };

  const hits: CoverageHit[] = [];
  const hashes: Record<string, string> = {};
  for (const reg of registry.modules.values()) {
    let anyHit = false;
    for (let i = 0; i < reg.hits.length; i++) {
      if (reg.hits[i] !== 0) {
        hits.push({ file: reg.file, fn: reg.fns[i]! });
        anyHit = true;
      }
    }
    if (anyHit) hashes[reg.file] = reg.hash;
    // Always clear — even modules with zero hits this window — so a module
    // loaded but not exercised doesn't carry a stale (already-zero, but
    // conceptually "read") window into the next test. Cheap: this is the
    // same Uint8Array.fill(0) research.md's perf summary measured at
    // ~0.013ms for 5,000 functions.
    reg.hits.fill(0);
  }
  return { hits, hashes, versionMismatch: false };
}

/** V6: a test belongs to a new file relative to whatever the buffer is
 * currently accumulating for — `undefined` (nothing buffered yet) is never
 * itself a boundary. */
export function isFileBoundary(
  bufferedTestFile: string | undefined,
  nextTestFile: string,
): boolean {
  return bufferedTestFile !== undefined && bufferedTestFile !== nextTestFile;
}

export function serializeRecord(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * V6 batch flush: returns the exact bytes to append — a verbatim
 * concatenation of already-`serializeRecord`-produced lines, each one
 * independently a complete `JSON.stringify(...) + "\n"` — and empties the
 * buffer in place. Returns `undefined` (no write) for an empty buffer
 * (contract §RunnerBuffer: "0 レコード時は flush しない").
 */
export function drainBuffer(buffer: string[]): string | undefined {
  if (buffer.length === 0) return undefined;
  const text = buffer.join("");
  buffer.length = 0;
  return text;
}

/**
 * research.md V8, tasks.md T016 — cdp-path-only: worker-local `path →
 * contentHash` memo, one of the two sanctioned cheap improvements (FR-013
 * caps investment there). A run's source files are assumed immutable for
 * its duration — the same per-run-immutability assumption the `instrument`
 * engine's transform-time hash already makes (V5) — so hashing a file once
 * on its first hit and reusing the result for every later test that also
 * hits it turns the recompute cost from "per test that hits this file"
 * into "once per file per worker". `readFile` is injected (rather than
 * this function calling `readFileSync` itself) so it can be pinned in
 * `tests/vitest-runner-unit.test.ts` without touching the real filesystem,
 * while the runtime instance passes a real disk read through the same
 * implementation.
 */
export function memoizedHash(
  memo: Map<string, string>,
  key: string,
  readFile: () => string,
): string {
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const hash = hashContent(readFile());
  memo.set(key, hash);
  return hash;
}

/**
 * `package.json#exports["./vitest"]` (`test.runner` target). Extends the
 * built-in `VitestTestRunner` (research.md D1) to bracket every test with a
 * `Profiler.takePreciseCoverage` drain (`onBeforeRunTask`) / read
 * (`onAfterRunTask`) pair, converting the delta into one TraceShard JSONL
 * `test` (or, for `it.concurrent`, `skipped`) record per test — appended to
 * a shard file unique to this worker (`${pid}-t${threadId}-${runToken}.jsonl`,
 * contract §ファイル配置: "ワーカーごとに独立 — 同時書込みなし").
 */
export default class ArtgraphTraceRunner extends VitestTestRunner {
  private readonly root: string;
  private readonly roots: readonly [string, string];
  private readonly traceDir: string;
  private readonly runToken: string;
  private readonly shardPath: string;
  private session: CdpSession | undefined;
  private ready: Promise<void> | undefined;
  private metaWritten = false;
  // URL → relPath memo. Coverage snapshots repeat the same script URLs on
  // every test, so this turns per-test path work into a single Map lookup
  // (and is where the symlink double-relativize cost is amortized away).
  private readonly relPathMemo = new Map<string, string | undefined>();
  // spec 022 (tasks.md T016, research.md V8) — cdp-path-only relPath →
  // contentHash memo (see `memoizedHash`'s doc comment for the rationale).
  private readonly hashMemo = new Map<string, string>();

  // spec 022 (T009) — instrument-engine (v2) state. `sawAnyRegistration` /
  // `warnedVersionMismatch` / `warnedNoRegistration` and `drain()` stay
  // unused on the `cdp` path (registry/no-plugin diagnostics don't apply to
  // an inspector-driven run); `buffer` / `bufferedTestFile` are now SHARED
  // with the `cdp` path too (T016, research.md V8/V6 — batch flush is one
  // of `cdp`'s two sanctioned cheap improvements), so the `cdp` path is no
  // longer byte-for-byte the pre-021 code: record CONTENT and the shard
  // contract are unchanged, only write TIMING (per-test → per-file-
  // boundary/final flush) changed.
  private readonly engine: Engine;
  private readonly buffer: string[] = [];
  private bufferedTestFile: string | undefined;
  private sawAnyRegistration = false;
  private warnedVersionMismatch = false;
  private warnedNoRegistration = false;

  constructor(...args: ConstructorParameters<typeof VitestTestRunner>) {
    super(...args);
    // Resolved FIRST (before any other init): an invalid
    // `ARTGRAPH_TRACE_ENGINE` must fail worker construction loudly
    // (fail-fast, contracts/config-surface.md) rather than let a
    // half-initialized runner limp into `onBeforeRunTask`.
    this.engine = resolveEngine();
    this.root = this.config.root;
    let realRoot = this.root;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      // Root not resolvable (should not happen for a running vitest) —
      // fall back to the configured spelling only.
    }
    this.roots = [this.root, realRoot];
    this.traceDir = resolveTraceDir(this.root);
    this.runToken = randomToken();
    const workerId = `${process.pid}-t${threadId}`;
    this.shardPath = resolve(this.traceDir, `${workerId}-${this.runToken}.jsonl`);
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initProfiler();
    }
    return this.ready;
  }

  private async initProfiler(): Promise<void> {
    const session = new inspector.Session();
    session.connect();
    const post = (method: string, params?: Record<string, unknown>) =>
      new Promise<any>((res, rej) => {
        session.post(method, params, (err: Error | null, result: unknown) =>
          err ? rej(err) : res(result),
        );
      });
    await post("Profiler.enable");
    await post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    this.session = { post } as unknown as CdpSession;
    mkdirSync(this.traceDir, { recursive: true });
  }

  private append(record: unknown): void {
    appendFileSync(this.shardPath, `${JSON.stringify(record)}\n`, "utf-8");
  }

  private writeMetaOnce(): void {
    if (this.metaWritten) return;
    this.metaWritten = true;
    // The `cdp` path creates `traceDir` inside `initProfiler` (which always
    // runs before this, via `ensureReady`); the `instrument` path never
    // calls `initProfiler` at all, so this call is what ensures the
    // directory exists before this class's first `appendFileSync` — cheap
    // and idempotent (`recursive: true`) either way.
    mkdirSync(this.traceDir, { recursive: true });
    let vitestVersion = "unknown";
    try {
      vitestVersion = (nodeRequire("vitest/package.json") as { version: string }).version;
    } catch {
      // best-effort — `vitest` field is diagnostic-only (contract §meta).
    }
    this.append({
      schemaVersion: SCHEMA_VERSION,
      kind: "meta",
      runToken: this.runToken,
      // `this.pool` is inherited from the base `TestRunner` — it's already
      // populated (from the real worker context, not a heuristic) by the
      // time `super(...)` returns in this class's constructor.
      pool: this.pool,
      vitest: vitestVersion,
      startedAt: new Date().toISOString(),
    });
  }

  override async onBeforeRunTask(test: RunnerTask): Promise<void> {
    if (this.engine === "instrument") {
      // No inspector on this path at all (research.md V1) — the capture
      // window is delimited entirely by `onAfterRunTask`'s drain-then-clear
      // (contract §runner の義務 1: "クリアが次テストの採取窓の開始を兼ねる"),
      // so there is no "before" work to do.
      return super.onBeforeRunTask(test);
    }
    await this.ensureReady();
    this.writeMetaOnce();
    // Drain whatever accumulated since the previous test (or since
    // `startPreciseCoverage`, for the very first task) so this test's
    // window starts at zero — `takePreciseCoverage` resets V8's counters on
    // every call (research.md R1: "呼ぶたびにカウンタをリセットする").
    await this.session!.post("Profiler.takePreciseCoverage");
    return super.onBeforeRunTask(test);
  }

  override async onAfterRunTask(test: RunnerTask): Promise<void> {
    if (this.engine === "instrument") {
      await super.onAfterRunTask(test);
      return this.onAfterRunTaskInstrument(test);
    }
    await super.onAfterRunTask(test);
    await this.ensureReady();
    const { result } = await this.session!.post("Profiler.takePreciseCoverage");

    const testFile = test.file?.filepath ? relToRoots(this.roots, test.file.filepath) : "";
    // T016: the cdp path now shares the instrument path's batch-flush
    // buffer (V6) instead of an `appendFileSync` per test — same file-
    // boundary flush semantics, same shard contract (record content/
    // ordering unchanged, only the write TIMING changes).
    this.maybeFlushOnBoundary(testFile);

    // FR-003 / D5: concurrent tests can't be isolated (their coverage
    // windows overlap with sibling concurrent tests) — record the
    // attribution loss explicitly rather than write a misleading record.
    if ((test as { concurrent?: boolean }).concurrent) {
      this.bufferRecord({
        kind: "skipped",
        testName: test.name,
        testFile,
        reason: "concurrent",
      });
      return;
    }

    const state = (test as { result?: { state?: string } }).result?.state;
    // `runTest` (see @vitest/runner) only invokes `onAfterRunTask` for tasks
    // that actually ran (mode `run`/`queued`), so `state` is `pass` or
    // `fail` here — this guard is defensive, not load-bearing.
    if (state !== "pass" && state !== "fail") return;

    const hits: CoverageHit[] = [];
    for (const script of result) {
      let file: string | undefined;
      if (this.relPathMemo.has(script.url)) {
        file = this.relPathMemo.get(script.url);
      } else {
        file = toRelPath(this.roots, script.url);
        this.relPathMemo.set(script.url, file);
      }
      if (file === undefined) continue;
      for (const fn of script.functions) {
        // module-init exclusion (FR-007 前段, contract §test): V8 reports a
        // module's top-level execution as a FunctionCoverage entry with an
        // empty `functionName` — keep only named functions.
        if (fn.functionName === "") continue;
        if (fn.ranges.some((r) => r.count > 0)) {
          hits.push({ file, fn: fn.functionName });
        }
      }
    }

    const hashes: Record<string, string> = {};
    for (const hit of hits) {
      if (hashes[hit.file] !== undefined) continue;
      try {
        // T016 / V8: memoized across the whole worker lifetime, not just
        // within this test — see `memoizedHash`'s doc comment.
        hashes[hit.file] = memoizedHash(this.hashMemo, hit.file, () =>
          readFileSync(resolve(this.root, hit.file), "utf-8"),
        );
      } catch {
        // File vanished between execution and hashing (shouldn't happen at
        // capture time — this test just ran code from it). Leave it
        // unhashed rather than crash the worker; a hit with no matching
        // `hashes` entry is ingest's problem (dangling), not this module's.
        // (Deliberately NOT memoized — a transient read failure shouldn't
        // pin a missing hash for the rest of the worker's lifetime.)
      }
    }

    this.bufferRecord({
      kind: "test",
      testName: test.name,
      suitePath: suitePathOf(test),
      testFile,
      passed: state === "pass",
      hits,
      hashes,
    });
  }

  // -------------------------------------------------------------------------
  // spec 022 (T009) — instrument engine (v2). Reads `globalThis[REGISTRY_KEY]`
  // (written by `src/vitest/plugin.ts`'s preamble — contracts/
  // instrumentation-runtime.md) instead of driving an inspector session.
  // -------------------------------------------------------------------------

  private currentRegistry(): TraceRegistry | undefined {
    return (globalThis as unknown as Record<string, TraceRegistry | undefined>)[REGISTRY_KEY];
  }

  private drain(): DrainResult {
    const registry = this.currentRegistry();
    if (registry && registry.modules.size > 0) this.sawAnyRegistration = true;
    const result = drainTraceRegistry(registry);
    if (result.versionMismatch && !this.warnedVersionMismatch) {
      this.warnedVersionMismatch = true;
      process.stderr.write(
        "[artgraph] trace registry version mismatch — abandoning instrument-engine collection for " +
          "this worker (contracts/instrumentation-runtime.md §globalThis キー).\n",
      );
    }
    return result;
  }

  private bufferRecord(record: unknown): void {
    this.buffer.push(serializeRecord(record));
  }

  // V6: flush whatever is buffered for the PRIOR test file before this
  // test's record joins the buffer under its (possibly new) file.
  private maybeFlushOnBoundary(testFile: string): void {
    if (isFileBoundary(this.bufferedTestFile, testFile)) this.flush();
    this.bufferedTestFile = testFile;
  }

  private flush(): void {
    const text = drainBuffer(this.buffer);
    if (text === undefined) return; // 0 レコード時は flush しない
    try {
      appendFileSync(this.shardPath, text, "utf-8");
    } catch (err) {
      // A write failure must not kill the worker or fail the test run
      // (観点4) — the shard for this batch is lost, but collection
      // continues; ingest already treats missing/partial shards as
      // diagnostics, not fatal errors.
      process.stderr.write(`[artgraph] trace shard write failed: ${String(err)} — continuing.\n`);
    }
  }

  private async onAfterRunTaskInstrument(test: RunnerTask): Promise<void> {
    this.writeMetaOnce();
    const testFile = test.file?.filepath ? relToRoots(this.roots, test.file.filepath) : "";
    this.maybeFlushOnBoundary(testFile);

    // FR-003 / D5, contract §runner の義務 2: concurrent tests still get
    // drained (clearing the window for whatever runs next) even though
    // their coverage can't be attributed — only the record differs.
    if ((test as { concurrent?: boolean }).concurrent) {
      this.drain();
      this.bufferRecord({ kind: "skipped", testName: test.name, testFile, reason: "concurrent" });
      return;
    }

    const state = (test as { result?: { state?: string } }).result?.state;
    if (state !== "pass" && state !== "fail") {
      // Defensive (see the `cdp` path's identical comment) — still drain so
      // a skipped-hook task doesn't leave a dirty window for the next test.
      this.drain();
      return;
    }

    const { hits, hashes } = this.drain();
    this.bufferRecord({
      kind: "test",
      testName: test.name,
      suitePath: suitePathOf(test),
      testFile,
      passed: state === "pass",
      hits,
      hashes,
    });
  }

  override onAfterRunFiles(): void {
    super.onAfterRunFiles();
    // T016: final flush is shared by both engines now — whatever's left
    // after the last test file in this worker's batch (V6).
    this.flush();
    if (this.engine !== "instrument") return;
    if (!this.sawAnyRegistration && !this.warnedNoRegistration) {
      this.warnedNoRegistration = true;
      // FR-008: a plugin-less `instrument` run (e.g. `test.runner` set
      // directly without `withTrace()`, or `withTrace()` misconfigured to
      // skip plugin injection) silently produces empty shards forever
      // without this — contracts/config-surface.md's documented escape
      // hatches are surfaced directly in the warning.
      process.stderr.write(
        "[artgraph] trace instrumentation: no module was ever registered by this worker — hits will " +
          "always be empty. Use `withTrace()` (which injects the instrumentation plugin), or set " +
          "ARTGRAPH_TRACE_ENGINE=cdp to fall back to the legacy inspector-based engine.\n",
      );
    }
  }
}
