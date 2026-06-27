import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// Metatest: walks templates/skills/**/SKILL.md and verifies invariants
// for the Claude Code Skills artgraph distributes.
// Catches drift between the spec contract (012-skills-expansion /
// FR-008..FR-011 / FR-029) and the actual SKILL.md files.

const TEMPLATES_SKILLS_DIR = resolve(
  import.meta.dirname,
  "..",
  "templates",
  "skills",
);

// Discover Skill directories dynamically so that newly added Skills are
// automatically validated by this metatest (M6 hardening).
function discoverSkillDirs(): string[] {
  return readdirSync(TEMPLATES_SKILLS_DIR)
    .filter((name) => {
      if (name === "_shared" || name.startsWith(".")) return false;
      return statSync(join(TEMPLATES_SKILLS_DIR, name)).isDirectory();
    })
    .sort();
}

const EXPECTED_SKILL_DIRS = discoverSkillDirs();

// Contract subset: only these designated Skills must link to install-check.
const SKILLS_LINKING_INSTALL_CHECK = [
  "artgraph-impact",
  "artgraph-verify",
  "artgraph-coverage",
  "artgraph-rename",
] as const;

// CJK unicode ranges covered (use \u escapes so the test file itself stays
// ASCII-only and survives copy/paste across editors):
//   U+3000-U+303F  CJK Symbols and Punctuation (full-width space, kuten, tooten, kagi-kakko)
//   U+3040-U+309F  Hiragana
//   U+30A0-U+30FF  Katakana
//   U+4E00-U+9FFF  CJK Unified Ideographs
//   U+FF00-U+FFEF  Halfwidth and Fullwidth Forms (full-width latin, half-width katakana)
const CJK_REGEX =
  /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/;

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
  // Trim leading newlines so the blank line that conventionally follows the
  // closing `---` does not count toward the 100-line cap (M19 fix: without
  // this, the effective cap is 99 because split produces a leading "").
  const lines = body.trimStart().split("\n");

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

  it("at least 7 Skill directories are present (regression guard)", () => {
    // Pairs with the dynamic discoverSkillDirs() — if someone accidentally
    // moves a Skill out of templates/skills/, the count drops and this trips.
    expect(EXPECTED_SKILL_DIRS.length).toBeGreaterThanOrEqual(7);
  });

  it("every _shared/*.md fragment is referenced by at least one Skill", () => {
    const sharedFiles = readdirSync(join(TEMPLATES_SKILLS_DIR, "_shared")).filter(
      (n) => n.endsWith(".md"),
    );
    expect(sharedFiles.length).toBeGreaterThan(0);

    const allSkillBodies = EXPECTED_SKILL_DIRS.map((dir) => {
      const path = join(TEMPLATES_SKILLS_DIR, dir, "SKILL.md");
      return readFileSync(path, "utf8");
    });

    for (const shared of sharedFiles) {
      const linkPattern = new RegExp(`_shared/${shared.replace(".", "\\.")}`);
      const referencingSkills = allSkillBodies.filter((body) =>
        linkPattern.test(body),
      );
      expect(
        referencingSkills.length,
        `_shared/${shared} is orphaned (no Skill references it)`,
      ).toBeGreaterThan(0);
    }
  });

  it("references/*.md files inside Skill dirs are CJK-free", () => {
    for (const dir of EXPECTED_SKILL_DIRS) {
      const refsDir = join(TEMPLATES_SKILLS_DIR, dir, "references");
      if (!existsSync(refsDir)) continue;
      const files = readdirSync(refsDir).filter((n) => n.endsWith(".md"));
      for (const f of files) {
        const body = readFileSync(join(refsDir, f), "utf8");
        const m = body.match(CJK_REGEX);
        expect(
          m,
          `${dir}/references/${f} contains CJK character ${JSON.stringify(m?.[0])}`,
        ).toBeNull();
      }
    }
  });

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
