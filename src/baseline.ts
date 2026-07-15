import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import type {
  ArtgraphConfig,
  ArtifactGraph,
  DriftEntry,
  LockFile,
  BaselineStatus,
} from "./types.js";
import { findOrphans, findUncovered, formatOrphan, type OrphanEdge } from "./graph/traverse.js";
import { scan } from "./scan.js";
import { getGitRenameMap } from "./diff.js";

// spec 017 — baseline 差分ゲート (issue #174). Expand the base ref (Phase 1:
// HEAD) into a throw-away git worktree, `scan` it, and reduce the whole base
// graph to a set of issue identity keys. `check --diff --gate` subtracts this
// set from the current scoped issues so only *newly introduced* problems fail
// the gate. Side-effect-free: the user's working tree, index and `.trace.lock`
// are never touched (FR-004 / SC-003).
//
// issue #182 review (PR #182 adversarial review, Phase 1a/Alpha) hardened the
// worktree lifecycle, exception handling and observability of this module —
// see the fix markers (A1..A6, B1, B3, B8, B9) scattered through the file.

export interface BaselineIssues {
  keys: Set<string>;
  status: BaselineStatus; // "computed" | "empty" | "unavailable" (never "skipped" here)
  // spec 017 (Critical fix B1, issue #182 review) — diagnostic message
  // captured when `status === "unavailable"`. Always a non-empty string when
  // present; unset for every other status. `check()` copies this verbatim
  // into `CheckResult.baselineError` (data-model.md §1.1, contracts/
  // baseline-diff.md §1.2).
  error?: string;
  /**
   * The raw base-ref worktree scan graph, defined only when
   * `status === "computed"`. issue #229 — `check --diff`'s scope used to be
   * computed on the CURRENT graph alone, so a diff that DELETES the only
   * `@impl`/`@verifies` edge to a REQ removes that edge from the current
   * graph before `impact()` ever walks it: the REQ never enters scope and
   * the newly-uncovered REQ silently escapes the gate. `src/commands/check.ts`
   * reuses this graph to also compute impact/scope on the BASELINE side and
   * union the two, so an edge that exists on only one side of the diff still
   * pulls its REQ into scope. See spec 017 US2 AS3.
   */
  graph?: ArtifactGraph;
}

// ── issue identity keys (SSOT, data-model §6 / R4) ──────────────────────────
// The current-side diff calculation (src/check.ts) imports these exact
// functions so the two sides can never disagree on how an issue is keyed.
export const driftKey = (d: DriftEntry): string => `drift:${d.nodeId}`;
export const orphanKey = (o: OrphanEdge): string => `orphan:${formatOrphan(o)}`;
export const uncoveredKey = (id: string): string => `uncovered:${id}`;
export const testfailKey = (id: string): string => `testfail:${id}`;

// Base prefix shared by every temp baseline worktree's basename (creation AND
// prune-sweep matching). Fix A1 (issue #182 review): the *created* directory
// name is now `${WORKTREE_PREFIX}${pid}-<mkdtemp random suffix>` so a prune
// sweep can recover the owning PID and check liveness before ever touching a
// worktree — a plain prefix match couldn't tell a live concurrent run's
// worktree apart from genuine crash residue.
const WORKTREE_PREFIX = "artgraph-baseline-";

// Pre-#182 worktrees were named `${WORKTREE_PREFIX}<mkdtemp random suffix>`
// with no embedded PID. Such a name carries no liveness signal, so it's only
// reclaimed once clearly abandoned (fix A1).
const STALE_MTIME_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24h

// spec 017 (Critical fix A3, issue #182 review) — worktrees this PROCESS has
// created via `computeBaselineIssues` and not yet cleaned up. Node's default
// SIGINT/SIGTERM/SIGHUP handling terminates the process without running
// pending `finally` blocks, so without this tracker + a registered signal
// handler (`installBaselineSignalHandlers`, below) a Ctrl+C or CI job kill
// mid-scan leaks the ephemeral worktree — which then becomes crash residue
// for the NEXT run's prune sweep (fix A1) to reason about. Module-scoped by
// design: a single Node process only ever needs one such registry.
const activeWorktrees = new Set<{ rootDir: string; path: string }>();

let signalHandlersInstalled = false;
let handlingFatalSignal = false;

