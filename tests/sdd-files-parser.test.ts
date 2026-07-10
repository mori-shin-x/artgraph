// spec 016 — parser unit tests. Rewritten from the spec 014 `files: string[]`
// baseline to drive the new `entries: SymbolEntry[]` contract
// (specs/016-impact-plan-symbol-level/contracts/sdd-files-parser.md).
//
// The tests are arranged in three groups:
//   1. Stage A legacy behaviour, now expressed in terms of `entries[]`
//      (path-only). Kept so the redesign doesn't regress file-unit parsing.
//   2. spec 016 contract §3 cases 1–8 — `path:symbol` syntax acceptance,
//      diagnostic exclusivity (INV-S1), Stage B symbol suppression (FR-006).
//   3. Stage B fallback and the empty stage (unchanged semantics, restated
//      against the entries shape).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { extractFiles } from "../src/parsers/sdd-files.js";
import type { ArtifactGraph, GraphNode } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(
  fileIds: string[],
  symbolIds: Array<{ path: string; symbol: string }> = [],
): ArtifactGraph {
  // File nodes are keyed under `file:<path>` (matches the graph builder).
  // Symbol nodes follow `symbol:<path>#<symbol>` per spec 016 R-004.
  const nodes = new Map<string, GraphNode>();
  for (const path of fileIds) {
    const id = `file:${path}`;
    nodes.set(id, { id, kind: "file", filePath: path, contentHash: "0".repeat(16) });
  }
  for (const { path, symbol } of symbolIds) {
    const id = `symbol:${path}#${symbol}`;
    nodes.set(id, {
      id,
      kind: "symbol",
      filePath: path,
      contentHash: "0".repeat(16),
      label: symbol,
    });
  }
  return { nodes, edges: [] };
}

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-sdd-files-"));
}

function touch(root: string, relPath: string): void {
  const abs = resolve(root, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, "");
}

function paths(result: { entries: Array<{ path: string }> }): string[] {
  return result.entries.map((e) => e.path);
}

// ---------------------------------------------------------------------------
// Stage A — legacy file-unit behaviour, restated against `entries[]`
// ---------------------------------------------------------------------------

