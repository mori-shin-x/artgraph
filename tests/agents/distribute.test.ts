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

import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
