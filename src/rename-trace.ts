// spec 020 T017 (FR-016, spec.md Edge Cases "REQ の rename / split / merge")
// — `artgraph rename --from/--to` and `--merge` also rewrite the
// `[REQ-NNN]` tokens inside TraceShard JSONL `testName`/`suitePath` strings
// (contracts/trace-artifact.md §レコード種別 test/skipped), the same way
// `rewriteTestTags` (./rename.js) rewrites them inside `*.test.ts` source.
//
// `--split` deliberately does NOT call into this module: `executeSplit`
// already leaves `[REQ-NNN]` test-title tags in code test files untouched
// (manual-reassignment territory, same policy as `@impl` on split) — shards
// mirror that policy exactly by staying untouched too.
//
// A shard whose `meta.schemaVersion` isn't the generation `src/trace/
// schema.ts`'s `parseShardLines` understands is left byte-untouched and
// reported via `unknownSchemaShards` instead of a silent skip (Edge Cases:
// "書換え不能な形式の trace(旧スキーマ世代)は stale 扱い" — same
// never-silent-skip discipline issue #189 established elsewhere in this
// codebase).

import { readFileSync, existsSync } from "node:fs";
import { relative } from "node:path";
import { listFilesGuarded } from "./glob-utils.js";
import { parseShardLines } from "./trace/schema.js";
import { rewriteTestTags, type RewriteChange } from "./rename.js";
import type { ArtgraphConfig } from "./types.js";

// Mirrors `src/trace/ingest.ts`'s private `DEFAULT_TRACE_ARTIFACTS` constant.
// Kept as an independent literal (not imported) so rename's shard discovery
// doesn't reach into ingest's internals — the shared source of truth is the
// wire-format contract (contracts/trace-artifact.md §ファイル配置), not that
// module's implementation detail.
const DEFAULT_TRACE_ARTIFACTS = [".artgraph/trace/*.jsonl"];

export interface TraceShardRewrite {
  /** Absolute path -> rewritten file content, for shards that actually changed. */
  filesToWrite: Map<string, string>;
  changes: RewriteChange[];
  /** Root-relative paths of shards whose `schemaVersion` this build's parser
   * doesn't understand — left byte-untouched, reported instead of silently
   * skipped. Sorted. */
  unknownSchemaShards: string[];
  /** issue #351 (H1) — set when the shard-discovery glob hit EMFILE/ENFILE
   * for at least one `trace.artifacts` pattern (see `discoverShardPaths`
   * below): some shards may have gone undiscovered, so a rename/split/merge
   * that "found nothing to rewrite" in trace shards this run cannot be
   * trusted to mean "no shard referenced this ID". Propagated by both
   * callers (`executeRename` / `executeMerge` in `rename-executor.ts`) into
   * `RenameResult.warnings` as a `system-resource-exhausted` entry. */
  resourceExhaustedCode?: "EMFILE" | "ENFILE";
}

// issue #351 (Step 0-pre HIGH-1, mirrors `src/trace/ingest.ts`'s identically
// named function and its own #351 doc comment) — this used to call the
// `glob` package's `globSync` directly, whose `globSync` does not throw on
// EMFILE/ENFILE (`path-scurry`'s `#readdirFail` maps an unknown errno to an
// empty child list and returns silently): the `catch { continue }` below
// never even ran, because `globSync` never threw in the first place, so a
// file-descriptor storm during rename's shard discovery used to vanish an
// entire shard set with NO diagnostic at all. Routed through
// `listFilesGuarded` (fast-glob) now: EMFILE/ENFILE is caught internally by
// that helper and surfaced via `resourceExhaustedCode` instead of silently
// returning `[]`. Every OTHER glob failure (a malformed pattern) keeps the
// pre-existing "skip just that one pattern" behavior.
function discoverShardPaths(
  rootDir: string,
  patterns: string[],
): { paths: string[]; resourceExhaustedCode?: "EMFILE" | "ENFILE" } {
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
  return { paths: [...paths].sort(), resourceExhaustedCode };
}

/** Rewrite `[oldId]` -> `[newId]` inside one shard string field, mirroring
 * `rewriteTestTags`'s bracket/`req:` regexes exactly — the same policy
 * source test titles get during rename/merge — by feeding the string through
 * it as if it were one line of file content. */
function rewriteTag(text: string, oldId: string, newId: string): string {
  return rewriteTestTags(text, oldId, newId).content;
}

function rewriteTagChain(text: string, idPairs: ReadonlyArray<[string, string]>): string {
  let next = text;
  for (const [oldId, newId] of idPairs) next = rewriteTag(next, oldId, newId);
  return next;
}

interface LineChange {
  line: number;
  before: string;
  after: string;
}

