import type { LockFile, LockEntry } from "./types.js";

export interface LockChange {
  kind: "rename" | "delete" | "create";
  oldKey?: string;
  newKey?: string;
}

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
 * Replace references to oldId with newId in an entry's impl, tests, and dependsOn arrays.
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
    updated.dependsOn = dedupe(updated.dependsOn.map((ref) => (ref === oldId ? newId : ref)));
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
  updated.dependsOn = expandRef(updated.dependsOn, oldId, newIds);
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
  const allDependsOn: string[] = [];
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
      if (entry.dependsOn) allDependsOn.push(...entry.dependsOn);

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
  const dedupedDeps = dedupe(allDependsOn).filter((d) => !sourceSet.has(d) && d !== newId);

  if (dedupedImpl.length > 0) merged.impl = dedupedImpl;
  if (dedupedTests.length > 0) merged.tests = dedupedTests;
  if (dedupedDeps.length > 0) merged.dependsOn = dedupedDeps;

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
