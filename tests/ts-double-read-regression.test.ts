// PR #334 meta-review HIGH-1 — regression test for the asymmetric-read /
// parse-cache-poisoning bug.
//
// Before this fix, graph/builder.ts's incremental TS parse-cache path read
// every code file TWICE: once (in builder.ts, `buildGraph`) purely to
// compute a cache-validity content hash, and a second time INSIDE
// `parseTSFile` (src/parsers/typescript.ts) to actually parse it. When the
// FIRST (hashing) read succeeded but the SECOND (parsing) read failed —
// EMFILE because file-descriptor pressure got worse between the two reads,
// or EACCES if permissions changed mid-scan — a broken fragment (a bare
// `file:` node, empty edges/symbols, plus an `unreadable-file`/
// `system-resource-exhausted` warning) was persisted to the parse cache
// keyed under the FIRST read's real, correct content hash. A later warm run
// — even long after the environment fully recovered — would hash-match
// that poisoned entry and reuse the broken, edge-less fragment WITHOUT ever
// attempting to reparse, reproducing the corruption forever.
//
// The fix threads the content builder.ts already read straight through to
// `parseTSFilePaths`/`parseTSFile` (the new `contents`/`precheckedContent`
// parameters), so there is only ever ONE read per file on this path — the
// asymmetric failure window this test simulates cannot occur post-fix.
//
// vitest ESM: mock node:fs the same way tests/system-resource-exhausted.test.ts
// does, but COUNT calls per path so only the FIRST readFileSync for the
// target file succeeds; every call after that fails with the configured
// errno. Pre-fix, that second call is exactly the one `parseTSFile` used to
// make. Post-fix it should never happen at all.
import { afterEach, describe, expect, it, vi } from "vitest";

const fsFailureControl = vi.hoisted(() => ({
  // path suffix -> rule
  rules: new Map<string, { code: string; succeedFirstNCalls: number }>(),
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
      for (const [suffix, rule] of fsFailureControl.rules) {
        if (path.endsWith(suffix)) {
          const n = (fsFailureControl.calls.get(suffix) ?? 0) + 1;
          fsFailureControl.calls.set(suffix, n);
          if (n > rule.succeedFirstNCalls) {
            const err = new Error(
              `simulated ${rule.code} reading ${path}`,
            ) as NodeJS.ErrnoException;
            err.code = rule.code;
            throw err;
          }
          break;
        }
      }
      return actual.readFileSync(...args);
    },
  };
});

import {
  mkdirSync,
  mkdtempSync,
  readFileSync as realReadFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { hashContent } from "../src/parse-cache.js";
import type { ArtgraphConfig } from "../src/types.js";

const TARGET_CONTENT = "export const target = 1;\n// @impl REQ-4001\n";

function makeFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  // The parse cache only activates when node_modules exists — opt in
  // explicitly, this test's whole point is about what gets PERSISTED.
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\n- REQ-4001: needs coverage\n");
  writeFileSync(join(root, "src", "target.ts"), TARGET_CONTENT);
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

function readCacheTsFragment(root: string): {
  contentHash: string;
  nodes: unknown[];
  edges: { source: string; target: string; kind: string }[];
} {
  const cacheRaw = realReadFileSync(
    join(root, "node_modules", ".cache", "artgraph", "parse-cache.json"),
    "utf-8",
  );
  const cache = JSON.parse(cacheRaw);
  return cache.ts["src/target.ts"];
}

function implEdge(edges: { source: string; target: string; kind: string }[]) {
  return edges.find(
    (e) => e.source === "file:src/target.ts" && e.target === "REQ-4001" && e.kind === "implements",
  );
}

afterEach(() => {
  fsFailureControl.rules.clear();
  fsFailureControl.calls.clear();
});

describe.each(["EMFILE", "EACCES"])(
  "buildGraph: precheck-succeeds/parse-fails asymmetry no longer poisons the TS parse cache (%s)",
  (code) => {
    it(`produces correct edges and never persists a broken fragment under the real hash (${code})`, () => {
      const root = makeFixture(`artgraph-double-read-${code.toLowerCase()}-`);
      try {
        // Only the FIRST readFileSync call for src/target.ts succeeds. Any
        // further read of this path — pre-fix, `parseTSFile`'s own second
        // read — fails with `code`.
        fsFailureControl.rules.set("src/target.ts", { code, succeedFirstNCalls: 1 });

        const { graph, warnings } = buildGraph(root, cfg);

        // No failure should be observable at all — the fix removes the
        // second read this scenario is modeling.
        expect(warnings.some((w) => w.type === "unreadable-file")).toBe(false);
        expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
        expect(implEdge(graph.edges)).toBeDefined();

        // The persisted fragment must carry the REAL content hash (not the
        // "unreadable-file:cannot-hash" sentinel) paired with the correct,
        // non-empty edges. Pre-fix, this exact real hash could be persisted
        // alongside a BROKEN (empty-edges) fragment — the corruption this
        // test guards against.
        const frag = readCacheTsFragment(root);
        expect(frag).toBeDefined();
        expect(frag.contentHash).toBe(hashContent(TARGET_CONTENT));
        expect(frag.contentHash).not.toBe("unreadable-file:cannot-hash");
        expect(implEdge(frag.edges)).toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it(`a warm run after the environment recovers still reports the correct edges, not a poisoned empty fragment (${code})`, () => {
      const root = makeFixture(`artgraph-double-read-warm-${code.toLowerCase()}-`);
      try {
        fsFailureControl.rules.set("src/target.ts", { code, succeedFirstNCalls: 1 });
        buildGraph(root, cfg); // run 1 — see the sibling test above for what this pins

        // "Recovery": by run 2 the simulated failure is gone (fd budget
        // freed / permissions restored). This is the exact scenario the
        // meta-review flags: pre-fix, a poisoned cache entry (real hash +
        // broken, empty fragment) would hash-match THIS warm run and get
        // reused verbatim — no reparse attempted — so the broken result
        // would replay forever even after recovery.
        fsFailureControl.rules.clear();
        fsFailureControl.calls.clear();

        const { graph, warnings } = buildGraph(root, cfg);
        expect(warnings.some((w) => w.type === "unreadable-file")).toBe(false);
        expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
        expect(implEdge(graph.edges)).toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);

describe("buildGraph: symmetric failure (both attempts would fail) keeps self-repairing via the sentinel hash, unchanged", () => {
  it("stays unreadable while the file stays unreadable, then repairs on the first run after it becomes readable", () => {
    const root = makeFixture("artgraph-double-read-symmetric-");
    try {
      // Every read of src/target.ts fails — the pre-existing #264 "both
      // attempts fail" behavior. This fix must not change it: with no
      // successful precheck read, `missContents` never gets an entry for
      // this path, so `parseTSFile` still makes (and fails) its own guarded
      // read, exactly as before this fix.
      fsFailureControl.rules.set("src/target.ts", { code: "EACCES", succeedFirstNCalls: 0 });

      const first = buildGraph(root, cfg);
      expect(first.warnings.some((w) => w.type === "unreadable-file")).toBe(true);
      expect(implEdge(first.graph.edges)).toBeUndefined();

      const frag = readCacheTsFragment(root);
      expect(frag.contentHash).toBe("unreadable-file:cannot-hash");

      fsFailureControl.rules.clear();
      fsFailureControl.calls.clear();
      const second = buildGraph(root, cfg);
      expect(second.warnings.some((w) => w.type === "unreadable-file")).toBe(false);
      expect(implEdge(second.graph.edges)).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
