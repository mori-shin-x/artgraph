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

// Kept as a public export so a small set of tests (SC-004 perf) can still
// spawn the real bin via subprocess.
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

// ---------------------------------------------------------------------------
// spec 023 (T002) — base-branch fixtures for `check --diff --base <ref>`.
// ---------------------------------------------------------------------------

/** Switch to (or with `create`) create-and-switch-to branch `name`. */
export function gitCheckoutBranch(dir: string, name: string, create = false): void {
  execFileSync("git", create ? ["checkout", "-q", "-b", name] : ["checkout", "-q", name], {
    cwd: dir,
    stdio: "pipe",
  });
}

export function gitRevParse(dir: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { cwd: dir, encoding: "utf-8" }).trim();
}

/**
 * spec 023 (T002) — graft a `base` + `feature` branch pair onto an existing
 * committed repo: `base` is created at the current HEAD (the branch point)
 * and `feature` is created and checked out from the same commit. Tests then
 * stack independent commits on either side (`gitCheckoutBranch` +
 * `gitCommitAll`) to build moved-ahead-base / committed-change fixtures for
 * `check --diff --base base`.
 */
export function withBaseAndFeatureBranches(dir: string): string {
  execFileSync("git", ["branch", "base"], { cwd: dir, stdio: "pipe" });
  gitCheckoutBranch(dir, "feature", true);
  return dir;
}

/** `makeRepoWithDebt` (pre-existing uncovered REQ-200) + base/feature branches. */
export function makeRepoWithBaseBranch(prefix: string): string {
  return withBaseAndFeatureBranches(makeRepoWithDebt(prefix));
}

/**
 * spec 023 (T002/T003) — point `name` at a second ROOT commit (no parent, no
 * shared history) built via plumbing (`mktree` + `commit-tree`). tasks.md
 * sketched `git checkout --orphan` for this, but plumbing never touches the
 * working tree / index / HEAD, so the fixture repo's checked-out branch is
 * guaranteed byte-identical before and after. `git merge-base <name> HEAD`
 * then deterministically fails (unrelated histories — the shallow-clone
 * failure's local stand-in).
 */
export function gitUnrelatedRootBranch(dir: string, name: string): void {
  const tree = execFileSync("git", ["mktree"], { cwd: dir, input: "", encoding: "utf-8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", "unrelated root"], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
  execFileSync("git", ["branch", name, commit], { cwd: dir, stdio: "pipe" });
}

/**
 * spec 023 (T011) — run `mutate` as a commit on the `base` branch (moving it
 * ahead of the branch point), then return to `feature`. The feature branch's
 * working tree ends up exactly as it started.
 */
export function commitOnBase(dir: string, mutate: () => void, message: string): void {
  gitCheckoutBranch(dir, "base");
  mutate();
  gitCommitAll(dir, message);
  gitCheckoutBranch(dir, "feature");
}

/**
 * spec 023 (T011) — cover `makeRepoWithDebt`'s pre-existing uncovered
 * REQ-200 with an `@impl` claim (the "base fixed the branch-point issue"
 * mutation for the moved-ahead-base scenario). The literal tag string lives
 * here (non-`.test.ts`, outside the `src/**` include set) for the same
 * dogfood-scan reason as `introduceNewOrphan`.
 */
export function coverDebtReq(dir: string): void {
  appendFileSync(join(dir, "src", "hub.ts"), "// @impl REQ-200\n");
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
 * issue #229 — a committed repo carrying a **sole `@impl` / `@verifies`
 * claim** so a test can delete just that one edge and assert the affected
 * REQ becomes newly-uncovered under `check --diff --gate` (the union-scope
 * fix: the CURRENT graph alone can no longer see the deleted edge, so the
 * fix must also compute scope on the BASELINE graph, where the edge still
 * exists, to pull the REQ into scope):
 *
 *  - `specs/target.md` defines `REQ-500` (implemented only by `fnTarget`,
 *    no test coverage) and `REQ-501` (implemented by `fnVerified` AND
 *    verified by `tests/target.test.ts`'s `[REQ-501]` tag).
 *  - `src/target.ts` holds both `fnTarget` (`@impl REQ-500`, sole claim) and
 *    `fnVerified` (`@impl REQ-501`).
 *  - `tests/target.test.ts` holds the sole `[REQ-501]` `verifies` tag.
 *
 * Everything is scanned, locked, and committed to HEAD before returning.
 */
export function makeRepoWithSoleImplTag(prefix: string): string {
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
  mkdirSync(join(dir, "tests"), { recursive: true });

  writeFileSync(
    join(dir, "specs", "target.md"),
    "# Target\n\n- REQ-500: only implemented by fnTarget\n- REQ-501: implemented and verified\n",
  );
  writeFileSync(
    join(dir, "src", "target.ts"),
    [
      "// @impl REQ-500",
      "export function fnTarget(): number {",
      "  return 1;",
      "}",
      "",
      "// @impl REQ-501",
      "export function fnVerified(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tests", "target.test.ts"),
    [
      'import { describe, it } from "vitest";',
      "",
      'describe("fnVerified", () => {',
      '  it("does something [REQ-501]", () => {});',
      "});",
      "",
    ].join("\n"),
  );

  gitInit(dir);
  gitCommitAll(dir, "init with sole @impl/@verifies claim (issue #229 fixture)");
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
