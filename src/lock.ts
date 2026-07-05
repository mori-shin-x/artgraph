import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import type { LockFile, ArtifactGraph, LockEntry, EdgeProvenance } from "./types.js";
import { unionDeps } from "./rename-lock.js";

// Defence-in-depth against symlinked directory components escaping the project
// root. `loadConfig` validates the lockFile path with string-only resolve/relative,
// which a symlinked parent directory can bypass. Here, just before writing, we
// realpath the (already existing) parent directory and verify it still resolves
// within the project root.
function assertWithinRoot(rootDir: string, fullPath: string): void {
  const realRoot = realpathSync(rootDir);
  const realDir = realpathSync(dirname(fullPath));
  const rel = relative(realRoot, realDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing to write lock file outside project root: ${fullPath} resolves to ${realDir}`,
    );
  }
}

/**
 * Thrown by `readLock` when the on-disk lock file is not a JSON object at the
 * top level (e.g. a corrupted or hand-edited file). Surfacing a clear,
 * actionable error keeps downstream code (`renameLockKey`, `mergeLockKeys`,
 * drift checks) free of defensive shape-guards.
 */
export class LockSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockSchemaError";
  }
}

function validateLockSchema(lock: unknown): asserts lock is LockFile {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new LockSchemaError(
      `LockFile must be a JSON object at the top level. Delete .trace.lock and run \`artgraph reconcile\` to regenerate.`,
    );
  }
}

