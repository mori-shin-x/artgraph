// spec 013 T004 — read the canonical Skills source tree under
// `templates/skills/` and produce a `SkillSource` (per data-model.md §2).
//
// Semantics:
//   - The function walks every top-level entry under `templatesDir`.
//   - `_shared/` is included as a `SkillEntry` with `isShared: true` (R1 in
//     research.md: SKILL.md files reference `../_shared/...` relatively, so
//     `_shared/` must travel with them).
//   - Every other top-level entry MUST contain a `SKILL.md` file, otherwise
//     the function throws `SkillsInstallError` (a packaging fault).
//   - Hidden files / directories (leading dot) are skipped recursively so
//     stray `.DS_Store` etc. never end up in the distribution.
//   - For each file we compute a sha256 hash up front so callers (distribute,
//     doctor) can verify byte-equality without re-reading the source.
//
// This function performs no writes and is safe to call concurrently. It is
// intentionally separate from `src/init.ts:readSkillTemplates` because the
// new shape (sha256-per-file, per-entry isShared flag) is consumed by
// US1 / US4, while the legacy reader is still used by the single-Claude
// install path until that path is removed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SkillsInstallError } from "../init.js";

export interface SkillFile {
  /** POSIX-style path relative to `templatesDir`. */
  relPath: string;
  /** Lower-case sha256 hex digest of the file contents. 64 chars. */
  sha256: string;
  /** Raw byte size (sanity check for doctor / extraneous-file detection). */
  byteSize: number;
}

export interface SkillEntry {
  /** Top-level directory name under `templatesDir`. Example: `artgraph-impact`. */
  topLevel: string;
  /** True iff `topLevel === "_shared"`. */
  isShared: boolean;
  /** Every regular file under this entry, recursive walk, sha256-stamped. */
  files: SkillFile[];
}

export interface SkillSource {
  /** Absolute path to the canonical source tree (`templates/skills/`). */
  sourceRoot: string;
  /** All top-level entries in stable (alpha) order. */
  entries: SkillEntry[];
}

/**
 * Walk `templatesDir` recursively, compute sha256 for every regular file, and
 * return a `SkillSource`. Throws `SkillsInstallError` when the directory is
 * missing or a non-`_shared/` entry lacks `SKILL.md` (packaging contract from
 * spec 012 inherited verbatim — Skill recognition by every Tier 1 agent
 * requires `<name>/SKILL.md`).
 */
export function readSkillSource(templatesDir: string): SkillSource {
  if (!existsSync(templatesDir)) {
    throw new SkillsInstallError(
      `Skills template directory not found at ${templatesDir}. This is likely a packaging issue.`,
    );
  }

  // Top-level entries: directories only, no hidden ones. Sorted so the
  // returned `entries` array is deterministic across filesystems.
  const topLevels = readdirSync(templatesDir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => statSync(join(templatesDir, name)).isDirectory())
    .sort();

  if (topLevels.length === 0) {
    throw new SkillsInstallError(
      `No skill template directories found in ${templatesDir}. Expected templates/skills/<name>/SKILL.md or templates/skills/_shared/. This is likely a packaging issue.`,
    );
  }

  const entries: SkillEntry[] = [];
  for (const topLevel of topLevels) {
    const isShared = topLevel === "_shared";
    const files = collectFiles(templatesDir, join(templatesDir, topLevel));

    if (!isShared) {
      const expected = `${topLevel}/SKILL.md`;
      const hasSkillMd = files.some((f) => f.relPath === expected);
      if (!hasSkillMd) {
        throw new SkillsInstallError(
          `Skill directory ${topLevel}/ is missing SKILL.md. This is likely a packaging issue.`,
        );
      }
    }

    entries.push({ topLevel, isShared, files });
  }

  return { sourceRoot: templatesDir, entries };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function collectFiles(root: string, current: string): SkillFile[] {
  const out: SkillFile[] = [];
  walk(root, current, out);
  // Deterministic order — sha256 stability test in T007 depends on this.
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

function walk(root: string, current: string, out: SkillFile[]): void {
  for (const entry of readdirSync(current)) {
    // Hidden files (`.DS_Store`, `.git`, editor swap files) never travel
    // with the distribution. Symlinks are inspected via `statSync` which
    // follows them, but the install layer (`installSkills`) refuses to
    // overwrite symlink targets defensively.
    if (entry.startsWith(".")) continue;
    const full = join(current, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    const buf = readFileSync(full);
    out.push({
      relPath: toPosix(relative(root, full)),
      sha256: createHash("sha256").update(buf).digest("hex"),
      byteSize: buf.byteLength,
    });
  }
}

function toPosix(p: string): string {
  return p.split(/\\|\//).join("/");
}
