import { describe, it, expect } from "vitest";
import {
  rewriteSpecListItem,
  rewriteSpecHeading,
  rewriteImplTags,
  rewriteTestTags,
  rewriteFrontmatter,
  rewriteFile,
} from "../src/rename.js";
import {
  renameLockKey,
  splitLockKey,
  mergeLockKeys,
} from "../src/rename-lock.js";
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

  it("handles namespace-qualified ID", () => {
    const input = "- 001-auth/FR-001: auth feature";
    const { content, changes } = rewriteSpecListItem(
      input,
      "001-auth/FR-001",
      "001-auth/FR-010",
    );
    expect(content).toBe("- 001-auth/FR-010: auth feature");
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

  it("handles case-insensitive prefixes", () => {
    const input1 = 'Req: "REQ-001"';
    const input2 = 'requirement: "REQ-001"';
    const input3 = 'spec: "REQ-001"';

    expect(rewriteTestTags(input1, "REQ-001", "REQ-100").content).toBe(
      'Req: "REQ-100"',
    );
    expect(rewriteTestTags(input2, "REQ-001", "REQ-100").content).toBe(
      'requirement: "REQ-100"',
    );
    expect(rewriteTestTags(input3, "REQ-001", "REQ-100").content).toBe(
      'spec: "REQ-100"',
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
        dependsOn: ["REQ-001"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result } = renameLockKey(lock, "REQ-001", "REQ-100");
    expect(result["REQ-002"].dependsOn).toEqual(["REQ-100"]);
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
        dependsOn: ["REQ-001"],
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const { lock: result } = renameLockKey(lock, "REQ-001", "REQ-100");
    // symbol: keys are skipped during reference updates
    expect(result["symbol:auth"].dependsOn).toEqual(["REQ-001"]);
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
});
