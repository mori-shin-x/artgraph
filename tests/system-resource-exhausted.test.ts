// issue #295 — `EMFILE`/`ENFILE` (file descriptor exhaustion) is a
// scan-wide condition, distinct from the per-file `unreadable-file` warning
// issue #264/#277 already cover (EACCES/EISDIR/ENOENT). This file pins:
//
//  1. EMFILE hit by BOTH the markdown loop and the TS loop in the same
//     `buildGraph()` call still produces exactly ONE `system-resource-exhausted`
//     warning (builder-level dedup).
//  2. That warning appears in `scan --format json`'s `warnings[]` array
//     (the field it rides through end to end).
//  3. `scan`'s default text output prints it (NOT silent, unlike
//     `phantom-import-repaired`/`dangling-import`).
//  4. The "default" errno branch (anything other than
//     EACCES/EISDIR/ENOENT/EMFILE/ENFILE, e.g. EPERM) keeps the pre-#295
//     generic `unreadable-file` behavior, with the code appended.
//  5. EACCES keeps the pre-#295 `unreadable-file` message byte-for-byte
//     (no code appended) — the real permission-error tests in
//     tests/builder.test.ts / tests/typescript.test.ts already cover this
//     via actual chmod(0); this file adds a deterministic, cross-platform
//     (no chmod) confirmation of the same branch via a mocked errno.
//
// vitest ESM: `vi.spyOn(fs, "readFileSync")` fails with "Cannot redefine
// property" because node:fs's exports are non-configurable (same
// constraint documented in tests/hooks-merge.test.ts for renameSync). This
// file mocks the module instead, with a flag-gated, path-suffix-guarded
// pass-through so only paths this file explicitly registers are affected —
// every other read (including this test file's own fixture setup) uses the
// real readFileSync.
import { afterEach, describe, expect, it, vi } from "vitest";

const fsFailureControl = vi.hoisted(() => ({
  // path suffix -> errno code to simulate for that one readFileSync call.
  failures: new Map<string, string>(),
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
          const err = new Error(`simulated ${code} reading ${path}`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
      }
      return actual.readFileSync(...args);
    },
  };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";
import { runAt } from "./helpers.js";

function makeFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "specs", "good.md"), "# Good\n\n- REQ-2951: stays readable\n");
  writeFileSync(join(root, "specs", "broken.md"), "- REQ-2952: never actually read\n");
  writeFileSync(join(root, "src", "keep.ts"), "export const keep = 1;\n// @impl REQ-2951\n");
  writeFileSync(join(root, "src", "broken.ts"), "export const neverRead = 1;\n");
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
});

