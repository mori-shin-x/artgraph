import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { listFilesOrThrow } from "./glob-utils.js";
import {
  rewriteFile,
  rewriteImplTags,
  rewriteTestTags,
  rewriteFrontmatter,
  expandFrontmatterDependsOn,
  specDefinitionId,
  fencedLines,
  extOf,
  escapeRegExp,
  type RewriteChange,
  type RewriteOptions,
} from "./rename.js";
import { renameLockKey, splitLockKey, mergeLockKeys } from "./rename-lock.js";
import type { LockChange } from "./rename-lock.js";
import { readLockWithMeta, assertLockSchemaWritable, warnIfNewerLockSchema } from "./lock.js";
import { scan, reconcile, ReconcileResourceExhaustedError } from "./scan.js";
import { loadConfig } from "./config.js";
import { globCodeFiles } from "./parsers/typescript.js";
import type { BuildWarning } from "./graph/builder.js";
import { assertValidTargetId } from "./rename-validate-id.js";
import { rewriteTraceShards } from "./rename-trace.js";
import type { ArtgraphConfig, LockFile } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RenameOptions {
  dryRun: boolean;
  format: "json" | "text";
  rootDir: string;
  /** issue #243 — overwrite a lock whose `_meta.schemaVersion` is newer than
   * this CLI's `LOCK_SCHEMA_VERSION` (see `assertLockSchemaWritable`). Only
   * consulted for a non-dry-run apply — `--dry-run` never touches the lock
   * file, so it is exempt from the guard. */
  force?: boolean;
}

export type RenameWarning =
  | {
      type: "manual-assignment-needed";
      filePath: string;
      oldId: string;
      newIds: string[];
    }
  // spec 020 T017 (FR-016, Edge Cases "旧スキーマ世代") — a trace shard
  // matched by `trace.artifacts` whose `meta.schemaVersion` this build
  // doesn't understand: left byte-untouched rather than silently skipped.
  | {
      type: "unknown-trace-schema";
      filePath: string;
    }
  // meta-review (PR #293, issue #277 follow-up) — same unreadable-file
  // crash class as builder.ts's #277 fix, but for rename/split/merge: a
  // scanned spec/code/test file that exists (enumerateRewriteFiles already
  // matched it) but cannot be READ (permission errors, EISDIR, …) used to
  // throw uncaught here, crashing the whole rename/split/merge command with
  // no per-file isolation. Fixed fail-safe: warn, skip the file, and keep
  // rewriting every OTHER file exactly like builder.ts's #277 fix skips
  // parsing (but keeps scanning) an unreadable .md.
  | {
      type: "unreadable-file";
      filePath: string;
      message: string;
    };

export interface RenameResult {
  operation: "rename" | "split" | "merge";
  // Structured identifiers so consumers/printers never have to reconstruct
  // them from change text (L1).
  from?: string;
  to?: string;
  sourceIds?: string[];
  intoIds?: string[];
  // How many files were enumerated and scanned for references (issue #212):
  // makes an accidentally-empty scan scope visible in `--dry-run`/JSON output
  // instead of silently reporting success over zero files.
  filesScanned: number;
  changes: RewriteChange[];
  lockChanges: LockChange[];
  warnings: RenameWarning[];
  // issue #265 — `buildGraph()`'s own warnings (pathological-bracket-nesting,
  // class-member-collision, …) from the pre-rewrite scan that resolved
  // `existingIds` below. Kept as a separate field from `warnings` above (a
  // different, rename-specific warning type).
  buildWarnings: BuildWarning[];
  // issue #273-2 ((a)-lite) — `reconcileAfterWrite`'s post-write `scan()`
  // (which runs purely to refresh the lock) can surface a BuildWarning the
  // pre-write scan never had — e.g. a `--merge` scaffold landing in two
  // spec files mints a fresh `duplicate-id`. Deliberately ADDITIVE: a new
  // OPTIONAL field, `buildWarnings` above is untouched. This is
  // non-breaking for a consumer that reads only KNOWN fields (the common
  // case, and the only one `docs/commands.md` documents) — it is NOT a
  // guarantee for every possible consumer: one that validates the JSON
  // payload against a closed/exact schema, or asserts a byte-exact
  // snapshot of the full result object, WILL observe a diff the first time
  // a rename actually produces a new post-write warning (this field simply
  // did not exist before issue #273-2 at all). Contains only warnings NOT
  // already present pre-write (set-diffed via `warningKey`, issue #336
  // F3/F4 — type+id+sorted-files+message, except `system-resource-exhausted`
  // which keys on type alone — against `buildWarnings`) — a warning that
  // existed before the rename and that rename did nothing to cause or fix
  // is not re-reported here. `undefined` (the key is present but unset, and
  // `JSON.stringify` drops it) when no post-write scan ran at all — either
  // `--dry-run` (which never writes or reconciles) or no `.trace.lock` file
  // existed to reconcile against. Deliberately distinct from an empty array
  // (`[]`, meaning the post-write scan ran and found nothing new): callers
  // must not conflate "no post-write scan happened" with "post-write scan
  // found nothing new" — the latter is a real, positive absence-of-warnings
  // signal; the former is simply "no data".
  postWriteWarnings?: BuildWarning[];
  applied: boolean;
}

