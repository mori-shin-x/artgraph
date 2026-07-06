import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  ArtgraphConfig,
  ArtifactGraph,
  DriftEntry,
  LockFile,
  BaselineStatus,
} from "./types.js";
import { findOrphans, findUncovered, formatOrphan, type OrphanEdge } from "./graph/traverse.js";
import { scan } from "./scan.js";

// spec 017 — baseline 差分ゲート (issue #174). Expand the base ref (Phase 1:
// HEAD) into a throw-away git worktree, `scan` it, and reduce the whole base
// graph to a set of issue identity keys. `check --diff --gate` subtracts this
// set from the current scoped issues so only *newly introduced* problems fail
// the gate. Side-effect-free: the user's working tree, index and `.trace.lock`
// are never touched (FR-004 / SC-003).

export interface BaselineIssues {
  keys: Set<string>;
  status: BaselineStatus; // "computed" | "empty" | "unavailable" (never "skipped" here)
}

// ── issue identity keys (SSOT, data-model §6 / R4) ──────────────────────────
// The current-side diff calculation (src/check.ts) imports these exact
// functions so the two sides can never disagree on how an issue is keyed.
export const driftKey = (d: DriftEntry): string => `drift:${d.nodeId}`;
export const orphanKey = (o: OrphanEdge): string => `orphan:${formatOrphan(o)}`;
export const uncoveredKey = (id: string): string => `uncovered:${id}`;
export const testfailKey = (id: string): string => `testfail:${id}`;

// Prefix used for every temporary baseline worktree so stray ones (crash /
// SIGINT before `finally` ran) can be recognised and reclaimed.
const WORKTREE_PREFIX = "artgraph-baseline-";

// spec 017 — baseline computation is base-ref-parameterised (Phase 1 pins
// "HEAD"), side-effect-free, and distinguishes the unborn-HEAD "empty" case
// from the "unavailable" error case.
// @impl 017-check-gate-baseline-diff/FR-002
// @impl 017-check-gate-baseline-diff/FR-004
// @impl 017-check-gate-baseline-diff/FR-012
// @impl 017-check-gate-baseline-diff/FR-014
export function computeBaselineIssues(
  rootDir: string,
  baseRef: string,
  currentLock: LockFile,
  config: ArtgraphConfig,
): BaselineIssues {
  const empty = (): BaselineIssues => ({ keys: new Set(), status: "empty" });
  const unavailable = (): BaselineIssues => ({ keys: new Set(), status: "unavailable" });

  // Not a git repository at all → cannot establish a baseline (FR-010). This
  // is distinct from an unborn HEAD (a valid repo with no commits), which is
  // the FR-014 "empty" case handled next.
  if (!isGitRepo(rootDir)) return unavailable();

  // Reclaim any leftover baseline worktrees from a prior interrupted run
  // before we add our own (best-effort — never fatal).
  pruneStaleWorktrees(rootDir);

  // HEAD (or the requested ref) doesn't resolve → no base state to compare
  // against. Treat as an empty baseline: every current issue is new (FR-014).
  if (!refResolves(rootDir, baseRef)) return empty();

  let worktree: string | undefined;
  try {
    worktree = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
    execFileSync("git", ["worktree", "add", "--detach", worktree, baseRef], {
      cwd: rootDir,
      stdio: "pipe",
    });
    const { graph } = scan(worktree, config);
    return { keys: collectIssueKeys(graph, currentLock), status: "computed" };
  } catch {
    return unavailable();
  } finally {
    if (worktree) removeWorktree(rootDir, worktree);
  }
}

// Global (whole base graph) issue key set: drift (vs the CURRENT lock, R3),
// orphans and uncovered REQs. Test failures are intentionally excluded — they
// belong to "this test run" and can't be reconstructed from a static ref, so
// current test failures always count as new (baseline-diff.md §1.3).
// @impl 017-check-gate-baseline-diff/FR-011
function collectIssueKeys(graph: ArtifactGraph, currentLock: LockFile): Set<string> {
  const keys = new Set<string>();

  for (const [id, entry] of Object.entries(currentLock)) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (node.contentHash !== entry.contentHash) {
      keys.add(
        driftKey({
          nodeId: id,
          kind: node.kind,
          lockedHash: entry.contentHash,
          currentHash: node.contentHash,
        }),
      );
    }
  }

  for (const o of findOrphans(graph)) keys.add(orphanKey(o));
  for (const id of findUncovered(graph)) keys.add(uncoveredKey(id));

  return keys;
}

function isGitRepo(rootDir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rootDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function refResolves(rootDir: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: rootDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function removeWorktree(rootDir: string, worktree: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: rootDir,
      stdio: "pipe",
    });
  } catch {
    // remove failed (e.g. dir already gone) — fall back to prune + rm so the
    // baseline result (already computed) is still returned.
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: rootDir, stdio: "pipe" });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(worktree, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// Reclaim leftover `artgraph-baseline-` worktrees registered against this
// repo. Runs at the start of every invocation so residue from a crashed run
// can't accumulate and bloat `git worktree list` / disk.
function pruneStaleWorktrees(rootDir: string): void {
  let listing: string;
  try {
    listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
  } catch {
    return;
  }
  const tmpRoot = tmpdir();
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    // Only ever reclaim OUR temp worktrees: a direct child of the OS temp dir
    // whose basename carries the WORKTREE_PREFIX. This must never match the
    // caller's own repo/worktree (which is where `finally` runs `rmSync`) —
    // a looser substring match once nuked a repo path that merely contained
    // the prefix. Anything failing either guard is left untouched (safe).
    if (!path.startsWith(tmpRoot)) continue;
    if (!basename(path).startsWith(WORKTREE_PREFIX)) continue;
    try {
      execFileSync("git", ["worktree", "remove", "--force", path], { cwd: rootDir, stdio: "pipe" });
    } catch {
      /* fall through to prune */
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: rootDir, stdio: "pipe" });
  } catch {
    /* best-effort */
  }
}
