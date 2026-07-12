// `artgraph reconcile` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import { reportGraphWarnings } from "./shared.js";

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Update the lock file to match current state")
    .action(async () => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan, reconcile } = await import("../scan.js");
      const config = loadConfig(rootDir);
      // issue #265 — `warnings` used to be discarded here, so a
      // `pathological-bracket-nesting` / `class-member-collision` build
      // warning was invisible via `artgraph reconcile`. `reconcile` has no
      // `--format json` mode, so this always prints (mirrors scan/init/check's
      // text-mode behavior).
      const { graph, warnings } = scan(rootDir, config);
      reconcile(rootDir, config, graph);
      console.log(`Lock file updated: ${config.lockFile}`);
      reportGraphWarnings(warnings);
    });
}
