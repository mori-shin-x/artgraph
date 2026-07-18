// issue #335 (implementation 3) — `reconcile()` (src/scan.ts) refuses to
// write the lock file when the `warnings` array passed alongside `graph`
// carries a `system-resource-exhausted` entry: the scan that produced
// `graph` may be missing entire spec/code trees (see graph/builder.ts's
// EMFILE/ENFILE guard sites), so a lock built from it would silently
// coarsen or drop real entries. This file pins that guard directly against
// `reconcile()` (unit-level, no CLI/process involved) — see
// tests/reconcile-command-resource-exhausted.test.ts and
// tests/rename-executor-resource-exhausted.test.ts /
// tests/init-resource-exhausted.test.ts /
// tests/check-gate-resource-exhausted.test.ts for the CLI-facing call sites
// (implementation 3's `commands/reconcile.ts` / `init.ts` /
// `rename-executor.ts` and implementation 4's `check --gate`).
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { reconcile, ReconcileResourceExhaustedError } from "../src/scan.js";
import type { ArtifactGraph, ArtgraphConfig, GraphNode } from "../src/types.js";
import type { BuildWarning } from "../src/graph/builder.js";

function node(id: string, kind: GraphNode["kind"] = "req"): GraphNode {
  return { id, kind, filePath: `${id}.md`, contentHash: "abc" };
}

function graph(nodes: GraphNode[]): ArtifactGraph {
  const map = new Map<string, GraphNode>();
  for (const n of nodes) map.set(n.id, n);
  return { nodes: map, edges: [] };
}

function mkTmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

const config: ArtgraphConfig = {
  include: [],
  specDirs: [],
  testPatterns: [],
  lockFile: ".trace.lock",
};

const resourceExhaustedWarning: BuildWarning = {
  type: "system-resource-exhausted",
  id: "glob:code-files",
  files: [],
  message: "file descriptor exhaustion (EMFILE) while globbing code files during this scan",
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("reconcile(): rejects a write when warnings carries system-resource-exhausted (issue #335)", () => {
  it("throws ReconcileResourceExhaustedError and does NOT create a lock file that did not exist", () => {
    const dir = mkTmp("artgraph-reconcile-resx-new-");
    tempDirs.push(dir);
    const lockPath = resolve(dir, ".trace.lock");
    expect(existsSync(lockPath)).toBe(false);

    expect(() =>
      reconcile(dir, config, graph([node("REQ-1")]), [resourceExhaustedWarning]),
    ).toThrow(ReconcileResourceExhaustedError);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws ReconcileResourceExhaustedError and leaves an EXISTING lock file byte-identical", () => {
    const dir = mkTmp("artgraph-reconcile-resx-existing-");
    tempDirs.push(dir);
    const lockPath = resolve(dir, ".trace.lock");
    const original = JSON.stringify({ "REQ-1": { contentHash: "abc", lastReconciled: "then" } });
    writeFileSync(lockPath, original);

    expect(() =>
      reconcile(dir, config, graph([node("REQ-1")]), [resourceExhaustedWarning]),
    ).toThrow(ReconcileResourceExhaustedError);

    expect(readFileSync(lockPath, "utf-8")).toBe(original);
  });

  it("the thrown error's message mentions the lock was not touched and points at recovery", () => {
    const dir = mkTmp("artgraph-reconcile-resx-message-");
    tempDirs.push(dir);
    try {
      reconcile(dir, config, graph([node("REQ-1")]), [resourceExhaustedWarning]);
      expect.unreachable("reconcile() should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReconcileResourceExhaustedError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/not modified|NOT modified|not write/i);
      expect(msg.toLowerCase()).toContain("file-descriptor exhaustion");
    }
  });

  it("does NOT reject when warnings is empty — writes the lock normally", () => {
    const dir = mkTmp("artgraph-reconcile-resx-clean-");
    tempDirs.push(dir);
    const lockPath = resolve(dir, ".trace.lock");

    expect(() => reconcile(dir, config, graph([node("REQ-1")]), [])).not.toThrow();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("does NOT reject when warnings carries only a per-file unreadable-file entry (scan-wide condition only, not per-file)", () => {
    const dir = mkTmp("artgraph-reconcile-resx-unreadable-");
    tempDirs.push(dir);
    const lockPath = resolve(dir, ".trace.lock");
    const unreadableFileWarning: BuildWarning = {
      type: "unreadable-file",
      id: "doc:broken.md",
      files: ["specs/broken.md"],
      message: "could not read specs/broken.md (EACCES)",
    };

    expect(() =>
      reconcile(dir, config, graph([node("REQ-1")]), [unreadableFileWarning]),
    ).not.toThrow();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("--force does not bypass the rejection (no escape hatch by design — YAGNI)", () => {
    const dir = mkTmp("artgraph-reconcile-resx-force-");
    tempDirs.push(dir);

    expect(() =>
      reconcile(dir, config, graph([node("REQ-1")]), [resourceExhaustedWarning], { force: true }),
    ).toThrow(ReconcileResourceExhaustedError);
  });
});
