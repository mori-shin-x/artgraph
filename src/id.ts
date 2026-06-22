import { DEFAULT_ID_TOKEN } from "./parsers/typescript.js";
import type { ReqPatternConfig } from "./types.js";

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
 */
export function isValidTargetId(id: string, codeId?: string): boolean {
  if (id.startsWith("doc:")) {
    return id.length > "doc:".length;
  }
  const token = codeId ?? DEFAULT_ID_TOKEN;
  return new RegExp(`^(?:${token})$`).test(id);
}

/**
 * Throw a descriptive error if `id` is not a valid target ID.
 */
export function assertValidTargetId(id: string, reqPatterns?: ReqPatternConfig): void {
  if (!isValidTargetId(id, reqPatterns?.codeId)) {
    throw new Error(
      `Invalid target ID "${id}": it does not match the requirement-ID format ` +
        `(e.g. "REQ-001", "auth/FR-2") or the "doc:" prefix. ` +
        `A non-conforming ID would not be re-discovered by the next scan.`,
    );
  }
}
