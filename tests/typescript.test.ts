import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  // Issue #35: every import edge carries `provenances: ["ts-import"]`.
  it("tags all import edges with provenances=['ts-import']", () => {
    const importEdges = result.edges.filter((e) => e.kind === "imports");
    expect(importEdges.length).toBeGreaterThan(0);
    for (const edge of importEdges) {
      expect(edge.provenances).toEqual(["ts-import"]);
    }
  });

  it("should extract @impl tags with single REQ", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/auth/login.ts",
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].target).toBe("AUTH-001");
    expect(implEdges[0].provenances).toEqual(["code-tag"]);
  });

  it("should extract @impl tags with multiple REQs", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/auth/session.ts",
    );

    expect(implEdges).toHaveLength(2);
    const targets = implEdges.map((e) => e.target).sort();
    expect(targets).toEqual(["AUTH-001", "AUTH-002"]);
  });

  it("should extract [REQ-xxxx] from test descriptions", () => {
    const verifyEdges = result.edges.filter(
      (e) => e.kind === "verifies" && e.source === "file:tests/login.test.ts",
    );

    expect(verifyEdges.length).toBeGreaterThanOrEqual(1);
    expect(verifyEdges[0].target).toBe("AUTH-001");
    expect(verifyEdges[0].provenances).toEqual(["code-tag"]);
  });

  it("should extract @impl with PREFIX-NNN pattern (US1)", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/us1-sample.ts",
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].target).toBe("FEAT-001");
  });

  it("should extract [PREFIX-NNN] from test descriptions (US1)", () => {
    const verifyEdges = result.edges.filter(
      (e) => e.kind === "verifies" && e.source === "file:tests/us1-sample.test.ts",
    );

    expect(verifyEdges).toHaveLength(1);
    expect(verifyEdges[0].target).toBe("FEAT-001");
  });

  it("should extract @impl with Requirement-N pattern (US2)", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.source === "file:src/us2-sample.ts",
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].target).toBe("Requirement-1");
  });

  it("should extract [Requirement-N] from test descriptions (US2)", () => {
    const verifyEdges = result.edges.filter(
      (e) => e.kind === "verifies" && e.source === "file:tests/us2-sample.test.ts",
    );

    expect(verifyEdges).toHaveLength(1);
    expect(verifyEdges[0].target).toBe("Requirement-1");
  });
});

describe("createTSParser (custom codeId — M1)", () => {
  const CUSTOM_DIR = resolve(import.meta.dirname, "fixtures/custom-id");

  it("should NOT extract numeric @impl/test IDs with the default pattern", () => {
    const result = createTSParser(CUSTOM_DIR, ["src/**/*.ts", "tests/**/*.ts"]).parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements");
    const verifyEdges = result.edges.filter((e) => e.kind === "verifies");
    expect(implEdges).toHaveLength(0);
    expect(verifyEdges).toHaveLength(0);
  });

  it("should extract numeric @impl IDs when codeId is configured", () => {
    const result = createTSParser(
      CUSTOM_DIR,
      ["src/**/*.ts", "tests/**/*.ts"],
      "file",
      "\\d+",
    ).parse();
    const implTargets = result.edges
      .filter((e) => e.kind === "implements")
      .map((e) => e.target)
      .sort();
    expect(implTargets).toEqual(["123", "456", "789"]);
  });

  it("should extract numeric [ID] test tags when codeId is configured", () => {
    const result = createTSParser(
      CUSTOM_DIR,
      ["src/**/*.ts", "tests/**/*.ts"],
      "file",
      "\\d+",
    ).parse();
    const verifyTargets = result.edges.filter((e) => e.kind === "verifies").map((e) => e.target);
    expect(verifyTargets).toContain("123");
  });
});