/**
 * Rewrite one shard's raw JSONL text, replacing REQ IDs per `idPairs` (a
 * single `[from, to]` pair for `--from/--to`, or one pair per collapsed ID
 * for `--merge`, applied in order — mirroring `executeMerge`'s iterative
 * `rewriteTestTags` chain) inside every `test`/`skipped` record's `testName`
 * and (for `test` records) `suitePath` entries.
 *
 * Byte-conservative: a line that doesn't reference any target ID is passed
 * through completely unchanged (never re-serialized). A line that does change
 * is rebuilt via object-spread over the *parsed* record — preserving that
 * record's original key order and every untouched field (`hits`, `hashes`,
 * `passed`, `testFile`, `reason`, …) exactly — with only `testName`/
 * `suitePath` replaced, then re-serialized with `JSON.stringify` (the same
 * compact form `src/vitest/runner.ts` writes).
 */
export function rewriteTraceShardContent(
  content: string,
  idPairs: ReadonlyArray<[string, string]>,
): { content: string; changes: LineChange[] } {
  const changes: LineChange[] = [];
  if (idPairs.length === 0) return { content, changes };

  const rawLines = content.split("\n");

  const outLines = rawLines.map((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (trimmed === "") return rawLine;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return rawLine; // corrupted line — schema.ts's own diagnostics own this, not a rewrite target
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return rawLine;
    const record = parsed as Record<string, unknown>;

    if (record.kind === "test" && typeof record.testName === "string") {
      const nextName = rewriteTagChain(record.testName, idPairs);

      let nextSuitePath: unknown = record.suitePath;
      let suitePathChanged = false;
      if (Array.isArray(record.suitePath)) {
        nextSuitePath = record.suitePath.map((s) => {
          if (typeof s !== "string") return s;
          const next = rewriteTagChain(s, idPairs);
          if (next !== s) suitePathChanged = true;
          return next;
        });
      }

      if (nextName === record.testName && !suitePathChanged) return rawLine;

      const next = { ...record, testName: nextName, suitePath: nextSuitePath };
      const after = JSON.stringify(next);
      changes.push({ line: idx + 1, before: rawLine, after });
      return after;
    }

    if (record.kind === "skipped" && typeof record.testName === "string") {
      const nextName = rewriteTagChain(record.testName, idPairs);
      if (nextName === record.testName) return rawLine;

      const next = { ...record, testName: nextName };
      const after = JSON.stringify(next);
      changes.push({ line: idx + 1, before: rawLine, after });
      return after;
    }

    // `meta` records and anything else never carry REQ tags — passthrough.
    return rawLine;
  });

  return { content: outLines.join("\n"), changes };
}

/**
 * Discover the shards matched by `config.trace.artifacts` (or the runner's
 * default path) and rewrite REQ IDs per `idPairs` inside each. Shards whose
 * `meta.schemaVersion` this build doesn't understand are excluded wholesale
 * (never partially rewritten) and reported in `unknownSchemaShards`.
 *
 * Returns an empty result (no discovery performed at all) when `idPairs` is
 * empty — the degenerate `--merge X --into X` case, and the general
 * trace-absent / no-op path (FR-010-style regression: nothing to rewrite
 * means nothing touched, nothing scanned, nothing warned).
 */
export function rewriteTraceShards(
  rootDir: string,
  config: ArtgraphConfig,
  idPairs: ReadonlyArray<[string, string]>,
): TraceShardRewrite {
  const filesToWrite = new Map<string, string>();
  const changes: RewriteChange[] = [];
  const unknownSchemaShards: string[] = [];

  if (idPairs.length === 0) return { filesToWrite, changes, unknownSchemaShards };

  const patterns = config.trace?.artifacts ?? DEFAULT_TRACE_ARTIFACTS;
  const { paths: shardPaths, resourceExhaustedCode } = discoverShardPaths(rootDir, patterns);

  for (const absPath of shardPaths) {
    if (!existsSync(absPath)) continue;
    const relPath = relative(rootDir, absPath);
    const raw = readFileSync(absPath, "utf-8");

    if (parseShardLines(raw).unknownSchema) {
      unknownSchemaShards.push(relPath);
      continue;
    }

    const result = rewriteTraceShardContent(raw, idPairs);
    if (result.changes.length === 0) continue;

    filesToWrite.set(absPath, result.content);
    for (const c of result.changes) {
      changes.push({
        filePath: relPath,
        line: c.line,
        kind: "trace-shard",
        before: c.before,
        after: c.after,
      });
    }
  }

  unknownSchemaShards.sort();
  return { filesToWrite, changes, unknownSchemaShards, resourceExhaustedCode };
}
