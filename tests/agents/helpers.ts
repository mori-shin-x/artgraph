// spec 013 T002 — test fixture helpers shared by tests/agents/*.test.ts.
// Provides three primitives that every cross-agent test needs:
//   1. createFreshProject() — disposable empty tmp dir
//   2. readDistributedTree() — recursive walk that returns relPath + sha256 hex
//   3. injectMarkerBlock() — append an artgraph-managed block to a file (for
//      marker-aware tests that need a pre-populated fixture)
//
// These helpers stay framework-agnostic on purpose (no vitest imports) so they
// can also be used from e2e or perf suites later.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export interface FreshProject {
  /** Absolute path to the newly created tmp dir. */
  dir: string;
  /** Best-effort recursive cleanup. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Create a unique empty tmp dir. Naming includes a 4-byte random suffix so
 * concurrent tests don't collide even when `mkdtempSync`'s 6-char `XXXXXX`
 * placeholder happens to be reused across pids.
 */
export function createFreshProject(): FreshProject {
  const prefix = join(tmpdir(), `artgraph-spec013-${randomBytes(4).toString("hex")}-`);
  const dir = mkdtempSync(prefix);
  let cleaned = false;
  return {
    dir,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; tests must not fail on cleanup errors
      }
    },
  };
}

export interface DistributedTreeSnapshot {
  /**
   * Repo-root-relative POSIX paths of every regular file under `dir`, sorted
   * deterministically so callers can compare snapshots directly.
   */
  paths: string[];
  /** Map: relPath -> sha256 hex of the file contents. */
  sha256: Record<string, string>;
}

/**
 * Walk `dir` recursively and return a deterministic snapshot of every regular
 * file under it. Hidden entries (leading dot) at the top level are kept — a
 * spec 013 distribution lands under `.claude/skills/`, `.agents/skills/`, etc.,
 * all of which start with a dot.
 */
export function readDistributedTree(dir: string): DistributedTreeSnapshot {
  if (!existsSync(dir)) {
    return { paths: [], sha256: {} };
  }
  const collected: string[] = [];
  walk(dir, collected);
  collected.sort();
  const sha256: Record<string, string> = {};
  for (const abs of collected) {
    sha256[toPosix(relative(dir, abs))] = hashFile(abs);
  }
  return {
    paths: collected.map((abs) => toPosix(relative(dir, abs))),
    sha256,
  };
}

/**
 * Append an artgraph-managed block (HTML-comment marker pair) to `file`,
 * creating the file (and parent dirs) when needed. Used by tests that need
 * a pre-existing wrapper file to assert idempotent replacement behavior.
 *
 * The marker format mirrors R2 (`<!-- artgraph:begin -->` / `<!-- artgraph:end -->`)
 * so production code and test fixtures stay in sync.
 */
export function injectMarkerBlock(file: string, body: string): void {
  const parent = file.includes("/") ? file.substring(0, file.lastIndexOf("/")) : "";
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const block = `\n<!-- artgraph:begin -->\n${body}\n<!-- artgraph:end -->\n`;
  if (existsSync(file)) {
    appendFileSync(file, block, "utf-8");
  } else {
    writeFileSync(file, block, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function walk(current: string, out: string[]): void {
  for (const entry of readdirSync(current)) {
    const full = join(current, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
}

function hashFile(abs: string): string {
  const buf = readFileSync(abs);
  return createHash("sha256").update(buf).digest("hex");
}

function toPosix(p: string): string {
  return p.split(/\\|\//).join("/");
}