// Scaffold placeholder appended for newly created requirements. Kept in English
// to match the rest of the CLI output (M6).
const SCAFFOLD_PLACEHOLDER = "(TODO: describe this requirement)";

/**
 * issue #273-1 — every throw AFTER `loadScanContext()` (below) has already
 * captured this rename's pre-write `buildGraph()` warnings (`graphWarnings`
 * — `duplicate-id`, `pathological-bracket-nesting`, …), but a bare `Error`
 * has nowhere to carry them: `commands/rename.ts`'s catch used to keep only
 * `e.message`, so those warnings were silently dropped on EVERY validation
 * failure (`--from`/`--to` identical, invalid target ID, the zero-hit safety
 * valve, a rejected `--force`-less lock-schema-version bump, …) — the exact
 * "complete swallow" the Step 0-pre investigation confirmed. Every
 * validation/safety-valve throw in `executeRename`/`executeSplit`/
 * `executeMerge` below is routed through `runValidation` (also below)
 * instead of a bare `throw new Error(...)`, so it surfaces as this type
 * with `buildWarnings` attached. A throw that fires BEFORE
 * `loadScanContext()` runs (there is none today) is deliberately exempt —
 * it has no `graphWarnings` yet and stays a plain `Error`, matching the
 * pre-#273 behavior for that (currently hypothetical) case.
 */
export class RenameValidationError extends Error {
  readonly buildWarnings: BuildWarning[];

  constructor(message: string, buildWarnings: BuildWarning[]) {
    super(message);
    this.name = "RenameValidationError";
    this.buildWarnings = buildWarnings;
  }
}

/**
 * Run `fn`, converting anything it throws — a direct `throw new Error(...)`
 * inline, or one bubbling up from a helper like `assertRenameableSource` /
 * `assertValidTargetId` / `assertRenameLockWritable` — into a
 * `RenameValidationError` carrying `graphWarnings`. A `RenameValidationError`
 * thrown by a nested `runValidation` call (none today) passes through
 * unwrapped rather than being double-wrapped.
 */
function runValidation(graphWarnings: BuildWarning[], fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof RenameValidationError) throw e;
    throw new RenameValidationError(e instanceof Error ? e.message : String(e), graphWarnings);
  }
}

/**
 * issue #273-2 ((a)-lite) — structural identity key for a `BuildWarning`,
 * used to set-diff the post-write scan's warnings against the pre-write
 * scan's. Two scans build unrelated `BuildWarning` object instances even for
 * what is semantically "the same" warning, so object/reference identity
 * can't be used — `type`+`id`+`files`+`message` together are what the
 * default presenter (`printWarnings`) actually renders, so two warnings that
 * key identically are indistinguishable to a reader regardless of which
 * scan produced them.
 *
 * issue #336 (meta-review F3/F4) — two refinements on top of the original
 * key:
 *
 *   F4 — `w.files` is sorted before stringifying. `BuildWarning.files`'
 *   ORDER is a byproduct of directory-traversal / glob-enumeration order,
 *   which is not guaranteed stable across two independent `scan()` calls
 *   (pre-write vs. post-write) even when the underlying file SET is
 *   identical. An unsorted key would treat that pure ordering wobble as a
 *   different warning, spuriously promoting an unchanged
 *   `duplicate-id`/etc. warning into `postWriteWarnings`.
 *
 *   F3 — `system-resource-exhausted` is keyed on `type` ALONE (id/files/
 *   message ignored). This warning is scan-wide, not about a specific file:
 *   `graph/builder.ts`'s EMFILE/ENFILE guards report whichever file/glob/
 *   tsconfig read happened to be the FIRST one hit by the exhaustion in
 *   THIS particular scan ("Shown once per scan regardless of how many files
 *   were affected" — see the warning's own `message` text at its push
 *   sites), so the `id`/`files` it carries are a property of scan ORDER, not
 *   of the underlying condition. Keying on the full tuple like every other
 *   warning type would treat "the OS is still out of file descriptors" (the
 *   same recurring condition on both the pre-write and post-write scan) as a
 *   brand-new warning on almost every affected rename, purely because the
 *   first-offender id/files happened to differ between the two scans —
 *   drowning the genuinely-new-warnings signal `postWriteWarnings` exists to
 *   surface. This does NOT special-case away system-resource-exhaustion
 *   from `postWriteWarnings` entirely (meta-review recommendation (ii), not
 *   the alternative "exclude the type outright"): a scan pair where the
 *   PRE-write scan has no `system-resource-exhausted` key at all and the
 *   POST-write scan hits one still diffs as new (`diffPostWriteWarnings`'s
 *   `seen` set, built from `preWrite`, has nothing to match against) — only
 *   "recurs across both scans" is suppressed, never "newly appeared".
 *
 * Exported purely for direct unit testing of the F3/F4 keying rules.
 */
