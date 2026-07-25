import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSymbolNameTable } from "../src/trace/symbol-table.js";
import { MAX_BRACKET_NESTING_DEPTH } from "../src/parsers/typescript.js";

// issue #269 — `buildSymbolNameTable`'s "Source 2" class-member walk used to
// call `loadOxc().parseSync(filePath, content)` DIRECTLY, via its own copy of
// `loadOxc`, bypassing the bracket-nesting depth guard added for issue #247
// (`safeParseSync` in src/parsers/typescript.ts). A file whose bracket
// nesting is deep enough natively SIGSEGVs oxc-parser's Rust binding — not a
// catchable JS exception — so this call site could crash the whole process
// for trace-dependent commands, even though `createTSParser`'s own parse
// path (Source 1, used earlier in the same function) was already guarded.
//
// Fixed by routing through the shared, exported `safeParseSync` instead.
// This test uses a depth (2,000) that is safely ABOVE
// MAX_BRACKET_NESTING_DEPTH (so the guard's skip path is exercised) and
// safely BELOW the empirically observed ~3,500 native crash threshold (so
// running it in-process here — without the fix — would still be expected to
// SIGSEGV per issue #247's own canary, not merely misbehave; this pins the
// SKIP behavior itself rather than re-proving the underlying native crash,
// which tests/parser-oxc-canary.test.ts already does via subprocess
// isolation).
function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const PATHOLOGICAL_DEPTH = 2000;

// Pin the fixture's premise: the depth must sit ABOVE the guard threshold
// (or this suite silently stops exercising the skip path if the constant is
// ever raised past it — see the doc comment above for the upper bound too).
if (PATHOLOGICAL_DEPTH <= MAX_BRACKET_NESTING_DEPTH) {
  throw new Error(
    `fixture depth ${PATHOLOGICAL_DEPTH} no longer exceeds MAX_BRACKET_NESTING_DEPTH (${MAX_BRACKET_NESTING_DEPTH}) — bump PATHOLOGICAL_DEPTH`,
  );
}

describe("buildSymbolNameTable survives a pathologically deep-bracket-nesting file (issue #269)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-symtable-269-"));
    write(
      root,
      "src/normal.ts",
      ["export class Cart {", "  add(): number {", "    return 1;", "  }", "}", ""].join("\n"),
    );
    write(
      root,
      "src/pathological.ts",
      [
        "export class Deep {",
        "  compute(): number {",
        `    return ${"(".repeat(PATHOLOGICAL_DEPTH)}1${")".repeat(PATHOLOGICAL_DEPTH)};`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not crash (does not throw / SIGSEGV) building the table over a set containing a pathological file", () => {
    expect(() => buildSymbolNameTable(root, ["src/**/*.ts"])).not.toThrow();
  });

  it("still resolves a normal file's class-member name to the member's own symbol id", () => {
    const { table } = buildSymbolNameTable(root, ["src/**/*.ts"]);
    expect(table.hasFile("src/normal.ts")).toBe(true);
    expect(table.resolve("src/normal.ts", "add")).toEqual({
      kind: "symbol",
      id: "symbol:src/normal.ts#Cart.add",
    });
  });

  it("fails safe (file-fallback, never a crash) resolving a name inside the pathological file — its class member was never symbolized", () => {
    const { table } = buildSymbolNameTable(root, ["src/**/*.ts"]);
    expect(table.hasFile("src/pathological.ts")).toBe(true);
    expect(table.resolve("src/pathological.ts", "compute")).toEqual({
      kind: "file-fallback",
      id: "file:src/pathological.ts",
    });
  });
});

// issue #377 — a repo-relative path may legally contain `#`. Four sites split a
// `symbol:<path>#<name>` id on the FIRST `#`, which cuts inside such a path.
//
// These four sites masked each other: `buildSymbolNameTable` corrupted the
// candidate NAME (`ird.ts#weird` instead of `weird`), the symbol-grain lookup
// therefore missed, and the file-grain fallback — which uses the caller's own
// relPath and so happened to be right — covered it up. Repairing that site
// alone makes the now-correct `symbol:` id flow into `resolveTraceGraphNodeId`,
// which (unrepaired) computes `file:src/we` and finds nothing, dropping the
// evidence with no warning. So these assertions belong together: they fail if
// any one of the sites regresses on its own.
describe("symbol id splitting with `#` in the file path (issue #377)", () => {
  let root: string;
  const WEIRD = "src/we#ird.ts";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-377-"));
    write(
      root,
      WEIRD,
      ["export function weird(): void {}", "export class Odd {", "  m(): void {}", "}", ""].join(
        "\n",
      ),
    );
    write(root, "src/plain.ts", ["export function fn(): void {}", ""].join("\n"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a top-level symbol at symbol grain, not via the file fallback", () => {
    const { table } = buildSymbolNameTable(root, ["src/**/*.ts"], ["tests/**/*.test.ts"]);
    // Before the fix this was {kind: "file-fallback", id: "file:src/we#ird.ts"}
    // — accidentally the right file, but the wrong grain, and only correct
    // because the name had been corrupted badly enough to miss entirely.
    expect(table.resolve(WEIRD, "weird")).toEqual({
      kind: "symbol",
      id: `symbol:${WEIRD}#weird`,
    });
  });

  it("still resolves class members in such a file", () => {
    const { table } = buildSymbolNameTable(root, ["src/**/*.ts"], ["tests/**/*.test.ts"]);
    expect(table.resolve(WEIRD, "m")).toEqual({ kind: "symbol", id: `symbol:${WEIRD}#Odd.m` });
  });

  it("leaves paths without `#` untouched", () => {
    const { table } = buildSymbolNameTable(root, ["src/**/*.ts"], ["tests/**/*.test.ts"]);
    expect(table.resolve("src/plain.ts", "fn")).toEqual({
      kind: "symbol",
      id: "symbol:src/plain.ts#fn",
    });
  });
});