describe("buildGraph: EMFILE/ENFILE dedup across markdown + TS loops (issue #295)", () => {
  it("emits exactly one system-resource-exhausted warning when both loops hit EMFILE", () => {
    const root = makeFixture("artgraph-emfile-dedup-");
    try {
      fsFailureControl.failures.set("specs/broken.md", "EMFILE");
      fsFailureControl.failures.set("src/broken.ts", "EMFILE");

      const { graph, warnings } = buildGraph(root, cfg);

      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]!.message).toMatch(/EMFILE/);

      // Neither failing file crashed the build, and neither one is
      // misreported as a plain `unreadable-file` — the scan continues for
      // both loops (graph semantics unchanged, per the issue's design).
      expect(warnings.some((w) => w.type === "unreadable-file")).toBe(false);
      expect(graph.nodes.has("file:src/keep.ts")).toBe(true);
      expect(graph.nodes.has("REQ-2951")).toBe(true);
      expect(graph.nodes.has("file:src/broken.ts")).toBe(true);
      expect(graph.nodes.has("doc:broken.md")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits exactly one warning even with ENFILE and EMFILE mixed across loops", () => {
    const root = makeFixture("artgraph-enfile-mix-");
    try {
      fsFailureControl.failures.set("specs/broken.md", "ENFILE");
      fsFailureControl.failures.set("src/broken.ts", "EMFILE");

      const { warnings } = buildGraph(root, cfg);
      const exhausted = warnings.filter((w) => w.type === "system-resource-exhausted");
      expect(exhausted).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scan --format json / text surface system-resource-exhausted (issue #295)", () => {
  it("scan --format json includes system-resource-exhausted in warnings[]", async () => {
    const root = makeFixture("artgraph-emfile-json-");
    try {
      fsFailureControl.failures.set("src/broken.ts", "EMFILE");

      const { stdout, exitCode } = await runAt(root, ["scan", "--format", "json"]);
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(
        result.warnings.some((w: { type: string }) => w.type === "system-resource-exhausted"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scan (text) prints the warning to stderr — not silent", async () => {
    const root = makeFixture("artgraph-emfile-text-");
    try {
      fsFailureControl.failures.set("src/broken.ts", "EMFILE");

      const { stderr, exitCode } = await runAt(root, ["scan"]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("WARNING:");
      expect(stderr).toMatch(/EMFILE/);
      expect(stderr).toMatch(/ulimit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("errno branch coverage: EACCES unchanged, default (EPERM) pinned (issue #295)", () => {
  it("EACCES keeps the pre-#295 unreadable-file message byte-for-byte (TS side)", () => {
    const root = makeFixture("artgraph-eacces-ts-");
    try {
      fsFailureControl.failures.set("src/broken.ts", "EACCES");

      const { warnings } = buildGraph(root, cfg);
      const unreadable = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]!.files).toEqual(["src/broken.ts"]);
      expect(unreadable[0]!.message).toBe(
        `could not read "src/broken.ts" (simulated EACCES reading ${join(root, "src", "broken.ts")}); ` +
          "skipped symbol/import/@impl extraction for this file. A file node was still created so " +
          "it stays visible in the graph, but it carries none of its usual edges until the file " +
          "becomes readable again.",
      );
      // The default branch's "append code" behavior must NOT leak into the
      // EACCES branch.
      expect(unreadable[0]!.message).not.toContain("[EACCES]");
      expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("EACCES keeps the pre-#295 unreadable-file message byte-for-byte (markdown side)", () => {
    const root = makeFixture("artgraph-eacces-md-");
    try {
      fsFailureControl.failures.set("specs/broken.md", "EACCES");

      const { warnings } = buildGraph(root, cfg);
      const unreadable = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]!.files).toEqual(["specs/broken.md"]);
      expect(unreadable[0]!.message).not.toContain("[EACCES]");
      expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Step 0-pre required item — pin the "default" bucket (any errno NOT in
  // {EACCES, EISDIR, ENOENT, EMFILE, ENFILE}, and code === undefined) to the
  // SAME `unreadable-file` type and generic message the pre-#295 code
  // always produced, with the errno code appended when one is present.
  // EPERM stands in for the "some other real errno" case (ELOOP is the
  // issue's own example).
  it("default branch (EPERM) stays unreadable-file with the generic message + appended code (TS side)", () => {
    const root = makeFixture("artgraph-eperm-ts-");
    try {
      fsFailureControl.failures.set("src/broken.ts", "EPERM");

      const { warnings } = buildGraph(root, cfg);
      const unreadable = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]!.message).toContain(
        "skipped symbol/import/@impl extraction for this file",
      );
      expect(unreadable[0]!.message).toContain("[EPERM]");
      expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default branch (EPERM) stays unreadable-file with the generic message + appended code (markdown side)", () => {
    const root = makeFixture("artgraph-eperm-md-");
    try {
      fsFailureControl.failures.set("specs/broken.md", "EPERM");

      const { warnings } = buildGraph(root, cfg);
      const unreadable = warnings.filter((w) => w.type === "unreadable-file");
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]!.message).toContain("skipped req/task/edge extraction for this file");
      expect(unreadable[0]!.message).toContain("[EPERM]");
      expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
