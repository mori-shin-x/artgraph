// spec 020 (tasks.md T012, plan.md Cat2-(b)) — regression pin closing the
// Cat2 SSOT pair T006 deliberately created: `src/vitest/runner.ts` cannot
// import `src/parsers/typescript.ts` (plan.md Structure Decision — the CLI
// bundle must stay vitest-agnostic, `pnpm knip` enforces no import from a
// CLI entry point into `src/vitest/`), so the runner's file-hash function is
// a hand-duplicated copy of the parser's file-mode contentHash algorithm.
// This test is the only thing keeping the two definitions honest: it pins
// them to produce byte-identical output for the same content, including the
// BOM-stripping edge case both sides special-case.
import { describe, it, expect } from "vitest";
import { hash, stripBom } from "../src/parsers/typescript.js";
import { hashContent } from "../src/vitest/runner.js";

// The parser's own file-mode contentHash computation (src/parsers/typescript.ts
// `parseTSFile`: `hash(stripBom(content))`), reconstructed here from its two
// exported primitives rather than re-implemented — this test compares
// runner.ts's `hashContent` against the REAL parser algorithm, not a third
// copy of it.
function parserFileHash(content: string): string {
  return hash(stripBom(content));
}

describe("SSOT: src/vitest/runner.ts hashContent === src/parsers/typescript.ts file-mode contentHash", () => {
  it("matches for plain ASCII content", () => {
    const content = "export function foo() {\n  return 1;\n}\n";
    expect(hashContent(content)).toBe(parserFileHash(content));
  });

  it("matches for empty content", () => {
    expect(hashContent("")).toBe(parserFileHash(""));
  });

  it("matches when the content carries a UTF-8 BOM (both sides strip it identically)", () => {
    const withBom = "﻿export function foo() {\n  return 1;\n}\n";
    expect(hashContent(withBom)).toBe(parserFileHash(withBom));
    // The BOM itself must not leak into the hash on either side: with-BOM
    // and without-BOM inputs must hash identically.
    const withoutBom = withBom.slice(1);
    expect(hashContent(withBom)).toBe(hashContent(withoutBom));
    expect(parserFileHash(withBom)).toBe(parserFileHash(withoutBom));
  });

  it("matches for content containing characters beyond the BMP (surrogate pairs)", () => {
    const content = 'export const emoji = "🎉";\n';
    expect(hashContent(content)).toBe(parserFileHash(content));
  });

  it("produces different hashes for different content (sanity — not a constant-hash bug)", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});
