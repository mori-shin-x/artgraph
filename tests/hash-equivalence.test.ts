// spec 021 (tasks.md T003/T004, research.md V5) — SSOT direct pin.
// `src/trace/schema.ts` hoists the repo's file-mode contentHash rule (BOM
// strip → sha256 → 16 hex chars) so the vitest plugin (main process) and
// both runner engines (worker) share one definition instead of hand-copies
// (spec 020's Cat2 pair, previously pinned only against `src/vitest/runner.ts`'s
// duplicate, is now closed — schema.ts IS the definition, not a third copy).
// This test hits schema.ts directly and compares it against
// `src/parsers/typescript.ts`'s independently-defined file-mode contentHash
// (`hash(stripBom(content))`) — the graph's own hash, which staleness
// detection (spec 020 D7) compares shard-recorded hashes against. Byte
// identity here is what keeps the two sides honest.
import { describe, it, expect } from "vitest";
import { hash, stripBom as parserStripBom } from "../src/parsers/typescript.js";
import { hashContent, stripBom } from "../src/trace/schema.js";

// The parser's own file-mode contentHash computation (src/parsers/typescript.ts
// `parseTSFile`: `hash(stripBom(content))`), reconstructed here from its two
// exported primitives rather than re-implemented — this test compares
// schema.ts's `hashContent` against the REAL parser algorithm, not a third
// copy of it.
function parserFileHash(content: string): string {
  return hash(parserStripBom(content));
}

describe("SSOT: src/trace/schema.ts hashContent === src/parsers/typescript.ts file-mode contentHash", () => {
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

describe("SSOT: src/trace/schema.ts stripBom === src/parsers/typescript.ts stripBom", () => {
  it("strips a leading BOM identically on both sides", () => {
    const withBom = "﻿const x = 1;\n";
    expect(stripBom(withBom)).toBe(parserStripBom(withBom));
    expect(stripBom(withBom)).toBe(withBom.slice(1));
  });

  it("leaves BOM-less content untouched on both sides", () => {
    const content = "const x = 1;\n";
    expect(stripBom(content)).toBe(parserStripBom(content));
    expect(stripBom(content)).toBe(content);
  });
});