// spec 017 (Critical fix A3, issue #182 review) — call once from the CLI
// entry point (NOT from the in-process test harness — see src/cli.ts) so a
// fatal signal or an uncaught error still gets a chance to synchronously
// remove any worktree this process was mid-way through building. Idempotent:
// only the first call actually registers handlers.
export function installBaselineSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const fatalHandler = (exitCode: number, eventName: string) => (arg?: unknown) => {
    if (handlingFatalSignal) return; // already unwinding — avoid re-entrant cleanup
    handlingFatalSignal = true;

    // Preserve Node's default diagnostic behavior for uncaughtException /
    // unhandledRejection (normally: print the error, exit 1) — this handler
    // exists to run worktree cleanup first, not to make failures quieter.
    if (arg !== undefined) {
      const printable = arg instanceof Error ? (arg.stack ?? arg.message) : String(arg);
      console.error(printable);
    }

    // Deleting the CURRENT entry mid-iteration is well-defined for `Set`
    // (it won't be revisited and no other entry is skipped), so this can
    // iterate `activeWorktrees` directly without snapshotting it first.
    for (const entry of activeWorktrees) {
      try {
        removeWorktree(entry.rootDir, entry.path);
      } catch (e) {
        debugLog(`installBaselineSignalHandlers: cleanup failed for ${entry.path}`, e);
      }
      activeWorktrees.delete(entry);
    }

    // issue #155/#125 (`scan --serve`) — some commands register their OWN
    // SIGINT/SIGTERM listener for command-specific graceful shutdown (e.g.
    // draining the HTTP server before exiting). This handler is installed
    // FIRST, at CLI entry, before such a command ever runs — so if it always
    // exits here, it wins the race against Node's in-order listener dispatch
    // and the command's own drain logic never runs. When another listener is
    // already registered for this event, defer: finish the worktree cleanup
    // above but let that listener decide the actual exit path/code.
    if (process.listenerCount(eventName) > 1) return;
    process.exit(exitCode);
  };

  process.on("SIGINT", fatalHandler(130, "SIGINT"));
  process.on("SIGTERM", fatalHandler(143, "SIGTERM"));
  process.on("SIGHUP", fatalHandler(129, "SIGHUP"));
  process.on("uncaughtException", fatalHandler(1, "uncaughtException"));
  process.on("unhandledRejection", fatalHandler(1, "unhandledRejection"));
}

// spec 023 (FR-004/FR-005) — the single shallow-clone remedy hint (SSOT).
// Both `--base` failure stages (ref resolution via `classifyBaseRef` and
// merge-base computation below) append this same constant, because in CI the
// dominant root cause is identical for both: `actions/checkout`'s default
// `fetch-depth: 1` fetched neither the base ref nor the common ancestor.
// @impl 023-check-base-ref/FR-004
export const FETCH_DEPTH_HINT =
  "hint: if this is a shallow clone, fetch full history (actions/checkout: fetch-depth: 0) or fetch the base ref first.";

