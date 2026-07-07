import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiffFiles, getGitRenameMap } from "../src/diff.js";
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
