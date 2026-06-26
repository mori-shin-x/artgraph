import type { LockFile, LockEntry, EdgeProvenance } from "./types.js";

export interface LockChange {
  kind: "rename" | "delete" | "create";
  oldKey?: string;
  newKey?: string;
}

type DepRef = { id: string; provenances: EdgeProvenance[] };

function isSymbolKey(key: string): boolean {
  return key.startsWith("symbol:");
}

function deepCopyLock(lock: LockFile): LockFile {
  return JSON.parse(JSON.stringify(lock));
}

function deepCopyEntry(entry: LockEntry): LockEntry {
  return JSON.parse(JSON.stringify(entry));
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function sortDeps(deps: DepRef[]): DepRef[] {
  return [...deps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Union dependsOn entries by `id`: collapse duplicates, set-union their
// `provenances`, and emit a single sorted array. Mirrors the dedup union in
// builder.ts so the lock-level shape matches the graph-level invariants.
// Exported so `buildLockFromGraph` (lock.ts) can apply the same id-based
// union when the same target appears under both `depends_on` and
// `derives_from` (review C4).
export function unionDeps(deps: DepRef[]): DepRef[] {
  const byId = new Map<string, Set<EdgeProvenance>>();
  for (const d of deps) {
    let provs = byId.get(d.id);
    if (!provs) {
      provs = new Set();
      byId.set(d.id, provs);
    }
    for (const p of d.provenances) provs.add(p);
  }
  const result: DepRef[] = [];
  for (const [id, provs] of byId) {
    result.push({ id, provenances: [...provs].sort() });
  }
  return sortDeps(result);
}

/**
 * Replace each `oldId` element of `arr` with every entry of `newIds`
 * (one-to-many expansion), preserving order and de-duplicating.
 */
function expandRef(arr: string[] | undefined, oldId: string, newIds: string[]): string[] | undefined {
  if (!arr) return arr;
  const out: string[] = [];
  for (const ref of arr) {
    if (ref === oldId) out.push(...newIds);
    else out.push(ref);
  }
  return dedupe(out);
}

/**
 * Replace each `dependsOn` entry whose `id === oldId` with N copies that share
 * the same `provenances` (one-to-many expansion), preserving order and merging
 * collisions via set-union of `provenances`.
 */
function expandDepRef(
  arr: DepRef[] | undefined,
  oldId: string,
  newIds: string[],
): DepRef[] | undefined {
  if (!arr) return arr;
  const out: DepRef[] = [];
  for (const ref of arr) {
    if (ref.id === oldId) {
      for (const nid of newIds) {
        out.push({ id: nid, provenances: [...ref.provenances] });
      }
    } else {
      out.push({ id: ref.id, provenances: [...ref.provenances] });
    }
  }
  return unionDeps(out);
}

/**
 * Replace references to oldId with newId in an entry's impl, tests, and dependsOn arrays.
 * `dependsOn` is the schema-v2 `{id, provenances}` form (issue #35) — only the
 * `id` field is rewritten; the `provenances` array is preserved verbatim.
 * Returns a new entry (does not mutate).
 */
function updateReferences(entry: LockEntry, oldId: string, newId: string): LockEntry {
  const updated = deepCopyEntry(entry);

  if (updated.impl) {
    updated.impl = dedupe(updated.impl.map((ref) => (ref === oldId ? newId : ref)));
  }
  if (updated.tests) {
    updated.tests = dedupe(updated.tests.map((ref) => (ref === oldId ? newId : ref)));
  }
  if (updated.dependsOn) {
    const rewritten = updated.dependsOn.map((ref) =>
      ref.id === oldId ? { id: newId, provenances: [...ref.provenances] } : { ...ref },
    );
    updated.dependsOn = unionDeps(rewritten);
  }

  return updated;
}

/**
 * Expand references to oldId into newIds across an entry's reference arrays.
 */
function expandReferences(entry: LockEntry, oldId: string, newIds: string[]): LockEntry {
  const updated = deepCopyEntry(entry);
  updated.impl = expandRef(updated.impl, oldId, newIds);
  updated.tests = expandRef(updated.tests, oldId, newIds);
  updated.dependsOn = expandDepRef(updated.dependsOn, oldId, newIds);
  return updated;
}

/**
 * Move a lock entry from oldId to newId, updating all cross-references.
 * Returns a deep copy — the input lock is not mutated.
 */
export function renameLockKey(
  lock: LockFile,
  oldId: string,
  newId: string,
): { lock: LockFile; changes: LockChange[] } {
  if (!(oldId in lock)) {
    return { lock: deepCopyLock(lock), changes: [] };
  }

  const result = deepCopyLock(lock);
  const changes: LockChange[] = [];

  // Move the entry from oldId to newId
  result[newId] = result[oldId];
  delete result[oldId];
  changes.push({ kind: "rename", oldKey: oldId, newKey: newId });

  // Scan all non-symbol entries and update cross-references
  for (const key of Object.keys(result)) {
    if (isSymbolKey(key)) continue;
    result[key] = updateReferences(result[key], oldId, newId);
  }

  return { lock: result, changes };
}

/**
 * Delete oldId and create empty entries for each newId. References to oldId in
 * *other* entries are expanded to all newIds so the graph stays valid (C2).
 * Returns a deep copy — the input lock is not mutated.
 */
export function splitLockKey(
  lock: LockFile,
  oldId: string,
  newIds: string[],
): { lock: LockFile; changes: LockChange[] } {
  const result = deepCopyLock(lock);
  const changes: LockChange[] = [];

  const sourceSpecFile = result[oldId]?.specFile;

  if (oldId in result) {
    delete result[oldId];
    changes.push({ kind: "delete", oldKey: oldId });
  }

  for (const newId of newIds) {
    const entry: LockEntry = {
      contentHash: "",
      impl: [],
      tests: [],
      lastReconciled: new Date().toISOString(),
    };
    if (sourceSpecFile) entry.specFile = sourceSpecFile;
    result[newId] = entry;
    changes.push({ kind: "create", newKey: newId });
  }

  // Expand references to the split ID across every other entry.
  for (const key of Object.keys(result)) {
    if (isSymbolKey(key) || newIds.includes(key)) continue;
    result[key] = expandReferences(result[key], oldId, newIds);
  }

  return { lock: result, changes };
}

/**
 * Merge multiple source entries into a single new entry. Combines and
 * deduplicates impl, tests and dependsOn, preserves specFile (H5), updates
 * references to any source ID in *other* entries to point at newId (C2), and
 * drops self-references in the merged entry.
 * Returns a deep copy — the input lock is not mutated.
 */
export function mergeLockKeys(
  lock: LockFile,
  sourceIds: string[],
  newId: string,
): { lock: LockFile; changes: LockChange[] } {
  const result = deepCopyLock(lock);
  const changes: LockChange[] = [];

  const allImpl: string[] = [];
  const allTests: string[] = [];
  const allDependsOn: DepRef[] = [];
  let contentHash = "";
  let specFile: string | undefined;
  let firstFound = false;

  for (const sourceId of sourceIds) {
    if (sourceId in result) {
      const entry = result[sourceId];

      if (!firstFound) {
        contentHash = entry.contentHash;
        specFile = entry.specFile;
        firstFound = true;
      }
      if (specFile === undefined && entry.specFile) specFile = entry.specFile;

      if (entry.impl) allImpl.push(...entry.impl);
      if (entry.tests) allTests.push(...entry.tests);
      if (entry.dependsOn) {
        for (const d of entry.dependsOn) {
          allDependsOn.push({ id: d.id, provenances: [...d.provenances] });
        }
      }

      delete result[sourceId];
    }
    changes.push({ kind: "delete", oldKey: sourceId });
  }

  const sourceSet = new Set(sourceIds);
  const merged: LockEntry = {
    contentHash,
    lastReconciled: new Date().toISOString(),
  };
  if (specFile) merged.specFile = specFile;

  const dedupedImpl = dedupe(allImpl);
  const dedupedTests = dedupe(allTests);
  // A merged requirement must not depend on its own former parts or on itself.
  // Provenances are set-unioned per `id` (issue #35 lock schema v2).
  const unionedDeps = unionDeps(allDependsOn).filter((d) => !sourceSet.has(d.id) && d.id !== newId);

  if (dedupedImpl.length > 0) merged.impl = dedupedImpl;
  if (dedupedTests.length > 0) merged.tests = dedupedTests;
  if (unionedDeps.length > 0) merged.dependsOn = unionedDeps;

  result[newId] = merged;
  changes.push({ kind: "create", newKey: newId });

  // Repoint references to any source ID in other entries to newId.
  for (const key of Object.keys(result)) {
    if (isSymbolKey(key) || key === newId) continue;
    let entry = result[key];
    for (const sourceId of sourceIds) {
      if (sourceId === newId) continue;
      entry = updateReferences(entry, sourceId, newId);
    }
    result[key] = entry;
  }

  return { lock: result, changes };
}