// spec 023 (FR-005, D1) — resolve `git merge-base <ref> HEAD` exactly ONCE.
// The returned sha is the single base point shared by the diff range, rename
// detection, the tracked-path probe AND the baseline worktree (the caller —
// src/commands/check.ts — distributes it by argument; nothing re-resolves).
// Using `<ref>`'s tip instead would mis-judge in both directions whenever
// the base branch moved ahead of the branch point (research.md R1): issues
// fixed on base since the branch point would false-fail the gate, and issues
// introduced on base since then would suppress a PR's identical new issue.
//
// Failure shape (verified empirically, T001): a shallow clone with a missing
// common ancestor and unrelated histories both exit 1 with EMPTY stdout and
// EMPTY stderr, so `extractErrorMessage` alone would surface only Node's
// generic "Command failed" text — the context line + FETCH_DEPTH_HINT are
// prepended/appended here so the diagnostic is actionable either way.
// @impl 023-check-base-ref/FR-005
export function resolveMergeBase(
  rootDir: string,
  ref: string,
): { sha: string } | { error: string } {
  try {
    const out = execFileSync("git", ["merge-base", ref, "HEAD"], {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sha = out.trim();
    if (sha) return { sha };
    // Defensive: exit 0 always prints the sha, but never return an empty
    // base point that downstream git calls would misparse.
    return {
      error: `git merge-base ${ref} HEAD produced no output\n${FETCH_DEPTH_HINT}`,
    };
  } catch (e) {
    debugLog("resolveMergeBase", e);
    return {
      error: `could not determine merge-base of "${ref}" and HEAD (shallow clone or unrelated histories?): ${extractErrorMessage(e)}\n${FETCH_DEPTH_HINT}`,
    };
  }
}

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
  // spec 023 (FR-008, data-model §5 SSOT) — the rename map computed by the
  // caller (`getGitRenameMap(rootDir, baseSha?)`) so the inverse-rename
  // startId resolution in src/commands/check.ts and the orphan-key
  // normalization below always share ONE map instance (no re-resolution —
  // an internally recomputed HEAD-based map would silently miss committed
  // base..HEAD renames whenever `--base` is in play). Omitted (legacy /
  // direct callers): falls back to the pre-023 HEAD-vs-working-tree map.
  renameMap?: Map<string, string>,
): BaselineIssues {
  const empty = (): BaselineIssues => ({ keys: new Set(), status: "empty" });
  const unavailable = (error: string): BaselineIssues => ({
    keys: new Set(),
    status: "unavailable",
    error: error.trim() || "unknown error",
  });

  // Not a git repository at all → cannot establish a baseline (FR-010). This
  // is distinct from an unborn HEAD (a valid repo with no commits), which is
  // the FR-014 "empty" case handled below via classifyBaseRef.
  const notGitRepoReason = detectNotGitRepoReason(rootDir);
  if (notGitRepoReason) return unavailable(notGitRepoReason);

  // Reclaim any leftover baseline worktrees from a prior interrupted run
  // before we add our own (best-effort — never fatal).
  pruneStaleWorktrees(rootDir);

  // spec 017 (Medium-High fix B9, issue #182 review) — `git worktree add`
  // never initializes submodules, so a submodule-backed repo would compute a
  // base graph missing every submodule node: everything the current graph
  // covers there would look brand-new (issue #174's failure mode, relocated
  // to submodule boundaries). Declined support, fail-closed instead of
  // silently mis-scoring (spec.md Assumptions) — still the case after
  // spec 023 (`check --base`), which generalises the base ref but not the
  // worktree mechanics (023/FR-011: the old "see #185" pointer is consumed).
  if (hasSubmodules(rootDir)) {
    return unavailable(
      "submodules are not supported by baseline diff — remove submodules or use plain check",
    );
  }

  // spec 017 (High fix B3, issue #182 review) — `git rev-parse --verify`
  // failing is NOT on its own proof of an unborn HEAD (FR-014's normal
  // pre-first-commit case): a corrupted `.git/HEAD`, a mid-rebase, or a
  // permissions problem fails the same way. Collapsing both into "empty"
  // turned an environment problem into a false-positive storm (every
  // pre-existing issue suddenly counts as "new"). classifyBaseRef tells
  // them apart.
  const refStatus = classifyBaseRef(rootDir, baseRef);
  if (refStatus === "unborn") return empty();
  if (refStatus === "error") {
    return unavailable(
      `base ref "${baseRef}" does not resolve and does not look like a normal unborn-HEAD repository (possible corrupted HEAD or repository state)`,
    );
  }

  let worktree: string | undefined;
  let trackedEntry: { rootDir: string; path: string } | undefined;
  try {
    // Fix A1 (issue #182 review) — embed this process's PID in the worktree
    // name so a future prune sweep (ours or a later run's) can tell a live
    // concurrent run's worktree apart from genuine crash residue.
    worktree = mkdtempSync(join(tmpdir(), `${WORKTREE_PREFIX}${process.pid}-`));
    trackedEntry = { rootDir, path: worktree };
    activeWorktrees.add(trackedEntry); // fix A3 — reachable by the signal handler from this point on

    execFileSync(
      "git",
      // fix B8 (issue #182 review) — disable hooks so a Husky/lefthook
      // post-checkout hook doesn't fire on every baseline scan (defeats the
      // SC-005 lazy-eval cost story and can run arbitrary install scripts).
      ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree, baseRef],
      {
        cwd: rootDir,
        // fix B1 — keep stdin out of the picture explicitly; stdout/stderr
        // stay piped so a failure's stderr is captured on the thrown error
        // (previously read as `stdio: "pipe"`, functionally equivalent but
        // made the "we deliberately don't feed this any input" intent
        // explicit here and at every other execFileSync call in this file).
        stdio: ["ignore", "pipe", "pipe"],
        // fix B9 (LFS) — skip smudge filters for the base-graph checkout;
        // `scan()` only reads text sources, never LFS-tracked binaries, so
        // fetching real blob content here is pure wasted bandwidth/latency
        // (and can itself fail under restricted egress, turning an
        // unrelated LFS hiccup into a bogus "unavailable").
        env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      },
    );
    const { graph } = scan(worktree, config);
    // Fix C2 (High, issue #182 review) — computed against `rootDir` (the
    // REAL repo, not the throwaway `worktree` checkout of `baseRef`, which
    // has no working-tree changes of its own to diff). spec 023 (FR-008):
    // when the caller already resolved a (possibly base-range-aware) map,
    // reuse that exact instance instead of recomputing.
    const effectiveRenameMap = renameMap ?? getGitRenameMap(rootDir);
    // `graph` (issue #229) — reused by `src/commands/check.ts` for `--diff`
    // scope expansion; see the `BaselineIssues.graph` JSDoc above.
    return {
      keys: collectIssueKeys(graph, currentLock, effectiveRenameMap),
      status: "computed",
      graph,
    };
  } catch (e) {
    // fix B1 (Critical, issue #182 review) — surface *why* the baseline
    // could not be built instead of a single generic "unavailable". Covers
    // mkdtemp errno, `git worktree add` failures (LFS/submodule/hook/perm),
    // and any exception `scan()` throws (malformed spec, parser crash, ...).
    debugLog("computeBaselineIssues", e);
    return unavailable(extractErrorMessage(e));
  } finally {
    if (worktree) removeWorktree(rootDir, worktree);
    if (trackedEntry) activeWorktrees.delete(trackedEntry);
  }
}

