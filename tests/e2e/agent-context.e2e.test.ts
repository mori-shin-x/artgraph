// spec 013 T023 [US3] — E2E tests for the agent-context stage.
//
// Asserts the four key invariants from `specs/013-cross-agent-extensions/spec.md`
// US3 + quickstart §1-2 / §1-5:
//   - AGENTS.md carries the canonical artgraph body (9 Skill names, marker
//     block intact) — SC-003 "no body duplication in wrappers".
//   - CLAUDE.md is a thin wrapper: `@AGENTS.md` import literal + relative
//     link, no copy of the AGENTS.md body.
//   - .github/copilot-instructions.md is the same shape with a `../AGENTS.md`
//     relative link (R6 — the wrapper lives one dir below the repo root).
//   - Idempotent re-run: sha256 of AGENTS.md / CLAUDE.md unchanged.
//   - User-authored content outside the marker block is preserved verbatim
//     (FR-009 / FR-010).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFreshProject } from "../agents/helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");

// Repeat across tests so a single failing assertion doesn't snowball into the
// rest (each block scopes its own fixture / init).
function runInit(cwd: string, args: string[]) {
  return spawnSync("node", [CLI, "init", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const SKILL_NAMES = [
  "artgraph-setup",
  "artgraph-bootstrap",
  "artgraph-impact",
  "artgraph-plan-coverage",
  "artgraph-verify",
  "artgraph-rename",
] as const;

describe("e2e: artgraph init --agents=claude,copilot agent-context", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeAll(() => {
    proj = createFreshProject();
    const r = runInit(proj.dir, ["--agents=claude,copilot", "--no-scan", "--force"]);
    if (r.status !== 0) {
      throw new Error(`init failed: exit=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
    }
  });

  afterAll(() => {
    proj.cleanup();
  });

  it("AGENTS.md carries the artgraph body (marker block + 6 Skill names)", () => {
    const body = readFileSync(join(proj.dir, "AGENTS.md"), "utf-8");
    expect(body).toContain("<!-- artgraph:begin -->");
    expect(body).toContain("<!-- artgraph:end -->");
    for (const name of SKILL_NAMES) {
      expect(body, `AGENTS.md missing Skill name ${name}`).toContain(name);
    }
  });

  it("CLAUDE.md is a thin wrapper with @AGENTS.md import (no body duplication)", () => {
    const body = readFileSync(join(proj.dir, "CLAUDE.md"), "utf-8");
    expect(body).toContain("<!-- artgraph:begin -->");
    expect(body).toContain("<!-- artgraph:end -->");
    expect(body).toContain("@AGENTS.md");
    // Repo-root relative link (R6).
    expect(body).toContain("./AGENTS.md");
    // SC-003: the wrapper MUST NOT duplicate the AGENTS.md body. We cap the
    // total file size as a proxy — the canonical body is several hundred
    // bytes; a wrapper under 300 bytes cannot have copied it.
    expect(body.length).toBeLessThan(300);
  });

  it(".github/copilot-instructions.md is a thin wrapper with ../AGENTS.md link", () => {
    const path = join(proj.dir, ".github", "copilot-instructions.md");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf-8");
    expect(body).toContain("<!-- artgraph:begin -->");
    expect(body).toContain("<!-- artgraph:end -->");
    expect(body).toContain("@AGENTS.md");
    expect(body).toContain("../AGENTS.md");
    expect(body.length).toBeLessThan(300);
  });
});

describe("e2e: agent-context idempotency + user content preservation", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeAll(() => {
    proj = createFreshProject();
    const r1 = runInit(proj.dir, ["--agents=claude", "--no-scan", "--force"]);
    if (r1.status !== 0) {
      throw new Error(`init #1 failed: exit=${r1.status} stderr=${r1.stderr}`);
    }
  });

  afterAll(() => {
    proj.cleanup();
  });

  it("second `init --agents=claude` leaves AGENTS.md / CLAUDE.md sha256 unchanged", () => {
    const agentsBefore = sha256(join(proj.dir, "AGENTS.md"));
    const claudeBefore = sha256(join(proj.dir, "CLAUDE.md"));

    const r2 = runInit(proj.dir, ["--agents=claude", "--no-scan", "--force"]);
    expect(r2.status, `stderr: ${r2.stderr}`).toBe(0);

    expect(sha256(join(proj.dir, "AGENTS.md"))).toBe(agentsBefore);
    expect(sha256(join(proj.dir, "CLAUDE.md"))).toBe(claudeBefore);
  });

  it("user content appended OUTSIDE the marker block is preserved on re-init", () => {
    // Append a user paragraph after the artgraph block. The marker-aware
    // writer must touch only the block, leaving everything before/after intact.
    const claudeMd = join(proj.dir, "CLAUDE.md");
    const userParagraph = "\n\n## User custom\n\nHand-authored content the agent must remember.\n";
    appendFileSync(claudeMd, userParagraph, "utf-8");

    const r = runInit(proj.dir, ["--agents=claude", "--no-scan", "--force"]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const after = readFileSync(claudeMd, "utf-8");
    expect(after).toContain("## User custom");
    expect(after).toContain("Hand-authored content the agent must remember.");
    // The artgraph block must still be present (and intact).
    expect(after).toContain("<!-- artgraph:begin -->");
    expect(after).toContain("<!-- artgraph:end -->");
    expect(after).toContain("@AGENTS.md");
  });

  it("user content PREPENDED before the marker block is also preserved", () => {
    // Worst case: replace the file with user content + marker block placed
    // *after* a user header. The writer must replace only inside the markers.
    const claudeMd = join(proj.dir, "CLAUDE.md");
    const original = readFileSync(claudeMd, "utf-8");
    const userHeader = "# My project guide\n\nThis line MUST survive init.\n\n";
    writeFileSync(claudeMd, userHeader + original, "utf-8");

    const r = runInit(proj.dir, ["--agents=claude", "--no-scan", "--force"]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const after = readFileSync(claudeMd, "utf-8");
    expect(after.startsWith("# My project guide")).toBe(true);
    expect(after).toContain("This line MUST survive init.");
    expect(after).toContain("<!-- artgraph:begin -->");
    expect(after).toContain("@AGENTS.md");
  });
});
