// spec 013 T011 — unit tests for `distribute()` (parametric over all 5
// Tier 1 agents). Uses the real `templates/skills/` tree so the test
// guarantees the production source ships correctly to every canonical path.
//
// Coverage matrix (FR-003 / FR-004 / FR-009 / FR-010 / R1 / R3):
//   - per-agent path landing (5 entries in AGENT_DESCRIPTORS)
//   - post-copy sha256 byte-equality with canonical
//   - sub-tree structure preserved (snapshot equality with readSkillSource)
//   - idempotent re-run (writtenPaths empty, noopPaths covers everything)
//   - drift detection without --force throws DistributionError
//   - --force overwrites drifted file successfully
//   - conflict messages list every drifted path
//   - `_shared/` (3 files) lands under every agent's skills path (R1)
//   - symlinks at the destination refused even with --force

import { describe, it, expect, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_DESCRIPTORS,
  type AgentDescriptor,
} from "../../src/agents/descriptors.js";
import { readSkillSource } from "../../src/agents/source.js";
import {
  DistributionError,
  distribute,
  planDistribution,
} from "../../src/agents/distribute.js";
import { createFreshProject, readDistributedTree } from "./helpers.js";

const REPO_TEMPLATES_DIR = resolve(
  import.meta.dirname,
  "..",
  "..",
  "templates",
  "skills",
);

// Sha256 of a file in the source tree (for direct expected-value assertions
// independent of `readSkillSource`'s own implementation).
function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

