// spec 013 T012 [US1] — E2E tests for `artgraph init --agents=<one|many>`.
//
// These tests spawn the real built `dist/cli.js` against fresh tmp projects.
// They are the canonical proof that the spec 013 Skills distribution + agent-
// context wiring lands the right files at the right canonical paths for every
// Tier 1 agent. Quickstart §1-1 and §1-2 (`specs/013-cross-agent-extensions/
// quickstart.md`) drive the per-agent + 5-agent matrix here.
//
// Why E2E rather than unit:
//   - `distribute()` is unit-tested in tests/agents/distribute.test.ts; here
//     we exercise the wiring through `runInit` + commander argv parsing so a
//     regression in `--agents=<csv>` plumbing (orthogonality, validation, gate
//     gating) cannot slip past.
//   - The test compares the full `<skillsPath>/...` tree against the canonical
//     `templates/skills/` byte-for-byte via the helpers used by every unit
//     suite, so a partial copy or wrong destination shows up as a diff in the
//     test report rather than as a silent missing-file regression.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_DESCRIPTORS,
  DISTRIBUTED_AGENT_DESCRIPTORS,
  type AgentId,
} from "../../src/agents/descriptors.js";
import { createFreshProject, readDistributedTree } from "../agents/helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");
const TEMPLATES_DIR = resolve(REPO_ROOT, "templates/skills");

function runInit(cwd: string, args: string[]) {
  // 30s timeout per init — even on a cold-cache scan a single-agent init
  // finishes well under 10s on the CI image; the cushion is for the 5-agent
  // matrix below.
  return spawnSync("node", [CLI, "init", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  });
}

