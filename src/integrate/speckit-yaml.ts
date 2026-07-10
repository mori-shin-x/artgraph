/**
 * Comment-preserving editor for `.specify/extensions.yml`.
 *
 * Uses the eemeli/yaml Document API so existing comments, key order, and
 * blank lines survive `parse → modify → serialize`. All write-back to disk
 * happens through {@link atomicWriteFile} (callers are responsible for
 * disk I/O — this module is pure CST manipulation).
 *
 * Contract: specs/009-sdd-integration/contracts/speckit-extension-schema.md §2
 */
import { Document, isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import type { Pair } from "yaml";
import { validateHookEntry } from "./schemas/speckit-1.0.js";
import type { HookEntry, HookTrigger } from "../types.js";

/** Parse the raw YAML text into a Document we can mutate. */
export function parseExtensionsYaml(text: string): Document.Parsed {
  return parseDocument(text);
}

/**
 * Serialize the Document back to YAML text. Always ends with exactly one
 * trailing newline (POSIX convention).
 */
export function serializeExtensionsYaml(doc: Document.Parsed | Document): string {
  // Spec Kit's .specify/extensions.yml convention uses non-indented block
  // sequences (`- foo` flush with the key) and 2-space mapping indent. We
  // match that style so round-trips don't reformat unrelated lines.
  let out = doc.toString({ indent: 2, indentSeq: false, lineWidth: 0 });
  // Document.toString() normally appends a trailing newline; guard against
  // edge cases where the source was missing one or had multiple.
  out = out.replace(/\n*$/, "\n");
  return out;
}

/**
 * Ensure `installed:` exists as a sequence and append `id` to it. Returns
 * true when the list was actually mutated, false when `id` was already
 * present (idempotent).
 */
export function addInstalled(doc: Document, id: string): boolean {
  let seq = doc.get("installed");
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set("installed", seq);
  }
  // Always emit block style so `installed:` reads as a multi-line list rather
  // than the flow-style `[a, b]` form (the latter can leak in when the parent
  // node was originally a flow scalar like `{}` / `[]`).
  (seq as YAMLSeq).flow = false;
  const existing = (seq as YAMLSeq).items.map(scalarValue);
  if (existing.includes(id)) {
    return false;
  }
  (seq as YAMLSeq).add(id);
  return true;
}

/**
 * Remove `id` from `installed:`. Returns true on mutation, false when `id`
 * was already absent.
 */
