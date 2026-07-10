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
/**
 * issue #229 review (Finding 2, PR #237) — cheap probe for which of `paths`
 * were tracked in the git index at `HEAD`. `src/commands/check.ts` uses this
 * as a skip-optimization gate for `check --diff`'s eager baseline build: if
 * NONE of a diff's paths were ever tracked at HEAD (and no other
 * baseline-resolvable condition holds — see check.ts), the baseline graph
 * could not possibly resolve a startId for any of them either, so the
 * ~2-3s `git worktree add` + `scan()` can be skipped entirely and the
 * pre-existing "not tracked in the graph" early exit is reached directly,
 * matching pre-#229 latency for a diff that touches only files outside the
 * graph (e.g. an untracked README).
 *
 * Returns the SUBSET of `paths` that `git ls-tree -r HEAD` reports as
 * present at HEAD. An empty `paths` array short-circuits to an empty set
 * without invoking `git` at all.
 *
 * Batched at `LS_TREE_BATCH_SIZE` paths per `git ls-tree` invocation so a
 * huge diff (tens of thousands of files) never risks tripping a platform
 * argv length limit; each batch is queried independently.
 *
 * Safe-on-failure, but conservative in the one direction that matters for
 * the caller: this is only ever consulted to decide whether it's safe to
 * SKIP the baseline build. If a batch's `git ls-tree` call itself fails
 * (corrupted repo state, `git` missing, permissions, ...), that batch's
 * paths are added to the result as if they WERE tracked at HEAD — never
 * silently treated as "not tracked" — so a probe failure always biases the
 * caller back toward building the baseline eagerly (the always-correct,
 * pre-existing behavior) instead of ever skipping it on uncertain
 * information.
 */
const LS_TREE_BATCH_SIZE = 500;

export function getHeadTrackedPaths(rootDir: string, paths: string[]): Set<string> {
  const tracked = new Set<string>();
  if (paths.length === 0) return tracked;

  for (let i = 0; i < paths.length; i += LS_TREE_BATCH_SIZE) {
    const batch = paths.slice(i, i + LS_TREE_BATCH_SIZE);
    try {
      const output = execFileSync(
        "git",
        [
          "-c",
          "core.quotePath=false",
          "ls-tree",
          "-r",
          "HEAD",
          "--name-only",
          "-z",
          "--",
          ...batch,
        ],
        { cwd: rootDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      for (const p of parseNulSeparated(output)) tracked.add(p);
    } catch {
      // Conservative fallback (see JSDoc above) — treat this whole batch as
      // tracked so a probe failure can never cause the caller to skip a
      // baseline build it actually needed.
      for (const p of batch) tracked.add(p);
    }
  }

  return tracked;
}

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
