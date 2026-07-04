// spec 013 T015 / T016 / T017 [US2] — multi-agent distribution scenarios.
//
// US2 ships no production code of its own: `distribute()` (US1) already
// loops per-agent, so the contract for "single canonical SKILL.md tree,
// many Tier 1 agents in parallel" is enforced entirely by this file.
//
// Scenario coverage (US2 Acceptance Scenarios in spec.md):
//   T015 — 5-agent simultaneous distribute → all 5 destinations byte-equal
//          to one another AND byte-equal to `templates/skills/` (US2 A-1).
//   T016 — incremental addition (init --agents=claude then --agents=claude,
//          codex --force): claude tree unchanged, codex tree freshly
//          populated and byte-equal to claude (US2 A-2).
//   T017 — canonical edit propagation: bumping ONE source byte and
//          re-distributing with --force reflects in ALL 5 destinations
//          (US2 A-3). This test uses an ISOLATED tmp skills-source tree
//          so the real `templates/skills/` is never mutated.
//
// Design notes:
//   - Tests call `distribute()` directly (not `runInit`) because the unit
//     contract under test is "distribute is loop-safe across the 5 Tier 1
//     descriptors" — going through runInit adds detect/scan overhead and
//     extra stages (agent-context, integrations) that are exercised by
//     other suites and not relevant here.
//   - T017 builds its own `templates/skills/`-shaped fixture under tmp and
//     reads it via `readSkillSource(tmpDir)`. This keeps the real source
//     tree pristine across the run (Constitution Principle I — determinism
//     across tests in any order / in parallel).

import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_DESCRIPTORS,
  type AgentDescriptor,
} from "../../src/agents/descriptors.js";
import { readSkillSource } from "../../src/agents/source.js";
import { distribute } from "../../src/agents/distribute.js";
import {
  createFreshProject,
  readDistributedTree,
  type DistributedTreeSnapshot,
} from "./helpers.js";

const REPO_TEMPLATES_DIR = resolve(
  import.meta.dirname,
  "..",
  "..",
  "templates",
  "skills",
);

/**
 * Compare two `DistributedTreeSnapshot` instances for full byte-equality:
 * same set of relpaths and same sha256 per relpath. Returns a list of
 * human-readable diffs (empty when equal) so vitest's assertion shows the
 * exact divergence rather than a Map-deep-equality black box.
 */
function diffSnapshots(
  a: DistributedTreeSnapshot,
  b: DistributedTreeSnapshot,
): string[] {
  const diffs: string[] = [];
  const allPaths = new Set([...a.paths, ...b.paths]);
  for (const p of allPaths) {
    const sa = a.sha256[p];
    const sb = b.sha256[p];
    if (sa === undefined) diffs.push(`only in B: ${p}`);
    else if (sb === undefined) diffs.push(`only in A: ${p}`);
    else if (sa !== sb) diffs.push(`sha mismatch ${p}: A=${sa} B=${sb}`);
  }
  return diffs;
}

