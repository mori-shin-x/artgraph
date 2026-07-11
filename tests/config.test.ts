import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { scan } from "../src/scan.js";

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

  // issue #234 — parent/child specDirs (e.g. `["specs", "specs/sub"]`) made
  // builder.ts glob the same file twice under two different specDirPrefixes,
  // producing two doc nodes for one physical file. loadConfig now filters
  // descendant entries and warns instead of letting the collision reach the
  // builder.
  describe("specDirs parent/child dedup (issue #234)", () => {
    const writeConfig = (obj: Record<string, unknown>) => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(obj));
    };

    it("T234-1: filters descendant specDirs and warns", () => {
      writeConfig({ specDirs: ["specs", "specs/sub"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("specs/sub"));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('descendant of "specs"'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-2: dedups exact-duplicate specDirs", () => {
      writeConfig({ specDirs: ["specs", "specs"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("duplicate entry"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-3: does not filter unrelated sibling specDirs", () => {
      writeConfig({ specDirs: ["specs", "docs"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs", "docs"]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-4: prefix collision is not mistaken for ancestor (specs vs specs2)", () => {
      writeConfig({ specDirs: ["specs", "specs2"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs", "specs2"]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-5: filters all descendants regardless of depth", () => {
      writeConfig({ specDirs: ["specs", "specs/a", "specs/a/b"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]);
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-13: cites the shortest surviving ancestor, not a dropped intermediate one (MINOR 2)", () => {
      writeConfig({ specDirs: ["a/x", "a", "a/x/y"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["a"]);
        expect(
          warnSpy.mock.calls.some(
            (call) =>
              String(call[0]).includes('"a/x/y"') && String(call[0]).includes('descendant of "a"'),
          ),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-6: filters descendant even when it appears before the ancestor", () => {
      writeConfig({ specDirs: ["specs/sub", "specs"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-7: builder does not create ghost doc nodes for parent+child specDirs", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-specdirs-234");
      const tmpSub = resolve(tmpRoot, "specs", "sub");
      mkdirSync(tmpSub, { recursive: true });
      writeFileSync(resolve(tmpSub, "x.md"), "- REQ-1: something\n");
      writeFileSync(
        resolve(tmpRoot, ".artgraph.json"),
        JSON.stringify({ specDirs: ["specs", "specs/sub"], mode: "file" }),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(tmpRoot);
        const { graph } = scan(tmpRoot, cfg);
        const docIds = [...graph.nodes.keys()].filter((k) => k.startsWith("doc:"));
        expect(docIds).toEqual(["doc:sub/x.md"]);
        // REQ nodes dedup by ID regardless of the parent/child specDirs bug, so
        // this alone wouldn't have caught the ghost-doc regression — pinned
        // here anyway to document the "req: 1" behavior from issue #234.
        expect([...graph.nodes.keys()].filter((k) => /^REQ-/.test(k))).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        rmSync(tmpRoot, { recursive: true });
      }
    });

    it("T234-8: trailing slash on ancestor still triggers descendant filter", () => {
      writeConfig({ specDirs: ["specs/", "specs/sub"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]); // canonicalized, no trailing slash
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("descendant"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-9: ./ prefix on descendant still triggers filter", () => {
      writeConfig({ specDirs: ["specs", "./specs/sub"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("descendant"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-10: mixed trailing slash and ./ prefix still normalize+filter correctly", () => {
      writeConfig({ specDirs: ["./specs/", "specs/sub/"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual(["specs"]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-11: malformed non-string entry throws (matches sibling validators)", () => {
      writeConfig({ specDirs: ["specs", 42, "specs/sub"] });
      expect(() => loadConfig(TMP_DIR)).toThrow(/Invalid specDirs\[1\]/);
    });

    it("T234-12: explicit empty specDirs array is preserved (pre-PR behavior)", () => {
      writeConfig({ specDirs: [] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(TMP_DIR);
        expect(cfg.specDirs).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("T234-14: builder gets no ghost doc for trailing-slash ancestor + child", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-specdirs-234-trailing-slash");
      const tmpSub = resolve(tmpRoot, "specs", "sub");
      mkdirSync(tmpSub, { recursive: true });
      writeFileSync(resolve(tmpSub, "x.md"), "- REQ-1: something\n");
      writeFileSync(
        resolve(tmpRoot, ".artgraph.json"),
        JSON.stringify({ specDirs: ["specs/", "specs/sub"], mode: "file" }),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = loadConfig(tmpRoot);
        expect(cfg.specDirs).toEqual(["specs"]);
        const { graph } = scan(tmpRoot, cfg);
        const docIds = [...graph.nodes.keys()].filter((k) => k.startsWith("doc:"));
        expect(docIds).toEqual(["doc:sub/x.md"]);
        expect(docIds).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        rmSync(tmpRoot, { recursive: true });
      }
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

  describe("agents validation (spec 013 follow-up, #158)", () => {
    it("should accept a valid agents array, alpha-sorted", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: ["cursor", "claude"] }));
      expect(loadConfig(TMP_DIR).agents).toEqual(["claude", "cursor"]);
    });

    it("should be undefined when the field is absent (legacy config round-trips as undefined)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, "{}");
      expect(loadConfig(TMP_DIR).agents).toBeUndefined();
    });

    it("should accept an empty array (explicit opt-out)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: [] }));
      expect(loadConfig(TMP_DIR).agents).toEqual([]);
    });

    it("should reject a non-array value", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: "claude" }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/must be an array of strings/);
    });

    it("should reject an invalid agent id (windsurf is not Tier 1)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: ["windsurf"] }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/not a supported agent id/);
    });

    it("should reject duplicate entries", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: ["claude", "claude"] }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/duplicate entry/);
    });

    it("should reject a non-string entry", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: [42] }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/non-empty string/);
    });

    it("should reject an empty-string entry", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ agents: [""] }));
      expect(() => loadConfig(TMP_DIR)).toThrow(/non-empty string/);
    });

    it("should accept all 5 Tier 1 ids", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ agents: ["kiro", "copilot", "codex", "cursor", "claude"] }),
      );
      expect(loadConfig(TMP_DIR).agents).toEqual(["claude", "codex", "copilot", "cursor", "kiro"]);
    });
  });

  // spec 020 (contracts/cli-surface.md §7, data-model.md §8) — `.artgraph.json`
  // `trace` section. Mirrors `docGraph`: absent key/field => undefined,
  // downstream consumers apply the documented default.
  describe("trace config (spec 020, contracts/cli-surface.md §7)", () => {
    it("defaults to undefined when the trace key is omitted", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({}));
      const config = loadConfig(TMP_DIR);
      expect(config.trace).toBeUndefined();
    });

    it("loads a fully-specified trace section", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          trace: {
            artifacts: [".artgraph/trace/*.jsonl", "ci-shards/*.jsonl"],
            acceptExercises: true,
            staleness: "exclude",
            sharedThreshold: 5,
          },
        }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.trace).toEqual({
        artifacts: [".artgraph/trace/*.jsonl", "ci-shards/*.jsonl"],
        acceptExercises: true,
        staleness: "exclude",
        sharedThreshold: 5,
      });
    });

    it("leaves unspecified trace fields undefined (per-field default, not eager merge)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: 4 } }));
      const config = loadConfig(TMP_DIR);
      expect(config.trace).toEqual({ sharedThreshold: 4 });
      expect(config.trace?.artifacts).toBeUndefined();
      expect(config.trace?.acceptExercises).toBeUndefined();
      expect(config.trace?.staleness).toBeUndefined();
    });

    it("rejects trace as a non-object (e.g. array)", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ trace: [1, 2, 3] }));
      expect(() => loadConfig(TMP_DIR)).toThrow("Invalid trace: must be an object");
    });

    describe("trace.artifacts validation", () => {
      it("rejects a non-array artifacts", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { artifacts: "x.jsonl" } }));
        expect(() => loadConfig(TMP_DIR)).toThrow("trace.artifacts: must be an array of strings");
      });

      it("rejects a non-string entry", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { artifacts: [123] } }));
        expect(() => loadConfig(TMP_DIR)).toThrow("trace.artifacts: every entry must be a string");
      });
    });

    describe("trace.acceptExercises validation", () => {
      it("rejects a non-boolean", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { acceptExercises: "true" } }));
        expect(() => loadConfig(TMP_DIR)).toThrow("trace.acceptExercises: must be a boolean");
      });
    });

    describe("trace.staleness validation (FR-015)", () => {
      it.each(["warn", "exclude", "gate"] as const)("accepts the valid value %s", (staleness) => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { staleness } }));
        expect(loadConfig(TMP_DIR).trace?.staleness).toBe(staleness);
      });

      it("rejects an invalid staleness value in the same style as other config errors", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { staleness: "ignore" } }));
        expect(() => loadConfig(TMP_DIR)).toThrow(
          'Invalid trace.staleness: must be one of "warn", "exclude", "gate"',
        );
      });
    });

    // ①境界: sharedThreshold = 0 / 1 / 負値 / 非整数。1 のみ合法、他は canonical エラー。
    describe("trace.sharedThreshold validation (FR-013 boundary)", () => {
      it("accepts 1 (the minimum legal value)", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: 1 } }));
        expect(loadConfig(TMP_DIR).trace?.sharedThreshold).toBe(1);
      });

      it("accepts the default-shaped value 3", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: 3 } }));
        expect(loadConfig(TMP_DIR).trace?.sharedThreshold).toBe(3);
      });

      it("rejects 0", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: 0 } }));
        expect(() => loadConfig(TMP_DIR)).toThrow(
          "Invalid trace.sharedThreshold: must be a positive integer (>= 1)",
        );
      });

      it("rejects a negative value", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: -1 } }));
        expect(() => loadConfig(TMP_DIR)).toThrow(
          "Invalid trace.sharedThreshold: must be a positive integer (>= 1)",
        );
      });

      it("rejects a non-integer", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: 1.5 } }));
        expect(() => loadConfig(TMP_DIR)).toThrow(
          "Invalid trace.sharedThreshold: must be a positive integer (>= 1)",
        );
      });

      it("rejects a non-number (e.g. string)", () => {
        mkdirSync(TMP_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ trace: { sharedThreshold: "3" } }));
        expect(() => loadConfig(TMP_DIR)).toThrow(
          "Invalid trace.sharedThreshold: must be a positive integer (>= 1)",
        );
      });
    });

    it("does not interfere with other top-level fields", () => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          trace: { sharedThreshold: 5 },
          reqPatterns: { listItem: "^(JIRA-\\d+)[:\\s]" },
        }),
      );
      const config = loadConfig(TMP_DIR);
      expect(config.trace?.sharedThreshold).toBe(5);
      expect(config.reqPatterns?.listItem).toBe("^(JIRA-\\d+)[:\\s]");
    });
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
