// spec 020 (data-model.md §2, contracts/trace-artifact.md §ingest 側の義務) —
// the ingest layer: reads TraceShard JSONL artifacts (via `./schema.js`'s
// SSOT parse/normalize), joins REQ tags (spec 006's describe-ancestor rule,
// reused from `src/test-results.ts`) and hit function names (via
// `./symbol-table.js`) into a deterministic per-REQ coverage summary.
//
// Deliberately never imports `vitest` (plan.md Structure Decision — the CLI
// stays runner-agnostic) and never mutates graph/lock: Phase A's contract is
// "read shards, produce report material" only. `src/graph/builder.ts` (T015)
// and `src/commands/trace.ts` (T011) are the consumers.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { listFilesGuarded } from "../glob-utils.js";
import type { ArtgraphConfig, ArtifactGraph, GraphNode } from "../types.js";
import { resolveReqTags } from "../test-results.js";
import { systemResourceExhaustedMessage, type TsParseWarning } from "../parsers/typescript.js";
import {
  parseShardLines,
  normalizeTrace,
  type ParsedShard,
  type TraceDiagnostics,
} from "./schema.js";
import { buildSymbolNameTable } from "./symbol-table.js";

const DEFAULT_TRACE_ARTIFACTS = [".artgraph/trace/*.jsonl"];

export interface TestRef {
  testFile: string;
  testName: string;
}

export interface ReqCoverage {
  /** Symbol-grain nodeIds (`symbol:<relPath>#<name>`), sorted, deduped —
   * the green-test coverage UNION for this REQ (FR-006, US1-4 N:M). */
  symbols: string[];
  /** File-grain fallback nodeIds (`file:<relPath>`), sorted, deduped
   * (FR-007 fail-safe: unresolvable-name hits and out-of-scope-but-tagged
   * evidence still reach the REQ, just at coarser grain). */
  files: string[];
  /** Every green `[REQ-NNN]`-tagged test that contributed to this REQ's
   * evidence (with or without hits — module-init-only tests still count as
   * "ran"), sorted by (testFile, testName). Material for `impact --tests`
   * (T021/T022). */
  tests: TestRef[];
}

/**
 * Ingest-layer output. This is data-model.md §2's "NormalizedTrace" —
 * deliberately NOT reusing that name here, because `./schema.js` already
 * exports a `NormalizedTrace` for the shard-level (tests/skipped/
 * diagnostics) shape; `IngestedTrace` is one layer up, keyed by REQ.
 * `graph = f(files, trace)`'s trace-side input (FR-011 determinism):  the
 * same shard files + the same source tree always produce a byte-identical
 * `IngestedTrace` (sorted arrays, Map insertion order fixed to sorted
 * reqId — see `ingestTrace`).
 */
export interface IngestedTrace {
  /** Per-REQ coverage. Map iteration order is sorted-reqId (deterministic
   * regardless of shard/test processing order). */
  perReq: Map<string, ReqCoverage>;
  /**
   * nodeId -> contentHash of the FILE the node belongs to, as recorded by
   * the runner at trace-capture time (TraceShard `hashes`; the wire schema
   * only carries file-grain hashes — see `./schema.js`'s `ShardTestRecord`
   * — so a symbol node's staleness baseline is its file's hash, FR-005 /
   * FR-015). Populated only for nodes that ended up in some `perReq`
   * bucket's `symbols`/`files`.
   */
  hashesAtTrace: Map<string, string>;
  /** Shard-level diagnostics, spread from `normalizeTrace` with `dangling`
   * overridden by this layer's own count — the contract `./schema.js`'s
   * `TraceDiagnostics.dangling` field doc documents ("ingest can spread
   * this object and only ever override `dangling`"). Never silently
   * dropped: `unknownSchema` / `corrupted` / `skipped` all originate one
   * layer down in `parseShardLines` / `normalizeTrace` and are carried
   * through unchanged. */
  diagnostics: TraceDiagnostics;
  /**
   * nodeId -> the set of distinct reqIds whose green-tagged-test evidence
   * reaches it (union across `symbols` and `files`). The classification
   * layer (`src/commands/trace.ts` T010/T011, `src/coverage.ts` T019/T020)
   * consumes this for FR-013's exclusivity ruling: `size === 1` ->
   * exclusive (suggestable / exercised-eligible), `2 .. sharedThreshold-1`
   * -> silent (no finding, edge still exists for impact), `>=
   * sharedThreshold` -> infrastructure.
   */
  reqsByNode: Map<string, Set<string>>;
  /**
   * Number of shard FILES matched by `trace.artifacts` and successfully
   * read (before any per-line parsing/validation). `0` is the "no trace
   * captured at all" signal `src/commands/trace.ts` (T011) uses for its
   * exit-1 + runner-setup guidance (contracts/cli-surface.md §2, FR-018's
   * sibling wording) — distinct from "shards exist but contributed zero
   * usable records" (unknownSchema / corrupted only), which is a diagnostic,
   * not a hard error.
   */
  shardCount: number;
}

