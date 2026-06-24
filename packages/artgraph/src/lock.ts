import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import type { LockFile, ArtifactGraph, LockEntry } from "./types.js";

// Defence-in-depth against symlinked directory components escaping the project
// root. `loadConfig` validates the lockFile path with string-only resolve/relative,
// which a symlinked parent directory can bypass. Here, just before writing, we
// realpath the (already existing) parent directory and verify it still resolves
// within the project root.
function assertWithinRoot(rootDir: string, fullPath: string): void {
  const realRoot = realpathSync(rootDir);
  const realDir = realpathSync(dirname(fullPath));
  const rel = relative(realRoot, realDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing to write lock file outside project root: ${fullPath} resolves to ${realDir}`,
    );
  }
}

export function readLock(rootDir: string, lockPath: string): LockFile {
  const fullPath = resolve(rootDir, lockPath);
  if (!existsSync(fullPath)) return {};
  try {
    return JSON.parse(readFileSync(fullPath, "utf-8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Warning: failed to parse ${fullPath}, treating as empty: ${msg}`);
    return {};
  }
}

export function writeLock(rootDir: string, lockPath: string, lock: LockFile): void {
  const fullPath = resolve(rootDir, lockPath);
  assertWithinRoot(rootDir, fullPath);
  const tmpPath = resolve(dirname(fullPath), `.${basename(fullPath)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, fullPath);
}

export function buildLockFromGraph(graph: ArtifactGraph): LockFile {
  const lock: LockFile = {};
  const now = new Date().toISOString();

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req" && node.kind !== "doc" && node.kind !== "symbol") continue;

    if (node.kind === "symbol") {
      lock[id] = { contentHash: node.contentHash, lastReconciled: now };
      continue;
    }

    const entry: LockEntry = {
      contentHash: node.contentHash,
      lastReconciled: now,
    };

    if (node.filePath) entry.specFile = node.filePath;

    // Lock baselines only track code-claim relations: `entry.impl` is meant for
    // implementation file/symbol sources and `entry.tests` for test sources.
    // `task → implements/verifies` is a planning artefact (data-model.md §7 / U2)
    // — including task IDs here would pollute drift checks and reconcile output.
    const isTaskSource = (source: string) =>
      graph.nodes.get(source)?.kind === "task";

    const implEdges = graph.edges.filter(
      (e) => e.kind === "implements" && e.target === id && !isTaskSource(e.source),
    );
    if (implEdges.length > 0) {
      entry.impl = implEdges.map((e) => e.source);
    }

    const testEdges = graph.edges.filter(
      (e) => e.kind === "verifies" && e.target === id && !isTaskSource(e.source),
    );
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
