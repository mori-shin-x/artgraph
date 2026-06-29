// spec 013 T022 — unit tests for src/agents/agent-context.ts.
//
// Scope: pure marker-block utilities + AGENTS.md / wrapper writers. The
// init.ts wiring is exercised separately in T023 (E2E). These tests own the
// invariants used by US3 / SC-003:
//   - marker block parse / replace is byte-stable (idempotent)
//   - applyMarkerBlock preserves user content outside the block (FR-009/10)
//   - AGENTS.md body contains the 8 Skill names + workflows + quickstart
//   - wrappers contain `@AGENTS.md` literal AND a Markdown link AGENTS.md
//   - wrappers do NOT duplicate the AGENTS.md body (SC-003)
//   - copilot wrapper auto-creates `.github/` when missing

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  MARKER_BEGIN,
  MARKER_END,
  applyMarkerBlock,
  buildAgentsMdBody,
  buildClaudeWrapperBody,
  buildCopilotWrapperBody,
  inspectMarkerBlock,
  writeAgentsMd,
  writeWrapper,
} from "../src/agents/agent-context.js";
import { createFreshProject } from "./agents/helpers.js";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// ---------------------------------------------------------------------------
// applyMarkerBlock
// ---------------------------------------------------------------------------

describe("applyMarkerBlock (T018)", () => {
  it("appends a new block when input is empty (found=false)", () => {
    const res = applyMarkerBlock("", "hello body");
    expect(res.found).toBe(false);
    expect(res.newContent).toBe(`${MARKER_BEGIN}\nhello body\n${MARKER_END}\n`);
  });

  it("appends after existing content with a blank-line separator", () => {
    const existing = "# User content\n\nSome user prose.\n";
    const res = applyMarkerBlock(existing, "body");
    expect(res.found).toBe(false);
    expect(res.newContent).toBe(
      `${existing}\n\n${MARKER_BEGIN}\nbody\n${MARKER_END}\n`,
    );
    // User content survives byte-identical at the head.
    expect(res.newContent.startsWith(existing)).toBe(true);
  });

  it("replaces an existing block in place (found=true) and preserves surrounding text", () => {
    const existing =
      "# Heading\n\nUser prose before.\n\n" +
      `${MARKER_BEGIN}\nold body\n${MARKER_END}\n\n` +
      "User prose after.\n";
    const res = applyMarkerBlock(existing, "new body");
    expect(res.found).toBe(true);
    expect(res.newContent).toBe(
      "# Heading\n\nUser prose before.\n\n" +
        `${MARKER_BEGIN}\nnew body\n${MARKER_END}\n\n` +
        "User prose after.\n",
    );
    // The "User prose after." section MUST be byte-preserved.
    expect(res.newContent.endsWith("User prose after.\n")).toBe(true);
  });

  it("handles body content with blank lines, code fences and special chars", () => {
    const body =
      "Para 1.\n\n```bash\nartgraph init --agents=claude,codex\n```\n\nPara 2 with `code` & $vars.";
    const res = applyMarkerBlock("", body);
    expect(res.found).toBe(false);
    // Lazy match: end marker matches the first occurrence after the body.
    expect(res.newContent).toBe(`${MARKER_BEGIN}\n${body}\n${MARKER_END}\n`);
  });

  it("is idempotent: applying the same body twice produces identical content", () => {
    const first = applyMarkerBlock("", "stable body");
    const second = applyMarkerBlock(first.newContent, "stable body");
    expect(second.found).toBe(true);
    expect(second.newContent).toBe(first.newContent);
  });

  it("only replaces the first block when (somehow) two are present", () => {
    const dup =
      `${MARKER_BEGIN}\nfirst\n${MARKER_END}\n` +
      `${MARKER_BEGIN}\nsecond\n${MARKER_END}\n`;
    const res = applyMarkerBlock(dup, "replaced");
    expect(res.found).toBe(true);
    // Second block stays intact — doctor will flag the duplicate later.
    expect(res.newContent).toContain(`${MARKER_BEGIN}\nreplaced\n${MARKER_END}`);
    expect(res.newContent).toContain(`${MARKER_BEGIN}\nsecond\n${MARKER_END}`);
  });
});

// ---------------------------------------------------------------------------
// inspectMarkerBlock
// ---------------------------------------------------------------------------

