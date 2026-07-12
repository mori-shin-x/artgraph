import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTSParser, globCodeFiles, hash } from "../src/parsers/typescript.js";

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

// spec 021 (issue #218) — class method grain. T001: the issue's own
// reproduction (standalone function + a class whose two methods each carry
// their own `@impl`) must produce per-method symbol nodes, per-method
// `implements` edges, an unchanged whole-class symbol, and a class -> method
// `contains` edge (provenance "structural") per method.
describe("createTSParser (symbol mode — class method grain, spec 021 / issue #218)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-method-grain-"));
    // T001 — issue #218 reproduction.
    write(
      "src/sample.ts",
      [
        "// @impl REQ-901",
        "export function standaloneFn(): void {}",
        "",
        "export class Sample {",
        "  // @impl REQ-902",
        "  methodA(): void {}",
        "",
        "  // @impl REQ-903",
        "  methodB(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // T002(a) — a tag directly above the class attributes to the CLASS, not
    // to the first member (US1 AS1-2, unchanged pre-existing behavior).
    write(
      "src/attr-class-tag.ts",
      ["// @impl REQ-801", "export class ClassTagSample {", "  methodA(): void {}", "}", ""].join(
        "\n",
      ),
    );
    // T002(b) — a tag written INSIDE a method body attributes to that
    // method, not the class (US1 AS1-3 — behavior CHANGE from pre-spec-021,
    // where the whole class was the innermost symbol).
    write(
      "src/attr-method-body-tag.ts",
      [
        "export class BodyTagSample {",
        "  methodA(): void {",
        "    // @impl REQ-802",
        "    doSomething();",
        "  }",
        "}",
        "function doSomething(): void {}",
        "",
      ].join("\n"),
    );
    // T002(c) — leading-trivia attribution reaches THROUGH a JSDoc block
    // above the method, exactly like the existing top-level-function rule
    // (US1 AS1-4, issue #177 idiom).
    write(
      "src/attr-jsdoc-tag.ts",
      [
        "export class JsdocSample {",
        "  // @impl REQ-803",
        "  /**",
        "   * JSDoc between the tag and the method.",
        "   */",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // T002(d) — a non-exported class gets NO symbol nodes at all (class or
    // member); its `@impl` tags fall back to file attribution, unchanged
    // (US1 AS1-6).
    write(
      "src/attr-non-exported.ts",
      ["class NotExported {", "  // @impl REQ-804", "  methodA(): void {}", "}", ""].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("T001(a): produces symbol:...#Sample.methodA / #Sample.methodB nodes", () => {
    const result = parse();
    const symbolIds = result.nodes.filter((n) => n.kind === "symbol").map((n) => n.id);
    expect(symbolIds).toContain("symbol:src/sample.ts#Sample.methodA");
    expect(symbolIds).toContain("symbol:src/sample.ts#Sample.methodB");
  });

  it("T001(b): implements edges are sourced from each method symbol", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements");
    expect(implEdges).toContainEqual({
      source: "symbol:src/sample.ts#Sample.methodA",
      target: "REQ-902",
      kind: "implements",
      provenances: ["code-tag"],
    });
    expect(implEdges).toContainEqual({
      source: "symbol:src/sample.ts#Sample.methodB",
      target: "REQ-903",
      kind: "implements",
      provenances: ["code-tag"],
    });
    // The standalone function keeps its pre-existing symbol-mode resolution.
    expect(implEdges).toContainEqual({
      source: "symbol:src/sample.ts#standaloneFn",
      target: "REQ-901",
      kind: "implements",
      provenances: ["code-tag"],
    });
  });

  it("T001(c): the class symbol still exists with its whole-class span hash unchanged", () => {
    const result = parse();
    const classNode = result.nodes.find((n) => n.id === "symbol:src/sample.ts#Sample");
    expect(classNode).toBeDefined();
    const source = [
      "// @impl REQ-901",
      "export function standaloneFn(): void {}",
      "",
      "export class Sample {",
      "  // @impl REQ-902",
      "  methodA(): void {}",
      "",
      "  // @impl REQ-903",
      "  methodB(): void {}",
      "}",
      "",
    ].join("\n");
    const classText = source.slice(
      source.indexOf("export class Sample"),
      source.lastIndexOf("}") + 1,
    );
    expect(classNode?.contentHash).toBe(hash(classText));
  });

  it("T001(d): a contains edge (provenance structural) links class -> each method", () => {
    const result = parse();
    const containsEdges = result.edges.filter((e) => e.kind === "contains");
    expect(containsEdges).toContainEqual({
      source: "symbol:src/sample.ts#Sample",
      target: "symbol:src/sample.ts#Sample.methodA",
      kind: "contains",
      provenances: ["structural"],
    });
    expect(containsEdges).toContainEqual({
      source: "symbol:src/sample.ts#Sample",
      target: "symbol:src/sample.ts#Sample.methodB",
      kind: "contains",
      provenances: ["structural"],
    });
  });

  it("T002(a): a tag directly above the class attributes to the class (AS1-2)", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements" && e.target === "REQ-801");
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/attr-class-tag.ts#ClassTagSample");
  });

  it("T002(b): a tag inside a method BODY attributes to that method (AS1-3)", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements" && e.target === "REQ-802");
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/attr-method-body-tag.ts#BodyTagSample.methodA");
  });

  it("T002(c): leading-trivia attribution reaches through a JSDoc block above the method (AS1-4)", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements" && e.target === "REQ-803");
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/attr-jsdoc-tag.ts#JsdocSample.methodA");
  });

  it("T002(d): a non-exported class gets no symbol nodes; its tag stays file-attributed (AS1-6)", () => {
    const result = parse();
    const symbolIds = result.nodes.filter((n) => n.kind === "symbol").map((n) => n.id);
    expect(symbolIds.some((id) => id.includes("NotExported"))).toBe(false);

    const implEdges = result.edges.filter((e) => e.kind === "implements" && e.target === "REQ-804");
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("file:src/attr-non-exported.ts");
  });
});

