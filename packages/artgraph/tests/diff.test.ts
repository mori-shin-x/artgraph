import { describe, it, expect } from "vitest";
import { parseDiffFiles } from "../src/diff.js";

describe("parseDiffFiles", () => {
  it("should parse git diff --name-only output", () => {
    const diffOutput = "src/auth/login.ts\nsrc/auth/session.ts\n";
    const files = parseDiffFiles(diffOutput);
    expect(files).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
  });

  it("should ignore empty lines", () => {
    const diffOutput = "src/auth/login.ts\n\nsrc/auth/session.ts\n\n";
    const files = parseDiffFiles(diffOutput);
    expect(files).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
  });

  it("should return empty array for empty diff", () => {
    const files = parseDiffFiles("");
    expect(files).toEqual([]);
  });
});
