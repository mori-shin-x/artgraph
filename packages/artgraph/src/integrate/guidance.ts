/**
 * Agent-Guidance Generator — writes a Markdown steering / skills document
 * that tells an SDD tool's AI agent how to use artgraph. Used by
 * `KiroProvider` today and reserved for OpenSpec (Skills) in the future.
 *
 * Contract: specs/009-sdd-integration/contracts/agent-guidance.md
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import * as atomicWrite from "./atomic-write.js";
import type { GuidanceWriteRequest, GuidanceWriteResult } from "../types.js";

/**
 * Write `req.content` to `req.destPath` idempotently:
 *
 *  - target absent             → write, `written: true`, `hadExisting: false`
 *  - target equals content     → no-op,  `written: false`, `hadExisting: true`
 *  - target differs, force=false → no-op, `written: false`, `hadExisting: true`
 *    (caller / provider is responsible for emitting a warning)
 *  - target differs, force=true  → overwrite, `written: true`, `hadExisting: true`
 *
 * The on-disk content is always normalised to end with exactly one trailing
 * `\n`. Callers may pass content with or without a trailing newline; the
 * comparison is done against the normalised form so the round-trip is stable.
 *
 * Side effects (atomicWriteFile, mkdirSync) only happen when we have decided
 * to write. On any thrown error from the underlying disk layer we re-throw
 * without leaving partial state — atomicWriteFile handles its own tmp
 * cleanup, and a mkdir failure happens before any rename so the target is
 * untouched.
 */
export function writeGuidanceFile(req: GuidanceWriteRequest): GuidanceWriteResult {
  const { destPath, force } = req;
  const createParentDirs = req.createParentDirs !== false; // default true

  // Always write content that ends with exactly one '\n'. This makes byte-for
  // -byte comparison against a previously written file stable regardless of
  // whether the caller bothered to include a trailing newline.
  const normalised = ensureSingleTrailingNewline(req.content);

  const hadExisting = existsSync(destPath);

  if (hadExisting) {
    const current = readFileSync(destPath, "utf-8");
    if (current === normalised) {
      // byte-for-byte match → nothing to do.
      return { written: false, hadExisting: true, createdParentDirs: false };
    }
    if (!force) {
      // Differs but caller didn't ask for --force; leave disk alone. The
      // provider layer is responsible for surfacing this as a warning so the
      // user can decide whether to re-run with --force.
      return { written: false, hadExisting: true, createdParentDirs: false };
    }
    // force=true → fall through and overwrite via atomicWriteFile.
  }

  let createdParentDirs = false;
  const parent = dirname(destPath);
  if (!existsSync(parent)) {
    if (!createParentDirs) {
      // Emulate the ENOENT that fs.writeFileSync would have thrown.
      const err = new Error(`ENOENT: no such file or directory, open '${destPath}'`) as Error & {
        code?: string;
      };
      err.code = "ENOENT";
      throw err;
    }
    mkdirSync(parent, { recursive: true });
    createdParentDirs = true;
  }

  atomicWrite.atomicWriteFile(destPath, normalised);
  return { written: true, hadExisting, createdParentDirs };
}

function ensureSingleTrailingNewline(s: string): string {
  // Strip all trailing newlines, then add exactly one. Handles "", "x", "x\n",
  // "x\n\n\n" uniformly.
  const stripped = s.replace(/\n+$/, "");
  return stripped + "\n";
}
