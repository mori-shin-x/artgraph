// spec 013 T009 — per-agent Skills distribution (`distribute()`).
//
// Takes a single `AgentDescriptor` + the canonical `SkillSource` (walked from
// `templates/skills/`) and writes every file from the source tree into the
// agent's canonical Skills path (`<rootDir>/<agent.skillsPath>/<srcRelPath>`).
//
// Determinism guarantees (Constitution Principle I):
//   - No LLM / stochastic / heuristic decision is taken; every branch keys off
//     a literal sha256 comparison (R3) or a deterministic filesystem stat.
//   - sha256 hashes are recomputed after each write to verify byte equality
//     with the canonical source (catches read-path corruption and
//     atomic-rename edge cases that would otherwise leave a "successfully
//     written" file with the wrong bytes).
//   - NOTE (OPS-15): the post-write sha256 verifies byte-equality between
//     the on-disk bytes and the canonical source AT THE MOMENT WE HASH
//     THEM. The read may be served from the kernel page cache, so this
//     check does NOT guarantee filesystem copy-on-write ordering, hardware
//     `fsync`, or power-loss durability. Those properties would require
//     `fsync` + directory `fsync`, which we do not attempt; guaranteeing
//     durability is the OS / package-manager's job.
//
// Symlink policy (extended for A4):
//   - Symlinks at the LEAF destination are NEVER overwritten, even with
//     `force: true`. `copyFileSync` would follow them and clobber whatever
//     they point at, which is a security hazard outside the skills tree.
//   - EVERY intermediate directory from `rootDir` down to `dirname(dst)` is
//     also lstat-checked. A symlink anywhere in that ancestor chain is
//     refused (A4): otherwise a malicious symlink at, say,
//     `.claude/skills/artgraph-impact/` planted before init could redirect
//     the write to `../../../etc`. This mirrors the intent of
//     `src/init.ts:findConflicts` and expands it to the full ancestor path.
//
// Idempotency (FR-009 / SC-004):
//   - When a target already exists and its sha256 matches the canonical, the
//     write is skipped and the path is reported under `noopPaths`.
//   - When a target already exists and its sha256 differs, `force: false`
//     throws `DistributionError` (collecting every drifted path before
//     throwing); `force: true` overwrites via the non-destructive path
//     described below.
//
// Non-destructive drift overwrite + rollback (B1 hardening):
//   - Each write goes through a sibling tmp file (`.artgraph-tmp-<sha8>`) and
//     a `renameSync` onto the destination (B4). Direct `copyFileSync(src,
//     dst)` is NOT used: it opens+truncates+streams, so a concurrent doctor
//     (or an ENOSPC mid-copy) could see a partial file at the destination.
//     `renameSync` is a single directory-entry swap that every mainstream
//     filesystem treats as atomic within the same volume.
//   - For drift-overwrite targets we FIRST copy the current bytes to a
//     sibling `.artgraph-backup-<sha8>.tmp` before staging the new tmp.
//     If any subsequent write in the loop fails (post-write sha256
//     mismatch, ENOSPC on a later target, etc.), the rollback restores the
//     backup via `renameSync(backup, target)` — the user's original edit is
//     preserved.
//   - On success the backups are `unlinkSync`-ed at the end of the loop.
//   - Only fresh-write targets are unlinked on rollback (nothing to restore
//     to). If a rollback step itself fails (e.g. Windows AV holding a
//     file open, EACCES), the affected path is reported in
//     `DistributionError.partiallyWritten` so the caller can surface
//     "manual cleanup required" to the user.
//
// Rollback (mirrors `src/init.ts:installSkills`, extended for B5):
//   - Every directory created by this call is tracked individually (B5).
//     `mkdirSync({recursive:true})` creates all missing ancestors in one
//     call but reports only the leaf; walking upward first and mkdir-ing
//     each segment lets rollback remove them all leaf-first without
//     leaving orphaned empty ancestors that doctor's auto-detect would
//     mistake for an "installed" state.
//
// Kiro scope note (FR-008):
//   - `distribute()` for `descriptor.id === "kiro"` writes ONLY into
//     `.kiro/skills/`. The `.kiro/steering/artgraph.md` file is the
//     `KiroProvider` (spec 009) responsibility, reached via the integrate
//     stage / `artgraph integrate kiro`. distribute() must never touch
//     `.kiro/steering/`.

