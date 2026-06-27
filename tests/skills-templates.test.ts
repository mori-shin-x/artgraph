import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// Metatest: walks templates/skills/**/SKILL.md and verifies invariants
// for the Claude Code Skills artgraph distributes.
// Catches drift between the spec contract (012-skills-expansion /
// FR-008..FR-011 / FR-029) and the actual SKILL.md files.

const EXPECTED_SKILL_DIRS = [
  "artgraph-coverage",
  "artgraph-detect",
  "artgraph-impact",
  "artgraph-integrate",
  "artgraph-rename",
  "artgraph-setup",
  "artgraph-verify",
] as const;

const SKILLS_LINKING_INSTALL_CHECK = [
  "artgraph-impact",
  "artgraph-verify",
  "artgraph-coverage",
  "artgraph-rename",
] as const;

// CJK unicode ranges: Hiragana, Katakana, CJK Unified Ideographs.
const CJK_REGEX = /[぀-ゟ゠-ヿ一-鿿]/;

const TEMPLATES_SKILLS_DIR = resolve(
  import.meta.dirname,
  "..",
  "templates",
  "skills",
);

type SkillFile = {
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
  lines: string[];
  filePath: string;
};

function readSkill(dirName: string): SkillFile {
  const filePath = resolve(TEMPLATES_SKILLS_DIR, dirName, "SKILL.md");
  if (!existsSync(filePath)) {
    throw new Error(`SKILL.md missing for ${dirName}: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");

  // Extract frontmatter between the first two `---` delimiters.
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`No YAML frontmatter found in ${filePath}`);
  }
  const frontmatter = (parseYaml(fmMatch[1]) ?? {}) as Record<string, unknown>;
  const body = fmMatch[2];
  const lines = body.split("\n");

  return { raw, frontmatter, body, lines, filePath };
}

describe("templates/skills metatest", () => {
  describe.each(EXPECTED_SKILL_DIRS)("Skill: %s", (dirName) => {
    it("every expected Skill directory exists", () => {
      const filePath = resolve(TEMPLATES_SKILLS_DIR, dirName, "SKILL.md");
      expect(
        existsSync(filePath),
        `Expected SKILL.md at ${filePath}`,
      ).toBe(true);
    });

    it("frontmatter parses and has required fields", () => {
      const skill = readSkill(dirName);
      expect(
        typeof skill.frontmatter.name,
        `frontmatter.name must be a string in ${dirName}/SKILL.md`,
      ).toBe("string");
      expect(
        typeof skill.frontmatter.description,
        `frontmatter.description must be a string in ${dirName}/SKILL.md`,
      ).toBe("string");
    });

    it("frontmatter name matches directory name", () => {
      const skill = readSkill(dirName);
      expect(
        skill.frontmatter.name,
        `frontmatter.name should equal directory name for ${dirName}`,
      ).toBe(dirName);
    });

    it("frontmatter description is <= 1024 chars", () => {
      const skill = readSkill(dirName);
      const description = skill.frontmatter.description as string;
      expect(
        description.length,
        `description for ${dirName} is ${description.length} chars (max 1024)`,
      ).toBeLessThanOrEqual(1024);
    });

    it("body is <= 100 lines", () => {
      const skill = readSkill(dirName);
      expect(
        skill.lines.length,
        `body for ${dirName} is ${skill.lines.length} lines (max 100)`,
      ).toBeLessThanOrEqual(100);
    });

    it("allowed-tools (when present) is an array of '<Name>(...)' strings", () => {
      const skill = readSkill(dirName);
      const allowedTools = skill.frontmatter["allowed-tools"];
      if (allowedTools === undefined) {
        return;
      }
      expect(
        Array.isArray(allowedTools),
        `allowed-tools in ${dirName} must be an array`,
      ).toBe(true);
      const pattern = /^[A-Z][A-Za-z]+\(.+\)$/;
      for (const entry of allowedTools as unknown[]) {
        expect(
          typeof entry === "string" && pattern.test(entry),
          `allowed-tools entry "${String(entry)}" in ${dirName} must match <Name>(...)`,
        ).toBe(true);
      }
    });

    it("SKILL.md is English (no CJK characters)", () => {
      const skill = readSkill(dirName);
      const match = skill.raw.match(CJK_REGEX);
      expect(
        match,
        `CJK character "${match?.[0]}" found in ${dirName}/SKILL.md`,
      ).toBeNull();
    });
  });

  describe.each(SKILLS_LINKING_INSTALL_CHECK)(
    "Skill linking install-check: %s",
    (dirName) => {
      it("body links to _shared/install-check.md", () => {
        const skill = readSkill(dirName);
        const linkPattern = /\[.+\]\(\.\.\/_shared\/install-check\.md\)/;
        expect(
          linkPattern.test(skill.body),
          `${dirName}/SKILL.md body must link to ../_shared/install-check.md`,
        ).toBe(true);
      });
    },
  );

  it("all descriptions across Skills are unique", () => {
    const descriptions: string[] = [];
    for (const dirName of EXPECTED_SKILL_DIRS) {
      const filePath = resolve(TEMPLATES_SKILLS_DIR, dirName, "SKILL.md");
      if (!existsSync(filePath)) {
        // Skip missing Skills here — the existence test covers that.
        continue;
      }
      const skill = readSkill(dirName);
      if (typeof skill.frontmatter.description === "string") {
        descriptions.push(skill.frontmatter.description);
      }
    }
    const seen = new Map<string, number>();
    for (const desc of descriptions) {
      seen.set(desc, (seen.get(desc) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    expect(
      duplicates,
      `duplicate descriptions found: ${duplicates
        .map(([d]) => `"${d.slice(0, 60)}..."`)
        .join(", ")}`,
    ).toEqual([]);
  });

  describe("_shared files", () => {
    const SHARED_FILES = [
      "install-check.md",
      "output-schema.md",
      "package-manager.md",
    ] as const;

    it.each(SHARED_FILES)("%s is English (no CJK characters)", (name) => {
      const filePath = resolve(TEMPLATES_SKILLS_DIR, "_shared", name);
      expect(existsSync(filePath), `Expected ${filePath} to exist`).toBe(true);
      const content = readFileSync(filePath, "utf8");
      const match = content.match(CJK_REGEX);
      expect(
        match,
        `CJK character "${match?.[0]}" found in _shared/${name}`,
      ).toBeNull();
    });
  });
});
