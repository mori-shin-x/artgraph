// PR #334 meta-review HIGH-2 — two more scan-wide "ran out of file
// descriptors" hazards graph/builder.ts did NOT guard before that fix:
//
//  1. The tsconfig.json read (builder.ts, just after `globCodeFiles`) used a
//     bare `readFileSync` guarded only by `existsSync` (which never throws,
//     but doesn't protect the read itself from EMFILE/ENFILE, or from any
//     other errno). An uncaught throw here crashed the WHOLE build — worse
//     than simply treating the repo as tsconfig-less, which the code already
//     does when the file is absent.
//  2. `globCodeFiles` (builder.ts) wraps `fast-glob`, which — unlike the
//     `glob` package the markdown loop used to call directly — THROWS on a
//     read error instead of silently returning an empty match list. An
//     uncaught throw here likewise crashed the whole build before a single
//     TS file was even enumerated.
//
// Both are guarded: EMFILE/ENFILE report the scan-wide
// `system-resource-exhausted` type (deduped against every other site that
// can report it, per the flag documented in graph/builder.ts) and the build
// continues — tsconfig-driven import resolution falls back to "no tsconfig"
// and the code-file set falls back to empty. Any OTHER glob failure (a real
// bug, not resource exhaustion) still propagates instead of being silently
// swallowed.
//
// issue #335 (Step 0-pre) closed two more gaps this file used to document as
// explicitly OUT OF SCOPE:
//
//  a. The markdown spec-file loop used to call the `glob` package's
//     `globSync` directly, which SILENTLY swallows an EMFILE/ENFILE readdir
//     failure (via path-scurry's `#readdirFail` falling into its `else`
//     branch) and returns an EMPTY match list with NO warning at all — an
//     entire specDir's REQ/task/doc nodes could vanish from the graph
//     without a trace. It now goes through `src/glob-utils.ts`'s
//     `listFilesGuarded` (shared with the TS side), which gives it the SAME
//     "warn once, continue with an empty list" treatment `globCodeFiles`
//     already had. See the "markdown-side glob" describe block below.
//  b. `src/parsers/typescript.ts`'s `createResolverContext` /
//     `readTsconfigResolveOptions` reads tsconfig.json (and its "extends"
//     chain) a SECOND, independent time — the actual TS parser's own
//     jsx/allowJs/resolveJsonModule resolution, distinct from builder.ts's
//     own cache-hash-only read at the top of this file's fixture. That read
//     is now guarded too — EMFILE/ENFILE reports the same
//     `system-resource-exhausted` type; every other errno falls back to
//     "tsconfig absent" defaults silently. See the "resolver-context
//     tsconfig read (second site)" describe block below. The `atCall`
//     mechanism on `fsFailureControl` (below) exists specifically so these
//     tests can target this SECOND read without also tripping builder.ts's
//     own (already-guarded) FIRST read.
import { afterEach, describe, expect, it, vi } from "vitest";

const fsFailureControl = vi.hoisted(() => ({
  // path suffix -> { code, atCall } — simulate failure on the Nth
  // readFileSync call matching that suffix (1-indexed; every other call
  // matching the same suffix passes through to the real implementation).
  // `atCall` lets a test target ONE specific read site among several that
  // all happen to read a file with the same suffix (e.g. tsconfig.json is
  // read once by builder.ts's own cache-hash guard, then again by the TS
  // parser's resolver context — see the module doc comment above).
  failures: new Map<string, { code: string; atCall: number }>(),
  calls: new Map<string, number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (
      ...args: Parameters<typeof actual.readFileSync>
    ): ReturnType<typeof actual.readFileSync> => {
      const path = String(args[0] ?? "");
      for (const [suffix, { code, atCall }] of fsFailureControl.failures) {
        if (path.endsWith(suffix)) {
          const n = (fsFailureControl.calls.get(suffix) ?? 0) + 1;
          fsFailureControl.calls.set(suffix, n);
          if (n === atCall) {
            const err = new Error(`simulated ${code} reading ${path}`) as NodeJS.ErrnoException;
            err.code = code;
            throw err;
          }
          break;
        }
      }
      return actual.readFileSync(...args);
    },
  };
});

const globControl = vi.hoisted(() => ({
  // when set, every fastGlob.sync() call matching `failWhen` (or every call
  // at all, when `failWhen` is unset) throws an error with this code.
  failCode: undefined as string | undefined,
  // Optional predicate to scope the failure to specific glob patterns — e.g.
  // only the markdown spec-file glob, or only the TS code-file glob — so a
  // test can pin ONE enumeration site's guard without also degrading the
  // other. Receives fast-glob's first `sync()` argument (a string or
  // string[] pattern). Undefined = fail every call (broad, "the whole
  // process is out of file descriptors" simulation).
  failWhen: undefined as ((pattern: unknown) => boolean) | undefined,
}));

