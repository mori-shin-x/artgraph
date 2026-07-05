import { NAMESPACED_ID_TOKEN } from "./grammar/tokens.js";
import { BUILTIN_TASK_PRESETS } from "./parsers/markdown.js";
import type { ReqPatternConfig, TaskConventionPreset } from "./types.js";

// Bare ID shapes for the built-in task presets. The presets' `taskIdRe`
// embeds list-item context (`[ ]` checkbox, leading paragraph anchor), which
// is wrong for validating a bare ID like `T001` or `1.1` supplied to
// `--to`. These shapes mirror the captured group 1 of each built-in preset.
const BUILTIN_TASK_ID_SHAPES: RegExp[] = [
  /^T\d+$/, // spec-kit
  /^\d+(?:\.\d+)*$/, // kiro
];

/**
 * Validate that a target ID is one the parser could re-discover after the
 * rename/split/merge writes its references back to disk. Without this guard the
 * tool happily emits IDs like `REQ-COMBINED` or `REQ-001a` that no parser
 * regex matches, so the requirement silently vanishes from the next scan.
 *
 * Accepted forms:
 *   - `doc:<path>`           — document node IDs
 *   - the canonical req-ID token (or a project's custom `reqPatterns.codeId`)
 *     e.g. `REQ-001`, `auth/FR-2`, `Requirement-3`
 *   - built-in task ID shapes (`T001`, `1.1`, `2.3.4`) when not opted-out via
 *     `disableBuiltinTaskConventions`
 *   - any shape captured by a user-defined `taskConventions[].taskIdRe`
 *     whose full match equals `id` (with the listItem-prefix portion
 *     of the regex being optional via the user's own `(?:...)?` wrap).
 */
export function isValidTargetId(
  id: string,
  codeId?: string,
  taskConventions?: TaskConventionPreset[],
  disabledBuiltins?: string[],
): boolean {
  if (id.startsWith("doc:")) {
    return id.length > "doc:".length;
  }
  const token = codeId ?? NAMESPACED_ID_TOKEN;
  if (new RegExp(`^(?:${token})$`).test(id)) return true;

  // Built-in task shapes
  const disabled = new Set(disabledBuiltins ?? []);
  for (let i = 0; i < BUILTIN_TASK_PRESETS.length; i++) {
    if (disabled.has(BUILTIN_TASK_PRESETS[i].name)) continue;
    if (BUILTIN_TASK_ID_SHAPES[i].test(id)) return true;
  }

  // User-defined task presets — best effort: try each preset's taskIdRe and
  // accept when capture group 1 equals the full id. Users with a checkbox-
  // mandatory pattern won't pass this — they should structure their pattern as
  // `^(?:...)?(<id-shape>)\b` so a bare id can also satisfy it.
  for (const preset of taskConventions ?? []) {
    try {
      const m = id.match(new RegExp(preset.taskIdRe));
      if (m && m[1] === id) return true;
    } catch {
      // bad preset regex — already validated at loadConfig, ignore here
    }
  }

  return false;
}

/**
 * Throw a descriptive error if `id` is not a valid target ID.
 */
export function assertValidTargetId(
  id: string,
  reqPatterns?: ReqPatternConfig,
  taskConventions?: TaskConventionPreset[],
  disabledBuiltins?: string[],
): void {
  if (!isValidTargetId(id, reqPatterns?.codeId, taskConventions, disabledBuiltins)) {
    throw new Error(
      `Invalid target ID "${id}": it does not match the requirement-ID format ` +
        `(e.g. "REQ-001", "auth/FR-2"), a built-in task shape (e.g. "T001", "1.1"), ` +
        `or the "doc:" prefix. ` +
        `A non-conforming ID would not be re-discovered by the next scan.`,
    );
  }
}
