// `artgraph rename` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import type { RenameResult } from "../rename-executor.js";
// `OxcLoadError` is ALSO statically imported, unconditionally, by cli.ts's
// own top-level catch (issue #263) — every real CLI invocation already pays
// this module's (cheap, native-binding-free at import time — see
// parsers/typescript.ts's own doc comment) load cost regardless of which
// command runs, so importing it here too adds no new cost. `rename-executor.js`
// stays a LAZY (`await import`) dependency below, unlike this — it pulls in
// the whole scan/graph-builder stack, which the lazy-import refactor
// (issue #162) deliberately keeps out of every command module's static
// imports so `artgraph --help` doesn't pay for it.
import { OxcLoadError } from "../parsers/typescript.js";
import type { BuildWarning } from "../graph/builder.js";
import { printRenameJson, printRenameText } from "./presenters/rename.js";
import { printWarnings } from "./presenters/warnings.js";

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
      const { executeRename, executeSplit, executeMerge, RenameValidationError } =
        await import("../rename-executor.js");
      const format: "json" | "text" = opts.format;
      const baseOpts = { dryRun: !!opts.dryRun, format, rootDir, force: !!opts.force };

      // issue #273-1 — `warnings` is the pre-write scan's `BuildWarning[]`
      // carried by a `RenameValidationError` (undefined on every other error
      // path — there's nothing to attach). json: folded into the SAME
      // `{"error": ...}` envelope as a `warnings` field (F7's original
      // contract stays byte-identical when there are none — the field is
      // simply omitted, not `[]`). text: printed via `printWarnings` (stderr)
      // BEFORE the `Error: ...` line, mirroring `printRenameText`'s existing
      // success-path convention of always surfacing `buildWarnings`.
      const fail = (msg: string, warnings?: BuildWarning[]): never => {
        // Honour --format json even on the error path so JSON consumers never
        // have to parse a plain-text line (F7).
        if (format === "json") {
          const envelope: { error: string; warnings?: BuildWarning[] } = { error: msg };
          if (warnings && warnings.length > 0) envelope.warnings = warnings;
          console.error(JSON.stringify(envelope));
        } else {
          if (warnings && warnings.length > 0) printWarnings(warnings);
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

        // PR #339 meta-review (F2) — `postWriteWarnings` carrying
        // `system-resource-exhausted` means the post-write re-scan
        // (`reconcileAfterWrite`) refused to update the lock (see
        // `ReconcileResourceExhaustedError` in `../scan.js`): the rewrite
        // itself succeeded (files on disk already reflect the rename), but
        // the lock — which `artgraph check` immediately compares against —
        // was left stale, pointing at the OLD id. Updating the lock is a
        // core part of `rename`'s contract (unlike `init`, where the FIRST
        // lock write is a nice-to-have bootstrap step, not something anything
        // downstream already depends on being current — see the contrasting
        // comment in `../init.ts` near its own `ReconcileResourceExhaustedError`
        // handling), so this is a genuine partial success: `process.exitCode`
        // (not an immediate `process.exit`) is set to 1 so both `--format
        // json` and `--format text` still finish printing their full,
        // unchanged output (the JSON shape is untouched — this only affects
        // the process exit code) before the process exits non-zero.
        if (result.postWriteWarnings?.some((w) => w.type === "system-resource-exhausted")) {
          process.exitCode = 1;
        }
      } catch (e) {
        // issue #279 — `OxcLoadError` (oxc-parser's native binding missing/
        // broken, issue #263) is an environment failure, not a
        // validation/IO problem about THIS rename. `.message` is already a
        // complete, formatted diagnostic (see parsers/typescript.ts), so
        // it's printed bare in text mode (no "Error:" prefix — matches
        // cli.ts's own pre-existing top-level handling of the same error)
        // and wrapped in the same envelope shape as every other fatal error
        // here in json mode. See docs/commands.md's fatal-error contract.
        if (e instanceof OxcLoadError) {
          if (format === "json") {
            console.error(JSON.stringify({ error: e.message }));
          } else {
            console.error(e.message);
          }
          process.exit(1);
        }
        // issue #273-1 — a validation/safety-valve throw from
        // rename-executor.ts now carries the pre-write scan's
        // buildWarnings; surface them via `fail` instead of the pre-fix
        // behavior of extracting only `e.message` and discarding the rest.
        if (e instanceof RenameValidationError) {
          fail(e.message, e.buildWarnings);
        }
        const msg = e instanceof Error ? e.message : String(e);
        fail(msg);
      }
    });
}
