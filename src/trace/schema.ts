// spec 020 (contracts/trace-artifact.md) — TraceShard JSONL schema SSOT.
// Written by the (future) `artgraph/vitest` runner, read by
// `src/trace/ingest.ts`. Both import ONLY this module for the wire shape
// (plan.md Cat2-(b)) so the schema never drifts between writer and reader.
//
// Deliberately dependency-free: no `vitest` import (CLI must stay
// vitest-agnostic — plan.md Structure Decision) and no other project
// imports, so this module can be pulled in from either side of that
// boundary without dragging anything else along.

/** Current shard schema generation. Bump on any wire-shape change and teach
 * `parseShardLines` to keep reading the prior generation (contract §互換性ポリシー). */
export const SCHEMA_VERSION = 1;

/** A single V8-coverage hit recorded for one test. `file` is repo-root
 * relative (runner-normalized); `fn` is the raw V8 `functionName`, synthetic
 * names (`<instance_members_initializer>`) included as-is — interpreting
 * those is `src/trace/ingest.ts`'s job, not this module's. */
export interface CoverageHit {
  file: string;
  fn: string;
}

/** First line of every shard. Non-deterministic fields (`startedAt` etc.)
 * live here only, never in a `test`/`skipped` record (FR-004). */
export interface ShardMetaRecord {
  schemaVersion: number;
  kind: "meta";
  runToken: string;
  pool: string;
  vitest: string;
  startedAt: string;
}

/** One executed test. `passed: false` records still parse — ingest is the
 * layer that excludes them from evidence (contract §ingest 側の義務 (2)). */
export interface ShardTestRecord {
  kind: "test";
  testName: string;
  suitePath: string[];
  testFile: string;
  passed: boolean;
  hits: CoverageHit[];
  hashes: Record<string, string>;
}

/** A test whose per-test coverage attribution was discarded (e.g.
 * `it.concurrent`, FR-003). Carries no `hits` — there is nothing to attribute. */
export interface ShardSkippedRecord {
  kind: "skipped";
  testName: string;
  testFile: string;
  reason: string;
}

/** Result of parsing exactly one shard file's raw JSONL content. Line order
 * is NOT preserved as meaningful — `normalizeTrace` re-sorts everything, so
 * a shard's internal line order never affects the final result. */
export interface ParsedShard {
  meta: ShardMetaRecord | undefined;
  tests: ShardTestRecord[];
  skipped: ShardSkippedRecord[];
  /** JSON-parse failures (truncated writes) + structurally-invalid records
   * (valid JSON, wrong/missing fields, unknown `kind`) in this shard. Each
   * bad line is skipped individually; the rest of the shard is still parsed
   * (contract: "該当行のみ診断+残りは処理"). */
  corruptedLines: number;
  /** True when this shard's `meta.schemaVersion` is not one this build of
   * ingest understands. The whole shard is excluded from `normalizeTrace`'s
   * output (never used for edge derivation) but is still counted — never
   * silently dropped (contract §レコード種別 meta). */
  unknownSchema: boolean;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one shard file's raw JSONL text. Never throws: a malformed line
 * (truncated JSON from a killed run, or a structurally-invalid-but-parseable
 * record) is counted in `corruptedLines` and skipped; parsing continues with
 * the next line.
 */
export function parseShardLines(content: string): ParsedShard {
  let meta: ShardMetaRecord | undefined;
  const tests: ShardTestRecord[] = [];
  const skipped: ShardSkippedRecord[] = [];
  let corruptedLines = 0;
  let unknownSchema = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue; // trailing/blank line — not a diagnostic

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruptedLines++;
      continue;
    }
    if (!isRecordObject(parsed)) {
      corruptedLines++;
      continue;
    }

    if (parsed.kind === "meta") {
      if (typeof parsed.schemaVersion !== "number") {
        corruptedLines++;
        continue;
      }
      meta = {
        schemaVersion: parsed.schemaVersion,
        kind: "meta",
        runToken: typeof parsed.runToken === "string" ? parsed.runToken : "",
        pool: typeof parsed.pool === "string" ? parsed.pool : "",
        vitest: typeof parsed.vitest === "string" ? parsed.vitest : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      };
      if (parsed.schemaVersion !== SCHEMA_VERSION) unknownSchema = true;
      continue;
    }

    if (parsed.kind === "test") {
      if (
        typeof parsed.testName !== "string" ||
        typeof parsed.testFile !== "string" ||
        typeof parsed.passed !== "boolean" ||
        !Array.isArray(parsed.hits)
      ) {
        corruptedLines++;
        continue;
      }
      const hits: CoverageHit[] = [];
      let hitsValid = true;
      for (const h of parsed.hits) {
        if (!isRecordObject(h) || typeof h.file !== "string" || typeof h.fn !== "string") {
          hitsValid = false;
          break;
        }
        hits.push({ file: h.file, fn: h.fn });
      }
      if (!hitsValid) {
        corruptedLines++;
        continue;
      }
      const hashes: Record<string, string> = {};
      if (isRecordObject(parsed.hashes)) {
        for (const [file, hash] of Object.entries(parsed.hashes)) {
          if (typeof hash === "string") hashes[file] = hash;
        }
      }
      tests.push({
        kind: "test",
        testName: parsed.testName,
        suitePath: Array.isArray(parsed.suitePath)
          ? parsed.suitePath.filter((s): s is string => typeof s === "string")
          : [],
        testFile: parsed.testFile,
        passed: parsed.passed,
        hits,
        hashes,
      });
      continue;
    }