interface ShardDiscoveryResult {
  paths: string[];
  /** Set when at least one pattern's `fast-glob` call hit EMFILE/ENFILE (via
   * `listFilesGuarded`). `paths` is still whatever the OTHER patterns
   * (if any) managed to enumerate — never treated as "no shards", so a
   * caller must consult this field, not `paths.length === 0`, to tell
   * "genuinely no shards" apart from "couldn't tell". */
  resourceExhaustedCode?: "EMFILE" | "ENFILE";
}

// issue #351 (Step 0-pre HIGH-1, `src/glob-utils.ts`'s #335 header comment)
// — this used to call the `glob` package's `globSync` directly, the one
// shard-discovery call site that comment calls out as still unmigrated: the
// `glob` package's `globSync` does not throw on EMFILE/ENFILE
// (`path-scurry`'s `#readdirFail` maps an unknown errno to an empty child
// list and returns silently), so a file-descriptor storm during trace-shard
// enumeration used to vanish an entire shard set with NO diagnostic at all —
// the `catch { continue }` below never even ran, because `globSync` never
// threw in the first place. Routed through `listFilesGuarded` (fast-glob)
// now: EMFILE/ENFILE is caught internally by that helper and surfaced here
// via `resourceExhaustedCode` instead of silently returning `[]`. Every
// OTHER glob failure (a malformed pattern) keeps the pre-existing "skip just
// that one pattern" behavior — `listFilesGuarded` itself only swallows
// EMFILE/ENFILE, so a genuine bad-pattern error still throws out of it and
// is caught, per-pattern, right here.
function discoverShardPaths(rootDir: string, patterns: string[]): ShardDiscoveryResult {
  const paths = new Set<string>();
  let resourceExhaustedCode: "EMFILE" | "ENFILE" | undefined;
  for (const pattern of patterns) {
    let result: ReturnType<typeof listFilesGuarded>;
    try {
      result = listFilesGuarded(pattern, { cwd: rootDir });
    } catch {
      // An invalid glob shouldn't crash a fully-opt-in feature; just skip it.
      continue;
    }
    if (result.resourceExhaustedCode) {
      resourceExhaustedCode = result.resourceExhaustedCode;
      continue;
    }
    for (const m of result.files) paths.add(m);
  }
  // Sorted for reproducible reads. `normalizeTrace` is itself order-
  // independent (FR-004) — this is hygiene, not a correctness dependency.
  return { paths: [...paths].sort(), resourceExhaustedCode };
}

interface LoadShardsResult {
  shards: ParsedShard[];
  resourceExhaustedCode?: "EMFILE" | "ENFILE";
}

