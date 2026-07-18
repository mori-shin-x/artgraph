import { resolve } from "node:path";
import { buildGraph, type BuildWarning } from "./graph/builder.js";
import {
  writeLock,
  buildLockFromGraph,
  readLockWithMeta,
  assertLockSchemaWritable,
} from "./lock.js";
import type { IngestedTrace } from "./trace/ingest.js";
import type { ArtifactGraph, ArtgraphConfig } from "./types.js";

export interface ScanResult {
  graph: ArtifactGraph;
  warnings: BuildWarning[];
  // issue #351 ("Window B" elimination) — the SAME `IngestedTrace`
  // `buildGraph()` already ingested to build `exercises`/`implements`
  // (coverage) edges, threaded through so `src/commands/check.ts` /
  // `src/commands/impact.ts` / `src/commands/trace.ts` can reuse it instead
  // of each calling `ingestTrace()` a second, independent time (the
  // structural fix for the "Window B" raw-crash class the Step 0-pre
  // investigation found — see `src/graph/builder.ts`'s own doc comment on
  // this field). `undefined` on a trace-absent project (`hasTraceShards`
  // false), mirroring `buildGraph`'s own FR-010 byte-identical-output
  // contract — this key is omitted from a trace-absent scan's result
  // entirely, not merely `undefined`-valued.
  trace?: IngestedTrace;
  nodeCount: number;
  edgeCount: number;
  reqCount: number;
  docCount: number;
  fileCount: number;
  symbolCount: number;
  testCount: number;
  taskCount: number;
}

export function scan(rootDir: string, config: ArtgraphConfig): ScanResult {
  const absRoot = resolve(rootDir);
  const { graph, warnings, trace } = buildGraph(absRoot, config);

  let reqCount = 0;
  let docCount = 0;
  let fileCount = 0;
  let symbolCount = 0;
  let testCount = 0;
  let taskCount = 0;

  for (const node of graph.nodes.values()) {
    switch (node.kind) {
      case "req":
        reqCount++;
        break;
      case "doc":
        docCount++;
        break;
      case "file":
        fileCount++;
        break;
      case "symbol":
        symbolCount++;
        break;
      case "test":
        testCount++;
        break;
      case "task":
        taskCount++;
        break;
    }
  }

  const result: ScanResult = {
    graph,
    warnings,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    reqCount,
    docCount,
    fileCount,
    symbolCount,
    testCount,
    taskCount,
  };
  if (trace) result.trace = trace;
  return result;
}

export interface ReconcileOptions {
  /** issue #243 — overwrite a lock whose `_meta.schemaVersion` is newer than
   * this CLI's `LOCK_SCHEMA_VERSION` (see `assertLockSchemaWritable`). */
  force?: boolean;
}

/**
 * issue #335 — thrown by `reconcile()` when `warnings` (the SAME
 * `BuildWarning[]` the caller's `scan()` call just produced) contains a
 * `system-resource-exhausted` entry: the scan that built `graph` may be
 * missing entire spec/code trees (see `graph/builder.ts`'s EMFILE/ENFILE
 * guard sites), so writing a lock derived from it would silently coarsen or
 * drop real entries — the exact failure mode the Step 0-pre investigation
 * traced back to `buildGraph`'s markdown-glob guard gap. The lock file is
 * left COMPLETELY UNTOUCHED (this check runs before `readLockWithMeta` /
 * `writeLock` do anything) — existing on-disk content, if any, survives
 * unmodified. Deliberately no `--force`-style override (YAGNI): unlike a
 * lock-schema-version mismatch (`assertLockSchemaWritable`,
 * where forcing means "accept a known, bounded loss"), forcing past this
 * would write a lock from a graph whose SHAPE of incompleteness is
 * unknowable in advance — there is nothing principled to force past. Retry
 * after the environment recovers instead.
 */
export class ReconcileResourceExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileResourceExhaustedError";
  }
}

export function reconcile(
  rootDir: string,
  config: ArtgraphConfig,
  graph: ArtifactGraph,
  // issue #335 — required (not optional) so every reconcile() call site
  // must explicitly thread its scan's warnings through: putting the gate
  // INSIDE reconcile() itself (rather than as a convention each caller has
  // to remember) structurally rules out a call site that quietly forgets to
  // guard against writing a lock from an incomplete scan.
  warnings: BuildWarning[],
  opts?: ReconcileOptions,
): void {
  if (warnings.some((w) => w.type === "system-resource-exhausted")) {
    throw new ReconcileResourceExhaustedError(
      "Refusing to write the lock file: this scan hit file-descriptor exhaustion " +
        "(system-resource-exhausted — see the warning above) and the graph it produced may be " +
        "missing entire spec/code trees. The lock file was NOT modified. Once your environment " +
        "has recovered (e.g. raise the OS file-descriptor limit via `ulimit -n`), re-run this " +
        "command.",
    );
  }
  // Pass the previous lock (if any) so structurally-identical entries keep
  // their lastReconciled timestamp. Without this, every `scan` writes new
  // timestamps for every entry and INV-L4 (byte-identical round-trip) is
  // broken in real use even though the test stubs `Date`. Review B1.
  const { lock: prevLock, schemaVersion } = readLockWithMeta(rootDir, config.lockFile);
  // issue #243 — this is THE sole `writeLock` call site in the codebase, so
  // gating here covers every write path (`reconcile` CLI, `rename-executor`'s
  // `reconcileAfterWrite`, `init`'s initial scan) without duplicating the
  // check at each caller.
  assertLockSchemaWritable(schemaVersion, config.lockFile, opts?.force ?? false);
  const lock = buildLockFromGraph(graph, prevLock);
  writeLock(rootDir, config.lockFile, lock);
}
