import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";

const TMP_DIR = resolve(import.meta.dirname, "fixtures/config-test");
const CONFIG_PATH = resolve(TMP_DIR, ".spectrace.json");

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
});