describe("distribute() — parametric over 5 Tier 1 agents", () => {
  // describe.each runs the same suite once per descriptor; failures are
  // reported with the agent id so a single broken path is obvious.
  describe.each(AGENT_DESCRIPTORS.map((d) => [d.id, d] as const))(
    "agent=%s",
    (_id, descriptor: AgentDescriptor) => {
      it("lands every templates/skills file under <skillsPath>/<relPath>", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          const result = distribute(descriptor, source, { rootDir: dir });

          // Every file in the canonical source has a matching destination.
          const expectedRelPaths = source.entries
            .flatMap((e) => e.files)
            .map((f) => f.relPath);
          expect(result.targets.length).toBe(expectedRelPaths.length);
          expect(result.writtenPaths.length).toBe(expectedRelPaths.length);
          expect(result.noopPaths.length).toBe(0);

          for (const rel of expectedRelPaths) {
            const dst = join(dir, descriptor.skillsPath, rel);
            expect(existsSync(dst), `missing: ${dst}`).toBe(true);
          }
        } finally {
          cleanup();
        }
      });

      it("post-copy sha256 matches the canonical source byte-for-byte", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          distribute(descriptor, source, { rootDir: dir });

          for (const entry of source.entries) {
            for (const file of entry.files) {
              const dst = join(dir, descriptor.skillsPath, file.relPath);
              const onDisk = sha256File(dst);
              expect(onDisk, `drift: ${file.relPath}`).toBe(file.sha256);
            }
          }
        } finally {
          cleanup();
        }
      });

      it("preserves the sub-tree structure exactly (snapshot equality)", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          distribute(descriptor, source, { rootDir: dir });

          const distRoot = join(dir, descriptor.skillsPath);
          const snapshot = readDistributedTree(distRoot);

          // Flatten the canonical source to the same shape so we can compare
          // path-by-path. `readDistributedTree` returns relpaths under
          // `distRoot`, which mirror `SkillFile.relPath` exactly.
          const expectedPaths = source.entries
            .flatMap((e) => e.files)
            .map((f) => f.relPath)
            .sort();
          expect(snapshot.paths).toEqual(expectedPaths);

          for (const rel of expectedPaths) {
            const file = source.entries
              .flatMap((e) => e.files)
              .find((f) => f.relPath === rel)!;
            expect(snapshot.sha256[rel], `sha mismatch ${rel}`).toBe(file.sha256);
          }
        } finally {
          cleanup();
        }
      });

      it("is idempotent — second run touches nothing", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          const first = distribute(descriptor, source, { rootDir: dir });
          expect(first.writtenPaths.length).toBeGreaterThan(0);
          expect(first.noopPaths.length).toBe(0);

          // Capture sha256s before the second call so we can prove they are
          // unchanged after the no-op pass.
          const distRoot = join(dir, descriptor.skillsPath);
          const before = readDistributedTree(distRoot);

          const second = distribute(descriptor, source, { rootDir: dir });
          expect(second.writtenPaths.length).toBe(0);
          expect(second.noopPaths.length).toBe(first.targets.length);

          const after = readDistributedTree(distRoot);
          expect(after.paths).toEqual(before.paths);
          for (const p of after.paths) {
            expect(after.sha256[p]).toBe(before.sha256[p]);
          }
        } finally {
          cleanup();
        }
      });

      it("refuses to overwrite a drifted file without --force", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          distribute(descriptor, source, { rootDir: dir });

          // Tamper with one SKILL.md so the second call sees drift.
          const tampered = join(
            dir,
            descriptor.skillsPath,
            "artgraph-impact",
            "SKILL.md",
          );
          writeFileSync(tampered, "user edit\n", "utf-8");

          let caught: unknown;
          try {
            distribute(descriptor, source, { rootDir: dir });
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(DistributionError);
          if (caught instanceof DistributionError) {
            expect(caught.conflictPaths).toContain("artgraph-impact/SKILL.md");
            expect(caught.message).toMatch(/artgraph-impact\/SKILL\.md/);
            expect(caught.message).toMatch(/--force/);
          }

          // The destination remains the user's tampered content (not
          // overwritten by the failed call).
          expect(readFileSync(tampered, "utf-8")).toBe("user edit\n");
        } finally {
          cleanup();
        }
      });

      it("--force overwrites drifted files and re-syncs sha256", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          distribute(descriptor, source, { rootDir: dir });

          const tampered = join(
            dir,
            descriptor.skillsPath,
            "artgraph-impact",
            "SKILL.md",
          );
          writeFileSync(tampered, "user edit\n", "utf-8");

          const result = distribute(descriptor, source, {
            rootDir: dir,
            force: true,
          });
          // Only the tampered file was rewritten; the rest stayed no-op.
          expect(result.writtenPaths.some((p) => p === tampered)).toBe(true);

          const expectedHash = source.entries
            .flatMap((e) => e.files)
            .find((f) => f.relPath === "artgraph-impact/SKILL.md")!.sha256;
          expect(sha256File(tampered)).toBe(expectedHash);
        } finally {
          cleanup();
        }
      });

      it("lists every drifted path in the conflict error (no --force)", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          distribute(descriptor, source, { rootDir: dir });

          // Tamper TWO files so the error message lists both.
          const a = join(dir, descriptor.skillsPath, "artgraph-impact", "SKILL.md");
          const b = join(dir, descriptor.skillsPath, "artgraph-verify", "SKILL.md");
          writeFileSync(a, "edit A\n", "utf-8");
          writeFileSync(b, "edit B\n", "utf-8");

          let caught: unknown;
          try {
            distribute(descriptor, source, { rootDir: dir });
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(DistributionError);
          if (caught instanceof DistributionError) {
            expect(caught.conflictPaths).toContain("artgraph-impact/SKILL.md");
            expect(caught.conflictPaths).toContain("artgraph-verify/SKILL.md");
          }
        } finally {
          cleanup();
        }
      });

      // R1 — `_shared/` must travel with every agent's distribution.
      it("distributes every _shared/ file under <skillsPath>/_shared/", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          distribute(descriptor, source, { rootDir: dir });

          const sharedEntry = source.entries.find((e) => e.topLevel === "_shared");
          expect(sharedEntry, "_shared/ entry must be present").toBeDefined();
          expect(sharedEntry!.files.length).toBeGreaterThanOrEqual(3);

          for (const file of sharedEntry!.files) {
            const dst = join(dir, descriptor.skillsPath, file.relPath);
            expect(existsSync(dst), `missing shared: ${file.relPath}`).toBe(true);
            expect(sha256File(dst)).toBe(file.sha256);
          }

          // Explicit assertions on the three known fragments so this test
          // also acts as a contract check against templates/skills/_shared/.
          for (const known of [
            "_shared/install-check.md",
            "_shared/output-schema.md",
            "_shared/package-manager.md",
          ]) {
            const abs = join(dir, descriptor.skillsPath, known);
            expect(existsSync(abs), `missing _shared file: ${known}`).toBe(true);
          }
        } finally {
          cleanup();
        }
      });

      it("refuses to overwrite a symlink at the destination, even with --force", () => {
        const { dir, cleanup } = createFreshProject();
        try {
          const source = readSkillSource(REPO_TEMPLATES_DIR);
          // Plant a symlink at one of the destinations BEFORE distributing.
          const dstSkillMd = join(
            dir,
            descriptor.skillsPath,
            "artgraph-impact",
            "SKILL.md",
          );
          mkdirSync(dirname(dstSkillMd), { recursive: true });
          // Point at a harmless file the test owns. The point is that
          // distribute() must not follow the symlink and overwrite it.
          const decoyTarget = join(dir, "decoy.txt");
          writeFileSync(decoyTarget, "decoy\n", "utf-8");
          symlinkSync(decoyTarget, dstSkillMd);

          let caught: unknown;
          try {
            distribute(descriptor, source, { rootDir: dir, force: true });
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(DistributionError);
          if (caught instanceof DistributionError) {
            expect(caught.conflictPaths.some((p) => p.includes("symlink"))).toBe(
              true,
            );
          }
          // The decoy target was NOT clobbered.
          expect(readFileSync(decoyTarget, "utf-8")).toBe("decoy\n");
        } finally {
          cleanup();
        }
      });
    },
  );
});

