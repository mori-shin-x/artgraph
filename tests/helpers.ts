import { resolve, join } from "node:path";
import {
  existsSync,
  unlinkSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { runCli } from "../src/cli.js";

// Kept as a public export so a small set of tests (SC-004 perf, hook-pretool
// stdin tests) can still spawn the real bin via subprocess.
export const CLI = resolve(import.meta.dirname, "../dist/cli.js");
export const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
export const LOCK_PATH = resolve(FIXTURE_DIR, ".trace.lock");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function run(args: string[]): Promise<RunResult> {
  return runAt(FIXTURE_DIR, args);
}

export function runAt(cwd: string, args: string[]): Promise<RunResult> {
  return runCli(args, { cwd });
}

export function runWithStdin(args: string[], stdin: string, cwd?: string): Promise<RunResult> {
  return runCli(args, { cwd: cwd ?? FIXTURE_DIR, stdin });
}

export function cleanup() {
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
}

// ---------------------------------------------------------------------------
// spec 017 (T002) — temp git repo fixtures for the baseline-diff gate.
// ---------------------------------------------------------------------------

export function gitInit(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
}

export function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" });
}

/**
 * spec 017 (T002) — build a committed temp git repo carrying **pre-existing
 * debt** in the shape issue #174 describes:
 *
 *  - `specs/debt.md` defines `REQ-A` (covered by `src/hub.ts`) and its sibling
 *    `REQ-DEBT` (uncovered — the pre-existing debt). Touching `src/hub.ts`
 *    drags `REQ-DEBT` into the blast radius via the shared doc, so the gate
 *    must learn to suppress it as pre-existing.
 *  - `specs/clean.md` / `src/clean.ts` are a self-contained covered pair whose
 *    blast radius has zero gate issues (used for the lazy-eval "skipped" path).
 *
 * `.trace.lock` is gitignored exactly like production (FR-011): baseline drift
 * is judged against the *current* lock, never a committed one.
 */
export function makeRepoWithDebt(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, ".gitignore"), ".trace.lock\nnode_modules/\n");
  writeFileSync(
    join(dir, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.ts"],
      lockFile: ".trace.lock",
    }),
  );
  mkdirSync(join(dir, "specs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });

  // NOTE: requirement IDs must be `PREFIX-<digits>` (grammar/tokens.ts) — a
  // suffix like `REQ-DEBT` is NOT recognised as a req node.
  writeFileSync(
    join(dir, "specs", "clean.md"),
    "# Clean\n\n- REQ-001: fully covered requirement\n",
  );
  writeFileSync(join(dir, "src", "clean.ts"), "// @impl REQ-001\nexport const clean = 1;\n");

  writeFileSync(
    join(dir, "specs", "debt.md"),
    "# Debt\n\n- REQ-100: covered by the hub\n- REQ-200: pre-existing uncovered debt\n",
  );
  writeFileSync(join(dir, "src", "hub.ts"), "// @impl REQ-100\nexport const hub = 1;\n");

  gitInit(dir);
  gitCommitAll(dir, "init with pre-existing debt");
  return dir;
}

/**
 * spec 017 — introduce a brand-new orphan: an `@impl` claim on an in-scope
 * file pointing at a REQ that does not exist. The literal tag string lives
 * HERE (a non-`.test.ts` helper, outside the `src/**` include set) rather than
 * in the test files, so artgraph's OWN dogfood scan never mistakes the fixture
 * text for a real code tag (which would fail `check --diff --gate` on this repo).
 */
export function introduceNewOrphan(dir: string): void {
  appendFileSync(join(dir, "src", "hub.ts"), "// @impl REQ-999\n");
}

/**
 * spec 017 (High fix C2, issue #182 review) — a committed repo carrying a
 * **pre-existing orphan**: `src/old.ts` has an `@impl REQ-999` tag whose
 * target REQ is never defined anywhere in `specs/`. The orphan is committed
 * as-is (it predates any diff), so a later `git mv src/old.ts <newPath>`
 * with zero content change is a pure rename of a pre-existing issue — the
 * gate must keep suppressing it after the rename (baseline key
 * normalization via `getGitRenameMap`, C2). `src/clean.ts` gives the repo a
 * second, fully-covered file so a rename of `old.ts` isn't the only file in
 * the graph.
 */
export function makeRepoWithOrphan(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, ".gitignore"), ".trace.lock\nnode_modules/\n");
  writeFileSync(
    join(dir, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.ts"],
      lockFile: ".trace.lock",
    }),
  );
  mkdirSync(join(dir, "specs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "specs", "clean.md"),
    "# Clean\n\n- REQ-001: fully covered requirement\n",
  );
  writeFileSync(join(dir, "src", "clean.ts"), "// @impl REQ-001\nexport const clean = 1;\n");

  // Pre-existing orphan: REQ-999 is never defined anywhere in specs/.
  writeFileSync(join(dir, "src", "old.ts"), "// @impl REQ-999\nexport const old = 1;\n");

  gitInit(dir);
  gitCommitAll(dir, "init with pre-existing orphan");
  return dir;
}

/**
 * spec 017 (T022b / T026) — an **unborn HEAD** repo: `git init` with an
 * uncommitted, untracked spec + impl carrying a scoped issue. `git rev-parse
 * HEAD` fails, so `computeBaselineIssues` returns `status:"empty"` and every
 * current issue counts as new (FR-014). The untracked files show up in the
 * `--diff` set via `git ls-files --others`.
 */
export function makeUnbornRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, ".gitignore"), ".trace.lock\nnode_modules/\n");
  writeFileSync(
    join(dir, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.ts"],
      lockFile: ".trace.lock",
    }),
  );
  mkdirSync(join(dir, "specs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  // REQ-300 has no @impl anywhere → uncovered (a scoped issue that makes the
  // lazy-eval build a baseline). No commit is made: HEAD is unborn.
  writeFileSync(join(dir, "specs", "new.md"), "# New\n\n- REQ-300: brand-new uncovered\n");
  writeFileSync(join(dir, "src", "feature.ts"), "export const feature = 1;\n");
  gitInit(dir); // repo exists, but there is no commit → unborn HEAD
  return dir;
}

/**
 * spec 017 (T020 / T026) — force the baseline build to fail *after* `git diff`
 * has already succeeded, so the run reaches `baselineStatus:"unavailable"`
 * (contract cli-check-gate §4.4 / §4.5). Writing a regular file where git
 * wants to create the `worktrees/` admin directory makes `git worktree add`
 * fail with ENOTDIR while leaving `rev-parse` / `diff` fully functional. This
 * is the only path that reliably reaches "unavailable" through `check --diff`
 * (a non-git dir would instead throw inside `git diff` before any baseline).
 */
export function blockWorktreeAdd(dir: string): void {
  // `.git` is a directory for a freshly `git init`'d repo; `.git/worktrees`
  // does not exist yet, so planting a file there is safe and deterministic.
  writeFileSync(join(dir, ".git", "worktrees"), "block");
}

/**
 * spec 017 (fix A1, issue #182 review) — returns a PID guaranteed to no
 * longer be running, simulating a prior `artgraph` invocation that has
 * already exited (crashed or completed normally). Used to name a fake
 * leftover baseline worktree so `pruneStaleWorktrees`'s liveness check
 * (`process.kill(pid, 0)`) reclaims it deterministically, without a 24h
 * mtime wait and without any risk of colliding with a real running process.
 */
export function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (typeof result.pid !== "number") {
    throw new Error("deadPid(): failed to spawn a helper process");
  }
  return result.pid;
}
