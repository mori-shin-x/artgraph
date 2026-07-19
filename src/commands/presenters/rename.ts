// Presenter: `rename`/`split`/`merge` result → stdout text/json. Extracted
// verbatim from `src/cli.ts` (issue #162) — no behavior change.

import type { RenameResult } from "../../rename-executor.js";
import { isSilentWarning, type BuildWarning } from "../../graph/builder.js";
import { printWarnings } from "./warnings.js";

/**
 * issue #273-2 ((a)-lite) — `postWriteWarnings` is the (already pre-write-
 * deduped) set of `BuildWarning`s the post-rename re-scan surfaced that the
 * PRE-write scan did not have. Printed as its own labeled block (stderr,
 * same stream as `buildWarnings`) so a reader can tell "this warning existed
 * before your rename" (`buildWarnings`) apart from "your rename's rewritten
 * files triggered this warning on the very next scan" (`postWriteWarnings`)
 * — e.g. a `--merge` scaffold landing in two spec files minting a fresh
 * `duplicate-id`. Filters `isSilentWarning` types first (mirrors
 * `printWarnings`'s own filtering) so an all-silent `postWriteWarnings`
 * (e.g. only `phantom-import-repaired`) does not print a heading with
 * nothing under it. A `no post-write scan ran` `undefined` (dry-run, or no
 * lock file) prints nothing, same as an empty array.
 */
function printPostWriteWarnings(postWriteWarnings: BuildWarning[] | undefined): void {
  if (!postWriteWarnings) return;
  const visible = postWriteWarnings.filter((w) => !isSilentWarning(w.type));
  if (visible.length === 0) return;
  console.error(
    "WARNING: new warnings detected by the post-rename re-scan (not necessarily caused by this rename):",
  );
  printWarnings(visible);
}

export function printRenameText(result: RenameResult) {
  if (result.changes.length === 0 && result.lockChanges.length === 0) {
    console.log("No references found.");
    // issue #265 — build warnings (pathological-bracket-nesting,
    // class-member-collision, …) matter regardless of whether this
    // particular rename found any references to rewrite.
    printWarnings(result.buildWarnings);
    printPostWriteWarnings(result.postWriteWarnings);
    return;
  }

  if (result.operation === "rename") {
    console.log(`Renamed ${result.from} → ${result.to}`);
  } else if (result.operation === "split") {
    console.log(`Split ${result.from} → ${(result.intoIds ?? []).join(", ")}`);
  } else if (result.operation === "merge") {
    console.log(`Merged ${(result.sourceIds ?? []).join(", ")} → ${result.to}`);
  }

  for (const c of result.changes) {
    const before = c.before.trim().slice(0, 60);
    const after = c.after.trim().slice(0, 60);
    console.log(`  ${c.filePath}:${c.line}  ${before} → ${after}`);
  }

  for (const w of result.warnings) {
    if (w.type === "unknown-trace-schema") {
      console.log(
        `WARNING: ${w.filePath} — unrecognized trace schema generation; left unrewritten (re-run the test suite to regenerate this trace)`,
      );
    } else if (w.type === "unreadable-file" || w.type === "system-resource-exhausted") {
      console.log(`WARNING: ${w.message}`);
    } else {
      console.log(
        `WARNING: ${w.filePath} contains @impl ${w.oldId} — manual assignment to ${w.newIds.join(", ")} needed`,
      );
    }
  }

  if (!result.applied) {
    console.log("(dry-run: no files were modified)");
  }

  // issue #265 — see the note in printRenameText's early-return branch above.
  printWarnings(result.buildWarnings);
  printPostWriteWarnings(result.postWriteWarnings);
}

export function printRenameJson(result: RenameResult) {
  console.log(JSON.stringify(result));
}
