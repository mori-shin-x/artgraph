// `artgraph reconcile` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import { applyMode } from "./shared.js";

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Update the lock file to match current state")
    .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan, reconcile } = await import("../scan.js");
      const config = applyMode(loadConfig(rootDir), opts.mode);
      const { graph } = scan(rootDir, config);
      reconcile(rootDir, config, graph);
      console.log(`Lock file updated: ${config.lockFile}`);
    });
}
