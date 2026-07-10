import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDiffFiles,
  getGitRenameMap,
  getGitTrackedFiles,
  getHeadTrackedPaths,
} from "../src/diff.js";
import { gitInit, gitCommitAll } from "./helpers.js";

describe("parseDiffFiles", () => {
  it("should parse git diff --name-only output", () => {
    const diffOutput = "src/auth/login.ts\nsrc/auth/session.ts\n";
    const files = parseDiffFiles(diffOutput);
    expect(files).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
  });

  it("should ignore empty lines", () => {
    const diffOutput = "src/auth/login.ts\n\nsrc/auth/session.ts\n\n";
    const files = parseDiffFiles(diffOutput);
    expect(files).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
  });

  it("should return empty array for empty diff", () => {
    const files = parseDiffFiles("");
    expect(files).toEqual([]);
  });
});

// issue #212 — `rename` no longer consumes getGitTrackedFiles (its file
// enumeration is `.artgraph.json`-pattern based now), but the helper stays
// exported for git-scoped tooling. Pin its contract in isolation: tracked
// files only, NUL-separated so non-ASCII paths survive unescaped.
describe("getGitTrackedFiles", () => {
  const dirs: string[] = [];
  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("returns tracked files verbatim (incl. non-ASCII) and excludes untracked ones", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-lsfiles-")));
    gitInit(dir);
    mkdirSync(join(dir, "specs"));
    writeFileSync(join(dir, "specs", "日本語.md"), "# spec\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    gitCommitAll(dir, "init");
    writeFileSync(join(dir, "untracked.txt"), "u\n");

    const files = getGitTrackedFiles(dir);
    expect(files).toContain("a.txt");
    expect(files).toContain("specs/日本語.md");
    expect(files).not.toContain("untracked.txt");
  });

  it("throws with an explicit message for a non-git directory", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-lsfiles-nogit-")));
    expect(() => getGitTrackedFiles(dir)).toThrow(/git ls-files/);
  });
});

// spec 017 (High fix C2, issue #182 review) — T-rename-3: unit coverage for
// the rename-map parser in isolation (tests/check-baseline-diff.test.ts
// exercises it end-to-end through the gate).
describe("getGitRenameMap", () => {
  const dirs: string[] = [];
  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("returns an empty map when nothing was renamed (plain edit only)", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-renamemap-none-")));
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    gitCommitAll(dir, "init");
    writeFileSync(join(dir, "a.txt"), "hello, edited\n");

    expect(getGitRenameMap(dir).size).toBe(0);
  });

  it("maps old path to new path for a staged `git mv`", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-renamemap-mv-")));
    gitInit(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "old.ts"), "export const a = 1;\n");
    gitCommitAll(dir, "init");
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd: dir, stdio: "pipe" });

    const map = getGitRenameMap(dir);
    expect(map.size).toBe(1);
    expect(map.get("src/old.ts")).toBe("src/new.ts");
  });

  it("handles a non-ASCII rename alongside an unrelated modify and a new file", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-renamemap-nonascii-")));
    gitInit(dir);
    mkdirSync(join(dir, "specs"));
    writeFileSync(join(dir, "specs", "日本語.md"), "# spec\n");
    writeFileSync(join(dir, "unrelated.txt"), "v1\n");
    gitCommitAll(dir, "init");
    execFileSync("git", ["mv", "specs/日本語.md", "specs/新規.md"], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "unrelated.txt"), "v2\n");
    writeFileSync(join(dir, "brandnew.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });

    const map = getGitRenameMap(dir);
    // Only the rename becomes a map entry — the modify/add never do.
    expect(map.size).toBe(1);
    expect(map.get("specs/日本語.md")).toBe("specs/新規.md");
  });

  it("returns an empty map (never throws) for a non-git directory", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-renamemap-nogit-")));
    expect(() => getGitRenameMap(dir)).not.toThrow();
    expect(getGitRenameMap(dir).size).toBe(0);
  });

  it("returns an empty map (never throws) for an unborn HEAD", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-renamemap-unborn-")));
    gitInit(dir); // repo exists, but no commit yet
    expect(() => getGitRenameMap(dir)).not.toThrow();
    expect(getGitRenameMap(dir).size).toBe(0);
  });
});

// issue #229 review (Finding 2, PR #237) — unit coverage for the cheap
// baseline-skip probe in isolation (tests/check-baseline-diff.test.ts
// exercises it end-to-end through the gate via T229-perf).
describe("getHeadTrackedPaths", () => {
  const dirs: string[] = [];
  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("returns an empty set without invoking git for an empty paths array", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-headtracked-empty-")));
    // Not even a git repo — if this called git it would throw/return early
    // via the catch path, not via the empty-array short-circuit. Asserting
    // size 0 here doesn't distinguish the two, so the real point is just
    // that it never throws even outside a repo.
    expect(getHeadTrackedPaths(dir, [])).toEqual(new Set());
  });

  it("returns only the subset of paths that exist at HEAD", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-headtracked-subset-")));
    gitInit(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "tracked.ts"), "export const a = 1;\n");
    gitCommitAll(dir, "init");
    writeFileSync(join(dir, "untracked.ts"), "export const b = 2;\n");

    const result = getHeadTrackedPaths(dir, [
      "src/tracked.ts",
      "untracked.ts",
      "does/not/exist.ts",
    ]);
    expect(result).toEqual(new Set(["src/tracked.ts"]));
  });

  it("a path added after HEAD (working-tree-only) is NOT tracked", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-headtracked-new-")));
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    gitCommitAll(dir, "init");
    writeFileSync(join(dir, "b.txt"), "brand new, never committed\n");

    expect(getHeadTrackedPaths(dir, ["a.txt", "b.txt"])).toEqual(new Set(["a.txt"]));
  });

  it("a path deleted from the working tree but still present at HEAD IS tracked", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-headtracked-deleted-")));
    gitInit(dir);
    writeFileSync(join(dir, "gone.txt"), "will be deleted\n");
    gitCommitAll(dir, "init");
    execFileSync("git", ["rm", "gone.txt"], { cwd: dir, stdio: "pipe" });

    expect(getHeadTrackedPaths(dir, ["gone.txt"])).toEqual(new Set(["gone.txt"]));
  });

  it("fails safe (never throws) and treats requested paths as tracked for a non-git directory", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-headtracked-nogit-")));
    expect(() => getHeadTrackedPaths(dir, ["a.ts", "b.ts"])).not.toThrow();
    // Conservative-on-failure: a probe failure must never look like "nothing
    // is tracked" to the caller, or the caller could wrongly skip a baseline
    // build it actually needed (see the JSDoc in src/diff.ts).
    expect(getHeadTrackedPaths(dir, ["a.ts", "b.ts"])).toEqual(new Set(["a.ts", "b.ts"]));
  });
});