export function warningKey(w: BuildWarning): string {
  if (w.type === "system-resource-exhausted") {
    return JSON.stringify([w.type]);
  }
  return JSON.stringify([w.type, w.id, [...w.files].sort(), w.message ?? null]);
}

/**
 * issue #273-2 ((a)-lite) — `postWrite` is `reconcileAfterWrite`'s scan
 * result: `undefined` when no post-write scan ran at all (dry-run, or no
 * lock file to reconcile), an array (possibly empty) otherwise. Returns
 * `undefined` unchanged in the former case (see `RenameResult.postWriteWarnings`'s
 * doc for why that's kept distinct from `[]`); otherwise returns only the
 * `postWrite` warnings whose structural key (`warningKey` above — type+id+
 * sorted-files+message, except `system-resource-exhausted` which keys on
 * `type` alone, issue #336 F3/F4) was NOT already present in `preWrite` — a
 * warning the pre-write scan already had, that this rename did nothing to
 * introduce, is not re-reported as "new".
 *
 * Exported (alongside `warningKey`) purely for direct unit testing of the
 * F3/F4 keying rules — every real caller reaches this only through
 * `execute*` above.
 */
export function diffPostWriteWarnings(
  postWrite: BuildWarning[] | undefined,
  preWrite: BuildWarning[],
): BuildWarning[] | undefined {
  if (postWrite === undefined) return undefined;
  const seen = new Set(preWrite.map(warningKey));
  return postWrite.filter((w) => !seen.has(warningKey(w)));
}

// ── Helpers ──────────────────────────────────────────────────────────

const RELEVANT_EXTENSIONS = new Set([".md", ".ts", ".tsx", ".js", ".jsx"]);

function filterRelevantFiles(files: string[]): string[] {
  return files.filter((f) => RELEVANT_EXTENSIONS.has(extOf(f)));
}

/**
 * Enumerate rewrite-candidate files from the `.artgraph.json` patterns — the
 * exact sources `scan` reads: spec markdown under `specDirs` plus code/test
 * files matching `include`/`testPatterns` (see graph/builder.ts). Deliberately
 * NOT `git ls-files`: rename must rewrite untracked (pre-commit) files exactly
 * like committed ones (issue #212), and must never touch tracked files outside
 * the configured scan scope such as `.claude/` skills or `.specify/` templates
 * (issue #213). Returned paths are root-relative and sorted for deterministic
 * change ordering.
 *
 * PR #339 meta-review (F1) — the markdown half of this enumeration used to
 * call the `glob` package's `globSync` directly; now routed through
 * `../glob-utils.js`'s `listFilesOrThrow` (the SAME throw-on-EMFILE/ENFILE
 * contract `globCodeFiles` below already has), not `listFilesGuarded`
 * (`graph/builder.ts`'s fail-safe, swallow-and-continue variant). This is a
 * deliberate divergence from `buildGraph`'s markdown loop, not an
 * inconsistency: `buildGraph` degrades gracefully because a partial graph is
 * still useful for `check`/`impact` to report against. This function runs
 * BEFORE any file is rewritten — if it silently returned a truncated file
 * list (a whole specDir's worth of files missing because a readdir hit
 * EMFILE), `executeRename`/`executeSplit`/`executeMerge` would rewrite only
 * the files that DID get listed, leaving the rest referencing the OLD id: a
 * partially-applied rename with no warning, and the existing
 * `allChanges.length === 0` safety valve (below) does NOT catch this — it
 * only fires when NO file changed, not when some subset silently didn't.
 * Throwing here aborts the whole rename before any write happens, which
 * `commands/rename.ts`'s catch-all reports as a normal fatal error (not a
 * `RenameValidationError` — this throw happens outside `runValidation`,
 * matching `RenameValidationError`'s own doc: only throws AFTER
 * `loadScanContext()` that go through `runValidation` get wrapped). That
 * generic `{"error": ...}` / `Error: ...` envelope is the same shape
 * `withFatalErrors` produces for every other command's fatal error, so no
 * dedicated formatting branch is needed here.
 */
function enumerateRewriteFiles(rootDir: string, config: ArtgraphConfig): string[] {
  const absPaths = new Set<string>();
  for (const specDirName of config.specDirs) {
    for (const file of listFilesOrThrow(resolve(rootDir, specDirName, "**/*.md"))) {
      absPaths.add(resolve(file));
    }
  }
  for (const file of globCodeFiles(rootDir, [...config.include, ...config.testPatterns])) {
    absPaths.add(resolve(file));
  }
  return filterRelevantFiles([...absPaths].map((f) => relative(rootDir, f))).sort();
}

/**
 * meta-review (PR #293, issue #277 follow-up) — read a scanned file's
 * content, catching the EISDIR/EACCES class of errors that a bare
 * `readFileSync` would otherwise throw uncaught (mirrors builder.ts's
 * #277 fix for the identical failure mode in `buildGraph`'s markdown loop).
 * Pre-fix, a single unreadable spec/code/test file anywhere in the scanned
 * set crashed the whole `rename`/`split`/`merge` command with no per-file
 * isolation. On failure: push an `unreadable-file` RenameWarning and return
 * `undefined` so the caller can skip (not rewrite, not throw) this one file
 * and keep going — matching what already happens for a file `enumerateRewriteFiles`
 * lists but that no longer `existsSync`s.
 */
