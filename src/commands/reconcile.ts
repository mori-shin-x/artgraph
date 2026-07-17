// `artgraph reconcile` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import { reportGraphWarnings, withOxcLoadErrorFatal } from "./shared.js";

export function registerReconcileCommand(program: Command): void {
  program
    .command("reconcile")
    .description("Update the lock file to match current state")
    .option(
      "--force",
      "Overwrite a lock file written by a newer artgraph (lock schema version newer than this CLI supports)",
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("../config.js");
      const { scan, reconcile } = await import("../scan.js");
      const { LockSchemaVersionError } = await import("../lock.js");
      const config = loadConfig(rootDir);
      // issue #265 — `warnings` used to be discarded here, so a
      // `pathological-bracket-nesting` / `class-member-collision` build
      // warning was invisible via `artgraph reconcile`. `reconcile` has no
      // `--format json` mode, so this always prints (mirrors scan/init/check's
      // text-mode behavior).
      //
      // issue #279 — format-aware `OxcLoadError` handling (issue #263):
      // `reconcile` has no `--format` at all, so `format` is `undefined`
      // (text-mode diagnostic) — this action had no catch of its own before,
      // so the error used to propagate uncaught to cli.ts's top-level catch.
      const { graph, warnings } = await withOxcLoadErrorFatal(undefined, () =>
        scan(rootDir, config),
      );
      // issue #243 — a lock schema newer than this CLI understands is a hard
      // stop (not a silent coarse rebuild): print a clear, actionable error
      // and exit non-zero instead of letting the exception's raw stack
      // trace fall through commander's default handling.
      try {
        reconcile(rootDir, config, graph, { force: Boolean(opts.force) });
      } catch (e) {
        if (e instanceof LockSchemaVersionError) {
          console.error(`Error: ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
      console.log(`Lock file updated: ${config.lockFile}`);
      reportGraphWarnings(warnings);
    });
}
