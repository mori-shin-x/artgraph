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

/**
 * Replace references to oldId with newId in an entry's impl, tests, and dependsOn arrays.
 * Returns a new entry (does not mutate).
 */
function updateReferences(entry: LockEntry, oldId: string, newId: string): LockEntry {
  const updated = deepCopyEntry(entry);

  if (updated.impl) {
    updated.impl = updated.impl.map((ref) => (ref === oldId ? newId : ref));
  }
  if (updated.tests) {
    updated.tests = updated.tests.map((ref) => (ref === oldId ? newId : ref));
  }
  if (updated.dependsOn) {
    updated.dependsOn = updated.dependsOn.map((ref) => (ref === oldId ? newId : ref));
  }

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
 * Delete oldId and create empty entries for each newId.
 * Returns a deep copy — the input lock is not mutated.
 */
export function splitLockKey(
  lock: LockFile,
  oldId: string,
  newIds: string[],
): { lock: LockFile; changes: LockChange[] } {
  const result = deepCopyLock(lock);
  const changes: LockChange[] = [];

  if (oldId in result) {
    delete result[oldId];
    changes.push({ kind: "delete", oldKey: oldId });
  }

  for (const newId of newIds) {
    result[newId] = {
      contentHash: "",
      impl: [],
      tests: [],
      lastReconciled: new Date().toISOString(),
    };
    changes.push({ kind: "create", newKey: newId });
  }

  return { lock: result, changes };
}

/**
 * Merge multiple source entries into a single new entry.
 * Combines and deduplicates impl, tests, and dependsOn arrays.
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
  let firstFound = false;

  for (const sourceId of sourceIds) {
    if (sourceId in result) {
      const entry = result[sourceId];

      if (!firstFound) {
        contentHash = entry.contentHash;
        firstFound = true;
      }

      if (entry.impl) allImpl.push(...entry.impl);
      if (entry.tests) allTests.push(...entry.tests);
      if (entry.dependsOn) allDependsOn.push(...entry.dependsOn);

      delete result[sourceId];
    }
    changes.push({ kind: "delete", oldKey: sourceId });
  }

  const dedupe = (arr: string[]): string[] => [...new Set(arr)];

  const merged: LockEntry = {
    contentHash,
    lastReconciled: new Date().toISOString(),
  };

  const dedupedImpl = dedupe(allImpl);
  const dedupedTests = dedupe(allTests);
  const dedupedDeps = dedupe(allDependsOn);

  if (dedupedImpl.length > 0) merged.impl = dedupedImpl;
  if (dedupedTests.length > 0) merged.tests = dedupedTests;
  if (dedupedDeps.length > 0) merged.dependsOn = dedupedDeps;

  result[newId] = merged;
  changes.push({ kind: "create", newKey: newId });

  return { lock: result, changes };
}
