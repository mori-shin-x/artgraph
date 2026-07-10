// `artgraph check` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import type { ArtifactGraph, CheckResult } from "../types.js";
import { pathsToEntries, resolveTestResults } from "./shared.js";
import { printWarnings } from "./presenters/warnings.js";
import { printCheckText } from "./presenters/check.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Check for drift, orphans, and uncovered REQs")
    .option("--gate", "Exit 2 on any issue (for Stop hook)")
    .option("--diff", "Scope check to files changed in git diff")
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const { readLock } = await import("../lock.js");
      const { check } = await import("../check.js");
      const config = loadConfig(rootDir);
      const { graph, warnings } = scan(rootDir, config);
      const lock = readLock(rootDir, config.lockFile);

      const testResults = await resolveTestResults(config, rootDir);

      let result: CheckResult;
      if (opts.diff) {
        const { getGitDiffFiles } = await import("../diff.js");
        const { impact, resolveStartIds } = await import("../graph/traverse.js");
        const { computeBaselineIssues } = await import("../baseline.js");
        const diffFiles = getGitDiffFiles(rootDir);
        if (diffFiles.length === 0) {
          // spec 017 (Critical fix E1, issue #182 review) — in CI the checked-
          // out working tree already matches the commit under test, so `git
          // diff` (staged+unstaged+untracked) is empty on essentially every
          // run regardless of what the PR actually changed. Without a `--base
          // <ref>` (Phase 2, issue #185) the gate silently no-ops right here:
          // it exits 0 looking like "nothing to check" when it never actually
          // compared anything. Warn (exit code stays 0 — this is not a gate
          // failure) so CI logs surface the gap instead of a green check that
          // checked nothing. No FR covers this directly (issue #182 review
          // finding, not an original spec 017 requirement) — see issue #185
          // for the tracked Phase 2 follow-up that actually closes the gap.
          const isCI = process.env.CI === "true" || process.env.CI === "1";
          const ciWarning =
            "WARNING: gate is not active in CI without --base <ref> (Phase 2 — see #185).";
          if (isCI) console.error(ciWarning);

          // E4: same fix as `impact --diff` — don't ignore `--format json` on
          // the "no changes" case. Shape matches the normal `check
          // --format json` output (`CheckResult` + `warnings`), just all-clear,
          // plus a `message` field flagging the no-diff short-circuit. spec 017
          // adds the baseline-diff fields so the shape never depends on the
          // presence of a diff (baselineStatus "skipped" = no baseline built).
          if (opts.format === "json") {
            console.log(
              JSON.stringify({
                drifted: [],
                orphans: [],
                orphanNodeIds: [],
                uncovered: [],
                coverage: [],
                testFailures: [],
                pass: true,
                newIssues: { drifted: [], orphans: [], uncovered: [], testFailures: [] },
                suppressedCount: 0,
                baselineStatus: "skipped",
                warnings: isCI ? [...warnings, ciWarning] : warnings,
                message: "No changes detected in git diff.",
              }),
            );
          } else {
            console.log("No changes detected in git diff.");
          }
          process.exit(0);
        }
        const entries = pathsToEntries(diffFiles);
        const { startIds: currentStartIds } = resolveStartIds(graph, entries);

        // issue #229 — eager baseline for `--diff`. This used to be a lazy
        // R6/SC-005 optimization (only build the base-ref worktree when the
        // CURRENT-graph scope already had an issue), but that made the gate
        // fail-open on a diff that DELETES the only `@impl`/`@verifies` edge
        // to a REQ: removing the edge from the current graph makes the REQ
        // unreachable from the changed file, so it never entered scope and
        // `hasScopedIssue` was false — the baseline worktree was never even
        // built. The baseline is now always computed for `--diff` and its
        // graph is reused below to also compute scope on the BASELINE side,
        // so a REQ reachable via an edge that exists on EITHER side of the
        // diff still lands in scope. Correctness over SC-005's perf win.
        // Phase 1 pins the base ref to HEAD (FR-002); the internal API
        // already takes a `baseRef` parameter so Phase 2 can expose `--base`
        // (FR-012).
        const baseline = computeBaselineIssues(rootDir, "HEAD", lock, config);
        const baselineGraph = baseline.graph;
        const baselineStartIds = baselineGraph
          ? resolveStartIds(baselineGraph, entries).startIds
          : [];

        // "Not tracked in the graph" only when NEITHER side resolves a
        // startId. Checking only the current graph (pre-#229 behavior) would
        // wrongly take this early exit for e.g. a deleted file whose sole
        // `@impl` claim needs to surface as newly-uncovered: the file is gone
        // from the current graph but still resolves against the baseline.
        if (currentStartIds.length === 0 && baselineStartIds.length === 0) {
          // spec 017 (Critical fix D1, issue #182 review) — same E4-style gap
          // as the `diffFiles.length === 0` branch above: `--format json` was
          // silently ignored here, breaking a CI/Skill consumer piping `check
          // --diff --format json` into `jq` whenever every changed file sits
          // outside the graph. `baselineStatus:"skipped"` because this IS a
          // `--diff` run (not a plain check) whose scope trivially carries
          // zero issues — nothing resolved to a startId at all.
          if (opts.format === "json") {
            console.log(
              JSON.stringify({
                drifted: [],
                orphans: [],
                uncovered: [],
                coverage: [],
                testFailures: [],
                pass: true,
                newIssues: { drifted: [], orphans: [], uncovered: [], testFailures: [] },
                suppressedCount: 0,
                baselineStatus: "skipped",
                warnings,
                message: "Changed files are not tracked in the graph.",
              }),
            );
          } else {
            console.log("Changed files are not tracked in the graph.");
          }
          process.exit(0);
        }

        // Reduces a resolved start-id set to a scope (start ids + impact
        // reach) on a given graph. Shared by the current-graph and
        // baseline-graph passes below so the two sides can never drift on
        // how a startId set is expanded into scope.
        const buildScope = (g: ArtifactGraph, sids: string[]): Set<string> => {
          const r = impact(g, sids, lock);
          const s = new Set<string>([
            ...sids,
            ...r.impactReqs,
            ...r.affectedDocs,
            ...r.affectedFiles.map((f) => `file:${f}`),
          ]);
          for (const f of r.affectedFiles) {
            for (const [id, node] of g.nodes) {
              if (node.kind === "symbol" && node.filePath === f) s.add(id);
            }
          }
          return s;
        };

        // spec 017 US2 AS3 (issue #229) — union the scope computed on the
        // CURRENT graph with the scope computed on the BASELINE graph. An
        // `@impl`/`@verifies` edge (or a spec REQ line) deleted by the diff
        // is gone from `graph` but still present in `baselineGraph`, so the
        // REQ it pointed at still enters scope from the baseline side even
        // though the current-side BFS can no longer reach it.
        // @impl 017-check-gate-baseline-diff/US2-AS3
        const currentScope = buildScope(graph, currentStartIds);
        const baselineScope = baselineGraph
          ? buildScope(baselineGraph, baselineStartIds)
          : new Set<string>();
        const scopedNodeIds = new Set([...currentScope, ...baselineScope]);

        // One `check()` call: baseline is already available (computed
        // eagerly above), so there is no more "preliminary, then maybe
        // rebuild with baseline" two-phase call. `diffRequested` (spec 017
        // Critical fix B6/D2) stays `true` here regardless — it exists so
        // `check()` can tell a `--diff` run apart from a plain check when
        // `baseline` is omitted, which no longer happens on this path but
        // the signal is kept for parity with the non-diff branch below.
        result = check(graph, lock, scopedNodeIds, testResults, baseline, true);
      } else {
        result = check(graph, lock, undefined, testResults, undefined, false);
      }

      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, warnings }));
      } else {
        printCheckText(result, { diff: !!opts.diff, gate: !!opts.gate });
        printWarnings(warnings);
      }

      // spec 017 (contract cli-check-gate §4.4 / §4.5, §3 note) — baseline
      // undeterminable. Never silently pass (FR-010): with `--gate` this is a
      // dedicated exit 1 (distinct from a gate fail's exit 2); without `--gate`
      // it is display-only, so warn on stderr and exit 0.
      // @impl 017-check-gate-baseline-diff/FR-010
      if (result.baselineStatus === "unavailable") {
        if (opts.gate) {
          console.error("ERROR: could not establish a baseline (git worktree unavailable).");
          console.error("       gate result is undetermined; not treating as pass.");
          process.exit(1);
        }
        console.error("WARNING: could not establish a baseline; showing all issues without");
        console.error("         new/pre-existing distinction.");
      }

      // Exit code 2 (contract §2): `--gate` and a NEW issue was introduced.
      if (opts.gate && !result.pass) {
        process.exit(2);
      }
    });
}
