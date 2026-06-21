import { execFileSync } from "node:child_process";

export function parseDiffFiles(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function getGitTrackedFiles(rootDir: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    return parseDiffFiles(output);
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