function tryReadFile(
  absPath: string,
  relPath: string,
  warnings: RenameWarning[],
): string | undefined {
  try {
    return readFileSync(absPath, "utf-8");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    warnings.push({
      type: "unreadable-file",
      filePath: relPath,
      message: `could not read "${relPath}" (${message}); skipped rewrite for this file.`,
    });
    return undefined;
  }
}

/**
 * Reject IDs that can never be a rename/split/merge *source*: `file:`/`symbol:`
 * nodes are derived from paths, not authored references, so the rewriter cannot
 * relocate them (F8).
 */
function assertRenameableSource(id: string): void {
  if (id.startsWith("file:") || id.startsWith("symbol:")) {
    throw new Error(
      `ID "${id}" refers to a ${id.startsWith("file:") ? "file" : "symbol"} node, ` +
        `which is derived from the filesystem and cannot be renamed.`,
    );
  }
}

/**
 * After files are written, rebuild the lock from a fresh scan so contentHashes,
 * cross-references and specFile entries reflect the new on-disk state. Without
 * this, `artgraph check` immediately reports drift for every rewritten node
 * (F1). Only runs when a lock file already existed — returns `undefined` in
 * that case (see `RenameResult.postWriteWarnings`'s doc: distinct from `[]`,
 * "no post-write scan ran" vs. "ran and found nothing new").
 *
 * issue #273-2 ((a)-lite) — this second scan's `warnings` used to be
 * discarded outright (`const { graph } = scan(...)`). Now returned as-is
 * (undiffed); the caller (`applyWrites` → each `execute*`) diffs them
 * against the pre-write `graphWarnings` via `diffPostWriteWarnings`.
 *
 * issue #335 — `reconcile()` now refuses to write the lock (throwing
 * `ReconcileResourceExhaustedError`) when `warnings` carries a
 * `system-resource-exhausted` entry. By the time this function runs, the
 * caller (`applyWrites`) has ALREADY rewritten every source file to disk —
 * letting that throw escape uncaught would abort the whole rename/split/
 * merge command at that point, silently hiding from the caller that its
 * file rewrites succeeded even though the lock did not get updated. Caught
 * here instead: `warnings` already carries the underlying
 * `system-resource-exhausted` BuildWarning `scan()` produced (the exact
 * condition `reconcile()` is rejecting on) — one more entry is appended
 * with rename-specific recovery guidance ("files were rewritten, lock was
 * not") and the combined array is returned exactly like the success path,
 * so it flows through the SAME `postWriteWarnings` channel
 * (`diffPostWriteWarnings` → `RenameResult.postWriteWarnings` →
 * `presenters/rename.ts`'s `printPostWriteWarnings`) unchanged. The
 * pre-existing "lock file doesn't exist → no-op, return undefined" branch
 * above is unaffected (this only guards the write this function itself
 * performs).
 */
function reconcileAfterWrite(
  rootDir: string,
  config: ArtgraphConfig,
  force: boolean,
): BuildWarning[] | undefined {
  const lockFilePath = resolve(rootDir, config.lockFile);
  if (!existsSync(lockFilePath)) return undefined;
  const { graph, warnings } = scan(rootDir, config);
  try {
    reconcile(rootDir, config, graph, warnings, { force });
  } catch (e) {
    if (e instanceof ReconcileResourceExhaustedError) {
      return [
        ...warnings,
        {
          type: "system-resource-exhausted",
          id: "reconcile",
          files: [],
          message:
            "Files were rewritten, but the lock file was NOT updated: reconcile() refused the " +
            "write because this scan hit file-descriptor exhaustion (see the warning above). " +
            "Once your environment has recovered, run `artgraph reconcile`.",
        },
      ];
    }
    throw e;
  }
  return warnings;
}

/**
 * issue #243 — fail BEFORE any spec/code/test file is rewritten when the
 * existing lock's schema is newer than this CLI understands and `force` was
 * not given. Without this early check, `applyWrites` would rewrite every
 * source file first and only discover the version conflict afterwards (in
 * `reconcileAfterWrite`), leaving renamed IDs in source files with no
 * matching lock update — a worse, half-migrated state than refusing upfront.
 * A no-op when no lock file exists yet (nothing to protect).
 */
function assertRenameLockWritable(rootDir: string, config: ArtgraphConfig, force: boolean): void {
  const lockFilePath = resolve(rootDir, config.lockFile);
  if (!existsSync(lockFilePath)) return;
  const { schemaVersion } = readLockWithMeta(rootDir, config.lockFile);
  assertLockSchemaWritable(schemaVersion, config.lockFile, force);
}

interface ScanContext {
  config: ArtgraphConfig;
  existingIds: Set<string>;
  rewriteOpts: RewriteOptions;
  // issue #265 — the pre-rewrite scan's build warnings, threaded into
  // `RenameResult.buildWarnings` by each `execute*` below.
  graphWarnings: BuildWarning[];
}

