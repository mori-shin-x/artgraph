// issue #366 (scope A) — "json-event-array" hook format writer: a single
// JSON config file keyed by event name, each event holding an array of
// `{ hooks: [...] }` groups (Claude Code `.claude/settings.json`, Codex CLI
// `.codex/hooks.json`). Generalized from the original Claude-only
// `installHooks()` Case A-D merge logic in `src/init.ts` (pre-#366) — the
// 4-case strategy itself is unchanged, only the event key and target/
// template paths are now parameterized via `HookConfigJsonEventArray`.

import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderTemplate } from "../template.js";
import { writeAtomic } from "./atomic-write.js";
import type { HookConfigJsonEventArray, HookWriteOutcome } from "./types.js";

// `templatePath` on `HookConfigJsonEventArray` is package-root relative; this
// module lives at `src/hooks/` (two levels under the package root, one more
// than `src/init.ts`), so resolve one extra `..`. Works for both
// `dist/hooks/json-event-array.js` and direct `src/hooks/json-event-array.ts`
// execution (vitest), mirroring `src/init.ts`'s `SKILLS_TEMPLATE_DIR`.
const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Merge an artgraph hook entry into a JSON config file keyed by event name,
 * following the 4-case strategy in
 * specs/012-skills-expansion/contracts/settings-merge.md:
 *   - Case A: config file absent → write the rendered template verbatim.
 *   - Case B: config exists, no `hooks` object (or non-`<event>` shape) →
 *     add `hooks.<event>`, preserving other top-level fields.
 *   - Case C: `hooks` object exists with sibling keys (e.g. `PreToolUse`) →
 *     add `hooks.<event>`, preserving the sibling keys.
 *   - Case D: a populated `hooks.<event>` array already exists → conflict,
 *     never overwritten (not even with `--force` — contract §--force
 *     フラグの扱い: this is the most sensitive user config file for the
 *     agent, and clobbering a pre-existing hook is never safe).
 *
 * Never throws: every fs / JSON / template failure is caught and converted
 * into a structured `{ action, reason?, failure? }` outcome so one agent's
 * hook-install problem never aborts the rest of `init` or a sibling agent's
 * install (`src/hooks/index.ts`'s dispatch).
 */
export function writeJsonEventArrayHook(
  rootDir: string,
  hookConfig: HookConfigJsonEventArray,
  execPrefix: string,
): HookWriteOutcome {
  // Narrow the parsed template shape so downstream lookups (Case D reason,
  // Case B/C merge) work off a single typed handle rather than repeated
  // `unknown` casts.
  type RenderedTemplate = {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  };
  let rendered: RenderedTemplate;
  try {
    const raw = readFileSync(resolve(PACKAGE_ROOT, hookConfig.templatePath), "utf-8");
    const substituted = renderTemplate(raw, { ARTGRAPH_EXEC: execPrefix });
    rendered = JSON.parse(substituted) as RenderedTemplate;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  const event = hookConfig.event;
  const configPath = resolve(rootDir, hookConfig.configPath);

  // D1: `lstatSync({ throwIfNoEntry: false })` only suppresses ENOENT —
  // EACCES / EPERM / ELOOP still throw and would escape the "never throws"
  // contract without this try/catch.
  let existingStat: ReturnType<typeof lstatSync> | undefined;
  try {
    existingStat = lstatSync(configPath, { throwIfNoEntry: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }
  // Refuse to follow/overwrite anything that isn't a regular file (symlink,
  // directory, socket, ...) — never overridden even with --force, since that
  // could clobber a file outside the agent's config tree via a malicious or
  // accidental symlink.
  if (existingStat && !existingStat.isFile()) {
    return {
      action: "io-error",
      reason: `${hookConfig.configPath} is not a regular file`,
      failure: true,
    };
  }

  // Case A: no existing config file — write the template verbatim.
  if (!existingStat) {
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeAtomic(configPath, JSON.stringify(rendered, null, 2) + "\n");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: "io-error", reason: msg, failure: true };
    }
    return { action: "created", failure: false };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }
  // Strip a leading UTF-8 BOM before parsing (same treatment as
  // package-manager.ts's packageManager-field reader).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let existing: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${hookConfig.configPath} root must be a JSON object`);
    }
    existing = parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "invalid-json", reason: msg, failure: true };
  }

  // H9: an ARRAY `hooks` field would otherwise slip past the object check
  // (`typeof [] === "object"`) — its `.<event>` is undefined, so Case D
  // would not fire and Case B/C would overwrite the array wholesale,
  // silently destroying whatever the user had encoded. Reject it up front.
  if (Array.isArray(existing.hooks)) {
    return {
      action: "invalid-json",
      reason: `${hookConfig.configPath} 'hooks' field must be an object, not an array`,
      failure: true,
    };
  }

  const existingHooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : undefined;

  // Case D: a populated hooks.<event> array already exists — never
  // overwrite, even with --force (contract §--force フラグの扱い).
  // Non-array / empty-array / null hooks.<event> are NOT conflicts and fall
  // through to Case B/C.
  const existingEvent = existingHooks?.[event];
  if (Array.isArray(existingEvent) && existingEvent.length > 0) {
    // A3: derive the reason string from the SAME `rendered` object we would
    // have written on the merge path, so it never drifts from what Cases
    // A/B/C actually write.
    const conflictCmd = rendered.hooks[event]?.[0]?.hooks[0]?.command ?? "";
    return { action: "conflict", reason: conflictCmd, failure: true };
  }

  // Case B/C: merge <event> into (possibly absent/non-object) hooks,
  // preserving any other top-level fields and any other hook keys (e.g.
  // PreToolUse). Extension point: if a template ever grows beyond one
  // event, spread rendered.hooks here instead of setting <event> alone.
  //
  // The array-hooks case was already rejected above (H9), so at this point
  // `existing.hooks` is either undefined or a plain object.
  const originalHooks = existingHooks ?? {};
  // C1: distinguish "user had a genuine sibling hook" (→ merged-c) from
  // "user had `{hooks: {<event>: []}}`" (→ merged-b). Counting <event>
  // itself would tag the latter as "other hooks preserved" — technically
  // true, but only of a placeholder we're about to overwrite.
  const hadOtherHookKeys = Object.keys(originalHooks).some((k) => k !== event);
  existing.hooks = { ...originalHooks, [event]: rendered.hooks[event] };

  try {
    writeAtomic(configPath, JSON.stringify(existing, null, 2) + "\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  return { action: hadOtherHookKeys ? "merged-c" : "merged-b", failure: false };
}