function loadShards(rootDir: string, patterns: string[]): LoadShardsResult {
  const { paths, resourceExhaustedCode: discoveryCode } = discoverShardPaths(rootDir, patterns);
  const shards: ParsedShard[] = [];
  let resourceExhaustedCode = discoveryCode;
  for (const p of paths) {
    let content: string;
    try {
      content = readFileSync(p, "utf-8");
    } catch (e) {
      // issue #351 (H1) — a shard FILE (as opposed to the glob enumeration
      // above) can independently hit EMFILE/ENFILE between discovery and
      // read; skip just that shard (matching `discoverShardPaths`'s own
      // per-pattern fail-safety) and record the same resource-exhaustion
      // signal rather than letting a genuine fd-exhaustion crash propagate
      // uncaught. Any OTHER read failure (permissions, ENOENT from a
      // concurrent delete, …) still throws — this layer only ever
      // fail-safes the specific "process/system ran out of fds" case.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EMFILE" || code === "ENFILE") {
        resourceExhaustedCode = code;
        continue;
      }
      throw e;
    }
    shards.push(parseShardLines(content));
  }
  return { shards, resourceExhaustedCode };
}

/**
 * Cheap existence probe (glob only, no read/parse) so `src/graph/builder.ts`
 * (T015) can skip `ingestTrace` — and the `buildSymbolNameTable` re-parse it
 * triggers — entirely on a trace-absent project. FR-010: byte-identical
 * output AND unchanged cost when no trace artifacts exist.
 *
 * issue #351 (H1) — `resourceExhausted` is `true` when the underlying glob
 * hit EMFILE/ENFILE for at least one pattern: `present` in that case is NOT
 * a reliable "no shards" signal (some/all patterns could not even be
 * evaluated), so a caller must branch on `resourceExhausted` FIRST — never
 * infer "no trace" from `present === false` alone without also checking it.
 */
export function hasTraceShards(
  config: ArtgraphConfig,
  rootDir: string,
): { present: boolean; resourceExhausted: boolean } {
  const artifactPatterns = config.trace?.artifacts ?? DEFAULT_TRACE_ARTIFACTS;
  const { paths, resourceExhaustedCode } = discoverShardPaths(rootDir, artifactPatterns);
  return { present: paths.length > 0, resourceExhausted: resourceExhaustedCode !== undefined };
}

function testKey(testFile: string, testName: string): string {
  return `${testFile} ${testName}`;
}

function sortedTestRefs(keys: Iterable<string>): TestRef[] {
  return [...keys].sort().map((key) => {
    const idx = key.indexOf(" ");
    return { testFile: key.slice(0, idx), testName: key.slice(idx + 1) };
  });
}

interface Bucket {
  symbols: Set<string>;
  files: Set<string>;
  tests: Set<string>;
}

/**
 * Read the configured trace shards, join REQ tags + hit names, and produce
 * the deterministic per-REQ coverage summary that `src/commands/trace.ts`
 * (T010/T011) and, later, `src/graph/builder.ts` (T014/T015) consume. Pure
 * read: touches only the shard files and the source tree needed to build
 * the (transient) SymbolNameTable — never writes graph/lock, never throws
 * on a missing/empty trace (FR-010: trace absence is a fully opt-in input).
 *
 * issue #351 (Step 0-pre HIGH-1/HIGH-1b/HIGH-2, "Window B" elimination) —
 * `buildSymbolNameTable` can now hit EMFILE/ENFILE and degrade fail-safe
 * instead of throwing (see that function's own doc comment); its
 * `warnings: TsParseWarning[]` are threaded straight through here rather
 * than swallowed, so a caller can surface them. `IngestedTrace` itself
 * deliberately does NOT carry warnings (the scan-level `warnings` array —
 * `src/graph/builder.ts`'s `BuildWarning[]` — is the single place a caller
 * prints/embeds them; see `src/graph/builder.ts`'s own conversion of this
 * return value for how the two shapes are kept from double-printing).
 *
 * issue #351 (H1) — `loadShards`'s own EMFILE/ENFILE (either the shard glob
 * itself, via `discoverShardPaths`, or an individual shard's `readFileSync`)
 * is folded into this same `warnings` array as a `system-resource-exhausted`
 * entry, one layer below `buildSymbolNameTable`'s own guard — so a caller
 * only ever has to drain ONE `warnings` array to see every resource-
 * exhaustion signal this function's read path can produce.
 */
