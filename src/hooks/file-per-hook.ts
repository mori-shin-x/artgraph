// issue #366 (scope A) — "file-per-hook" format writer: one self-contained
// hook definition file per hook (Kiro IDE `.kiro/hooks/*.kiro.hook`). Unlike
// the json-event-array format there is no merge case — the target is a
// single dedicated file, so any pre-existing entry at that path is a
// conflict, symmetric with json-event-array's "never overwrite, even with
// --force" rule (MEDIUM-2, Step 0-pre shift-left finding).

import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderTemplate } from "../template.js";
import { writeAtomic } from "./atomic-write.js";
import type { HookConfigFilePerHook, HookWriteOutcome } from "./types.js";

// See json-event-array.ts's identical constant for why `../..` from
// `src/hooks/`.
const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Write a single self-contained hook definition file. Never throws: every
 * fs / JSON / template failure is caught and converted into a structured
 * `{ action, reason?, failure? }` outcome (mirrors
 * `writeJsonEventArrayHook`'s contract).
 */
export function writeFilePerHook(
  rootDir: string,
  hookConfig: HookConfigFilePerHook,
  execPrefix: string,
): HookWriteOutcome {
  const targetPath = resolve(rootDir, hookConfig.configPath);

  // `lstatSync({ throwIfNoEntry: false })` only suppresses ENOENT — EACCES /
  // EPERM / ELOOP still throw and would escape the "never throws" contract
  // without this try/catch (mirrors json-event-array's D1 handling).
  let existingStat: ReturnType<typeof lstatSync> | undefined;
  try {
    existingStat = lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  // Any pre-existing entry — regular file, symlink, or directory — is a
  // conflict. One-file-per-hook has no merge case (unlike json-event-array's
  // Case B/C), so there is nothing safe to combine with; never overwritten,
  // even with --force (MEDIUM-2 symmetrizes this with the Claude/Codex
  // writer's Case D, which the same Step 0-pre review flagged as
  // asymmetric with Kiro's originally-drafted "--force overwrites" behavior).
  if (existingStat) {
    return {
      action: "conflict",
      reason: `${hookConfig.configPath} already exists`,
      failure: true,
    };
  }

  let rendered: string;
  try {
    const raw = readFileSync(resolve(PACKAGE_ROOT, hookConfig.templatePath), "utf-8");
    const substituted = renderTemplate(raw, { ARTGRAPH_EXEC: execPrefix });
    // LOW-1: validate the rendered template is well-formed JSON before
    // writing it — a broken template must fail loudly here rather than
    // shipping a syntactically-invalid hook file to the user's IDE.
    JSON.parse(substituted);
    rendered = substituted.replace(/\n+$/, "") + "\n";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeAtomic(targetPath, rendered);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  return { action: "created", failure: false };
}
