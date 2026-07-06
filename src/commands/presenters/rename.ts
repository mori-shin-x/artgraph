// Presenter: `rename`/`split`/`merge` result → stdout text/json. Extracted
// verbatim from `src/cli.ts` (issue #162) — no behavior change.

import type { RenameResult } from "../../rename-executor.js";

export function printRenameText(result: RenameResult) {
  if (result.changes.length === 0 && result.lockChanges.length === 0) {
    console.log("No references found.");
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
    console.log(
      `WARNING: ${w.filePath} contains @impl ${w.oldId} — manual assignment to ${w.newIds.join(", ")} needed`,
    );
  }

  if (!result.applied) {
    console.log("(dry-run: no files were modified)");
  }
}

export function printRenameJson(result: RenameResult) {
  console.log(JSON.stringify(result));
}
