import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";

const TMP_DIR = resolve(import.meta.dirname, "fixtures/config-test");
const CONFIG_PATH = resolve(TMP_DIR, ".artgraph.json");

function cleanup() {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

describe("loadConfig", () => {
  afterEach(cleanup);

  it("should return default config when no file exists", () => {
    const config = loadConfig(TMP_DIR);
    expect(config.reqPatterns).toBeUndefined();
    expect(config.include).toEqual(["src/**/*.ts", "src/**/*.tsx"]);
  });

  it("should load reqPatterns from config file", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        reqPatterns: {
          listItem: "(CUSTOM-\\d+)",
          heading: "(Spec\\s+\\d+)",
        },
      }),
    );

    const config = loadConfig(TMP_DIR);
    expect(config.reqPatterns).toEqual({
      listItem: "(CUSTOM-\\d+)",
      heading: "(Spec\\s+\\d+)",
    });
  });

  it("should preserve default values for unspecified fields", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "(X-\\d+)" } }));

    const config = loadConfig(TMP_DIR);
    expect(config.reqPatterns).toEqual({ listItem: "(X-\\d+)" });
    expect(config.specDirs).toEqual(["specs", "docs"]);
  });

  it("T012: should load docGraph config with autoNodes false", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ docGraph: { autoNodes: false } }));

    const config = loadConfig(TMP_DIR);
    expect(config.docGraph?.autoNodes).toBe(false);
  });

  it("T013: should have docGraph undefined when not specified", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({}));

    const config = loadConfig(TMP_DIR);
    expect(config.docGraph).toBeUndefined();
  });

  describe("testResultPaths validation", () => {
    it("should load a valid string array", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ testResultPaths: ["a.json", "b/*.xml"] }));
      const config = loadConfig(TMP_DIR);
      expect(config.testResultPaths).toEqual(["a.json", "b/*.xml"]);
    });

    it("should reject a non-array testResultPaths", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ testResultPaths: "a.json" }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must be an array of strings");
    });

    it("should reject a non-string element (e.g. [123])", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ testResultPaths: [123] }));
      expect(() => loadConfig(TMP_DIR)).toThrow("every entry must be a string");
    });
  });

  describe("reqPatterns validation (FR-007)", () => {
    it("should reject empty reqPatterns.listItem", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must not be empty");
    });

    it("should reject invalid regex in reqPatterns.listItem", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "[invalid(" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("invalid regular expression");
    });

    it("should reject reqPatterns without capture group", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "JIRA-\\d+" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must contain at least one capture group");
    });

    it("should accept valid reqPatterns with capture groups", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ reqPatterns: { listItem: "^(JIRA-\\d+)[:\\s]" } }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.reqPatterns?.listItem).toBe("^(JIRA-\\d+)[:\\s]");
    });

    it("should accept non-capturing groups alongside capture groups", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ reqPatterns: { heading: "^(?:US|Story)(\\d+)\\s*:" } }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.reqPatterns?.heading).toBe("^(?:US|Story)(\\d+)\\s*:");
    });

    // S3: capture-group counting must rely on the regex engine, not a regex
    // heuristic that mis-judges named groups / escaped parens / char classes.
    it("should accept a named capture group", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ reqPatterns: { listItem: "^(?<id>JIRA-\\d+)[:\\s]" } }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.reqPatterns?.listItem).toBe("^(?<id>JIRA-\\d+)[:\\s]");
    });

    it("should reject a pattern whose only parens are escaped or in a char class", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "^\\(ID[(]\\d+" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must contain at least one capture group");
    });

    // S1: ReDoS mitigation — nested quantifiers and over-long patterns are rejected.
    it("should reject nested quantifiers that risk catastrophic backtracking", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "^(([a-z]+)+)$" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("nested quantifiers");
    });

    // ReDoS bypass shapes the original `/\([^)]*[+*]\)[+*]/` heuristic missed.
    // Each rejects on the strengthened detectReDoSRisk traversal.
    it.each([
      ["alternation overlap", "^(a|a)+(\\d+)$"],
      ["braced inner quantifier", "^(a{1,5})+(\\d+)$"],
      ["double-nested", "^((a+))+(\\d+)$"],
      ["non-capturing alternation overlap", "^(?:a|aa)+(\\d+)$"],
    ])("should reject ReDoS bypass: %s", (_label, pattern) => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: pattern } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("nested quantifiers");
    });

    // codeId skips the capture-group requirement but must still apply the
    // ReDoS guard — otherwise the codeId path is the widest attack surface.
    it("should reject ReDoS bypass in codeId (no capture group required path)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { codeId: "(?:a|aa)+" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("nested quantifiers");
    });

    it("should reject an over-long pattern", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      const longPattern = "^(" + "a".repeat(300) + "\\d+)";
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: longPattern } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must not exceed");
    });

    // codeId uses whole-match semantics, so a capture group is optional.
    it("should accept reqPatterns.codeId without a capture group", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { codeId: "\\d+" } }));
      const config = loadConfig(TMP_DIR);
      expect(config.reqPatterns?.codeId).toBe("\\d+");
    });

    it("should still reject an invalid regex in reqPatterns.codeId", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { codeId: "[invalid(" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("invalid regular expression");
    });
  });

  describe("taskConventions validation (FR-012)", () => {
    it("should default to undefined when not specified", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}));
      const config = loadConfig(TMP_DIR);
      expect(config.taskConventions).toBeUndefined();
    });

    it("should accept a valid user preset", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" }],
        }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.taskConventions).toEqual([
        { name: "openspec", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" },
      ]);
    });

    it("should reject a non-array taskConventions", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ taskConventions: "openspec" }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must be an array");
    });

    it("should reject empty name", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("name: must not be empty");
    });

    it("should reject duplicate built-in name without opt-out", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "spec-kit", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("collides with a built-in preset");
    });

    it("should allow a user preset to override a built-in via disableBuiltinTaskConventions", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          disableBuiltinTaskConventions: ["kiro"],
          taskConventions: [{ name: "kiro", fileStems: ["tasks"], taskIdRe: "^(K-\\d+)" }],
        }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.disableBuiltinTaskConventions).toEqual(["kiro"]);
      expect(config.taskConventions).toEqual([
        { name: "kiro", fileStems: ["tasks"], taskIdRe: "^(K-\\d+)" },
      ]);
    });

    it("should reject disableBuiltinTaskConventions naming a non-builtin", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ disableBuiltinTaskConventions: ["openspec"] }));
      expect(() => loadConfig(TMP_DIR)).toThrow('"openspec" is not a built-in');
    });

    it("should reject duplicate user name", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [
            { name: "foo", fileStems: ["tasks"], taskIdRe: "^(OS-\\d+)" },
            { name: "foo", fileStems: ["plan"], taskIdRe: "^(BAR-\\d+)" },
          ],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow('duplicate name "foo"');
    });

    it("should reject empty fileStems", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: [], taskIdRe: "^(OS-\\d+)" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("fileStems: must not be empty");
    });

    it("should reject empty taskIdRe", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: "" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("taskIdRe: must not be empty");
    });

    it("should reject over-long taskIdRe", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      const longPattern = "^(" + "a".repeat(300) + "\\d+)";
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: longPattern }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("must not exceed");
    });

    it("should reject nested quantifier in taskIdRe", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: "^(([a-z]+)+)$" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("nested quantifiers");
    });

    it("should reject invalid regex in taskIdRe", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: "[invalid(" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("invalid regular expression");
    });

    it("should reject taskIdRe without capture group", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [{ name: "openspec", fileStems: ["tasks"], taskIdRe: "^OS-\\d+" }],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("at least one capture group");
    });

    it("should accept a preset with implementsTagRe / verifiesTagRe", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [
            {
              name: "openspec",
              fileStems: ["tasks"],
              taskIdRe: "^(OS-\\d+)",
              implementsTagRe: "@impl\\(([^)]+)\\)",
              verifiesTagRe: "\\[(REQ-[\\w-]+)\\]",
            },
          ],
        }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.taskConventions?.[0].implementsTagRe).toBe("@impl\\(([^)]+)\\)");
      expect(config.taskConventions?.[0].verifiesTagRe).toBe("\\[(REQ-[\\w-]+)\\]");
    });

    it("should reject invalid implementsTagRe regex", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [
            {
              name: "openspec",
              fileStems: ["tasks"],
              taskIdRe: "^(OS-\\d+)",
              implementsTagRe: "[invalid(",
            },
          ],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("implementsTagRe: invalid regular expression");
    });

    it("should reject implementsTagRe without capture group", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [
            {
              name: "openspec",
              fileStems: ["tasks"],
              taskIdRe: "^(OS-\\d+)",
              implementsTagRe: "@impl\\([^)]+\\)",
            },
          ],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow(
        "implementsTagRe: regex must contain at least one capture group",
      );
    });

    it("should reject verifiesTagRe with nested quantifier", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [
            {
              name: "openspec",
              fileStems: ["tasks"],
              taskIdRe: "^(OS-\\d+)",
              verifiesTagRe: "(([a-z]+)+)",
            },
          ],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("nested quantifiers");
    });

    it("should reject empty implementsTagRe (explicit empty string is a typo)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          taskConventions: [
            {
              name: "openspec",
              fileStems: ["tasks"],
              taskIdRe: "^(OS-\\d+)",
              implementsTagRe: "",
            },
          ],
        }),
      );
      expect(() => loadConfig(TMP_DIR)).toThrow("implementsTagRe: must not be empty");
    });
  });

  // spec 014 — `.artgraph.json` planCoverage section. Defaults to undefined so
  // existing configs are not broken; nested fields default to lenient (false).
  describe("planCoverage (spec 014, FR-018)", () => {
    it("defaults to undefined when not specified", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}));
      const config = loadConfig(TMP_DIR);
      expect(config.planCoverage).toBeUndefined();
    });

    it("loads requireFilesSection: true", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ planCoverage: { requireFilesSection: true } }));
      const config = loadConfig(TMP_DIR);
      expect(config.planCoverage?.requireFilesSection).toBe(true);
    });

    it("loads requireFilesSection: false", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ planCoverage: { requireFilesSection: false } }));
      const config = loadConfig(TMP_DIR);
      expect(config.planCoverage?.requireFilesSection).toBe(false);
    });

    it("rejects planCoverage as a non-object (e.g. array)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ planCoverage: [1, 2, 3] }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must be an object");
    });

    it("rejects requireFilesSection if not a boolean", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ planCoverage: { requireFilesSection: "yes" } }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must be a boolean");
    });

    it("does not interfere with other top-level fields", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          planCoverage: { requireFilesSection: true },
          reqPatterns: { listItem: "^(JIRA-\\d+)[:\\s]" },
        }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.planCoverage?.requireFilesSection).toBe(true);
      expect(config.reqPatterns?.listItem).toBe("^(JIRA-\\d+)[:\\s]");
    });
  });

  describe("lockFile path traversal prevention", () => {
    it("should reject lockFile with path traversal", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ lockFile: "../../etc/evil.lock" }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must resolve within the project root");
    });

    it("should reject absolute lockFile path", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ lockFile: "/tmp/evil.lock" }));
      expect(() => loadConfig(TMP_DIR)).toThrow("must resolve within the project root");
    });

    it("should accept lockFile in subdirectory", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ lockFile: "build/.trace.lock" }));
      const config = loadConfig(TMP_DIR);
      expect(config.lockFile).toBe("build/.trace.lock");
    });

    it("should accept default lockFile path", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}));
      const config = loadConfig(TMP_DIR);
      expect(config.lockFile).toBe(".trace.lock");
    });
  });

  describe("packageManager (spec 015, FR-006, contracts §4)", () => {
    const writeConfig = (obj: Record<string, unknown>) => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(obj));
    };

    it.each(["npm", "pnpm", "bun", "deno"] as const)("accepts the valid value %s", (pm) => {
      writeConfig({ packageManager: pm });
      expect(loadConfig(TMP_DIR).packageManager).toBe(pm);
    });

    it("drops yarn to undefined AND warns to stderr (yarn is the one ex-supported PM)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        writeConfig({ packageManager: "yarn" });
        expect(loadConfig(TMP_DIR).packageManager).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/yarn.*not supported/i);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does NOT warn for an unknown non-yarn string (typo stays silent)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        writeConfig({ packageManager: "npmm" });
        expect(loadConfig(TMP_DIR).packageManager).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("drops a non-string value (number) to undefined", () => {
      writeConfig({ packageManager: 123 });
      expect(loadConfig(TMP_DIR).packageManager).toBeUndefined();
    });

    it("is undefined when the field is absent", () => {
      writeConfig({});
      expect(loadConfig(TMP_DIR).packageManager).toBeUndefined();
    });
  });

  describe("ignoreIdPrefixes validation (issue #216)", () => {
    it("should load a valid ignoreIdPrefixes array", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ ignoreIdPrefixes: ["SC", "Requirement"] }));
      expect(loadConfig(TMP_DIR).ignoreIdPrefixes).toEqual(["SC", "Requirement"]);
    });

    it("should be undefined when the field is absent", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, "{}");
      expect(loadConfig(TMP_DIR).ignoreIdPrefixes).toBeUndefined();
    });

    it("should accept an empty array (nothing ignored)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ ignoreIdPrefixes: [] }));
      expect(loadConfig(TMP_DIR).ignoreIdPrefixes).toEqual([]);
    });

    it("should reject a non-array value", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ ignoreIdPrefixes: "SC" }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/must be an array of strings/);
    });

    it("should reject an empty-string entry", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ ignoreIdPrefixes: [""] }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/non-empty string/);
    });

    it("should reject a non-string entry", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ ignoreIdPrefixes: [42] }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/non-empty string/);
    });

    it.each([["SC-"], ["SC-\\d+"], ["sc"], ["1SC"], ["SC 001"]])(
      "should reject an entry outside the prefix grammar: %s",
      (entry) => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ ignoreIdPrefixes: [entry] }));
        expect(() => loadConfig(TMP_DIR)).toThrow(/bare ID prefix/);
      },
    );
  });

  describe("top-level JSON shape", () => {
    // Hand-edited configs can accidentally produce a non-object root
    // (array / number / string / null). The old code silently fell back to
    // every default because every `raw.<field>` was just `undefined`. Now we
    // reject the wrong root shape up front with a clear message.
    it.each([
      ["array", "[1, 2, 3]"],
      ["number", "42"],
      ["string", '"hello"'],
      ["null", "null"],
    ])("rejects a non-object root: %s", (_label, raw) => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, raw);
      expect(() => loadConfig(TMP_DIR)).toThrow(/must be a JSON object/);
    });

    it("accepts an empty object root", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, "{}");
      expect(() => loadConfig(TMP_DIR)).not.toThrow();
    });
  });
});