// spec 021 (issue #218) — class method grain, 7-observation-point matrix
// (lane C, tasks.md T010/T011/T013/T014/T017/T020/T022/T023). Each `describe`
// below owns its own tmp fixture root, following the T001/T002 pattern above.

describe("createTSParser (symbol mode — class method grain, spec 021 — T010 boundary conditions 1)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t010-"));
    // T010(a)-1 — a tag directly above a genuinely ONE-LINE class (the whole
    // class statement, including its sole member, occupies a single source
    // line) attributes to the CLASS. The class's own attribution range
    // widens over the tag's comment-only line; the member's range is bounded
    // below by the (un-widened) class declaration line and never reaches it.
    write(
      "src/oneline-tag-above.ts",
      ["// @impl REQ-1010", "export class S { m() {} }", ""].join("\n"),
    );
    // T010(a)-2 — the genuine SAME-SIZE TIE: a trailing `// @impl` on the
    // very same physical line as a one-line class. Neither the class's nor
    // the member's attribution range widens (nothing above to climb over),
    // so both ranges collapse to exactly that one line (size 0) — a true
    // tie. Symbol ranges are registered class-first (extractSymbols pushes
    // the class's own range before any member range), so
    // resolveSymbolsAtLine's "first group wins on a size tie" rule picks the
    // class (Edge Cases: "1 行クラスの…同サイズ tie" is resolved by
    // registration order, not by any special-cased tie-break).
    write(
      "src/oneline-trailing-tag.ts",
      ["export class S { m() {} } // @impl REQ-1011", ""].join("\n"),
    );
    // T010(b) — `export class Name { methodA(): void {` : the class
    // declaration and its first member OPEN on the same source line, but the
    // member's body (and the class) continue on subsequent lines. A tag
    // directly above the class must still attribute to the CLASS — the
    // member's leading-trivia rise is bounded by the class declaration's own
    // (un-widened) start line, so it cannot climb past that line to steal a
    // tag sitting above the class.
    write(
      "src/sameline-open.ts",
      [
        "// @impl REQ-1012",
        "export class SameLineOpenSample { methodA(): void {",
        "  body();",
        "} }",
        "",
      ].join("\n"),
    );
    // T010(c) — a tag between the class's opening brace and its first
    // member (nothing but the tag and a blank line in between). The rise for
    // the first member is bounded below by the class declaration line, not
    // by "the previous member's end" (there is no previous member), so the
    // gap behaves exactly like the inter-member floating-tag case (T022b):
    // it deterministically attributes to the NEXT (here: first) member.
    write(
      "src/between-open-and-first-member.ts",
      [
        "export class BetweenSample {",
        "  // @impl REQ-1013",
        "",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("T010(a)-1: a tag above a one-line class attributes to the class", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1010",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/oneline-tag-above.ts#S");
  });

  it("T010(a)-2: a same-size tie (trailing tag on a one-line class) keeps the class (registration-order tie-break)", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1011",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/oneline-trailing-tag.ts#S");
  });

  it("T010(b): a same-line class-open does not let the method steal the class's own leading tag", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1012",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/sameline-open.ts#SameLineOpenSample");
  });

  it("T010(c): a tag between the class-open brace and the first member resolves deterministically (to the first member)", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1013",
    );
    expect(implEdges).toHaveLength(1);
    // Deterministic — repeated parses agree with each other and with the
    // single resolved source below (the "next member" rule, generalized to
    // the class-open/first-member gap).
    const again = parse().edges.filter((e) => e.kind === "implements" && e.target === "REQ-1013");
    expect(again).toEqual(implEdges);
    expect(implEdges[0].source).toBe(
      "symbol:src/between-open-and-first-member.ts#BetweenSample.methodA",
    );
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T011 boundary conditions 2)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t011-"));
    write("src/empty.ts", ["export class EmptyClass {}", ""].join("\n"));
    write(
      "src/tail-tag.ts",
      [
        "export class TailSample {",
        "  methodA(): void {}",
        "",
        "  // @impl REQ-1014",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/one-member.ts",
      ["export class OneMemberSample {", "  soleMethod(): void {}", "}", ""].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("T011(a): an empty class produces zero method symbols, zero contains edges, and only the class symbol", () => {
    const result = parse();
    const symbolNodes = result.nodes.filter(
      (n) => n.kind === "symbol" && n.filePath === "src/empty.ts",
    );
    expect(symbolNodes.map((n) => n.id)).toEqual(["symbol:src/empty.ts#EmptyClass"]);
    const containsEdges = result.edges.filter(
      (e) => e.kind === "contains" && e.source === "symbol:src/empty.ts#EmptyClass",
    );
    expect(containsEdges).toHaveLength(0);
  });

  it("T011(b): a tag after the last member (before the closing brace) attributes to the class", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1014",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/tail-tag.ts#TailSample");
  });

  it("T011(c): a class with exactly one member produces exactly one method symbol and one contains edge", () => {
    const result = parse();
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/one-member.ts")
      .map((n) => n.id);
    expect(symbolIds.sort()).toEqual([
      "symbol:src/one-member.ts#OneMemberSample",
      "symbol:src/one-member.ts#OneMemberSample.soleMethod",
    ]);
    const containsEdges = result.edges.filter(
      (e) => e.kind === "contains" && e.source === "symbol:src/one-member.ts#OneMemberSample",
    );
    expect(containsEdges).toEqual([
      {
        source: "symbol:src/one-member.ts#OneMemberSample",
        target: "symbol:src/one-member.ts#OneMemberSample.soleMethod",
        kind: "contains",
        provenances: ["structural"],
      },
    ]);
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T013 export-form x member-kind matrix)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t013-"));
    // Positive grid: inline named export x {method, getter, setter, static
    // method, arrow-fn property}, plus the two explicitly-excluded-by-type
    // cells {abstract method, static block} via a second (abstract) class —
    // abstract classes are still an INLINE NAMED export, so their CONCRETE
    // members must still be symbolized while the abstract one falls back.
    write(
      "src/matrix.ts",
      [
        "export class MatrixSample {",
        "  // @impl REQ-1020",
        "  method(): void {}",
        "  // @impl REQ-1021",
        "  get g(): number { return 1; }",
        "  // @impl REQ-1022",
        "  set g(v: number) {}",
        "  // @impl REQ-1023",
        "  static sm(): void {}",
        "  // @impl REQ-1024",
        "  onClick = () => {};",
        "}",
        "",
        // Inline DEFAULT export — the same member-kind coverage (method +
        // arrow-fn property) must work under the `default.` prefix too.
        "export default class {",
        "  // @impl REQ-1025",
        "  defaultMethod(): void {}",
        "  // @impl REQ-1026",
        "  onClick = () => {};",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/abstract-and-static-block.ts",
      [
        "export abstract class AbstractSample {",
        "  // @impl REQ-1027",
        "  abstract methodA(): void;",
        "  // @impl REQ-1028",
        "  concreteMethod(): void {}",
        "  static {",
        "    doInit();",
        "  }",
        "}",
        "function doInit(): void {}",
        "",
      ].join("\n"),
    );
    // Excluded export forms: separate (`export { X }`) and alias
    // (`export { X as Y }`) exported classes never reach the inline
    // ClassDeclaration branch that calls extractClassMembers — only the
    // class-level symbol (existing pre-021 behavior) is produced.
    write(
      "src/separate-export.ts",
      [
        "class SeparateSample {",
        "  methodA(): void {}",
        "}",
        "export { SeparateSample };",
        "",
      ].join("\n"),
    );
    write(
      "src/alias-export.ts",
      [
        "class AliasSample {",
        "  methodA(): void {}",
        "}",
        "export { AliasSample as Renamed };",
        "",
      ].join("\n"),
    );
    // Double export: the SAME class is exported both inline-default and via
    // a separate named specifier. Only ONE set of member symbols may exist —
    // under the inline form's own prefix (`default.`), never duplicated
    // under the specifier's local name (`DoubleSample.`).
    write(
      "src/double-export.ts",
      [
        "export default class DoubleSample {",
        "  methodA(): void {}",
        "}",
        "export { DoubleSample };",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("inline named export: method / getter+setter / static method / arrow-fn property all get their own symbol + implements edge", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements");
    const bySource = (target: string) => implEdges.find((e) => e.target === target)?.source;
    expect(bySource("REQ-1020")).toBe("symbol:src/matrix.ts#MatrixSample.method");
    expect(bySource("REQ-1021")).toBe("symbol:src/matrix.ts#MatrixSample.g");
    expect(bySource("REQ-1022")).toBe("symbol:src/matrix.ts#MatrixSample.g");
    expect(bySource("REQ-1023")).toBe("symbol:src/matrix.ts#MatrixSample.sm");
    expect(bySource("REQ-1024")).toBe("symbol:src/matrix.ts#MatrixSample.onClick");
  });

  it("inline default export: method and arrow-fn property get `default.<name>` symbols", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements");
    const bySource = (target: string) => implEdges.find((e) => e.target === target)?.source;
    expect(bySource("REQ-1025")).toBe("symbol:src/matrix.ts#default.defaultMethod");
    expect(bySource("REQ-1026")).toBe("symbol:src/matrix.ts#default.onClick");
  });

  it("abstract method falls back to the class; the concrete sibling member and a static block do not crash extraction", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements");
    const bySource = (target: string) => implEdges.find((e) => e.target === target)?.source;
    // The abstract member is excluded (FR-004 category) — falls back to the class.
    expect(bySource("REQ-1027")).toBe("symbol:src/abstract-and-static-block.ts#AbstractSample");
    // The concrete sibling is still symbolized normally.
    expect(bySource("REQ-1028")).toBe(
      "symbol:src/abstract-and-static-block.ts#AbstractSample.concreteMethod",
    );
    // No symbol was synthesized for the anonymous static block.
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/abstract-and-static-block.ts")
      .map((n) => n.id);
    expect(symbolIds.sort()).toEqual([
      "symbol:src/abstract-and-static-block.ts#AbstractSample",
      "symbol:src/abstract-and-static-block.ts#AbstractSample.concreteMethod",
    ]);
  });

  it("separate export (`export { X }`) produces no member symbols, only the pre-existing class-level symbol", () => {
    const result = parse();
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/separate-export.ts")
      .map((n) => n.id);
    expect(symbolIds).toEqual(["symbol:src/separate-export.ts#SeparateSample"]);
  });

  it("alias export (`export { X as Y }`) produces no member symbols, only the class-level symbol under the alias", () => {
    const result = parse();
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/alias-export.ts")
      .map((n) => n.id);
    expect(symbolIds).toEqual(["symbol:src/alias-export.ts#Renamed"]);
  });

  it("double export (inline default + separate named): member symbols exist ONLY once, under the inline form's prefix", () => {
    const result = parse();
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/double-export.ts")
      .map((n) => n.id);
    expect(symbolIds.sort()).toEqual([
      "symbol:src/double-export.ts#DoubleSample",
      "symbol:src/double-export.ts#default",
      "symbol:src/double-export.ts#default.methodA",
    ]);
    // Never a second, specifier-named member set.
    expect(symbolIds).not.toContain("symbol:src/double-export.ts#DoubleSample.methodA");
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T014 same-name convergence)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t014-"));
    write(
      "src/getset.ts",
      [
        "export class GetSetSample {",
        "  // @impl REQ-1040",
        "  get value(): number { return 1; }",
        "  // @impl REQ-1041",
        "  set value(v: number) {}",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/static-instance.ts",
      [
        "export class StaticInstanceSample {",
        "  // @impl REQ-1042",
        "  static method(): void {}",
        "  // @impl REQ-1043",
        "  method(): void {}",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("T014(a): a get+set pair converges to ONE symbol; both occurrences' tags attribute to it", () => {
    const result = parse();
    const memberNodes = result.nodes.filter(
      (n) => n.kind === "symbol" && n.id === "symbol:src/getset.ts#GetSetSample.value",
    );
    expect(memberNodes).toHaveLength(1);
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && (e.target === "REQ-1040" || e.target === "REQ-1041"),
    );
    expect(implEdges).toHaveLength(2);
    for (const edge of implEdges) {
      expect(edge.source).toBe("symbol:src/getset.ts#GetSetSample.value");
    }
  });

  it("T014(a)/(d): editing the setter changes the converged hash; editing an unrelated sibling member does not (\\0-joined occurrence hash)", () => {
    const build = (setterBody: string, otherBody: string) =>
      [
        "export class InterleavedSample {",
        "  get value(): number { return 1; }",
        "  other(): void {" + otherBody + "}",
        "  set value(v: number) {" + setterBody + "}",
        "}",
        "",
      ].join("\n");
    const hashFor = (content: string) => {
      write("src/interleaved.ts", content);
      const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
      return result.nodes.find((n) => n.id === "symbol:src/interleaved.ts#InterleavedSample.value")
        ?.contentHash;
    };
    const base = hashFor(build("", ""));
    const afterEditingOther = hashFor(build("", "doWork();"));
    const afterEditingSetter = hashFor(build("doWork();", ""));

    expect(base).toBeDefined();
    // Editing a member sandwiched BETWEEN the get and the set (source-order
    // between the two occurrences) must NOT drift the converged hash — the
    // \0-joined hash only ever spans the get/set occurrence texts themselves.
    expect(afterEditingOther).toBe(base);
    // Editing the setter's own body — one of the converged occurrences —
    // MUST drift the hash.
    expect(afterEditingSetter).not.toBe(base);
  });

  it("T014(b): static and instance members of the same name converge to ONE symbol; both tags attribute to it", () => {
    const result = parse();
    const memberNodes = result.nodes.filter(
      (n) =>
        n.kind === "symbol" && n.id === "symbol:src/static-instance.ts#StaticInstanceSample.method",
    );
    expect(memberNodes).toHaveLength(1);
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && (e.target === "REQ-1042" || e.target === "REQ-1043"),
    );
    expect(implEdges).toHaveLength(2);
    for (const edge of implEdges) {
      expect(edge.source).toBe("symbol:src/static-instance.ts#StaticInstanceSample.method");
    }
  });

  it("T014(c): two overload signatures + one implementation converge to ONE symbol; editing the implementation body drifts the hash", () => {
    const build = (body: string) =>
      [
        "export class OverloadSample {",
        "  method(a: number): void;",
        "  method(a: string): void;",
        "  method(a: unknown): void {" + body + "}",
        "}",
        "",
      ].join("\n");
    write("src/overload.ts", build(""));
    const r1 = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const memberNodes = r1.nodes.filter(
      (n) => n.kind === "symbol" && n.id === "symbol:src/overload.ts#OverloadSample.method",
    );
    expect(memberNodes).toHaveLength(1);
    const h1 = memberNodes[0].contentHash;

    write("src/overload.ts", build("doWork();"));
    const r2 = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const h2 = r2.nodes.find(
      (n) => n.id === "symbol:src/overload.ts#OverloadSample.method",
    )?.contentHash;
    expect(h2).not.toBe(h1);
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T017 fatal-syntax fallback)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t017-"));
    write("src/target.ts", "export const t = 1;\n");
    // A file with a class (incl. a member `@impl` tag) that ALSO contains a
    // fatal syntax error elsewhere (`const x = ;`). oxc returns an empty
    // `program` for such files (see typescript-oxc-regression.test.ts R11),
    // so extractClassMembers is never even reached for this file — the
    // whole file degrades to file-level `@impl` attribution, same as a
    // fatal-syntax file with no class at all.
    write(
      "src/broken-with-class.ts",
      [
        "// @impl BRK-101",
        'import { t } from "./target.js";',
        "export class Sample {",
        "  // @impl BRK-102",
        "  methodA(): void {}",
        "}",
        "const x = ;",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not crash on a fatal-syntax file containing a class, and degrades class-member tags to file attribution", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const symbolNodes = result.nodes.filter(
      (n) => n.kind === "symbol" && n.filePath === "src/broken-with-class.ts",
    );
    expect(symbolNodes).toEqual([]);
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && (e.target === "BRK-101" || e.target === "BRK-102"),
    );
    expect(implEdges).toHaveLength(2);
    for (const edge of implEdges) {
      expect(edge.source).toBe("file:src/broken-with-class.ts");
    }
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T020 collision + warning)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t020-"));
    // Edge Cases: a string-literal export alias whose VALUE is a dotted
    // name identical to a class member's synthesized symbol name.
    write(
      "src/collision.ts",
      [
        "function helper(): void {}",
        'export { helper as "Sample.methodA" };',
        "",
        "export class Sample {",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // PR #242 review B — same collision shape, but with an `@impl` tag on
    // the LOSING declaration. Pre-fix, the loser entry was spliced out of
    // `entries` together with its attribution range, so this tag silently
    // degraded to FILE grain. Post-fix the range survives (only the node is
    // suppressed) and the tag re-attributes to the winning class member.
    write(
      "src/collision-tagged.ts",
      [
        "// @impl REQ-2001",
        "function helper(): void {}",
        'export { helper as "Sample.methodA" };',
        "",
        "export class Sample {",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("T020(a): the class member wins the ID collision and a STRUCTURED warning is emitted (not console.warn — PR #242 review A)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result;
    let consoleCalls: string[];
    try {
      result = parse();
      consoleCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    } finally {
      warnSpy.mockRestore();
    }
    // Exactly one node for the contested id — the class member's, not the
    // string-literal-aliased export's.
    const contested = result.nodes.filter((n) => n.id === "symbol:src/collision.ts#Sample.methodA");
    expect(contested).toHaveLength(1);
    // The warning is a structured entry in the parser's return value — it
    // travels through TsFragment → buildGraph warnings, so it survives a
    // parse-cache warm hit and reaches `--format json` `warnings[]`.
    const collisionWarnings = result.warnings.filter(
      (w) =>
        w.type === "class-member-collision" &&
        w.symbolId === "symbol:src/collision.ts#Sample.methodA",
    );
    expect(collisionWarnings).toHaveLength(1);
    expect(collisionWarnings[0].filePath).toBe("src/collision.ts");
    expect(collisionWarnings[0].message).toMatch(/collides with an existing/);
    // The message tells the author what happens to a tag on the loser side.
    expect(collisionWarnings[0].message).toMatch(/re-attributes to the class member/);
    // And the old side channel is gone: nothing about this collision goes
    // through console.warn anymore (it double-printed under `check --gate
    // --diff` and vanished on warm cache hits).
    expect(consoleCalls.filter((msg) => msg.includes("Sample.methodA"))).toEqual([]);
  });

  it("T020(b): the collision resolution and warning are deterministic across repeated parses", () => {
    const r1 = parse();
    const r2 = parse();
    expect(r2.warnings).toEqual(r1.warnings);
    expect(r2.nodes.filter((n) => n.kind === "symbol").map((n) => n.id)).toEqual(
      r1.nodes.filter((n) => n.kind === "symbol").map((n) => n.id),
    );
  });

  it("T020(c): a tag above the collision-LOSING declaration re-attributes to the winning class member, not to the file (PR #242 review B)", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-2001",
    );
    expect(implEdges).toHaveLength(1);
    // The loser's attribution range survives the collision, and the name it
    // resolves ("Sample.methodA") is exactly the id the winning class member
    // owns — so the tag lands on the member symbol. Pre-fix this was
    // `file:src/collision-tagged.ts` (a silent symbol→file downgrade).
    expect(implEdges[0].source).toBe("symbol:src/collision-tagged.ts#Sample.methodA");
    // The winner's node is the ONLY node under the contested id.
    expect(
      result.nodes.filter((n) => n.id === "symbol:src/collision-tagged.ts#Sample.methodA"),
    ).toHaveLength(1);
  });
});

// PR #242 review C — the OTHER collision channel: push()'s `seen`-name dedup
// silently discarding a whole entry. Pre-existing behavior for plain symbols
// (first registered wins — unchanged), but once class entries carry member
// maps, the silent drop can now swallow an entire class's member symbols, so
// those cases emit the same structured `class-member-collision` warning.
describe("createTSParser (symbol mode — class-level seen-collision warnings, PR #242 review C)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-seen-collision-"));
    // C1 order 1 — the string-literal alias export registers "Sample" FIRST
    // (both are pass-2 forms, so source order decides); the inline class of
    // the same name is then dropped by the seen dedup, member symbols and
    // all.
    write(
      "src/alias-first.ts",
      [
        "function helper(): void {}",
        'export { helper as "Sample" };',
        "export class Sample {",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // C1 order 2 — the class registers first and WINS; the alias export of
    // the same name is the dropped side. The winner carries classMembers, so
    // this direction warns too.
    write(
      "src/class-first.ts",
      [
        "export class Sample {",
        "  methodA(): void {}",
        "}",
        "function helper(): void {}",
        'export { helper as "Sample" };',
        "",
      ].join("\n"),
    );
    // C2 — two same-name classes in one file (illegal TS, but oxc parses
    // both): the second class is silently dropped by the seen dedup.
    write(
      "src/dup-class.ts",
      [
        "export class Dup {",
        "  a(): void {}",
        "}",
        "export class Dup {",
        "  b(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // Benign — `export function f(){}` + `export { f }` re-pushes the SAME
    // declaration span (the specifier resolves back to the function's own
    // LocalDecl), so it is a no-op duplicate, not a collision. MUST NOT
    // warn.
    write("src/benign.ts", ["export function f(): void {}", "export { f };", ""].join("\n"));
    // Legal declaration merges — class+namespace and interface+class are
    // valid TS; the collision warning ("rename one of them") would be wrong
    // advice, so both orders MUST stay silent (review C follow-up).
    write(
      "src/merge-ns.ts",
      [
        "export class Merged {",
        "  m(): void {}",
        "}",
        "export namespace Merged {",
        "  export const x = 1;",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/merge-iface.ts",
      [
        "export interface MergedI {",
        "  y: number;",
        "}",
        "export class MergedI {",
        "  m(): void {}",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("C1 (alias first): a class entry swallowed by the seen dedup emits a structured warning", () => {
    const result = parse();
    const warnings = result.warnings.filter(
      (w) => w.type === "class-member-collision" && w.filePath === "src/alias-first.ts",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].symbolId).toBe("symbol:src/alias-first.ts#Sample");
    // The dropped class contributed no member symbols (the drop is the
    // pre-existing first-wins behavior — only the observability is new).
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/alias-first.ts")
      .map((n) => n.id);
    expect(symbolIds).toEqual(["symbol:src/alias-first.ts#Sample"]);
  });

  it("C1 (class first): a same-name alias export dropped AGAINST a class winner emits a structured warning", () => {
    const result = parse();
    const warnings = result.warnings.filter(
      (w) => w.type === "class-member-collision" && w.filePath === "src/class-first.ts",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].symbolId).toBe("symbol:src/class-first.ts#Sample");
    // The class won, so its member symbols are intact.
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/class-first.ts")
      .map((n) => n.id)
      .sort();
    expect(symbolIds).toEqual([
      "symbol:src/class-first.ts#Sample",
      "symbol:src/class-first.ts#Sample.methodA",
    ]);
  });

  it("C2 (duplicate classes): the silently-dropped second class emits a structured warning", () => {
    const result = parse();
    const warnings = result.warnings.filter(
      (w) => w.type === "class-member-collision" && w.filePath === "src/dup-class.ts",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].symbolId).toBe("symbol:src/dup-class.ts#Dup");
    // First class won: only ITS member (`a`) is symbolized.
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/dup-class.ts")
      .map((n) => n.id)
      .sort();
    expect(symbolIds).toEqual(["symbol:src/dup-class.ts#Dup", "symbol:src/dup-class.ts#Dup.a"]);
  });

  it("benign re-push (`export function f` + `export { f }`) does NOT warn (same declaration span)", () => {
    const result = parse();
    expect(result.warnings.filter((w) => w.filePath === "src/benign.ts")).toEqual([]);
  });

  it("legal class+namespace declaration merge does NOT warn", () => {
    const result = parse();
    expect(result.warnings.filter((w) => w.filePath === "src/merge-ns.ts")).toEqual([]);
    // The class registered first and keeps its member grain.
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/merge-ns.ts")
      .map((n) => n.id)
      .sort();
    expect(symbolIds).toEqual(["symbol:src/merge-ns.ts#Merged", "symbol:src/merge-ns.ts#Merged.m"]);
  });

  it("legal interface+class declaration merge does NOT warn (interface first)", () => {
    const result = parse();
    expect(result.warnings.filter((w) => w.filePath === "src/merge-iface.ts")).toEqual([]);
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T022 edge cases 1)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t022-"));
    // T022(a) — attribution span for a decorated member includes the
    // decorator; leading-trivia rise reaches a comment ABOVE the decorator.
    write(
      "src/decorated.ts",
      [
        "function Decorator() { return (target: unknown, key: unknown) => {}; }",
        "export class DecoratedSample {",
        "  // @impl REQ-1050",
        "  @Decorator()",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // T022(b) — a floating tag between two members (comment/blank lines
    // only) attributes to the NEXT member, not the previous one.
    write(
      "src/float.ts",
      [
        "export class FloatSample {",
        "  methodA(): void {}",
        "",
        "  // @impl REQ-1051",
        "",
        "  methodB(): void {}",
        "}",
        "",
      ].join("\n"),
    );
    // T022(c) — a run of a tag, a plain comment, a blank line, another plain
    // comment, and a JSDoc block, all above the member: the rise must climb
    // through every one of them to reach the tag.
    write(
      "src/rise.ts",
      [
        "export class RiseSample {",
        "  // @impl REQ-1052",
        "  // a plain comment",
        "",
        "  // another plain comment",
        "  /**",
        "   * jsdoc block",
        "   */",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("T022(a): a tag above a decorated method's decorator attributes to the method", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1050",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/decorated.ts#DecoratedSample.methodA");
  });

  it("T022(b): a floating tag between two members attributes to the NEXT member", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1051",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/float.ts#FloatSample.methodB");
  });

  it("T022(c): leading-trivia rise climbs through consecutive comments, a blank line, and a JSDoc block", () => {
    const result = parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1052",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/rise.ts#RiseSample.methodA");
  });
});

describe("createTSParser (symbol mode — class method grain, spec 021 — T023 edge cases 2)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t023-"));
    write(
      "src/excluded.ts",
      [
        "const KEY = 'computed';",
        "export class ExcludedSample {",
        "  // @impl REQ-1060",
        "  [KEY](): void {}",
        "  // @impl REQ-1061",
        "  #priv(): void {}",
        "  // @impl REQ-1062",
        "  dataProp = 5;",
        // A function-VALUED `accessor` field — this specifically probes
        // that the exclusion is because oxc types `accessor` fields as a
        // DIFFERENT ClassElement (`AccessorProperty`), not merely because a
        // plain data property fails the Arrow/FunctionExpression check.
        "  // @impl REQ-1063",
        "  accessor accField = () => {};",
        "}",
        "",
      ].join("\n"),
    );
    write(
      "src/ctor.ts",
      ["export class CtorSample {", "  // @impl REQ-1064", "  constructor() {}", "}", ""].join(
        "\n",
      ),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const parse = () => createTSParser(root, ["src/**/*.ts"], "symbol").parse();

  it("computed name, private #member, data property, and a function-valued accessor field all fall back to the class", () => {
    const result = parse();
    const implEdges = result.edges.filter((e) => e.kind === "implements");
    const bySource = (target: string) => implEdges.find((e) => e.target === target)?.source;
    for (const target of ["REQ-1060", "REQ-1061", "REQ-1062", "REQ-1063"]) {
      expect(bySource(target)).toBe("symbol:src/excluded.ts#ExcludedSample");
    }
    // None of the four excluded member kinds produced their own symbol.
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/excluded.ts")
      .map((n) => n.id);
    expect(symbolIds).toEqual(["symbol:src/excluded.ts#ExcludedSample"]);
  });

  it("constructor is symbolized as `ClassName.constructor` and receives its own tag attribution", () => {
    const result = parse();
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/ctor.ts")
      .map((n) => n.id);
    expect(symbolIds.sort()).toEqual([
      "symbol:src/ctor.ts#CtorSample",
      "symbol:src/ctor.ts#CtorSample.constructor",
    ]);
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1064",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/ctor.ts#CtorSample.constructor");
  });
});