export function readLock(rootDir: string, lockPath: string): LockFile {
  const fullPath = resolve(rootDir, lockPath);
  if (!existsSync(fullPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, "utf-8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Warning: failed to parse ${fullPath}, treating as empty: ${msg}`);
    return {};
  }
  // Schema validation is a hard fail (LockSchemaError), not a soft warning:
  // a non-object top level would cause cryptic TypeErrors in rename / merge.
  validateLockSchema(parsed);
  return parsed;
}

export function writeLock(rootDir: string, lockPath: string, lock: LockFile): void {
  const fullPath = resolve(rootDir, lockPath);
  assertWithinRoot(rootDir, fullPath);
  const tmpPath = resolve(dirname(fullPath), `.${basename(fullPath)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, fullPath);
}

// Structural equality of two lock entries excluding lastReconciled. Used by
// buildLockFromGraph to decide whether to preserve a previous entry's
// lastReconciled (idempotent rebuild) or stamp a new timestamp.
//
// IMPORTANT: lastReconciled itself is intentionally NOT compared — including it
// would make idempotency vacuous (no two rebuilds would ever match unless the
// caller froze Date). The fields below are all serialised by writeLock, so
// comparing them is equivalent to "byte-identical entry JSON modulo timestamp".
function entriesStructurallyEqual(a: LockEntry, b: LockEntry): boolean {
  if (a.contentHash !== b.contentHash) return false;
  if ((a.specFile ?? "") !== (b.specFile ?? "")) return false;
  if (!stringArrayEqual(a.impl, b.impl)) return false;
  if (!stringArrayEqual(a.tests, b.tests)) return false;
  if (!depsEqual(a.dependsOn, b.dependsOn)) return false;
  return true;
}

function stringArrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function depsEqual(
  a: Array<{ id: string; provenances: EdgeProvenance[] }> | undefined,
  b: Array<{ id: string; provenances: EdgeProvenance[] }> | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    const pa = a[i].provenances;
    const pb = b[i].provenances;
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) if (pa[j] !== pb[j]) return false;
  }
  return true;
}

/**
 * Build a `LockFile` from the freshly scanned graph.
 *
 * Idempotency (INV-L4, review B1): when `prevLock` is supplied and the newly
 * built entry is **structurally identical** to the previous entry (same
 * contentHash, specFile, impl, tests, dependsOn — but **excluding**
 * lastReconciled), the previous `lastReconciled` is preserved verbatim. This
 * makes `scan` → `writeLock` → `scan` → `writeLock` byte-stable. When
 * `prevLock` is omitted (legacy callers / fresh-init), every entry gets a fresh
 * `now` timestamp, matching the pre-fix behaviour.
 */
export function buildLockFromGraph(graph: ArtifactGraph, prevLock?: LockFile): LockFile {
  const lock: LockFile = {};
  const now = new Date().toISOString();

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req" && node.kind !== "doc" && node.kind !== "symbol") continue;

    if (node.kind === "symbol") {
      const candidate: LockEntry = { contentHash: node.contentHash, lastReconciled: now };
      const prev = prevLock?.[id];
      if (prev && entriesStructurallyEqual(candidate, prev)) {
        candidate.lastReconciled = prev.lastReconciled;
      }
      lock[id] = candidate;
      continue;
    }

    const entry: LockEntry = {
      contentHash: node.contentHash,
      lastReconciled: now,
    };

    if (node.filePath) entry.specFile = node.filePath;

    // Lock baselines only track code-claim relations: `entry.impl` is meant for
    // implementation file/symbol sources and `entry.tests` for test sources.
    // `task → implements/verifies` is a planning artefact (data-model.md §7 / U2)
    // — including task IDs here would pollute drift checks and reconcile output.
    const isTaskSource = (source: string) => graph.nodes.get(source)?.kind === "task";

    const implEdges = graph.edges.filter(
      (e) => e.kind === "implements" && e.target === id && !isTaskSource(e.source),
    );
    if (implEdges.length > 0) {
      // Sort + uniq (review B2): graph.edges order is not stable across runs
      // (depends on file-walk ordering), so without sort impl/tests would
      // ping-pong across rebuilds and break INV-L4 byte-identical round-trip.
      entry.impl = [...new Set(implEdges.map((e) => e.source))].sort();
    }

    const testEdges = graph.edges.filter(
      (e) => e.kind === "verifies" && e.target === id && !isTaskSource(e.source),
    );
    if (testEdges.length > 0) {
      entry.tests = [...new Set(testEdges.map((e) => e.source))].sort();
    }

    // Schema v2 (issue #35): `dependsOn` is `Array<{id, provenances}>` and
    // includes annotation-derived edges as well. The output is sorted by `id`
    // ascending and each `provenances` array is sorted ascending so identical
    // graph inputs produce byte-identical lock outputs (INV-L1, INV-L2,
    // INV-L4). See specs/011-edge-provenance/contracts/lock-schema-v2.md.
    //
    // INV-L5 hardening (review D3): orphan edges (target not in graph.nodes)
    // are emitted as `orphan-edge` warnings by builder.ts and must NOT appear
    // in the lock. A lock id must always reference an existing node — without
    // this filter, rename/drift would carry the dangling target around.
    const depEdges = graph.edges.filter(
      (e) =>
        (e.kind === "depends_on" || e.kind === "derives_from") &&
        e.source === id &&
        graph.nodes.has(e.target),
    );
    if (depEdges.length > 0) {
      // Defence-in-depth (review C3): builder.ts already dedups provenances,
      // but emit `[...new Set(...)]` here so a future graph code-path that
      // forgets to dedup cannot break INV-L2 (provenances sorted+unique).
      //
      // id-based union (review C4): a target reached via BOTH `depends_on`
      // and `derives_from` would otherwise appear twice. `unionDeps` merges
      // by id and set-unions provenances, matching the rename-lock collapse
      // so `scan → rename → scan` is shape-stable.
      const raw = depEdges.map((e) => ({
        id: e.target,
        provenances: [...new Set(e.provenances)].sort() as EdgeProvenance[],
      }));
      entry.dependsOn = unionDeps(raw);
    }

    // Preserve lastReconciled when nothing structural changed (review B1).
    const prev = prevLock?.[id];
    if (prev && entriesStructurallyEqual(entry, prev)) {
      entry.lastReconciled = prev.lastReconciled;
    }

    lock[id] = entry;
  }

  return lock;
}
