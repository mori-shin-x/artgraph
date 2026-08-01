// issue #422 — `artgraph init` detected Kiro, wrote the Kiro integration, and
// then handed the project a `.artgraph.json` whose `specDirs` was still the
// default `["specs", "docs"]`. Kiro keeps its specs in `.kiro/specs/`, so the
// very first scan found zero requirements and zero docs, and the init summary
// said "@impl tags found, but no matching specs yet" — the exact opposite of
// the truth.
//
// Three changes ship together here, because fixing only the first one leaves
// the symptom in place for a measured 41.5% of real Kiro spec files:
//
//   (1) `detectProject` probes each SDD tool's SPECS directory and
//       `generateConfig` appends it to `specDirs` (never substitutes).
//   (2) the Kiro heading grammar accepts the bare `### Requirement 1`
//       spelling, not just `### Requirement 1: Title`.
//   (3) `rename`'s heading rewriter is widened in lockstep with (2), so a
//       heading that is now RECOGNIZED as a requirement is also RENAMEABLE.
//       Without that pairing `artgraph rename` reports success while silently
//       leaving the heading untouched.
//
// `artgraph doctor` gets an advisory for the population (1) cannot reach:
// projects initialized before this version, whose `specDirs` `init --force`
// deliberately preserves rather than re-derives.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectProject, generateConfig, runInit } from "../src/init.js";
import { loadConfig } from "../src/config.js";
import { parseMarkdownContent } from "../src/parsers/markdown.js";
import { rewriteSpecHeading } from "../src/rename.js";
import { runDoctor, type DoctorFinding } from "../src/doctor.js";
import { createFreshProject, type FreshProject } from "./agents/helpers.js";
import type { DetectionResult } from "../src/types.js";

const KIRO_SPECS = ".kiro/specs";
const SPECIFY_SPECS = ".specify/specs";

/** Requirements file holding both heading spellings Kiro emits in the wild. */
const REQUIREMENTS_MD = [
  "# Requirements Document",
  "",
  "## Requirements",
  "",
  "### Requirement 1: Federated authentication",
  "",
  "**User Story:** As a user, I want to sign in.",
  "",
  "### Requirement 2",
  "",
  "**User Story:** As a user, I want rate limiting.",
  "",
].join("\n");

function mkdirp(root: string, rel: string): void {
  mkdirSync(join(root, ...rel.split("/")), { recursive: true });
}

function write(root: string, rel: string, content: string): void {
  const parts = rel.split("/");
  mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), content, "utf-8");
}

function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".artgraph.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// (1a) detectProject / generateConfig — which directories reach `specDirs`
// ---------------------------------------------------------------------------