function loadScanContext(rootDir: string): ScanContext {
  const config = loadConfig(rootDir);
  const { graph, warnings } = scan(rootDir, config);
  return {
    config,
    existingIds: new Set(graph.nodes.keys()),
    rewriteOpts: {
      reqPatterns: config.reqPatterns,
      taskConventions: config.taskConventions,
      disableBuiltinTaskConventions: config.disableBuiltinTaskConventions,
    },
    graphWarnings: warnings,
  };
}

// issue #273-2 ((a)-lite) — returns `reconcileAfterWrite`'s raw (undiffed)
// post-write scan warnings, or `undefined` on `--dry-run` (which never
// writes or reconciles at all — same "no post-write scan ran" case as no
// lock file existing). Each `execute*` below diffs this against its own
// `graphWarnings` via `diffPostWriteWarnings` before putting it on the
// result.
function applyWrites(
  rootDir: string,
  config: ArtgraphConfig,
  filesToWrite: Map<string, string>,
  dryRun: boolean,
  force: boolean,
): BuildWarning[] | undefined {
  if (dryRun) return undefined;
  for (const [absPath, content] of filesToWrite) {
    writeFileSync(absPath, content, "utf-8");
  }
  return reconcileAfterWrite(rootDir, config, force);
}

// ── executeRename ───────────────────────────────────────────────────

export function executeRename(options: RenameOptions & { from: string; to: string }): RenameResult {
  const { rootDir, dryRun, from, to, force = false } = options;
  const { config, existingIds, rewriteOpts, graphWarnings } = loadScanContext(rootDir);
  if (!dryRun) {
    runValidation(graphWarnings, () => assertRenameLockWritable(rootDir, config, force));
  }

  // Validate
  runValidation(graphWarnings, () => {
    if (from === to) {
      throw new Error(`Source and target IDs are identical ("${from}"); nothing to rename.`);
    }
    assertRenameableSource(from);
    assertValidTargetId(
      to,
      config.reqPatterns,
      config.taskConventions,
      config.disableBuiltinTaskConventions,
    );
    if (!existingIds.has(from)) {
      throw new Error(`ID "${from}" does not exist in the project.`);
    }
    if (existingIds.has(to)) {
      throw new Error(`ID "${to}" already exists in the project.`);
    }
  });

  // Rewrite each file
  const allChanges: RewriteChange[] = [];
  const filesToWrite = new Map<string, string>();
  const scannedFiles = enumerateRewriteFiles(rootDir, config);
  const readWarnings: RenameWarning[] = [];

  for (const relPath of scannedFiles) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = tryReadFile(absPath, relPath, readWarnings);
    if (content === undefined) continue;
    const result = rewriteFile(relPath, content, from, to, rewriteOpts);
    if (result.changes.length > 0) {
      allChanges.push(...result.changes);
      filesToWrite.set(absPath, result.content);
    }
  }
  const unreadableCount = readWarnings.length;

  // Safety valve (issue #212): the graph knows `from`, so at least one scanned
  // file must carry a rewritable reference. Zero hits means the enumeration
  // and the scan disagree — report the failure loudly instead of "success".
  if (allChanges.length === 0) {
    runValidation(graphWarnings, () => {
      throw new Error(
        `ID "${from}" was not found in any of the ${scannedFiles.length} files matched by ` +
          `.artgraph.json include/specDirs/testPatterns — nothing was rewritten. ` +
          `Check that the files referencing "${from}" are covered by those patterns.`,
      );
    });
  }

  // Project lock changes (also the source of truth for dry-run reporting).
  const lockChanges = projectLockChanges(rootDir, config, dryRun, (lock) =>
    renameLockKey(lock, from, to),
  );

  // spec 020 T017 (FR-016) — trace shard REQ ID rewrite, separate from the
  // spec/code/test scan above: shards are not enumerated by
  // enumerateRewriteFiles (they aren't specDirs/include/testPatterns
  // material) and must never affect `filesScanned` (F-style contract with
  // existing rename JSON consumers).
  const traceRewrite = rewriteTraceShards(rootDir, config, [[from, to]]);
  for (const [absPath, content] of traceRewrite.filesToWrite) filesToWrite.set(absPath, content);
  allChanges.push(...traceRewrite.changes);
  const warnings: RenameWarning[] = [
    ...readWarnings,
    ...traceRewrite.unknownSchemaShards.map(
      (filePath): RenameWarning => ({
        type: "unknown-trace-schema" as const,
        filePath,
      }),
    ),
  ];

  const postWriteScanWarnings = applyWrites(rootDir, config, filesToWrite, dryRun, force);

  return {
    operation: "rename",
    from,
    to,
    // meta-review (PR #293, issue #277 follow-up) — a file that could not be
    // read is skipped, not scanned, so it is excluded from this count.
    filesScanned: scannedFiles.length - unreadableCount,
    changes: allChanges,
    lockChanges,
    warnings,
    buildWarnings: graphWarnings,
    postWriteWarnings: diffPostWriteWarnings(postWriteScanWarnings, graphWarnings),
    applied: !dryRun,
  };
}