export function ingestTrace(
  config: ArtgraphConfig,
  rootDir: string,
): { trace: IngestedTrace; warnings: TsParseWarning[] } {
  const artifactPatterns = config.trace?.artifacts ?? DEFAULT_TRACE_ARTIFACTS;
  const { shards, resourceExhaustedCode: shardsResourceExhaustedCode } = loadShards(
    rootDir,
    artifactPatterns,
  );
  const normalized = normalizeTrace(shards);
  const { table, warnings: symbolTableWarnings } = buildSymbolNameTable(
    rootDir,
    config.include,
    config.testPatterns,
  );
  const warnings: TsParseWarning[] = [...symbolTableWarnings];
  if (shardsResourceExhaustedCode) {
    warnings.push({
      type: "system-resource-exhausted",
      symbolId: "glob:trace-shards",
      filePath: "",
      message: systemResourceExhaustedMessage(shardsResourceExhaustedCode),
    });
  }

  const buckets = new Map<string, Bucket>();
  const hashesAtTrace = new Map<string, string>();
  const reqsByNode = new Map<string, Set<string>>();
  let dangling = 0;

  const getBucket = (reqId: string): Bucket => {
    let bucket = buckets.get(reqId);
    if (!bucket) {
      bucket = { symbols: new Set(), files: new Set(), tests: new Set() };
      buckets.set(reqId, bucket);
    }
    return bucket;
  };

  const addNodeReq = (nodeId: string, reqId: string): void => {
    let reqIds = reqsByNode.get(nodeId);
    if (!reqIds) {
      reqIds = new Set();
      reqsByNode.set(nodeId, reqIds);
    }
    reqIds.add(reqId);
  };

  for (const test of normalized.tests) {
    // D6 (contract §ingest 側の義務 (2)): only green records are evidence.
    // The record itself was never dropped — `normalizeTrace` (T003/T004)
    // already retains every parseable test/skipped record for diagnostics —
    // this layer just declines to build edges from a failing run.
    if (!test.passed) continue;

    const reqIds = resolveReqTags(test.testName, test.suitePath);
    if (reqIds.length === 0) continue; // untagged: nothing to attribute to

    const key = testKey(test.testFile, test.testName);
    // A tagged green test registers as "ran for this REQ" regardless of
    // whether any of its hits resolve to a node below — a module-init-only
    // test (US1-6) or a test whose every hit is dangling/out-of-boundary
    // still belongs in `tests` (impact --tests material), just contributes
    // nothing to `symbols`/`files`.
    for (const reqId of reqIds) {
      getBucket(reqId).tests.add(key);
    }

    for (const hit of test.hits) {
      if (!table.hasFile(hit.file)) {
        // Not in scope right now. Tell "still exists but out of `include`"
        // (silent exclusion, contract §Edge Cases "exclude glob との交差")
        // apart from "no longer exists" (dangling, §Edge Cases "trace 内の
        // 消滅ファイル/シンボル") — the latter is diagnostic-worthy, the
        // former is by design and silent.
        if (existsSync(resolve(rootDir, hit.file))) continue;
        dangling++;
        continue;
      }

      const resolved = table.resolve(hit.file, hit.fn);
      const fileHash = test.hashes[hit.file];

      for (const reqId of reqIds) {
        const bucket = getBucket(reqId);
        if (resolved.kind === "symbol") bucket.symbols.add(resolved.id);
        else bucket.files.add(resolved.id);
        addNodeReq(resolved.id, reqId);
      }
      if (fileHash !== undefined) hashesAtTrace.set(resolved.id, fileHash);
    }
  }

  const perReq = new Map<string, ReqCoverage>();
  for (const reqId of [...buckets.keys()].sort()) {
    const bucket = buckets.get(reqId)!;
    perReq.set(reqId, {
      symbols: [...bucket.symbols].sort(),
      files: [...bucket.files].sort(),
      tests: sortedTestRefs(bucket.tests),
    });
  }

  return {
    trace: {
      perReq,
      hashesAtTrace,
      diagnostics: { ...normalized.diagnostics, dangling },
      reqsByNode,
      shardCount: shards.length,
    },
    warnings,
  };
}