describe("issue #422 — generateConfig seeds an SDD tool's spec directory", () => {
  let proj: FreshProject;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  // F1 — the whole point of the issue. A Kiro-only project must not be handed
  // a specDirs of two directories that do not exist plus the one that does:
  // the SDD append happens BEFORE the "nothing found, fall back to the
  // defaults" branch, so the fallback never fires here.
  it("F1: a repo whose only spec tree is .kiro/specs gets exactly that one entry", () => {
    mkdirp(proj.dir, KIRO_SPECS);
    const config = generateConfig(detectProject(proj.dir));
    expect(config.specDirs).toEqual([KIRO_SPECS]);
  });

  // F2 — appended, never substituted, and in a pinned order. A Kiro project
  // that also keeps a `docs/` tree still wants `docs/` scanned.
  it("F2: specs/ and docs/ are kept alongside .kiro/specs, in that order", () => {
    mkdirp(proj.dir, "specs");
    mkdirp(proj.dir, "docs");
    mkdirp(proj.dir, KIRO_SPECS);
    const config = generateConfig(detectProject(proj.dir));
    expect(config.specDirs).toEqual(["specs", "docs", KIRO_SPECS]);
  });

  // F3 — the self-detection trap, with its positive control in the same test.
  // `init --agents=kiro` creates `.kiro/skills/` and `.kiro/hooks/` itself, so
  // a `.kiro/` on disk proves only that artgraph has run before. Keying the
  // decision on `.kiro` rather than `.kiro/specs` would put artgraph's own
  // distributed SKILL.md files into the graph as doc nodes, and every artgraph
  // upgrade that edits a Skill would then read as lock drift downstream.
  it("F3: artgraph's own .kiro/skills + .kiro/hooks do NOT seed a spec dir, while .kiro/specs does", () => {
    mkdirp(proj.dir, "specs");
    mkdirp(proj.dir, "docs");
    mkdirp(proj.dir, ".kiro/skills");
    mkdirp(proj.dir, ".kiro/hooks");

    const detectedWithoutSpecs = detectProject(proj.dir);
    expect(detectedWithoutSpecs.sddTools.map((t) => t.name)).toContain("Kiro");
    expect(detectedWithoutSpecs.sddTools.find((t) => t.name === "Kiro")!.specDir).toBeUndefined();
    expect(generateConfig(detectedWithoutSpecs).specDirs).toEqual(["specs", "docs"]);

    // Positive control on the same tree: add the specs dir and the entry appears.
    mkdirp(proj.dir, KIRO_SPECS);
    const detectedWithSpecs = detectProject(proj.dir);
    expect(detectedWithSpecs.sddTools.find((t) => t.name === "Kiro")!.specDir).toBe(KIRO_SPECS);
    expect(generateConfig(detectedWithSpecs).specDirs).toEqual(["specs", "docs", KIRO_SPECS]);
  });

  // F4 — Spec Kit has the identical defect; the fix is the same branch.
  it("F4: .specify/specs is seeded the same way (Spec Kit symmetry)", () => {
    mkdirp(proj.dir, SPECIFY_SPECS);
    const config = generateConfig(detectProject(proj.dir));
    expect(config.specDirs).toEqual([SPECIFY_SPECS]);
  });

  // F5 — both tools present.
  it("F5: a repo with both tools gets both spec directories", () => {
    mkdirp(proj.dir, SPECIFY_SPECS);
    mkdirp(proj.dir, KIRO_SPECS);
    const config = generateConfig(detectProject(proj.dir));
    expect(config.specDirs).toEqual([SPECIFY_SPECS, KIRO_SPECS]);
  });

  // F6 — back-compat for hand-built literals: `integrations` and the new
  // `specDir` are both optional, and a caller that omits them must not crash.
  it("F6: a DetectionResult literal without integrations / specDir still generates a config", () => {
    const legacy: DetectionResult = {
      hasSrc: true,
      hasSpecs: true,
      hasDocs: false,
      sddTools: [{ name: "Kiro", marker: ".kiro" }],
    };
    expect(legacy.integrations).toBeUndefined();
    const config = generateConfig(legacy);
    expect(config.specDirs).toEqual(["specs"]);
  });

  // F9 — the append can only ever add SIBLINGS of the existing entries, so it
  // can never produce the parent/child shape `loadConfig` silently filters
  // (issue #234). Second half shows what that filtering does, so the first
  // half is not just an assertion about an unreachable state.
  it("F9: no hasSpecs x hasDocs x tool combination yields a parent/child specDirs pair, which loadConfig would drop", () => {
    const combos: DetectionResult[] = [];
    for (const hasSpecs of [false, true]) {
      for (const hasDocs of [false, true]) {
        for (const specify of [undefined, SPECIFY_SPECS]) {
          for (const kiro of [undefined, KIRO_SPECS]) {
            combos.push({
              hasSrc: true,
              hasSpecs,
              hasDocs,
              sddTools: [
                ...(specify ? [{ name: "Spec Kit", marker: ".specify", specDir: specify }] : []),
                ...(kiro ? [{ name: "Kiro", marker: ".kiro", specDir: kiro }] : []),
              ],
            });
          }
        }
      }
    }
    expect(combos).toHaveLength(16);

    for (const detection of combos) {
      const dirs = generateConfig(detection).specDirs;
      expect(new Set(dirs).size, JSON.stringify(dirs)).toBe(dirs.length);
      for (const a of dirs) {
        for (const b of dirs) {
          if (a === b) continue;
          expect(b.startsWith(a + "/"), `${b} is a descendant of ${a}`).toBe(false);
        }
      }
    }

    // What the shape above avoids: an ancestor entry swallows its descendant
    // at load time, so a config that listed both would lose `.kiro/specs`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      write(
        proj.dir,
        ".artgraph.json",
        JSON.stringify({ specDirs: [".kiro", KIRO_SPECS], include: ["src/**/*.ts"] }),
      );
      expect(loadConfig(proj.dir).specDirs).toEqual([".kiro"]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// (1b) runInit end-to-end — the behaviour the issue actually reported
// ---------------------------------------------------------------------------

describe("issue #422 — init's first scan sees a Kiro project's requirements", () => {
  let proj: FreshProject;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  // F7 — the reported symptom, end to end. Every other init test in this repo
  // runs with `--no-scan`, so nothing before this one could observe that the
  // first scan came back empty on a Kiro project.
  //
  // Deliberately runs the Skills stage as well: it is what creates
  // `.kiro/skills/`, and the doc count below is what proves those distributed
  // SKILL.md files did NOT enter the graph.
  it("F7: `init --agents=kiro` scans .kiro/specs and reports a non-zero reqCount", () => {
    write(proj.dir, ".kiro/specs/auth/requirements.md", REQUIREMENTS_MD);
    write(proj.dir, "src/app.ts", "export const x = 1;\n");

    const result = runInit(proj.dir, { agents: ["kiro"], noIntegrate: true, noHooks: true });

    expect(result.config.specDirs).toEqual([KIRO_SPECS]);
    expect(readConfig(proj.dir).specDirs).toEqual([KIRO_SPECS]);

    // Both heading spellings in the fixture became requirements.
    expect(result.scanSummary!.reqCount).toBe(2);

    // The Skills stage really did create `.kiro/skills/` before the scan ran —
    // this is the self-detection trap F3 covers, here in its live form — and
    // exactly one doc node exists, the requirements file. Had `specDirs`
    // keyed on `.kiro`, every distributed SKILL.md would be a doc node too.
    expect(existsSync(join(proj.dir, ".kiro", "skills"))).toBe(true);
    expect(result.scanSummary!.docCount).toBe(1);
  });

  // F8 — the `--force` contract (`tests/init.test.ts` pins the general form).
  // `--force` MERGES an existing config instead of re-deriving detection
  // fields, and that must keep holding now that `specDirs` has a new source.
  it("F8: `init --force` leaves an existing specDirs alone even when .kiro/specs is present", () => {
    write(proj.dir, ".kiro/specs/auth/requirements.md", REQUIREMENTS_MD);
    write(proj.dir, ".artgraph.json", JSON.stringify({ specDirs: ["my-specs"] }));

    runInit(proj.dir, { force: true, minimal: true });

    expect(readConfig(proj.dir).specDirs).toEqual(["my-specs"]);
  });
});

// ---------------------------------------------------------------------------
// (2) heading grammar — the bare spelling
// ---------------------------------------------------------------------------

describe("issue #422 — Kiro heading grammar accepts a bare number", () => {
  function reqIdsOf(markdown: string): string[] {
    return parseMarkdownContent(markdown, "requirements.md")
      .nodes.filter((n) => n.kind === "req")
      .map((n) => n.id);
  }

  // F10 + F11 + F12 in one test: the widening, its positive control, and the
  // prose heading that must stay OUT. The three belong together — the
  // narrower `:?` spelling of the same widening would pass F10 and F11 while
  // silently flipping F12 to accept.
  it("F10/F11/F12: bare and titled numbers define a requirement; a prose heading does not", () => {
    // F11 — positive control, the spelling that always worked.
    expect(reqIdsOf("### Requirement 1: Federated authentication")).toEqual(["Requirement-1"]);

    // F10 — the widening. 41.5% of measured real-world Kiro headings.
    expect(reqIdsOf("### Requirement 2")).toEqual(["Requirement-2"]);

    // F12 — prose is not a definition. `:?` would accept this one.
    expect(reqIdsOf("### Requirement 3 is important")).toEqual([]);

    // Neighbouring shapes that must also stay out, so the assertion above is
    // not carrying the whole negative side on its own.
    expect(reqIdsOf("### Requirements")).toEqual([]);
    expect(reqIdsOf("### Requirement Completeness")).toEqual([]);
  });

  it("recognizes the bare spelling at every heading level Kiro emits", () => {
    expect(reqIdsOf("## Requirement 4")).toEqual(["Requirement-4"]);
    expect(reqIdsOf("### Requirement 5")).toEqual(["Requirement-5"]);
    expect(reqIdsOf("#### Requirement 6")).toEqual(["Requirement-6"]);
  });
});

// ---------------------------------------------------------------------------
// (3) rename parity — recognized implies renameable
// ---------------------------------------------------------------------------

describe("issue #422 — rename rewrites both heading spellings", () => {
  // F13 + F14. The pairing is the point: widening only the RECOGNITION regex
  // produces a heading that `check` treats as a requirement and that `rename`
  // reports as successfully renamed while leaving the file byte-identical.
  it("F13/F14: the bare spelling is rewritten, and so is the titled one", () => {
    // F14 — positive control.
    const titled = rewriteSpecHeading(
      "### Requirement 1: Federated authentication",
      "Requirement-1",
      "Requirement-9",
    );
    expect(titled.content).toBe("### Requirement 9: Federated authentication");
    expect(titled.changes).toHaveLength(1);

    // F13 — the parity case. Fails when only the recognition side is widened.
    const bare = rewriteSpecHeading("### Requirement 1", "Requirement-1", "Requirement-9");
    expect(bare.content).toBe("### Requirement 9");
    expect(bare.changes).toHaveLength(1);
    expect(bare.changes[0].kind).toBe("spec-heading");
  });

  it("preserves trailing whitespace and does not match a longer number", () => {
    // The captured separator run is replayed verbatim, so padding survives.
    expect(
      rewriteSpecHeading("### Requirement 1   ", "Requirement-1", "Requirement-9").content,
    ).toBe("### Requirement 9   ");

    // `### Requirement 12` must not be rewritten when renaming number 1 —
    // the alternation requires a colon or the end of the line right after it.
    const other = rewriteSpecHeading("### Requirement 12", "Requirement-1", "Requirement-9");
    expect(other.content).toBe("### Requirement 12");
    expect(other.changes).toHaveLength(0);
  });

  it("leaves a prose heading alone (mirrors the recognition side)", () => {
    const prose = rewriteSpecHeading(
      "### Requirement 1 is important",
      "Requirement-1",
      "Requirement-9",
    );
    expect(prose.content).toBe("### Requirement 1 is important");
    expect(prose.changes).toHaveLength(0);
  });

  it("rewrites a heading closed with an ATX closing sequence", () => {
    // mdast strips a closing `###` before the recognition regex sees the
    // text, so `### Requirement 1 ###` IS recognized as a requirement. Only
    // the rewriter reads the raw line, which is why the two sides can
    // disagree here and nowhere else. Widening recognition to the bare
    // spelling without this branch produces a heading that renames to
    // nothing while `rename` reports success.
    const closed = rewriteSpecHeading("### Requirement 1 ###", "Requirement-1", "Requirement-9");
    expect(closed.content).toBe("### Requirement 9 ###");
    expect(closed.changes).toHaveLength(1);

    // Negative control in the same `it()`: the `#+` branch must not be a
    // door into prose. Both of these end in text, not in the line ending, so
    // neither side accepts them.
    const proseHash = rewriteSpecHeading(
      "### Requirement 1 ### and then some",
      "Requirement-1",
      "Requirement-9",
    );
    expect(proseHash.content).toBe("### Requirement 1 ### and then some");
    expect(proseHash.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (4) doctor advisory — the population `init` cannot reach
// ---------------------------------------------------------------------------

describe("issue #422 — doctor advisory for an uncovered SDD spec directory", () => {
  let proj: FreshProject;

  beforeEach(() => {
    proj = createFreshProject();
  });

  afterEach(() => {
    proj.cleanup();
  });

  function findingsOf(dir: string): DoctorFinding[] {
    return runDoctor({ rootDir: dir }).findings.filter(
      (f) => f.kind === "config-specdir-missing-sdd-tool",
    );
  }

  function initClaude(dir: string): void {
    runInit(dir, {
      agents: ["claude"],
      noScan: true,
      noIntegrate: true,
      noHooks: true,
      force: true,
    });
  }

  // F16 + F17. The negative control shares the test so an advisory that
  // simply never fires cannot pass as "correctly silent".
  it("F16/F17: fires when specDirs misses .kiro/specs, and is silent once an entry covers it", () => {
    write(proj.dir, ".kiro/specs/auth/requirements.md", REQUIREMENTS_MD);
    initClaude(proj.dir);
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
        specDirs: ["specs", "docs"],
        agents: ["claude"],
      }),
    );

    // F16 — advisory present, and advisory ONLY: severity `pass`, so the
    // doctor exit code is untouched (same contract as the `agents`-field and
    // pool-protection advisories).
    const report = runDoctor({ rootDir: proj.dir });
    const found = report.findings.filter((f) => f.kind === "config-specdir-missing-sdd-tool");
    expect(found, JSON.stringify(report.findings, null, 2)).toHaveLength(1);
    expect(found[0].severity).toBe("pass");
    expect(found[0].agent).toBeNull();
    expect(found[0].path).toBe(".artgraph.json");
    expect(found[0].message).toContain(KIRO_SPECS);
    expect(report.summary.failCount).toBe(0);

    // F17 — same tree, config extended: the advisory goes away.
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
        specDirs: ["specs", "docs", KIRO_SPECS],
        agents: ["claude"],
      }),
    );
    expect(findingsOf(proj.dir)).toEqual([]);
  });

  it("treats an ancestor entry as covering, and normalizes before comparing", () => {
    write(proj.dir, ".kiro/specs/auth/requirements.md", REQUIREMENTS_MD);
    initClaude(proj.dir);

    const base = {
      include: ["src/**/*.ts", "!**/node_modules/**"],
      testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      agents: ["claude"],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Ancestor entry covers the descendant.
      write(proj.dir, ".artgraph.json", JSON.stringify({ ...base, specDirs: [".kiro"] }));
      expect(findingsOf(proj.dir)).toEqual([]);

      // Same entry, spelled with a leading `./` and a trailing `/`.
      write(proj.dir, ".artgraph.json", JSON.stringify({ ...base, specDirs: ["./.kiro/specs/"] }));
      expect(findingsOf(proj.dir)).toEqual([]);

      // Prefix collision must NOT count as covering (positive control for the
      // two negatives above).
      write(proj.dir, ".artgraph.json", JSON.stringify({ ...base, specDirs: [".kiro-archive"] }));
      expect(findingsOf(proj.dir)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when only artgraph's own .kiro/skills is on disk, but fires once .kiro/specs appears", () => {
    initClaude(proj.dir);
    write(
      proj.dir,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts", "!**/node_modules/**"],
        testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
        specDirs: ["specs", "docs"],
        agents: ["claude"],
      }),
    );
    mkdirp(proj.dir, ".kiro/skills");
    mkdirp(proj.dir, ".kiro/hooks");
    expect(findingsOf(proj.dir)).toEqual([]);

    mkdirp(proj.dir, KIRO_SPECS);
    expect(findingsOf(proj.dir)).toHaveLength(1);
  });
});
