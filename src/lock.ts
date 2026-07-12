import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import type { LockFile, ArtifactGraph, LockEntry, EdgeProvenance } from "./types.js";
import { unionDeps, sortUniqueProvenances } from "./graph/canonical.js";

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

// issue #243 — lock schema version stamp. Mirrors `parse-cache.ts`'s
// `SCHEMA_VERSION` convention: bump this whenever the on-disk `LockEntry`
// shape gains/changes a field a strictly-older reader would silently
// misinterpret (e.g. spec 021's method-grain symbol entries). Before this
// stamp existed, an OLDER CLI's `reconcile` on a lock a NEWER CLI wrote would
// rebuild the lock from ITS OWN (coarser) model and silently overwrite the
// finer-grained entries — no warning, exit 0 (PR #242 review). `_meta` is a
// reserved top-level key (`{ "_meta": { "schemaVersion": N }, "<nodeId>":
// {...}, ... }`); a lock predating this field has no `_meta` key at all,
// which is treated as schemaVersion 0 (legacy) throughout this module.
export const LOCK_SCHEMA_VERSION = 1;

/**
 * Thrown by the lock-WRITE guard (`assertLockSchemaWritable`) when the
 * on-disk lock's `_meta.schemaVersion` is newer than this build understands
 * and the caller did not pass `force`. Distinct from `LockSchemaError` (shape
 * corruption) — this is a version mismatch, not malformed JSON.
 */
export class LockSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockSchemaVersionError";
  }
}

function validateLockSchema(lock: unknown): asserts lock is Record<string, unknown> {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new LockSchemaError(
      `LockFile must be a JSON object at the top level. Delete .trace.lock and run \`artgraph reconcile\` to regenerate.`,
    );
  }
}

export interface ReadLockResult {
  /** Entry map only — `_meta` is never present as a key here (INV: every
   * existing consumer that iterates a `LockFile` as an entry map — drift
   * checks, rename/merge, plan-coverage — must never see `_meta` as a
   * pseudo-entry). */
  lock: LockFile;
  /** `_meta.schemaVersion` from the on-disk file, or `0` when absent (no
   * lock file at all, or a pre-#243 lock with no `_meta` key). */
  schemaVersion: number;
}

/**
 * Reads the lock file and separates the reserved `_meta` stamp from the
 * entry map. `readLock` (below) is a thin wrapper that discards
 * `schemaVersion` for the many existing call sites that only ever consumed
 * entries; call sites that need to gate on version (write paths via
 * `assertLockSchemaWritable`, read-only paths via `warnIfNewerLockSchema`)
 * use this directly instead.
 */
export function readLockWithMeta(rootDir: string, lockPath: string): ReadLockResult {
  const fullPath = resolve(rootDir, lockPath);
  if (!existsSync(fullPath)) return { lock: {}, schemaVersion: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, "utf-8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Warning: failed to parse ${fullPath}, treating as empty: ${msg}`);
    return { lock: {}, schemaVersion: 0 };
  }
  // Schema validation is a hard fail (LockSchemaError), not a soft warning:
  // a non-object top level would cause cryptic TypeErrors in rename / merge.
  validateLockSchema(parsed);
  const { _meta, ...entries } = parsed as { _meta?: unknown } & Record<string, unknown>;
  let schemaVersion = 0;
  if (_meta !== undefined) {
    const raw =
      _meta && typeof _meta === "object" && !Array.isArray(_meta)
        ? (_meta as { schemaVersion?: unknown }).schemaVersion
        : undefined;
    // F2/F3 (meta-review, issue #243 follow-up): `_meta` is present but its
    // `schemaVersion` cannot be read as a non-negative integer — a string,
    // an array, `null`, a bare `{}` with no `schemaVersion` field, a
    // non-integer (1.5), or a negative number. Previously this fell through
    // to legacy (0) with NO warning, indistinguishable from a genuine
    // pre-#243 lock that never had a `_meta` key at all — silently hiding a
    // corrupted or hand-edited stamp. This is a deliberate fail-open: warn
    // once to stderr, then keep treating the lock as schema v0 (legacy)
    // rather than blocking every read-only command on a malformed stamp.
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
      schemaVersion = raw;
    } else {
      console.error(
        `Warning: ${fullPath} has a malformed _meta.schemaVersion (${JSON.stringify(raw)}); ` +
          `expected a non-negative integer. Treating this lock as schema v0 (legacy).`,
      );
      schemaVersion = 0;
    }
  }
  return { lock: entries as LockFile, schemaVersion };
}

export function readLock(rootDir: string, lockPath: string): LockFile {
  return readLockWithMeta(rootDir, lockPath).lock;
}

/**
 * Write-path guard (issue #243): refuse to rebuild/overwrite a lock whose
 * on-disk `_meta.schemaVersion` is newer than `LOCK_SCHEMA_VERSION`, unless
 * `force` is set. Callers: `scan.ts#reconcile` (the sole `writeLock` call
 * site) and `rename-executor.ts` (fail BEFORE any source file is rewritten,
 * so a rejected rename never leaves spec/code files mutated with no matching
 * lock update). Read-only commands (check/impact/plan-coverage) must NOT
 * call this — they call `warnIfNewerLockSchema` instead and keep running.
 */
