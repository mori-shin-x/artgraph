import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "./helpers.js";

// Docs-trio consistency metatest (#139).
//
// README.md, docs/skills-guide.md, and `artgraph init --help` all describe
// the default stages of `artgraph init`, and nothing keeps them in sync
// automatically: PR #103 advertised agent-context in the README before it
// shipped (H1), and PR #129 shipped the Stop hook but left "lands in PR-B"
// in the CLI help. This test pins the three sources to a single stage list
// and rejects stale future-tense markers, so the next shipped-but-
// undocumented (or documented-but-unshipped) stage fails CI instead of
// reaching users.
//
// The stage list below is the test's single source of truth. Adding a new
// init stage means updating it here, and the assertions then force the
// README paragraph, the skills-guide section, and the CLI help text to be
// updated in the same PR.
//
// issue #175: the third source used to be a grep of `src/commands/init.ts`
// (before that, `src/cli.ts` — issue #162 moved it). Reading the CLI
// module's source text coupled this test to wherever the `init` command's
// implementation happened to live, and it broke on pure file moves with no
// behavior change. Running `artgraph init --help` through the in-process
// `runCli()` harness instead checks what a user actually sees, and stays
// correct regardless of how the command's implementation is split up.

const ROOT = resolve(import.meta.dirname, "..");

const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
const skillsGuide = readFileSync(resolve(ROOT, "docs", "skills-guide.md"), "utf8");

let helpText: string;

beforeAll(async () => {
  const { stdout, exitCode } = await run(["init", "--help"]);
  expect(exitCode).toBe(0);
  helpText = stdout;
});

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

/**
 * The free-text description paragraph of `artgraph init --help`: everything
 * between the "Usage: ..." line and the "Options:" section, with wrapped
 * lines rejoined into a single line (commander word-wraps to terminal
 * width, which would otherwise split stage mentions across lines).
 */
function cliInitDescription(): string {
  const match = helpText.match(/^Usage: artgraph init \[options\]\n\n([\s\S]*?)\n\nOptions:/m);
  if (!match) {
    throw new Error(
      "`artgraph init --help`: could not find the description paragraph between " +
        '"Usage: artgraph init [options]" and "Options:". ' +
        "If commander's help layout changed, update docs-trio-consistency.test.ts to match.",
    );
  }
  return match[1].replace(/\s+/g, " ").trim();
}

/** All --flag names listed in the "Options:" section of `artgraph init --help`. */
function cliInitOptionFlags(): string[] {
  const flags: string[] = [];
  // Anchored to exactly two leading spaces so wrapped continuation lines
  // (indented further, e.g. "...--agents (default\n  mode only...)") can't
  // be mistaken for a flag declaration.
  for (const m of helpText.matchAll(/^ {2}(--[a-z-]+)/gm)) {
    flags.push(m[1]);
  }
  return flags;
}

describe("docs-trio consistency: README / docs/skills-guide.md / `artgraph init --help` (#139)", () => {
  describe("every default stage is described by all three sources", () => {
    for (const stage of DEFAULT_STAGES) {
      it(`stage "${stage.id}" appears in the init --help description`, () => {
        expect(
          enumerationSentence(cliInitDescription(), "`artgraph init --help` description"),
        ).toMatch(stage.mention);
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
    it("init --help declares exactly the expected --no-* opt-outs", () => {
      const expected = DEFAULT_STAGES.map((s) => s.optOut)
        .filter((f): f is string => f !== null)
        .sort();
      const actual = cliInitOptionFlags()
        .filter((f) => f.startsWith("--no-"))
        .sort();
      expect(actual).toEqual(expected);
    });

    it("init --help declares no --with-* opt-ins (removed in #135)", () => {
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
      ["`artgraph init --help`", () => helpText],
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