// Global (whole base graph) issue key set: drift (vs the CURRENT lock, R3),
// orphans and uncovered REQs. Test failures are intentionally excluded — they
// belong to "this test run" and can't be reconstructed from a static ref, so
// current test failures always count as new (baseline-diff.md §1.3).
// @impl 017-check-gate-baseline-diff/FR-011
//
// spec 017 (High fix C2, issue #182 review) — `orphanKey` embeds the
// orphan's `source` (`file:<path>` / `symbol:<path>#<name>`), so a pure
// `git mv old.ts new.ts` (zero content change, `@impl` tag intact) computes
// a DIFFERENT baseline key (`orphan:file:old.ts -> ...`) than the current
// side's key (`orphan:file:new.ts -> ...`, which always reflects the live
// path) — the pre-existing orphan fails to suppress and the gate
// false-positives on a pure rename (SC-004; issue #174's failure mode
// recurring on the rename path). `renameMap` (old path → new path, from
// `getGitRenameMap`) lets `normalizeOrphanSource` rewrite each BASELINE
// orphan's source onto the path the current side already uses, before its
// key is computed. The current side (src/check.ts) is never touched — it
// always reflects the live graph, so it needs no equivalent rewrite.
function collectIssueKeys(
  graph: ArtifactGraph,
  currentLock: LockFile,
  renameMap: Map<string, string> = new Map(),
): Set<string> {
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

  for (const o of findOrphans(graph)) keys.add(orphanKey(normalizeOrphanSource(o, renameMap)));
  for (const id of findUncovered(graph)) keys.add(uncoveredKey(id));

  return keys;
}

// Rewrites `o.source`'s embedded path through `renameMap` (old → new) when it
// matches a file this run's `git diff -M` reports as renamed; otherwise
// returns `o` unchanged. Handles both source shapes `findOrphans` can ever
// produce — `file:<path>` (file-mode / test sources) and
// `symbol:<path>#<name>` (symbol-mode) — since a project running in symbol
// mode hits the exact same rename false-positive. A task-sourced orphan
// never reaches here (`findOrphans` already excludes those), so no third
// prefix needs handling.
function normalizeOrphanSource(o: OrphanEdge, renameMap: Map<string, string>): OrphanEdge {
  if (renameMap.size === 0) return o; // fast path — nothing was renamed this run

  if (o.source.startsWith("file:")) {
    const path = o.source.slice("file:".length);
    const renamed = renameMap.get(path);
    return renamed === undefined ? o : { ...o, source: `file:${renamed}` };
  }

  if (o.source.startsWith("symbol:")) {
    const rest = o.source.slice("symbol:".length); // "<path>#<symbolName>"
    const hashIdx = rest.lastIndexOf("#");
    if (hashIdx === -1) return o; // malformed id — defensive no-op
    const path = rest.slice(0, hashIdx);
    const renamed = renameMap.get(path);
    if (renamed === undefined) return o;
    return { ...o, source: `symbol:${renamed}${rest.slice(hashIdx)}` };
  }

  return o;
}