import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentDescriptor } from "./descriptors.js";
import type { SkillSource } from "./source.js";

/**
 * Single (agent, file) pair in the distribution plan — the direct product of
 * `AgentDescriptor` × `SkillSource.entries[].files[]`.
 */
export interface DistributionTarget {
  agent: AgentDescriptor;
  /** POSIX-style path relative to `templates/skills/`. */
  srcRelPath: string;
  /** Absolute path on disk where the file should land. */
  dstAbsPath: string;
  /** Expected sha256 of the file contents (lower-case hex, 64 chars). */
  expectedSha256: string;
}

export interface DistributeOptions {
  /** Repo root — destination paths are resolved against this. */
  rootDir: string;
  /**
   * When true, drifted files (existing but sha256 mismatch) at the target
   * are overwritten. Symlinks at the target — or ANY ancestor directory of
   * the target between `rootDir` and the leaf — are STILL refused even
   * with `force: true` (A4). Non-regular filesystem entries (directories,
   * sockets, etc.) at the leaf are also refused (A-adj-4).
   */
  force?: boolean;
}

export interface DistributeResult {
  /** Every target computed for this call (= `entries[].files[].length`). */
  targets: DistributionTarget[];
  /** Targets that were written (new file or `--force` overwrite). */
  writtenPaths: string[];
  /** Targets already present with matching sha256 — no write performed. */
  noopPaths: string[];
}

/**
 * Thrown when distribution cannot complete cleanly. `conflictPaths` lists the
 * targets that triggered the failure (drifted without `--force`, symlinks,
 * non-regular filesystem entries, post-write sha256 mismatches, etc.) so the
 * caller can render an actionable stderr message.
 *
 * `partiallyWritten` lists targets that DID land on disk before this call
 * rolled back, but whose rollback step itself failed (e.g. `unlinkSync` or
 * `renameSync(backup, dst)` throwing EACCES / EBUSY). In the normal failure
 * path the rollback fully restores the pre-call state and this field is
 * empty; it is populated only when the rollback cannot complete, so the
 * caller can surface "manual cleanup required" to the user.
 */
export class DistributionError extends Error {
  readonly conflictPaths: string[];
  readonly partiallyWritten: string[];
  constructor(message: string, conflictPaths: string[] = [], partiallyWritten: string[] = []) {
    super(message);
    this.name = "DistributionError";
    this.conflictPaths = conflictPaths;
    this.partiallyWritten = partiallyWritten;
  }
}

/**
 * Build the `DistributionTarget[]` plan for a single agent without writing.
 * Exposed for tests / doctor that need the path table without side effects.
 */
export function planDistribution(
  descriptor: AgentDescriptor,
  source: SkillSource,
  rootDir: string,
): DistributionTarget[] {
  const absRoot = resolve(rootDir);
  const targets: DistributionTarget[] = [];
  for (const entry of source.entries) {
    for (const file of entry.files) {
      targets.push({
        agent: descriptor,
        srcRelPath: file.relPath,
        // `agent.skillsPath` is POSIX-style (e.g. `.claude/skills`), so join
        // with the file's POSIX relPath is safe on both POSIX and Windows
        // when funneled through `resolve` here.
        dstAbsPath: resolve(absRoot, descriptor.skillsPath, file.relPath),
        expectedSha256: file.sha256,
      });
    }
  }
  return targets;
}

