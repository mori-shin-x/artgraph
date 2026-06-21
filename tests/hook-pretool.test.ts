import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseHookInput,
  extractFilePaths,
  toRelativePath,
  formatAdditionalContext,
  buildHookOutput,
  runHookPretool,
} from "../src/hook-pretool.js";
import type { ImpactResult } from "../src/types.js";

const HOOKS_DIR = resolve(import.meta.dirname, "fixtures/hooks");

function readFixture(name: string): string {
  return readFileSync(resolve(HOOKS_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// parseHookInput
// ---------------------------------------------------------------------------
describe("parseHookInput", () => {
  it("should parse Edit hook JSON", () => {
    const result = parseHookInput(readFixture("edit-input.json"));
    expect(result).not.toBeNull();
    expect(result!.tool_name).toBe("Edit");
    expect(result!.tool_input.file_path).toBe("src/auth.ts");
  });

  it("should parse Write hook JSON", () => {
    const result = parseHookInput(readFixture("write-input.json"));
    expect(result).not.toBeNull();
    expect(result!.tool_name).toBe("Write");
    expect(result!.tool_input.file_path).toBe("src/new-file.ts");
  });

  it("should parse MultiEdit hook JSON", () => {
    const result = parseHookInput(readFixture("multiedit-input.json"));
    expect(result).not.toBeNull();
    expect(result!.tool_name).toBe("MultiEdit");
    expect(result!.tool_input.file_path).toBe("src/auth.ts");
  });

  it("should return null for invalid JSON", () => {
    const result = parseHookInput("{invalid json}");
    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = parseHookInput("");
    expect(result).toBeNull();
  });

  it("should return null for JSON array", () => {
    const result = parseHookInput('[{"tool_name":"Edit"}]');
    expect(result).toBeNull();
  });

  it("should return null when tool_name is missing", () => {
    const result = parseHookInput('{"tool_input":{"file_path":"src/foo.ts"}}');
    expect(result).toBeNull();
  });

  it("should return null when tool_name is not a string", () => {
    const result = parseHookInput('{"tool_name":123,"tool_input":{"file_path":"src/foo.ts"}}');
    expect(result).toBeNull();
  });

  it("should return null when tool_input is missing", () => {
    const result = parseHookInput('{"tool_name":"Edit"}');
    expect(result).toBeNull();
  });

  it("should return null when tool_input is not an object", () => {
    const result = parseHookInput('{"tool_name":"Edit","tool_input":"not-object"}');
    expect(result).toBeNull();
  });

  it("should return null when tool_input is an array", () => {
    const result = parseHookInput('{"tool_name":"Edit","tool_input":[]}');
    expect(result).toBeNull();
  });

  it("should return null for JSON primitive (number)", () => {
    const result = parseHookInput("42");
    expect(result).toBeNull();
  });

  it("should return null for JSON primitive (string)", () => {
    const result = parseHookInput('"hello"');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFilePaths
// ---------------------------------------------------------------------------
describe("extractFilePaths", () => {
  it("should extract file_path from Edit input", () => {
    const input = parseHookInput(readFixture("edit-input.json"))!;
    const paths = extractFilePaths(input);
    expect(paths).toEqual(["src/auth.ts"]);
  });

  it("should extract file_path from Write input", () => {
    const input = parseHookInput(readFixture("write-input.json"))!;
    const paths = extractFilePaths(input);
    expect(paths).toEqual(["src/new-file.ts"]);
  });

  it("should extract file_path from MultiEdit input", () => {
    const input = parseHookInput(readFixture("multiedit-input.json"))!;
    const paths = extractFilePaths(input);
    expect(paths).toEqual(["src/auth.ts"]);
  });

  it("should return empty array when tool_input has no file_path", () => {
    const input: any = { tool_name: "Edit", tool_input: {} };
    const paths = extractFilePaths(input);
    expect(paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toRelativePath
// ---------------------------------------------------------------------------
describe("toRelativePath", () => {
  it("should convert absolute path to relative", () => {
    const result = toRelativePath("/home/user/project/src/auth.ts", "/home/user/project");
    expect(result).toBe("src/auth.ts");
  });

  it("should return relative path as-is", () => {
    const result = toRelativePath("src/auth.ts", "/home/user/project");
    expect(result).toBe("src/auth.ts");
  });
});

// ---------------------------------------------------------------------------
// formatAdditionalContext
// ---------------------------------------------------------------------------
describe("formatAdditionalContext", () => {
  it("should format reqs and docs", () => {
    const result: ImpactResult = {
      affectedReqs: ["FR-001"],
      affectedDocs: ["doc:api-design"],
      affectedFiles: [],
      drifted: [],
    };
    expect(formatAdditionalContext(result)).toBe(
      "spectrace impact: FR-001 (req), doc:api-design (doc)",
    );
  });

  it("should format multiple reqs with no docs", () => {
    const result: ImpactResult = {
      affectedReqs: ["FR-001", "SC-001"],
      affectedDocs: [],
      affectedFiles: [],
      drifted: [],
    };
    expect(formatAdditionalContext(result)).toBe("spectrace impact: FR-001 (req), SC-001 (req)");
  });

  it("should return (none) when no reqs and no docs", () => {
    const result: ImpactResult = {
      affectedReqs: [],
      affectedDocs: [],
      affectedFiles: [],
      drifted: [],
    };
    expect(formatAdditionalContext(result)).toBe("spectrace impact: (none)");
  });
});

// ---------------------------------------------------------------------------
// buildHookOutput
// ---------------------------------------------------------------------------
describe("buildHookOutput", () => {
  it("should build hookSpecificOutput with additionalContext", () => {
    const output = buildHookOutput("spectrace impact: FR-001 (req)");
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "spectrace impact: FR-001 (req)",
      },
    });
  });

  it("should build hookSpecificOutput with empty additionalContext", () => {
    const output = buildHookOutput("");
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling (Phase 6)
// ---------------------------------------------------------------------------
describe("extractFilePaths edge cases", () => {
  it("should return empty array when tool_input is missing", () => {
    const input: any = { tool_name: "Edit" };
    const paths = extractFilePaths(input);
    expect(paths).toEqual([]);
  });

  it("should extract file_path from non-Edit/Write/MultiEdit tool_name", () => {
    const input: any = { tool_name: "Read", tool_input: { file_path: "src/foo.ts" } };
    const paths = extractFilePaths(input);
    expect(paths).toEqual(["src/foo.ts"]);
  });
});
