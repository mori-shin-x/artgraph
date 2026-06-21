import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractReqTags,
  parseVitestJson,
  parseJUnitXml,
  parseTestResults,
  buildTestResultMap,
  loadTestResults,
} from "../src/test-results.js";

const FIXTURE_DIR = resolve(
  import.meta.dirname,
  "fixtures/test-results",
);

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf-8");
}

describe("extractReqTags", () => {
  it("should extract a single REQ tag", () => {
    expect(extractReqTags("[REQ-001] should do something")).toEqual([
      "REQ-001",
    ]);
  });

  it("should extract multiple REQ tags", () => {
    expect(
      extractReqTags("[REQ-001][REQ-002] should do both"),
    ).toEqual(["REQ-001", "REQ-002"]);
  });

  it("should extract namespaced REQ tag", () => {
    expect(extractReqTags("[001-auth/FR-001] auth test")).toEqual([
      "001-auth/FR-001",
    ]);
  });

  it("should return empty array when no tags", () => {
    expect(extractReqTags("no tags here")).toEqual([]);
  });

  it("should deduplicate tags", () => {
    expect(
      extractReqTags("[REQ-001] and [REQ-001] duplicate"),
    ).toEqual(["REQ-001"]);
  });
});

describe("parseVitestJson", () => {
  it("should parse passing test", () => {
    const records = parseVitestJson(fixture("vitest-pass.json"));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      reqId: "REQ-001",
      testName: "[REQ-001] should authenticate user",
      passed: true,
    });
  });

  it("should parse failing test", () => {
    const records = parseVitestJson(fixture("vitest-fail.json"));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      reqId: "REQ-001",
      testName: "[REQ-001] should authenticate user",
      passed: false,
    });
  });

  it("should inherit REQ tag from ancestorTitles", () => {
    const records = parseVitestJson(
      fixture("vitest-describe-inherit.json"),
    );
    expect(records).toHaveLength(2);
    expect(records[0]!.reqId).toBe("REQ-001");
    expect(records[1]!.reqId).toBe("REQ-001");
  });

  it("should create records for multiple REQ tags", () => {
    const records = parseVitestJson(
      fixture("vitest-multi-req.json"),
    );
    expect(records).toHaveLength(2);
    const reqIds = records.map((r) => r.reqId).sort();
    expect(reqIds).toEqual(["REQ-001", "REQ-002"]);
  });

  it("should mark skipped test as not passed", () => {
    const records = parseVitestJson(fixture("vitest-skip.json"));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      reqId: "REQ-001",
      testName: "[REQ-001] should authenticate user",
      passed: false,
    });
  });

  it("should parse namespaced REQ tag", () => {
    const records = parseVitestJson(
      fixture("vitest-namespaced.json"),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.reqId).toBe("001-auth/FR-001");
  });

  it("should return empty array for invalid JSON", () => {
    const records = parseVitestJson("this is not json");
    expect(records).toEqual([]);
  });
});

describe("parseJUnitXml", () => {
  it("should parse passing test", () => {
    const records = parseJUnitXml(fixture("junit-pass.xml"));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      reqId: "REQ-001",
      testName: "[REQ-001] should authenticate user",
      passed: true,
    });
  });

  it("should parse failing test", () => {
    const records = parseJUnitXml(fixture("junit-fail.xml"));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      reqId: "REQ-001",
      testName: "[REQ-001] should authenticate user",
      passed: false,
    });
  });

  it("should inherit REQ tag from testsuite name", () => {
    const records = parseJUnitXml(
      fixture("junit-suite-inherit.xml"),
    );
    expect(records).toHaveLength(2);
    expect(records[0]!.reqId).toBe("REQ-002");
    expect(records[1]!.reqId).toBe("REQ-002");
  });

  it("should return empty array for invalid XML", () => {
    const records = parseJUnitXml("this is not xml");
    expect(records).toEqual([]);
  });
});