// ===========================================================================
// PR #114 review-cluster B: A4 / A-adj-4 / B1 / B5 / B9 regression tests.
//
// Each of these exercises a specific failure mode that the previous
// implementation silently mishandled. The tests use a claude descriptor and
// a synthetic (or partial) skills-source so we do NOT depend on the real
// `templates/skills/` tree — otherwise a template change would break
// unrelated safety assertions.
//
// Filesystem-permission-based tests (B1, B5, B9) only make sense on POSIX
// where `chmod` and `lstat` return standard errno codes. They are gated
// with `it.skipIf(process.platform === "win32")` so Windows CI skips them
// rather than reports flakes.
// ===========================================================================

const CLAUDE = AGENT_DESCRIPTORS.find((d) => d.id === "claude")!;
const IS_WIN = process.platform === "win32";

/**
 * Build a self-contained skills-source under `sourceDir` and return the
 * `SkillSource` for it. Callers can then `distribute()` against a fresh
 * project without touching the real `templates/skills/` tree.
 *
 * `entries[i].body` bytes are written verbatim; the returned SkillSource is
 * re-computed via `readSkillSource` so the sha256 fields match the on-disk
 * content exactly.
 */
function makeSyntheticSource(
  sourceDir: string,
  entries: Array<{ relPath: string; body: string }>,
): ReturnType<typeof readSkillSource> {
  for (const { relPath, body } of entries) {
    const abs = join(sourceDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }
  return readSkillSource(sourceDir);
}

describe("distribute() — PR #114 cluster B regressions", () => {
  // -------------------------------------------------------------------------
  // A4 — intermediate-directory symlink attack. If `.claude/` (or any
  // ancestor) is a symlink pointing outside the project tree, the previous
  // implementation would write through it, silently landing skills bytes on
  // some out-of-repo location. `findSymlinkAncestor` must catch this.
  // -------------------------------------------------------------------------
  it.skipIf(IS_WIN)(
    "A4: refuses to write through an ancestor-directory symlink (intermediate .claude → outside/)",
    () => {
      const { dir, cleanup } = createFreshProject();
      try {
        const source = readSkillSource(REPO_TEMPLATES_DIR);
        // Prepare an "outside" directory INSIDE the tmpdir (so we do not
        // pollute the real filesystem) and symlink `.claude` at it. From
        // distribute's perspective this ancestor is a symlink and any
        // downstream write would land in `outside/`.
        const outside = join(dir, "outside-landing");
        mkdirSync(outside);
        symlinkSync(outside, join(dir, ".claude"));

        let caught: unknown;
        try {
          distribute(CLAUDE, source, { rootDir: dir, force: true });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DistributionError);
        if (caught instanceof DistributionError) {
          // Message pinpoints the offending ancestor (.claude), not the leaf.
          expect(caught.message).toMatch(/symlink/);
          expect(caught.conflictPaths.some((p) => p.includes("symlink ancestor"))).toBe(
            true,
          );
          expect(
            caught.conflictPaths.some((p) => p.includes(".claude")),
          ).toBe(true);
        }
        // No skills bytes leaked into the outside/ landing dir.
        expect(existsSync(join(outside, "skills"))).toBe(false);
        expect(existsSync(join(outside, "artgraph-impact"))).toBe(false);
      } finally {
        cleanup();
      }
    },
  );

  // -------------------------------------------------------------------------
  // A-adj-4 — a directory sitting at the leaf target should not be
  // labelled "symlink". This regressed because the previous impl folded
  // any non-file into the `symlinkConflicts` bucket, so the error message
  // told the user to remove a "symlink" that was actually a directory.
  // -------------------------------------------------------------------------
  it("A-adj-4: directory at leaf target uses the non-regular bucket, not the symlink one", () => {
    const { dir, cleanup } = createFreshProject();
    try {
      const source = readSkillSource(REPO_TEMPLATES_DIR);
      // Pre-create a directory where `artgraph-impact/SKILL.md` should land.
      const badLeaf = join(
        dir,
        CLAUDE.skillsPath,
        "artgraph-impact",
        "SKILL.md",
      );
      mkdirSync(badLeaf, { recursive: true });
      // Sanity: the leaf really is a directory.
      expect(statSync(badLeaf).isDirectory()).toBe(true);

      let caught: unknown;
      try {
        distribute(CLAUDE, source, { rootDir: dir, force: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DistributionError);
      if (caught instanceof DistributionError) {
        // Message must NOT mislabel the conflict as a symlink.
        expect(caught.message.toLowerCase()).not.toMatch(/symlink/);
        expect(caught.message).toMatch(/non-regular/);
        // conflictPaths call out the offending SKILL.md relpath, non-symlink kind.
        expect(
          caught.conflictPaths.some((p) => p.includes("artgraph-impact/SKILL.md")),
        ).toBe(true);
        for (const p of caught.conflictPaths) {
          expect(p.toLowerCase()).not.toMatch(/symlink/);
        }
      }
      // The pre-existing directory was not touched.
      expect(existsSync(badLeaf)).toBe(true);
      expect(statSync(badLeaf).isDirectory()).toBe(true);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // B1 — mid-loop --force failure MUST restore the user's original bytes
  // for any drift-overwrite target that already succeeded. The regression
  // was that unlink-based rollback deleted the just-written canonical AND
  // the user edit it replaced, leaving the user with nothing.
  //
  // Reproduction: two drifted files (A and B). B's parent is chmod 0500
  // so the write for B fails at copyFileSync-to-tmp. A's backup MUST be
  // rename'd back over A so A retains "USER BYTES A".
  // -------------------------------------------------------------------------
  it.skipIf(IS_WIN)(
    "B1: mid-loop --force failure restores the user's pre-call bytes for succeeded drift-overwrites",
    () => {
      const { dir: projectDir, cleanup: cleanupProject } = createFreshProject();
      const { dir: sourceDir, cleanup: cleanupSource } = createFreshProject();
      // Track the chmod-locked dir so we can restore perms in finally
      // (otherwise vitest cleanup rm can't traverse).
      let locked: string | null = null;
      try {
        // Synthetic source with two Skill entries — deterministic ordering
        // (`artgraph-a` < `artgraph-b`) ensures A is processed before B.
        const source = makeSyntheticSource(sourceDir, [
          {
            relPath: "artgraph-a/SKILL.md",
            body: "---\nname: artgraph-a\ndescription: A stub\n---\ncanonical-A\n",
          },
          {
            relPath: "artgraph-b/SKILL.md",
            body: "---\nname: artgraph-b\ndescription: B stub\n---\ncanonical-B\n",
          },
        ]);

        // (1) Baseline distribute lands canonical bytes at both targets.
        distribute(CLAUDE, source, { rootDir: projectDir });
        const targetA = join(
          projectDir,
          CLAUDE.skillsPath,
          "artgraph-a",
          "SKILL.md",
        );
        const targetB = join(
          projectDir,
          CLAUDE.skillsPath,
          "artgraph-b",
          "SKILL.md",
        );
        expect(existsSync(targetA)).toBe(true);
        expect(existsSync(targetB)).toBe(true);

        // (2) User tampers with both files.
        const userBytesA = "USER EDIT A — must survive rollback\n";
        const userBytesB = "USER EDIT B — this one's dir gets locked\n";
        writeFileSync(targetA, userBytesA, "utf-8");
        writeFileSync(targetB, userBytesB, "utf-8");

        // (3) Break B's write two ways so BOTH the pre-fix and the
        //     post-fix paths hit an EACCES on B:
        //       * chmod 0444 on `targetB` — read-only file blocks the
        //         PRE-fix `copyFileSync(src, dst)` open-for-write path
        //         (that is the exact regression scenario documented in
        //         the review comment).
        //       * chmod 0500 on `.claude/skills/artgraph-b/` — read-exec
        //         parent blocks the POST-fix `copyFileSync(src, tmp)`
        //         and `copyFileSync(dst, backup)` steps because both
        //         create new files in that dir.
        //     A's parent stays writable, so A's backup+rename path
        //     succeeds and rollback can rename backup → A.
        chmodSync(targetB, 0o444);
        locked = join(projectDir, CLAUDE.skillsPath, "artgraph-b");
        chmodSync(locked, 0o500);

        // (4) --force distribute triggers driftOverwrite for both. Order:
        //     A first (write + backup succeed), B second (EACCES).
        let caught: unknown;
        try {
          distribute(CLAUDE, source, { rootDir: projectDir, force: true });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DistributionError);

        // (5) THE CORE B1 ASSERTION: user's bytes at A are preserved.
        // Old impl deleted the canonical replacement AND the backup, so
        // A would be lost. New impl renames backup → target.
        expect(existsSync(targetA)).toBe(true);
        expect(readFileSync(targetA, "utf-8")).toBe(userBytesA);
        // B was untouched by distribute (write failed before rename).
        expect(readFileSync(targetB, "utf-8")).toBe(userBytesB);

        // No orphan backup/tmp files linger under A's parent.
        const aDirEntries = readdirSync(
          join(projectDir, CLAUDE.skillsPath, "artgraph-a"),
        );
        for (const name of aDirEntries) {
          expect(name.includes(".artgraph-backup-")).toBe(false);
          expect(name.includes(".artgraph-tmp-")).toBe(false);
        }
      } finally {
        if (locked !== null) {
          try {
            chmodSync(locked, 0o755);
          } catch {
            /* best-effort */
          }
          // Also restore the read-only target so vitest's recursive
          // cleanup can unlink it.
          try {
            chmodSync(
              join(projectDir, CLAUDE.skillsPath, "artgraph-b", "SKILL.md"),
              0o644,
            );
          } catch {
            /* best-effort */
          }
        }
        cleanupProject();
        cleanupSource();
      }
    },
  );

  // -------------------------------------------------------------------------
  // B5 — rollback must remove every intermediate directory that was
  // created during the aborted run. The regression: `mkdirSync({recursive:
  // true})` reported only the leaf, so nested empty ancestors were left
  // behind (which doctor's auto-detect then read as "installed").
  //
  // Reproduction: one target that forces 3 nested dir creates (a,
  // a/nested, a/nested/deep) then a second target whose parent is chmod
  // 0500 so its write fails. The rollback must rmdir the whole a/…/deep
  // chain.
  // -------------------------------------------------------------------------
  it.skipIf(IS_WIN)(
    "B5: rollback removes every intermediate directory tracked during the aborted call",
    () => {
      const { dir: projectDir, cleanup: cleanupProject } = createFreshProject();
      const { dir: sourceDir, cleanup: cleanupSource } = createFreshProject();
      let locked: string | null = null;
      try {
        // Two synthetic entries. The first entry contains a deeply nested
        // reference file that forces `.claude/skills/artgraph-a/nested/deep/`
        // to be created a segment at a time. The second entry's parent is
        // pre-created and chmod'd so its write fails.
        const source = makeSyntheticSource(sourceDir, [
          {
            relPath: "artgraph-a/SKILL.md",
            body: "---\nname: artgraph-a\ndescription: A stub\n---\na\n",
          },
          {
            relPath: "artgraph-a/nested/deep/reference.md",
            body: "reference body\n",
          },
          {
            relPath: "artgraph-b/SKILL.md",
            body: "---\nname: artgraph-b\ndescription: B stub\n---\nb\n",
          },
        ]);

        // Pre-create `.claude/skills/artgraph-b/` chmod 0500 so writing
        // into it fails. This also implicitly creates `.claude/` and
        // `.claude/skills/` (both are NOT in dirsCreated because they
        // pre-existed at distribute() entry).
        locked = join(projectDir, CLAUDE.skillsPath, "artgraph-b");
        mkdirSync(locked, { recursive: true });
        chmodSync(locked, 0o500);

        let caught: unknown;
        try {
          distribute(CLAUDE, source, { rootDir: projectDir });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DistributionError);

        // THE CORE B5 ASSERTION: every intermediate dir that WAS created
        // during the aborted run is gone. Under the old code, `.claude/
        // skills/artgraph-a/nested` (and `.../nested/deep`) leaked as
        // empty orphans because only the leaf was tracked.
        const aRoot = join(projectDir, CLAUDE.skillsPath, "artgraph-a");
        const nested = join(aRoot, "nested");
        const deep = join(nested, "deep");
        expect(existsSync(deep), "deep must be rmdir'd").toBe(false);
        expect(existsSync(nested), "nested must be rmdir'd").toBe(false);
        expect(existsSync(aRoot), "artgraph-a must be rmdir'd").toBe(false);

        // Pre-existing dirs are untouched.
        expect(existsSync(locked)).toBe(true);
        expect(existsSync(join(projectDir, CLAUDE.skillsPath))).toBe(true);
      } finally {
        if (locked !== null) {
          try {
            chmodSync(locked, 0o755);
          } catch {
            /* best-effort */
          }
        }
        cleanupProject();
        cleanupSource();
      }
    },
  );

  // -------------------------------------------------------------------------
  // B9 — a non-ENOENT lstat error must surface as DistributionError with
  // a clear message, NOT be silently reinterpreted as "path is absent".
  // The regression was that `catch { freshWrites.push(t) }` folded EACCES
  // into the "we can write freshly here" bucket, so the user later saw an
  // opaque `copyfile EACCES` with no hint that the real cause was a
  // permission-denied lstat on the leaf's parent.
  // -------------------------------------------------------------------------
  it.skipIf(IS_WIN)(
    "B9: non-ENOENT lstat errors (EACCES) surface as DistributionError, not silent freshWrite",
    () => {
      const { dir: projectDir, cleanup: cleanupProject } = createFreshProject();
      const { dir: sourceDir, cleanup: cleanupSource } = createFreshProject();
      let locked: string | null = null;
      try {
        const source = makeSyntheticSource(sourceDir, [
          {
            relPath: "artgraph-a/SKILL.md",
            body: "---\nname: artgraph-a\ndescription: A stub\n---\na\n",
          },
        ]);

        // First distribute to establish a real leaf at
        // `.claude/skills/artgraph-a/SKILL.md`, then strip the parent dir
        // of its execute bit — that makes `lstatSync(leaf)` return EACCES
        // even though the file is there.
        distribute(CLAUDE, source, { rootDir: projectDir });
        locked = join(projectDir, CLAUDE.skillsPath, "artgraph-a");
        // 0o666 = rw for everyone but NO execute. Without x, path
        // traversal into the dir (which lstat of the leaf requires) is
        // denied.
        chmodSync(locked, 0o666);

        let caught: unknown;
        try {
          distribute(CLAUDE, source, { rootDir: projectDir, force: true });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DistributionError);
        if (caught instanceof DistributionError) {
          // Message pinpoints the leaf and includes an errno hint so the
          // user knows this is a permission issue on the parent dir, not
          // a "file missing" problem.
          expect(caught.message).toMatch(/Cannot inspect/);
          expect(caught.message).toMatch(/EACCES/);
          expect(caught.message).toMatch(/SKILL\.md/);
        }
      } finally {
        if (locked !== null) {
          try {
            chmodSync(locked, 0o755);
          } catch {
            /* best-effort */
          }
        }
        cleanupProject();
        cleanupSource();
      }
    },
  );
});

describe("planDistribution()", () => {
  it("returns one entry per (agent, file) pair without writing anything", () => {
    const { dir, cleanup } = createFreshProject();
    try {
      const source = readSkillSource(REPO_TEMPLATES_DIR);
      const claude = AGENT_DESCRIPTORS.find((d) => d.id === "claude")!;
      const plan = planDistribution(claude, source, dir);

      const expectedCount = source.entries.flatMap((e) => e.files).length;
      expect(plan.length).toBe(expectedCount);

      // No side effects: the dst path does NOT exist after planning.
      for (const t of plan) {
        expect(existsSync(t.dstAbsPath), `${t.dstAbsPath} pre-exists`).toBe(false);
      }
    } finally {
      cleanup();
    }
  });
});

// ===========================================================================
// PR #114 OUT-4 — direct regression tests for two failure modes that only
// had indirect / removed coverage:
//   1. post-write sha256 mismatch (the OPS-15 verification step in
//      distribute()'s write loop) actually throws and rolls back.
//   2. a rollback step that itself fails (unlinkSync of an already-written
//      fresh-write target) is reported via `DistributionError.partiallyWritten`
//      instead of being silently swallowed.
//
// `unlinkFailurePath` + the `node:fs` mock below exist ONLY for test 2. Real
// POSIX permissions cannot reproduce "target A's write succeeds, then A's
// OWN directory becomes unwritable before rollback" within a single
// synchronous `distribute()` call: creating a directory entry (the tmp file
// + rename) and removing one (rollback's unlinkSync) both require the
// identical write+execute bit on the SAME containing directory (verified
// empirically — chmod 0555 applied before the call blocks both operations
// together, so it cannot single out only the later one). The mock lets
// exactly one targeted `unlinkSync(path)` call fail while every other fs
// operation in this file — including every existing test above — is
// untouched (delegates straight through to the real implementation).
// ===========================================================================

let unlinkFailurePath: string | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (unlinkFailurePath !== null && path === unlinkFailurePath) {
        const err = new Error(
          `EACCES: permission denied, unlink '${String(path)}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.unlinkSync(path);
    },
  };
});

describe("distribute() — PR #114 OUT-4", () => {
  it("post-write sha256 mismatch: source tampered after readSkillSource() throws DistributionError and rolls back the fresh write", () => {
    const { dir: projectDir, cleanup: cleanupProject } = createFreshProject();
    const { dir: sourceDir, cleanup: cleanupSource } = createFreshProject();
    try {
      const source = makeSyntheticSource(sourceDir, [
        {
          relPath: "artgraph-a/SKILL.md",
          body: "---\nname: artgraph-a\ndescription: A stub\n---\noriginal content\n",
        },
      ]);

      // Overwrite the source file AFTER readSkillSource() already captured
      // sha256(original) into `source.entries[].files[].sha256`. distribute()
      // reads the file's CURRENT (tampered) bytes via copyFileSync, writes
      // them to the destination, then recomputes sha256(dst) — which now
      // mismatches the stale `expectedSha256` from the plan.
      const srcAbs = join(sourceDir, "artgraph-a", "SKILL.md");
      writeFileSync(
        srcAbs,
        "---\nname: artgraph-a\ndescription: A stub\n---\ntampered after hashing\n",
        "utf-8",
      );

      let caught: unknown;
      try {
        distribute(CLAUDE, source, { rootDir: projectDir });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DistributionError);
      if (caught instanceof DistributionError) {
        expect(caught.message).toMatch(/post-write sha256 mismatch/);
      }

      // Rollback ran: the fresh write must be undone, not left on disk with
      // the wrong (tampered) bytes.
      const dst = join(projectDir, CLAUDE.skillsPath, "artgraph-a", "SKILL.md");
      expect(existsSync(dst)).toBe(false);
    } finally {
      cleanupProject();
      cleanupSource();
    }
  });

  it.skipIf(IS_WIN)(
    "partiallyWritten: a rollback unlinkSync failure for an already-succeeded fresh write is reported as a survivor",
    () => {
      const { dir: projectDir, cleanup: cleanupProject } = createFreshProject();
      const { dir: sourceDir, cleanup: cleanupSource } = createFreshProject();
      let lockedDir: string | null = null;
      try {
        // Two fresh-write targets across two skill dirs — deterministic
        // ordering (`artgraph-a` < `artgraph-b`) means A is written (and
        // succeeds) before B is attempted.
        const source = makeSyntheticSource(sourceDir, [
          {
            relPath: "artgraph-a/SKILL.md",
            body: "---\nname: artgraph-a\ndescription: A stub\n---\ncanonical-A\n",
          },
          {
            relPath: "artgraph-b/SKILL.md",
            body: "---\nname: artgraph-b\ndescription: B stub\n---\ncanonical-B\n",
          },
        ]);

        const targetA = join(
          projectDir,
          CLAUDE.skillsPath,
          "artgraph-a",
          "SKILL.md",
        );

        // Pre-create + lock B's directory (real chmod, same technique as
        // the B1/B5 tests above) so B's write — the SECOND target in the
        // loop — fails with a genuine EACCES, triggering rollback.
        lockedDir = join(projectDir, CLAUDE.skillsPath, "artgraph-b");
        mkdirSync(lockedDir, { recursive: true });
        chmodSync(lockedDir, 0o500);

        // A's OWN rollback (unlinkSync of the fresh write that already
        // succeeded) is the one call forced to fail — see the mock's
        // header comment for why this can't be done via a real chmod on
        // A's directory instead.
        unlinkFailurePath = targetA;

        let caught: unknown;
        try {
          distribute(CLAUDE, source, { rootDir: projectDir });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(DistributionError);
        if (caught instanceof DistributionError) {
          expect(caught.partiallyWritten.length).toBeGreaterThan(0);
          expect(caught.partiallyWritten).toContain(targetA);
        }

        // A's bytes are still on disk — the rollback failed to remove
        // them, which is exactly the "manual cleanup required" state
        // `partiallyWritten` exists to surface to the caller.
        expect(existsSync(targetA)).toBe(true);
      } finally {
        unlinkFailurePath = null;
        if (lockedDir !== null) {
          // Explicit teardown BEFORE cleanup's recursive rmSync — otherwise
          // vitest's tmp-dir removal can't traverse the locked directory.
          try {
            chmodSync(lockedDir, 0o755);
          } catch {
            /* best-effort */
          }
        }
        cleanupProject();
        cleanupSource();
      }
    },
  );
});
