import { execFileSync } from "node:child_process";

export function parseDiffFiles(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Split a NUL-delimited git output (`-z`) into path entries. NUL-separated
 * output is never quoted/escaped by git, so paths with non-ASCII characters,
 * spaces or quotes survive verbatim.
 */
export function parseNulSeparated(output: string): string[] {
  return output.split("\0").filter((l) => l.length > 0);
}

export function getGitTrackedFiles(rootDir: string): string[] {
  try {
    // `-z` emits NUL-separated, unquoted paths and `core.quotePath=false`
    // is a belt-and-braces guard so non-ASCII paths (e.g. specs/日本語.md)
    // are never octal-escaped — otherwise `existsSync` on the escaped name
    // fails and the file is silently skipped.
    const output = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    return parseNulSeparated(output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to run git ls-files: ${msg}`);
  }
}

export function getGitDiffFiles(rootDir: string): string[] {
  try {
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const unstaged = execFileSync("git", ["diff", "--name-only"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const combined = new Set([
      ...parseDiffFiles(staged),
      ...parseDiffFiles(unstaged),
      ...parseDiffFiles(untracked),
    ]);
    return [...combined];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to run git diff (is this a git repository?): ${msg}`);
  }
}
