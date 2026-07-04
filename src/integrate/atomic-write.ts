import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write `content` to `destPath` atomically: write to a sibling tmp file in
 * the same directory, then `rename` it onto the target. If any step fails,
 * the tmp file is removed and the target is left unchanged.
 *
 * No trailing newline is appended — callers are responsible for the final
 * byte. See contracts/integration-provider.md §副作用境界 and
 * specs/009-sdd-integration/tasks.md T006.
 */
export function atomicWriteFile(destPath: string, content: string): void {
  const dir = dirname(destPath);
  // Random suffix avoids collisions when two writers race on the same target.
  const tmpName = `.artgraph-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, tmpName);

  // Write the tmp file first. Most failures here (parent dir missing /
  // EACCES) leave nothing on disk to clean up, but a partial write (e.g.
  // ENOSPC mid-write) can leave a truncated tmp file behind — clean it up
  // before re-throwing so a failed write never leaks a stray tmp file.
  try {
    writeFileSync(tmpPath, content, "utf-8");
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* swallow: tmp may not exist */
    }
    throw e;
  }

  try {
    renameSync(tmpPath, destPath);
  } catch (e) {
    // rename failed — remove the tmp file so we don't leak it, then re-throw.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* swallow: tmp may already be gone */
    }
    throw e;
  }
}
