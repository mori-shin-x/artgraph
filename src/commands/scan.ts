// `artgraph scan` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import { applyMode, resolveTestResults } from "./shared.js";
import { printWarnings } from "./presenters/warnings.js";

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Build the artifact graph and show summary")
    .option("--format <format>", "Output format: json | text", "text")
    .option("--test-results <paths...>", "Test result files (Vitest JSON / JUnit XML)")
    .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const config = applyMode(loadConfig(rootDir), opts.mode);
      const result = scan(rootDir, config);

      const testResults = await resolveTestResults(opts, config, rootDir);
      let testResultStats:
        | { totalTests: number; passedTests: number; failedTests: number }
        | undefined;
      if (testResults) {
        let totalTests = 0;
        let passedTests = 0;
        let failedTests = 0;
        for (const records of testResults.values()) {
          for (const r of records) {
            totalTests++;
            if (r.passed) passedTests++;
            else failedTests++;
          }
        }
        testResultStats = { totalTests, passedTests, failedTests };
      }

      if (opts.format === "json") {
        const output: Record<string, unknown> = {
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          reqCount: result.reqCount,
          docCount: result.docCount,
          fileCount: result.fileCount,
          symbolCount: result.symbolCount,
          testCount: result.testCount,
          taskCount: result.taskCount,
          warnings: result.warnings,
        };
        if (testResultStats) {
          output.testResultStats = testResultStats;
        }
        console.log(JSON.stringify(output));
      } else {
        console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
        const parts = [
          `req: ${result.reqCount}`,
          `doc: ${result.docCount}`,
          `file: ${result.fileCount}`,
        ];
        if (result.symbolCount > 0) parts.push(`symbol: ${result.symbolCount}`);
        parts.push(`test: ${result.testCount}`);
        if (result.taskCount > 0) parts.push(`task: ${result.taskCount}`);
        console.log(`  ${parts.join("  ")}`);
        if (testResultStats) {
          console.log(
            `\nTest Results: total=${testResultStats.totalTests} passed=${testResultStats.passedTests} failed=${testResultStats.failedTests}`,
          );
        }
        printWarnings(result.warnings);
      }
    });
}
