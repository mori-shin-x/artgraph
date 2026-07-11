import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parseSync as oxcParseSync } from "oxc-parser";
import {
  createTSParser,
  parseTSFilePaths,
  maxBracketNestingDepth,
  MAX_BRACKET_NESTING_DEPTH,
} from "../src/parsers/typescript.js";
import type { ParsedTS } from "../src/parsers/typescript.js";

// Canaries for two related, empirically-discovered oxc-parser failure modes
// (issues #246 and #247) that the guard added in src/parsers/typescript.ts
// (safeParseSync / maxBracketNestingDepth / MAX_BRACKET_NESTING_DEPTH) is
// built on top of:
//
//   #246  Today's oxc-parser gives a file with ANY syntax error a completely
//         EMPTY `program.body` (no partial/recovered AST). The symbol-mode
//         extraction guard (`parsed.errors.length === 0` at the extractSymbols
//         call site) relies on this — it exists to stop a FUTURE oxc version
//         (one that starts returning a partial AST for erroring files) from
//         silently synthesizing symbol nodes / `contains` edges off a
//         half-parsed, broken class. The describe block below pins today's
//         empty-program behavior; if oxc ever changes it, this block goes
//         red, which is the intended signal to re-examine that guard.
//
//   #247  parseSync's native (Rust) binding SIGSEGVs the whole process — not
//         a catchable JS exception — when given an expression with deep
//         enough bracket nesting. MAX_BRACKET_NESTING_DEPTH (1000) sits with
//         a 3.5x margin below the empirically observed crash threshold
//         (~3,500). The subprocess-isolated block below reproduces the raw
//         crash (bypassing our own guard, to prove the guard is needed); the
//         other blocks exercise the guard itself.

function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// A single, deeply-nested parenthesized expression of exactly `depth`,
// preceded by an import so tests can observe "did parsing even run" via the
// presence/absence of the resulting `imports` edge (the bare expression
// alone gives no other observable signal of parse success vs. skip).
function importPlusNesting(
  depth: number,
  importSpecifier = "./target.js",
  importedName = "z",
): string {
  return (
    `import { ${importedName} } from "${importSpecifier}";\n` +
    `const x = ${"(".repeat(depth)}${importedName}${")".repeat(depth)};\n`
  );
}

// ---------------------------------------------------------------------------
// #246 — a file with a syntax error gets an empty program.body (no partial
// AST recovery) from today's oxc-parser. Direct parseSync probes, no
// artgraph code involved.
// ---------------------------------------------------------------------------

