// issue #243 — lock schema version stamp (`_meta.schemaVersion`).
//
// Background: before this fix, an OLDER artgraph's `reconcile` silently
// rebuilt (and overwrote) a lock a NEWER artgraph had written — no warning,
// exit 0 — coarsening or dropping information the newer CLI produced (PR #242
// review). This file pins:
//   1. `_meta` round-trips through writeLock/readLock and never leaks into
//      entry-map consumers (readLock, rename-lock operations).
//   2. A pre-#243 lock with no `_meta` key is treated as schemaVersion 0 and
//      keeps working exactly as before.
//   3. Write paths (`reconcile`, `rename`) reject a newer-schema lock with a
//      clear error + non-zero exit, unless `--force`.
//   4. Read-only paths (`check`) warn on stderr and continue (exit unaffected
//      by the version itself).
//   5. `_meta` survives a rename's key-move (it is always re-stamped by the
//      `reconcileAfterWrite` that follows every successful rename/split/merge).
//   6. Lock byte-stability: two `writeLock` calls from the same graph are
//      byte-identical, `_meta` included.

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  readLock,
  readLockWithMeta,
  writeLock,
  buildLockFromGraph,
  assertLockSchemaWritable,
  warnIfNewerLockSchema,
  LockSchemaVersionError,
  LOCK_SCHEMA_VERSION,
} from "../src/lock.js";
import { reconcile } from "../src/scan.js";
import type { ArtifactGraph, ArtgraphConfig, GraphNode, LockFile } from "../src/types.js";
import { runAt } from "./helpers.js";

const RENAME_FIXTURE = resolve(import.meta.dirname, "fixtures/rename");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function node(id: string, kind: GraphNode["kind"]): GraphNode {
  return { id, kind, filePath: `${id}.md`, contentHash: "abc" };
}

function graph(nodes: GraphNode[]): ArtifactGraph {
  const map = new Map<string, GraphNode>();
  for (const n of nodes) map.set(n.id, n);
  return { nodes: map, edges: [] };
}

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. writeLock -> readLock round trip: `_meta` separated
// ---------------------------------------------------------------------------

describe("writeLock/readLock — _meta separation", () => {
  it("writeLock stamps _meta.schemaVersion = LOCK_SCHEMA_VERSION as the first key", () => {
    const dir = mkTmp("artgraph-lock-meta-");
    writeLock(dir, ".trace.lock", { "REQ-1": { contentHash: "x", lastReconciled: "now" } });
    const raw = JSON.parse(readFileSync(resolve(dir, ".trace.lock"), "utf-8"));
    expect(Object.keys(raw)[0]).toBe("_meta");
    expect(raw._meta).toEqual({ schemaVersion: LOCK_SCHEMA_VERSION });
    expect(raw["REQ-1"]).toEqual({ contentHash: "x", lastReconciled: "now" });
  });

  it("readLock strips _meta — it never appears as a pseudo-entry", () => {
    const dir = mkTmp("artgraph-lock-meta-");
    writeLock(dir, ".trace.lock", { "REQ-1": { contentHash: "x", lastReconciled: "now" } });
    const lock = readLock(dir, ".trace.lock");
    expect(Object.keys(lock)).toEqual(["REQ-1"]);
    expect(Object.prototype.hasOwnProperty.call(lock, "_meta")).toBe(false);
  });

  it("readLockWithMeta reports the stamped schemaVersion alongside the stripped entries", () => {
    const dir = mkTmp("artgraph-lock-meta-");
    writeLock(dir, ".trace.lock", { "REQ-1": { contentHash: "x", lastReconciled: "now" } });
    const { lock, schemaVersion } = readLockWithMeta(dir, ".trace.lock");
    expect(schemaVersion).toBe(LOCK_SCHEMA_VERSION);
    expect(Object.keys(lock)).toEqual(["REQ-1"]);
  });

  it("_meta never leaks into rename-lock's entry iteration (renameLockKey/splitLockKey/mergeLockKeys consume readLock's output)", async () => {
    const { renameLockKey } = await import("../src/rename-lock.js");
    const dir = mkTmp("artgraph-lock-meta-");
    writeLock(dir, ".trace.lock", {
      "REQ-1": { contentHash: "x", lastReconciled: "now" },
      "REQ-2": {
        contentHash: "y",
        lastReconciled: "now",
        dependsOn: [{ id: "REQ-1", provenances: ["frontmatter"] }],
      },
    });
    const lock = readLock(dir, ".trace.lock");
    const { lock: renamed } = renameLockKey(lock, "REQ-1", "REQ-1-NEW");
    // A bug that failed to strip `_meta` before readLock returned would make
    // this loop try to `updateReferences` on `_meta` itself and either crash
    // or silently corrupt it — asserting the exact key set catches both.
    expect(Object.keys(renamed).sort()).toEqual(["REQ-1-NEW", "REQ-2"]);
    expect(renamed["REQ-2"].dependsOn).toEqual([{ id: "REQ-1-NEW", provenances: ["frontmatter"] }]);
  });
});