export function assertLockSchemaWritable(
  schemaVersion: number,
  lockFile: string,
  force: boolean,
): void {
  if (schemaVersion <= LOCK_SCHEMA_VERSION) return;
  if (force) {
    // F5 (meta-review) — `--force` on init/reconcile/rename means "downgrade
    // the lock and accept the loss", not "silently pretend nothing
    // happened". Without this, the exact PR #242 failure mode (newer
    // fine-grained entries coarsened/overwritten with no trace) reappears
    // for anyone who reaches for `--force` without realizing this guard is
    // what it's overriding.
    console.error(
      `Downgrading lock schema v${schemaVersion} -> v${LOCK_SCHEMA_VERSION} (newer entries may be lost): ${lockFile}`,
    );
    return;
  }
  throw new LockSchemaVersionError(
    `${lockFile} was written by a newer version of artgraph (lock schema v${schemaVersion}; ` +
      `this CLI only understands up to v${LOCK_SCHEMA_VERSION}). Rebuilding it with this CLI ` +
      `would silently discard information the newer CLI wrote (e.g. finer-grained entries). ` +
      `Update artgraph to the version that wrote this lock, or re-run with --force to overwrite ` +
      `it anyway (accepting that loss).`,
  );
}

/**
 * Read-only-path warning (issue #243): a newer-schema lock is still readable
 * (unknown fields are simply invisible to this build), so `check` / `impact`
 * / `plan-coverage` continue rather than fail — but a silent continue would
 * reproduce the exact PR #242 bug for anyone who doesn't also run a write
 * command. Warns once to stderr and returns.
 */
export function warnIfNewerLockSchema(schemaVersion: number, lockFile: string): void {
  if (schemaVersion <= LOCK_SCHEMA_VERSION) return;
  console.error(
    `WARNING: ${lockFile} was written by a newer version of artgraph (lock schema v${schemaVersion}; ` +
      `this CLI only understands up to v${LOCK_SCHEMA_VERSION}). Continuing, but newer-format ` +
      `details may not be reflected below — update artgraph for full fidelity.`,
  );
}

export function writeLock(rootDir: string, lockPath: string, lock: LockFile): void {
  const fullPath = resolve(rootDir, lockPath);
  assertWithinRoot(rootDir, fullPath);
  const tmpPath = resolve(dirname(fullPath), `.${basename(fullPath)}.tmp`);
  // F1 (meta-review, issue #243 follow-up): `_meta` is the reserved top-level
  // stamp key stamped below. If `lock` itself already carries a bare `_meta`
  // entry — from a user-defined `reqPatterns` match, or a markdown
  // frontmatter `artgraph: { node_id: _meta }` doc id accepted with no
  // validation (see `src/parsers/markdown.ts`'s `docId`) — the object spread
  // below would let that entry silently win over the stamp (a later
  // duplicate key wins, and `lock`'s own `_meta` comes after the stamp
  // literal in `{ _meta: stamp, ...lock }`). The file on disk would then have
  // a `_meta` that is actually a `LockEntry`, not `{ schemaVersion }` — the
  // next `readLockWithMeta` strips it out as "meta", making the real entry
  // invisible and mis-reporting schemaVersion 0. Fail loudly instead of
  // silently corrupting the lock; `src/graph/builder.ts` also warns on this
  // exact-match collision at scan time, before it ever reaches a write.
  if (Object.prototype.hasOwnProperty.call(lock, "_meta")) {
    throw new Error(
      `Refusing to write ${fullPath}: the entry map contains a reserved "_meta" key, which ` +
        `would silently overwrite the lock schema stamp on write and make the entry invisible ` +
        `on the next read. This can come from a req/task ID that is literally "_meta" (check a ` +
        `custom reqPatterns match) or a markdown frontmatter "artgraph: { node_id: _meta }". ` +
        `Rename the offending ID and re-run.`,
    );
  }
  // issue #243 — `_meta` is stamped fresh on every write. The reader
  // (`readLockWithMeta`) separates it from the entry map BY NAME (object
  // destructuring), not by key position, so the key order here is cosmetic
  // and never load-bearing: `renameLockKey`/`splitLockKey`/`mergeLockKeys`
  // operate on the entry-only `LockFile` (no `_meta` key ever reaches them,
  // see `readLock` above), and the subsequent `reconcile()` → `writeLock()`
  // re-stamps `_meta` unconditionally regardless of what keys moved.
  const stamped = { _meta: { schemaVersion: LOCK_SCHEMA_VERSION }, ...lock };
  writeFileSync(tmpPath, JSON.stringify(stamped, null, 2) + "\n", "utf-8");
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
  // spec 020 (data-model.md §5, T016) — `exercises` participates in
  // idempotency exactly like `impl`/`tests`: a changed exercises set (new
  // evidence, staleness resolved and re-included, etc.) must NOT be treated
  // as a no-op rebuild, so `lastReconciled` correctly advances.
  if (!stringArrayEqual(a.exercises, b.exercises)) return false;
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

    // spec 020 (data-model.md §5, FR-011, T016) — `exercises` is req -> node
    // (forward only, unlike `impl`/`tests` which are node -> req), so this
    // filters on `e.source === id` rather than `e.target === id`. Same
    // dedupe+sort convention as `impl`/`tests`; omitted entirely (not `[]`)
    // when the req has no exercises edges so a trace-absent project's lock
    // entries stay byte-identical to pre-spec-020 output.
    const exercisesEdges = graph.edges.filter((e) => e.kind === "exercises" && e.source === id);
    if (exercisesEdges.length > 0) {
      entry.exercises = [...new Set(exercisesEdges.map((e) => e.target))].sort();
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
      // but `sortUniqueProvenances` is applied here too so a future graph
      // code-path that forgets to dedup cannot break INV-L2 (provenances
      // sorted+unique).
      //
      // id-based union (review C4): a target reached via BOTH `depends_on`
      // and `derives_from` would otherwise appear twice. `unionDeps`
      // (canonical.ts, which owns the invariant for rename-lock.ts too)
      // merges by id and set-unions provenances so `scan → rename → scan`
      // is shape-stable.
      const raw = depEdges.map((e) => ({
        id: e.target,
        provenances: sortUniqueProvenances(e.provenances),
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