// Returns a non-empty diagnostic reason when `rootDir` is not (recognisable
// as) a git repository, or `undefined` when it is. Fix B1 — replaces the old
// boolean-only `isGitRepo` so the caller can propagate the real `git`
// failure text instead of a canned message.
function detectNotGitRepoReason(rootDir: string): string | undefined {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return undefined;
  } catch (e) {
    debugLog("detectNotGitRepoReason", e);
    return extractErrorMessage(e);
  }
}

// spec 017 (Medium-High fix B9, issue #182 review). Fails OPEN (returns
// false) on a `git submodule status` error — a transient hiccup here
// shouldn't block a repo that has no submodules at all; a genuinely broken
// submodule configuration still surfaces later as a `git worktree add` /
// `scan()` failure → "unavailable" with a real diagnostic (fix B1).
function hasSubmodules(rootDir: string): boolean {
  try {
    const out = execFileSync("git", ["submodule", "status", "--recursive"], {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().length > 0;
  } catch (e) {
    debugLog("hasSubmodules", e);
    return false;
  }
}

// spec 017 (High fix B3, issue #182 review) — decide whether `baseRef`
// resolves, is a legitimate not-yet-existing ref (unborn HEAD, FR-014), or
// is unresolvable for some OTHER (environment/corruption) reason. Exported
// for direct testing of the unborn/error split.
export function classifyBaseRef(rootDir: string, baseRef: string): "resolved" | "unborn" | "error" {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "resolved";
  } catch (e) {
    debugLog("classifyBaseRef: rev-parse failed", e);
    return isUnbornHead(rootDir, baseRef) ? "unborn" : "error";
  }
}

// Only `baseRef === "HEAD"` can plausibly be "unborn" (Phase 1 always calls
// with "HEAD" — FR-002/FR-012; a named branch/tag that fails to resolve is
// never "unborn", it's simply missing, which is an `error`). Reads
// `.git/HEAD` directly rather than another `git` subprocess so a HEAD file
// that can't even be read surfaces as `error`, never a false "empty".
function isUnbornHead(rootDir: string, baseRef: string): boolean {
  if (baseRef !== "HEAD") return false;
  let headContent: string;
  try {
    headContent = readFileSync(join(rootDir, ".git", "HEAD"), "utf-8").trim();
  } catch (e) {
    debugLog("isUnbornHead: could not read .git/HEAD", e);
    return false; // unreadable → NOT confirmed unborn → classifyBaseRef returns "error"
  }
  const match = headContent.match(/^ref:\s*(refs\/heads\/.+)$/);
  if (!match) return false; // detached HEAD at a raw sha that doesn't resolve → error, not unborn
  return !existsSync(join(rootDir, ".git", match[1]));
}

// ── worktree removal (fix A2, issue #182 review) ────────────────────────────
//
// `git worktree remove --force` itself refuses to touch the main working
// tree (`fatal: '<path>' is a main working tree`). The bug this module used
// to carry: that refusal was caught by a bare `catch {}` and silently
// swallowed, falling through to an unconditional `rmSync` fallback — which
// has NO concept of "main working tree" and just deletes whatever is at
// `path`. Given the WRONG path (a stale worktree the caller `cd`'d into, a
// prune-sweep entry that coincides with a real repo, ...) that fallback
// deletes a real repository, including uncommitted work. Fixed with two
// independent guards:
//   1. `removeWorktree` parses `git worktree remove`'s stderr for "main
//      working tree" (case-insensitive) and NEVER calls `rmSync` when it
//      matches, no matter what else is going on.
//   2. The prune sweep's entry point (`reclaimDiscoveredWorktree`) requires
//      the on-disk signature of a linked worktree (`path/.git` is a regular
//      FILE, never a directory) before it will even ATTEMPT a removal —
//      a `.git` DIRECTORY at `path` means it's a fully-fledged repository
//      (possibly the main worktree itself) and must never be touched.
// The two are complementary: (1) protects every removal this module ever
// performs (including the worktree WE just created in `computeBaselineIssues`,
// whose provenance is known but is still checked out of caution), while (2)
// additionally gates the riskier "reclaim something merely discovered via
// `git worktree list`" path before git is even asked to remove it.

function isMainWorktreeError(e: unknown): boolean {
  return /main working tree/i.test(extractStderrText(e));
}

function extractStderrText(e: unknown): string {
  if (!e || typeof e !== "object") return "";
  const raw = (e as { stderr?: unknown }).stderr;
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf-8");
  return "";
}

// Removes the worktree at `path` (registered against `rootDir`'s repo).
// Safe to call on a path this process just created via `mkdtempSync` (known
// provenance — e.g. a `git worktree add` that failed part-way through and
// left no `.git` file yet must still be reclaimed here, not leaked) AND on a
// path discovered via the prune sweep, PROVIDED the caller has already
// applied the linked-worktree precondition for the latter
// (`reclaimDiscoveredWorktree`). Exported for direct testing of the
// main-worktree guard (fix A2).
export function removeWorktree(rootDir: string, path: string): void {
  try {
    execFileSync(
      "git",
      // fix B8 — see the `worktree add` call for why hooks are disabled.
      ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", path],
      { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    return;
  } catch (e) {
    if (isMainWorktreeError(e)) {
      console.error(
        `artgraph: refusing to remove "${path}" — git reports it is the main working tree; leaving it in place.`,
      );
      debugLog("removeWorktree: main-worktree guard tripped", e);
      return;
    }
    debugLog("removeWorktree: git worktree remove failed, falling back to prune + rmSync", e);
  }
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    debugLog("removeWorktree: git worktree prune fallback failed", e);
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    // fix A5 — every reclaim strategy failed; warn instead of leaking
    // silently (NFS / EBUSY / EACCES can make all three fail).
    console.error(
      `artgraph: could not reclaim leftover worktree "${path}" — run \`git worktree prune\` manually.`,
    );
    debugLog("removeWorktree: rmSync fallback failed", e);
  }
}

// `path/.git` must exist and be a regular FILE (the on-disk signature of a
// linked worktree, containing `gitdir: <...>`). A `.git` DIRECTORY means
// `path` is a fully-fledged repository — never a candidate for the
// prune sweep's destructive removal (fix A2, guard 2/2).
function looksLikeLinkedWorktree(path: string): boolean {
  try {
    return statSync(join(path, ".git")).isFile();
  } catch (e) {
    debugLog(`looksLikeLinkedWorktree(${path})`, e);
    return false;
  }
}

// Entry point used ONLY by the prune sweep (untrusted/discovered paths from
// `git worktree list`, as opposed to a path this process just created).
function reclaimDiscoveredWorktree(rootDir: string, path: string): void {
  if (!looksLikeLinkedWorktree(path)) {
    debugLog(
      `reclaimDiscoveredWorktree: skip ${path} (missing linked-worktree .git file marker)`,
      undefined,
    );
    return;
  }
  removeWorktree(rootDir, path);
}

// ── liveness / staleness helpers (fix A1, issue #182 review) ────────────────

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by someone else — we
    // can't signal it, but it IS alive; treat that as alive (fail-safe: skip
    // rather than risk destroying a concurrent run). Anything else (ESRCH —
    // no such process — or an unexpected errno) is treated as dead.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    debugLog(`isProcessAlive(${pid})`, e);
    return false;
  }
}

