import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { createTSParser } from "../src/parsers/typescript.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

describe("createTSParser", () => {
  const parser = createTSParser(FIXTURE_DIR, ["src/**/*.ts", "tests/**/*.ts"]);
  const result = parser.parse();

  it("should discover source files as file nodes", () => {
    const fileNodes = result.nodes.filter((n) => n.kind === "file");
    const paths = fileNodes.map((n) => n.filePath);

    expect(paths).toContain("src/auth/login.ts");
    expect(paths).toContain("src/auth/session.ts");
    expect(paths).toContain("src/index.ts");
  });

  it("should discover test files as test nodes", () => {
    const testNodes = result.nodes.filter((n) => n.kind === "test");
    expect(testNodes.length).toBeGreaterThanOrEqual(1);
    expect(testNodes[0].filePath).toContain("login.test.ts");
  });

  it("should extract import edges", () => {
    const importEdges = result.edges.filter((e) => e.kind === "imports");
    const loginImports = importEdges.filter((e) => e.source === "file:src/auth/login.ts");

    expect(loginImports).toHaveLength(1);
    expect(loginImports[0].target).toBe("file:src/auth/session.ts");
  });

  it("should extract @impl tags with single REQ", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/auth/login.ts",
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].target).toBe("REQ-7f3a");
  });

  it("should extract @impl tags with multiple REQs", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/auth/session.ts",
    );

    expect(implEdges).toHaveLength(2);
    const targets = implEdges.map((e) => e.target).sort();
    expect(targets).toEqual(["REQ-7f3a", "REQ-a1b2"]);
  });

  it("should extract [REQ-xxxx] from test descriptions", () => {
    const verifyEdges = result.edges.filter((e) => e.kind === "verifies");

    expect(verifyEdges.length).toBeGreaterThanOrEqual(1);
    expect(verifyEdges[0].target).toBe("REQ-7f3a");
  });
});