// PR #242 review D1 — `export declare class` is an AMBIENT declaration: its
// "members" are type-level signatures with no runtime bodies, so none of
// them get a method symbol (the `declare` flag sits on the ClassDeclaration
// node itself and extractClassMembers guards on it before walking the body).
// Tags on/above ambient members keep the pre-021 class attribution.
describe("createTSParser (symbol mode — declare class member suppression, PR #242 review D1)", () => {
  let root: string;

  const write = (relPath: string, content: string): void => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-declare-class-"));
    write(
      "src/ambient.ts",
      [
        "export declare class AmbientSample {",
        "  // @impl REQ-1070",
        "  methodA(): void;",
        "  static sm(): void;",
        "}",
        "",
        // Regression control in the SAME file: a normal exported class keeps
        // full member-grain symbolization (the declare guard must be scoped
        // to the ambient class only, zero side effects on concrete classes).
        "export class ConcreteSample {",
        "  // @impl REQ-1071",
        "  methodA(): void {}",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("`export declare class` members are not symbolized; a tag above an ambient member attributes to the class", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const symbolIds = result.nodes
      .filter((n) => n.kind === "symbol" && n.filePath === "src/ambient.ts")
      .map((n) => n.id)
      .sort();
    // The ambient class has NO member symbols and NO contains edges; the
    // concrete sibling class still has both.
    expect(symbolIds).toEqual([
      "symbol:src/ambient.ts#AmbientSample",
      "symbol:src/ambient.ts#ConcreteSample",
      "symbol:src/ambient.ts#ConcreteSample.methodA",
    ]);
    expect(
      result.edges.filter(
        (e) => e.kind === "contains" && e.source === "symbol:src/ambient.ts#AmbientSample",
      ),
    ).toEqual([]);
    const bySource = (target: string) =>
      result.edges.find((e) => e.kind === "implements" && e.target === target)?.source;
    expect(bySource("REQ-1070")).toBe("symbol:src/ambient.ts#AmbientSample");
    expect(bySource("REQ-1071")).toBe("symbol:src/ambient.ts#ConcreteSample.methodA");
  });
});

// PR #242 review G3 / spec 021 Edge Cases — several members opening on ONE
// physical line with a trailing `// @impl` on that same line: every member
// range covers the line at the same (smallest) size, so the pre-existing
// registration-order first-wins tie-break picks the FIRST member in source
// order. This pins the current behavior — it is an inherited property of the
// generic tie-break, not new semantics, and a formatter (oxfmt/prettier)
// naturally dissolves the construct into one-member-per-line.
describe("createTSParser (symbol mode — same-line multi-member trailing tag pin, PR #242 review G3)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-sameline-members-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "multi.ts"),
      [
        "export class MultiSample {",
        "  methodA(): void {} methodB(): void {} // @impl REQ-1080",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a trailing tag on a line with two members attributes to the FIRST member (registration order)", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const implEdges = result.edges.filter(
      (e) => e.kind === "implements" && e.target === "REQ-1080",
    );
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("symbol:src/multi.ts#MultiSample.methodA");
    // Determinism: a second parse agrees.
    const again = createTSParser(root, ["src/**/*.ts"], "symbol")
      .parse()
      .edges.filter((e) => e.kind === "implements" && e.target === "REQ-1080");
    expect(again).toEqual(implEdges);
  });
});

