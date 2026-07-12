// `artgraph rename` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import type { RenameResult } from "../rename-executor.js";
import { printRenameJson, printRenameText } from "./presenters/rename.js";

export function registerRenameCommand(program: Command): void {
  program
    .command("rename")
    .description("Rename, split, or merge spec IDs across the project")
    .option("--from <id>", "Source ID to rename")
    .option("--to <id>", "Target ID for rename")
    .option("--split <id>", "Source ID to split")
    .option("--merge <ids...>", "Source IDs to merge")
    .option("--into <ids...>", "Target ID(s) for split or merge")
    .option("--dry-run", "Show changes without applying them")
    .option(
      "--force",
      "Overwrite a lock file written by a newer artgraph (lock schema version newer than this CLI supports). Ignored with --dry-run, which never touches the lock.",
    )
    .addOption(
      new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"),
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { executeRename, executeSplit, executeMerge } = await import("../rename-executor.js");
      const format: "json" | "text" = opts.format;
      const baseOpts = { dryRun: !!opts.dryRun, format, rootDir, force: !!opts.force };

      const fail = (msg: string): never => {
        // Honour --format json even on the error path so JSON consumers never
        // have to parse a plain-text line (F7).
        if (format === "json") {
          console.error(JSON.stringify({ error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      };

      try {
        let result: RenameResult;

        if (opts.from && opts.to) {
          // rename mode
          result = executeRename({ ...baseOpts, from: opts.from, to: opts.to });
        } else if (opts.split && opts.into) {
          // split mode
          result = executeSplit({ ...baseOpts, splitId: opts.split, intoIds: opts.into });
        } else if (opts.merge && opts.into) {
          // merge mode
          if (opts.into.length !== 1) {
            fail("--merge requires exactly one --into target ID.");
          }
          result = executeMerge({ ...baseOpts, mergeIds: opts.merge, intoId: opts.into[0] });
        } else {
          fail("Specify --from/--to, --split/--into, or --merge/--into.");
          return;
        }

        if (format === "json") {
          printRenameJson(result);
        } else {
          printRenameText(result);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        fail(msg);
      }
    });
}
