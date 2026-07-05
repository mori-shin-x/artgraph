// spec 013 T022 — unit tests for src/agents/agent-context.ts.
//
// Scope: pure marker-block utilities + AGENTS.md / wrapper writers. The
// init.ts wiring is exercised separately in T023 (E2E). These tests own the
// invariants used by US3 / SC-003:
//   - marker block parse / replace is byte-stable (idempotent)
//   - applyMarkerBlock preserves user content outside the block (FR-009/10)
//   - AGENTS.md body contains the 9 Skill names + workflows + quickstart
//   - wrappers contain `@AGENTS.md` literal AND a Markdown link AGENTS.md
//   - wrappers do NOT duplicate the AGENTS.md body (SC-003)
//   - copilot wrapper auto-creates `.github/` when missing

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  MARKER_BEGIN,
  MARKER_END,
  MarkerBlockCorruptError,
  applyMarkerBlock,
  buildAgentsMdBody,
  buildClaudeWrapperBody,
  buildCopilotWrapperBody,
  inspectMarkerBlock,
  writeAgentsMd,
  writeGitAttributes,
  writeWrapper,
} from "../src/agents/agent-context.js";
import { DISTRIBUTED_AGENT_DESCRIPTORS, findDescriptor } from "../src/agents/descriptors.js";
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
    expect(res.newContent).toBe(`${existing}\n\n${MARKER_BEGIN}\nbody\n${MARKER_END}\n`);
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

  it("collapses duplicate blocks to a single canonical block (A2)", () => {
    const dup =
      `${MARKER_BEGIN}\nfirst\n${MARKER_END}\n\n` + `${MARKER_BEGIN}\nsecond\n${MARKER_END}\n`;
    const res = applyMarkerBlock(dup, "replaced");
    expect(res.found).toBe(true);
    // The first block is rewritten canonically; every subsequent duplicate
    // is removed so we end up with a single artgraph block on disk.
    expect(res.newContent).toContain(`${MARKER_BEGIN}\nreplaced\n${MARKER_END}`);
    expect(res.newContent).not.toContain("second");
    const beginCount = (res.newContent.match(/<!--\s*artgraph:begin\s*-->/gi) || []).length;
    const endCount = (res.newContent.match(/<!--\s*artgraph:end\s*-->/gi) || []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("preserves user prose between duplicate blocks when collapsing (A2)", () => {
    const dup =
      `${MARKER_BEGIN}\nfirst\n${MARKER_END}\n\n` +
      "user prose between blocks\n\n" +
      `${MARKER_BEGIN}\nsecond\n${MARKER_END}\n`;
    const res = applyMarkerBlock(dup, "replaced");
    expect(res.found).toBe(true);
    expect(res.newContent).toContain("user prose between blocks");
    expect(res.newContent).toContain(`${MARKER_BEGIN}\nreplaced\n${MARKER_END}`);
    expect(res.newContent).not.toContain("second");
  });

  it("does not treat inline (non-line-anchored) marker text as a real block (A1)", () => {
    // Marker string appears mid-line in prose. The line-anchored regex must
    // NOT match, so the writer falls through to the append path — no user
    // text is silently absorbed between the pseudo-marker and any later
    // real marker.
    const existing =
      "Docs: the literal `<!-- artgraph:begin -->` marker is used " +
      "and `<!-- artgraph:end -->` closes it. Do not touch.\n";
    const res = applyMarkerBlock(existing, "body");
    expect(res.found).toBe(false);
    // Original prose survives byte-identical at the head.
    expect(res.newContent.startsWith(existing)).toBe(true);
    // Canonical block appended at EOF.
    expect(res.newContent).toContain(`${MARKER_BEGIN}\nbody\n${MARKER_END}`);
  });

  it("does not treat indented marker text (e.g. inside a nested list) as a real block (A1)", () => {
    const existing = "- item\n    <!-- artgraph:begin --> inside a list\n";
    const res = applyMarkerBlock(existing, "body");
    // Indented marker is not line-anchored → not detected. Nor is it a bare
    // stray marker per BEGIN_RE, so append succeeds.
    expect(res.found).toBe(false);
    expect(res.newContent).toContain(`${MARKER_BEGIN}\nbody\n${MARKER_END}`);
  });

  it("throws MarkerBlockCorruptError on stray begin without matching end (A3)", () => {
    const stray = `# heading\n${MARKER_BEGIN}\nno closer here\n`;
    expect(() => applyMarkerBlock(stray, "body")).toThrow(MarkerBlockCorruptError);
    expect(() => applyMarkerBlock(stray, "body")).toThrow(/marker block is corrupt/i);
  });

  it("throws MarkerBlockCorruptError on stray end without matching begin (A3)", () => {
    const stray = `# heading\n${MARKER_END}\ntrailing prose\n`;
    expect(() => applyMarkerBlock(stray, "body")).toThrow(MarkerBlockCorruptError);
  });

  it("throws MarkerBlockCorruptError on reversed-order markers (A3)", () => {
    const reversed = `${MARKER_END}\nstuff\n${MARKER_BEGIN}\n`;
    expect(() => applyMarkerBlock(reversed, "body")).toThrow(MarkerBlockCorruptError);
  });

  it("self-heals mixed-case marker input via the case-insensitive regex (OPS-9)", () => {
    // IDE autocorrect (Grammarly, macOS "smart capitalization") title-cases
    // the marker string. The `i` flag on MARKER_RE / BEGIN_RE / END_RE keeps
    // the block detectable, and the writer normalizes it back to lowercase.
    const shouted = "<!-- artgraph:Begin -->\nold body\n<!-- artgraph:END -->\n";
    const res = applyMarkerBlock(shouted, "canonical body");
    expect(res.found).toBe(true);
    expect(res.newContent).toContain(`${MARKER_BEGIN}\ncanonical body\n${MARKER_END}`);
    // The uppercase / title-case variants are gone after normalization.
    expect(res.newContent).not.toContain("artgraph:Begin");
    expect(res.newContent).not.toContain("artgraph:END");
  });

  it("treats whitespace-only existing content as empty (BND-6)", () => {
    const res = applyMarkerBlock("\n", "body");
    expect(res.found).toBe(false);
    // No leading blank lines; the file starts with the canonical block.
    expect(res.newContent).toBe(`${MARKER_BEGIN}\nbody\n${MARKER_END}\n`);
    // Sanity: check the multi-whitespace variant, too.
    const res2 = applyMarkerBlock("   \n \t\n", "body");
    expect(res2.newContent).toBe(`${MARKER_BEGIN}\nbody\n${MARKER_END}\n`);
  });

  it("round-trips CRLF-quoted markers on read → same body extraction (BND-5)", () => {
    // Simulated Windows checkout: the marker file uses CRLF line endings.
    const crlf =
      "<!-- artgraph:begin -->\r\nbody line 1\r\nbody line 2\r\n<!-- artgraph:end -->\r\n";
    const health = inspectMarkerBlock(crlf);
    expect(health.hasMatchedPair).toBe(true);
    // No stray `\r` at head/tail of the extracted body.
    expect(health.bodyText).toBe("body line 1\r\nbody line 2");
    expect(health.bodyText?.startsWith("\r")).toBe(false);
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
  it("contains all 9 Skill names from contracts/agent-context-format.md", () => {
    const body = buildAgentsMdBody("npm");
    for (const skill of [
      "artgraph-setup",
      "artgraph-bootstrap",
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
    const body = buildAgentsMdBody("npm");
    expect(body).toContain("Common workflows");
    expect(body).toContain("Quickstart");
    expect(body).toContain("```bash");
    expect(body).toContain("artgraph init --agents=");
    expect(body).toContain("artgraph doctor");
  });

  it("contains the canonical repository link for human readers", () => {
    const body = buildAgentsMdBody("npm");
    expect(body).toContain("https://github.com/ShintaroMorimoto/artgraph");
  });

  it("does not embed the marker literals (those are added by applyMarkerBlock)", () => {
    const body = buildAgentsMdBody("npm");
    expect(body).not.toContain(MARKER_BEGIN);
    expect(body).not.toContain(MARKER_END);
  });
});

// ---------------------------------------------------------------------------
// buildAgentsMdBody — PM-independent command examples (#110)
// ---------------------------------------------------------------------------

describe("buildAgentsMdBody — PM exec-prefix substitution (#110)", () => {
  // Keep in sync with execPrefix() in src/package-manager.ts (contracts/
  // package-manager.md §2). The body must quote each PM's real invocation, not
  // the bare `artgraph` binary that only exists under a global install.
  const EXPECTED_PREFIX = {
    npm: "npx artgraph",
    pnpm: "pnpm exec artgraph",
    bun: "bunx artgraph",
    deno: "deno run -A npm:artgraph/cli",
  } as const;

  for (const [pm, prefix] of Object.entries(EXPECTED_PREFIX)) {
    it(`renders every command example with the ${pm} exec prefix`, () => {
      const body = buildAgentsMdBody(pm as keyof typeof EXPECTED_PREFIX);
      expect(body).toContain(`${prefix} init --agents=`);
      expect(body).toContain(`${prefix} doctor`);
      expect(body).toContain(`${prefix} check --diff`);
      expect(body).toContain(`${prefix} --help`);
    });

    it(`renders the ${pm} PM notice with the regenerate hint`, () => {
      const body = buildAgentsMdBody(pm as keyof typeof EXPECTED_PREFIX);
      expect(body).toContain(`packageManager=${pm}`);
      expect(body).toContain(`${prefix} init --force`);
    });
  }

  it("falls back to the bare `artgraph` binary when no PM was detected", () => {
    const body = buildAgentsMdBody(null);
    expect(body).toContain("artgraph init --agents=");
    expect(body).toContain("no package manager was detected");
    expect(body).not.toContain("npx");
    expect(body).not.toContain("pnpm exec");
  });

  it("leaves no unrendered {{…}} placeholders for any PM", () => {
    for (const pm of ["npm", "pnpm", "bun", "deno", null] as const) {
      const body = buildAgentsMdBody(pm);
      expect(body, `unrendered placeholder for pm=${String(pm)}`).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });

  it("opens with the PM notice as an HTML comment (invisible in rendered Markdown)", () => {
    const body = buildAgentsMdBody("pnpm");
    expect(body.startsWith("<!-- artgraph:")).toBe(true);
    expect(body.split("\n")[0]).toMatch(
      /^<!-- artgraph: generated for packageManager=pnpm\. .* -->$/,
    );
  });
});

// ---------------------------------------------------------------------------
// writeAgentsMd
// ---------------------------------------------------------------------------

describe("writeAgentsMd (T019)", () => {
  it("creates AGENTS.md on a fresh project and writes the canonical body", () => {
    const project = createFreshProject();
    try {
      const res = writeAgentsMd(project.dir, "npm");
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
      const first = writeAgentsMd(project.dir, "npm");
      expect(first.written).toBe(true);
      const hash1 = sha256(first.path);

      const second = writeAgentsMd(project.dir, "npm");
      expect(second.written).toBe(false);
      expect(second.path).toBe(first.path);
      const hash2 = sha256(second.path);

      expect(hash2).toBe(hash1);
    } finally {
      project.cleanup();
    }
  });

  it("refreshes the block when the detected PM changes between runs (#110)", () => {
    const project = createFreshProject();
    try {
      const first = writeAgentsMd(project.dir, "npm");
      expect(first.written).toBe(true);
      expect(readFileSync(first.path, "utf-8")).toContain("npx artgraph doctor");

      const second = writeAgentsMd(project.dir, "pnpm");
      expect(second.written).toBe(true);

      const onDisk = readFileSync(second.path, "utf-8");
      expect(onDisk).toContain("pnpm exec artgraph doctor");
      expect(onDisk).not.toContain("npx artgraph");
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

      const res = writeAgentsMd(project.dir, "npm");
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
    const canonical = buildAgentsMdBody("npm");
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
      expect(res.path).toBe(resolve(project.dir, ".github/copilot-instructions.md"));
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
    const canonical = buildAgentsMdBody("npm");
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

// ---------------------------------------------------------------------------
// writeMarkerFile error surface (A-adj-3)
// ---------------------------------------------------------------------------

describe("writeMarkerFile error surface (A-adj-3)", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)(
    "surfaces EACCES from readFileSync with the target path and errno reason",
    () => {
      const project = createFreshProject();
      const target = resolve(project.dir, "AGENTS.md");
      writeFileSync(target, "hi\n", "utf-8");
      chmodSync(target, 0o000);
      try {
        expect(() => writeAgentsMd(project.dir, "npm")).toThrow(/cannot read existing file/);
        expect(() => writeAgentsMd(project.dir, "npm")).toThrow(target);
      } finally {
        try {
          chmodSync(target, 0o644);
        } catch {
          /* ignore */
        }
        project.cleanup();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// writeGitAttributes (OPS-2 partial mitigation)
// ---------------------------------------------------------------------------

describe("writeGitAttributes (OPS-2)", () => {
  const CLAUDE_DESCRIPTOR = findDescriptor("claude")!;

  it("writes `** text eol=lf` (+ trailing newline) into <skillsPath>/.gitattributes", () => {
    const project = createFreshProject();
    try {
      const res = writeGitAttributes(project.dir, CLAUDE_DESCRIPTOR);
      expect(res.written).toBe(true);
      expect(res.path).toBe(resolve(project.dir, CLAUDE_DESCRIPTOR.skillsPath, ".gitattributes"));
      expect(existsSync(res.path)).toBe(true);
      const onDisk = readFileSync(res.path, "utf-8");
      expect(onDisk).toBe("** text eol=lf\n");
    } finally {
      project.cleanup();
    }
  });

  it("creates the parent skillsPath directory when missing", () => {
    const project = createFreshProject();
    try {
      const skillsAbs = resolve(project.dir, CLAUDE_DESCRIPTOR.skillsPath);
      expect(existsSync(skillsAbs)).toBe(false);
      const res = writeGitAttributes(project.dir, CLAUDE_DESCRIPTOR);
      expect(res.written).toBe(true);
      expect(statSync(skillsAbs).isDirectory()).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it("is idempotent on the second call (no rewrite when contents match)", () => {
    const project = createFreshProject();
    try {
      const first = writeGitAttributes(project.dir, CLAUDE_DESCRIPTOR);
      expect(first.written).toBe(true);
      const hash1 = sha256(first.path);

      const second = writeGitAttributes(project.dir, CLAUDE_DESCRIPTOR);
      expect(second.written).toBe(false);
      expect(sha256(second.path)).toBe(hash1);
    } finally {
      project.cleanup();
    }
  });

  it("rewrites when the existing .gitattributes contains stale content", () => {
    const project = createFreshProject();
    try {
      const skillsAbs = resolve(project.dir, CLAUDE_DESCRIPTOR.skillsPath);
      mkdirSync(skillsAbs, { recursive: true });
      const gaPath = join(skillsAbs, ".gitattributes");
      writeFileSync(gaPath, "# stale user config\n* text=auto\n", "utf-8");

      const res = writeGitAttributes(project.dir, CLAUDE_DESCRIPTOR);
      expect(res.written).toBe(true);
      expect(readFileSync(gaPath, "utf-8")).toBe("** text eol=lf\n");
    } finally {
      project.cleanup();
    }
  });

  it("works for every distributing Tier 1 descriptor's skillsPath", () => {
    // issue #130 — Copilot (skillsPath: null) has no dist tree, so it's
    // excluded here. Its no-op behaviour is asserted below.
    for (const descriptor of DISTRIBUTED_AGENT_DESCRIPTORS) {
      const project = createFreshProject();
      try {
        const res = writeGitAttributes(project.dir, descriptor);
        expect(res.written).toBe(true);
        expect(res.path).toBe(
          resolve(project.dir, descriptor.skillsPath as string, ".gitattributes"),
        );
        expect(readFileSync(res.path, "utf-8")).toBe("** text eol=lf\n");
      } finally {
        project.cleanup();
      }
    }
  });

  it("is an inert no-op for descriptors with skillsPath === null (Copilot, issue #130)", () => {
    // issue #130 — Copilot never gets an on-disk Skills tree, so
    // `writeGitAttributes` MUST NOT create `.github/skills/` on its
    // behalf. It returns `written: false, path: ""` so callers can
    // invoke it uniformly without special-casing.
    const project = createFreshProject();
    try {
      const copilot = findDescriptor("copilot")!;
      const res = writeGitAttributes(project.dir, copilot);
      expect(res.written).toBe(false);
      expect(res.path).toBe("");
      // No `.github/` should have been created for a bare Copilot run
      // (parent dir creation is the wrapper writer's responsibility only).
      expect(existsSync(resolve(project.dir, ".github", "skills"))).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// MarkerBlockCorruptError export sanity
// ---------------------------------------------------------------------------

describe("MarkerBlockCorruptError", () => {
  it("has a stable `.name` for downstream instanceof / error-code checks", () => {
    const err = new MarkerBlockCorruptError("test");
    expect(err.name).toBe("MarkerBlockCorruptError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MarkerBlockCorruptError);
  });
});
