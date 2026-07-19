// issue #366 (scope A) — atomic single-target-file write, shared by both
// hook writers (`json-event-array.ts` / `file-per-hook.ts`). Extracted
// verbatim (semantics unchanged) from the local `writeAtomic` closure inside
// the original Claude-only `installHooks()` in `src/init.ts` (pre-#366).

import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Write `content` to `targetPath` atomically: write to a FIXED-name sibling
 * `<targetPath>.tmp`, then `rename` it onto the target. Fixed (not a random
 * suffix like `src/integrate/atomic-write.ts`'s general-purpose helper)
 * because a hook writer only ever targets ONE well-known config file per
 * call, and the pre-existing-`.tmp` cleanup below depends on knowing that
 * name up front. `tests/hooks/json-event-array.test.ts`'s
 * "writeAtomic .tmp cleanup on failure" / symlink-preplant cases pin this
 * exact naming + cleanup contract (ported from `tests/hooks-merge.test.ts`).
 *
 * Any pre-existing `<targetPath>.tmp` — including a symlink an attacker
 * planted at that predictable path — is unlinked before writing:
 * `unlinkSync` removes the symlink itself, not its target, so the
 * subsequent `writeFileSync` always lands on a fresh regular file. On
 * failure (write or rename), the `.tmp` is removed again (best-effort) so a
 * partial write never lingers on disk, and the original error is rethrown
 * for the caller to convert into a structured `io-error` outcome.
 */
export function writeAtomic(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp`;
  try {
    unlinkSync(tmpPath);
  } catch {
    // no stale tmp file — expected happy path
  }
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup — nothing to remove or a lower-level failure
    }
    throw e;
  }
}
