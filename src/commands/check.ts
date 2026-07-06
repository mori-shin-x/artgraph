// `artgraph check` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
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

      let scopedNodeIds: Set<string> | undefined;
      if (opts.diff) {
        const { getGitDiffFiles } = await import("../diff.js");
        const { impact, resolveStartIds } = await import("../graph/traverse.js");
        const diffFiles = getGitDiffFiles(rootDir);
        if (diffFiles.length === 0) {
          // E4: same fix as `impact --diff` — don't ignore `--format json` on
          // the "no changes" case. Shape matches the normal `check
          // --format json` output (`CheckResult` + `warnings`), just all-clear,
          // plus a `message` field flagging the no-diff short-circuit.
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
      const result = check(graph, lock, scopedNodeIds, testResults);

      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, warnings }));
      } else {
        printCheckText(result);
        printWarnings(warnings);
      }

      if (opts.gate && !result.pass) {
        process.exit(2);
      }
    });
}