describe("oxc-parser canary (issue #246): fatal syntax errors yield an EMPTY program", () => {
  it.each<[name: string, source: string]>([
    ["unclosed class body", "class {"],
    ["missing variable initializer", "const x = ;"],
    ["unclosed function parameter list", "function (something) {"],
    ["unterminated string literal", 'const s = "abc'],
    ["random non-code garbage", "@@@ ~~~ !!! %%% ###"],
    ["unbalanced opening braces", "{{{{"],
    ["malformed import clause", 'import from "x";'],
  ])("%s: errors.length > 0 AND program.body is empty", (_name, source) => {
    const result = oxcParseSync("broken-canary.ts", source);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.program.body.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maxBracketNestingDepth — pure-function accuracy, including the documented
// over-approximation (string-literal brackets are counted too).
// ---------------------------------------------------------------------------

describe("maxBracketNestingDepth", () => {
  it("returns 0 for content with no brackets at all", () => {
    expect(maxBracketNestingDepth("const x = 1;")).toBe(0);
  });

  it("counts same-type nesting depth", () => {
    expect(maxBracketNestingDepth("((()))")).toBe(3);
  });

  it("counts mixed bracket-type nesting as one running depth counter", () => {
    expect(maxBracketNestingDepth("([{}])")).toBe(3);
  });

  it("clamps at 0 for unbalanced closers (never goes negative) and resumes counting after", () => {
    expect(maxBracketNestingDepth(")))")).toBe(0);
    expect(maxBracketNestingDepth(")))(((")).toBe(3);
  });

  it("matches MAX_BRACKET_NESTING_DEPTH exactly at the boundary depths used elsewhere in this file", () => {
    const atLimit =
      "(".repeat(MAX_BRACKET_NESTING_DEPTH) + "1" + ")".repeat(MAX_BRACKET_NESTING_DEPTH);
    expect(maxBracketNestingDepth(atLimit)).toBe(MAX_BRACKET_NESTING_DEPTH);
    const overLimit =
      "(".repeat(MAX_BRACKET_NESTING_DEPTH + 1) + "1" + ")".repeat(MAX_BRACKET_NESTING_DEPTH + 1);
    expect(maxBracketNestingDepth(overLimit)).toBe(MAX_BRACKET_NESTING_DEPTH + 1);
  });

  // Deliberate over-approximation (documented on the function itself): this
  // is a plain-text bracket-character count, not a tokenizer, so a string
  // literal's contents are counted as if they were real nesting even though
  // the code's ACTUAL syntactic nesting here is 0. Guard-purpose over-count
  // (false positive: skip-with-warning something safe) is the accepted
  // tradeoff — see the function's doc comment in src/parsers/typescript.ts.
  it("over-counts unmatched bracket characters inside a string literal (documented false-positive case)", () => {
    const src = `const s = "${"(".repeat(5)}";`; // syntactically valid; real nesting is 0
    expect(maxBracketNestingDepth(src)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// safeParseSync's depth-guard boundary, observed through the public parser
// entry point (parseTSFilePaths) rather than the unexported helper itself.
// A depth of exactly MAX_BRACKET_NESTING_DEPTH is well inside the empirically
// safe range (parses fine up to ~3,000 in-process; observed crash is
// ~3,500), so running the real parser on it here is safe.
// ---------------------------------------------------------------------------

describe("safeParseSync depth-guard boundary (via parseTSFilePaths)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-boundary-"));
    write(root, "src/target.ts", "export const z = 1;\n");
    write(root, "src/at-limit.ts", importPlusNesting(MAX_BRACKET_NESTING_DEPTH));
    write(root, "src/over-limit.ts", importPlusNesting(MAX_BRACKET_NESTING_DEPTH + 1));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(`parses a file at exactly the limit (${MAX_BRACKET_NESTING_DEPTH}) normally: no warning, import edge present`, () => {
    const abs = join(root, "src/at-limit.ts");
    const parsed: ParsedTS = parseTSFilePaths(root, [abs]).get(abs)!;
    expect(parsed.warnings).toEqual([]);
    expect(parsed.edges).toContainEqual({
      source: "file:src/at-limit.ts",
      target: "file:src/target.ts",
      kind: "imports",
      provenances: ["ts-import"],
    });
  });

  it(`skips parsing one level past the limit (${MAX_BRACKET_NESTING_DEPTH + 1}): one warning, no import edge`, () => {
    const abs = join(root, "src/over-limit.ts");
    const parsed: ParsedTS = parseTSFilePaths(root, [abs]).get(abs)!;
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatchObject({
      type: "pathological-bracket-nesting",
      symbolId: "file:src/over-limit.ts",
      filePath: "src/over-limit.ts",
    });
    expect(parsed.warnings[0].message).toContain(String(MAX_BRACKET_NESTING_DEPTH + 1));
    expect(parsed.warnings[0].message).toContain(String(MAX_BRACKET_NESTING_DEPTH));
    expect(
      parsed.edges.some((e) => e.kind === "imports" && e.source === "file:src/over-limit.ts"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #247 crash canary — subprocess-isolated. This BYPASSES artgraph's own
// guard entirely (calls oxc-parser directly, the way it would be called
// with no guard at all) to prove the native crash the guard exists for is
// real, on the exact dependency version this repo runs. Isolated in a child
// process so a SIGSEGV here does not take the test runner down with it.
// ---------------------------------------------------------------------------

describe("oxc-parser canary (issue #247): native crash on pathological bracket nesting", () => {
  it("parseSync crashes the process on 50,000-deep bracket nesting (subprocess-isolated)", () => {
    // Resolve oxc-parser's real on-disk entry point from THIS repo's
    // node_modules (matches how src/parsers/typescript.ts's `loadOxc`
    // resolves it), then have the child require that absolute path
    // directly — no reliance on the child's cwd or its own module
    // resolution.
    const oxcEntry = createRequire(import.meta.url).resolve("oxc-parser");
    const depth = 50_000;
    const script = [
      `const oxc = require(${JSON.stringify(oxcEntry)});`,
      `const depth = ${depth};`,
      `const src = "const x = " + "(".repeat(depth) + "1" + ")".repeat(depth) + ";";`,
      `oxc.parseSync("crash-probe.ts", src);`,
      `console.log("did not crash");`,
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script], { timeout: 10_000 });

    // A native SIGSEGV kills the child via a signal rather than a normal
    // exit — Node's spawnSync surfaces that as `signal: "SIGSEGV"` with
    // `status: null` (the OS-shell-level "128 + signal number" = 139
    // convention is a shell artifact, not something spawnSync's `status`
    // field reports directly). Treat either "killed by a signal" or "a
    // nonzero numeric exit" as a crash, so the assertion isn't fragile to
    // exactly which of those two forms the platform/Node version reports.
    const crashed = result.signal !== null || (result.status !== null && result.status !== 0);
    expect(crashed).toBe(true);
    // If this assertion starts FAILING (the child exits 0, prints "did
    // not crash"), oxc-parser's native parser has become stack-safe at
    // this depth — good news, but it means MAX_BRACKET_NESTING_DEPTH's
    // justification (issue #247) should be re-examined: the guard may no
    // longer be necessary at all, or its safe margin may have changed.
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Integration: a full createTSParser scan over a fixture directory
// containing both a pathological file (2,000-deep nesting — safely above
// MAX_BRACKET_NESTING_DEPTH, safely below the observed ~3,500 crash depth,
// so this itself never risks crashing the in-process test runner) and a
// normal file. The scan must not throw, must warn exactly once, must still
// produce a file node for the pathological file, and must extract the
// normal file's imports/symbols/@impl tags exactly as if the pathological
// file were not there.
// ---------------------------------------------------------------------------

describe("integration: createTSParser survives a pathological file in the scan set (issue #247)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-canary-scan-"));
    write(root, "src/normal-target.ts", "export const helloTarget = 1;\n");
    write(
      root,
      "src/normal.ts",
      [
        'import { helloTarget } from "./normal-target.js";',
        "// @impl CANARY-001",
        "export function normalFn(): number {",
        "  return helloTarget;",
        "}",
        "",
      ].join("\n"),
    );
    write(
      root,
      "src/pathological.ts",
      importPlusNesting(2000, "./normal-target.js", "helloTarget"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not crash scanning a 2,000-deep bracket-nesting file", () => {
    expect(() => createTSParser(root, ["src/**/*.ts"], "symbol").parse()).not.toThrow();
  });

  it("emits exactly one pathological-bracket-nesting warning, for the pathological file", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const nestingWarnings = result.warnings.filter(
      (w) => w.type === "pathological-bracket-nesting",
    );
    expect(nestingWarnings).toHaveLength(1);
    expect(nestingWarnings[0].filePath).toBe("src/pathological.ts");
    expect(nestingWarnings[0].symbolId).toBe("file:src/pathological.ts");
  });

  it("still creates a file node for the pathological file (degraded, not dropped) with no import edge", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    const node = result.nodes.find((n) => n.id === "file:src/pathological.ts");
    expect(node?.kind).toBe("file");
    expect(
      result.edges.some((e) => e.source === "file:src/pathological.ts" && e.kind === "imports"),
    ).toBe(false);
  });

  it("keeps extracting the normal file's imports, symbols, and @impl tags unaffected", () => {
    const result = createTSParser(root, ["src/**/*.ts"], "symbol").parse();
    // Symbol mode resolves a named import to the specific exported symbol,
    // not the whole file — this is unrelated to the #247 guard and just
    // pins ordinary symbol-mode import resolution for this fixture.
    expect(
      result.edges.some(
        (e) =>
          e.kind === "imports" &&
          e.source === "file:src/normal.ts" &&
          e.target === "symbol:src/normal-target.ts#helloTarget",
      ),
    ).toBe(true);
    expect(result.nodes.some((n) => n.id === "symbol:src/normal.ts#normalFn")).toBe(true);
    expect(
      result.edges.some(
        (e) =>
          e.kind === "implements" &&
          e.source === "symbol:src/normal.ts#normalFn" &&
          e.target === "CANARY-001",
      ),
    ).toBe(true);
  });
});