// @impl 013-cross-agent-extensions/FR-009 013-cross-agent-extensions/FR-010
/**
 * Cross-agent partial-state guard (B2). Runs the same conflict-detection
 * pre-flight `distribute()` uses (symlink ancestors / symlink leaves /
 * non-regular filesystem entries at the leaf / drifted content without
 * `--force`) but performs NO writes.
 *
 * Intended caller: `runInit`, which iterates `preflightDistribution()` over
 * every selected agent BEFORE invoking `distribute()` on any of them. This
 * ensures a mid-loop conflict on agent #3 does not leave agents #1-2 fully
 * written with no config / AGENTS.md to accompany them.
 *
 * Throws `DistributionError` with the same message shape as `distribute()`
 * so downstream error handling (CLI catch block) sees identical output
 * whether the failure surfaces during pre-flight or the actual write phase.
 *
 * Returns void on success. No return value is used to encode bucket
 * classification because a downstream `distribute()` call re-runs the
 * classification anyway (there is no way to safely reuse the pre-flight
 * across a TOCTOU window — a symlink planted between calls must still be
 * caught by `distribute()` itself).
 */
export function preflightDistribution(
  descriptor: AgentDescriptor,
  source: SkillSource,
  opts: DistributeOptions,
): void {
  const force = opts.force === true;
  const absRoot = resolve(opts.rootDir);
  const targets = planDistribution(descriptor, source, opts.rootDir);

  const driftConflicts: DistributionTarget[] = [];
  const symlinkConflicts: Array<{
    target: DistributionTarget;
    symlinkPath: string;
    kind: "leaf" | "ancestor";
  }> = [];
  const nonRegularConflicts: DistributionTarget[] = [];

  for (const t of targets) {
    const symlinkAncestor = findSymlinkAncestor(absRoot, t.dstAbsPath);
    if (symlinkAncestor !== null) {
      symlinkConflicts.push({
        target: t,
        symlinkPath: symlinkAncestor,
        kind: "ancestor",
      });
      continue;
    }

    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(t.dstAbsPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") continue; // will be a fresh write
      throw new DistributionError(
        `Cannot inspect ${t.dstAbsPath} (${err.code ?? "unknown errno"}): ${err.message}`,
      );
    }
    if (stat.isSymbolicLink()) {
      symlinkConflicts.push({
        target: t,
        symlinkPath: t.dstAbsPath,
        kind: "leaf",
      });
      continue;
    }
    if (!stat.isFile()) {
      nonRegularConflicts.push(t);
      continue;
    }
    const onDiskSha = hashFile(t.dstAbsPath);
    if (onDiskSha === t.expectedSha256) continue; // noop
    if (!force) driftConflicts.push(t);
    // force + drift → OK, no throw (distribute() will overwrite)
  }

  if (symlinkConflicts.length > 0) {
    const list = symlinkConflicts.map(({ target, symlinkPath, kind }) =>
      kind === "leaf"
        ? `${target.srcRelPath} (symlink at ${symlinkPath} — refusing to overwrite)`
        : `${target.srcRelPath} (symlink ancestor ${symlinkPath} — refusing to write through)`,
    );
    throw new DistributionError(
      `Refusing to write through symlink(s) in ${descriptor.skillsPath}: ${list.join(", ")}. Remove the entry/entries and rerun.`,
      list,
    );
  }
  if (nonRegularConflicts.length > 0) {
    const list = nonRegularConflicts.map(
      (t) =>
        `${t.srcRelPath} (existing non-regular filesystem entry at ${t.dstAbsPath} — refusing to overwrite)`,
    );
    throw new DistributionError(
      `Refusing to overwrite non-regular filesystem entry/entries in ${descriptor.skillsPath}: ${list.join(", ")}. Remove the entry/entries and rerun.`,
      list,
    );
  }
  if (driftConflicts.length > 0) {
    const list = driftConflicts.map((t) => t.srcRelPath);
    throw new DistributionError(
      `Skill file(s) already exist in ${descriptor.skillsPath} with drifted content: ${list.join(", ")}. Use --force to overwrite.`,
      list,
    );
  }
}

