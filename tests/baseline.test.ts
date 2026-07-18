import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBaselineIssues,
  uncoveredKey,
  orphanKey,
  driftKey,
  classifyBaseRef,
  removeWorktree,
  resolveMergeBase,
  FETCH_DEPTH_HINT,
} from "../src/baseline.js";
import { scan, reconcile } from "../src/scan.js";
import { readLock } from "../src/lock.js";
import { loadConfig } from "../src/config.js";
import {
  makeRepoWithDebt,
  makeRepoWithBaseBranch,
  gitInit,
  gitCommitAll,
  gitCheckoutBranch,
  gitRevParse,
  gitUnrelatedRootBranch,
  deadPid,
  blockWorktreeAdd,
} from "./helpers.js";

// Track temp dirs so every test cleans up even on failure.
const created: string[] = [];
function track<T extends string>(dir: T): T {
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) {
    const d = created.pop()!;
    // Best-effort: drop any leftover worktrees registered against this repo
    // before removing the dir so a failed test can't strand `.git` metadata.
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: d, stdio: "pipe" });
    } catch {
      /* not a git repo / already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function baselineWorktrees(dir: string): string[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree ") && l.includes("artgraph-baseline-"))
    .map((l) => l.slice("worktree ".length));
}

describe("computeBaselineIssues", () => {
  it("(d) computed: returns global issue key set for the base graph", () => {
    const dir = track(makeRepoWithDebt("artgraph-debt-computed-"));
    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);

    expect(result.status).toBe("computed");
    // REQ-DEBT is pre-existing uncovered — it must be in the baseline key set.
    expect(result.keys.has(uncoveredKey("REQ-200"))).toBe(true);
    // REQ-CLEAN and REQ-A are covered by an @impl — never uncovered.
    expect(result.keys.has(uncoveredKey("REQ-001"))).toBe(false);
    expect(result.keys.has(uncoveredKey("REQ-100"))).toBe(false);
  });

  it("(b) empty: no commits (unborn HEAD) → status empty, keys empty", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-empty-")));
    gitInit(dir); // git repo, but no commit yet
    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("empty");
    expect(result.keys.size).toBe(0);
  });

  it("(c) unavailable: not a git repository → status unavailable, keys empty", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-nogit-")));
    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("unavailable");
    expect(result.keys.size).toBe(0);
  });

  it("(a) side-effect-free: working tree, index and lock are byte-identical afterwards", () => {
    const dir = track(makeRepoWithDebt("artgraph-debt-noside-"));
    const config = loadConfig(dir);
    // Reconcile so a real .trace.lock exists to compare byte-for-byte.
    const { graph, warnings } = scan(dir, config);
    reconcile(dir, config, graph, warnings);
    const lock = readLock(dir, config.lockFile);

    const statusBefore = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const lockBefore = readFileSync(join(dir, ".trace.lock"), "utf-8");

    const result = computeBaselineIssues(dir, "HEAD", lock, config);
    expect(result.status).toBe("computed");

    const statusAfter = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const lockAfter = readFileSync(join(dir, ".trace.lock"), "utf-8");

    expect(statusAfter).toBe(statusBefore);
    expect(lockAfter).toBe(lockBefore);
    // No temporary worktree left behind.
    expect(baselineWorktrees(dir)).toEqual([]);
  });

  it("(g) determinism: two calls yield an identical key set", () => {
    const dir = track(makeRepoWithDebt("artgraph-debt-det-"));
    const config = loadConfig(dir);
    const a = computeBaselineIssues(dir, "HEAD", {}, config);
    const b = computeBaselineIssues(dir, "HEAD", {}, config);
    expect([...a.keys].sort()).toEqual([...b.keys].sort());
  });

  it("(f) stale cleanup: a leftover artgraph-baseline- worktree is pruned on the next run", () => {
    const dir = track(makeRepoWithDebt("artgraph-debt-stale-"));
    const config = loadConfig(dir);
    // Simulate a crashed prior run: a real worktree with the production
    // naming (`artgraph-baseline-<pid>-<random>`) whose owning process has
    // since exited (fix A1 — liveness, not just prefix/tmpdir, gates prune).
    const staleWt = track(mkdtempSync(join(tmpdir(), `artgraph-baseline-${deadPid()}-`)));
    execFileSync("git", ["worktree", "add", "--detach", staleWt, "HEAD"], {
      cwd: dir,
      stdio: "pipe",
    });
    expect(baselineWorktrees(dir).length).toBeGreaterThanOrEqual(1);

    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("computed");
    // Both the stale one and this run's own worktree are gone.
    expect(baselineWorktrees(dir)).toEqual([]);
    expect(existsSync(staleWt)).toBe(false);
  });

  it("drift keys are computed against the CURRENT lock (FR-011)", () => {
    const dir = track(makeRepoWithDebt("artgraph-debt-drift-"));
    const config = loadConfig(dir);
    // A lock that records a stale hash for REQ-A → base graph disagrees →
    // baseline drift on REQ-A even though the base ref content is unchanged.
    const staleLock = {
      "REQ-100": { contentHash: "stale-hash-value", lastReconciled: "2025-01-01T00:00:00Z" },
    };
    const result = computeBaselineIssues(dir, "HEAD", staleLock, config);
    expect(result.status).toBe("computed");
    expect(
      result.keys.has(
        driftKey({
          nodeId: "REQ-100",
          kind: "req",
          lockedHash: "stale-hash-value",
          currentHash: "x",
        }),
      ),
    ).toBe(true);
  });

  it("(T033) multiple interrupted runs leave several stale worktrees → all reclaimed next run", () => {
    const dir = track(makeRepoWithDebt("artgraph-debt-interrupt-"));
    const config = loadConfig(dir);
    // Simulate two prior runs that crashed before their `finally` removed the
    // worktree: two registered `artgraph-baseline-<dead pid>-` worktrees left
    // stranded, each naming a process that has since exited (fix A1).
    const stale1 = track(mkdtempSync(join(tmpdir(), `artgraph-baseline-${deadPid()}-`)));
    const stale2 = track(mkdtempSync(join(tmpdir(), `artgraph-baseline-${deadPid()}-`)));
    for (const s of [stale1, stale2]) {
      execFileSync("git", ["worktree", "add", "--detach", s, "HEAD"], { cwd: dir, stdio: "pipe" });
    }
    expect(baselineWorktrees(dir).length).toBeGreaterThanOrEqual(2);

    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("computed");
    // The best-effort liveness sweep reclaimed BOTH strays plus this run's own.
    expect(baselineWorktrees(dir)).toEqual([]);
    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
  });

  it("exports orphanKey/uncoveredKey/driftKey as the SSOT identity keys", () => {
    expect(uncoveredKey("REQ-1")).toBe("uncovered:REQ-1");
    expect(orphanKey({ source: "file:a.ts", target: "REQ-9", kind: "implements" })).toBe(
      "orphan:file:a.ts -> REQ-9 (implements)",
    );
    expect(driftKey({ nodeId: "REQ-1", kind: "req", lockedHash: "a", currentHash: "b" })).toBe(
      "drift:REQ-1",
    );
  });
});

// issue #182 review (Critical fix A1) — `pruneStaleWorktrees` must tell a
// concurrent run's live worktree apart from genuine crash residue instead of
// reclaiming everything matching the naming prefix unconditionally.
describe("pruneStaleWorktrees liveness (A1)", () => {
  it("a worktree whose owning process is still alive is never reclaimed", () => {
    const dir = track(makeRepoWithDebt("artgraph-a1-live-"));
    const config = loadConfig(dir);
    // Named after OUR OWN pid — trivially alive for the whole test, so this
    // exercises the general `isProcessAlive` liveness check (not just the
    // `pid === process.pid` fast path).
    // realpathSync: on macOS, tmpdir() is under a symlink (/var/folders/...
    // -> /private/var/folders/...); `git worktree add` records the
    // resolved path, so comparing against the raw mkdtemp path would
    // spuriously fail `baselineWorktrees()`'s `toContain` checks below.
    const liveWt = track(
      realpathSync(mkdtempSync(join(tmpdir(), `artgraph-baseline-${process.pid}-`))),
    );
    execFileSync("git", ["worktree", "add", "--detach", liveWt, "HEAD"], {
      cwd: dir,
      stdio: "pipe",
    });

    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("computed");
    // The live worktree must survive; only this call's own ephemeral
    // worktree is cleaned up.
    expect(existsSync(liveWt)).toBe(true);
    expect(baselineWorktrees(dir)).toContain(liveWt);
  });

  it("pre-#182 naming with no embedded PID is preserved when recently created (mtime cutoff)", () => {
    const dir = track(makeRepoWithDebt("artgraph-a1-oldrecent-"));
    const config = loadConfig(dir);
    // No liveness signal available for this naming — must be judged on
    // mtime alone, and "just created" must never be reclaimed.
    // realpathSync: see the liveWt comment above — git resolves symlinked
    // tmpdirs (macOS) before recording the worktree path.
    const staleWt = track(realpathSync(mkdtempSync(join(tmpdir(), "artgraph-baseline-"))));
    execFileSync("git", ["worktree", "add", "--detach", staleWt, "HEAD"], {
      cwd: dir,
      stdio: "pipe",
    });

    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("computed");
    expect(existsSync(staleWt)).toBe(true);
    expect(baselineWorktrees(dir)).toContain(staleWt);
  });

  it("pre-#182 naming with no embedded PID is reclaimed once older than the 24h cutoff", () => {
    const dir = track(makeRepoWithDebt("artgraph-a1-oldstale-"));
    const config = loadConfig(dir);
    const staleWt = track(mkdtempSync(join(tmpdir(), "artgraph-baseline-")));
    execFileSync("git", ["worktree", "add", "--detach", staleWt, "HEAD"], {
      cwd: dir,
      stdio: "pipe",
    });
    // Backdate mtime by 25h so it clears the 24h staleness cutoff.
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(staleWt, oldTime, oldTime);

    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("computed");
    expect(existsSync(staleWt)).toBe(false);
    expect(baselineWorktrees(dir)).toEqual([]);
  });
});

// issue #182 review (Critical fix A2) — `git worktree remove --force`
// refuses to touch the main working tree; the old fallback path caught that
// refusal with a bare `catch {}` and fell through to an unconditional
// `rmSync`, which has no such protection and deleted a real repository in
// the reproduction. `removeWorktree` is exported specifically so this
// regression can be pinned directly.
describe("removeWorktree main-worktree protection (A2)", () => {
  it("never rmSync's a path git reports as the main working tree", () => {
    const dir = track(makeRepoWithDebt("artgraph-a2-mainwt-"));
    // Ask removeWorktree to reclaim the repo's OWN root — exactly the
    // reported failure mode (a stray path resolving to the real repo).
    removeWorktree(dir, dir);
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, "src", "hub.ts"))).toBe(true);
    expect(existsSync(join(dir, "specs", "debt.md"))).toBe(true);
  });
});

// issue #182 review (High fix A4) — prune must never remove the caller's own
// cwd or rootDir, even when a leftover worktree's name looks fully
// reclaimable (dead pid / stale mtime).
describe("pruneStaleWorktrees cwd/rootDir protection (A4)", () => {
  it("never removes a worktree whose path equals rootDir, even if it looks reclaimable", () => {
    const pid = deadPid();
    // Named exactly like a reclaimable crash residue (dead pid), but IS the
    // repo root itself — `git worktree list` lists a plain repo's own root
    // as its first ("main") entry.
    const dir = track(mkdtempSync(join(tmpdir(), `artgraph-baseline-${pid}-fakemain-`)));
    gitInit(dir);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    gitCommitAll(dir, "init");
    const config = loadConfig(dir);

    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("computed");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("never removes the process's current working directory", () => {
    const dir = track(makeRepoWithDebt("artgraph-a4-cwd-"));
    const config = loadConfig(dir);
    const pid = deadPid();
    // Matches every "reclaim me" signal (prefix + dead pid) except that the
    // process is currently standing inside it — simulating "cd'd into a
    // stale leftover to inspect it, then ran `check` from there".
    const staleButCwd = track(mkdtempSync(join(tmpdir(), `artgraph-baseline-${pid}-`)));
    execFileSync("git", ["worktree", "add", "--detach", staleButCwd, "HEAD"], {
      cwd: dir,
      stdio: "pipe",
    });

    const originalCwd = process.cwd();
    process.chdir(staleButCwd);
    try {
      const result = computeBaselineIssues(dir, "HEAD", {}, config);
      expect(result.status).toBe("computed");
    } finally {
      process.chdir(originalCwd);
    }
    expect(existsSync(staleButCwd)).toBe(true);
  });
});

// issue #182 review (Critical fix B1) — every failure path funnels a real
// diagnostic into `BaselineIssues.error` instead of a silent bare catch.
describe("baseline error propagation (B1)", () => {
  it("unavailable status always carries a non-empty diagnostic error message", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-b1-nogit-")));
    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("unavailable");
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("a git worktree add failure surfaces the real git stderr, not a canned message", () => {
    const dir = track(makeRepoWithDebt("artgraph-b1-blocked-"));
    blockWorktreeAdd(dir);
    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("unavailable");
    expect(result.error).toBeTruthy();
    // The underlying git failure reason must be visible (this fixture fails
    // with "could not create leading directories of '.git/worktrees/...':
    // Not a directory").
    expect(result.error).toMatch(/worktree|directory/i);
  });

  it("(B9) a repo with a submodule returns unavailable with a submodules-not-supported message", () => {
    const dir = track(makeRepoWithDebt("artgraph-b9-submodule-"));
    const subSrc = track(mkdtempSync(join(tmpdir(), "artgraph-b9-subsrc-")));
    gitInit(subSrc);
    writeFileSync(join(subSrc, "lib.txt"), "lib\n");
    gitCommitAll(subSrc, "lib init");

    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", subSrc, "vendor/lib"],
      { cwd: dir, stdio: "pipe" },
    );
    gitCommitAll(dir, "add submodule");

    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("submodules are not supported");
  });
});

// spec 023 (T003, FR-005) — `resolveMergeBase` resolves `git merge-base
// <ref> HEAD` exactly once; every failure (unresolvable ref, unrelated
// histories, shallow clone) surfaces as a non-empty `{ error }` carrying the
// shared FETCH_DEPTH_HINT so CI users always see the fetch-depth: 0 fix.
describe("resolveMergeBase (spec 023 FR-005)", () => {
  it("(a) two diverged branches → resolves the branch-point sha, not either tip", () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-mb-diverged-"));
    const branchPoint = gitRevParse(dir, "HEAD");
    // Move BOTH sides ahead so branch point ≠ base tip ≠ feature tip.
    gitCheckoutBranch(dir, "base");
    writeFileSync(join(dir, "base-only.txt"), "base moved ahead\n");
    gitCommitAll(dir, "base moves ahead");
    gitCheckoutBranch(dir, "feature");
    writeFileSync(join(dir, "feature-only.txt"), "feature commit\n");
    gitCommitAll(dir, "feature commit");

    const result = resolveMergeBase(dir, "base");
    expect(result).toEqual({ sha: branchPoint });
    expect((result as { sha: string }).sha).not.toBe(gitRevParse(dir, "base"));
    expect((result as { sha: string }).sha).not.toBe(gitRevParse(dir, "HEAD"));
  });

  it("(b) <ref> at the same tip as HEAD → merge-base == HEAD (degenerate case)", () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-mb-sametip-"));
    const result = resolveMergeBase(dir, "base");
    expect(result).toEqual({ sha: gitRevParse(dir, "HEAD") });
  });

  it("(c) unrelated histories → { error } (non-empty, includes FETCH_DEPTH_HINT)", () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-mb-unrelated-"));
    gitUnrelatedRootBranch(dir, "unrelated");
    const result = resolveMergeBase(dir, "unrelated");
    expect("error" in result).toBe(true);
    const { error } = result as { error: string };
    expect(error.length).toBeGreaterThan(0);
    expect(error).toContain(FETCH_DEPTH_HINT);
  });

  it("(d) an unresolvable ref → { error } (fails at merge-base already)", () => {
    const dir = track(makeRepoWithBaseBranch("artgraph-023-mb-noref-"));
    const result = resolveMergeBase(dir, "nosuchref");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain(FETCH_DEPTH_HINT);
  });

  it("FETCH_DEPTH_HINT names the actions/checkout fetch-depth: 0 remedy (SSOT constant)", () => {
    expect(FETCH_DEPTH_HINT).toContain("fetch-depth: 0");
    expect(FETCH_DEPTH_HINT).toContain("shallow");
  });
});

// spec 023 (T005, FR-004) — regression pin for the safety precondition the
// `--base` path relies on: a NAMED ref that fails to resolve must classify
// as "error", never "unborn" (`isUnbornHead`'s non-HEAD early return,
// src/baseline.ts). If this ever regressed, an unfetched `--base origin/main`
// would silently become an EMPTY baseline (= every pre-existing issue counts
// as new) instead of failing closed as "unavailable".
describe("classifyBaseRef: named ref is never unborn (spec 023 FR-004 pin)", () => {
  it("an unresolvable named ref in a repo WITH commits classifies as error", () => {
    const dir = track(makeRepoWithDebt("artgraph-023-b10-named-"));
    expect(classifyBaseRef(dir, "origin/nosuch")).toBe("error");
    expect(classifyBaseRef(dir, "nosuchbranch")).toBe("error");
  });

  it("an unresolvable named ref even in an UNBORN repo classifies as error, not unborn", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-023-b10-unbornrepo-")));
    gitInit(dir); // no commits: HEAD itself is unborn…
    expect(classifyBaseRef(dir, "HEAD")).toBe("unborn");
    // …but a NAMED ref must still be an error — never empty-baseline'd.
    expect(classifyBaseRef(dir, "origin/main")).toBe("error");
  });
});

// issue #182 review (High fix B3) — `classifyBaseRef` must not collapse a
// genuinely unborn HEAD (FR-014, a normal pre-first-commit repo) and a
// corrupted/undeterminable ref into the same "empty" bucket: the latter must
// fail loud (`unavailable`) instead of silently suppressing every
// pre-existing issue as "baseline is empty, so everything is new".
describe("classifyBaseRef unborn vs error split (B3)", () => {
  it("a genuinely unborn HEAD (no commits yet) classifies as unborn", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artgraph-b3-unborn-")));
    gitInit(dir);
    expect(classifyBaseRef(dir, "HEAD")).toBe("unborn");
  });

  it("a resolvable HEAD classifies as resolved", () => {
    const dir = track(makeRepoWithDebt("artgraph-b3-resolved-"));
    expect(classifyBaseRef(dir, "HEAD")).toBe("resolved");
  });

  it("a detached HEAD at a non-existent commit classifies as error, not unborn", () => {
    const dir = track(makeRepoWithDebt("artgraph-b3-detached-"));
    // Well-formed (40 hex chars) but points at an object that doesn't
    // exist — git still recognizes the repo, but HEAD can't resolve, and
    // the content isn't a symbolic ref, so this must NOT read as "unborn".
    writeFileSync(join(dir, ".git", "HEAD"), "0000000000000000000000000000000000000000\n");
    expect(classifyBaseRef(dir, "HEAD")).toBe("error");

    const config = loadConfig(dir);
    const result = computeBaselineIssues(dir, "HEAD", {}, config);
    // Must fail loud (unavailable), never silently masquerade as "empty"
    // (which would turn every pre-existing issue into a false "new").
    expect(result.status).toBe("unavailable");
    expect(result.error).toBeTruthy();
  });
});