describe("parseTestResults", () => {
  it("should delegate JSON content to parseVitestJson", () => {
    const content = fixture("vitest-pass.json");
    const records = parseTestResults(content);
    expect(records).toHaveLength(1);
    expect(records[0]!.reqId).toBe("REQ-001");
    expect(records[0]!.passed).toBe(true);
  });

  it("should delegate XML content to parseJUnitXml", () => {
    const content = fixture("junit-pass.xml");
    const records = parseTestResults(content);
    expect(records).toHaveLength(1);
    expect(records[0]!.reqId).toBe("REQ-001");
    expect(records[0]!.passed).toBe(true);
  });

  it("should return empty array for invalid content", () => {
    const content = fixture("invalid-format.txt");
    const records = parseTestResults(content);
    expect(records).toEqual([]);
  });
});

describe("buildTestResultMap", () => {
  it("should group records by reqId", () => {
    const records = [
      { reqId: "REQ-001", testName: "test1", passed: true },
      { reqId: "REQ-002", testName: "test2", passed: false },
    ];
    const map = buildTestResultMap(records);
    expect(map.size).toBe(2);
    expect(map.get("REQ-001")).toHaveLength(1);
    expect(map.get("REQ-002")).toHaveLength(1);
  });

  it("should collect multiple tests for same REQ", () => {
    const records = [
      { reqId: "REQ-001", testName: "test1", passed: true },
      { reqId: "REQ-001", testName: "test2", passed: false },
    ];
    const map = buildTestResultMap(records);
    expect(map.size).toBe(1);
    expect(map.get("REQ-001")).toHaveLength(2);
  });

  it("should return empty map for empty array", () => {
    const map = buildTestResultMap([]);
    expect(map.size).toBe(0);
  });
});

describe("loadTestResults", () => {
  it("should load a single Vitest JSON file", () => {
    const filePath = resolve(FIXTURE_DIR, "vitest-pass.json");
    const map = loadTestResults([filePath], FIXTURE_DIR);
    expect(map.size).toBe(1);
    expect(map.get("REQ-001")).toHaveLength(1);
    expect(map.get("REQ-001")![0]!.passed).toBe(true);
  });

  it("should load a single JUnit XML file", () => {
    const filePath = resolve(FIXTURE_DIR, "junit-pass.xml");
    const map = loadTestResults([filePath], FIXTURE_DIR);
    expect(map.size).toBe(1);
    expect(map.get("REQ-001")).toHaveLength(1);
    expect(map.get("REQ-001")![0]!.passed).toBe(true);
  });

  it("should return empty Map for non-existent path", () => {
    const map = loadTestResults(["/nonexistent/path/to/file.json"], FIXTURE_DIR);
    expect(map.size).toBe(0);
  });

  it("should return empty Map for invalid format file", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const filePath = resolve(FIXTURE_DIR, "invalid-format.txt");
    const map = loadTestResults([filePath], FIXTURE_DIR);
    expect(map.size).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("warning: no test results found"),
    );
    consoleSpy.mockRestore();
  });

  it("should merge multiple files with different REQs", () => {
    const vitestPath = resolve(FIXTURE_DIR, "vitest-pass.json");
    const junitPath = resolve(FIXTURE_DIR, "junit-fail.xml");
    const map = loadTestResults([vitestPath, junitPath], FIXTURE_DIR);
    expect(map.size).toBe(1);
    // Both files have REQ-001, so they should be merged
    expect(map.get("REQ-001")).toHaveLength(2);
  });

  it("should merge Vitest and JUnit results from multiple files", () => {
    const vitestPath = resolve(FIXTURE_DIR, "vitest-mixed.json");
    const junitPath = resolve(FIXTURE_DIR, "junit-pass.xml");
    const map = loadTestResults([vitestPath, junitPath], FIXTURE_DIR);
    // vitest-mixed has REQ-001 and REQ-002, junit-pass has REQ-001
    expect(map.has("REQ-001")).toBe(true);
    expect(map.has("REQ-002")).toBe(true);
    expect(map.get("REQ-001")!.length).toBeGreaterThanOrEqual(2);
  });

  it("should expand glob patterns", () => {
    const rootDir = resolve(FIXTURE_DIR, "../../..");
    const map = loadTestResults(["tests/fixtures/test-results/vitest-*.json"], rootDir);
    // There are multiple vitest-*.json files, all containing REQ-001
    expect(map.size).toBeGreaterThanOrEqual(1);
    expect(map.has("REQ-001")).toBe(true);
  });
});
