import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  rewriteSpecListItem,
  rewriteSpecHeading,
  rewriteImplTags,
  rewriteTestTags,
  rewriteFrontmatter,
  expandFrontmatterDependsOn,
  rewriteAnnotationIds,
  rewriteFile,
} from "../src/rename.js";
import { buildGraph } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";
import {
  renameLockKey,
  splitLockKey,
  mergeLockKeys,
} from "../src/rename-lock.js";
import { isValidTargetId } from "../src/id.js";
import type { LockFile } from "../src/types.js";

// ── rewriteSpecListItem ─────────────────────────────────────────────

describe("rewriteSpecListItem", () => {
  it("rewrites plain list item ID", () => {
    const input = "- REQ-001: user login flow";
    const { content, changes } = rewriteSpecListItem(input, "REQ-001", "REQ-100");
    expect(content).toBe("- REQ-100: user login flow");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("spec-list-item");
  });

  it("rewrites bold-formatted list item ID", () => {
    const input = "- **REQ-001**: user login flow";
    const { content, changes } = rewriteSpecListItem(input, "REQ-001", "REQ-100");
    expect(content).toBe("- **REQ-100**: user login flow");
    expect(changes).toHaveLength(1);
  });

  it("does NOT rewrite ID in normal text (not a list item)", () => {
    const input = "This paragraph references REQ-001 for context.";
    const { content, changes } = rewriteSpecListItem(input, "REQ-001", "REQ-100");
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  it("rewrites multiple occurrences in the same file", () => {
    const input = [
      "- REQ-001: first item",
      "Some text in between",
      "- REQ-001: second item",
    ].join("\n");
    const { content, changes } = rewriteSpecListItem(input, "REQ-001", "REQ-100");
    expect(content).toBe(
      [
        "- REQ-100: first item",
        "Some text in between",
        "- REQ-100: second item",
      ].join("\n"),
    );
    expect(changes).toHaveLength(2);
  });

  it("does not touch a prefix-colliding ID (REQ-1 vs REQ-10)", () => {
    const input = ["- REQ-1: first", "- REQ-10: tenth"].join("\n");
    const { content, changes } = rewriteSpecListItem(input, "REQ-1", "REQ-2");
    expect(content).toBe(["- REQ-2: first", "- REQ-10: tenth"].join("\n"));
    expect(changes).toHaveLength(1);
  });

  it("ignores list items the parser does not treat as req IDs", () => {
    // The parser's LIST_ITEM_RE only captures `[A-Z][A-Za-z]*-\\d+`, so a
    // namespace-qualified token in a list item is not a tracked req and must
    // not be rewritten (rewriter/parser parity).
    const input = "- 001-auth/FR-001: auth feature";
    const { content, changes } = rewriteSpecListItem(
      input,
      "001-auth/FR-001",
      "001-auth/FR-010",
    );
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  // Meta-review #5: task-ID rename was previously half-applied because the
  // rewriter only knew about req patterns. Now it also rewrites spec-kit /
  // kiro task definition lines so `rename --from T001 --to T999` doesn't
  // leave the spec side intact while flipping the code side.
  it("rewrites a spec-kit task definition `- [X] T001 ...`", () => {
    const input = "- [X] T001 implement login @impl(auth-login)";
    const { content, changes } = rewriteSpecListItem(input, "T001", "T999");
    expect(content).toBe("- [X] T999 implement login @impl(auth-login)");
    expect(changes).toHaveLength(1);
  });

  it("rewrites a kiro hierarchical task ID `- [x] 1.1 ...`", () => {
    const input = "- [x] 1.1 Stripe integration";
    const { content, changes } = rewriteSpecListItem(input, "1.1", "1.5");
    expect(content).toBe("- [x] 1.5 Stripe integration");
    expect(changes).toHaveLength(1);
  });
});

// ── rewriteSpecHeading ──────────────────────────────────────────────

describe("rewriteSpecHeading", () => {
  it("rewrites Requirement N heading", () => {
    const input = "### Requirement 1: Login must use OAuth";
    const { content, changes } = rewriteSpecHeading(
      input,
      "Requirement-1",
      "Requirement-10",
    );
    expect(content).toBe("### Requirement 10: Login must use OAuth");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("spec-heading");
  });

  it("returns unchanged content when oldId is not Requirement-N format", () => {
    const input = "### Some Heading";
    const { content, changes } = rewriteSpecHeading(input, "REQ-001", "REQ-100");
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });
});

// ── rewriteImplTags ─────────────────────────────────────────────────

describe("rewriteImplTags", () => {
  it("rewrites single @impl tag", () => {
    const input = "// @impl REQ-001";
    const { content, changes } = rewriteImplTags(input, "REQ-001", "REQ-100");
    expect(content).toBe("// @impl REQ-100");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("impl-tag");
  });

  it("replaces only the target ID in a multi-ID @impl line", () => {
    const input = "// @impl REQ-001 REQ-002";
    const { content, changes } = rewriteImplTags(input, "REQ-001", "REQ-100");
    expect(content).toBe("// @impl REQ-100 REQ-002");
    expect(changes).toHaveLength(1);
  });

  it("does NOT rewrite non-@impl comments", () => {
    const input = "// This relates to REQ-001";
    const { content, changes } = rewriteImplTags(input, "REQ-001", "REQ-100");
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  it("handles doc:auth format ID", () => {
    const input = "// @impl doc:auth";
    const { content, changes } = rewriteImplTags(input, "doc:auth", "doc:auth-v2");
    expect(content).toBe("// @impl doc:auth-v2");
    expect(changes).toHaveLength(1);
  });
});

// ── rewriteTestTags ─────────────────────────────────────────────────

describe("rewriteTestTags", () => {
  it("rewrites bracket-wrapped ID", () => {
    const input = 'it("[REQ-001] should validate email", () => {});';
    const { content, changes } = rewriteTestTags(input, "REQ-001", "REQ-100");
    expect(content).toBe('it("[REQ-100] should validate email", () => {});');
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("test-tag");
  });

  it("rewrites req annotation pattern", () => {
    const input = 'req: "REQ-001"';
    const { content, changes } = rewriteTestTags(input, "REQ-001", "REQ-100");
    expect(content).toBe('req: "REQ-100"');
    expect(changes).toHaveLength(1);
  });

  it("rewrites an unquoted req: annotation", () => {
    const input = "req: REQ-001";
    const { content, changes } = rewriteTestTags(input, "REQ-001", "REQ-100");
    expect(content).toBe("req: REQ-100");
    expect(changes).toHaveLength(1);
  });

  it("only rewrites the parser-tracked `req:` key (case-sensitive)", () => {
    // The parser's TEST_ANNOTATION_RE tracks `req:` exclusively and
    // case-sensitively, so `Req:`/`requirement:`/`spec:` must be left alone to
    // avoid rewriting text the tooling never treated as a reference (M1).
    expect(rewriteTestTags('Req: "REQ-001"', "REQ-001", "REQ-100").content).toBe(
      'Req: "REQ-001"',
    );
    expect(
      rewriteTestTags('requirement: "REQ-001"', "REQ-001", "REQ-100").content,
    ).toBe('requirement: "REQ-001"');
    expect(rewriteTestTags('spec: "REQ-001"', "REQ-001", "REQ-100").content).toBe(
      'spec: "REQ-001"',
    );
  });
});

// ── rewriteFrontmatter ──────────────────────────────────────────────

describe("rewriteFrontmatter", () => {
  it("rewrites node_id inside frontmatter", () => {
    const input = [
      "---",
      'node_id: "doc:old"',
      "---",
      "# Body content",
    ].join("\n");
    const { content, changes } = rewriteFrontmatter(input, "doc:old", "doc:new");
    expect(content).toBe(
      [
        "---",
        'node_id: "doc:new"',
        "---",
        "# Body content",
      ].join("\n"),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("frontmatter-depends-on");
  });

  it("rewrites id inside depends_on in frontmatter", () => {
    const input = [
      "---",
      "depends_on:",
      '  - id: "REQ-001"',
      "---",
      "# Body",
    ].join("\n");
    const { content, changes } = rewriteFrontmatter(input, "REQ-001", "REQ-100");
    expect(content).toBe(
      [
        "---",
        "depends_on:",
        '  - id: "REQ-100"',
        "---",
        "# Body",
      ].join("\n"),
    );
    expect(changes).toHaveLength(1);
  });

  it("does NOT modify content outside frontmatter delimiters", () => {
    const input = [
      "---",
      'node_id: "doc:keep"',
      "---",
      'node_id: "doc:old"',
    ].join("\n");
    const { content } = rewriteFrontmatter(input, "doc:old", "doc:new");
    // Only the body line has doc:old, and it should remain untouched
    expect(content).toBe(input);
  });

  it("rewrites a plain-string depends_on item", () => {
    const input = ["---", "depends_on:", '  - "REQ-001"', "---", "# Body"].join("\n");
    const { content, changes } = rewriteFrontmatter(input, "REQ-001", "REQ-100");
    expect(content).toContain('  - "REQ-100"');
    expect(changes).toHaveLength(1);
  });

  it("rewrites an inline flow-map depends_on item", () => {
    const input = [
      "---",
      "artgraph:",
      "  depends_on:",
      '    - { id: "REQ-002", relation: implements }',
      "---",
    ].join("\n");
    const { content } = rewriteFrontmatter(input, "REQ-002", "REQ-200");
    expect(content).toContain('{ id: "REQ-200", relation: implements }');
  });

  // ── Issue #44: parser/rewriter acceptance-rule parity ───────────────
  //
  // The local frontmatterBounds used to accept any `---` (via .trim()), so
  // a mid-document horizontal rule paired with another `---` later in the
  // file was mis-identified as a frontmatter region and IDs inside got
  // silently rewritten — even though parseFrontmatter never extracted any
  // frontmatter from such a file. After the unification both modules share
  // findFrontmatterBounds and only honour a fence on line 0.

  it("does NOT treat a mid-document `---` block as frontmatter (issue #44)", () => {
    const input = [
      "# Title",
      "",
      "Some body prose.",
      "",
      "---",
      'node_id: "doc:old"',
      "---",
      "",
      "More body.",
    ].join("\n");
    const { content, changes } = rewriteFrontmatter(input, "doc:old", "doc:new");
    // The parser sees no frontmatter here, so the rewriter must agree.
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  it("does NOT treat an indented `   ---` as the opening fence (issue #44)", () => {
    const input = [
      "   ---",
      'node_id: "doc:old"',
      "---",
      "# Body",
    ].join("\n");
    const { content, changes } = rewriteFrontmatter(input, "doc:old", "doc:new");
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  it("still accepts trailing whitespace on fences (gray-matter parity)", () => {
    const input = [
      "--- ",
      'node_id: "doc:old"',
      "---\t",
      "# Body",
    ].join("\n");
    const { content, changes } = rewriteFrontmatter(input, "doc:old", "doc:new");
    expect(content).toContain('node_id: "doc:new"');
    expect(changes).toHaveLength(1);
  });
});

// ── expandFrontmatterDependsOn (F5) ─────────────────────────────────

describe("expandFrontmatterDependsOn", () => {
  it("expands a single dependency into one item per new ID", () => {
    const input = [
      "---",
      "depends_on:",
      '  - "REQ-001"',
      '  - "REQ-009"',
      "---",
    ].join("\n");
    const { content, changes } = expandFrontmatterDependsOn(input, "REQ-001", [
      "REQ-101",
      "REQ-102",
    ]);
    expect(content).toContain('  - "REQ-101"');
    expect(content).toContain('  - "REQ-102"');
    // The unrelated dependency survives, and the split ID is gone.
    expect(content).toContain('  - "REQ-009"');
    expect(content).not.toContain('"REQ-001"');
    expect(changes).toHaveLength(2);
  });

  // ── Issue #44 parity: same fence-acceptance contract as rewriteFrontmatter ──
  //
  // expandFrontmatterDependsOn was originally rewritten to consume the same
  // findFrontmatterBounds helper, but the regression tests only landed on the
  // rewriteFrontmatter side. These three mirror tests pin the same invariants
  // so a future revert/divergence on this code path is caught locally.

  it("does NOT treat a mid-document `---` block as frontmatter (issue #44)", () => {
    const input = [
      "# Title",
      "",
      "Some body prose.",
      "",
      "---",
      "depends_on:",
      '  - "REQ-001"',
      "---",
      "",
      "More body.",
    ].join("\n");
    const { content, changes } = expandFrontmatterDependsOn(input, "REQ-001", [
      "REQ-101",
      "REQ-102",
    ]);
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  it("does NOT treat an indented `   ---` as the opening fence (issue #44)", () => {
    const input = [
      "   ---",
      "depends_on:",
      '  - "REQ-001"',
      "---",
      "# Body",
    ].join("\n");
    const { content, changes } = expandFrontmatterDependsOn(input, "REQ-001", [
      "REQ-101",
      "REQ-102",
    ]);
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });

  it("still accepts trailing whitespace on fences (gray-matter parity)", () => {
    const input = [
      "--- ",
      "depends_on:",
      '  - "REQ-001"',
      "---\t",
      "# Body",
    ].join("\n");
    const { content, changes } = expandFrontmatterDependsOn(input, "REQ-001", [
      "REQ-101",
      "REQ-102",
    ]);
    expect(content).toContain('  - "REQ-101"');
    expect(content).toContain('  - "REQ-102"');
    expect(content).not.toContain('"REQ-001"');
    expect(changes).toHaveLength(2);
  });
});

// ── rewriteFile ─────────────────────────────────────────────────────

describe("rewriteFile", () => {
  it("applies list item + heading + frontmatter rewriters for .md files", () => {
    const input = [
      "---",
      'node_id: "doc:old"',
      "---",
      "### Requirement 1: description",
      "- REQ-001: some requirement",
    ].join("\n");

    const { content, changes } = rewriteFile(
      "specs/auth.md",
      input,
      "REQ-001",
      "REQ-100",
    );

    // List item should be rewritten
    expect(content).toContain("- REQ-100: some requirement");
    // The REQ-001 heading won't match because oldId is REQ-001 not Requirement-1
    // but the list item and frontmatter paths are tested
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.every((c) => c.filePath === "specs/auth.md")).toBe(true);
  });

  it("applies impl + test tag rewriters for .ts files", () => {
    const input = [
      "// @impl REQ-001",
      'it("[REQ-001] test", () => {});',
    ].join("\n");

    const { content, changes } = rewriteFile(
      "src/auth.ts",
      input,
      "REQ-001",
      "REQ-100",
    );

    expect(content).toContain("// @impl REQ-100");
    expect(content).toContain("[REQ-100]");
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.filePath === "src/auth.ts")).toBe(true);
  });

  it("does NOT rewrite IDs inside fenced code blocks (F6)", () => {
    const input = [
      "- REQ-001: real requirement",
      "",
      "```md",
      "- REQ-001: just an example in docs",
      "```",
    ].join("\n");

    const { content } = rewriteFile("specs/auth.md", input, "REQ-001", "REQ-100");
    expect(content).toContain("- REQ-100: real requirement");
    // The fenced example must be preserved verbatim.
    expect(content).toContain("- REQ-001: just an example in docs");
  });

  it("returns unchanged content for unknown extensions", () => {
    const input = "REQ-001 appears here";
    const { content, changes } = rewriteFile(
      "data/config.yaml",
      input,
      "REQ-001",
      "REQ-100",
    );
    expect(content).toBe(input);
    expect(changes).toHaveLength(0);
  });
});

// ── renameLockKey ───────────────────────────────────────────────────

describe("renameLockKey", () => {
  it("renames the key, preserving entry content", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "abc123",
        impl: ["src/foo.ts"],
        tests: ["tests/foo.test.ts"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result, changes } = renameLockKey(lock, "REQ-001", "REQ-100");

    expect(result["REQ-100"]).toBeDefined();
    expect(result["REQ-001"]).toBeUndefined();
    expect(result["REQ-100"].contentHash).toBe("abc123");
    expect(result["REQ-100"].impl).toEqual(["src/foo.ts"]);
    expect(result["REQ-100"].tests).toEqual(["tests/foo.test.ts"]);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("rename");
  });

  it("updates dependsOn references in other entries", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "abc",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-002": {
        contentHash: "def",
        dependsOn: [{ id: "REQ-001", provenances: ["frontmatter"] }],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result } = renameLockKey(lock, "REQ-001", "REQ-100");
    expect(result["REQ-002"].dependsOn).toEqual([
      { id: "REQ-100", provenances: ["frontmatter"] },
    ]);
  });

  it("returns unchanged lock when oldId does not exist", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "abc",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result, changes } = renameLockKey(lock, "REQ-999", "REQ-100");
    expect(result["REQ-001"]).toBeDefined();
    expect(result["REQ-999"]).toBeUndefined();
    expect(result["REQ-100"]).toBeUndefined();
    expect(changes).toHaveLength(0);
  });

  it("does not touch symbol: keys", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "abc",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "symbol:auth": {
        contentHash: "sym",
        dependsOn: [{ id: "REQ-001", provenances: ["code-tag"] }],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result } = renameLockKey(lock, "REQ-001", "REQ-100");
    // symbol: keys are skipped during reference updates
    expect(result["symbol:auth"].dependsOn).toEqual([
      { id: "REQ-001", provenances: ["code-tag"] },
    ]);
  });

  // Issue #35 / SC-005: rename must rewrite the `id` field only — the
  // `provenances` array is preserved verbatim (order + contents).
  it("SC-005: preserves multi-element provenances array on rename", () => {
    const lock: LockFile = {
      "REQ-001": { contentHash: "a", lastReconciled: "t" },
      "REQ-002": {
        contentHash: "b",
        dependsOn: [
          {
            id: "REQ-001",
            provenances: ["annotation", "convention", "frontmatter"],
          },
        ],
        lastReconciled: "t",
      },
    };
    const { lock: result } = renameLockKey(lock, "REQ-001", "REQ-100");
    expect(result["REQ-002"].dependsOn).toEqual([
      {
        id: "REQ-100",
        provenances: ["annotation", "convention", "frontmatter"],
      },
    ]);
  });

  // Issue #35: a rename followed by `buildLockFromGraph` (on a graph whose IDs
  // already reflect the rename) must produce a lock that is byte-equivalent to
  // the post-rename lock. The renameLockKey result, when piped through a
  // hypothetical re-scan, should not introduce drift in `dependsOn` shape.
  it("SC-003: post-rename lock shape preserves dependsOn invariants (id sorted, provenances sorted)", () => {
    const lock: LockFile = {
      "REQ-001": { contentHash: "a", lastReconciled: "t" },
      "REQ-099": { contentHash: "z", lastReconciled: "t" },
      "REQ-002": {
        contentHash: "b",
        dependsOn: [
          { id: "REQ-099", provenances: ["frontmatter"] },
          { id: "REQ-001", provenances: ["annotation", "convention"] },
        ],
        lastReconciled: "t",
      },
    };
    const { lock: result } = renameLockKey(lock, "REQ-001", "REQ-100");
    // The resulting dependsOn must be id-sorted (INV-L1) and each provenances
    // sub-array must still be sorted (INV-L2), exactly as buildLockFromGraph
    // would emit.
    expect(result["REQ-002"].dependsOn).toEqual([
      { id: "REQ-099", provenances: ["frontmatter"] },
      { id: "REQ-100", provenances: ["annotation", "convention"] },
    ]);
  });
});

// ── splitLockKey ────────────────────────────────────────────────────

describe("splitLockKey", () => {
  it("deletes old key and creates empty entries for new IDs", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "abc",
        impl: ["src/foo.ts"],
        tests: ["tests/foo.test.ts"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result, changes } = splitLockKey(lock, "REQ-001", [
      "REQ-001a",
      "REQ-001b",
    ]);

    expect(result["REQ-001"]).toBeUndefined();
    expect(result["REQ-001a"]).toBeDefined();
    expect(result["REQ-001b"]).toBeDefined();
    expect(result["REQ-001a"].contentHash).toBe("");
    expect(result["REQ-001a"].impl).toEqual([]);
    expect(result["REQ-001a"].tests).toEqual([]);
    expect(result["REQ-001b"].contentHash).toBe("");
    expect(changes).toHaveLength(3); // 1 delete + 2 creates
  });

  it("creates new entries even if old key does not exist", () => {
    const lock: LockFile = {};

    const { lock: result, changes } = splitLockKey(lock, "REQ-999", [
      "REQ-100",
      "REQ-101",
    ]);

    expect(result["REQ-100"]).toBeDefined();
    expect(result["REQ-101"]).toBeDefined();
    // No delete change because oldId didn't exist
    expect(changes).toHaveLength(2); // 2 creates only
  });

  it("expands references to the split ID in other entries (C2)", () => {
    const lock: LockFile = {
      "REQ-001": { contentHash: "a", lastReconciled: "t" },
      "REQ-003": {
        contentHash: "c",
        dependsOn: [
          { id: "REQ-001", provenances: ["frontmatter"] },
          { id: "REQ-002", provenances: ["frontmatter"] },
        ],
        lastReconciled: "t",
      },
    };

    const { lock: result } = splitLockKey(lock, "REQ-001", ["REQ-101", "REQ-102"]);
    // No dangling reference to the removed REQ-001 — it expands to both new IDs.
    // Output is id-sorted per INV-L1.
    expect(result["REQ-003"].dependsOn).toEqual([
      { id: "REQ-002", provenances: ["frontmatter"] },
      { id: "REQ-101", provenances: ["frontmatter"] },
      { id: "REQ-102", provenances: ["frontmatter"] },
    ]);
  });

  it("carries the split source's specFile onto the new entries (H5)", () => {
    const lock: LockFile = {
      "REQ-001": { specFile: "specs/a.md", contentHash: "a", lastReconciled: "t" },
    };
    const { lock: result } = splitLockKey(lock, "REQ-001", ["REQ-101", "REQ-102"]);
    expect(result["REQ-101"].specFile).toBe("specs/a.md");
    expect(result["REQ-102"].specFile).toBe("specs/a.md");
  });
});

// ── mergeLockKeys ───────────────────────────────────────────────────

describe("mergeLockKeys", () => {
  it("combines impl and tests arrays with deduplication", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "hash-a",
        impl: ["src/a.ts", "src/shared.ts"],
        tests: ["tests/a.test.ts"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-002": {
        contentHash: "hash-b",
        impl: ["src/b.ts", "src/shared.ts"],
        tests: ["tests/b.test.ts", "tests/a.test.ts"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result } = mergeLockKeys(lock, ["REQ-001", "REQ-002"], "REQ-MERGED");

    expect(result["REQ-MERGED"]).toBeDefined();
    expect(result["REQ-MERGED"].impl).toEqual([
      "src/a.ts",
      "src/shared.ts",
      "src/b.ts",
    ]);
    expect(result["REQ-MERGED"].tests).toEqual([
      "tests/a.test.ts",
      "tests/b.test.ts",
    ]);
  });

  it("deletes all source keys and creates new key", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "hash-a",
        impl: ["src/a.ts"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-002": {
        contentHash: "hash-b",
        impl: ["src/b.ts"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-003": {
        contentHash: "hash-c",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result, changes } = mergeLockKeys(
      lock,
      ["REQ-001", "REQ-002"],
      "REQ-MERGED",
    );

    expect(result["REQ-001"]).toBeUndefined();
    expect(result["REQ-002"]).toBeUndefined();
    expect(result["REQ-003"]).toBeDefined(); // untouched
    expect(result["REQ-MERGED"]).toBeDefined();
    expect(changes).toHaveLength(3); // 2 deletes + 1 create
  });

  it("uses first source's contentHash", () => {
    const lock: LockFile = {
      "REQ-001": {
        contentHash: "first-hash",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
      "REQ-002": {
        contentHash: "second-hash",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result } = mergeLockKeys(
      lock,
      ["REQ-001", "REQ-002"],
      "REQ-MERGED",
    );

    expect(result["REQ-MERGED"].contentHash).toBe("first-hash");
  });

  it("repoints references to merged sources in other entries (C2)", () => {
    const lock: LockFile = {
      "REQ-001": { contentHash: "a", lastReconciled: "t" },
      "REQ-002": { contentHash: "b", lastReconciled: "t" },
      "REQ-003": {
        contentHash: "c",
        dependsOn: [
          { id: "REQ-001", provenances: ["frontmatter"] },
          { id: "REQ-002", provenances: ["annotation"] },
        ],
        lastReconciled: "t",
      },
    };

    const { lock: result } = mergeLockKeys(lock, ["REQ-001", "REQ-002"], "REQ-100");
    // Both former references collapse onto the merge target; provenances union.
    expect(result["REQ-003"].dependsOn).toEqual([
      { id: "REQ-100", provenances: ["annotation", "frontmatter"] },
    ]);
  });

  it("preserves specFile and drops self-references (H5)", () => {
    const lock: LockFile = {
      "REQ-001": {
        specFile: "specs/a.md",
        contentHash: "a",
        dependsOn: [{ id: "REQ-002", provenances: ["annotation"] }],
        lastReconciled: "t",
      },
      "REQ-002": { specFile: "specs/a.md", contentHash: "b", lastReconciled: "t" },
    };

    const { lock: result } = mergeLockKeys(lock, ["REQ-001", "REQ-002"], "REQ-100");
    expect(result["REQ-100"].specFile).toBe("specs/a.md");
    // The merged entry must not depend on its own former parts.
    expect(result["REQ-100"].dependsOn).toBeUndefined();
  });
});

// ── ID validation (F2) ──────────────────────────────────────────────

describe("isValidTargetId", () => {
  it("accepts canonical requirement IDs and doc: IDs", () => {
    expect(isValidTargetId("REQ-001")).toBe(true);
    expect(isValidTargetId("FR-42")).toBe(true);
    expect(isValidTargetId("auth/AUTH-2")).toBe(true);
    expect(isValidTargetId("Requirement-3")).toBe(true);
    expect(isValidTargetId("doc:feature")).toBe(true);
  });

  it("rejects IDs the parser could not re-discover", () => {
    expect(isValidTargetId("REQ-COMBINED")).toBe(false);
    expect(isValidTargetId("REQ-001a")).toBe(false);
    expect(isValidTargetId("req-1")).toBe(false);
    expect(isValidTargetId("doc:")).toBe(false);
  });

  it("accepts built-in task ID shapes (spec-kit T###, kiro N / N.M)", () => {
    expect(isValidTargetId("T001")).toBe(true);
    expect(isValidTargetId("T999")).toBe(true);
    expect(isValidTargetId("1")).toBe(true);
    expect(isValidTargetId("1.1")).toBe(true);
    expect(isValidTargetId("2.3.4")).toBe(true);
  });

  it("respects disableBuiltinTaskConventions when checking task shapes", () => {
    // Disabling spec-kit drops the `T\d+` acceptance.
    expect(isValidTargetId("T001", undefined, undefined, ["spec-kit"])).toBe(false);
    // Kiro still accepted.
    expect(isValidTargetId("1.1", undefined, undefined, ["spec-kit"])).toBe(true);
  });

  it("accepts an ID matched by a user-defined taskConvention preset", () => {
    // Use a lowercase shape so it doesn't accidentally match the canonical
    // requirement-ID token (`[A-Z][A-Za-z]*-\d+`).
    const presets = [
      {
        name: "openspec",
        fileStems: ["tasks"],
        taskIdRe: "^(os-\\d+)$",
      },
    ];
    expect(isValidTargetId("os-77", undefined, presets)).toBe(true);
    expect(isValidTargetId("os-abc", undefined, presets)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// rewriteAnnotationIds (specs/010-req-req-dependency, T023)
// ──────────────────────────────────────────────────────────────────────

describe("rewriteAnnotationIds", () => {
  // Case 1: single ID
  it("rewrites a single-ID annotation target", () => {
    const input = "- X: y (depends_on: AUTH-001)";
    const { content, changes } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y (depends_on: AUTH-100)");
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("annotation-target");
  });

  // Case 2: multiple IDs — only the matching one rewrites
  it("rewrites only the matching ID inside a comma list", () => {
    const input = "- X: y (depends_on: AUTH-001, AUTH-002, AUTH-003)";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y (depends_on: AUTH-100, AUTH-002, AUTH-003)");
  });

  // Case 3: oldId appears multiple times in same annotation
  it("rewrites all occurrences of OLD inside a single annotation", () => {
    const input = "- X: y (depends_on: AUTH-001, AUTH-002, AUTH-001)";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y (depends_on: AUTH-100, AUTH-002, AUTH-100)");
  });

  // Case 4: derives_from kind behaves the same
  it("rewrites derives_from annotations too", () => {
    const input = "- X: y (derives_from: AUTH-001)";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y (derives_from: AUTH-100)");
  });

  // Case 5: BOLD form is preserved, only the ID is replaced
  it("preserves surrounding **BOLD** when replacing the inner ID", () => {
    const input = "- X: y (depends_on: **AUTH-001**)";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y (depends_on: **AUTH-100**)");
  });

  // Case 6: whitespace variations preserved
  it("preserves whitespace around colons / commas", () => {
    const input = "- X: y ( depends_on : AUTH-001 , AUTH-002 )";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y ( depends_on : AUTH-100 , AUTH-002 )");
  });

  // Case 7: fenced code block skipped
  it("does NOT rewrite inside fenced code blocks (F6)", () => {
    const input =
      "- AUTH-002: y (depends_on: AUTH-001)\n```md\n- AUTH-003: z (depends_on: AUTH-001)\n```\n";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe(
      "- AUTH-002: y (depends_on: AUTH-100)\n```md\n- AUTH-003: z (depends_on: AUTH-001)\n```\n",
    );
  });

  // Case 8: multiple annotations on one line, both touched
  it("rewrites the target ID in each annotation when the line has multiple", () => {
    const input = "- X: y (depends_on: AUTH-001)(derives_from: AUTH-001)";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe("- X: y (depends_on: AUTH-100)(derives_from: AUTH-100)");
  });

  // Case 9: oldId === newId is a no-op
  it("is a no-op when oldId === newId", () => {
    const input = "- X: y (depends_on: AUTH-001)";
    const { content, changes } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-001");
    expect(content).toBe(input);
    expect(changes).toEqual([]);
  });

  // Case 10: file without oldId is unchanged
  it("returns unchanged content + empty changes when oldId never appears", () => {
    const input = "- AUTH-002: y (depends_on: AUTH-003)";
    const { content, changes } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe(input);
    expect(changes).toEqual([]);
  });

  // Extra: must not touch a different annotation in the same line
  it("does not touch substring matches outside the annotation token boundary", () => {
    const input = "- X: y (depends_on: AUTH-0010)";
    const { content } = rewriteAnnotationIds(input, "AUTH-001", "AUTH-100");
    expect(content).toBe(input);
  });
});

// T024: rewriteFile (.md) wires rewriteAnnotationIds alongside list-item /
// heading / frontmatter rewriters in a single pass.
describe("rewriteFile (.md) — annotation target rewriting (T024)", () => {
  it("rewrites BOTH the list-item ID definition AND its uses in annotations", () => {
    const input =
      "# spec\n\n- AUTH-001: 認証\n- AUTH-002: セッション (depends_on: AUTH-001)\n";
    const { content, changes } = rewriteFile("spec.md", input, "AUTH-001", "AUTH-100");
    expect(content).toBe(
      "# spec\n\n- AUTH-100: 認証\n- AUTH-002: セッション (depends_on: AUTH-100)\n",
    );
    // Both spec-list-item (the definition) and annotation-target (the use) appear.
    expect(changes.find((c) => c.kind === "spec-list-item")).toBeDefined();
    expect(changes.find((c) => c.kind === "annotation-target")).toBeDefined();
  });

  it("multi-id fixture: full file rename rewrites all annotation occurrences and preserves fenced", () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "fixtures/req-req-annotations/multi-id.md",
    );
    const original = readFileSync(fixturePath, "utf-8");
    const { content } = rewriteFile(fixturePath, original, "AUTH-001", "AUTH-100");

    // Definition rewritten
    expect(content).toContain("- AUTH-100: 認証");
    // All annotation occurrences of AUTH-001 outside fenced rewritten
    expect(content).toContain("(depends_on: AUTH-100)");
    expect(content).toContain("(depends_on: AUTH-100, AUTH-002)");
    expect(content).toContain("(depends_on: **AUTH-100**)");
    expect(content).toContain("(depends_on: AUTH-100, AUTH-002, AUTH-100)");
    expect(content).toContain("( depends_on : AUTH-100 , AUTH-002 )");
    // fenced code block untouched
    expect(content).toContain("- AUTH-009: コード内 (depends_on: AUTH-001)");
  });

  // SC-004 invariants — rename does not change the dependency graph shape.
  it("SC-004: edge count is unchanged and orphan-edge does not grow after rename", () => {
    const tmpRoot = resolve(
      import.meta.dirname,
      "fixtures/req-req-annotations/_tmp-sc004",
    );
    const specDir = resolve(tmpRoot, "specs");
    const specFile = resolve(specDir, "spec.md");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      specFile,
      [
        "# SC-004",
        "",
        "- AUTH-001: 認証",
        "- AUTH-002: セッション (depends_on: AUTH-001)",
        "- AUTH-003: ログアウト (derives_from: AUTH-002)",
        "- AUTH-004: 強制 (depends_on: AUTH-001, AUTH-002)",
        "",
      ].join("\n"),
    );

    const cfg: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.ts"],
      lockFile: ".trace.lock",
    };

    try {
      const before = buildGraph(tmpRoot, cfg);
      const beforeEdges = before.graph.edges.length;
      const beforeOrphans = before.warnings.filter((w) => w.type === "orphan-edge").length;

      const original = readFileSync(specFile, "utf-8");
      const { content } = rewriteFile(specFile, original, "AUTH-001", "AUTH-100");
      writeFileSync(specFile, content);

      const after = buildGraph(tmpRoot, cfg);
      const afterEdges = after.graph.edges.length;
      const afterOrphans = after.warnings.filter((w) => w.type === "orphan-edge").length;

      expect(afterEdges).toBe(beforeEdges);
      expect(afterOrphans).toBeLessThanOrEqual(beforeOrphans);

      // Targeted: the AUTH-002 / AUTH-004 annotation edges now point at AUTH-100.
      const annAfter = after.graph.edges.filter((e) => e.provenances?.includes("annotation"));
      expect(annAfter.find((e) => e.source === "AUTH-002" && e.target === "AUTH-100")).toBeDefined();
      expect(annAfter.find((e) => e.source === "AUTH-004" && e.target === "AUTH-100")).toBeDefined();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
