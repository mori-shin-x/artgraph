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

/**
 * spec 017 (High fix C2, issue #182 review) — returns a mapping of renamed
 * files (old path → new path) between HEAD and the working tree (staged +
 * unstaged), via `git diff -M --name-status HEAD` with rename detection
 * enabled. Only records `git` itself reports as a rename (`R<score>`) are
 * included; a plain modify/add/delete never appears in the map.
 *
 * `-z` emits NUL-separated, unquoted fields and `core.quotePath=false` is the
 * same belt-and-braces guard `getGitTrackedFiles` uses, so a non-ASCII
 * rename (e.g. `specs/日本語.md` → `specs/新規.md`) round-trips without
 * octal escaping.
 *
 * Empty map when there are no renames, or when `git` itself fails (no repo,
 * unborn HEAD, corrupted ref, ...) — silent by design: callers that need to
 * distinguish "no repo" from "no renames" already do so through other means
 * (`baseline.ts`'s `detectNotGitRepoReason` / `classifyBaseRef` both run
 * before this is ever called), so this helper only ever needs to answer "is
 * there a rename to account for".
 *
 * Note: `git diff <commit>` (no `--cached`) never reports untracked files, so
 * a plain filesystem `mv` that was never `git add`-ed is NOT detected as a
 * rename here (it shows as a plain deletion of the old path, with the new
 * path invisible to this diff). `git mv` — which stages both sides — always
 * is, and is the case baseline normalization needs (spec.md C2).
 */
export function getGitRenameMap(rootDir: string): Map<string, string> {
  const map = new Map<string, string>();
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "-M", "-z", "--name-status", "HEAD"],
      { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return map;
  }

  const fields = parseNulSeparated(output);
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    // A rename record is 3 fields (`R<score>`, oldPath, newPath); every other
    // status (M/A/D/T/U/X) is 2 fields (status, path). `-C` (copy detection)
    // is never passed, so a `C<score>` status never appears here.
    if (status.startsWith("R")) {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        map.set(oldPath, newPath);
      }
      i += 3;
    } else {
      i += 2;
    }
  }

  return map;
}
