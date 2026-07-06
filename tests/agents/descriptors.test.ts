// spec 013 T007 — unit tests for the AgentDescriptor table + readSkillSource.
//
// These tests guard the foundational invariants the rest of US1 / US2 / US4
// builds on. They intentionally do NOT touch the CLI or runInit; the
// integration surface is exercised by tests/cli.test.ts and tests/init.test.ts.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { AGENT_DESCRIPTORS, AGENT_IDS, findDescriptor } from "../../src/agents/descriptors.js";
import { readSkillSource } from "../../src/agents/source.js";
import { SkillsInstallError } from "../../src/init.js";
import { createFreshProject } from "./helpers.js";

const REPO_TEMPLATES_DIR = resolve(import.meta.dirname, "..", "..", "templates", "skills");

describe("AGENT_DESCRIPTORS table (spec 013 §data-model 1)", () => {
  it("has exactly 5 Tier 1 entries", () => {
    expect(AGENT_DESCRIPTORS.length).toBe(5);
  });

  it("exposes AGENT_IDS with the same length and matching ids", () => {
    expect(AGENT_IDS.length).toBe(5);
    expect(AGENT_IDS).toEqual(AGENT_DESCRIPTORS.map((d) => d.id));
  });

  it("uses unique ids across all entries", () => {
    const seen = new Set<string>();
    for (const d of AGENT_DESCRIPTORS) {
      expect(seen.has(d.id), `duplicate id: ${d.id}`).toBe(false);
      seen.add(d.id);
    }
    expect(seen.size).toBe(AGENT_DESCRIPTORS.length);
  });

  it("contains each of the 5 expected Tier 1 ids", () => {
    const ids = AGENT_DESCRIPTORS.map((d) => d.id).sort();
    expect(ids).toEqual(["claude", "codex", "copilot", "cursor", "kiro"]);
  });

  it("every skillsPath ends with /skills (no trailing slash)", () => {
    for (const d of AGENT_DESCRIPTORS) {
      expect(d.skillsPath.endsWith("/skills"), `${d.id}: ${d.skillsPath}`).toBe(true);
      expect(d.skillsPath.endsWith("/")).toBe(false);
    }
  });

  it("uses POSIX separators in skillsPath", () => {
    for (const d of AGENT_DESCRIPTORS) {
      expect(d.skillsPath.includes("\\"), `${d.id}: ${d.skillsPath}`).toBe(false);
    }
  });

  it("claude → .claude/skills, with wrapper CLAUDE.md and both load mode", () => {
    const d = findDescriptor("claude")!;
    expect(d.skillsPath).toBe(".claude/skills");
    expect(d.wrapperFile).toBe("CLAUDE.md");
    expect(d.agentContextLoad).toBe("both");
  });

  it("codex → .agents/skills, no wrapper, native-agents-md", () => {
    const d = findDescriptor("codex")!;
    expect(d.skillsPath).toBe(".agents/skills");
    expect(d.wrapperFile).toBeNull();
    expect(d.agentContextLoad).toBe("native-agents-md");
  });

  it("cursor → .cursor/skills, no wrapper, native-agents-md", () => {
    const d = findDescriptor("cursor")!;
    expect(d.skillsPath).toBe(".cursor/skills");
    expect(d.wrapperFile).toBeNull();
    expect(d.agentContextLoad).toBe("native-agents-md");
  });

  it("copilot → .github/skills with wrapper .github/copilot-instructions.md", () => {
    const d = findDescriptor("copilot")!;
    expect(d.skillsPath).toBe(".github/skills");
    expect(d.wrapperFile).toBe(".github/copilot-instructions.md");
    expect(d.agentContextLoad).toBe("both");
  });

  it("kiro → .kiro/skills, no wrapper, native-agents-md (steering is the integrate stage responsibility)", () => {
    const d = findDescriptor("kiro")!;
    expect(d.skillsPath).toBe(".kiro/skills");
    expect(d.wrapperFile).toBeNull();
    expect(d.agentContextLoad).toBe("native-agents-md");
  });

  it("wrapperFile null implies agentContextLoad === 'native-agents-md'", () => {
    for (const d of AGENT_DESCRIPTORS) {
      if (d.wrapperFile === null) {
        expect(d.agentContextLoad, `${d.id} contract`).toBe("native-agents-md");
      } else {
        expect(["wrapper-required", "both"]).toContain(d.agentContextLoad);
      }
    }
  });
});

describe("findDescriptor", () => {
  it("returns the descriptor for a valid lowercase id", () => {
    const d = findDescriptor("claude");
    expect(d).toBeDefined();
    expect(d?.id).toBe("claude");
  });

  it("returns undefined for an unknown id", () => {
    expect(findDescriptor("windsurf")).toBeUndefined();
    expect(findDescriptor("")).toBeUndefined();
    expect(findDescriptor("CLAUDE")).toBeUndefined();
  });

  it("does NOT normalize case — 'Claude' returns undefined", () => {
    // A1 contract: parser must reject uppercase explicitly so the user sees
    // the "Did you mean ...?" hint; findDescriptor is the lookup primitive
    // and must not paper over the casing mistake.
    expect(findDescriptor("Claude")).toBeUndefined();
    expect(findDescriptor("Codex")).toBeUndefined();
  });
});

