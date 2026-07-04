import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// Metatest: walks templates/skills/**/SKILL.md and verifies invariants
// for the Claude Code Skills artgraph distributes.
// Catches drift between the spec contract (012-skills-expansion /
// FR-008..FR-011 / FR-029) and the actual SKILL.md files.

const TEMPLATES_SKILLS_DIR = resolve(import.meta.dirname, "..", "templates", "skills");

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
  "artgraph-plan-coverage",
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
const CJK_REGEX = /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/;

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
      expect(existsSync(filePath), `Expected SKILL.md at ${filePath}`).toBe(true);
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
      expect(Array.isArray(allowedTools), `allowed-tools in ${dirName} must be an array`).toBe(
        true,
      );
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
      expect(match, `CJK character "${match?.[0]}" found in ${dirName}/SKILL.md`).toBeNull();
    });
  });

  describe.each(SKILLS_LINKING_INSTALL_CHECK)("Skill linking install-check: %s", (dirName) => {
    it("body links to _shared/install-check.md", () => {
      const skill = readSkill(dirName);
      const linkPattern = /\[.+\]\(\.\.\/_shared\/install-check\.md\)/;
      expect(
        linkPattern.test(skill.body),
        `${dirName}/SKILL.md body must link to ../_shared/install-check.md`,
      ).toBe(true);
    });
  });

  it("at least 9 Skill directories are present (regression guard)", () => {
    // Pairs with the dynamic discoverSkillDirs() — if someone accidentally
    // moves a Skill out of templates/skills/, the count drops and this trips.
    // Bumped from 7 to 8 with spec 014 (artgraph-plan-coverage added).
    // Bumped from 8 to 9 with issue #123 (artgraph-bootstrap added).
    expect(EXPECTED_SKILL_DIRS.length).toBeGreaterThanOrEqual(9);
  });

  // SC-005 (spec 014): artgraph-impact description must NOT contain the
  // wide-match planning/designing/scoping vocabulary that caused spec 012's
  // mis-fires. The description must promise *only* file-based forward impact.
  describe("artgraph-impact description honesty (spec 014 SC-005)", () => {
    it("description contains no planning/designing/scoping (case-insensitive)", () => {
      const skill = readSkill("artgraph-impact");
      const description = skill.frontmatter.description as string;
      const forbidden = /\b(planning|designing|scoping)\b/i;
      const match = description.match(forbidden);
      expect(
        match,
        `forbidden word "${match?.[0]}" found in artgraph-impact description; ` +
          `spec 014 FR-009 requires file-based forward-impact phrasing only`,
      ).toBeNull();
    });
  });

  // SC-006 (spec 014): artgraph-plan-coverage Skill ships with the contract-
  // mandated invariants — body cap, install-check linking, allowed-tools
  // declaring the plan-coverage subcommand, and avoidance of the wide-match
  // planning/designing vocabulary that the parent spec is designed to fix.
  describe("artgraph-plan-coverage Skill contract (spec 014 SC-006)", () => {
    it("declares plan-coverage subcommand in allowed-tools", () => {
      const skill = readSkill("artgraph-plan-coverage");
      const allowed = (skill.frontmatter["allowed-tools"] ?? []) as string[];
      const hasNpx = allowed.some((t) => /^Bash\(npx artgraph plan-coverage\b/.test(t));
      const hasDirect = allowed.some((t) => /^Bash\(artgraph plan-coverage\b/.test(t));
      expect(
        hasNpx,
        `artgraph-plan-coverage allowed-tools must include "Bash(npx artgraph plan-coverage *)"`,
      ).toBe(true);
      expect(
        hasDirect,
        `artgraph-plan-coverage allowed-tools must include "Bash(artgraph plan-coverage *)"`,
      ).toBe(true);
    });

    it("description does not lean on the wide-match planning/designing vocabulary", () => {
      // The whole reason this Skill exists is to give plan-coverage its own
      // narrow description. Re-introducing planning/designing here would
      // bring spec 012's wide-match mis-fire back through the side door.
      const skill = readSkill("artgraph-plan-coverage");
      const description = skill.frontmatter.description as string;
      const forbidden = /\b(planning|designing)\b/i;
      const match = description.match(forbidden);
      expect(
        match,
        `forbidden word "${match?.[0]}" found in artgraph-plan-coverage description; ` +
          `spec 014 FR-021 requires a narrow "implicit impacts" promise`,
      ).toBeNull();
    });
  });

  it("every _shared/*.md fragment is referenced by at least one Skill", () => {
    const sharedFiles = readdirSync(join(TEMPLATES_SKILLS_DIR, "_shared")).filter((n) =>
      n.endsWith(".md"),
    );
    expect(sharedFiles.length).toBeGreaterThan(0);

    const allSkillBodies = EXPECTED_SKILL_DIRS.map((dir) => {
      const path = join(TEMPLATES_SKILLS_DIR, dir, "SKILL.md");
      return readFileSync(path, "utf8");
    });

    for (const shared of sharedFiles) {
      const linkPattern = new RegExp(`_shared/${shared.replace(".", "\\.")}`);
      const referencingSkills = allSkillBodies.filter((body) => linkPattern.test(body));
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

  describe("package-manager agnosticism (spec 015, FR-009/010, SC-004)", () => {
    it.each(EXPECTED_SKILL_DIRS)(
      "%s body has no bare `npx artgraph <subcommand>` command example",
      (dirName) => {
        const skill = readSkill(dirName);
        // SC-004 targets `npx artgraph <sub>` work-commands an agent would copy.
        // The regex tolerates intervening flags (`npx -y artgraph init`),
        // double spaces, and case. It requires the token after `artgraph` to be
        // a real subcommand (not starting with `-`), which exempts install
        // probes like `npx --no-install artgraph --version`. Markdown table rows
        // (the artgraph-setup PM mapping table, kept by FR-011) and blockquote
        // explainer lines (the `> <PM-exec> is ...` note added by PR #112
        // meta-followups) are also exempt: both are documentation, not commands
        // the agent would copy verbatim.
        const offenders = skill.body
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("|"))
          .filter((line) => !line.trimStart().startsWith(">"))
          .filter((line) => /\bnpx\s+(?:-\S+\s+)*artgraph\s+[^-\s]/i.test(line));
        expect(
          offenders,
          `${dirName}/SKILL.md body should use a PM-agnostic <PM-exec>/bare 'artgraph' form, not 'npx artgraph <sub>':\n${offenders.join("\n")}`,
        ).toEqual([]);
      },
    );

    // PR #112 meta-followup: body command lines should use `<PM-exec> <sub>`
    // rather than a bare `artgraph <sub>` form, so the same Skill works under
    // any of the four supported package managers without local rewriting.
    // Exempt:
    //   * artgraph-setup — the PM mapping table legitimately uses the runners.
    //   * artgraph-detect Step 1 — the `command -v artgraph || npx --no-install
    //     artgraph --version` probe is intentionally PM-fixed (it must run
    //     before PM detection has happened).
    //   * table rows starting with `|`.
    //   * blockquote explainer lines starting with `>`.
    //   * lines where `artgraph` is inside inline backticks (e.g. prose
    //     mentions like `artgraph rename`) — these don't get copy/pasted.
    it.each(EXPECTED_SKILL_DIRS)(
      "%s body uses `<PM-exec> <sub>` not bare `artgraph <sub>` (PR #112)",
      (dirName) => {
        if (dirName === "artgraph-setup" || dirName === "artgraph-detect") {
          return;
        }
        const skill = readSkill(dirName);
        const subcommands = /(coverage|impact|check|plan-coverage|rename|integrate|reconcile|init)/;
        const offenders = skill.body
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("|"))
          .filter((line) => !line.trimStart().startsWith(">"))
          // Strip inline-code spans (`...`) so prose mentions don't count.
          .map((line) => line.replace(/`[^`]*`/g, ""))
          .filter((line) => {
            const re = new RegExp(`(^|\\s)artgraph\\s+${subcommands.source}\\b`);
            return re.test(line);
          });
        expect(
          offenders,
          `${dirName}/SKILL.md body should call <PM-exec> <sub>, not bare 'artgraph <sub>':\n${offenders.join("\n")}`,
        ).toEqual([]);
      },
    );

    it.each(EXPECTED_SKILL_DIRS)(
      "%s allowed-tools pre-approves the bare artgraph bin",
      (dirName) => {
        const skill = readSkill(dirName);
        const tools = (skill.frontmatter["allowed-tools"] as string[]) ?? [];
        const hasBare = tools.some((t) => /^Bash\(artgraph( |\*| plan-coverage)/.test(t));
        expect(
          hasBare,
          `${dirName}/SKILL.md allowed-tools must include a bare 'Bash(artgraph ...)' entry; got ${JSON.stringify(tools)}`,
        ).toBe(true);
      },
    );

    it.each(EXPECTED_SKILL_DIRS)(
      "%s allowed-tools pre-approves all 4 PM exec runners",
      (dirName) => {
        const skill = readSkill(dirName);
        const tools = (skill.frontmatter["allowed-tools"] as string[]) ?? [];
        const joined = tools.join("\n");
        for (const runner of ["npx artgraph", "pnpm exec artgraph", "bunx artgraph", "deno run"]) {
          expect(
            joined,
            `${dirName}/SKILL.md allowed-tools must pre-approve '${runner}'; got ${JSON.stringify(tools)}`,
          ).toContain(runner);
        }
      },
    );

    // PR #112 meta-followup #3: every PM-exec entry in allowed-tools must use a
    // **space-bounded** scope (`Bash(pnpm exec artgraph *)`, not `Bash(pnpm
    // exec artgraph*)`). The space prevents `pnpm exec artgraphfoo` from
    // falsely matching the artgraph scope; and the explicit deno specifier
    // (`deno run -A npm:artgraph/cli *`) prevents `Bash(deno run*)` from
    // pre-approving every deno script in the repo.
    it.each(EXPECTED_SKILL_DIRS)(
      "%s allowed-tools have space-bounded PM-exec scopes (PR #112)",
      (dirName) => {
        const skill = readSkill(dirName);
        const tools = (skill.frontmatter["allowed-tools"] as string[]) ?? [];
        for (const tool of tools) {
          // glob-without-space bug: `Bash(pnpm exec artgraph*)` etc.
          expect(
            tool,
            `${dirName}/SKILL.md allowed-tools entry "${tool}" must keep a space before '*' to avoid prefix bleed`,
          ).not.toMatch(/(?:pnpm exec artgraph|bunx artgraph|npx artgraph)(?:\s+plan-coverage)?\*/);
          // unbounded deno: `Bash(deno run*)` would also approve `deno run mything`
          expect(
            tool,
            `${dirName}/SKILL.md allowed-tools entry "${tool}" must scope deno to 'npm:artgraph/cli', not the generic 'deno run*'`,
          ).not.toMatch(/^Bash\(deno run\*/);
        }
      },
    );
  });

  // PR #112 meta-followup #4: artgraph-detect must list all 8 canonical
  // Skills (the regression test from FR-021 only counts directories on disk;
  // this test pins the body text the user actually sees).
  describe("artgraph-detect canonical Skill set (PR #112)", () => {
    it("body lists artgraph-plan-coverage in the canonical set", () => {
      const skill = readSkill("artgraph-detect");
      expect(skill.body).toMatch(/artgraph-plan-coverage/);
    });

    it("body summary template says 'N of 8 installed' (not 7)", () => {
      const skill = readSkill("artgraph-detect");
      expect(skill.body).toMatch(/N of 8 installed/);
    });
  });

  // US4 (spec 016): symbol-level + dual-axis guidance must appear in the two
  // updated Skills, in docs/skills-guide.md, and in README.md (FR-026..FR-029).
  // The Skill body-line cap (≤ 100 lines, FR-030) is enforced by the generic
  // "body is <= 100 lines" test above; the keyword presence checks below pin
  // US4 Acceptance Scenarios 1, 2, 3, 4.
  describe("spec 016 US4 — symbol-level guidance keywords", () => {
    it("artgraph-impact SKILL.md mentions symbol-level input + originReqs + example", () => {
      // AS#1: grep "symbol-level" / "originReqs" / "src/auth.ts:validateToken"
      const skill = readSkill("artgraph-impact");
      expect(skill.body).toMatch(/symbol-level/);
      expect(skill.body).toMatch(/originReqs/);
      expect(skill.body).toMatch(/src\/auth\.ts:validateToken/);
    });

    it("artgraph-plan-coverage SKILL.md mentions impactReqs + originReqs + drift", () => {
      // AS#2: dual-axis output interpretation + drift detection
      const skill = readSkill("artgraph-plan-coverage");
      expect(skill.body).toMatch(/impactReqs/);
      expect(skill.body).toMatch(/originReqs/);
      expect(skill.body).toMatch(/drift/i);
      expect(skill.body).toMatch(/unresolvedSymbol/);
    });

    it("docs/skills-guide.md documents symbol mode, scan --mode symbol, and dual-axis", () => {
      // AS#3: "scan --mode symbol を実行しないと無効" + "impactReqs / originReqs の二軸"
      const docPath = resolve(import.meta.dirname, "..", "docs", "skills-guide.md");
      expect(existsSync(docPath), `Expected ${docPath} to exist`).toBe(true);
      const content = readFileSync(docPath, "utf8");
      expect(content).toMatch(/symbol mode/i);
      expect(content).toMatch(/scan --mode symbol/);
      expect(content).toMatch(/impactReqs/);
      expect(content).toMatch(/originReqs/);
      // FR-028 (a) trade-off, (c) .artgraph.json mode example
      expect(content).toMatch(/"mode":\s*"symbol"/);
    });

    it("README.md Skills table carries an input-mode column / annotation", () => {
      // AS#4: each Skill's supported mode (file / symbol / both) is readable
      const readmePath = resolve(import.meta.dirname, "..", "README.md");
      expect(existsSync(readmePath), `Expected ${readmePath} to exist`).toBe(true);
      const content = readFileSync(readmePath, "utf8");
      expect(content).toMatch(/Input mode/);
      expect(content).toMatch(/file \+ symbol/);
    });
  });

  describe("_shared files", () => {
    const SHARED_FILES = ["install-check.md", "output-schema.md", "package-manager.md"] as const;

    it.each(SHARED_FILES)("%s is English (no CJK characters)", (name) => {
      const filePath = resolve(TEMPLATES_SKILLS_DIR, "_shared", name);
      expect(existsSync(filePath), `Expected ${filePath} to exist`).toBe(true);
      const content = readFileSync(filePath, "utf8");
      const match = content.match(CJK_REGEX);
      expect(match, `CJK character "${match?.[0]}" found in _shared/${name}`).toBeNull();
    });
  });
});