describe("inspectMarkerBlock (T018)", () => {
  it("reports a matched pair and extracts the body for healthy input", () => {
    const content = `prelude\n\n${MARKER_BEGIN}\nbody line 1\nbody line 2\n${MARKER_END}\npostlude\n`;
    const r = inspectMarkerBlock(content);
    expect(r.hasBegin).toBe(true);
    expect(r.hasEnd).toBe(true);
    expect(r.hasMatchedPair).toBe(true);
    expect(r.bodyText).toBe("body line 1\nbody line 2");
  });

  it("reports begin-only with no matched pair", () => {
    const content = `prelude\n${MARKER_BEGIN}\nincomplete\n`;
    const r = inspectMarkerBlock(content);
    expect(r.hasBegin).toBe(true);
    expect(r.hasEnd).toBe(false);
    expect(r.hasMatchedPair).toBe(false);
    expect(r.bodyText).toBe(null);
  });

  it("reports end-only with no matched pair", () => {
    const content = `prelude\n${MARKER_END}\ntrailing\n`;
    const r = inspectMarkerBlock(content);
    expect(r.hasBegin).toBe(false);
    expect(r.hasEnd).toBe(true);
    expect(r.hasMatchedPair).toBe(false);
    expect(r.bodyText).toBe(null);
  });

  it("reports reversed-order markers as no matched pair", () => {
    const content = `${MARKER_END}\nstuff\n${MARKER_BEGIN}\n`;
    const r = inspectMarkerBlock(content);
    expect(r.hasBegin).toBe(true);
    expect(r.hasEnd).toBe(true);
    // end appears before begin → no valid block
    expect(r.hasMatchedPair).toBe(false);
    expect(r.bodyText).toBe(null);
  });

  it("reports no markers for empty / plain content", () => {
    const r = inspectMarkerBlock("# just a heading\n");
    expect(r.hasBegin).toBe(false);
    expect(r.hasEnd).toBe(false);
    expect(r.hasMatchedPair).toBe(false);
    expect(r.bodyText).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// buildAgentsMdBody
// ---------------------------------------------------------------------------

describe("buildAgentsMdBody (T019)", () => {
  it("contains all 8 Skill names from contracts/agent-context-format.md", () => {
    const body = buildAgentsMdBody();
    for (const skill of [
      "artgraph-setup",
      "artgraph-detect",
      "artgraph-integrate",
      "artgraph-impact",
      "artgraph-plan-coverage",
      "artgraph-coverage",
      "artgraph-verify",
      "artgraph-rename",
    ]) {
      expect(body, `missing Skill mention: ${skill}`).toContain(skill);
    }
  });

  it("contains common-workflows guidance and the quickstart code block", () => {
    const body = buildAgentsMdBody();
    expect(body).toContain("Common workflows");
    expect(body).toContain("Quickstart");
    expect(body).toContain("```bash");
    expect(body).toContain("artgraph init --agents=");
    expect(body).toContain("artgraph doctor");
  });

  it("contains the canonical repository link for human readers", () => {
    const body = buildAgentsMdBody();
    expect(body).toContain("https://github.com/ShintaroMorimoto/artgraph");
  });

  it("does not embed the marker literals (those are added by applyMarkerBlock)", () => {
    const body = buildAgentsMdBody();
    expect(body).not.toContain(MARKER_BEGIN);
    expect(body).not.toContain(MARKER_END);
  });
});

// ---------------------------------------------------------------------------
// writeAgentsMd
// ---------------------------------------------------------------------------

describe("writeAgentsMd (T019)", () => {
  it("creates AGENTS.md on a fresh project and writes the canonical body", () => {
    const project = createFreshProject();
    try {
      const res = writeAgentsMd(project.dir);
      expect(res.written).toBe(true);
      expect(res.path).toBe(resolve(project.dir, "AGENTS.md"));
      expect(existsSync(res.path)).toBe(true);

      const onDisk = readFileSync(res.path, "utf-8");
      expect(onDisk).toContain(MARKER_BEGIN);
      expect(onDisk).toContain(MARKER_END);
      // Body content present.
      expect(onDisk).toContain("artgraph-impact");
      expect(onDisk).toContain("artgraph-plan-coverage");
      expect(onDisk).toContain("Quickstart");
    } finally {
      project.cleanup();
    }
  });

  it("is idempotent on the second call (no rewrite, sha256 unchanged)", () => {
    const project = createFreshProject();
    try {
      const first = writeAgentsMd(project.dir);
      expect(first.written).toBe(true);
      const hash1 = sha256(first.path);

      const second = writeAgentsMd(project.dir);
      expect(second.written).toBe(false);
      expect(second.path).toBe(first.path);
      const hash2 = sha256(second.path);

      expect(hash2).toBe(hash1);
    } finally {
      project.cleanup();
    }
  });

  it("preserves pre-existing user content outside the marker block", () => {
    const project = createFreshProject();
    try {
      const target = resolve(project.dir, "AGENTS.md");
      const userContent = "# My project rules\n\nUse pnpm, not yarn.\n";
      writeFileSync(target, userContent, "utf-8");

      const res = writeAgentsMd(project.dir);
      expect(res.written).toBe(true);

      const onDisk = readFileSync(target, "utf-8");
      expect(onDisk.startsWith(userContent)).toBe(true);
      expect(onDisk).toContain(MARKER_BEGIN);
      expect(onDisk).toContain("artgraph-verify");
    } finally {
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// writeWrapper — claude
// ---------------------------------------------------------------------------

describe("writeWrapper(claude) (T020)", () => {
  it("creates CLAUDE.md with @AGENTS.md literal and ./AGENTS.md markdown link", () => {
    const project = createFreshProject();
    try {
      const res = writeWrapper(project.dir, "claude");
      expect(res.written).toBe(true);
      expect(res.path).toBe(resolve(project.dir, "CLAUDE.md"));
      expect(existsSync(res.path)).toBe(true);

      const onDisk = readFileSync(res.path, "utf-8");
      expect(onDisk).toContain(MARKER_BEGIN);
      expect(onDisk).toContain(MARKER_END);
      expect(onDisk).toContain("@AGENTS.md");
      expect(onDisk).toContain("[AGENTS.md](./AGENTS.md)");
    } finally {
      project.cleanup();
    }
  });

  it("body length is far shorter than AGENTS.md body (SC-003: no content duplication)", () => {
    const wrapper = buildClaudeWrapperBody();
    const canonical = buildAgentsMdBody();
    expect(wrapper.length).toBeLessThan(canonical.length / 4);
    // Sanity ceiling — wrapper is a few short lines, not a chapter.
    expect(wrapper.length).toBeLessThan(300);
  });

  it("is idempotent on the second call", () => {
    const project = createFreshProject();
    try {
      const first = writeWrapper(project.dir, "claude");
      expect(first.written).toBe(true);
      const hash1 = sha256(first.path);

      const second = writeWrapper(project.dir, "claude");
      expect(second.written).toBe(false);
      expect(sha256(second.path)).toBe(hash1);
    } finally {
      project.cleanup();
    }
  });

  it("preserves user-authored sections in an existing CLAUDE.md", () => {
    const project = createFreshProject();
    try {
      const target = resolve(project.dir, "CLAUDE.md");
      const userContent =
        "# Project: my-app\n\n## House style\n\n- Two-space indent.\n- Use `pnpm`.\n";
      writeFileSync(target, userContent, "utf-8");

      const res = writeWrapper(project.dir, "claude");
      expect(res.written).toBe(true);

      const onDisk = readFileSync(target, "utf-8");
      // User content head-anchored.
      expect(onDisk.startsWith(userContent)).toBe(true);
      // Marker block appended after.
      expect(onDisk).toContain(MARKER_BEGIN);
      expect(onDisk).toContain("@AGENTS.md");
    } finally {
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// writeWrapper — copilot
// ---------------------------------------------------------------------------

describe("writeWrapper(copilot) (T020)", () => {
  it("creates .github/copilot-instructions.md and its parent dir if missing", () => {
    const project = createFreshProject();
    try {
      expect(existsSync(join(project.dir, ".github"))).toBe(false);

      const res = writeWrapper(project.dir, "copilot");
      expect(res.written).toBe(true);
      expect(res.path).toBe(
        resolve(project.dir, ".github/copilot-instructions.md"),
      );
      expect(existsSync(res.path)).toBe(true);
      expect(statSync(join(project.dir, ".github")).isDirectory()).toBe(true);

      const onDisk = readFileSync(res.path, "utf-8");
      expect(onDisk).toContain(MARKER_BEGIN);
      expect(onDisk).toContain("@AGENTS.md");
      // Relative link is ../AGENTS.md from .github/.
      expect(onDisk).toContain("[AGENTS.md](../AGENTS.md)");
    } finally {
      project.cleanup();
    }
  });

  it("body length is far shorter than AGENTS.md body (SC-003)", () => {
    const wrapper = buildCopilotWrapperBody();
    const canonical = buildAgentsMdBody();
    expect(wrapper.length).toBeLessThan(canonical.length / 4);
    expect(wrapper.length).toBeLessThan(300);
  });

  it("does not recreate or destroy an existing .github/ directory", () => {
    const project = createFreshProject();
    try {
      const ghDir = join(project.dir, ".github");
      mkdirSync(ghDir, { recursive: true });
      // Drop a sentinel so we can verify nothing in .github/ is wiped.
      const sentinelPath = join(ghDir, "workflow-config.yml");
      writeFileSync(sentinelPath, "name: ci\n", "utf-8");
      const sentinelHash = sha256(sentinelPath);

      const res = writeWrapper(project.dir, "copilot");
      expect(res.written).toBe(true);
      expect(existsSync(sentinelPath)).toBe(true);
      expect(sha256(sentinelPath)).toBe(sentinelHash);
    } finally {
      project.cleanup();
    }
  });

  it("is idempotent on the second call", () => {
    const project = createFreshProject();
    try {
      const first = writeWrapper(project.dir, "copilot");
      const hash1 = sha256(first.path);

      const second = writeWrapper(project.dir, "copilot");
      expect(second.written).toBe(false);
      expect(sha256(second.path)).toBe(hash1);
    } finally {
      project.cleanup();
    }
  });
});
