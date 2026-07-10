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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SCHEMA_VERSION, type CoverageHit } from "../trace/schema.js";

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

// The repo's own file-mode `contentHash` (src/parsers/typescript.ts): BOM
// stripped, sha256 hex, truncated to 16 chars. Duplicated (not imported) —
// this module's only allowed `src/` import is `src/trace/schema.ts`
// (importing the parser would drag oxc-parser and the rest of the CLI into
// every vitest worker). MUST stay byte-for-byte identical to the original:
// Phase C staleness compares this shard-recorded hash directly against the
// graph's `contentHash` for the same file.
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

// Exported (spec 020 T012) purely for `tests/hash-equivalence.test.ts`'s SSOT
// equivalence pin against `src/parsers/typescript.ts`'s `hash(stripBom(...))`
// — no runtime caller outside this file needs the content-only form.
export function hashContent(content: string): string {
  return createHash("sha256").update(stripBom(content)).digest("hex").slice(0, 16);
}

function hashFileContent(absPath: string): string {
  return hashContent(readFileSync(absPath, "utf-8"));
}

// contract §hits: "テストファイル自身・node_modules が hits に現れない" — the
// finer-grained `include`/`exclude` boundary is ingest's job (contract
// §hits: "それ以外の絞り込みは ingest 側の責務"), so this is deliberately
// coarse: strip only the two categories the contract names.
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function isExcludedRelPath(relPath: string): boolean {
  return (
    relPath.startsWith("..") ||
    isAbsolute(relPath) ||
    relPath.includes("node_modules/") ||
    TEST_FILE_RE.test(relPath)
  );
}

// V8 script URLs come back as `file://` (possibly with a vite/vitest
// transform query string, e.g. `?v=…`); anything else (`node:`, synthetic
// eval sources, data URLs) isn't one of the project's own source files.
function toRelPath(root: string, url: string): string | undefined {
  if (!url.startsWith("file://")) return undefined;
  let abs: string;
  try {
    abs = fileURLToPath(url.split("?")[0]!);
  } catch {
    return undefined;
  }
  const rel = relative(root, abs).split(sep).join("/");
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
  private readonly traceDir: string;
  private readonly runToken: string;
  private readonly shardPath: string;
  private session: CdpSession | undefined;
  private ready: Promise<void> | undefined;
  private metaWritten = false;

  constructor(...args: ConstructorParameters<typeof VitestTestRunner>) {
    super(...args);
    this.root = this.config.root;
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
    await super.onAfterRunTask(test);
    await this.ensureReady();
    const { result } = await this.session!.post("Profiler.takePreciseCoverage");

    const testFile = test.file?.filepath
      ? relative(this.root, test.file.filepath).split(sep).join("/")
      : "";

    // FR-003 / D5: concurrent tests can't be isolated (their coverage
    // windows overlap with sibling concurrent tests) — record the
    // attribution loss explicitly rather than write a misleading record.
    if ((test as { concurrent?: boolean }).concurrent) {
      this.append({
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
      const file = toRelPath(this.root, script.url);
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
        hashes[hit.file] = hashFileContent(resolve(this.root, hit.file));
      } catch {
        // File vanished between execution and hashing (shouldn't happen at
        // capture time — this test just ran code from it). Leave it
        // unhashed rather than crash the worker; a hit with no matching
        // `hashes` entry is ingest's problem (dangling), not this module's.
      }
    }

    this.append({
      kind: "test",
      testName: test.name,
      suitePath: suitePathOf(test),
      testFile,
      passed: state === "pass",
      hits,
      hashes,
    });
  }
}
