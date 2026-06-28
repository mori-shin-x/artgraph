import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { extractFiles } from "../src/parsers/sdd-files.js";
import type { ArtifactGraph, GraphNode } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(fileIds: string[]): ArtifactGraph {
  // Pass file paths (e.g. "src/auth.ts"); the helper registers them under the
  // "file:" namespace the parser checks via `graph.nodes.has('file:<path>')`.
  const nodes = new Map<string, GraphNode>();
  for (const path of fileIds) {
    const id = `file:${path}`;
    nodes.set(id, {
      id,
      kind: "file",
      filePath: path,
      contentHash: "0000000000000000",
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

// ---------------------------------------------------------------------------
// Stage A — `Files:` section
// ---------------------------------------------------------------------------

describe("extractFiles — Stage A (Files: section)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("inline form: comma-separated paths on the header line", () => {
    const graph = makeGraph(["src/auth.ts", "src/auth-2fa.ts", "tests/auth.test.ts"]);
    const text = [
      "### T013: 2FA login flow",
      "",
      "Files: src/auth.ts, src/auth-2fa.ts, tests/auth.test.ts",
      "",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });

    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth-2fa.ts", "src/auth.ts", "tests/auth.test.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("inline form: strips trailing `.` and `;` punctuation", () => {
    const graph = makeGraph(["src/a.ts", "src/b.ts"]);
    const text = "Files: src/a.ts, src/b.ts.\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("bullet form: paths on subsequent `-` / `*` lines", () => {
    const graph = makeGraph(["src/auth.ts", "src/auth-2fa.ts", "tests/auth.test.ts"]);
    const text = [
      "Files:",
      "- src/auth.ts",
      "- src/auth-2fa.ts",
      "* tests/auth.test.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });

    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth-2fa.ts", "src/auth.ts", "tests/auth.test.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("bullet form: strips trailing `(new)` / `(deleted)` annotations", () => {
    const graph = makeGraph(["src/auth.ts", "src/auth-2fa.ts", "tests/auth.test.ts"]);
    const text = [
      "Files:",
      "- src/auth.ts",
      "- src/auth-2fa.ts (new)",
      "- tests/auth.test.ts (deleted)",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth-2fa.ts", "src/auth.ts", "tests/auth.test.ts"]);
  });

  it("inline + bullet mixed in the same section", () => {
    const graph = makeGraph(["src/auth.ts", "src/session.ts"]);
    const text = [
      "Files: src/auth.ts",
      "- src/session.ts",
      "",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth.ts", "src/session.ts"]);
  });

  it("nested bullets are captured (depth ignored)", () => {
    const graph = makeGraph(["src/auth.ts", "subdir/foo.ts", "src/session.ts"]);
    const text = [
      "Files:",
      "- src/auth.ts",
      "  - subdir/foo.ts",
      "- src/session.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth.ts", "src/session.ts", "subdir/foo.ts"]);
  });

  it("scope ends at the next markdown heading", () => {
    const graph = makeGraph(["src/auth.ts", "src/other.ts"]);
    const text = [
      "### T001",
      "Files:",
      "- src/auth.ts",
      "### T002",
      "- src/other.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    // src/other.ts lives in a different task block — must be excluded.
    expect(result.files).toEqual(["src/auth.ts"]);
  });

  it("scope ends after two consecutive blank lines", () => {
    const graph = makeGraph(["src/auth.ts", "src/leaked.ts"]);
    const text = [
      "Files:",
      "- src/auth.ts",
      "",
      "",
      "- src/leaked.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth.ts"]);
  });

  it("empty `Files:` section (no inline tail, no bullets) falls through to Stage B", () => {
    // Stage B must find something so we don't end up `stage: empty` — drop a real
    // file on disk that Stage B will discover via the regex+fs validation path.
    touch(root, "src/auth.ts");
    const graph = makeGraph([]);
    const text = [
      "Files:",
      "",
      "### Next",
      "src/auth.ts is the file we touch.",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(result.files).toEqual(["src/auth.ts"]);
  });

  it("case-sensitive header: `files:` / `FILES:` / `File:` do NOT match", () => {
    const graph = makeGraph(["src/auth.ts"]);
    const text = [
      "files: src/auth.ts",
      "FILES: src/auth.ts",
      "File: src/auth.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    // No Stage A match — Stage B falls back; src/auth.ts is in graph, accepted.
    expect(result.stage).toBe("regex-fallback");
    expect(result.files).toEqual(["src/auth.ts"]);
  });

  it("dedup: the same path declared multiple times appears once", () => {
    const graph = makeGraph(["src/auth.ts", "src/other.ts"]);
    const text = [
      "Files: src/auth.ts, src/auth.ts",
      "- src/auth.ts",
      "- src/other.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth.ts", "src/other.ts"]);
  });

  it("multiple `Files:` sections in one text are combined", () => {
    const graph = makeGraph(["src/a.ts", "src/b.ts"]);
    const text = [
      "### T001",
      "Files: src/a.ts",
      "",
      "### T002",
      "Files: src/b.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("absolute path is skipped and produces `unresolvedFilePath` diagnostic", () => {
    const graph = makeGraph(["src/auth.ts"]);
    const text = [
      "Files: /home/user/repo/src/auth.ts, src/auth.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    // Only the relative path is kept.
    expect(result.files).toEqual(["src/auth.ts"]);
    expect(result.diagnostics).toEqual([
      { kind: "unresolvedFilePath", path: "/home/user/repo/src/auth.ts" },
    ]);
  });

  it("trusts a relative path that is not (yet) on disk and not in the graph; emits a typo warning", () => {
    const graph = makeGraph([]);
    const text = "Files: src/brand-new.ts\n";
    const result = extractFiles(text, { graph, repoRoot: root });

    expect(result.stage).toBe("files-section");
    // Per contract: Stage A trusts the human's explicit declaration even for
    // not-yet-existing files. The file is accepted AND a diagnostic is added.
    expect(result.files).toEqual(["src/brand-new.ts"]);
    expect(result.diagnostics).toEqual([
      { kind: "unresolvedFilePath", path: "src/brand-new.ts" },
    ]);
  });

  it("relative path resolved against repoRoot via fs.existsSync → no diagnostic", () => {
    touch(root, "src/exists-on-fs.ts");
    const graph = makeGraph([]); // not in graph, but on disk
    const text = "Files: src/exists-on-fs.ts\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.files).toEqual(["src/exists-on-fs.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("relative path resolved via graph node → no diagnostic", () => {
    const graph = makeGraph(["src/in-graph.ts"]);
    const text = "Files: src/in-graph.ts\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.files).toEqual(["src/in-graph.ts"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("`./` and `../` prefixed paths are accepted (relative, normalized as-written)", () => {
    touch(root, "src/auth.ts");
    const graph = makeGraph([]);
    const text = "Files: ./src/auth.ts\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["./src/auth.ts"]);
  });

  it("trailing slash directory paths are kept verbatim (preserve `/`)", () => {
    const graph = makeGraph([]);
    const text = "Files: src/auth/, tests/\n";
    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth/", "tests/"]);
    // Neither is in the graph nor on disk → both get the typo warning.
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { kind: "unresolvedFilePath", path: "src/auth/" },
        { kind: "unresolvedFilePath", path: "tests/" },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Stage B — regex fallback
// ---------------------------------------------------------------------------

describe("extractFiles — Stage B (regex fallback)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs only when Stage A produced zero files", () => {
    // Both Stage A (Files: section) AND Stage B candidates exist; Stage A wins.
    const graph = makeGraph(["src/auth.ts", "src/other.ts"]);
    const text = [
      "Files: src/auth.ts",
      "",
      "Some prose that also mentions src/other.ts",
    ].join("\n");

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("files-section");
    expect(result.files).toEqual(["src/auth.ts"]);
  });

  it("picks up path-shaped tokens validated against graph", () => {
    const graph = makeGraph(["src/auth.ts", "tests/auth.test.ts"]);
    // Avoid a `.` immediately after a path — `tests/auth.test.ts.` would put
    // `.` (which is in the regex char class) directly after the candidate and
    // defeat the trailing `(?![\w./-])` boundary on purpose. Authors who hit
    // that case should declare a `Files:` section.
    const text = "We plan to edit src/auth.ts and update tests/auth.test.ts in the next pass.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(result.files).toEqual(["src/auth.ts", "tests/auth.test.ts"]);
  });

  it("picks up path-shaped tokens validated against fs.existsSync", () => {
    touch(root, "src/real.ts");
    const graph = makeGraph([]);
    const text = "Edit src/real.ts to fix the bug.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(result.files).toEqual(["src/real.ts"]);
  });

  it("drops path-shaped tokens that exist neither in graph nor on fs (no diagnostic)", () => {
    const graph = makeGraph([]);
    const text = "There is no file named bogus/nonexistent.ts anywhere.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("empty");
    expect(result.files).toEqual([]);
    // Free-text scan must NOT emit warnings for arbitrary tokens.
    expect(result.diagnostics).toEqual([]);
  });

  it("drops URL-looking tokens like `https://example.com/foo.md`", () => {
    const graph = makeGraph([]);
    const text = "See https://example.com/foo.md for details.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("empty");
    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('drops HTML-tag attribute tokens like `<img src="logo.png">`', () => {
    const graph = makeGraph([]);
    const text = 'Hero image: <img src="logo.png" alt="brand">\n';

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("empty");
    expect(result.files).toEqual([]);
  });

  it("dedups Stage B candidates that appear multiple times", () => {
    const graph = makeGraph(["src/auth.ts"]);
    const text = "src/auth.ts is touched here, and src/auth.ts again below.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(result.files).toEqual(["src/auth.ts"]);
  });

  it("returns sorted files even from unordered detection", () => {
    const graph = makeGraph(["z.ts", "a.ts", "m.ts"]);
    const text = "Edit z.ts then a.ts and finally m.ts in that order.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("regex-fallback");
    expect(result.files).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Empty stage
// ---------------------------------------------------------------------------

describe("extractFiles — empty stage", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns `stage: empty` and an empty files[] when neither stage finds anything", () => {
    const graph = makeGraph([]);
    const text = "Prose with no Files: section and no path-shaped tokens at all.\n";

    const result = extractFiles(text, { graph, repoRoot: root });
    expect(result.stage).toBe("empty");
    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("returns `stage: empty` when input text is empty", () => {
    const graph = makeGraph([]);
    const result = extractFiles("", { graph, repoRoot: root });
    expect(result.stage).toBe("empty");
    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});
