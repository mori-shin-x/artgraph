import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGitDiffFiles,
  getGitRenameMap,
  getGitTrackedFiles,
  getHeadTrackedPaths,
} from "../src/diff.js";
import { gitInit, gitCommitAll, gitRevParse } from "./helpers.js";

// spec 023 (T006, FR-006) — `getGitDiffFiles` grows an optional `baseSha`:
// omitted keeps the exact three-way union (regression, FR-003); provided
// adds the committed base..HEAD range to the union. All four underlying git
// calls are `-z` + `core.quotePath=false`, so non-ASCII paths are verbatim
// from every source (SC-007).
describe("getGitDiffFiles (spec 023 FR-006)", () => {
  const dirs: string[] = [];
  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function makeCommittedRepo(prefix: string): string {
    const dir = track(mkdtempSync(join(tmpdir(), prefix)));
    gitInit(dir);
    writeFileSync(join(dir, "committed.txt"), "v1\n");
    writeFileSync(join(dir, "staged.txt"), "v1\n");
    writeFileSync(join(dir, "unstaged.txt"), "v1\n");
    gitCommitAll(dir, "init");
    return dir;
  }

  it("(a) no base arg: exact three-way union of staged, unstaged and untracked (regression)", () => {
    const dir = makeCommittedRepo("artgraph-023-diff-a-");
    writeFileSync(join(dir, "staged.txt"), "v2\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "unstaged.txt"), "v2\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");

    const files = getGitDiffFiles(dir);
    expect([...files].sort()).toEqual(["staged.txt", "untracked.txt", "unstaged.txt"].sort());
  });

  it("(b) baseSha: committed base..HEAD changes join the union", () => {
    const dir = makeCommittedRepo("artgraph-023-diff-b-");
    const base = gitRevParse(dir, "HEAD");
    writeFileSync(join(dir, "committed.txt"), "v2 (committed after base)\n");
    gitCommitAll(dir, "edit committed.txt");

    // Working tree is clean → without baseSha the diff is empty…
    expect(getGitDiffFiles(dir)).toEqual([]);
    // …with baseSha the committed change is in the set.
    expect(getGitDiffFiles(dir, base)).toContain("committed.txt");
  });

  it("(c) untracked files are still included when baseSha is passed (union, not replacement)", () => {
    const dir = makeCommittedRepo("artgraph-023-diff-c-");
    const base = gitRevParse(dir, "HEAD");
    writeFileSync(join(dir, "committed.txt"), "v2\n");
    gitCommitAll(dir, "edit committed.txt");
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    writeFileSync(join(dir, "unstaged.txt"), "v2\n");

    const files = getGitDiffFiles(dir, base);
    expect(files).toContain("committed.txt"); // base range
    expect(files).toContain("untracked.txt"); // working tree (untracked)
    expect(files).toContain("unstaged.txt"); // working tree (unstaged)
    // De-dup: each path appears exactly once.
    expect(files.length).toBe(new Set(files).size);
  });

  it("(d) non-ASCII paths are verbatim (no octal escaping) from BOTH the base range and the working tree", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-023-diff-d-")));
    gitInit(dir);
    mkdirSync(join(dir, "specs"));
    writeFileSync(join(dir, "specs", "日本語.md"), "# spec v1\n");
    writeFileSync(join(dir, "specs", "既存.md"), "# spec v1\n");
    gitCommitAll(dir, "init");
    const base = gitRevParse(dir, "HEAD");
    // base-range-only change to a non-ASCII path…
    writeFileSync(join(dir, "specs", "日本語.md"), "# spec v2\n");
    gitCommitAll(dir, "edit 日本語.md");
    // …plus a working-tree-only change to another non-ASCII path, and an
    // untracked non-ASCII file.
    writeFileSync(join(dir, "specs", "既存.md"), "# spec v2\n");
    writeFileSync(join(dir, "specs", "新規.md"), "# new\n");

    const files = getGitDiffFiles(dir, base);
    expect(files).toContain("specs/日本語.md");
    expect(files).toContain("specs/既存.md");
    expect(files).toContain("specs/新規.md");
    // No escaped variant may sneak in alongside the verbatim one.
    expect(files.some((f) => f.includes("\\"))).toBe(false);
    expect(files.some((f) => f.startsWith('"'))).toBe(false);
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

  // spec 023 (T006e, FR-008) — a rename COMMITTED inside base..HEAD is
  // invisible to the default HEAD-vs-working-tree comparison (the CI-normal
  // state) but must appear when the merge-base sha is passed.
  it("(e) a committed `git mv` in base..HEAD appears only with baseSha; no-arg stays HEAD-based", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-023-renamemap-base-")));
    gitInit(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "old.ts"), "export const a = 1;\n");
    gitCommitAll(dir, "init");
    const base = gitRevParse(dir, "HEAD");
    execFileSync("git", ["mv", "src/old.ts", "src/new.ts"], { cwd: dir, stdio: "pipe" });
    gitCommitAll(dir, "committed rename");

    // No arg: compares HEAD vs (clean) working tree → the committed rename
    // is invisible (current behavior, regression-pinned).
    expect(getGitRenameMap(dir).size).toBe(0);
    // baseSha: the committed rename is detected.
    const map = getGitRenameMap(dir, base);
    expect(map.get("src/old.ts")).toBe("src/new.ts");
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

  // spec 023 (T006f, FR-009) — a path deleted by a COMMIT inside base..HEAD
  // exists in neither HEAD's tree nor the working tree; only the merge-base
  // tree still has it. Without the baseSha probe the caller would take the
  // "not tracked" skip and the deleted file's sole `@impl` edge would
  // fail-open (issue #229's failure mode, base-range edition).
  it("(f) a path deleted in base..HEAD is tracked only when baseSha is probed", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-023-headtracked-base-")));
    gitInit(dir);
    writeFileSync(join(dir, "deleted-in-range.txt"), "will be deleted by a commit\n");
    gitCommitAll(dir, "init");
    const base = gitRevParse(dir, "HEAD");
    execFileSync("git", ["rm", "-q", "deleted-in-range.txt"], { cwd: dir, stdio: "pipe" });
    gitCommitAll(dir, "delete it");

    // HEAD-only probe (no arg): the file is gone from HEAD → not tracked.
    expect(getHeadTrackedPaths(dir, ["deleted-in-range.txt"])).toEqual(new Set());
    // HEAD ∪ merge-base probe: the merge-base tree still has it.
    expect(getHeadTrackedPaths(dir, ["deleted-in-range.txt"], base)).toEqual(
      new Set(["deleted-in-range.txt"]),
    );
  });
});