// ── executeSplit ─────────────────────────────────────────────────────

export function executeSplit(
  options: RenameOptions & { splitId: string; intoIds: string[] },
): RenameResult {
  const { rootDir, dryRun, splitId, intoIds, force = false } = options;
  const { config, existingIds, rewriteOpts, graphWarnings } = loadScanContext(rootDir);
  if (!dryRun) {
    runValidation(graphWarnings, () => assertRenameLockWritable(rootDir, config, force));
  }

  // Validate
  runValidation(graphWarnings, () => {
    assertRenameableSource(splitId);
    if (!existingIds.has(splitId)) {
      throw new Error(`ID "${splitId}" does not exist in the project.`);
    }
    if (intoIds.length === 0) {
      throw new Error(`--split requires at least one target ID via --into.`);
    }
    const seen = new Set<string>();
    for (const newId of intoIds) {
      assertValidTargetId(
        newId,
        config.reqPatterns,
        config.taskConventions,
        config.disableBuiltinTaskConventions,
      );
      if (seen.has(newId)) {
        throw new Error(`Duplicate target ID "${newId}" in --into.`);
      }
      seen.add(newId);
      if (newId !== splitId && existingIds.has(newId)) {
        throw new Error(`ID "${newId}" already exists in the project.`);
      }
    }
  });

  const allChanges: RewriteChange[] = [];
  const warnings: RenameWarning[] = [];
  const filesToWrite = new Map<string, string>();
  const scannedFiles = enumerateRewriteFiles(rootDir, config);

  const implRe = /\/\/[^\S\n]*@impl[^\S\n]+/;

  let unreadableCount = 0;
  for (const relPath of scannedFiles) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = tryReadFile(absPath, relPath, warnings);
    if (content === undefined) {
      unreadableCount++;
      continue;
    }
    const ext = extOf(relPath);

    if (ext === ".md") {
      const { content: next, changes } = splitMarkdown(
        relPath,
        content,
        splitId,
        intoIds,
        rewriteOpts,
      );
      if (changes.length > 0) {
        allChanges.push(...changes);
        filesToWrite.set(absPath, next);
      }
    } else {
      // Code files: @impl assignment is ambiguous on split, so warn instead of
      // rewriting (unchanged behaviour).
      const lines = content.split("\n");
      const fenced = fencedLines(content);
      for (let i = 0; i < lines.length; i++) {
        if (fenced.has(i)) continue;
        if (implRe.test(lines[i]) && referencesId(lines[i], splitId)) {
          warnings.push({
            type: "manual-assignment-needed",
            filePath: relPath,
            oldId: splitId,
            newIds: intoIds,
          });
          break;
        }
      }
    }
  }

  // Safety valve (issue #212): if no scanned file carried the split source —
  // neither a spec definition (change) nor a code `@impl` (warning) — the
  // split would only touch the lock and report success. Fail loudly instead.
  if (allChanges.length === 0 && warnings.length === 0) {
    runValidation(graphWarnings, () => {
      throw new Error(
        `ID "${splitId}" was not found in any of the ${scannedFiles.length} files matched by ` +
          `.artgraph.json include/specDirs/testPatterns — nothing was rewritten. ` +
          `Check that the files referencing "${splitId}" are covered by those patterns.`,
      );
    });
  }

  const lockChanges = projectLockChanges(rootDir, config, dryRun, (lock) =>
    splitLockKey(lock, splitId, intoIds),
  );

  const postWriteScanWarnings = applyWrites(rootDir, config, filesToWrite, dryRun, force);

  return {
    operation: "split",
    from: splitId,
    sourceIds: [splitId],
    intoIds,
    // meta-review (PR #293, issue #277 follow-up) — a file that could not be
    // read is skipped, not scanned, so it is excluded from this count.
    filesScanned: scannedFiles.length - unreadableCount,
    changes: allChanges,
    lockChanges,
    warnings,
    buildWarnings: graphWarnings,
    postWriteWarnings: diffPostWriteWarnings(postWriteScanWarnings, graphWarnings),
    applied: !dryRun,
  };
}

// ── executeMerge ─────────────────────────────────────────────────────