// issue #351 (Step 0-pre "trace status must work with zero shards") —
// `src/commands/check.ts` / `src/commands/impact.ts` / `src/commands/
// trace.ts` no longer call `ingestTrace` themselves (Window B elimination):
// they consume `scan()`'s own `trace?: IngestedTrace` field instead, which
// is `undefined` on a trace-absent project (`hasTraceShards` false — see
// `src/graph/builder.ts`'s FR-010 byte-identical-output contract). `trace
// status` is the one caller that must still produce a full `IngestedTrace`-
// shaped result even with zero shards (its own contract: "shards 0 件でも
// 動く"), so it substitutes this zero-value in place of calling `ingestTrace`
// again. Shaped to match `normalizeTrace([])`'s diagnostics exactly
// (unknownSchema/corrupted/skipped all 0 from an empty shard list; dangling
// 0 — this layer's own override, see `IngestedTrace.diagnostics`'s doc).
export function emptyIngestedTrace(): IngestedTrace {
  return {
    perReq: new Map(),
    hashesAtTrace: new Map(),
    diagnostics: { unknownSchema: 0, corrupted: 0, skipped: 0, dangling: 0, offGraph: 0 },
    reqsByNode: new Map(),
    shardCount: 0,
  };
}

// issue #275 — SSOT node-id resolution shared between `src/graph/builder.ts`'s
// `mergeTraceEdges` (folding trace evidence into graph edges, symbol-mode
// grain) and `filterTraceToGraph` below (dropping ghost nodes from an
// `IngestedTrace` before it reaches any other consumer). Exported from here
// (rather than from builder.ts, which already imports `ingestTrace` /
// `hasTraceShards` from this module) so there is exactly one place this
// degrade rule lives — a naive `graph.nodes.has(id)` in either caller would
// treat a `symbol:` id as "off graph" whenever the CURRENT graph is
// file-mode (zero `symbol:` nodes ever exist there), even though the id's
// owning FILE node is a perfectly real graph member. That over-filter is the
// exact class of regression `filterTraceToGraph`'s A-T4 test guards: real
// evidence must never be lost just because the graph's `mode` doesn't carry
// symbol-grain nodes.
//
// `ingestTrace`'s `SymbolNameTable` always resolves hits at symbol grain
// internally (see `./symbol-table.js`'s header comment), independent of
// `config.mode` — so a file-mode graph's `symbol:<rel>#<name>` trace ids
// dangle by construction unless degraded to their owning `file:<rel>` node.
// Returns `undefined` only when NEITHER the exact id NOR (for a `symbol:`
// id) its owning file is a real node in `nodes` — out of `include`/
// `testPatterns` scope for this build, or a stale/mismatched symbol table.
export function resolveTraceGraphNodeId(
  nodeId: string,
  nodes: Map<string, GraphNode>,
): string | undefined {
  if (nodes.has(nodeId)) return nodeId;
  if (nodeId.startsWith("symbol:")) {
    const body = nodeId.slice("symbol:".length);
    // issue #377 — split on the LAST `#`, not the first. A filePath may
    // legally contain `#`, and cutting at the first one produces a path no
    // node carries, so the file-grain fallback below misses and the caller
    // drops the evidence with no warning at all. No filePath is available
    // here — deriving one from the id is this function's whole purpose — so
    // the prefix-strip used in trace/symbol-table.ts is not an option.
    const hashIdx = body.lastIndexOf("#");
    const relPath = hashIdx === -1 ? body : body.slice(0, hashIdx);
    const fileId = `file:${relPath}`;
    if (nodes.has(fileId)) return fileId;
  }
  return undefined;
}