describe("createTSParser (symbol mode)", () => {
  const SYM_FIXTURE = resolve(import.meta.dirname, "fixtures/symbol-level");
  const parser = createTSParser(SYM_FIXTURE, ["src/**/*.ts"], "symbol");
  const result = parser.parse();

  it("should extract symbol nodes for exported functions", () => {
    const symbolNodes = result.nodes.filter((n) => n.kind === "symbol");
    const symbolIds = symbolNodes.map((n) => n.id);

    expect(symbolIds).toContain("symbol:src/utils.ts#foo");
    expect(symbolIds).toContain("symbol:src/utils.ts#bar");
  });

  it("should keep file nodes alongside symbol nodes", () => {
    const fileNodes = result.nodes.filter((n) => n.kind === "file");
    const filePaths = fileNodes.map((n) => n.filePath);

    expect(filePaths).toContain("src/utils.ts");
    expect(filePaths).toContain("src/consumer.ts");
  });

  it("should resolve named import to symbol-level edge", () => {
    const importEdges = result.edges.filter(
      (e) => e.kind === "imports" && e.source === "file:src/consumer.ts",
    );

    const symbolTargets = importEdges.filter((e) => e.target.startsWith("symbol:"));
    expect(symbolTargets).toContainEqual({
      source: "file:src/consumer.ts",
      target: "symbol:src/utils.ts#foo",
      kind: "imports",
      provenances: ["ts-import"],
    });
  });

  it("should fallback namespace import to file-level edge", () => {
    const importEdges = result.edges.filter(
      (e) => e.kind === "imports" && e.source === "file:src/ns-consumer.ts",
    );

    expect(importEdges).toContainEqual({
      source: "file:src/ns-consumer.ts",
      target: "file:src/utils.ts",
      kind: "imports",
      provenances: ["ts-import"],
    });
    const symbolTargets = importEdges.filter((e) => e.target.startsWith("symbol:"));
    expect(symbolTargets).toHaveLength(0);
  });

  it("should resolve default import to symbol:path#default edge", () => {
    const importEdges = result.edges.filter(
      (e) => e.kind === "imports" && e.source === "file:src/consumer.ts",
    );

    expect(importEdges).toContainEqual({
      source: "file:src/consumer.ts",
      target: "symbol:src/defaults.ts#default",
      kind: "imports",
      provenances: ["ts-import"],
    });
  });

  it("should extract default export as symbol:path#default node", () => {
    const symbolNodes = result.nodes.filter((n) => n.kind === "symbol");
    const symbolIds = symbolNodes.map((n) => n.id);

    expect(symbolIds).toContain("symbol:src/defaults.ts#default");
  });

  it("should resolve aliased import { bar as myBar } to original export name", () => {
    const importEdges = result.edges.filter(
      (e) => e.kind === "imports" && e.source === "file:src/consumer.ts",
    );

    expect(importEdges).toContainEqual({
      source: "file:src/consumer.ts",
      target: "symbol:src/utils.ts#bar",
      kind: "imports",
      provenances: ["ts-import"],
    });
  });

  it("should resolve @impl inside arrow function export to symbol source", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "FR-001" && e.source.includes("arrow"),
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/arrow.ts#handler");
  });

  it("should resolve @impl inside exported function to symbol source", () => {
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "FR-001" && e.source.includes("utils"),
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/utils.ts#foo");
  });

  it("should fallback @impl at top-level to file source", () => {
    const implEdges = result.edges.filter((e) => e.kind === "implements" && e.target === "SC-001");

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("file:src/toplevel-impl.ts");
  });

  it("should use file source for @impl in file mode (regression)", () => {
    const fileParser = createTSParser(SYM_FIXTURE, ["src/**/*.ts"], "file");
    const fileResult = fileParser.parse();

    const implEdges = fileResult.edges.filter(
      (e) => e.kind === "implements" && e.target === "FR-001" && e.source === "file:src/utils.ts",
    );

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("file:src/utils.ts");
  });
});

// Issue #214: `// @impl REQ-001, REQ-002` used to register only the FIRST ID
// and silently drop the rest — the implRe separator accepted whitespace only.
// Commas (with or without surrounding spaces, including a trailing comma) are
// now a supported separator, equivalent to the space-separated and stacked
// one-per-line notations.
describe("createTSParser (@impl comma-separated IDs — issue #214)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  const implTargets = (
    edges: Array<{ kind: string; source: string; target: string }>,
    source: string,
  ): string[] =>
    edges
      .filter((e) => e.kind === "implements" && e.source === source)
      .map((e) => e.target)
      .sort();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-impl-comma-"));
    // The exact reproduction from the issue: comma style vs stacked style.
    write(
      "src/repro.ts",
      [
        "// @impl REQ-901, REQ-902",
        "export function commaStyle(): void {}",
        "",
        "// @impl REQ-903",
        "// @impl REQ-904",
        "export function stackedStyle(): void {}",
        "",
      ].join("\n"),
    );
    write(
      "src/edge-cases.ts",
      [
        "// @impl REQ-001,REQ-002",
        "export function noSpace(): void {}",
        "",
        "// @impl REQ-003,",
        "export function trailingComma(): void {}",
        "",
        "// @impl REQ-004, REQ-005 REQ-006",
        "export function mixedSeparators(): void {}",
        "",
        "// @impl ns/REQ-007, Requirement-8",
        "export function namespacedAndKiro(): void {}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registers EVERY comma-separated ID as an implements edge (issue repro)", () => {
    const result = createTSParser(root, ["src/**/*.ts"]).parse();
    expect(implTargets(result.edges, "file:src/repro.ts")).toEqual([
      "REQ-901",
      "REQ-902",
      "REQ-903",
      "REQ-904",
    ]);
  });

  it("accepts no-space commas, a trailing comma, and mixed comma/space separators", () => {
    const result = createTSParser(root, ["src/**/*.ts"]).parse();
    expect(implTargets(result.edges, "file:src/edge-cases.ts")).toEqual([
      "REQ-001",
      "REQ-002",
      "REQ-003",
      "REQ-004",
      "REQ-005",
      "REQ-006",
      "Requirement-8",
      "ns/REQ-007",
    ]);
  });

  it("binds every comma-separated ID to the tagged symbol in symbol mode", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    expect(implTargets(result.edges, "symbol:src/repro.ts#commaStyle")).toEqual([
      "REQ-901",
      "REQ-902",
    ]);
    // The stacked notation keeps working exactly as before.
    expect(implTargets(result.edges, "symbol:src/repro.ts#stackedStyle")).toEqual([
      "REQ-903",
      "REQ-904",
    ]);
  });

  it("supports commas with a custom codeId token too", () => {
    const customRoot = mkdtempSync(join(tmpdir(), "artgraph-impl-comma-custom-"));
    try {
      const abs = join(customRoot, "src/ids.ts");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "// @impl 123, 456,789\nexport function f(): void {}\n");
      const result = createTSParser(customRoot, ["src/**/*.ts"], "file", "\\d+").parse();
      expect(implTargets(result.edges, "file:src/ids.ts")).toEqual(["123", "456", "789"]);
    } finally {
      rmSync(customRoot, { recursive: true, force: true });
    }
  });
});