export function executeMerge(
  options: RenameOptions & { mergeIds: string[]; intoId: string },
): RenameResult {
  const { rootDir, dryRun, mergeIds, intoId, force = false } = options;
  const { config, existingIds, rewriteOpts, graphWarnings } = loadScanContext(rootDir);
  if (!dryRun) {
    runValidation(graphWarnings, () => assertRenameLockWritable(rootDir, config, force));
  }

  // Validate
  runValidation(graphWarnings, () => {
    if (mergeIds.length < 1) {
      throw new Error(`--merge requires at least one source ID.`);
    }
    assertValidTargetId(
      intoId,
      config.reqPatterns,
      config.taskConventions,
      config.disableBuiltinTaskConventions,
    );
    for (const id of mergeIds) {
      assertRenameableSource(id);
      if (!existingIds.has(id)) {
        throw new Error(`ID "${id}" does not exist in the project.`);
      }
    }
    // intoId must NOT exist UNLESS it equals one of mergeIds.
    if (existingIds.has(intoId) && !mergeIds.includes(intoId)) {
      throw new Error(
        `ID "${intoId}" already exists in the project and is not one of the merge source IDs.`,
      );
    }
  });

  // IDs whose references/definitions collapse into intoId.
  const idsToRewrite = mergeIds.filter((id) => id !== intoId);
  const intoIsExisting = mergeIds.includes(intoId);

  const allChanges: RewriteChange[] = [];
  const filesToWrite = new Map<string, string>();
  const scannedFiles = enumerateRewriteFiles(rootDir, config);
  const readWarnings: RenameWarning[] = [];

  for (const relPath of scannedFiles) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = tryReadFile(absPath, relPath, readWarnings);
    if (content === undefined) continue;
    const ext = extOf(relPath);

    if (ext === ".md") {
      const { content: next, changes } = mergeMarkdown(
        relPath,
        content,
        idsToRewrite,
        intoId,
        intoIsExisting,
        rewriteOpts,
      );
      if (changes.length > 0) {
        allChanges.push(...changes);
        filesToWrite.set(absPath, next);
      }
    } else {
      // Code/test files: collapse @impl and test references onto intoId.
      let next = content;
      const fileChanges: RewriteChange[] = [];
      for (const oldId of idsToRewrite) {
        const implRes = rewriteImplTags(next, oldId, intoId);
        next = implRes.content;
        const testRes = rewriteTestTags(next, oldId, intoId);
        next = testRes.content;
        for (const c of [...implRes.changes, ...testRes.changes]) {
          c.filePath = relPath;
          fileChanges.push(c);
        }
      }
      if (fileChanges.length > 0) {
        allChanges.push(...fileChanges);
        filesToWrite.set(absPath, next);
      }
    }
  }

  // Safety valve (issue #212): when there are IDs to collapse but no scanned
  // file carried any of them, the merge would only touch the lock and report
  // success. Fail loudly instead. (A degenerate `--merge X --into X` has
  // nothing to rewrite by definition and is left to the presenter.)
  if (idsToRewrite.length > 0 && allChanges.length === 0) {
    runValidation(graphWarnings, () => {
      throw new Error(
        `None of the IDs ${idsToRewrite.map((id) => `"${id}"`).join(", ")} were found in any of ` +
          `the ${scannedFiles.length} files matched by .artgraph.json include/specDirs/testPatterns — ` +
          `nothing was rewritten. Check that the files referencing them are covered by those patterns.`,
      );
    });
  }

  const lockChanges = projectLockChanges(rootDir, config, dryRun, (lock) =>
    mergeLockKeys(lock, mergeIds, intoId),
  );

  // spec 020 T017 (FR-016) — collapse the same idsToRewrite -> intoId pairs
  // into trace shard testName/suitePath strings, mirroring the code-side
  // rewriteTestTags chain above exactly (issue-free even for the degenerate
  // `--merge X --into X` case: idsToRewrite is empty there, and
  // rewriteTraceShards short-circuits on an empty pair list).
  const traceRewrite = rewriteTraceShards(
    rootDir,
    config,
    idsToRewrite.map((id): [string, string] => [id, intoId]),
  );
  for (const [absPath, content] of traceRewrite.filesToWrite) filesToWrite.set(absPath, content);
  allChanges.push(...traceRewrite.changes);
  const warnings: RenameWarning[] = [
    ...readWarnings,
    ...traceRewrite.unknownSchemaShards.map(
      (filePath): RenameWarning => ({
        type: "unknown-trace-schema" as const,
        filePath,
      }),
    ),
  ];

  const postWriteScanWarnings = applyWrites(rootDir, config, filesToWrite, dryRun, force);

  return {
    operation: "merge",
    to: intoId,
    sourceIds: mergeIds,
    intoIds: [intoId],
    // meta-review (PR #293, issue #277 follow-up) — a file that could not be
    // read is skipped, not scanned, so it is excluded from this count.
    filesScanned: scannedFiles.length - readWarnings.length,
    changes: allChanges,
    lockChanges,
    warnings,
    buildWarnings: graphWarnings,
    postWriteWarnings: diffPostWriteWarnings(postWriteScanWarnings, graphWarnings),
    applied: !dryRun,
  };
}

// ── Markdown split/merge primitives ──────────────────────────────────

/**
 * Whether `line` references `id` as a standalone token (not as a definition).
 */
