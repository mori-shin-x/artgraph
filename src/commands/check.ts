// `artgraph check` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import { applyMode, pathsToEntries, resolveTestResults } from "./shared.js";
import { printWarnings } from "./presenters/warnings.js";
import { printCheckText } from "./presenters/check.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Check for drift, orphans, and uncovered REQs")
    .option("--gate", "Exit 2 on any issue (for Stop hook)")
    .option("--diff", "Scope check to files changed in git diff")
    .option("--format <format>", "Output format: json | text", "text")
    .option("--test-results <paths...>", "Test result files (Vitest JSON / JUnit XML)")
    .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const { readLock } = await import("../lock.js");
      const { check } = await import("../check.js");
      const config = applyMode(loadConfig(rootDir), opts.mode);
      const { graph, warnings } = scan(rootDir, config);
      const lock = readLock(rootDir, config.lockFile);

      const testResults = await resolveTestResults(opts, config, rootDir);

      let scopedNodeIds: Set<string> | undefined;
      if (opts.diff) {
        const { getGitDiffFiles } = await import("../diff.js");
        const { impact, resolveStartIds } = await import("../graph/traverse.js");
        const diffFiles = getGitDiffFiles(rootDir);
        if (diffFiles.length === 0) {
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
                uncovered: [],
                coverage: [],
                testFailures: [],
                pass: true,
                newIssues: { drifted: [], orphans: [], uncovered: [], testFailures: [] },
                suppressedCount: 0,
                baselineStatus: "skipped",
                warnings,
                message: "No changes detected in git diff.",
              }),
            );
          } else {
            console.log("No changes detected in git diff.");
          }
          process.exit(0);
        }
        const { startIds } = resolveStartIds(graph, pathsToEntries(diffFiles));
        if (startIds.length === 0) {
          console.log("Changed files are not tracked in the graph.");
          process.exit(0);
        }
        const impactResult = impact(graph, startIds, lock);
        scopedNodeIds = new Set([
          ...startIds,
          ...impactResult.impactReqs.map((r) => r),
          ...impactResult.affectedDocs.map((d) => d),
          ...impactResult.affectedFiles.map((f) => `file:${f}`),
        ]);
        for (const f of impactResult.affectedFiles) {
          for (const [id, node] of graph.nodes) {
            if (node.kind === "symbol" && node.filePath === f) {
              scopedNodeIds.add(id);
            }
          }
        }
      }

      // Preliminary scoped result — no baseline applied yet.
      let result = check(graph, lock, scopedNodeIds, testResults);

      // spec 017 (data-model §5, R6) — lazy baseline diff for the gate. Only
      // build the base-ref worktree when gating a diff that actually has a
      // scoped issue: a fully clean scope cannot contain any NEW issue, so the
      // worktree cost is skipped and `baselineStatus` stays "skipped" (SC-005).
      const hasScopedIssue =
        result.drifted.length > 0 ||
        result.orphans.length > 0 ||
        result.uncovered.length > 0 ||
        result.testFailures.length > 0;

      if (opts.gate && opts.diff && hasScopedIssue) {
        const { computeBaselineIssues } = await import("../baseline.js");
        // Phase 1 pins the base ref to HEAD (FR-002); the internal API already
        // takes a `baseRef` parameter so Phase 2 can expose `--base` (FR-012).
        const baseline = computeBaselineIssues(rootDir, "HEAD", lock, config);
        result = check(graph, lock, scopedNodeIds, testResults, baseline);
      }

      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, warnings }));
      } else {
        printCheckText(result);
        printWarnings(warnings);
      }

      // Exit codes (contract cli-check-gate §2): 1 = baseline undeterminable
      // (FR-010, distinct from a gate fail); 2 = a NEW issue was introduced.
      if (opts.gate && result.baselineStatus === "unavailable") {
        console.error("ERROR: could not establish a baseline (git worktree unavailable).");
        console.error("       gate result is undetermined; not treating as pass.");
        process.exit(1);
      }
      if (opts.gate && !result.pass) {
        process.exit(2);
      }
    });
}
