// `artgraph check` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import type { ArtifactGraph, CheckResult } from "../types.js";
import type { BaselineIssues } from "../baseline.js";
import { pathsToEntries, resolveTestResults } from "./shared.js";
import { printWarnings } from "./presenters/warnings.js";
import { printCheckText } from "./presenters/check.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Check for drift, orphans, and uncovered REQs")
    .option("--gate", "Exit 2 on any issue (for Stop hook)")
    .option("--diff", "Scope check to files changed in git diff")
    .option(
      "--ignore <csv>",
      "Comma-separated REQ-IDs to drop from newIssues.uncovered (one-shot; not persisted). See issue #178.",
      "",
    )
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();

      // issue #178 — one-shot escape hatch, mirrors `plan-coverage --ignore`.
      // Parse before the `--diff` branch so the WARNING below can fire on the
      // plain-check path too. Empty entries are dropped silently so
      // `--ignore ""` or trailing commas don't generate spurious IDs.
      const ignoreUncoveredIds = new Set(
        ((opts.ignore as string) ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
      if (ignoreUncoveredIds.size > 0 && !opts.diff) {
        console.error("WARNING: --ignore is only effective with --diff; ignoring.");
      }
      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const { readLockWithMeta, warnIfNewerLockSchema } = await import("../lock.js");
      const { check } = await import("../check.js");
      const config = loadConfig(rootDir);
      const { graph, warnings } = scan(rootDir, config);
      // issue #243 — `check` is read-only w.r.t. the lock: a newer-schema
      // lock is still readable (unknown fields are simply invisible), so
      // warn and keep going rather than fail like the write paths do.
      const { lock, schemaVersion } = readLockWithMeta(rootDir, config.lockFile);
      warnIfNewerLockSchema(schemaVersion, config.lockFile);

      const testResults = await resolveTestResults(config, rootDir);

      // spec 020 (contracts/cli-surface.md §4, FR-010〜015) — cheap glob-only
      // existence probe first (mirrors `src/commands/trace.ts`'s Phase A
      // precedent): a trace-absent project must reach `check()` WITHOUT the
      // 7th argument at all, not with an empty/zero-cost `IngestedTrace`, so
      // `CheckResult` never gains the new optional keys (FR-010 byte-identical).
      const { hasTraceShards, ingestTrace } = await import("../trace/ingest.js");
      let traceOptions: import("../check.js").TraceCheckOptions | undefined;
      if (hasTraceShards(config, rootDir)) {
        const { computeStaleNodeIds } = await import("../trace/report.js");
        const trace = ingestTrace(config, rootDir);
        traceOptions = {
          trace,
          staleNodeIds: computeStaleNodeIds(graph, trace),
          acceptExercises: config.trace?.acceptExercises ?? false,
          staleness: config.trace?.staleness ?? "warn",
          sharedThreshold: config.trace?.sharedThreshold,
        };
      }

      let result: CheckResult;
      if (opts.diff) {
        const { getGitDiffFiles, getGitRenameMap, getHeadTrackedPaths } =
          await import("../diff.js");
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
                newIssues: {
                  drifted: [],
                  orphans: [],
                  uncovered: [],
                  testFailures: [],
                },
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

        // issue #229 review — rename-aware baseline entry resolution: a diff
        // that renames a file AND deletes its sole @impl edge in the same
        // change resolves only the NEW path via getGitDiffFiles; the
        // baseline graph only knows the OLD path, so translate through
        // git's rename detection so the baseline side still resolves.
        const renameMap = getGitRenameMap(rootDir);
        const inverseRenameMap = new Map<string, string>();
        for (const [oldPath, newPath] of renameMap) inverseRenameMap.set(newPath, oldPath);
        const baselineEntries = entries.map((e) => {
          const oldPath = inverseRenameMap.get(e.path);
          return oldPath === undefined ? e : { ...e, path: oldPath };
        });

        // issue #229 — eager baseline for `--diff`. This used to be a lazy
        // R6/SC-005 optimization (only build the base-ref worktree when the
        // CURRENT-graph scope already had an issue), but that made the gate
        // fail-open on a diff that DELETES the only `@impl`/`@verifies` edge
        // to a REQ: removing the edge from the current graph makes the REQ
        // unreachable from the changed file, so it never entered scope and
        // `hasScopedIssue` was false — the baseline worktree was never even
        // built. The baseline is now (subject to the skip check just below)
        // computed for `--diff` and its graph is reused below to also
        // compute scope on the BASELINE side, so a REQ reachable via an edge
        // that exists on EITHER side of the diff still lands in scope.
        // Correctness over SC-005's perf win. Phase 1 pins the base ref to
        // HEAD (FR-002); the internal API already takes a `baseRef`
        // parameter so Phase 2 can expose `--base` (FR-012).
        //
        // issue #229 review (Finding 2) — the fully-unconditional eager
        // baseline above regressed the case where the diff touches only
        // files outside the graph entirely (e.g. an untracked README): the
        // baseline `git worktree add` + `scan()` (~2-3s) ran and was then
        // immediately discarded by the "not tracked" early exit below,
        // ~5x'ing that case's latency versus pre-#229. `getHeadTrackedPaths`
        // is a cheap probe (`git ls-tree -r HEAD`, no worktree) for whether
        // any diff path was ever tracked at HEAD; if NONE were (and the
        // current graph resolved nothing, and no diff path is a rename
        // NEW-path), the baseline graph could not possibly resolve a
        // startId either, so building it would only be thrown away. Building
        // is still the default whenever there's any chance it's needed —
        // this only ever skips work that would provably go unused.
        const headTrackedPaths = getHeadTrackedPaths(
          rootDir,
          entries.map((e) => e.path),
        );
        const anyBaselineResolvable =
          currentStartIds.length > 0 ||
          headTrackedPaths.size > 0 ||
          entries.some((e) => inverseRenameMap.has(e.path));

        let baseline: BaselineIssues | undefined;
        let baselineGraph: ArtifactGraph | undefined;
        let baselineStartIds: string[] = [];
        if (anyBaselineResolvable) {
          baseline = computeBaselineIssues(rootDir, "HEAD", lock, config);
          baselineGraph = baseline.graph;
          baselineStartIds = baselineGraph
            ? resolveStartIds(baselineGraph, baselineEntries).startIds
            : [];
        }

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
                newIssues: {
                  drifted: [],
                  orphans: [],
                  uncovered: [],
                  testFailures: [],
                },
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
        // above, subject to the Finding 2 skip check), so there is no more
        // "preliminary, then maybe rebuild with baseline" two-phase call.
        // `baseline` can only be `undefined` here when `anyBaselineResolvable`
        // was false, which forces `baselineStartIds` to stay `[]` — and since
        // that condition also requires `currentStartIds` to be empty, the
        // "not tracked" early exit above always fires first, so this line
        // never actually runs with `baseline === undefined`.
        // `diffRequested` (spec 017 Critical fix B6/D2) stays `true` here
        // regardless — it exists so `check()` can tell a `--diff` run apart
        // from a plain check when `baseline` is omitted, kept for parity
        // with the non-diff branch below.
        result = check(graph, lock, scopedNodeIds, testResults, baseline, true, traceOptions);
      } else {
        result = check(graph, lock, undefined, testResults, undefined, false, traceOptions);
      }

      // issue #178 — apply `--ignore` only for `--diff` runs: plain `check`
      // has no `newIssues` concept for it to act on. Rebuild `result` rather
      // than mutating in place so `pass` is re-derived consistently (a
      // baseline-`"unavailable"` run must stay non-passing regardless of
      // what `--ignore` drops).
      if (ignoreUncoveredIds.size > 0 && opts.diff) {
        // PR #250 review — the INFO line below must list only the IDs that
        // ACTUALLY suppressed something (intersection of `--ignore` with the
        // pre-filter `newIssues.uncovered`), NOT the raw requested set. A
        // typo'd or misspelled ID in the CSV would otherwise appear in the
        // "suppressed" list even though it never matched anything, defeating
        // the diagnostic purpose of the message.
        const actuallySuppressed = result.newIssues.uncovered.filter((id) =>
          ignoreUncoveredIds.has(id),
        );
        const filteredUncovered = result.newIssues.uncovered.filter(
          (id) => !ignoreUncoveredIds.has(id),
        );
        result = {
          ...result,
          newIssues: { ...result.newIssues, uncovered: filteredUncovered },
          pass:
            result.baselineStatus === "unavailable"
              ? false
              : result.newIssues.drifted.length === 0 &&
                result.newIssues.orphans.length === 0 &&
                filteredUncovered.length === 0 &&
                result.newIssues.testFailures.length === 0,
        };
        if (actuallySuppressed.length > 0) {
          console.error(
            `INFO: --ignore suppressed ${actuallySuppressed.length} REQ(s) from newIssues.uncovered: ${[...actuallySuppressed].sort().join(", ")}`,
          );
        }
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

      // spec 020 (FR-015, contracts/cli-surface.md §4) — `trace.staleness:
      // "gate"` composes with `--gate` as an INDEPENDENT failure class from
      // spec 017's baseline-diff gate above: stale evidence isn't part of the
      // new-vs-pre-existing baseline model (it has no baseline concept at
      // all), so it gets its own exit-2 check rather than folding into
      // `pass`/`newIssues`. `warn` (default) and `exclude` never set
      // `staleGate`, so this is a no-op for them regardless of `--gate`.
      if (opts.gate && result.staleGate) {
        process.exit(2);
      }
    });
}