/**
 * issue #275 — filter an `IngestedTrace` down to node ids the CURRENT graph
 * can actually resolve (via `resolveTraceGraphNodeId` above), so a
 * `testPatterns`-only negative pattern (or any other divergence between
 * `buildSymbolNameTable`'s `config.include`-only file set and
 * `buildGraph`'s `[...include, ...testPatterns]` file set — see this
 * module's `ingestTrace`/`buildSymbolNameTable` and
 * `.artgraph.json`'s `testPatterns` doc in `src/types.ts`) can never smuggle
 * a "ghost" node — one that exists in the trace's symbol table but not in
 * the graph — into `classifyEvidence` (phantom `suggestedImpls`/
 * `infrastructure`), `src/coverage.ts`'s `isExercisedEligible` (false-green
 * `exercised` rescue under `acceptExercises: true`), or
 * `computeStaleNodeIds` (false-red `staleness: "gate"` exit 2 for a file the
 * graph doesn't even know about).
 *
 * Every consumer of `ingestTrace`'s output OTHER than `src/graph/builder.ts`
 * itself MUST route the ingested trace through this filter before handing it
 * to `classifyEvidence` / `computeCoverage` / `computeStaleNodeIds` / test
 * selection. `buildGraph`'s own `ingestTrace` call is the one exception: its
 * `mergeTraceEdges` already applies `resolveTraceGraphNodeId` per (reqId,
 * node) pair while emitting graph edges, so its output can never be
 * contaminated by a ghost node in the first place — running this filter
 * there too would be redundant, not wrong.
 *
 * issue #351 ("Window B" elimination) — `ingestTrace` itself now runs at
 * most once per process (inside `buildGraph`, reached via `scan()`):
 * `src/commands/check.ts`, `src/commands/impact.ts`'s `--tests`, and
 * `src/commands/trace.ts`'s `status`/`report` no longer call `ingestTrace`
 * directly — they consume `scan()`'s own `trace?: IngestedTrace` field
 * instead. This does not change WHO must call `filterTraceToGraph`: each of
 * those three still calls it themselves (on the trace `scan()` handed them),
 * same as before — only the ghost-node risk this filter guards against is
 * now shared by every consumer against a single ingest, rather than each
 * consumer's own independent (and potentially non-identical, if the file
 * system changed between calls) re-ingest.
 *
 * `perReq[reqId].tests` (the raw tagged-test list) is left untouched, same
 * rationale as `src/trace/report.ts`'s `excludeStaleEvidence`: a ghost
 * node's EXECUTION evidence is dropped, but the fact that a green tagged
 * test ran is not itself graph-membership-dependent (`impact --tests` still
 * wants to know a REQ has tests even when none of its hits resolved to a
 * graph node).
 *
 * A kept entry's node id is REPLACED by `resolveTraceGraphNodeId`'s return
 * value, not left as the original trace-side id — a `symbol:` id that
 * degrades to its owning `file:` node is rekeyed/moved to that `file:` id
 * everywhere (`reqsByNode`, `hashesAtTrace`, and `perReq[].symbols`/`.files`,
 * where a degraded id moves OUT of `symbols` and INTO `files` so `symbols`
 * never contains an id absent from the graph). This matters beyond cosmetics:
 * without it, `classifyEvidence` (`src/trace/report.ts`) and
 * `isExercisedEligible` (`src/coverage.ts`) would keep comparing/reporting a
 * `symbol:` id no node in a file-mode graph ever has, so `reqExercises`'s
 * claim-corroboration check (which compares against `coverage.symbols`/
 * `.files` at the CLAIM's own grain) would silently miss real evidence, and
 * `suggestedImpls` would surface an id `trace report`'s JSON consumers can't
 * resolve back to any real graph node. Two (or more) original ids CAN
 * degrade to the SAME resolved id — e.g. `symbol:src/foo.ts#a` and
 * `symbol:src/foo.ts#b` both falling back to `file:src/foo.ts` — in which
 * case their `reqsByNode` reqId sets are UNIONed (never overwritten) and
 * their `symbols`/`files` contributions are deduped after the move. When the
 * resolved id already equals the original (mode:"symbol", exact match, the
 * common case), this is a no-op replacement.
 *
 * Pure: returns a new `IngestedTrace`; never mutates `trace`. The count of
 * distinct ghost node ids dropped (from `reqsByNode`'s key set — every
 * `hashesAtTrace`/`perReq` node id is also a `reqsByNode` key, since
 * `ingestTrace` only ever populates the former alongside the latter) is
 * never a silent drop: it is surfaced via `diagnostics.offGraph`
 * (`trace status`/`trace report`, mirroring how `ingestTrace` itself
 * overrides `dangling` on top of `normalizeTrace`'s shard-level
 * diagnostics — see `IngestedTrace.diagnostics`'s doc above).
 */
