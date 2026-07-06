// `artgraph reconcile` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Update the lock file to match current state")
    .action(async () => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan, reconcile } = await import("../scan.js");
      const config = loadConfig(rootDir);
      const { graph } = scan(rootDir, config);
      reconcile(rootDir, config, graph);
      console.log(`Lock file updated: ${config.lockFile}`);
    });
}
