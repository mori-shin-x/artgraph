// Presenter: `BuildWarning[]` → stderr text. Shared by `init`, `scan`, and
// `check`. Extracted verbatim from `src/cli.ts` (issue #162) — no behavior
// change.

import { isSilentWarning, type BuildWarning } from "../../graph/builder.js";

export function printWarnings(warnings: BuildWarning[]) {
  for (const w of warnings) {
    // issue #189 — observability warnings (`phantom-import-repaired`,
    // `dangling-import`) stay out of the default stderr stream; a repo
    // with lots of star re-exports would otherwise get noisy. They are
    // still emitted into `scan --format json` `warnings[]` for tooling.
    if (isSilentWarning(w.type)) continue;
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
      // PR #242 review A/C — symbol-mode class-member id collision. Shown by
      // default (NOT in SILENT_WARNING_TYPES): a collision silently rewires
      // which symbol a tag attributes to, which the author should see. The
      // parser-built message carries the full context (colliding id, winner,
      // re-attribution note), so print it verbatim with the id as fallback.
      case "class-member-collision":
        console.error(
          `WARNING: ${w.message ?? `class-member-collision "${w.id}" in ${w.files.join(", ")}`}`,
        );
        break;
      // issue #247 — pathological bracket-nesting guard skipped AST-based
      // extraction for a file. Shown by default (NOT in SILENT_WARNING_TYPES):
      // the file's symbols/imports are missing from the graph (text-scanned
      // `@impl` / `[REQ-…]` tags are NOT affected — extractImplTags is a
      // regex scan independent of the AST), which the author needs to see.
      // The parser-built message carries the file, observed depth, and
      // threshold, so print it verbatim with the id as fallback.
      case "pathological-bracket-nesting":
        console.error(
          `WARNING: ${w.message ?? `pathological-bracket-nesting "${w.id}" in ${w.files.join(", ")}`}`,
        );
        break;
      // issue #264 — a file that could not be read at all (e.g. a
      // permission error). Shown by default (NOT in SILENT_WARNING_TYPES):
      // the file's symbols/imports/@impl edges are missing from the graph
      // until it becomes readable again, which the author needs to see. The
      // parser-built message carries the file and the underlying I/O error,
      // so print it verbatim with the id as fallback.
      case "unreadable-file":
        console.error(
          `WARNING: ${w.message ?? `unreadable-file "${w.id}" in ${w.files.join(", ")}`}`,
        );
        break;
      // issue #295 — file descriptor exhaustion (EMFILE/ENFILE) hit while
      // reading a file during the scan. Shown by default (NOT in
      // SILENT_WARNING_TYPES): this is a system-level problem the user
      // needs to act on (raise the ulimit), unlike the two silent types
      // below. `graph/builder.ts` already collapses every occurrence in one
      // scan down to a single warning, so this case only ever prints once.
      case "system-resource-exhausted":
        console.error(
          `WARNING: ${w.message ?? `system-resource-exhausted "${w.id}" in ${w.files.join(", ")}`}`,
        );
        break;
      // issue #287 — the include/testPatterns globs matched a file under
      // node_modules. Shown by default (NOT in SILENT_WARNING_TYPES): the
      // builder-provided message already carries the count and the
      // `!**/node_modules/**` config fix, so print it verbatim with the
      // file list as fallback.
      case "node-modules-in-scan":
        console.error(`WARNING: ${w.message ?? `node-modules-in-scan (${w.files.join(", ")})`}`);
        break;
      // Filtered above via `isSilentWarning`, but the switch still needs
      // cases so the exhaustiveness check below stays happy.
      case "phantom-import-repaired":
      case "dangling-import":
      // issue #333 — silent, same rationale as the two types above (see
      // `BuildWarning["type"]`'s doc comment in graph/builder.ts).
      case "unresolved-reexport":
      case "unresolved-import":
      // issue #356 — silent: a config-shape check that fires on EVERY scan of
      // an asymmetric config regardless of whether node_modules even exists
      // in the project, so showing it by default would be high-noise (see
      // `BuildWarning["type"]`'s doc comment in graph/builder.ts). Still
      // observable via `scan --format json` `warnings[]`.
      case "config-pool-protection-asymmetry":
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