// @impl 013-cross-agent-extensions/FR-003 013-cross-agent-extensions/FR-004
/**
 * Distribute one agent's Skills tree to its canonical path.
 *
 * Algorithm (deterministic, no statistics / LLM):
 *   1. Build the `DistributionTarget[]` plan via `planDistribution`.
 *   2. Pre-flight: for every target:
 *        - Walk each ancestor from `rootDir` down to `dirname(dst)`; if any
 *          ancestor is a symlink (via `lstatSync`) → symlink-conflict (A4).
 *        - `lstatSync(dst)`; only ENOENT counts as "not there" — any other
 *          errno (EACCES / EPERM / ELOOP / ENOTDIR / …) surfaces as a
 *          DistributionError with the raw errno message (B9), so a
 *          permission-denied stat does not cascade into a bewildering
 *          `copyfile EACCES`.
 *        - If leaf is a symlink → symlink-conflict.
 *        - If leaf exists but is not a regular file (directory / socket /
 *          …) → non-regular-conflict (A-adj-4 — distinct from symlink so
 *          the message is not misleading).
 *        - Else regular file: sha256 match → no-op; mismatch + `!force` →
 *          drift-conflict; mismatch + `force` → drift-overwrite bucket.
 *   3. If symlink-conflicts > 0 → throw (never overridable).
 *   4. If non-regular-conflicts > 0 → throw (never overridable).
 *   5. If drift-conflicts > 0 → throw.
 *   6. Otherwise write every fresh-write or drift-overwrite target:
 *        - `ensureDirTracked(dirname(dst), dirsCreated)` — creates every
 *          missing ancestor segment individually so rollback can clean
 *          them up leaf-first (B5).
 *        - For a drift-overwrite target, first `copyFileSync(dst, backup)`
 *          onto a sibling `.artgraph-backup-<sha8>.tmp` so a mid-loop
 *          failure can restore the user's pre-call bytes (B1).
 *        - Stage the new bytes via `copyFileSync(src, tmp)` onto a sibling
 *          `.artgraph-tmp-<sha8>` and then `renameSync(tmp, dst)`. This
 *          replaces `copyFileSync(src, dst)`, which is NOT atomic (B4).
 *        - Re-read the destination and recompute sha256; if it doesn't
 *          match `expectedSha256`, treat as a hard failure (rollback +
 *          throw). See the header note about page-cache limits (OPS-15).
 *   7. On success, `unlinkSync` every backup.
 *   8. On any mid-loop exception, restore drift-overwrite targets from
 *      backup, unlink fresh-write targets, and rmdir every tracked
 *      directory (leaf-first). Any rollback step that itself fails is
 *      reported in `DistributionError.partiallyWritten`.
 *
 * FR-003: per-agent canonical Skills paths come from `descriptor.skillsPath`;
 * the SKILL.md ファイル群と frontmatter は AGENT_DESCRIPTORS 経由で 5 エージェント
 * 共通の `templates/skills/<name>/SKILL.md` から取り出され、バイト一致で配置される。
 * FR-004: `_shared/` 配下も `SkillSource.entries` に含まれるため、SKILL.md と同じ
 * 配布先に同じディレクトリ構造で書き込まれる (各 SKILL.md の `../_shared/...`
 * 相対参照が解決可能になる)。
 */
