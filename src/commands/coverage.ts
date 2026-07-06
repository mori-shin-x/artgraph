// `artgraph coverage` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import { applyMode, resolveTestResults } from "./shared.js";
import { printCoverageJson, printCoverageText } from "./presenters/coverage.js";

export function registerCoverageCommand(program: Command): void {
  program
    .command("coverage")
    .description("Show coverage status for each requirement")
    .addOption(
      new Option("--format <format>", "Output format: json | text")
        .choices(["json", "text"])
        .default("text"),
    )
    .option("--test-results <paths...>", "Test result files (Vitest JSON / JUnit XML)")
    .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const { computeCoverage } = await import("../coverage.js");
      const config = applyMode(loadConfig(rootDir), opts.mode);
      const { graph } = scan(rootDir, config);

      const testResults = await resolveTestResults(opts, config, rootDir);
      const entries = computeCoverage(graph, testResults);

      if (opts.format === "json") {
        printCoverageJson(entries);
      } else {
        printCoverageText(entries);
      }
    });
}
