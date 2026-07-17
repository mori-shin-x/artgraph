// `artgraph reconcile` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import { reportGraphWarnings, withFatalErrors } from "./shared.js";

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
      // issue #265 — `warnings` used to be discarded here, so a
      // `pathological-bracket-nesting` / `class-member-collision` build
      // warning was invisible via `artgraph reconcile`. `reconcile` has no
      // `--format json` mode, so this always prints (mirrors scan/init/check's
      // text-mode behavior).
      //
      // issue #279 / issue #336 (meta-review F1/F4) — `reconcile` has no
      // `--format` at all, so `format` is `undefined` (text-only contract:
      // a clean one-line message on stderr, exit 1 — never a raw stack
      // trace). Pre-#336, ONLY the `scan()` call was guarded (against
      // `OxcLoadError` only): `loadConfig()` ran unguarded above it, and the
      // `reconcile()` call below had its own narrower try/catch that special-
      // cased `LockSchemaVersionError` and rethrew everything else — so both
      // a malformed `.artgraph.json` AND any OTHER `reconcile()` failure
      // (not `LockSchemaVersionError`) still produced a raw Node stack
      // trace. `withFatalErrors` now guards `loadConfig()`, `scan()`, AND
      // `reconcile()` uniformly: `LockSchemaVersionError`'s `.message` is
      // already the exact clean text the old dedicated catch printed, so
      // routing it through the generic catch-all is not a wording change,
      // just one fewer special case to maintain.
      const config = await withFatalErrors(undefined, () => loadConfig(rootDir));
      const { graph, warnings } = await withFatalErrors(undefined, () => scan(rootDir, config));
      await withFatalErrors(undefined, () =>
        reconcile(rootDir, config, graph, { force: Boolean(opts.force) }),
      );
      console.log(`Lock file updated: ${config.lockFile}`);
      reportGraphWarnings(warnings);
    });
}