function referencesId(line: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_/:-])${escapeRegExp(id)}(?![A-Za-z0-9_/:-])`).test(line);
}

/**
 * Split a markdown spec: remove the definition line(s) for `splitId`, append a
 * scaffold list item per new ID, and expand any frontmatter dependency on the
 * split ID to all new IDs (F5). Fenced code blocks are never touched (F6).
 *
 * Scaffolds are appended ONLY to a file that actually hosted the split
 * source's definition (issue #213) — mirroring mergeMarkdown's
 * `removedAnyDefinition` gate. Without this, every enumerated markdown file
 * received one scaffold per new ID.
 */
function splitMarkdown(
  relPath: string,
  content: string,
  splitId: string,
  intoIds: string[],
  opts: RewriteOptions,
): { content: string; changes: RewriteChange[] } {
  const lines = content.split("\n");
  const fenced = fencedLines(content);
  const changes: RewriteChange[] = [];

  const kept: string[] = [];
  let removedAnyDefinition = false;
  for (let i = 0; i < lines.length; i++) {
    if (!fenced.has(i) && specDefinitionId(lines[i], opts) === splitId) {
      changes.push({
        filePath: relPath,
        line: i + 1,
        kind: "spec-list-item",
        before: lines[i],
        after: "(removed)",
      });
      removedAnyDefinition = true;
      continue;
    }
    kept.push(lines[i]);
  }

  if (removedAnyDefinition) {
    for (const newId of intoIds) {
      const scaffold = `- ${newId}: ${SCAFFOLD_PLACEHOLDER}`;
      kept.push(scaffold);
      changes.push({
        filePath: relPath,
        line: kept.length,
        kind: "spec-list-item",
        before: "",
        after: scaffold,
      });
    }
  }

  // Expand frontmatter dependency references.
  let next = kept.join("\n");
  const fm = expandFrontmatterDependsOn(next, splitId, intoIds);
  if (fm.changes.length > 0) {
    next = fm.content;
    for (const c of fm.changes) {
      c.filePath = relPath;
      changes.push(c);
    }
  }

  return { content: next, changes };
}

/**
 * Merge markdown specs: remove the definition lines for the merged-away IDs,
 * collapse frontmatter dependency references onto intoId, and append a single
 * scaffold for intoId only when it is a brand-new requirement. Crucially the
 * definition lines are removed *instead of* being rewritten, so intoId is never
 * duplicated (C1).
 */
function mergeMarkdown(
  relPath: string,
  content: string,
  idsToRewrite: string[],
  intoId: string,
  intoIsExisting: boolean,
  opts: RewriteOptions,
): { content: string; changes: RewriteChange[] } {
  const lines = content.split("\n");
  const fenced = fencedLines(content);
  const changes: RewriteChange[] = [];
  const removeSet = new Set(idsToRewrite);

  const kept: string[] = [];
  let removedAnyDefinition = false;
  for (let i = 0; i < lines.length; i++) {
    const defId = fenced.has(i) ? null : specDefinitionId(lines[i], opts);
    if (defId != null && removeSet.has(defId)) {
      changes.push({
        filePath: relPath,
        line: i + 1,
        kind: "spec-list-item",
        before: lines[i],
        after: "(removed)",
      });
      removedAnyDefinition = true;
      continue;
    }
    kept.push(lines[i]);
  }

  let next = kept.join("\n");

  // Collapse frontmatter dependency references onto intoId.
  for (const oldId of idsToRewrite) {
    const fm = rewriteFrontmatter(next, oldId, intoId);
    if (fm.changes.length > 0) {
      next = fm.content;
      for (const c of fm.changes) {
        c.filePath = relPath;
        changes.push(c);
      }
    }
  }

  // Append a scaffold for a brand-new intoId, but only in a file that actually
  // hosted one of the merged definitions.
  if (!intoIsExisting && removedAnyDefinition) {
    const scaffold = `- ${intoId}: ${SCAFFOLD_PLACEHOLDER}`;
    const outLines = next.split("\n");
    outLines.push(scaffold);
    changes.push({
      filePath: relPath,
      line: outLines.length,
      kind: "spec-list-item",
      before: "",
      after: scaffold,
    });
    next = outLines.join("\n");
  }

  return { content: next, changes };
}

// ── Lock projection ──────────────────────────────────────────────────

/**
 * Compute the projected lock-key changes for reporting / dry-run. The actual
 * on-disk lock is rebuilt by reconcileAfterWrite, so this only needs the change
 * log, not the resulting lock.
 *
 * F4 (meta-review, issue #243 follow-up): reads via `readLockWithMeta` and
 * warns on a newer-schema lock via `warnIfNewerLockSchema`, but ONLY when
 * `dryRun` is true. `--dry-run` never calls `assertRenameLockWritable` (it's
 * exempt from the write guard), so without this it silently produced a
 * preview from a newer-schema lock while a real apply would warn/reject —
 * the exact asymmetry the meta-review flagged. For a non-dry-run call,
 * `assertRenameLockWritable` (invoked earlier in each `execute*` before this
 * function ever runs) already emitted the equivalent notice — either it
 * threw, or it printed the `--force` downgrade notice — so warning again
 * here would just be a duplicate.
 */
function projectLockChanges(
  rootDir: string,
  config: ArtgraphConfig,
  dryRun: boolean,
  op: (lock: LockFile) => { changes: LockChange[] },
): LockChange[] {
  const lockFilePath = resolve(rootDir, config.lockFile);
  if (!existsSync(lockFilePath)) return [];
  const { lock, schemaVersion } = readLockWithMeta(rootDir, config.lockFile);
  if (dryRun) warnIfNewerLockSchema(schemaVersion, config.lockFile);
  return op(lock).changes;
}
