import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Docs-trio consistency metatest (#139).
//
// README.md, docs/skills-guide.md, and src/cli.ts all describe the default
// stages of `artgraph init`, and nothing keeps them in sync automatically:
// PR #103 advertised agent-context in the README before it shipped (H1),
// and PR #129 shipped the Stop hook but left "lands in PR-B" in the CLI
// help. This test pins the three sources to a single stage list and rejects
// stale future-tense markers, so the next shipped-but-undocumented (or
// documented-but-unshipped) stage fails CI instead of reaching users.
//
// The stage list below is the test's single source of truth. Adding a new
// init stage means updating it here, and the assertions then force the
// README paragraph, the skills-guide section, and the cli.ts flag surface
// to be updated in the same PR.

const ROOT = resolve(import.meta.dirname, "..");

const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
const skillsGuide = readFileSync(resolve(ROOT, "docs", "skills-guide.md"), "utf8");
const cliSource = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf8");

type Stage = {
  id: string;
  /** How the stage is spelled when the docs enumerate the default setup. */
  mention: RegExp;
  /** Default-mode opt-out flag; null for stages without one (config). */
  optOut: string | null;
  /**
   * Whether README / skills-guide list the opt-out flag. `--no-scan` exists
   * on the CLI but is deliberately not part of the documented opt-out list.
   */
  optOutDocumented: boolean;
};

const DEFAULT_STAGES: Stage[] = [
  { id: "config", mention: /config/i, optOut: null, optOutDocumented: false },
  { id: "scan", mention: /scan/i, optOut: "--no-scan", optOutDocumented: false },
  {
    id: "skills",
    mention: /Skills/,
    optOut: "--no-skills",
    optOutDocumented: true,
  },
  {
    id: "integrate",
    mention: /integrate/i,
    optOut: "--no-integrate",
    optOutDocumented: true,
  },
  {
    id: "hooks",
    mention: /Stop hook/,
    optOut: "--no-hooks",
    optOutDocumented: true,
  },
  {
    id: "agent-context",
    mention: /AGENTS\.md/,
    optOut: "--no-agent-context",
    optOutDocumented: true,
  },
];

// Markers that only ever appear when a doc describes a stage as future work.
// Every historical drift incident used one of these spellings; if a new one
// slips through, add it here.
const STALE_MARKERS = [
  /PR-B/,
  /P1 deliverable/i,
  /no effect yet/i,
  /coming in PR/i,
  /lands in PR/i,
  /\(P1\)/,
];

/**
 * The one README paragraph that enumerates the full default setup. Matches
 * up to the next blank line (not a single physical line) so a hard-wrap of
 * the paragraph doesn't silently truncate the extracted text and turn the
 * downstream assertions into misleading "docs regressed" failures.
 */
function readmeDefaultSetupParagraph(): string {
  const match = readme.match(
    /^`artgraph init` runs the full setup:[\s\S]*?(?=\n\s*\n|(?![\s\S]))/m,
  );
  if (!match) {
    throw new Error(
      "README.md: could not find the default-setup paragraph " +
        '(a paragraph starting with "`artgraph init` runs the full setup:"). ' +
        "If the Quickstart wording changed, update docs-trio-consistency.test.ts to match.",
    );
  }
  return match[0];
}

/**
 * Slice the stage enumeration out of an enumeration-bearing text: everything
 * up to the first sentence break. Stage-mention assertions must run against
 * this slice, not the full paragraph, because incidental later mentions in
 * the same paragraph (e.g. "--no-hooks" or "share the Stop hook with
 * teammates") would otherwise keep /Stop hook/ green after the stage was
 * dropped from the enumeration itself.
 */
function enumerationSentence(text: string, label: string): string {
  const end = text.indexOf(". ");
  if (end === -1) {
    throw new Error(
      `${label}: expected a sentence break after the stage enumeration; ` +
        "if the wording changed, update docs-trio-consistency.test.ts to match.",
    );
  }
  return text.slice(0, end);
}

/**
 * The skills-guide section describing `init` default behavior. The heading
 * text after "## `init` " is Japanese; anchoring on the ASCII prefix keeps
 * the regex free of non-ASCII characters and survives heading-wording edits.
 * The terminator accepts either the next "## " heading or end-of-file, so
 * the extraction keeps working if the section is moved to the end.
 */
function skillsGuideInitSection(): string {
  const match = skillsGuide.match(/^## `init` [^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!match) {
    throw new Error(
      "docs/skills-guide.md: could not find the `init` default-behavior section " +
        '(a "## `init` ..." heading). ' +
        "If the section was renamed or restructured, update docs-trio-consistency.test.ts to match.",
    );
  }
  return match[1];
}

/**
 * Only the "- " stage bullet lines of the skills-guide init section. The
 * section also documents the opt-out flags in a table, so matching stage
 * mentions against the whole section would let flag names (--no-integrate,
 * "bare config") mask a stage dropped from the bullet list.
 */
function skillsGuideStageBullets(): string {
  const bullets = skillsGuideInitSection()
    .split("\n")
    .filter((line) => line.startsWith("- "));
  if (bullets.length === 0) {
    throw new Error(
      "docs/skills-guide.md: the `init` section no longer contains a '- ' stage " +
        "bullet list; update docs-trio-consistency.test.ts to match.",
    );
  }
  return bullets.join("\n");
}

/** Source text of one commander command block in src/cli.ts. */
function cliCommandBlock(name: string): string {
  const start = cliSource.indexOf(`.command("${name}")`);
  if (start === -1) {
    throw new Error(`src/cli.ts: .command("${name}") not found`);
  }
  const next = cliSource.indexOf('.command("', start + 1);
  return cliSource.slice(start, next === -1 ? undefined : next);
}

/** The .description("...") string of the init command. */
function cliInitDescription(): string {
  const match = cliCommandBlock("init").match(/\.description\(\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) {
    throw new Error('src/cli.ts: init .description("...") not found or not a plain string');
  }
  return match[1];
}

/** All --flag names declared via .option() inside the init command block. */
function cliInitOptionFlags(): string[] {
  const block = cliCommandBlock("init");
  const flags: string[] = [];
  for (const m of block.matchAll(/\.option\(\s*"(--[a-z-]+)/g)) {
    flags.push(m[1]);
  }
  return flags;
}

describe("docs-trio consistency: README / docs/skills-guide.md / src/cli.ts (#139)", () => {
  describe("every default stage is described by all three sources", () => {
    for (const stage of DEFAULT_STAGES) {
      it(`stage "${stage.id}" appears in the cli.ts init description`, () => {
        expect(enumerationSentence(cliInitDescription(), "src/cli.ts init description")).toMatch(
          stage.mention,
        );
      });

      it(`stage "${stage.id}" appears in the README default-setup enumeration`, () => {
        expect(
          enumerationSentence(readmeDefaultSetupParagraph(), "README default-setup paragraph"),
        ).toMatch(stage.mention);
      });

      it(`stage "${stage.id}" appears in the skills-guide stage bullet list`, () => {
        expect(skillsGuideStageBullets()).toMatch(stage.mention);
      });
    }
  });

  describe("stage flag surface matches the stage list", () => {
    it("cli.ts declares exactly the expected --no-* opt-outs on init", () => {
      const expected = DEFAULT_STAGES.map((s) => s.optOut)
        .filter((f): f is string => f !== null)
        .sort();
      const actual = cliInitOptionFlags()
        .filter((f) => f.startsWith("--no-"))
        .sort();
      expect(actual).toEqual(expected);
    });

    it("cli.ts declares no --with-* opt-ins on init (removed in #135)", () => {
      expect(cliInitOptionFlags().filter((f) => f.startsWith("--with-"))).toEqual([]);
    });

    for (const stage of DEFAULT_STAGES.filter((s) => s.optOutDocumented)) {
      it(`opt-out ${stage.optOut} is documented in README and skills-guide`, () => {
        expect(readmeDefaultSetupParagraph()).toContain(stage.optOut);
        expect(skillsGuideInitSection()).toContain(stage.optOut);
      });
    }

    it("all three sources mention --minimal as the bare-config escape hatch", () => {
      expect(cliInitDescription()).toContain("--minimal");
      expect(readmeDefaultSetupParagraph()).toContain("--minimal");
      expect(skillsGuideInitSection()).toContain("--minimal");
    });
  });

  describe("no stale future-work markers in any of the three sources", () => {
    const sources: Array<[string, () => string]> = [
      ["README.md", () => readme],
      ["docs/skills-guide.md", () => skillsGuide],
      ["src/cli.ts", () => cliSource],
    ];
    for (const [label, read] of sources) {
      for (const marker of STALE_MARKERS) {
        it(`${label} does not contain ${marker}`, () => {
          const text = read();
          const hit = text.match(marker);
          if (hit) {
            const line = text.slice(0, hit.index).split("\n").length;
            expect.fail(
              `${label}:${line} contains stale marker ${marker}: "${hit[0]}". ` +
                "A shipped feature is still described as future work (or vice " +
                "versa); update the doc, or ship the feature before advertising it.",
            );
          }
        });
      }
    }
  });
});