describe("readSkillSource (spec 013 §data-model 2, R1)", () => {
  it("walks the real templates/skills/ tree and includes _shared as a SkillEntry", () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    expect(source.sourceRoot).toBe(REPO_TEMPLATES_DIR);
    expect(source.entries.length).toBeGreaterThanOrEqual(2);

    const shared = source.entries.find((e) => e.topLevel === "_shared");
    expect(shared, "_shared/ entry must be present (R1 decision)").toBeDefined();
    expect(shared?.isShared).toBe(true);
  });

  it("every non-shared entry contains a <topLevel>/SKILL.md file", () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    for (const entry of source.entries) {
      if (entry.isShared) continue;
      const relSkill = `${entry.topLevel}/SKILL.md`;
      const hit = entry.files.find((f) => f.relPath === relSkill);
      expect(hit, `${entry.topLevel} must contain ${relSkill}`).toBeDefined();
    }
  });

  it("each SkillFile carries a 64-char lowercase sha256 hex digest", () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    for (const entry of source.entries) {
      for (const f of entry.files) {
        expect(f.sha256, `${f.relPath}`).toMatch(/^[0-9a-f]{64}$/);
        expect(f.byteSize).toBeGreaterThan(0);
      }
    }
  });

  it("is idempotent — two reads of the same templates dir produce identical sha256 maps", () => {
    const a = readSkillSource(REPO_TEMPLATES_DIR);
    const b = readSkillSource(REPO_TEMPLATES_DIR);
    expect(a.entries.length).toBe(b.entries.length);
    for (let i = 0; i < a.entries.length; i++) {
      const ea = a.entries[i]!;
      const eb = b.entries[i]!;
      expect(ea.topLevel).toBe(eb.topLevel);
      expect(ea.files.length).toBe(eb.files.length);
      for (let j = 0; j < ea.files.length; j++) {
        expect(ea.files[j]).toEqual(eb.files[j]);
      }
    }
  });

  it("relPath uses POSIX separators (no backslashes)", () => {
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    for (const entry of source.entries) {
      for (const f of entry.files) {
        expect(f.relPath.includes("\\"), `${f.relPath}`).toBe(false);
      }
    }
  });

  it("sha256 matches a freshly computed digest of the same bytes", () => {
    // Independent recomputation: round-trip through node:crypto to verify
    // the source-side hashes are not just stable but actually correct.
    const source = readSkillSource(REPO_TEMPLATES_DIR);
    const sample = source.entries
      .flatMap((e) => e.files)
      .find((f) => f.relPath.endsWith("SKILL.md"));
    expect(sample, "expected at least one SKILL.md to sample").toBeDefined();

    const abs = join(source.sourceRoot, sample!.relPath);
    const buf = readFileSync(abs);
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(sample!.sha256).toBe(expected);
  });

  it("throws SkillsInstallError when the templates dir does not exist", () => {
    const { dir, cleanup } = createFreshProject();
    try {
      const missing = join(dir, "no-such-templates");
      expect(() => readSkillSource(missing)).toThrow(SkillsInstallError);
    } finally {
      cleanup();
    }
  });

  it("throws SkillsInstallError when a non-shared entry is missing SKILL.md", () => {
    // Build a tiny synthetic templates dir with a broken entry. Mirrors
    // the existing init.ts contract: every <name>/ that is NOT _shared
    // must carry SKILL.md, otherwise the Tier 1 agents won't recognize it.
    const { dir, cleanup } = createFreshProject();
    try {
      const templatesDir = join(dir, "templates", "skills");
      mkdirSync(join(templatesDir, "artgraph-broken"), { recursive: true });
      writeFileSync(
        join(templatesDir, "artgraph-broken", "README.md"),
        "intentionally missing SKILL.md\n",
      );

      expect(() => readSkillSource(templatesDir)).toThrow(SkillsInstallError);
      expect(() => readSkillSource(templatesDir)).toThrow(/artgraph-broken.*missing SKILL\.md/);
    } finally {
      cleanup();
    }
  });

  it("accepts a _shared-only top-level entry without SKILL.md", () => {
    // _shared/ never carries SKILL.md (it holds reusable fragments). Build a
    // fixture with ONLY `_shared/` + one valid skill so the source still
    // parses, and assert the broken-entry guard doesn't fire on _shared/.
    const { dir, cleanup } = createFreshProject();
    try {
      const templatesDir = join(dir, "templates", "skills");
      mkdirSync(join(templatesDir, "_shared"), { recursive: true });
      writeFileSync(join(templatesDir, "_shared", "install-check.md"), "shared\n");
      mkdirSync(join(templatesDir, "artgraph-ok"), { recursive: true });
      writeFileSync(join(templatesDir, "artgraph-ok", "SKILL.md"), "---\nname: ok\n---\n");

      const source = readSkillSource(templatesDir);
      const shared = source.entries.find((e) => e.topLevel === "_shared");
      expect(shared).toBeDefined();
      expect(shared?.isShared).toBe(true);
      expect(shared?.files.length).toBe(1);
      expect(shared?.files[0]?.relPath).toBe("_shared/install-check.md");
    } finally {
      cleanup();
    }
  });

  it("skips hidden files and directories during the walk", () => {
    const { dir, cleanup } = createFreshProject();
    try {
      const templatesDir = join(dir, "templates", "skills");
      mkdirSync(join(templatesDir, "artgraph-ok"), { recursive: true });
      writeFileSync(join(templatesDir, "artgraph-ok", "SKILL.md"), "---\nname: ok\n---\n");
      writeFileSync(join(templatesDir, "artgraph-ok", ".DS_Store"), "junk");

      const source = readSkillSource(templatesDir);
      const entry = source.entries.find((e) => e.topLevel === "artgraph-ok");
      expect(entry).toBeDefined();
      expect(entry!.files.map((f) => f.relPath)).toEqual(["artgraph-ok/SKILL.md"]);
    } finally {
      cleanup();
    }
  });
});
