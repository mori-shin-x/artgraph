// `artgraph graph` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import type { NodeKind } from "../types.js";

export function registerGraphCommand(program: Command): void {
  program
    .command("graph")
    .description("Show the artifact graph")
    .option("--format <format>", "Output format: text | json", "text")
    .addOption(
      new Option("--kind <kind>", "Filter by node kind").choices([
        "doc",
        "req",
        "file",
        "test",
        "task",
      ]),
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const { formatGraphText, formatGraphJSON } = await import("../graph/format.js");
      const config = loadConfig(rootDir);
      const { graph } = scan(rootDir, config);

      const kindFilter = opts.kind as NodeKind | undefined;

      if (opts.format === "json") {
        console.log(formatGraphJSON(graph, kindFilter));
      } else {
        console.log(formatGraphText(graph, kindFilter));
      }
    });
}