describe("e2e: artgraph init --agents=<single>", () => {
  // Run each distributing Tier 1 agent in a fresh tmp dir. The test asserts:
  //   1. exit 0
  //   2. <skillsPath>/artgraph-impact/SKILL.md exists at the expected canonical path
  //   3. <skillsPath>/_shared/install-check.md exists (R1 shared fragment travels)
  //   4. AGENTS.md exists and contains the artgraph marker block (US3 stage
  //      runs by default; verified more thoroughly in agent-context.e2e.test.ts)
  //   5. CLAUDE.md / .github/copilot-instructions.md wrapper presence
  //      matches the descriptor (only claude / copilot agents get wrappers)
  // issue #130 — Copilot has `skillsPath: null` (no on-disk Skills), so
  // it's covered by a dedicated block below rather than this per-Skills
  // matrix.
  for (const descriptor of DISTRIBUTED_AGENT_DESCRIPTORS) {
    const skillsPath = descriptor.skillsPath as string;
    describe(`agent=${descriptor.id}`, () => {
      let proj: ReturnType<typeof createFreshProject>;

      beforeEach(() => {
        proj = createFreshProject();
      });

      afterEach(() => {
        proj.cleanup();
      });

      it(`lands canonical Skills at ${skillsPath}/ and emits AGENTS.md`, () => {
        const r = runInit(proj.dir, [`--agents=${descriptor.id}`, "--no-scan"]);
        expect(r.status, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);

        // (2) one representative SKILL.md
        const skillMd = join(proj.dir, skillsPath, "artgraph-impact", "SKILL.md");
        expect(existsSync(skillMd), `missing: ${skillMd}`).toBe(true);

        // (3) _shared fragment (R1)
        const sharedMd = join(proj.dir, skillsPath, "_shared", "install-check.md");
        expect(existsSync(sharedMd), `missing: ${sharedMd}`).toBe(true);

        // (4) AGENTS.md with marker block
        const agentsMd = join(proj.dir, "AGENTS.md");
        expect(existsSync(agentsMd)).toBe(true);
        const agentsBody = readFileSync(agentsMd, "utf-8");
        expect(agentsBody).toContain("<!-- artgraph:begin -->");
        expect(agentsBody).toContain("<!-- artgraph:end -->");

        // (5) wrapper presence — only claude has a wrapper among the
        // distributing agents (Copilot's wrapper is exercised in its
        // own describe block below).
        const claudeMd = join(proj.dir, "CLAUDE.md");
        expect(existsSync(claudeMd)).toBe(descriptor.id === "claude");
      });

      it(`distributed Skills tree byte-matches templates/skills/`, () => {
        const r = runInit(proj.dir, [`--agents=${descriptor.id}`, "--no-scan"]);
        expect(r.status, `stderr: ${r.stderr}`).toBe(0);

        const canonical = readDistributedTree(TEMPLATES_DIR);
        const distributed = readDistributedTree(join(proj.dir, skillsPath));
        // Every canonical path must appear at the destination with matching
        // sha256. The destination MAY have extra paths from a future test that
        // adds bookkeeping files, so we assert containment rather than equality.
        for (const relPath of canonical.paths) {
          expect(
            distributed.sha256[relPath],
            `missing or mismatched: ${skillsPath}/${relPath}`,
          ).toBe(canonical.sha256[relPath]);
        }
      });
    });
  }

  // issue #130 — Copilot never receives on-disk Skills. `--agents=copilot`
  // still writes AGENTS.md and `.github/copilot-instructions.md`, and does
  // NOT create `.github/skills/`.
  describe("agent=copilot (issue #130 — no Skills distribution)", () => {
    let proj: ReturnType<typeof createFreshProject>;

    beforeEach(() => {
      proj = createFreshProject();
    });

    afterEach(() => {
      proj.cleanup();
    });

    it("writes the copilot wrapper + AGENTS.md but does NOT create .github/skills/", () => {
      const r = runInit(proj.dir, ["--agents=copilot", "--no-scan"]);
      expect(r.status, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);

      // Wrapper + AGENTS.md are present, but no on-disk Skills.
      expect(existsSync(join(proj.dir, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(proj.dir, ".github", "copilot-instructions.md"))).toBe(true);
      expect(existsSync(join(proj.dir, ".github", "skills"))).toBe(false);
    });
  });
});

describe("e2e: artgraph init --agents=claude,codex,cursor,copilot,kiro --force", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeAll(() => {
    proj = createFreshProject();
    const r = runInit(proj.dir, [
      "--agents=claude,codex,cursor,copilot,kiro",
      "--no-scan",
      "--force",
    ]);
    if (r.status !== 0) {
      throw new Error(`init failed: exit=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
    }
  });

  afterAll(() => {
    proj.cleanup();
  });

  it("populates every distributing Tier 1 canonical Skills path", () => {
    // issue #130 — Copilot's `skillsPath` is null so it is excluded.
    // The absence of `.github/skills/` is asserted separately below.
    for (const descriptor of DISTRIBUTED_AGENT_DESCRIPTORS) {
      const skillMd = join(
        proj.dir,
        descriptor.skillsPath as string,
        "artgraph-impact",
        "SKILL.md",
      );
      expect(existsSync(skillMd), `missing: ${skillMd}`).toBe(true);
    }
    // Copilot must never receive an on-disk Skills tree (issue #130).
    expect(existsSync(join(proj.dir, ".github", "skills"))).toBe(false);
  });

  it("all distributed trees are byte-identical (diff -rq zero)", () => {
    // Use claude as the reference: every other DISTRIBUTING agent's tree
    // MUST equal it file-for-file with matching sha256. Copilot (issue
    // #130) is excluded — it has no tree to compare.
    const ref = readDistributedTree(join(proj.dir, ".claude", "skills"));
    expect(ref.paths.length).toBeGreaterThan(0);

    for (const descriptor of DISTRIBUTED_AGENT_DESCRIPTORS) {
      if (descriptor.id === "claude") continue;
      const skillsPath = descriptor.skillsPath as string;
      const t = readDistributedTree(join(proj.dir, skillsPath));
      expect(t.paths, `path set differs at ${skillsPath}`).toEqual(ref.paths);
      for (const p of ref.paths) {
        expect(t.sha256[p], `sha256 differs for ${skillsPath}/${p}`).toBe(ref.sha256[p]);
      }
    }
  });

  it("AGENTS.md is written once with the artgraph marker block", () => {
    const body = readFileSync(join(proj.dir, "AGENTS.md"), "utf-8");
    expect(body).toContain("<!-- artgraph:begin -->");
    expect(body).toContain("<!-- artgraph:end -->");
    // Exactly one begin marker — idempotent merge MUST NOT duplicate.
    const matches = body.match(/<!--\s*artgraph:begin\s*-->/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("emits exactly two wrappers (claude + copilot), no codex / cursor / kiro wrappers", () => {
    expect(existsSync(join(proj.dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(proj.dir, ".github", "copilot-instructions.md"))).toBe(true);
    // No stray wrappers for the 3 native-AGENTS.md agents.
    expect(existsSync(join(proj.dir, ".cursor", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(proj.dir, ".agents", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(proj.dir, ".kiro", "AGENTS.md"))).toBe(false);
  });

  it("(issue #130) does not create .github/skills/ even when --agents includes copilot", () => {
    // Copilot's skillsPath is null; init MUST NOT provision `.github/skills/`
    // as a side effect of selecting Copilot alongside other agents.
    expect(existsSync(join(proj.dir, ".github", "skills"))).toBe(false);
  });
});

describe("e2e: artgraph init --agents validation errors", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("rejects init without --agents and lists 3 corrective options", () => {
    const r = runInit(proj.dir, ["--no-scan"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ERROR: --agents=<list> is required");
    expect(r.stderr).toContain("Supported values: claude, codex, copilot, cursor, kiro");
    expect(r.stderr).toMatch(/1\.\s+Specify target agents/);
    expect(r.stderr).toMatch(/2\.\s+Skip Skills and agent-context distribution/);
    expect(r.stderr).toMatch(/3\.\s+Skip every extra setup stage/);
    // No .artgraph.json should be written when validation fails.
    expect(existsSync(join(proj.dir, ".artgraph.json"))).toBe(false);
  });

  it("rejects an unknown agent id and lists the supported values", () => {
    const r = runInit(proj.dir, ["--agents=windsurf", "--no-scan"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("windsurf");
    expect(r.stderr).toContain("claude");
  });
});
