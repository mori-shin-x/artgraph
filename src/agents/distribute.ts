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
//     with the canonical source (catches corrupted filesystems / atomic-rename
//     edge cases).
//   - Symlinks at the destination are NEVER overwritten, even with
//     `force: true` — `copyFileSync` would follow them and clobber whatever
//     they point at, which is a security hazard outside the skills tree.
//     Mirrors the existing `src/init.ts:findConflicts` policy.
//
// Idempotency (FR-009 / SC-004):
//   - When a target already exists and its sha256 matches the canonical, the
//     write is skipped and the path is reported under `noopPaths`.
//   - When a target already exists and its sha256 differs, `force: false`
//     throws `DistributionError` (collecting every drifted path before
//     throwing); `force: true` overwrites.
//
// Rollback (mirrors `src/init.ts:installSkills`):
//   - If any write in the loop fails, every file written so far in this call
//     is unlinked and every directory created in this call is removed
//     (best-effort, in reverse order). This keeps the pre-call filesystem
//     state intact on a mid-run failure so the user does not have to clean
//     up half-written distributions by hand before retrying.
//
// Kiro scope note (FR-008):
//   - `distribute()` for `descriptor.id === "kiro"` writes ONLY into
//     `.kiro/skills/`. The `.kiro/steering/artgraph.md` file is the
//     `KiroProvider` (spec 009) responsibility, reached via
//     `--integrations=kiro`. distribute() must never touch `.kiro/steering/`.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
   * are overwritten. Symlinks at the target are STILL refused even with
   * `force: true` (mirrors `src/init.ts:findConflicts`).
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
 * post-write sha256 mismatches, etc.) so the caller can render an actionable
 * stderr message.
 *
 * `partiallyWritten` lists targets that DID land on disk before this call
 * rolled back. In the normal failure path the rollback unlinks them, so this
 * field is empty; it is populated only when the rollback itself fails (e.g.
 * read-only parent directory), so the caller can surface "manual cleanup
 * required" to the user.
 */
export class DistributionError extends Error {
  readonly conflictPaths: string[];
  readonly partiallyWritten: string[];
  constructor(
    message: string,
    conflictPaths: string[] = [],
    partiallyWritten: string[] = [],
  ) {
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

// @impl 013-cross-agent-extensions/FR-003 013-cross-agent-extensions/FR-004
/**
 * Distribute one agent's Skills tree to its canonical path.
 *
 * Algorithm (deterministic, no statistics / LLM):
 *   1. Build the `DistributionTarget[]` plan via `planDistribution`.
 *   2. Pre-flight: for every target that already exists:
 *        - if `lstat.isSymbolicLink()` → push to symlink-conflicts (refused
 *          even with `--force`).
 *        - else compute on-disk sha256; if it matches `expectedSha256` → mark
 *          as no-op candidate; otherwise push to drift-conflicts.
 *   3. If symlink-conflicts.length > 0 → throw (never overridable).
 *   4. If drift-conflicts.length > 0 AND `force === false` → throw.
 *   5. Otherwise write every "new" or "drifted+force" target:
 *        - ensure parent directory exists (`mkdir -p`, tracked for rollback)
 *        - `copyFileSync(src, dst)` (atomic on POSIX; falls through on
 *          Windows but the rollback path covers partial-copy failures).
 *        - re-read the destination and recompute sha256; if it doesn't match
 *          `expectedSha256`, treat as a hard failure (rollback + throw).
 *   6. On any mid-loop exception, unlink every file written in this call
 *      and rmdir every directory created in this call, in reverse order.
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
  const targets = planDistribution(descriptor, source, opts.rootDir);

  // @impl 013-cross-agent-extensions/FR-009 013-cross-agent-extensions/FR-010
  // Pre-flight classification — every target lands in exactly one bucket:
  //   noopCandidates: existing + sha256 match → skip (idempotent)        (FR-009)
  //   driftConflicts: existing + sha256 mismatch + !force → throw        (FR-009)
  //   driftOverwrite: existing + sha256 mismatch + force  → overwrite    (FR-010)
  //   symlinkConflicts: existing + isSymbolicLink → always throw         (FR-010 — user-managed)
  //   freshWrites:    not existing → write new
  const noopCandidates: DistributionTarget[] = [];
  const driftConflicts: DistributionTarget[] = [];
  const driftOverwrite: DistributionTarget[] = [];
  const symlinkConflicts: DistributionTarget[] = [];
  const freshWrites: DistributionTarget[] = [];

  for (const t of targets) {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(t.dstAbsPath);
    } catch {
      // ENOENT (file does not exist) — pristine write.
      freshWrites.push(t);
      continue;
    }
    if (stat.isSymbolicLink()) {
      symlinkConflicts.push(t);
      continue;
    }
    if (!stat.isFile()) {
      // Directory or special file where a Skill file should live. Treat as
      // a hard conflict (cannot overwrite a directory with a regular file
      // via copyFileSync). Surface like a symlink: refuse even with --force.
      symlinkConflicts.push(t);
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
    const list = symlinkConflicts.map((t) => `${t.srcRelPath} (symlink — refusing to overwrite)`);
    throw new DistributionError(
      `Refusing to overwrite non-regular file(s) in ${descriptor.skillsPath}: ${list.join(", ")}. Remove the entry/entries and rerun.`,
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
  const writtenAbs: string[] = [];
  const dirsCreated: string[] = [];

  const ensureDir = (path: string): void => {
    if (existsSync(path)) return;
    mkdirSync(path, { recursive: true });
    dirsCreated.push(path);
  };

  const writePlan = [...freshWrites, ...driftOverwrite];

  let currentSrc = "";
  try {
    for (const t of writePlan) {
      currentSrc = t.srcRelPath;
      const src = join(source.sourceRoot, t.srcRelPath);
      ensureDir(dirname(t.dstAbsPath));
      copyFileSync(src, t.dstAbsPath);
      writtenAbs.push(t.dstAbsPath);

      // Post-write verification: re-read the destination and recompute
      // sha256. Catches filesystem corruption or atomic-rename mistakes that
      // would otherwise leave a "successfully written" file with the wrong
      // bytes. This is deterministic — purely a hash comparison.
      const actualSha = hashFile(t.dstAbsPath);
      if (actualSha !== t.expectedSha256) {
        throw new Error(
          `post-write sha256 mismatch for ${t.srcRelPath}: expected ${t.expectedSha256}, got ${actualSha}`,
        );
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Roll back: files first, then any directory we created.
    const survivors: string[] = [];
    for (const f of [...writtenAbs].reverse()) {
      try {
        unlinkSync(f);
      } catch {
        // Best-effort: a permission error here means the file persists.
        // Report it under `partiallyWritten` so the caller can surface a
        // "manual cleanup required" hint.
        survivors.push(f);
      }
    }
    for (const d of [...dirsCreated].reverse()) {
      try {
        rmdirSync(d);
      } catch {
        // best-effort: leave non-empty dirs (likely held user content)
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