export function filterTraceToGraph(trace: IngestedTrace, graph: ArtifactGraph): IngestedTrace {
  const resolve = (nodeId: string): string | undefined =>
    resolveTraceGraphNodeId(nodeId, graph.nodes);

  let offGraph = 0;
  const reqsByNode = new Map<string, Set<string>>();
  for (const [nodeId, reqIds] of trace.reqsByNode) {
    const resolvedId = resolve(nodeId);
    if (resolvedId === undefined) {
      offGraph++;
      continue;
    }
    // Union rather than overwrite: multiple original ids can degrade to the
    // same resolved id (see doc above).
    let merged = reqsByNode.get(resolvedId);
    if (!merged) {
      merged = new Set();
      reqsByNode.set(resolvedId, merged);
    }
    for (const reqId of reqIds) merged.add(reqId);
  }

  const hashesAtTrace = new Map<string, string>();
  for (const [nodeId, hash] of trace.hashesAtTrace) {
    const resolvedId = resolve(nodeId);
    if (resolvedId === undefined) continue;
    // Collision tie-break: first-write-wins. A collision only happens when
    // two `symbol:` ids from the SAME file both degrade to that file's
    // `file:` id, and `hashesAtTrace` records the FILE's own contentHash at
    // trace-capture time (see `IngestedTrace.hashesAtTrace`'s doc) — so any
    // colliding values are expected to already agree; keeping whichever
    // wrote first avoids the result depending on `Map` iteration order in
    // the (unexpected) case they don't.
    if (!hashesAtTrace.has(resolvedId)) hashesAtTrace.set(resolvedId, hash);
  }

  const perReq = new Map<string, ReqCoverage>();
  for (const [reqId, coverage] of trace.perReq) {
    const symbols = new Set<string>();
    const files = new Set<string>();
    for (const s of coverage.symbols) {
      const resolvedId = resolve(s);
      if (resolvedId === undefined) continue;
      // A `symbol:` id that degraded to its owning `file:` id belongs in
      // `files`, not `symbols` — `symbols` must never carry a `file:` id.
      if (resolvedId.startsWith("symbol:")) symbols.add(resolvedId);
      else files.add(resolvedId);
    }
    for (const f of coverage.files) {
      const resolvedId = resolve(f);
      if (resolvedId !== undefined) files.add(resolvedId);
    }
    perReq.set(reqId, {
      symbols: [...symbols].sort(),
      files: [...files].sort(),
      tests: coverage.tests,
    });
  }

  return {
    ...trace,
    perReq,
    hashesAtTrace,
    reqsByNode,
    diagnostics: { ...trace.diagnostics, offGraph },
  };
}
