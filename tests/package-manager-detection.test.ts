import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  buildExecCommand,
  buildInstallCommand,
} from "../src/package-manager.js";

// Truth table fixtures per
// specs/015-pkg-mgr-agnostic/contracts/package-manager.md §1 (SC-001).

let dir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-detect-"));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content = "") => writeFileSync(join(dir, name), content);
const pkg = (extra: Record<string, unknown> = {}) =>
  write("package.json", JSON.stringify({ name: "x", ...extra }));

describe("detectPackageManager — truth table (SC-001)", () => {
  it("1a: packageManager field pnpm@* → pnpm", () => {
    pkg({ packageManager: "pnpm@9.0.0" });
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("1b: packageManager field bun@* → bun", () => {
    pkg({ packageManager: "bun@1.1.0" });
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("1c: packageManager field npm@* → npm", () => {
    pkg({ packageManager: "npm@10.0.0" });
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("1d: packageManager field yarn@* → pnpm + warn", () => {
    pkg({ packageManager: "yarn@4.0.0" });
    expect(detectPackageManager(dir)).toBe("pnpm");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/yarn/i));
  });

  it("2a: bun.lockb → bun", () => {
    pkg();
    write("bun.lockb");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("2a: bun.lock (text) → bun", () => {
    pkg();
    write("bun.lock");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("2b: no package.json + deno.json → deno", () => {
    write("deno.json", "{}");
    expect(detectPackageManager(dir)).toBe("deno");
  });

  it("2b: no package.json + deno.lock → deno", () => {
    write("deno.lock");
    expect(detectPackageManager(dir)).toBe("deno");
  });

  it("2c: pnpm-lock.yaml → pnpm", () => {
    pkg();
    write("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("2d: yarn.lock → pnpm + warn", () => {
    pkg();
    write("yarn.lock");
    expect(detectPackageManager(dir)).toBe("pnpm");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/yarn/i));
  });

  it("2e: package-lock.json → npm (explicit npm signal)", () => {
    pkg();
    write("package-lock.json");
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("3: package.json only (no signal) → pnpm default", () => {
    pkg();
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("4: empty dir (no package.json / lockfile / deno) → null + warn", () => {
    expect(detectPackageManager(dir)).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/cannot detect/i));
  });

  it("deno is ignored when package.json is present (Node project wins)", () => {
    pkg();
    write("deno.json", "{}");
    // No deno lockfile branch fires; falls through to pnpm default.
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("first-match: bun.lockb beats pnpm-lock.yaml", () => {
    pkg();
    write("bun.lockb");
    write("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("malformed packageManager field falls through to lockfile sniff", () => {
    pkg({ packageManager: "not-a-pm" });
    write("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("field wins over a conflicting lockfile (corepack convention)", () => {
    pkg({ packageManager: "pnpm@9" });
    write("package-lock.json");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });
});

describe("buildExecCommand (SC-003, contracts §2)", () => {
  it("maps each PM to its exec prefix", () => {
    expect(buildExecCommand("npm", "check --diff")).toBe("npx artgraph check --diff");
    expect(buildExecCommand("pnpm", "check --diff")).toBe("pnpm exec artgraph check --diff");
    expect(buildExecCommand("bun", "check --diff")).toBe("bunx artgraph check --diff");
    expect(buildExecCommand("deno", "check --diff")).toBe(
      "deno run -A npm:artgraph/cli check --diff",
    );
  });

  it("omits trailing space when subcommand is empty", () => {
    expect(buildExecCommand("pnpm")).toBe("pnpm exec artgraph");
    expect(buildExecCommand("pnpm", "  ")).toBe("pnpm exec artgraph");
    // Empty subcommand with a multi-word prefix must not leave a trailing space.
    expect(buildExecCommand("deno")).toBe("deno run -A npm:artgraph/cli");
  });

  it("trims surrounding whitespace around the subcommand", () => {
    expect(buildExecCommand("npm", "  check --diff  ")).toBe("npx artgraph check --diff");
  });
});

describe("buildInstallCommand (contracts §3)", () => {
  it("maps each PM to its dev-dep install command", () => {
    expect(buildInstallCommand("npm")).toBe("npm install -D artgraph");
    expect(buildInstallCommand("pnpm")).toBe("pnpm add -D artgraph");
    expect(buildInstallCommand("bun")).toBe("bun add -d artgraph");
    expect(buildInstallCommand("deno")).toBe("deno add npm:artgraph");
  });
});

describe("detectPackageManager — packageManager field edge cases", () => {
  // Bare "<pm>" (no @version) is not a valid Corepack-style spec; the TS
  // detector requires `^([a-z]+)@`, and the template prose states the same
  // rule ("a value without an `@version` suffix is ignored"), so both must
  // fall through to lockfile sniffing. Without the fallthrough,
  // `{ "packageManager": "npm" }` on a pnpm project would mis-route the user
  // to npm install commands.
  for (const bare of ["npm", "pnpm", "bun", "yarn"] as const) {
    it(`bare "${bare}" (no @version) falls through to default pnpm`, () => {
      pkg({ packageManager: bare });
      expect(detectPackageManager(dir)).toBe("pnpm");
      // Yarn fallthrough must NOT log the yarn warning — the field is
      // malformed, not a recognized yarn signal.
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringMatching(/yarn is not supported/i));
    });
  }

  it("BOM-prefixed package.json still parses packageManager", () => {
    writeFileSync(
      join(dir, "package.json"),
      "﻿" + JSON.stringify({ name: "x", packageManager: "npm@10.0.0" }),
    );
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("BOM-prefixed package.json with no field still detects pnpm default", () => {
    writeFileSync(join(dir, "package.json"), "﻿" + JSON.stringify({ name: "x" }));
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  for (const value of ['"hello"', "[]", "null", "42"]) {
    it(`non-object JSON ${value} as package.json falls through`, () => {
      writeFileSync(join(dir, "package.json"), value);
      // No lockfile / deno marker, package.json is a "file" (statSync.isFile),
      // but it's non-object so packageManager parse returns null AND the
      // fallback `hasPkgJson` branch fires → pnpm default.
      expect(detectPackageManager(dir)).toBe("pnpm");
    });
  }
});

describe("detectPackageManager — directory-named lockfiles", () => {
  it("a directory named bun.lockb is NOT detected as bun (isFile guard)", () => {
    pkg();
    mkdirSync(join(dir, "bun.lockb"));
    // Falls through to pnpm default (package.json present, no real lockfile).
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("a directory named package-lock.json is NOT detected as npm", () => {
    pkg();
    mkdirSync(join(dir, "package-lock.json"));
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("a directory named package.json on its own is not treated as a Node project", () => {
    mkdirSync(join(dir, "package.json"));
    // No real package.json, no lockfile, no deno marker → null.
    expect(detectPackageManager(dir)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// SC-007 prose<->TS rule-level sync (meta-test). Since issue #141 the Skill
// templates carry the detection logic as PROSE rules, not an executable bash
// snippet, so parity can no longer be checked by running the template. Instead
// this meta-test asserts that the prose rule lists -- the "Detection rules"
// section of templates/skills/_shared/package-manager.md and Step 2 of
// templates/skills/artgraph-setup/SKILL.md -- still mention every load-bearing
// token of each rule detectPackageManager() implements, in the same precedence
// order. If either template drifts from src/package-manager.ts (rule removed,
// mapping changed, precedence reordered), a pattern or order check fails here.
// -----------------------------------------------------------------------------

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(__dirname, "..", ...segments), "utf-8");
}

// Slice out one markdown section: from `heading` up to the next heading of the
// same level (end of file if none). Throws when the heading disappears, so a
// template restructure cannot silently skip the sync checks.
function extractSection(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start === -1) throw new Error(`could not find heading in template: ${heading}`);
  const level = /^#+/.exec(heading)?.[0] ?? "#";
  const body = md.slice(start + heading.length);
  const next = body.search(new RegExp(`^${level} `, "m"));
  return next === -1 ? body : body.slice(0, next);
}

describe("SC-007 prose<->TS rule-level sync (meta-test)", () => {
  // Both prose copies of the detection rules must pass the same checks: the
  // canonical rule list in the shared template and the inlined Step 2 rules in
  // the artgraph-setup Skill (which runs during bootstrap and cannot call TS).
  const sources: { label: string; rules: string }[] = [
    {
      label: "_shared/package-manager.md Detection rules",
      rules: extractSection(
        readRepoFile("templates", "skills", "_shared", "package-manager.md"),
        "## Detection rules",
      ),
    },
    {
      label: "artgraph-setup/SKILL.md Step 2",
      rules: extractSection(
        readRepoFile("templates", "skills", "artgraph-setup", "SKILL.md"),
        "### 2. Detect the package manager",
      ),
    },
  ];

  // One row per rule of detectPackageManager() in src/package-manager.ts.
  // Each pattern pins the load-bearing tokens of that rule (signal, outcome,
  // warning) within a single prose line, tolerating surrounding wording.
  const ruleChecks: { label: string; pattern: RegExp }[] = [
    {
      label: "1: top-level packageManager field, Corepack-style <pm>@<version>",
      pattern: /packageManager[^\n]*Corepack-style/,
    },
    {
      label: "1: field npm/pnpm/bun accepted verbatim",
      pattern: /`npm`[^\n]*`pnpm`[^\n]*`bun`[^\n]*use that PM/,
    },
    {
      label: "1: field yarn falls back to pnpm with a warning",
      pattern: /`yarn`[^\n]*\*\*pnpm\*\*[^\n]*warn/,
    },
    {
      label: "1: value without @version suffix is ignored (bare name is malformed)",
      pattern: /@version/,
    },
    {
      label: "1: absent/malformed field falls through to lockfile sniffing",
      pattern: /absent, malformed[^\n]*continue to rule 2/,
    },
    {
      label: "2: bun.lockb or bun.lock selects bun",
      pattern: /`bun\.lockb` or `bun\.lock`[^\n]*\*\*bun\*\*/,
    },
    {
      label: "2: deno markers without package.json select deno",
      pattern:
        /`deno\.lock`, `deno\.json`, or `deno\.jsonc`[^\n]*no[^\n]*`package\.json`[^\n]*\*\*deno\*\*/,
    },
    {
      label: "2: pnpm-lock.yaml selects pnpm",
      pattern: /`pnpm-lock\.yaml`[^\n]*\*\*pnpm\*\*/,
    },
    {
      label: "2: yarn.lock falls back to pnpm with a warning",
      pattern: /`yarn\.lock`[^\n]*\*\*pnpm\*\*[^\n]*warn/,
    },
    {
      label: "2: package-lock.json selects npm",
      pattern: /`package-lock\.json`[^\n]*\*\*npm\*\*/,
    },
    {
      label: "2: only regular files count as lockfile signals (isFile guard)",
      pattern: /regular files?/,
    },
    {
      label: "3: package.json without other signals defaults to pnpm",
      pattern: /`package\.json` exists but nothing above matched[^\n]*default to \*\*pnpm\*\*/,
    },
    {
      label: "4: nothing matched means detection fails and the user is asked",
      pattern: /[Nn]othing matched at all[^\n]*detection fails/,
    },
    {
      label: "4: failure message says the PM cannot be detected",
      pattern: /[Cc]annot detect/,
    },
  ];

  for (const src of sources) {
    describe(src.label, () => {
      for (const check of ruleChecks) {
        it(`mentions rule ${check.label}`, () => {
          expect(src.rules).toMatch(check.pattern);
        });
      }

      it("keeps rule mentions in TS precedence order", () => {
        // Scan the section for each rule's anchor token strictly after the
        // previous anchor's match, mirroring the order detectPackageManager()
        // evaluates the rules. A reordered prose list (changed precedence)
        // breaks the chain even when every token is still present, while
        // incidental earlier mentions in intro prose (e.g. the setup Skill's
        // "signals disagree" example) stay tolerated. Lowercased to bridge
        // "Cannot"/"cannot" wording.
        const anchors = [
          "packagemanager", // rule 1: field wins over lockfiles
          "`bun.lockb`", // rule 2, first lockfile branch
          "`deno.lock`",
          "`pnpm-lock.yaml`",
          "`yarn.lock`",
          "`package-lock.json`",
          "default to **pnpm**", // rule 3
          "cannot detect", // rule 4
        ];
        const haystack = src.rules.toLowerCase();
        let cursor = -1;
        for (const anchor of anchors) {
          const idx = haystack.indexOf(anchor, cursor + 1);
          expect(idx, `anchor missing or out of order: ${anchor}`).toBeGreaterThan(cursor);
          cursor = idx;
        }
      });
    });
  }

  it("shared template quotes the TS warning/error messages verbatim", () => {
    // The shared template tells agents to relay these messages with the same
    // wording the TS detector writes to stderr. Assert the exact strings
    // appear in BOTH files, so rewording either side breaks the sync here.
    const template = readRepoFile("templates", "skills", "_shared", "package-manager.md");
    const tsSource = readRepoFile("src", "package-manager.ts");
    const messages = [
      "packageManager=yarn but Yarn is not supported; falling back to pnpm",
      "yarn.lock found but Yarn is not supported; falling back to pnpm",
      "Cannot detect package manager; ask the user which to use",
    ];
    for (const message of messages) {
      expect(tsSource).toContain(message);
      expect(template).toContain(message);
    }
  });

  it("shared template declares the SC-007 sync contract against the TS source", () => {
    const template = readRepoFile("templates", "skills", "_shared", "package-manager.md");
    expect(template).toContain("SC-007");
    expect(template).toContain("src/package-manager.ts");
  });
});
