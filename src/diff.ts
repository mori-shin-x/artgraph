import { execFileSync } from "node:child_process";

export function parseDiffFiles(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function getGitDiffFiles(rootDir: string): string[] {
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  const unstaged = execFileSync("git", ["diff", "--name-only"], {
    cwd: rootDir,
    encoding: "utf-8",
  });
  const combined = new Set([...parseDiffFiles(staged), ...parseDiffFiles(unstaged)]);
  return [...combined];
}
