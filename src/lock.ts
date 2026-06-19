import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LockFile, ArtifactGraph, LockEntry } from "./types.js";

export function readLock(rootDir: string, lockPath: string): LockFile {
  const fullPath = resolve(rootDir, lockPath);
  if (!existsSync(fullPath)) return {};
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

export function writeLock(rootDir: string, lockPath: string, lock: LockFile): void {
  const fullPath = resolve(rootDir, lockPath);
  writeFileSync(fullPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

export function buildLockFromGraph(graph: ArtifactGraph): LockFile {
  const lock: LockFile = {};
  const now = new Date().toISOString();

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req" && node.kind !== "doc") continue;

    const entry: LockEntry = {
      contentHash: node.contentHash,
      lastReconciled: now,
    };

    if (node.slug) entry.slug = node.slug;

    const implEdges = graph.edges.filter((e) => e.kind === "implements" && e.target === id);
    if (implEdges.length > 0) {
      entry.impl = implEdges.map((e) => e.source);
    }

    const testEdges = graph.edges.filter((e) => e.kind === "verifies" && e.target === id);
    if (testEdges.length > 0) {
      entry.tests = testEdges.map((e) => e.source);
    }

    const depEdges = graph.edges.filter(
      (e) => (e.kind === "depends_on" || e.kind === "derives_from") && e.source === id,
    );
    if (depEdges.length > 0) {
      entry.dependsOn = depEdges.map((e) => e.target);
    }

    lock[id] = entry;
  }

  return lock;
}