describe("extractFiles — Stage A (file-unit, entries shape)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("inline form: comma-separated paths preserve input order with `symbol === undefined`", () => {
    const graph = makeGraph(["src/auth.ts", "src/auth-2fa.ts", "tests/auth.test.ts"]);
    const text = "Files: src/auth.ts, src/auth-2fa.ts, tests/auth.test.ts\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(paths(result)).toEqual(["src/auth.ts", "src/auth-2fa.ts", "tests/auth.test.ts"]);
    expect(result.entries.every((e) => e.symbol === undefined)).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("bullet form retains source line numbers per entry", () => {
    const graph = makeGraph(["src/auth.ts", "src/auth-2fa.ts"]);
    const text = ["Files:", "- src/auth.ts", "- src/auth-2fa.ts"].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([
      { path: "src/auth.ts", symbol: undefined, line: 2 },
      { path: "src/auth-2fa.ts", symbol: undefined, line: 3 },
    ]);
  });

  it("strips trailing `(new)` / `(deleted)` annotations from the path", () => {
    const graph = makeGraph(["src/auth-2fa.ts", "tests/auth.test.ts"]);
    const text = ["Files:", "- src/auth-2fa.ts (new)", "- tests/auth.test.ts (deleted)"].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(paths(result)).toEqual(["src/auth-2fa.ts", "tests/auth.test.ts"]);
  });

  it("dedup: same path declared twice yields one entry", () => {
    const graph = makeGraph(["src/auth.ts"]);
    const text = ["Files: src/auth.ts, src/auth.ts", "- src/auth.ts"].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(paths(result)).toEqual(["src/auth.ts"]);
  });

  it("absolute path is dropped with `unresolvedFilePath` diagnostic; relative entries preserved", () => {
    const graph = makeGraph(["src/auth.ts"]);
    const text = "Files: /home/user/repo/src/auth.ts, src/auth.ts\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(paths(result)).toEqual(["src/auth.ts"]);
    expect(result.diagnostics).toEqual([
      { kind: "unresolvedFilePath", path: "/home/user/repo/src/auth.ts", line: 1 },
    ]);
  });

  it("rejects paths that escape the repo root with `unresolvedFilePath`", () => {
    const graph = makeGraph([]);
    const text = "Files: ../outside/foo.ts\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([
      { kind: "unresolvedFilePath", path: "../outside/foo.ts", line: 1 },
    ]);
  });

  it("normalizes `./` and `..` segments before lookup", () => {
    touch(root, "src/foo.ts");
    const graph = makeGraph([]);
    const text = "Files: ./src/sub/../foo.ts\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(paths(result)).toEqual(["src/foo.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("unresolvedFilePath line numbers reflect bullet position", () => {
    const graph = makeGraph([]);
    const text = ["Files:", "- src/typo-1.ts", "- src/typo-2.ts"].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    const diag = result.diagnostics.filter((d) => d.kind === "unresolvedFilePath");
    expect(diag).toEqual(
      expect.arrayContaining([
        { kind: "unresolvedFilePath", path: "src/typo-1.ts", line: 2 },
        { kind: "unresolvedFilePath", path: "src/typo-2.ts", line: 3 },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Spec 016 contract §3 — `path:symbol` syntax (FR-001..FR-007, INV-S1)
// ---------------------------------------------------------------------------

describe("extractFiles — Stage A path:symbol syntax (spec 016)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Case 1: `Files: src/auth.ts:validateToken` single
  it("case 1: single symbol entry exposes `{ path, symbol, line }`", () => {
    const graph = makeGraph(["src/auth.ts"], [{ path: "src/auth.ts", symbol: "validateToken" }]);
    const text = "Files: src/auth.ts:validateToken\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.entries).toEqual([{ path: "src/auth.ts", symbol: "validateToken", line: 1 }]);
    expect(result.diagnostics).toEqual([]);
  });

  // Case 2: file + symbol mixed in one section; input order preserved
  it("case 2: file + symbol mixed — entries follow input order with mixed symbol presence", () => {
    const graph = makeGraph(
      ["src/auth.ts", "src/session.ts"],
      [{ path: "src/auth.ts", symbol: "validateToken" }],
    );
    const text = "Files: src/session.ts, src/auth.ts:validateToken\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([
      { path: "src/session.ts", symbol: undefined, line: 1 },
      { path: "src/auth.ts", symbol: "validateToken", line: 1 },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  // Case 3: symbol name containing `:` (split only on first `:`)
  it("case 3: only the first `:` splits — `Class::method` style stays in symbol", () => {
    const graph = makeGraph(["src/a.ts"], [{ path: "src/a.ts", symbol: "fn:sub" }]);
    const text = "Files: src/a.ts:fn:sub\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([{ path: "src/a.ts", symbol: "fn:sub", line: 1 }]);
  });

  // Case 4: trailing `(new)` annotation stripped before symbol split
  it("case 4: trailing annotation stripped before `path:symbol` evaluation", () => {
    const graph = makeGraph(["src/a.ts"], [{ path: "src/a.ts", symbol: "fn" }]);
    const text = "Files: src/a.ts:fn (new)\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([{ path: "src/a.ts", symbol: "fn", line: 1 }]);
  });

  // Case 5: path also missing — only unresolvedFilePath fires (INV-S1)
  it("case 5: missing path + missing symbol — only `unresolvedFilePath` (no symbol diag)", () => {
    const graph = makeGraph([]); // no file node, no symbol node
    const text = "Files: src/missing.ts:doesNotExist\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    // Entry is kept (Stage A trusts the author) but only the path miss is reported.
    expect(result.entries).toEqual([{ path: "src/missing.ts", symbol: "doesNotExist", line: 1 }]);
    expect(result.diagnostics).toEqual([
      { kind: "unresolvedFilePath", path: "src/missing.ts", line: 1 },
    ]);
    // INV-S1: must NOT also report unresolvedSymbol for the same entry.
    expect(result.diagnostics.some((d) => d.kind === "unresolvedSymbol")).toBe(false);
  });

  // Case 6: path registered, symbol missing → unresolvedSymbol only
  it("case 6: registered path + missing symbol → only `unresolvedSymbol`", () => {
    const graph = makeGraph(["src/auth.ts"]); // file registered, no symbol nodes
    const text = "Files: src/auth.ts:doesNotExist\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([{ path: "src/auth.ts", symbol: "doesNotExist", line: 1 }]);
    expect(result.diagnostics).toEqual([
      {
        kind: "unresolvedSymbol",
        sourceFile: "src/auth.ts",
        symbol: "doesNotExist",
        line: 1,
      },
    ]);
  });

  // Case 7: both registered → no diagnostics
  it("case 7: registered path + registered symbol → no diagnostics", () => {
    const graph = makeGraph(["src/auth.ts"], [{ path: "src/auth.ts", symbol: "validateToken" }]);
    const text = "Files: src/auth.ts:validateToken\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.diagnostics).toEqual([]);
  });

  // Case 8: Stage B (regex fallback) does NOT detect symbols (FR-006)
  it("case 8: Stage B fallback returns `symbol === undefined` even for `path:name` text", () => {
    // Free-text mention; no `Files:` section. Stage B should pick up the
    // path token but NOT split off `:name`.
    const graph = makeGraph(["src/auth.ts"]);
    const text = "We will tweak src/auth.ts in the next iteration.\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every((e) => e.symbol === undefined)).toBe(true);
  });

  // Additional: line numbers point at bullet positions for symbol entries
  it("symbol entry line number reflects bullet position", () => {
    const graph = makeGraph(["src/auth.ts"], [{ path: "src/auth.ts", symbol: "validateToken" }]);
    const text = ["Files:", "- src/auth.ts:validateToken"].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([{ path: "src/auth.ts", symbol: "validateToken", line: 2 }]);
  });

  // Additional: same path with two different symbols → two entries
  it("same path with two different symbols yields two entries", () => {
    const graph = makeGraph(
      ["src/auth.ts"],
      [
        { path: "src/auth.ts", symbol: "validateToken" },
        { path: "src/auth.ts", symbol: "issueToken" },
      ],
    );
    const text = "Files: src/auth.ts:validateToken, src/auth.ts:issueToken\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.entries).toEqual([
      { path: "src/auth.ts", symbol: "validateToken", line: 1 },
      { path: "src/auth.ts", symbol: "issueToken", line: 1 },
    ]);
  });

  // Additional: extensionless tokens like `REQ-003` never match path:symbol
  it("extensionless tokens are not parsed as path:symbol", () => {
    const graph = makeGraph([]);
    const text = "Files: REQ-003:something\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    // The whole token is treated as a path (raw) which fails fs/graph lookup.
    expect(result.entries).toEqual([{ path: "REQ-003:something", symbol: undefined, line: 1 }]);
    expect(result.diagnostics).toEqual([
      { kind: "unresolvedFilePath", path: "REQ-003:something", line: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stage B — regex fallback (unchanged semantics, restated)
// ---------------------------------------------------------------------------

describe("extractFiles — Stage B (regex fallback, entries shape)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back when Stage A returns no entries", () => {
    touch(root, "src/real.ts");
    const graph = makeGraph([]);
    const text = "Edit src/real.ts to fix the bug.\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(paths(result)).toEqual(["src/real.ts"]);
  });

  it("does NOT run when Stage A produced entries", () => {
    const graph = makeGraph(["src/auth.ts", "src/other.ts"]);
    const text = "Files: src/auth.ts\n\nProse also mentions src/other.ts.\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(paths(result)).toEqual(["src/auth.ts"]);
  });

  it("drops URL-looking tokens", () => {
    const graph = makeGraph([]);
    const text = "See https://example.com/foo.md for details.\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("empty");
    expect(result.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage A scope boundary — flat checklist tasks (issue #219)
// ---------------------------------------------------------------------------

describe("extractFiles — Stage A boundary at checklist items (issue #219)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("inline Files: followed directly by the next checklist task does not swallow the task line", () => {
    // Exact layout from issue #219: Spec Kit standard flat checklist, one
    // blank line between the task and its Files: block, and the next task
    // line right below the Files: header. Before the fix the T003 line was
    // parsed as a bullet entry and surfaced as a bogus unresolvedFilePath.
    const graph = makeGraph(["src/todo.ts", "src/cli.ts"]);
    const text = [
      "- [ ] T002 Define Todo type in src/todo.ts",
      "",
      "Files: src/todo.ts",
      "- [ ] T003 Create CLI entry scaffold (argv parsing, command dispatch table, shared",
      "  helpers) in src/cli.ts",
      "",
    ].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(paths(result)).toEqual(["src/todo.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("bullet-form Files: scope ends at the next checklist item", () => {
    const graph = makeGraph(["src/a.ts", "src/b.ts"]);
    const text = [
      "Files:",
      "- src/a.ts",
      "- src/b.ts",
      "- [ ] T004 Implement feature (not a file entry)",
    ].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(paths(result)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("checked (`[x]` / `[X]`), `*`-bulleted, and indented checklist items all terminate the scope", () => {
    const graph = makeGraph(["src/a.ts"]);
    const markers = [
      "- [x] T005 next task",
      "- [X] T005 next task",
      "* [ ] T005 next task",
      "  - [ ] T005 next task",
    ];
    for (const marker of markers) {
      const text = ["Files: src/a.ts", marker].join("\n");
      const result = extractFiles(text, { graph, repoRoot: root });
      expect(paths(result)).toEqual(["src/a.ts"]);
      expect(result.diagnostics).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// taskBlocks (unchanged, but verified once for non-regression)
// ---------------------------------------------------------------------------

describe("extractFiles — taskBlocks", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("captures T-prefixed and numeric IDs alongside each other", () => {
    const graph = makeGraph([]);
    const text = ["### T001 first", "", "### 1.1 second"].join("\n");
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.taskBlocks).toEqual([
      { taskId: "T001", line: 1, hasFilesSection: false },
      { taskId: "1.1", line: 3, hasFilesSection: false },
    ]);
  });
});