export function removeInstalled(doc: Document, id: string): boolean {
  const seq = doc.get("installed");
  if (!isSeq(seq)) return false;
  const items = (seq as YAMLSeq).items;
  const idx = items.findIndex((it) => scalarValue(it) === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  return true;
}

/**
 * Add or replace a hook entry under `hooks.<trigger>`. Existing entries
 * belonging to OTHER extensions are preserved verbatim. If an entry from
 * the same extension already exists:
 *   - if its content equals `entry` → no-op (returns false)
 *   - otherwise → replace it (returns true)
 *
 * Returns true when the document was mutated.
 */
export function addHookEntry(doc: Document, trigger: HookTrigger, entry: HookEntry): boolean {
  validateHookEntry(entry);

  let hooks = doc.get("hooks");
  if (!isMap(hooks)) {
    hooks = new YAMLMap();
    doc.set("hooks", hooks);
  }
  // Force block style on the hooks map. When the source was `hooks: {}` (an
  // empty flow map), yaml will otherwise inherit the parent flow style and
  // serialize the new entries as `hooks: { after_tasks: [ { ... } ] }` on a
  // single line. That violates Spec Kit convention and would also make `git
  // diff` unreadable.
  (hooks as YAMLMap).flow = false;

  let arr = (hooks as YAMLMap).get(trigger);
  if (!isSeq(arr)) {
    arr = new YAMLSeq();
    (hooks as YAMLMap).set(trigger, arr);
  }
  // Same reasoning as above: ensure the trigger sequence is block-style so
  // each hook entry appears on its own line.
  (arr as YAMLSeq).flow = false;

  const seq = arr as YAMLSeq;
  const existingIdx = seq.items.findIndex((it) => extensionOf(it) === entry.extension);
  const newNode = doc.createNode(entry);
  // The new entry map itself must also be block style so its keys (extension,
  // command, ...) appear on separate lines.
  if (isMap(newNode)) {
    (newNode as YAMLMap).flow = false;
  }

  if (existingIdx === -1) {
    seq.add(newNode);
    return true;
  }

  // Compare existing-as-plain-object to the incoming entry.
  const existing = seq.items[existingIdx];
  const existingPlain = isMap(existing) ? (existing.toJSON() as HookEntry) : undefined;
  if (existingPlain && hookEntryEquals(existingPlain, entry)) {
    return false;
  }
  seq.items[existingIdx] = newNode;
  return true;
}

/**
 * Return true when `hooks.<trigger>` already contains an entry belonging to
 * `extensionId` (regardless of its command/flags). Used by the speckit
 * provider to avoid clobbering a previously chosen `before_implement`
 * variant (issue #217: the default install only adds the non-blocking
 * preview hook when artgraph has no entry yet).
 */
export function hasHookEntry(doc: Document, trigger: HookTrigger, extensionId: string): boolean {
  const hooks = doc.get("hooks");
  if (!isMap(hooks)) return false;
  const arr = (hooks as YAMLMap).get(trigger);
  if (!isSeq(arr)) return false;
  return (arr as YAMLSeq).items.some((it) => extensionOf(it) === extensionId);
}

/**
 * Remove the entry under `hooks.<trigger>` whose `extension` field matches
 * `extensionId`. Other entries are preserved. Returns true on mutation.
 *
 * If the trigger array becomes empty after removal, it is deleted entirely
 * to keep the file clean.
 */
export function removeHookEntry(doc: Document, trigger: HookTrigger, extensionId: string): boolean {
  const hooks = doc.get("hooks");
  if (!isMap(hooks)) return false;
  const arr = (hooks as YAMLMap).get(trigger);
  if (!isSeq(arr)) return false;
  const seq = arr as YAMLSeq;
  const before = seq.items.length;
  seq.items = seq.items.filter((it) => extensionOf(it) !== extensionId);
  const removed = seq.items.length !== before;
  if (removed && seq.items.length === 0) {
    (hooks as YAMLMap).delete(trigger);
  }
  return removed;
}

/**
 * Walk every `hooks.<trigger>` array and strip out any entry belonging to
 * artgraph. Returns the list of triggers from which entries were
 * removed (deduplicated, in document order). Convenience for uninstall.
 */
export function removeAllArtgraphHooks(doc: Document): HookTrigger[] {
  const hooks = doc.get("hooks");
  if (!isMap(hooks)) return [];
  const triggers: HookTrigger[] = [];
  // Snapshot keys because we mutate the map during iteration.
  const keys = (hooks as YAMLMap).items.map((p: Pair) => scalarValue(p.key) as HookTrigger);
  for (const trig of keys) {
    if (removeHookEntry(doc, trig, "artgraph")) {
      triggers.push(trig);
    }
  }
  return triggers;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scalarValue(node: unknown): unknown {
  if (isScalar(node)) return node.value;
  return node;
}

function extensionOf(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const v = (node as YAMLMap).get("extension");
  if (isScalar(v)) return String(v.value);
  if (typeof v === "string") return v;
  return undefined;
}

function hookEntryEquals(a: HookEntry, b: HookEntry): boolean {
  return (
    a.extension === b.extension &&
    a.command === b.command &&
    a.enabled === b.enabled &&
    a.optional === b.optional &&
    a.priority === b.priority &&
    a.prompt === b.prompt &&
    a.description === b.description &&
    a.condition === b.condition
  );
}