describe("distribute() — US2 multi-agent scenarios", () => {
  // -------------------------------------------------------------------------
  // T015 — 5 Tier 1 agents distributed in one project, all destinations
  // byte-equal to one another AND to the canonical `templates/skills/` tree.
  // -------------------------------------------------------------------------
  it("T015: 5-agent simultaneous distribute lands byte-identical trees at every canonical path", () => {
    const { dir, cleanup } = createFreshProject();
    try {
      const source = readSkillSource(REPO_TEMPLATES_DIR);

      // Distribute to every Tier 1 agent (claude, codex, cursor, copilot,
      // kiro). `force: true` mirrors the CLI invocation in the task line.
      for (const descriptor of AGENT_DESCRIPTORS) {
        const result = distribute(descriptor, source, {
          rootDir: dir,
          force: true,
        });
        // Fresh project → every target should land as a write, none as no-op.
        expect(
          result.writtenPaths.length,
          `agent=${descriptor.id} expected all-fresh writes`,
        ).toBe(result.targets.length);
        expect(result.noopPaths.length).toBe(0);
      }

      // Read each destination tree and assert pairwise diff-zero.
      const canonicalSnapshot = readDistributedTree(REPO_TEMPLATES_DIR);
      const perAgent = new Map<string, DistributedTreeSnapshot>();
      for (const descriptor of AGENT_DESCRIPTORS) {
        const snap = readDistributedTree(join(dir, descriptor.skillsPath));
        perAgent.set(descriptor.id, snap);

        // Each destination must match the canonical source byte-for-byte.
        const diffsVsCanonical = diffSnapshots(canonicalSnapshot, snap);
        expect(
          diffsVsCanonical,
          `agent=${descriptor.id} diverges from canonical: ${diffsVsCanonical.join("; ")}`,
        ).toEqual([]);
      }

      // Pairwise byte-equality between every (agent_i, agent_j) destination.
      // Quadratic in 5 agents (= 10 comparisons) — trivial, and explicit so a
      // single drift between two destinations is reported with both ids.
      const ids = AGENT_DESCRIPTORS.map((d) => d.id);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = perAgent.get(ids[i]!)!;
          const b = perAgent.get(ids[j]!)!;
          const diffs = diffSnapshots(a, b);
          expect(
            diffs,
            `${ids[i]} vs ${ids[j]} diverged: ${diffs.join("; ")}`,
          ).toEqual([]);
        }
      }
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T016 — incremental addition: first init `--agents=claude`, then re-init
  // `--agents=claude,codex --force`. The pre-existing claude tree must be
  // untouched (idempotent re-pass), and the new codex tree must appear and
  // be byte-equal to claude.
  // -------------------------------------------------------------------------
  it("T016: incremental addition (claude → claude+codex) preserves claude bytes and populates codex", () => {
    const { dir, cleanup } = createFreshProject();
    try {
      const source = readSkillSource(REPO_TEMPLATES_DIR);
      const claude = AGENT_DESCRIPTORS.find((d) => d.id === "claude")!;
      const codex = AGENT_DESCRIPTORS.find((d) => d.id === "codex")!;

      // (1) First init: only --agents=claude.
      const first = distribute(claude, source, { rootDir: dir });
      expect(first.writtenPaths.length).toBe(first.targets.length);
      expect(first.noopPaths.length).toBe(0);

      const claudeBefore = readDistributedTree(join(dir, claude.skillsPath));
      expect(claudeBefore.paths.length).toBeGreaterThan(0);

      // (2) `.agents/skills/` (codex destination) MUST NOT exist yet —
      // helper returns an empty snapshot for a non-existent directory.
      const codexBefore = readDistributedTree(join(dir, codex.skillsPath));
      expect(codexBefore.paths).toEqual([]);

      // (3) Second init: --agents=claude,codex --force. Mirroring runInit's
      // per-agent loop, distribute() is invoked for both descriptors.
      const reClaude = distribute(claude, source, {
        rootDir: dir,
        force: true,
      });
      // Every claude target should be classified as no-op on the second
      // pass — sha256 already matches, --force does not force a rewrite of
      // already-canonical files (driftOverwrite bucket stays empty).
      expect(
        reClaude.writtenPaths.length,
        "claude re-distribution must not rewrite already-canonical files",
      ).toBe(0);
      expect(reClaude.noopPaths.length).toBe(reClaude.targets.length);

      const newCodex = distribute(codex, source, {
        rootDir: dir,
        force: true,
      });
      expect(newCodex.writtenPaths.length).toBe(newCodex.targets.length);
      expect(newCodex.noopPaths.length).toBe(0);

      // (4) Claude tree byte-equal to the pre-second-call snapshot.
      const claudeAfter = readDistributedTree(join(dir, claude.skillsPath));
      const claudeDiffs = diffSnapshots(claudeBefore, claudeAfter);
      expect(
        claudeDiffs,
        `claude tree mutated during codex add: ${claudeDiffs.join("; ")}`,
      ).toEqual([]);

      // (5) Codex tree exists and matches the claude tree byte-for-byte
      // (relpaths under <skillsPath> are descriptor-independent).
      const codexAfter = readDistributedTree(join(dir, codex.skillsPath));
      const crossDiffs = diffSnapshots(claudeAfter, codexAfter);
      expect(
        crossDiffs,
        `codex tree diverges from claude: ${crossDiffs.join("; ")}`,
      ).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // T017 — canonical edit propagation. We mutate ONE source byte and verify
  // that every one of the 5 destinations reflects the change after --force
  // re-distribution. To avoid touching the real `templates/skills/` (which
  // would leak across tests / corrupt the working tree), we build a
  // dedicated tmp skills-source tree and point `readSkillSource` at it.
  // -------------------------------------------------------------------------
  it("T017: editing canonical source propagates to all 5 destinations on --force re-distribute", () => {
    const { dir: projectDir, cleanup: cleanupProject } = createFreshProject();
    const { dir: sourceDir, cleanup: cleanupSource } = createFreshProject();
    try {
      // Build a minimal-yet-realistic `templates/skills/`-shaped fixture:
      //   sourceDir/
      //     artgraph-impact/SKILL.md          (the file we'll edit)
      //     artgraph-verify/SKILL.md          (sanity entry — must NOT change)
      //     _shared/install-check.md          (R1 shared fragment travels)
      // readSkillSource enforces that every non-`_shared` top level has
      // SKILL.md; both entries above satisfy that.
      const skillImpactPath = join(sourceDir, "artgraph-impact", "SKILL.md");
      const skillVerifyPath = join(sourceDir, "artgraph-verify", "SKILL.md");
      const sharedPath = join(sourceDir, "_shared", "install-check.md");
      for (const p of [skillImpactPath, skillVerifyPath, sharedPath]) {
        mkdirSync(dirname(p), { recursive: true });
      }
      const initialImpactBody =
        "---\nname: artgraph-impact\ndescription: stub\n---\nv1\n";
      writeFileSync(skillImpactPath, initialImpactBody, "utf-8");
      writeFileSync(
        skillVerifyPath,
        "---\nname: artgraph-verify\ndescription: stub\n---\nverify\n",
        "utf-8",
      );
      writeFileSync(sharedPath, "shared install-check v1\n", "utf-8");

      // (1) First distribution pass with the v1 source.
      const sourceV1 = readSkillSource(sourceDir);
      for (const descriptor of AGENT_DESCRIPTORS) {
        distribute(descriptor, sourceV1, {
          rootDir: projectDir,
          force: true,
        });
      }

      // Capture snapshot A (post-v1) per agent.
      const snapshotsA = new Map<string, DistributedTreeSnapshot>();
      for (const descriptor of AGENT_DESCRIPTORS) {
        snapshotsA.set(
          descriptor.id,
          readDistributedTree(join(projectDir, descriptor.skillsPath)),
        );
      }

      // Sanity: every destination has v1 bytes of the SKILL.md we'll edit.
      const expectedV1Sha = sourceV1.entries
        .flatMap((e) => e.files)
        .find((f) => f.relPath === "artgraph-impact/SKILL.md")!.sha256;
      for (const descriptor of AGENT_DESCRIPTORS) {
        const snap = snapshotsA.get(descriptor.id)!;
        expect(snap.sha256["artgraph-impact/SKILL.md"]).toBe(expectedV1Sha);
      }

      // (2) Mutate ONE byte (well, append a marker line) in the source.
      const editedBody = `${initialImpactBody}// v2 marker\n`;
      writeFileSync(skillImpactPath, editedBody, "utf-8");

      // (3) Re-read source (new sha256s) and re-distribute with --force to
      // every Tier 1 agent.
      const sourceV2 = readSkillSource(sourceDir);
      const expectedV2Sha = sourceV2.entries
        .flatMap((e) => e.files)
        .find((f) => f.relPath === "artgraph-impact/SKILL.md")!.sha256;
      // sanity — v2 must differ from v1 (otherwise the test setup is wrong)
      expect(expectedV2Sha).not.toBe(expectedV1Sha);

      for (const descriptor of AGENT_DESCRIPTORS) {
        const result = distribute(descriptor, sourceV2, {
          rootDir: projectDir,
          force: true,
        });
        // Exactly one file (the edited SKILL.md) should be in writtenPaths;
        // the rest stay no-op since their sha256 still matches.
        expect(
          result.writtenPaths.length,
          `agent=${descriptor.id} expected exactly 1 write (the edited file), got ${result.writtenPaths.length}`,
        ).toBe(1);
        expect(result.writtenPaths[0]).toBe(
          join(projectDir, descriptor.skillsPath, "artgraph-impact", "SKILL.md"),
        );
      }

      // (4) Snapshot B per agent — should reflect v2 bytes everywhere.
      for (const descriptor of AGENT_DESCRIPTORS) {
        const distRoot = join(projectDir, descriptor.skillsPath);
        const snapB = readDistributedTree(distRoot);
        const snapA = snapshotsA.get(descriptor.id)!;

        // The edited file sha changed AND matches v2 canonical.
        expect(snapB.sha256["artgraph-impact/SKILL.md"]).toBe(expectedV2Sha);
        expect(snapB.sha256["artgraph-impact/SKILL.md"]).not.toBe(
          snapA.sha256["artgraph-impact/SKILL.md"],
        );

        // On-disk bytes equal the new source bytes verbatim.
        const onDisk = readFileSync(
          join(distRoot, "artgraph-impact", "SKILL.md"),
          "utf-8",
        );
        expect(onDisk).toBe(editedBody);

        // Untouched files keep their v1 sha256 (no collateral rewrites).
        expect(snapB.sha256["artgraph-verify/SKILL.md"]).toBe(
          snapA.sha256["artgraph-verify/SKILL.md"],
        );
        expect(snapB.sha256["_shared/install-check.md"]).toBe(
          snapA.sha256["_shared/install-check.md"],
        );
      }

      // (5) All 5 destinations remain pairwise byte-equal after the edit
      // (canonical-single-truth invariant under edit).
      const ids = AGENT_DESCRIPTORS.map((d) => d.id);
      const snapsB = new Map<string, DistributedTreeSnapshot>();
      for (const descriptor of AGENT_DESCRIPTORS) {
        snapsB.set(
          descriptor.id,
          readDistributedTree(join(projectDir, descriptor.skillsPath)),
        );
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const diffs = diffSnapshots(
            snapsB.get(ids[i]!)!,
            snapsB.get(ids[j]!)!,
          );
          expect(
            diffs,
            `${ids[i]} vs ${ids[j]} post-edit diverged: ${diffs.join("; ")}`,
          ).toEqual([]);
        }
      }
    } finally {
      cleanupProject();
      cleanupSource();
    }
  });
});
