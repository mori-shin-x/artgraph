// issue #336 (PR #336 meta-review F3/F4) — direct unit coverage of
// `warningKey`/`diffPostWriteWarnings` (`src/rename-executor.ts`), the pure
// helpers `RenameResult.postWriteWarnings` is built from. Exercised here at
// unit level (rather than only end-to-end through the CLI, as
// `tests/rename-cli.test.ts`'s existing `postWriteWarnings` suite does)
// because the two scenarios this fix targets are impractical to reproduce
// reliably end-to-end:
//
//   F4 — two independent `scan()` calls enumerating the exact same file SET
//        in a different order (this depends on directory-traversal/glob
//        order, which isn't something a fixture can deterministically force
//        to differ between a pre-write and post-write scan).
//   F3 — a REAL EMFILE/ENFILE condition hitting the pre-write scan and the
//        post-write scan with a DIFFERENT "first offending file" each time
//        (this would require orchestrating actual file-descriptor
//        exhaustion at two specific points in a rename run).
//
// Both `warningKey` and `diffPostWriteWarnings` are pure functions of
// `BuildWarning[]`, so constructing the pre/post arrays directly is the
// precise, deterministic way to pin the exact keying rule.

import { describe, expect, it } from "vitest";
import { diffPostWriteWarnings, warningKey } from "../src/rename-executor.js";
import type { BuildWarning } from "../src/graph/builder.js";

function dup(files: string[], id = "REQ-100"): BuildWarning {
  return { type: "duplicate-id", id, files, message: `duplicate ID "${id}"` };
}

function exhausted(id: string, files: string[], message: string): BuildWarning {
  return { type: "system-resource-exhausted", id, files, message };
}

describe("rename-executor: warningKey (issue #336 F3/F4)", () => {
  it("F4: is stable across a reversed `files` order for an ordinary warning type", () => {
    const a = dup(["specs/a.md", "specs/b.md"]);
    const b = dup(["specs/b.md", "specs/a.md"]);
    expect(warningKey(a)).toBe(warningKey(b));
  });

  it("F4: still distinguishes a genuinely different `files` SET (not just order)", () => {
    const a = dup(["specs/a.md", "specs/b.md"]);
    const b = dup(["specs/a.md", "specs/c.md"]);
    expect(warningKey(a)).not.toBe(warningKey(b));
  });

  it("F3: system-resource-exhausted keys on `type` alone — differing id/files/message collapse to the same key", () => {
    const a = exhausted("doc:specs/a.md", ["specs/a.md"], "fd exhaustion (EMFILE) round 1");
    const b = exhausted("glob:code-files", [], "fd exhaustion (ENFILE) round 2");
    expect(warningKey(a)).toBe(warningKey(b));
  });

  it("F3: a DIFFERENT warning type is never collapsed by the system-resource-exhausted special case", () => {
    const a = exhausted("doc:specs/a.md", ["specs/a.md"], "fd exhaustion");
    const b = dup(["specs/a.md"]);
    expect(warningKey(a)).not.toBe(warningKey(b));
  });
});

describe("rename-executor: diffPostWriteWarnings (issue #336 F3/F4)", () => {
  it("F4: a duplicate-id warning whose `files` enumerate in reversed order across pre/post scans is NOT reported as new", () => {
    const pre: BuildWarning[] = [dup(["specs/a.md", "specs/b.md"])];
    const post: BuildWarning[] = [dup(["specs/b.md", "specs/a.md"])];
    expect(diffPostWriteWarnings(post, pre)).toEqual([]);
  });

  it("F3: system-resource-exhausted recurring (with a different id/files/message) across pre/post scans is NOT reported as new", () => {
    const pre: BuildWarning[] = [
      exhausted("doc:specs/a.md", ["specs/a.md"], "fd exhaustion (EMFILE) pre-write"),
    ];
    const post: BuildWarning[] = [
      exhausted("glob:code-files", [], "fd exhaustion (ENFILE) post-write"),
    ];
    expect(diffPostWriteWarnings(post, pre)).toEqual([]);
  });

  it("F3: a system-resource-exhausted warning ABSENT pre-write that appears post-write still surfaces (no blanket exclusion)", () => {
    const pre: BuildWarning[] = [];
    const post: BuildWarning[] = [
      exhausted("doc:specs/a.md", ["specs/a.md"], "fd exhaustion (EMFILE)"),
    ];
    expect(diffPostWriteWarnings(post, pre)).toEqual(post);
  });

  it("a genuinely new warning of an ordinary type (not present pre-write) still surfaces", () => {
    const pre: BuildWarning[] = [];
    const post: BuildWarning[] = [dup(["specs/a.md", "specs/b.md"])];
    expect(diffPostWriteWarnings(post, pre)).toEqual(post);
  });

  it("returns undefined unchanged when no post-write scan ran at all", () => {
    expect(diffPostWriteWarnings(undefined, [dup(["specs/a.md"])])).toBeUndefined();
  });
});
