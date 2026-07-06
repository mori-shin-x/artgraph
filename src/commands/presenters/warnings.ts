// Presenter: `BuildWarning[]` → stderr text. Shared by `init`, `scan`, and
// `check`. Extracted verbatim from `src/cli.ts` (issue #162) — no behavior
// change.

import type { BuildWarning } from "../../graph/builder.js";

export function printWarnings(warnings: BuildWarning[]) {
  for (const w of warnings) {
    switch (w.type) {
      case "ambiguous-id": {
        const hint = w.files.length > 0 ? ` (candidates: ${w.files.join(", ")})` : "";
        console.error(`WARNING: ambiguous ID "${w.id}"${hint}`);
        break;
      }
      case "duplicate-id":
        console.error(`WARNING: duplicate ID "${w.id}" in ${w.files.join(", ")}`);
        break;
      case "orphan-doc":
        console.error(`WARNING: orphan-doc "${w.id}" referenced from ${w.files.join(", ")}`);
        break;
      case "orphan-edge":
        console.error(
          `WARNING: orphan-edge "${w.id}"${w.files.length > 0 ? ` referenced from ${w.files.join(", ")}` : ""}${w.message ? ` (${w.message})` : ""}`,
        );
        break;
      case "invalid-relation":
        console.error(
          `WARNING: invalid relation "${w.id}" in ${w.files.join(", ")}. Use "derives_from" or "depends_on"`,
        );
        break;
      case "reserved-prefix":
        console.error(`WARNING: reserved prefix in ID "${w.id}" in ${w.files.join(", ")}`);
        break;
      case "unresolved-link":
        console.error(`WARNING: unresolved-link "${w.id}" referenced from ${w.files.join(", ")}`);
        break;
      case "out-of-scope-link":
        console.error(
          `WARNING: out-of-scope-link "${w.id}" referenced from ${w.files.join(", ")} (outside specDirs)`,
        );
        break;
      case "invalid-annotation-id":
        console.error(
          `WARNING: invalid-annotation-id "${w.id}"${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
        );
        break;
      case "empty-annotation":
        console.error(
          `WARNING: empty-annotation${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
        );
        break;
      case "self-reference-annotation":
        console.error(
          `WARNING: self-reference-annotation "${w.id}"${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
        );
        break;
      default: {
        // Exhaustiveness check: if `BuildWarning.type` gains a new variant
        // without a matching case, TypeScript flags the assignment below at
        // compile time. Keeps the CLI surface in sync with the warning union.
        const _exhaustive: never = w.type;
        void _exhaustive;
      }
    }
  }
}