// issue #266 — `globCodeFiles` used to `resolve(rootDir, p)` EVERY pattern,
// including fast-glob-convention negative patterns (`"!src/generated/**"`),
// which mangled the leading `!` into the middle of an absolute path and
// silently matched nothing — the exclusion had no effect. Fixture below has
// three code files under different subdirectories so a positive-only run
// (regression case) picks up all of them, and each negative-pattern case can
// assert a specific subset is excluded.
describe("globCodeFiles (issue #266 — negative glob patterns)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-t266-"));
    const write = (relPath: string): void => {
      const abs = join(root, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "export const x = 1;\n");
    };
    write("src/keep.ts");
    write("src/generated/gen.ts");
    write("src/other/skip.ts");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const relFiles = (files: string[]): string[] => files.map((f) => f.slice(root.length + 1)).sort();

  it("regression: a plain (no `!`) pattern list matches every file, unchanged", () => {
    const files = globCodeFiles(root, ["src/**/*.ts"]);
    expect(relFiles(files)).toEqual(["src/generated/gen.ts", "src/keep.ts", "src/other/skip.ts"]);
  });

  it("mixed positive/negative: a leading `!` pattern excludes its matches", () => {
    const files = globCodeFiles(root, ["src/**/*.ts", "!src/generated/**"]);
    expect(relFiles(files)).toEqual(["src/keep.ts", "src/other/skip.ts"]);
  });

  it("multiple negative patterns compose (all excluded subsets are dropped)", () => {
    const files = globCodeFiles(root, ["src/**/*.ts", "!src/generated/**", "!src/other/**"]);
    expect(relFiles(files)).toEqual(["src/keep.ts"]);
  });

  it("negative-only pattern list matches zero files (natural degenerate case)", () => {
    const files = globCodeFiles(root, ["!src/**/*.ts"]);
    expect(files).toEqual([]);
  });

  it("empty pattern list matches zero files", () => {
    expect(globCodeFiles(root, [])).toEqual([]);
  });

  // Consistency check (buildSymbolNameTable's own invariant, spec 020):
  // `createTSParser`'s internal file enumeration (`enumerateFiles`) must
  // agree with `globCodeFiles` on which files a negative pattern excludes —
  // they used to be two independent glob call sites and only `globCodeFiles`
  // is directly under test above.
  it("createTSParser (via enumerateFiles) excludes the same files as globCodeFiles", () => {
    const patterns = ["src/**/*.ts", "!src/generated/**"];
    const globbed = relFiles(globCodeFiles(root, patterns));
    const parsed = createTSParser(root, patterns).parse();
    const parsedFiles = parsed.nodes
      .filter((n) => n.kind === "file" || n.kind === "test")
      .map((n) => n.filePath)
      .sort();
    expect(parsedFiles).toEqual(globbed);
    expect(parsedFiles).toEqual(["src/keep.ts", "src/other/skip.ts"]);
  });
});
