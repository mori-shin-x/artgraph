// PR #334 meta-review HIGH-2 — two more scan-wide "ran out of file
// descriptors" hazards graph/builder.ts did NOT guard before this fix:
//
//  1. The tsconfig.json read (builder.ts, just after `globCodeFiles`) used a
//     bare `readFileSync` guarded only by `existsSync` (which never throws,
//     but doesn't protect the read itself from EMFILE/ENFILE, or from any
//     other errno). An uncaught throw here crashed the WHOLE build — worse
//     than simply treating the repo as tsconfig-less, which the code already
//     does when the file is absent.
//  2. `globCodeFiles` (builder.ts) wraps `fast-glob`, which — unlike the
//     `glob` package the markdown loop uses — THROWS on a read error instead
//     of silently returning an empty match list. An uncaught throw here
//     likewise crashed the whole build before a single TS file was even
//     enumerated.
//
// Both are now guarded: EMFILE/ENFILE report the scan-wide
// `system-resource-exhausted` type (deduped against every other site that
// can report it, per the flag documented in graph/builder.ts) and the build
// continues — tsconfig-driven import resolution falls back to "no tsconfig"
// and the code-file set falls back to empty (spec/doc nodes are unaffected;
// the graph is simply empty on the code side for this one run). Any OTHER
// glob failure (a real bug, not resource exhaustion) still propagates instead
// of being silently swallowed.
//
// Scope note: `tsconfig.json` is ALSO read from a second, independent site —
// `src/parsers/typescript.ts`'s `createResolverContext` /
// `readTsconfigResolveOptions`, which the actual TS parser consults for
// jsx/allowJs/resolveJsonModule. That read is unguarded too, but it is OUT OF
// SCOPE for this fix (only builder.ts:565-566's cache-hash read was in
// scope) — a separate, pre-existing gap, not something this PR introduces or
// claims to close. The `tsconfig.json` failure mock below therefore only
// fails the FIRST readFileSync call for that path (builder.ts's own read,
// which always runs before `parseTSFilePaths`/`createResolverContext` in
// `buildGraph`'s call order) and lets every later call through untouched, so
// these tests exercise builder.ts's new guard in isolation without tripping
// over that unrelated, unguarded second site.
import { afterEach, describe, expect, it, vi } from "vitest";

const fsFailureControl = vi.hoisted(() => ({
  // path suffix -> errno code to simulate for the FIRST readFileSync call
  // matching that suffix only (see the scope note above for why this is
  // call-count-limited rather than unconditional).
  failures: new Map<string, string>(),
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
      for (const [suffix, code] of fsFailureControl.failures) {
        if (path.endsWith(suffix)) {
          const n = (fsFailureControl.calls.get(suffix) ?? 0) + 1;
          fsFailureControl.calls.set(suffix, n);
          if (n === 1) {
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
  // when set, every fastGlob.sync() call throws an error with this code
  failCode: undefined as string | undefined,
}));

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
        if (globControl.failCode) {
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
});

describe("buildGraph: tsconfig.json read guard (PR #334 HIGH-2)", () => {
  it("EMFILE reading tsconfig.json does not crash the build and reports system-resource-exhausted once", () => {
    const root = makeFixture("artgraph-tsconfig-emfile-");
    try {
      fsFailureControl.failures.set("tsconfig.json", "EMFILE");

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
      fsFailureControl.failures.set("tsconfig.json", "EACCES");

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

describe("buildGraph: fast-glob (globCodeFiles) resource-exhaustion guard (PR #334 HIGH-2)", () => {
  it("EMFILE from fast-glob.sync does not crash the build, warns once, and the graph is empty on the code side", () => {
    const root = makeFixture("artgraph-fastglob-emfile-");
    try {
      globControl.failCode = "EMFILE";

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.message).toMatch(/EMFILE/);

      // No TS file was enumerated at all — but the doc/spec side of the
      // graph, which never depends on globCodeFiles, is unaffected.
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
