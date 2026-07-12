// Presenter: `rename`/`split`/`merge` result → stdout text/json. Extracted
// verbatim from `src/cli.ts` (issue #162) — no behavior change.

import type { RenameResult } from "../../rename-executor.js";
import { printWarnings } from "./warnings.js";

export function printRenameText(result: RenameResult) {
  if (result.changes.length === 0 && result.lockChanges.length === 0) {
    console.log("No references found.");
    // issue #265 — build warnings (pathological-bracket-nesting,
    // class-member-collision, …) matter regardless of whether this
    // particular rename found any references to rewrite.
    printWarnings(result.buildWarnings);
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
}

export function printRenameJson(result: RenameResult) {
  console.log(JSON.stringify(result));
}
