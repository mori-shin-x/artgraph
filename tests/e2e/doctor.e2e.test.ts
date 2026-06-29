// spec 013 T030 [US4] — E2E tests for `artgraph doctor`.
//
// Spawns the built `dist/cli.js` against tmp projects so commander wiring,
// process.exit semantics, and `--format text|json` rendering are all
// exercised end-to-end. Mirrors the six scenarios from
// `specs/013-cross-agent-extensions/quickstart.md §3-1 〜 §3-6`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createFreshProject } from "../agents/helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");

function runCli(cwd: string, args: string[]) {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  });
}

function initProject(cwd: string, agents: string) {
  const r = runCli(cwd, ["init", `--agents=${agents}`, "--no-scan", "--force"]);
  if (r.status !== 0) {
    throw new Error(`init failed: exit=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
  }
}

describe("e2e: artgraph doctor — healthy project", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, "claude,codex");
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("quickstart §3-1: exit 0 + Summary mentions 0 fail (text)", () => {
    const r = runCli(proj.dir, ["doctor"]);
    expect(r.status, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    expect(r.stdout).toContain("artgraph doctor");
    expect(r.stdout).toMatch(/0 fail/);
    expect(r.stdout).toContain("[claude]");
    expect(r.stdout).toContain("[codex]");
  });

  it("quickstart §3-2: --format json yields a valid summary", () => {
    const r = runCli(proj.dir, ["doctor", "--format", "json"]);
    expect(r.status, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.summary.failCount).toBe(0);
    expect(parsed.summary.passCount).toBeGreaterThan(0);
    expect(parsed.summary.agents).toEqual(["claude", "codex"]);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});

describe("e2e: artgraph doctor — drift / FAIL detection", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
    initProject(proj.dir, "claude,codex");
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("quickstart §3-3: SKILL.md drift → exit 1 + skill-file-drift in output", () => {
    appendFileSync(
      join(proj.dir, ".agents/skills/artgraph-verify/SKILL.md"),
      "\n// tampered\n",
      "utf-8",
    );
    const r = runCli(proj.dir, ["doctor"]);
    expect(r.status, `stdout: ${r.stdout}`).toBe(1);
    expect(r.stdout).toContain("skill-file-drift");
  });

  it("quickstart §3-3 (JSON): drift surfaces in findings with expected/actual sha256", () => {
    appendFileSync(
      join(proj.dir, ".agents/skills/artgraph-verify/SKILL.md"),
      "\n// tampered\n",
      "utf-8",
    );
    const r = runCli(proj.dir, ["doctor", "--format", "json"]);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    const drift = parsed.findings.find(
      (f: { kind: string }) => f.kind === "skill-file-drift",
    );
    expect(drift).toBeDefined();
    expect(drift.path).toContain(".agents/skills/artgraph-verify/SKILL.md");
    expect(drift.expected).toMatch(/^[0-9a-f]{64}$/);
    expect(drift.actual).toMatch(/^[0-9a-f]{64}$/);
  });

  it("quickstart §3-4: removing @AGENTS.md from CLAUDE.md → wrapper-no-import + exit 1", () => {
    const claudeMd = join(proj.dir, "CLAUDE.md");
    const body = readFileSync(claudeMd, "utf-8");
    const stripped = body
      .split("\n")
      .filter((l) => l.trim() !== "@AGENTS.md")
      .join("\n");
    writeFileSync(claudeMd, stripped, "utf-8");
    const r = runCli(proj.dir, ["doctor"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("wrapper-no-import");
  });

  it("quickstart §3-6: extraneous file → exit 1 + extraneous-file finding", () => {
    const obsoleteDir = join(proj.dir, ".claude/skills/artgraph-old");
    mkdirSync(obsoleteDir, { recursive: true });
    writeFileSync(join(obsoleteDir, "SKILL.md"), "obsolete\n", "utf-8");
    const r = runCli(proj.dir, ["doctor"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("extraneous-file");
  });
});

describe("e2e: artgraph doctor — empty project", () => {
  let proj: ReturnType<typeof createFreshProject>;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  it("quickstart §3-5: no distribution → exit 0 + 'No Tier 1 distribution detected'", () => {
    const r = runCli(proj.dir, ["doctor"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No Tier 1 distribution detected");
    // No .artgraph.json side effect (doctor is read-only).
    expect(existsSync(join(proj.dir, ".artgraph.json"))).toBe(false);
  });
});