export function distribute(
  descriptor: AgentDescriptor,
  source: SkillSource,
  opts: DistributeOptions,
): DistributeResult {
  const force = opts.force === true;
  const absRoot = resolve(opts.rootDir);
  const targets = planDistribution(descriptor, source, opts.rootDir);

  // @impl 013-cross-agent-extensions/FR-009 013-cross-agent-extensions/FR-010
  // Pre-flight classification — every target lands in exactly one bucket:
  //   noopCandidates:      existing + sha256 match → skip (idempotent)          (FR-009)
  //   driftConflicts:      existing + sha256 mismatch + !force → throw          (FR-009)
  //   driftOverwrite:      existing + sha256 mismatch + force  → overwrite      (FR-010)
  //   symlinkConflicts:    leaf OR ancestor is a symlink → always throw         (FR-010 — user-managed / A4)
  //   nonRegularConflicts: leaf exists but is not a regular file → always throw (A-adj-4)
  //   freshWrites:         not existing → write new
  const noopCandidates: DistributionTarget[] = [];
  const driftConflicts: DistributionTarget[] = [];
  const driftOverwrite: DistributionTarget[] = [];
  const symlinkConflicts: Array<{
    target: DistributionTarget;
    symlinkPath: string;
    kind: "leaf" | "ancestor";
  }> = [];
  const nonRegularConflicts: DistributionTarget[] = [];
  const freshWrites: DistributionTarget[] = [];

  for (const t of targets) {
    // A4: intermediate-directory symlink detection. Walk every ancestor
    // from `absRoot` down to `dirname(dst)` and reject if any is a
    // symlink — otherwise a planted symlink at `.claude/` could redirect
    // writes out of the repo tree entirely. Non-existent ancestors are
    // fine (they'll be created under `ensureDirTracked` below); non-ENOENT
    // lstat errors surface as DistributionError.
    const symlinkAncestor = findSymlinkAncestor(absRoot, t.dstAbsPath);
    if (symlinkAncestor !== null) {
      symlinkConflicts.push({
        target: t,
        symlinkPath: symlinkAncestor,
        kind: "ancestor",
      });
      continue;
    }

    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(t.dstAbsPath);
    } catch (e) {
      // B9: only ENOENT counts as "absent". EACCES / EPERM / ELOOP /
      // ENOTDIR (etc.) are real errors and must not be silently
      // reinterpreted as "path is available — go write".
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        freshWrites.push(t);
        continue;
      }
      throw new DistributionError(
        `Cannot inspect ${t.dstAbsPath} (${err.code ?? "unknown errno"}): ${err.message}`,
      );
    }
    if (stat.isSymbolicLink()) {
      symlinkConflicts.push({
        target: t,
        symlinkPath: t.dstAbsPath,
        kind: "leaf",
      });
      continue;
    }
    if (!stat.isFile()) {
      // A-adj-4: directory (or socket / block / char device) where a Skill
      // file should live. Treat as a hard conflict distinct from the
      // symlink bucket so the error message does not mislabel the cause.
      nonRegularConflicts.push(t);
      continue;
    }
    const onDiskSha = hashFile(t.dstAbsPath);
    if (onDiskSha === t.expectedSha256) {
      noopCandidates.push(t);
    } else if (force) {
      driftOverwrite.push(t);
    } else {
      driftConflicts.push(t);
    }
  }

  if (symlinkConflicts.length > 0) {
    const list = symlinkConflicts.map(({ target, symlinkPath, kind }) =>
      kind === "leaf"
        ? `${target.srcRelPath} (symlink at ${symlinkPath} — refusing to overwrite)`
        : `${target.srcRelPath} (symlink ancestor ${symlinkPath} — refusing to write through)`,
    );
    throw new DistributionError(
      `Refusing to write through symlink(s) in ${descriptor.skillsPath}: ${list.join(", ")}. Remove the entry/entries and rerun.`,
      list,
    );
  }
  if (nonRegularConflicts.length > 0) {
    const list = nonRegularConflicts.map(
      (t) =>
        `${t.srcRelPath} (existing non-regular filesystem entry at ${t.dstAbsPath} — refusing to overwrite)`,
    );
    throw new DistributionError(
      `Refusing to overwrite non-regular filesystem entry/entries in ${descriptor.skillsPath}: ${list.join(", ")}. Remove the entry/entries and rerun.`,
      list,
    );
  }
  if (driftConflicts.length > 0) {
    const list = driftConflicts.map((t) => t.srcRelPath);
    throw new DistributionError(
      `Skill file(s) already exist in ${descriptor.skillsPath} with drifted content: ${list.join(", ")}. Use --force to overwrite.`,
      list,
    );
  }

  // Now perform the writes. Track everything we touch so we can roll back
  // on a mid-loop failure (filesystem error, post-write sha256 mismatch).
  const dirsCreated: string[] = [];
  // freshWrite targets that were successfully renamed onto — unlink on rollback.
  const writtenFresh: string[] = [];
  // drift-overwrite targets → their `.artgraph-backup-<sha8>.tmp` sibling.
  // Rollback restores by `renameSync(backup, target)`; success unlinks the
  // backup.
  const writtenDrift = new Map<string, string>();

  // In-flight state for the failing iteration: cleaned in the catch handler.
  let currentTmp: string | null = null;
  let currentBackup: string | null = null;
  let currentSrc = "";

  const driftOverwriteSet = new Set(driftOverwrite);
  const writePlan: DistributionTarget[] = [...freshWrites, ...driftOverwrite];

  try {
    for (const t of writePlan) {
      currentSrc = t.srcRelPath;
      const src = join(source.sourceRoot, t.srcRelPath);
      const dstDir = dirname(t.dstAbsPath);
      const isDrift = driftOverwriteSet.has(t);

      // B5: create each missing ancestor segment individually so every
      // intermediate dir lands in `dirsCreated` — rollback can then rmdir
      // the full chain leaf-first.
      ensureDirTracked(dstDir, dirsCreated);

      // B1: for drift-overwrite, snapshot the current bytes BEFORE any
      // write so we can restore the user's pre-call file if a later
      // iteration fails.
      if (isDrift) {
        currentBackup = `${t.dstAbsPath}.artgraph-backup-${sha8()}.tmp`;
        copyFileSync(t.dstAbsPath, currentBackup);
      }

      // B4: tmp+rename instead of direct copyFileSync. `copyFileSync(src,
      // dst)` opens+truncates+streams — a concurrent doctor could observe
      // a partial file at the destination. `renameSync(tmp, dst)` is a
      // single directory-entry swap.
      currentTmp = `${t.dstAbsPath}.artgraph-tmp-${sha8()}`;
      copyFileSync(src, currentTmp);
      renameSync(currentTmp, t.dstAbsPath);
      currentTmp = null; // consumed by rename

      if (isDrift) {
        // currentBackup was set two branches above when isDrift is true.
        writtenDrift.set(t.dstAbsPath, currentBackup as string);
      } else {
        writtenFresh.push(t.dstAbsPath);
      }
      currentBackup = null; // ownership transferred to writtenDrift (or n/a)

      // Post-write verification: re-read the destination and recompute
      // sha256. Catches read-path bugs or atomic-rename mistakes that
      // would otherwise leave a "successfully written" file with the
      // wrong bytes. Purely deterministic — a hash comparison. See the
      // header note about page-cache vs. hardware flush (OPS-15).
      const actualSha = hashFile(t.dstAbsPath);
      if (actualSha !== t.expectedSha256) {
        throw new Error(
          `post-write sha256 mismatch for ${t.srcRelPath}: expected ${t.expectedSha256}, got ${actualSha}`,
        );
      }
    }

    // Every write succeeded — retire the backups. Best-effort: a leaked
    // backup would only be visible until the next `artgraph init`, so we
    // do not error out on unlink failures here.
    for (const backup of writtenDrift.values()) {
      try {
        unlinkSync(backup);
      } catch {
        // best-effort
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    // Clean up any in-flight tmp/backup that belongs to the failing
    // iteration. Best-effort: unlinkSync throws ENOENT if the file never
    // materialised, which is the common case for early failures.
    if (currentTmp !== null) {
      try {
        unlinkSync(currentTmp);
      } catch {
        /* best-effort */
      }
    }
    if (currentBackup !== null) {
      // The backup for the failing iteration hasn't been committed to
      // writtenDrift yet — the target still holds its original bytes, so
      // simply drop the backup without a restore.
      try {
        unlinkSync(currentBackup);
      } catch {
        /* best-effort */
      }
    }

    const survivors: string[] = [];

    // B1: restore each drift-overwrite target from its backup. A failed
    // restore is a genuine "manual cleanup required" case — we report the
    // target so the user knows which paths still hold canonical (not
    // original) bytes; we also try to unlink the orphan backup so the
    // tmp artefact does not linger under the user's Skills tree.
    for (const [target, backup] of writtenDrift) {
      try {
        renameSync(backup, target);
      } catch {
        survivors.push(target);
        try {
          unlinkSync(backup);
        } catch {
          /* stranded — reported via survivors above */
        }
      }
    }

    // B1: fresh writes did not exist before this call, so rollback is a
    // straight unlink. Reverse order matches the direction we created
    // them in, mirroring the tracked-dir cleanup below.
    for (const f of [...writtenFresh].reverse()) {
      try {
        unlinkSync(f);
      } catch {
        survivors.push(f);
      }
    }

    // B5: every intermediate dir we created lands here, so rmdir'ing
    // leaf-first drains the whole chain
    // (`.claude/skills/artgraph-impact` → `.claude/skills` → `.claude`)
    // instead of leaving orphan empty ancestors that would fool doctor's
    // auto-detect.
    for (const d of [...dirsCreated].reverse()) {
      try {
        rmdirSync(d);
      } catch {
        // best-effort: a non-empty dir (likely holding user content) is
        // legitimately left in place.
      }
    }
    throw new DistributionError(
      `Failed to write ${currentSrc} into ${descriptor.skillsPath}: ${msg}`,
      [currentSrc],
      survivors,
    );
  }

  return {
    targets,
    writtenPaths: writePlan.map((t) => t.dstAbsPath),
    noopPaths: noopCandidates.map((t) => t.dstAbsPath),
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function hashFile(abs: string): string {
  const buf = readFileSync(abs);
  return createHash("sha256").update(buf).digest("hex");
}

/** 8 hex chars — collision-safe suffix for tmp/backup sibling files. */
function sha8(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Walk from `dirname(dst)` up to (and including) `absRoot` and return the
 * first ancestor that is a symlink, or `null` if the chain is clean (or
 * every ancestor is ENOENT, which is fine — `ensureDirTracked` will create
 * them). Non-ENOENT lstat errors are surfaced as DistributionError so we
 * do not quietly write through a permission-denied ancestor.
 *
 * Returned path is the ancestor itself (not the target) so the error
 * message can pinpoint the offending link, which is essential for A4's
 * "refuse to write through" contract.
 */
function findSymlinkAncestor(absRoot: string, dstAbsPath: string): string | null {
  const leafDir = dirname(dstAbsPath);
  const ancestors: string[] = [];
  let current = leafDir;
  while (true) {
    ancestors.push(current);
    if (current === absRoot) break;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root reached (defensive)
    current = parent;
  }
  // Iterate root-first so the reported offender is the topmost symlink
  // (most informative for the operator).
  for (const ancestor of ancestors.reverse()) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(ancestor);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") continue;
      throw new DistributionError(
        `Cannot inspect ancestor directory ${ancestor} (${err.code ?? "unknown errno"}): ${err.message}`,
      );
    }
    if (stat.isSymbolicLink()) return ancestor;
  }
  return null;
}

/**
 * Ensure `target` (a directory path) exists, tracking each newly-created
 * segment in `tracked` in creation order (root-first). Callers that need
 * leaf-first rollback should iterate `tracked.slice().reverse()`.
 *
 * This replaces `mkdirSync(target, {recursive: true})`, which creates every
 * missing ancestor in one syscall but reports only the leaf — insufficient
 * for rollback (B5). We walk upward first to find the deepest existing
 * ancestor, then `mkdirSync` each missing segment in order.
 */
function ensureDirTracked(target: string, tracked: string[]): void {
  const ancestors: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break; // filesystem root — never happens for our targets
    current = parent;
  }
  // Ancestors were pushed leaf-first; reverse to create root-first so
  // each mkdirSync (non-recursive) sees an existing parent.
  for (const dir of ancestors.reverse()) {
    mkdirSync(dir);
    tracked.push(dir);
  }
}