    if (parsed.kind === "skipped") {
      if (
        typeof parsed.testName !== "string" ||
        typeof parsed.testFile !== "string" ||
        typeof parsed.reason !== "string"
      ) {
        corruptedLines++;
        continue;
      }
      skipped.push({
        kind: "skipped",
        testName: parsed.testName,
        testFile: parsed.testFile,
        reason: parsed.reason,
      });
      continue;
    }

    // Unknown/missing `kind` — structurally invalid, not a silent no-op.
    corruptedLines++;
  }

  return { meta, tests, skipped, corruptedLines, unknownSchema };
}

/** A `hits` entry after normalization: dedup'd, lexicographically sorted. */
export type NormalizedHit = CoverageHit;

export interface NormalizedTestRecord {
  testFile: string;
  testName: string;
  suitePath: string[];
  passed: boolean;
  /** Dedup'd + sorted by (file, fn) — repeated V8 call counts collapse to
   * boolean presence (FR-004: "実行回数 → boolean"). */
  hits: NormalizedHit[];
  /** Same object, with keys iterated/rebuilt in sorted order. */
  hashes: Record<string, string>;
}

export interface NormalizedSkippedRecord {
  testFile: string;
  testName: string;
  reason: string;
}

export interface TraceDiagnostics {
  /** Shards excluded outright because their `meta.schemaVersion` is unknown. */
  unknownSchema: number;
  /** JSONL lines (across all shards) that failed to parse or didn't match a
   * known record shape. */
  corrupted: number;
  /** Deduped `skipped`-kind records across all (non-unknownSchema) shards. */
  skipped: number;
  /**
   * Always 0 here. Reserved for `src/trace/ingest.ts` (T009), which is the
   * layer that knows about the current file set and can detect hits
   * pointing at files that no longer exist. Kept as a field on this shared
   * shape (rather than a second diagnostics type) so ingest can spread this
   * object and only ever override `dangling` — one diagnostics shape, one
   * source of truth (data-model.md §2).
   */
  dangling: number;
}

export interface NormalizedTrace {
  tests: NormalizedTestRecord[];
  skipped: NormalizedSkippedRecord[];
  diagnostics: TraceDiagnostics;
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeHits(hits: CoverageHit[]): NormalizedHit[] {
  const seen = new Map<string, NormalizedHit>();
  for (const hit of hits) {
    seen.set(`${hit.file} ${hit.fn}`, hit);
  }
  return [...seen.values()].sort(
    (a, b) => compareStrings(a.file, b.file) || compareStrings(a.fn, b.fn),
  );
}

function normalizeHashes(hashes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of Object.keys(hashes).sort()) {
    out[file] = hashes[file]!;
  }
  return out;
}

// Canonical string form of an already-normalized test record. Every caller
// builds the object literal with the same key order, so two records with
// identical (normalized) content always stringify identically — this is
// the dedup key for "同一レコード重複" (byte-identical duplicate records),
// independent of the order they were read in.
function canonicalTestKey(t: NormalizedTestRecord): string {
  return JSON.stringify({
    testFile: t.testFile,
    testName: t.testName,
    suitePath: t.suitePath,
    passed: t.passed,
    hits: t.hits,
    hashes: t.hashes,
  });
}

function compareTests(a: NormalizedTestRecord, b: NormalizedTestRecord): number {
  return (
    compareStrings(a.testFile, b.testFile) ||
    compareStrings(a.testName, b.testName) ||
    compareStrings(canonicalTestKey(a), canonicalTestKey(b))
  );
}

function compareSkipped(a: NormalizedSkippedRecord, b: NormalizedSkippedRecord): number {
  return (
    compareStrings(a.testFile, b.testFile) ||
    compareStrings(a.testName, b.testName) ||
    compareStrings(a.reason, b.reason)
  );
}

/**
 * Merge already-parsed shards into the deterministic, normalized trace: hit
 * counts collapsed to booleans, entries lexicographically sorted, shards
 * unioned. Independent of shard array order and of each shard's internal
 * line order (FR-004) — callers may pass shards/lines in any order and get
 * a byte-identical result.
 *
 * Unknown-schemaVersion shards contribute to `diagnostics.unknownSchema`
 * (and their `corruptedLines`, if any, still count) but none of their
 * `test`/`skipped` records are used — never a silent skip.
 */
export function normalizeTrace(shards: ParsedShard[]): NormalizedTrace {
  let unknownSchema = 0;
  let corrupted = 0;
  const testsByKey = new Map<string, NormalizedTestRecord>();
  const skippedByKey = new Map<string, NormalizedSkippedRecord>();

  for (const shard of shards) {
    corrupted += shard.corruptedLines;
    if (shard.unknownSchema) {
      unknownSchema++;
      continue;
    }

    for (const test of shard.tests) {
      const normalized: NormalizedTestRecord = {
        testFile: test.testFile,
        testName: test.testName,
        suitePath: [...test.suitePath],
        passed: test.passed,
        hits: normalizeHits(test.hits),
        hashes: normalizeHashes(test.hashes),
      };
      testsByKey.set(canonicalTestKey(normalized), normalized);
    }

    for (const skip of shard.skipped) {
      const normalized: NormalizedSkippedRecord = {
        testFile: skip.testFile,
        testName: skip.testName,
        reason: skip.reason,
      };
      skippedByKey.set(`${skip.testFile} ${skip.testName} ${skip.reason}`, normalized);
    }
  }

  const tests = [...testsByKey.values()].sort(compareTests);
  const skipped = [...skippedByKey.values()].sort(compareSkipped);

  return {
    tests,
    skipped,
    diagnostics: { unknownSchema, corrupted, skipped: skipped.length, dangling: 0 },
  };
}
