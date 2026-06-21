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
          listItem: "CUSTOM-\\d+",
          heading: "Spec\\s+\\d+",
        },
      }),
    );

    const config = loadConfig(TMP_DIR);
    expect(config.reqPatterns).toEqual({
      listItem: "CUSTOM-\\d+",
      heading: "Spec\\s+\\d+",
    });
  });

  it("should preserve default values for unspecified fields", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ reqPatterns: { listItem: "X-\\d+" } }));

    const config = loadConfig(TMP_DIR);
    expect(config.reqPatterns).toEqual({ listItem: "X-\\d+" });
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
});