// ---------------------------------------------------------------------------
// 1b. writeLock — reserved `_meta` entry key collision guard (F1)
// ---------------------------------------------------------------------------

describe("writeLock — `_meta` reserved-key collision guard (F1)", () => {
  it("throws instead of silently letting a bare `_meta` entry overwrite the stamp", () => {
    const dir = mkTmp("artgraph-lock-meta-collision-");
    const lock: LockFile = {
      // A real LockEntry masquerading under the reserved key — this is what
      // a `reqPatterns` match on the literal id "_meta", or a frontmatter
      // `node_id: _meta`, would produce via buildLockFromGraph.
      // @ts-expect-error - deliberately malformed input under test
      _meta: { contentHash: "x", lastReconciled: "now" },
      "REQ-1": { contentHash: "y", lastReconciled: "now" },
    };
    expect(() => writeLock(dir, ".trace.lock", lock)).toThrow(/reserved "_meta" key/);
  });

  it('buildLockFromGraph on a graph with a node literally id "_meta" produces an entry map writeLock then rejects', () => {
    const dir = mkTmp("artgraph-lock-meta-collision-");
    const g = graph([node("_meta", "req"), node("REQ-1", "req")]);
    const built = buildLockFromGraph(g);
    expect(Object.prototype.hasOwnProperty.call(built, "_meta")).toBe(true);
    expect(() => writeLock(dir, ".trace.lock", built)).toThrow(/reserved "_meta" key/);
  });

  it("reconcile() surfaces the same rejection end-to-end and does not touch the lock file", () => {
    const dir = mkTmp("artgraph-lock-meta-collision-");
    const config: ArtgraphConfig = {
      include: [],
      specDirs: [],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    expect(() => reconcile(dir, config, graph([node("_meta", "req")]), [])).toThrow(
      /reserved "_meta" key/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Legacy lock (no `_meta`) — treated as schemaVersion 0
// ---------------------------------------------------------------------------

describe("legacy lock (no _meta key) — schemaVersion 0", () => {
  it("readLockWithMeta reports schemaVersion 0 for a pre-#243 lock file", () => {
    const dir = mkTmp("artgraph-lock-legacy-");
    writeFileSync(
      resolve(dir, ".trace.lock"),
      JSON.stringify({ "REQ-1": { contentHash: "x", lastReconciled: "now" } }, null, 2) + "\n",
    );
    const { lock, schemaVersion } = readLockWithMeta(dir, ".trace.lock");
    expect(schemaVersion).toBe(0);
    expect(lock).toEqual({ "REQ-1": { contentHash: "x", lastReconciled: "now" } });
  });

  it("a missing lock file also reports schemaVersion 0", () => {
    const dir = mkTmp("artgraph-lock-legacy-");
    const { lock, schemaVersion } = readLockWithMeta(dir, ".trace.lock");
    expect(schemaVersion).toBe(0);
    expect(lock).toEqual({});
  });

  it("reconcile() on a legacy no-_meta lock succeeds and upgrades it with _meta on next write", () => {
    const dir = mkTmp("artgraph-lock-legacy-");
    writeFileSync(
      resolve(dir, ".trace.lock"),
      JSON.stringify({ "REQ-1": { contentHash: "abc", lastReconciled: "now" } }, null, 2) + "\n",
    );
    const config: ArtgraphConfig = {
      include: [],
      specDirs: [],
      testPatterns: [],
      lockFile: ".trace.lock",
    };
    expect(() => reconcile(dir, config, graph([node("REQ-1", "req")]), [])).not.toThrow();
    const raw = JSON.parse(readFileSync(resolve(dir, ".trace.lock"), "utf-8"));
    expect(raw._meta).toEqual({ schemaVersion: LOCK_SCHEMA_VERSION });
  });
});

// ---------------------------------------------------------------------------
// 2b. Malformed `_meta.schemaVersion` — warn + fall back to legacy (F2/F3)
// ---------------------------------------------------------------------------

describe("readLockWithMeta — malformed _meta.schemaVersion warns and falls back to v0 (F2/F3)", () => {
  function writeRawMeta(dir: string, metaValue: unknown): void {
    writeFileSync(
      resolve(dir, ".trace.lock"),
      JSON.stringify(
        { _meta: metaValue, "REQ-1": { contentHash: "x", lastReconciled: "now" } },
        null,
        2,
      ) + "\n",
    );
  }

  const cases: Array<[label: string, metaValue: unknown]> = [
    ["schemaVersion is a string", { schemaVersion: "1" }],
    ["schemaVersion is an array", { schemaVersion: [1] }],
    ["schemaVersion is null", { schemaVersion: null }],
    ["_meta is an empty object (no schemaVersion field)", {}],
    ["_meta is a bare string", "not-an-object"],
    ["schemaVersion is a non-integer float", { schemaVersion: 1.5 }],
    ["schemaVersion is negative", { schemaVersion: -1 }],
  ];

  it.each(cases)("warns to stderr and falls back to schemaVersion 0: %s", (_label, metaValue) => {
    const dir = mkTmp("artgraph-lock-malformed-meta-");
    writeRawMeta(dir, metaValue);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { lock, schemaVersion } = readLockWithMeta(dir, ".trace.lock");
    expect(schemaVersion).toBe(0);
    expect(lock).toEqual({ "REQ-1": { contentHash: "x", lastReconciled: "now" } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/malformed _meta\.schemaVersion/);
    spy.mockRestore();
  });

  it("does NOT warn when _meta.schemaVersion is a valid non-negative integer", () => {
    const dir = mkTmp("artgraph-lock-malformed-meta-");
    writeRawMeta(dir, { schemaVersion: 0 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { schemaVersion } = readLockWithMeta(dir, ".trace.lock");
    expect(schemaVersion).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does NOT warn when there is no `_meta` key at all (genuine legacy lock)", () => {
    const dir = mkTmp("artgraph-lock-malformed-meta-");
    writeFileSync(
      resolve(dir, ".trace.lock"),
      JSON.stringify({ "REQ-1": { contentHash: "x", lastReconciled: "now" } }, null, 2) + "\n",
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { schemaVersion } = readLockWithMeta(dir, ".trace.lock");
    expect(schemaVersion).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. assertLockSchemaWritable / warnIfNewerLockSchema (unit)
// ---------------------------------------------------------------------------

describe("assertLockSchemaWritable", () => {
  it("does not throw when schemaVersion <= LOCK_SCHEMA_VERSION", () => {
    expect(() => assertLockSchemaWritable(0, ".trace.lock", false)).not.toThrow();
    expect(() => assertLockSchemaWritable(LOCK_SCHEMA_VERSION, ".trace.lock", false)).not.toThrow();
  });

  it("throws LockSchemaVersionError when schemaVersion > LOCK_SCHEMA_VERSION and force is false", () => {
    expect(() => assertLockSchemaWritable(LOCK_SCHEMA_VERSION + 1, ".trace.lock", false)).toThrow(
      LockSchemaVersionError,
    );
  });

  it("does not throw when schemaVersion > LOCK_SCHEMA_VERSION and force is true", () => {
    expect(() =>
      assertLockSchemaWritable(LOCK_SCHEMA_VERSION + 1, ".trace.lock", true),
    ).not.toThrow();
  });

  it("F5: prints a downgrade notice to stderr when force overrides a newer schema", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertLockSchemaWritable(LOCK_SCHEMA_VERSION + 1, ".trace.lock", true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(
      new RegExp(`Downgrading lock schema v${LOCK_SCHEMA_VERSION + 1} -> v${LOCK_SCHEMA_VERSION}`),
    );
    spy.mockRestore();
  });

  it("F5: does not print a downgrade notice when force is true but schema is not newer", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    assertLockSchemaWritable(LOCK_SCHEMA_VERSION, ".trace.lock", true);
    assertLockSchemaWritable(0, ".trace.lock", true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("warnIfNewerLockSchema", () => {
  it("warns to stderr when schemaVersion > LOCK_SCHEMA_VERSION", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnIfNewerLockSchema(LOCK_SCHEMA_VERSION + 1, ".trace.lock");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/^WARNING:/);
    spy.mockRestore();
  });

  it("does not warn when schemaVersion <= LOCK_SCHEMA_VERSION", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnIfNewerLockSchema(LOCK_SCHEMA_VERSION, ".trace.lock");
    warnIfNewerLockSchema(0, ".trace.lock");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. reconcile() — the sole writeLock call site — rejects / --force overrides
// ---------------------------------------------------------------------------

describe("reconcile() write-path guard", () => {
  function futureLockDir(): string {
    const dir = mkTmp("artgraph-lock-future-");
    writeFileSync(
      resolve(dir, ".trace.lock"),
      JSON.stringify(
        {
          _meta: { schemaVersion: LOCK_SCHEMA_VERSION + 1 },
          "REQ-1": { contentHash: "abc", lastReconciled: "now" },
        },
        null,
        2,
      ) + "\n",
    );
    return dir;
  }

  const config: ArtgraphConfig = {
    include: [],
    specDirs: [],
    testPatterns: [],
    lockFile: ".trace.lock",
  };

  it("rejects with LockSchemaVersionError when the on-disk lock is newer and force is not given", () => {
    const dir = futureLockDir();
    expect(() => reconcile(dir, config, graph([node("REQ-1", "req")]), [])).toThrow(
      LockSchemaVersionError,
    );
    // Refusing to write means the on-disk lock is untouched.
    const raw = JSON.parse(readFileSync(resolve(dir, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION + 1);
  });

  it("--force (opts.force) overwrites the newer lock, downgrading _meta to this build's version", () => {
    const dir = futureLockDir();
    expect(() =>
      reconcile(dir, config, graph([node("REQ-1", "req")]), [], { force: true }),
    ).not.toThrow();
    const raw = JSON.parse(readFileSync(resolve(dir, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 5. Lock byte-stability with _meta present
// ---------------------------------------------------------------------------

describe("lock byte-stability with _meta", () => {
  it("two writeLock calls from the same buildLockFromGraph output are byte-identical", () => {
    const g = graph([node("X", "req"), node("Y", "req")]);
    const now = "2026-07-12T00:00:00.000Z";
    const real = global.Date;
    // @ts-expect-error - test stub
    global.Date = class extends real {
      constructor(...args: ConstructorParameters<typeof real>) {
        super(...(args.length === 0 ? [now] : args));
      }
      static now() {
        return real.parse(now);
      }
    };
    let lock1: LockFile;
    let lock2: LockFile;
    try {
      lock1 = buildLockFromGraph(g);
      lock2 = buildLockFromGraph(g);
    } finally {
      global.Date = real;
    }
    const dirA = mkTmp("artgraph-lock-stable-a-");
    const dirB = mkTmp("artgraph-lock-stable-b-");
    writeLock(dirA, ".trace.lock", lock1);
    writeLock(dirB, ".trace.lock", lock2);
    const bufA = readFileSync(resolve(dirA, ".trace.lock"));
    const bufB = readFileSync(resolve(dirB, ".trace.lock"));
    expect(Buffer.compare(bufA, bufB)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. CLI-level: reconcile / rename reject a newer lock, check warns
// ---------------------------------------------------------------------------

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", message],
    { cwd, stdio: "pipe" },
  );
}

async function prepareTempProject(): Promise<string> {
  const tmp = mkTmp("artgraph-lock-schema-cli-");
  cpSync(RENAME_FIXTURE, tmp, { recursive: true });
  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
  gitCommit(tmp, "init");
  // Reconcile once (the fixture's checked-in .trace.lock is a hand-authored
  // legacy shape) so we start from a real, current-schema lock.
  await runAt(tmp, ["reconcile"]);
  gitCommit(tmp, "reconcile");
  return tmp;
}

/** Rewrite the temp project's on-disk lock to claim a future schema version. */
function bumpLockToFutureVersion(tmp: string): void {
  const lockPath = resolve(tmp, ".trace.lock");
  const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
  raw._meta = { schemaVersion: LOCK_SCHEMA_VERSION + 1 };
  writeFileSync(lockPath, JSON.stringify(raw, null, 2) + "\n");
}

describe("CLI — reconcile rejects a newer-schema lock, --force overrides", () => {
  it("`artgraph reconcile` exits non-zero with a clear message on a newer-schema lock", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["reconcile"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/newer version of artgraph/i);
    // Refused write: the lock on disk still claims the future version.
    const raw = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION + 1);
  });

  it("`artgraph reconcile --force` overwrites the newer-schema lock", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["reconcile", "--force"]);
    expect(result.exitCode).toBe(0);
    const raw = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION);
  });

  // F5 (meta-review) — `--force` must not silently pass; it prints a
  // downgrade notice so the user sees what they just overrode.
  it("`artgraph reconcile --force` prints a downgrade notice to stderr", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["reconcile", "--force"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(
      new RegExp(`Downgrading lock schema v${LOCK_SCHEMA_VERSION + 1} -> v${LOCK_SCHEMA_VERSION}`),
    );
  });
});

describe("CLI — rename rejects a newer-schema lock without mutating source files, --force overrides", () => {
  it("`artgraph rename --from --to` exits non-zero and leaves source files untouched", async () => {
    const tmp = await prepareTempProject();
    const before = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["rename", "--from", "REQ-001", "--to", "REQ-099"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/newer version of artgraph/i);
    const after = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    expect(after).toBe(before);
  });

  it("`artgraph rename --force` proceeds and re-stamps _meta at this build's version", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["rename", "--from", "REQ-001", "--to", "REQ-099", "--force"]);
    expect(result.exitCode).toBe(0);
    const after = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    expect(after).toMatch(/REQ-099/);
    const raw = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION);
    // `_meta` survived the rename's key-move (REQ-001 -> REQ-099).
    expect(raw["REQ-001"]).toBeUndefined();
    expect(raw["REQ-099"]).toBeDefined();
  });

  // F5 (meta-review) — same downgrade notice as reconcile, since both funnel
  // through `assertLockSchemaWritable`.
  it("`artgraph rename --force` prints a downgrade notice to stderr", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["rename", "--from", "REQ-001", "--to", "REQ-099", "--force"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(
      new RegExp(`Downgrading lock schema v${LOCK_SCHEMA_VERSION + 1} -> v${LOCK_SCHEMA_VERSION}`),
    );
  });

  it("`artgraph rename --dry-run` is exempt from the guard (never touches the lock)", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, [
      "rename",
      "--from",
      "REQ-001",
      "--to",
      "REQ-099",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const raw = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION + 1);
  });

  // F4 (meta-review) — dry-run previously produced a silent preview from a
  // newer-schema lock while a real apply would warn/reject; it should now
  // warn just like the read-only `check` path does.
  it("`artgraph rename --dry-run` warns on stderr about the newer-schema lock", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, [
      "rename",
      "--from",
      "REQ-001",
      "--to",
      "REQ-099",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/WARNING:.*newer version of artgraph/i);
  });
});

describe("CLI — check warns on a newer-schema lock but still completes (read-only path)", () => {
  it("`artgraph check` warns on stderr and does not fail solely due to the lock schema", async () => {
    const tmp = await prepareTempProject();
    bumpLockToFutureVersion(tmp);
    const result = await runAt(tmp, ["check"]);
    expect(result.stderr).toMatch(/WARNING:.*newer version of artgraph/i);
    // The lock is untouched by a read-only command.
    const raw = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(raw._meta.schemaVersion).toBe(LOCK_SCHEMA_VERSION + 1);
  });
});