function isStaleByMtime(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MTIME_CUTOFF_MS;
  } catch (e) {
    debugLog(`isStaleByMtime(${path})`, e);
    return false; // can't stat → be conservative, don't claim stale
  }
}

// `candidate` is `dir` itself or nested under it (post-realpath comparison).
function isWithinDir(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

// Reclaim leftover `artgraph-baseline-` worktrees registered against this
// repo. Runs at the start of every invocation so residue from a crashed run
// can't accumulate and bloat `git worktree list` / disk.
//
// issue #182 review hardened this from a bare prefix+tmpdir substring match
// into several independent guards, each fixing a distinct failure mode found
// by adversarial review:
//   - A1: liveness (embedded PID + `process.kill(pid, 0)`) so a concurrent
//     run's OWN in-flight worktree is never treated as stale residue.
//   - A2: delegated to `reclaimDiscoveredWorktree`/`removeWorktree` — never
//     `rmSync`s anything git itself calls "a main working tree", and
//     requires the linked-worktree `.git`-file marker before even trying.
//   - A4: never touches the caller's own `cwd` or `rootDir`.
//   - A6: `realpathSync`-normalizes both sides of the tmpdir containment
//     check (raw `os.tmpdir()` vs. git's canonical listing disagree on
//     macOS/Windows/custom `TMPDIR`, which silently zeroed out the sweep).
function pruneStaleWorktrees(rootDir: string): void {
  let listing: string;
  try {
    listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    debugLog("pruneStaleWorktrees: git worktree list failed", e);
    return;
  }

  let tmpRoot: string;
  try {
    tmpRoot = realpathSync(tmpdir());
  } catch (e) {
    // A6 — nothing safe to compare against; skip the sweep this run.
    debugLog("pruneStaleWorktrees: realpathSync(tmpdir()) failed", e);
    return;
  }

  // A4 — best-effort; if these can't be resolved we simply don't get that
  // particular protection this run (the sweep still runs).
  let realCwd: string | undefined;
  try {
    realCwd = realpathSync(process.cwd());
  } catch (e) {
    debugLog("pruneStaleWorktrees: realpathSync(cwd()) failed", e);
  }
  let realRootDir: string | undefined;
  try {
    realRootDir = realpathSync(rootDir);
  } catch (e) {
    debugLog("pruneStaleWorktrees: realpathSync(rootDir) failed", e);
  }

  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const rawPath = line.slice("worktree ".length).trim();
    if (!rawPath) continue;

    let realPath: string;
    try {
      realPath = realpathSync(rawPath);
    } catch (e) {
      // A4/A6 — already gone or inaccessible: leave it to the unconditional
      // `git worktree prune` call below (metadata-only, safe).
      debugLog(`pruneStaleWorktrees: realpathSync(${rawPath}) failed`, e);
      continue;
    }

    if (!isWithinDir(realPath, tmpRoot)) continue; // not one of ours

    // A4 — never touch the caller's own cwd or the repo root, however this
    // entry was reached (e.g. the user `cd`'d into a stale leftover to
    // inspect it, then re-ran `check` from inside it).
    if (realCwd !== undefined && realPath === realCwd) continue;
    if (realRootDir !== undefined && isWithinDir(realPath, realRootDir)) continue;

    const name = basename(realPath);
    if (!name.startsWith(WORKTREE_PREFIX)) continue;

    const pidMatch = name.slice(WORKTREE_PREFIX.length).match(/^(\d+)-/);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      // A1 — never touch our own in-flight worktree, or one whose owning
      // process is still running: a concurrent `artgraph` run's worktree is
      // named identically (same repo ⇒ same prefix) and may be mid-scan
      // when this sweep runs.
      if (pid === process.pid || isProcessAlive(pid)) continue;
    } else {
      // Pre-#182 naming carried no PID — no liveness signal available. Fall
      // back to an mtime cutoff so a worktree that's merely seconds old
      // (e.g. mid-flight under an old binary) is never touched, only
      // genuine multi-day residue.
      if (!isStaleByMtime(realPath)) continue;
    }

    reclaimDiscoveredWorktree(rootDir, realPath);
  }

  try {
    execFileSync("git", ["worktree", "prune"], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    debugLog("pruneStaleWorktrees: final git worktree prune failed", e);
  }
}

// ── observability helpers (fix B1, issue #182 review) ───────────────────────
//
// Every catch block in this file is `catch (e)` and funnels through
// `debugLog`, so `ARTGRAPH_DEBUG=1` gives full visibility into every
// swallowed failure path (worktree list/add/remove/prune, git-repo/ref
// detection, submodule check, staleness checks — not just the single
// top-level "unavailable" catch). Silent by default: production runs are
// unaffected unless the env var is set.

function debugLog(context: string, e: unknown): void {
  if (process.env.ARTGRAPH_DEBUG !== "1") return;
  const detail = e instanceof Error ? (e.stack ?? e.message) : e === undefined ? "" : String(e);
  console.error(`[artgraph:debug] ${context}${detail ? `: ${detail}` : ""}`);
}

// Builds the most useful available diagnostic string from a caught
// exception: prefer captured stderr (what `git` actually said), then
// `.message`, then a last-resort `String(e)`. Always non-empty.
function extractErrorMessage(e: unknown): string {
  const stderrText = extractStderrText(e);
  if (stderrText.trim()) return stderrText.trim();
  if (e && typeof e === "object") {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const fallback = String(e).trim();
  return fallback || "unknown error";
}
