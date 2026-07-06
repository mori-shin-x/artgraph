import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBaselineIssues, uncoveredKey, orphanKey, driftKey } from "../src/baseline.js";
import { scan, reconcile } from "../src/scan.js";
import { readLock } from "../src/lock.js";
import { loadConfig } from "../src/config.js";
import { makeRepoWithDebt, gitInit } from "./helpers.js";

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
    const { graph } = scan(dir, config);
    reconcile(dir, config, graph);
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
    // signature (direct tmpdir child, `artgraph-baseline-` basename) that a
    // missing `finally` never removed.
    const staleWt = track(mkdtempSync(join(tmpdir(), "artgraph-baseline-")));
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