function isMdPattern(pattern: unknown): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => typeof p === "string" && p.includes(".md"));
}

vi.mock("fast-glob", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("fast-glob") }>();
  const realDefault = actual.default as unknown as {
    sync: (...args: unknown[]) => string[];
  } & ((...args: unknown[]) => unknown);
  const wrapped = Object.assign(
    (...args: unknown[]) => (realDefault as (...a: unknown[]) => unknown)(...args),
    realDefault,
    {
      sync: (...args: unknown[]) => {
        if (globControl.failCode && (!globControl.failWhen || globControl.failWhen(args[0]))) {
          const err = new Error(
            `simulated ${globControl.failCode} in fast-glob.sync`,
          ) as NodeJS.ErrnoException;
          err.code = globControl.failCode;
          throw err;
        }
        return realDefault.sync(...args);
      },
    },
  );
  return { default: wrapped };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";

function makeFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-4101: needs coverage\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// @impl REQ-4101\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react" } }));
  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
  );
  return root;
}

const cfg: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: [],
  lockFile: ".trace.lock",
};

afterEach(() => {
  fsFailureControl.failures.clear();
  fsFailureControl.calls.clear();
  globControl.failCode = undefined;
  globControl.failWhen = undefined;
});

describe("buildGraph: tsconfig.json read guard (PR #334 HIGH-2, builder.ts's own cache-hash read)", () => {
  it("EMFILE reading tsconfig.json does not crash the build and reports system-resource-exhausted once", () => {
    const root = makeFixture("artgraph-tsconfig-emfile-");
    try {
      fsFailureControl.failures.set("tsconfig.json", { code: "EMFILE", atCall: 1 });

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.message).toMatch(/EMFILE/);
      expect(warnings.some((w) => w.type === "unreadable-file")).toBe(false);

      // The rest of the scan is unaffected: tsconfig.json simply falls back
      // to "not present" for import-resolution purposes, code files still
      // parse and their edges still land.
      expect(graph.nodes.has("file:src/a.ts")).toBe(true);
      expect(graph.nodes.has("REQ-4101")).toBe(true);
      const implEdge = graph.edges.find(
        (e) => e.source === "file:src/a.ts" && e.target === "REQ-4101" && e.kind === "implements",
      );
      expect(implEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-resource read error on tsconfig.json falls back to no-tsconfig with a generic warning, not a crash", () => {
    const root = makeFixture("artgraph-tsconfig-eacces-");
    try {
      fsFailureControl.failures.set("tsconfig.json", { code: "EACCES", atCall: 1 });

      const { warnings } = buildGraph(root, cfg);

      expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
      const unreadable = warnings.filter(
        (w) => w.type === "unreadable-file" && w.id === "tsconfig.json",
      );
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]!.message).toMatch(/tsconfig\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// issue #335 (Step 0-pre HIGH-2) — the SECOND, independent tsconfig.json
// read: `src/parsers/typescript.ts`'s `createResolverContext` /
// `readTsconfigResolveOptions`, consulted by the TS parser itself for
// jsx/allowJs/resolveJsonModule. This only runs when `graph/builder.ts`'s
// incremental parse cache actually needs to (re)parse a file
// (`parseTSFilePaths`, on a cache miss) — the fixture here is always a cold
// build (no prior cache), so `missPaths.length > 0` and this second read
// always happens right after builder.ts's own (already-guarded, and here
// left SUCCEEDING via `atCall: 2`) cache-hash read of the same file.
describe("buildGraph: resolver-context tsconfig read guard (issue #335 HIGH-2, second site)", () => {
  it("EMFILE on the SECOND tsconfig.json read (the parser's own resolver context) does not crash the build and reports system-resource-exhausted once", () => {
    const root = makeFixture("artgraph-tsconfig-resolver-emfile-");
    try {
      // Let builder.ts's own read (call #1) succeed; fail only the parser's
      // resolver-context read (call #2).
      fsFailureControl.failures.set("tsconfig.json", { code: "EMFILE", atCall: 2 });

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.message).toMatch(/EMFILE/);
      expect(exhausted[0]!.id).toBe("tsconfig.json");

      // Parsing itself is unaffected — jsx/allowJs/resolveJsonModule just
      // fall back to compiler defaults for this run; the code file and its
      // @impl edge still land in the graph exactly like the "no tsconfig at
      // all" case.
      expect(graph.nodes.has("file:src/a.ts")).toBe(true);
      expect(graph.nodes.has("REQ-4101")).toBe(true);
      const implEdge = graph.edges.find(
        (e) => e.source === "file:src/a.ts" && e.target === "REQ-4101" && e.kind === "implements",
      );
      expect(implEdge).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-resource read error on the SECOND tsconfig.json read falls back to tsconfig-absent defaults silently (no crash, no extra warning)", () => {
    const root = makeFixture("artgraph-tsconfig-resolver-eacces-");
    try {
      fsFailureControl.failures.set("tsconfig.json", { code: "EACCES", atCall: 2 });

      const { graph, warnings } = buildGraph(root, cfg);

      // Unlike builder.ts's OWN cache-hash read (which emits a generic
      // `unreadable-file` for any non-resource errno — see the describe
      // block above), this deeper parser-internal site deliberately stays
      // SILENT for anything other than EMFILE/ENFILE: builder.ts's own read
      // already reported the tsconfig-unreadable condition once for this
      // exact scan (this test's `atCall: 2` targeting is what isolates the
      // second site — in a REAL EACCES scenario, both reads would hit the
      // same errno and only the first would warn).
      expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
      expect(graph.nodes.has("file:src/a.ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildGraph: fast-glob (globCodeFiles) resource-exhaustion guard (PR #334 HIGH-2)", () => {
  it("EMFILE from fast-glob.sync scoped to the TS code-file glob does not crash the build, warns once, and only the code side is affected", () => {
    const root = makeFixture("artgraph-fastglob-emfile-ts-");
    try {
      globControl.failCode = "EMFILE";
      globControl.failWhen = (pattern) => !isMdPattern(pattern);

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.message).toMatch(/EMFILE/);

      // No TS file was enumerated at all — but the doc/spec side of the
      // graph (now ALSO fast-glob-backed — see issue #335 — but not scoped
      // by `failWhen` here) is unaffected.
      expect(graph.nodes.has("file:src/a.ts")).toBe(false);
      expect(graph.nodes.has("REQ-4101")).toBe(true);
      expect(graph.edges.some((e) => e.kind === "implements")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-resource fast-glob failure is NOT swallowed — it propagates", () => {
    const root = makeFixture("artgraph-fastglob-other-");
    try {
      globControl.failCode = "EPERM";

      expect(() => buildGraph(root, cfg)).toThrow(/EPERM/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// issue #335 (Step 0-pre HIGH-1) — the markdown spec-file loop's NEW guard
// (`src/glob-utils.ts`'s `listFilesGuarded`), pinning the gap this whole
// issue started from: pre-#335, the `glob` package the markdown loop called
// directly SILENTLY returned an empty match list on EMFILE/ENFILE — no
// warning, no error, the entire specDir just vanished from the graph. It now
// gets the exact same "warn once, continue empty" treatment `globCodeFiles`
// already had.
describe("buildGraph: markdown-side glob (listFilesGuarded) resource-exhaustion guard (issue #335 HIGH-1)", () => {
  it("EMFILE from fast-glob.sync scoped to the markdown spec glob does not crash the build, warns once, and only the doc/spec side is affected", () => {
    const root = makeFixture("artgraph-fastglob-emfile-md-");
    try {
      globControl.failCode = "EMFILE";
      globControl.failWhen = isMdPattern;

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.message).toMatch(/EMFILE/);
      expect(exhausted[0]!.id).toBe("glob:specs");

      // No spec file was enumerated at all — REQ-4101 never got defined —
      // but the TS/code side of the graph is unaffected.
      expect(graph.nodes.has("REQ-4101")).toBe(false);
      expect(graph.nodes.has("file:src/a.ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-resource fast-glob failure on the markdown spec glob is NOT swallowed — it propagates", () => {
    const root = makeFixture("artgraph-fastglob-md-other-");
    try {
      globControl.failCode = "EPERM";
      globControl.failWhen = isMdPattern;

      expect(() => buildGraph(root, cfg)).toThrow(/EPERM/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("EMFILE affecting BOTH the markdown and TS globs (process-wide exhaustion) still reports exactly one warning", () => {
    const root = makeFixture("artgraph-fastglob-emfile-both-");
    try {
      globControl.failCode = "EMFILE";
      // No failWhen — every fastGlob.sync() call fails, simulating a real
      // "the whole process is out of file descriptors" condition rather
      // than one call site in isolation.

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      // The markdown loop runs first in `buildGraph`, so it is the first to
      // observe (and report) the condition this scan.
      expect(exhausted[0]!.id).toBe("glob:specs");

      expect(graph.nodes.has("REQ-4101")).toBe(false);
      expect(graph.nodes.has("file:src/a.ts")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
