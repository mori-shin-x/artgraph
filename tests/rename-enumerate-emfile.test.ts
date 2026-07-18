// PR #339 meta-review (F1) — `enumerateRewriteFiles` (rename-executor.ts)
// used to call the `glob` package's `globSync` directly and now routes
// through `../src/glob-utils.js`'s `listFilesOrThrow`, which THROWS on
// EMFILE/ENFILE (matching `globCodeFiles`'s pre-existing contract) rather
// than the fail-safe `listFilesGuarded` variant `graph/builder.ts`'s
// markdown loop uses. This is deliberate: `enumerateRewriteFiles` runs
// BEFORE any file is rewritten, so a truncated file list here (an entire
// specDir silently missing because a readdir hit EMFILE) would let
// `executeRename`/`executeSplit`/`executeMerge` rewrite only the files that
// DID get listed and leave the rest pointing at the OLD id — a partially-
// applied rename with no warning. The existing `allChanges.length === 0`
// safety valve does NOT catch this: it only fires when NOTHING changed, not
// when some subset silently didn't. Throwing aborts the whole rename before
// any write happens instead.
//
// The mock below counts `fast-glob.sync` calls and only starts failing
// starting at call #3: calls #1-#2 are `loadScanContext`'s own initial scan
// (one markdown-glob call, one `globCodeFiles` call — see the experiment
// this count is based on), which must succeed so `--from REQ-001` resolves
// and validation passes; calls #3 onward are `enumerateRewriteFiles`'s OWN
// markdown-glob call, made before any file is read or written.
const control = vi.hoisted(() => ({
  callCount: 0,
  failFromCall: undefined as number | undefined,
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
        control.callCount++;
        if (control.failFromCall !== undefined && control.callCount >= control.failFromCall) {
          const err = new Error("simulated EMFILE in fast-glob.sync") as NodeJS.ErrnoException;
          err.code = "EMFILE";
          throw err;
        }
        return (realDefault.sync as (...a: unknown[]) => string[])(...args);
      },
    },
  );
  return { default: wrapped };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAt } from "./helpers.js";

function prepareFixture(): string {
  const tmp = mkdtempSync(join(tmpdir(), "artgraph-rename-enum-emfile-"));
  mkdirSync(join(tmp, "specs"), { recursive: true });
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"], testPatterns: [] }),
  );
  writeFileSync(join(tmp, "specs", "a.md"), "# Spec A\n\n- REQ-001: alpha\n");
  writeFileSync(join(tmp, "src", "feature.ts"), "// @impl REQ-001\nexport const x = 1;\n");
  return tmp;
}

afterEach(() => {
  control.callCount = 0;
  control.failFromCall = undefined;
});

describe("rename: enumerateRewriteFiles EMFILE aborts before any write (PR #339 meta-review F1)", () => {
  it("EMFILE during file enumeration → no file rewritten, non-zero exit, no partial rename", async () => {
    const tmp = prepareFixture();
    try {
      const specBefore = readFileSync(join(tmp, "specs", "a.md"), "utf-8");
      const srcBefore = readFileSync(join(tmp, "src", "feature.ts"), "utf-8");

      control.failFromCall = 3;
      const { exitCode, stdout, stderr } = await runAt(tmp, [
        "rename",
        "--from",
        "REQ-001",
        "--to",
        "REQ-100",
        "--format",
        "json",
      ]);

      // Aborted before printing any result — a partial/successful `result`
      // envelope must never reach stdout for a rename that wrote nothing.
      expect(exitCode).not.toBe(0);
      expect(stdout.trim()).toBe("");
      expect(stderr).toMatch(/EMFILE/);

      // Zero files rewritten — the crucial "no partial rename" assertion.
      // If `enumerateRewriteFiles` had instead swallowed the EMFILE (the
      // `listFilesGuarded` fail-safe behavior this fix deliberately does
      // NOT use here), the command would see an empty/truncated file list
      // and either rewrite nothing (this would still look identical) OR, in
      // a project with more than one specDir, rewrite some directories but
      // not others — a silent partial rename this pin exists to catch by
      // construction (throwing instead of continuing).
      const specAfter = readFileSync(join(tmp, "specs", "a.md"), "utf-8");
      const srcAfter = readFileSync(join(tmp, "src", "feature.ts"), "utf-8");
      expect(specAfter).toBe(specBefore);
      expect(srcAfter).toBe(srcBefore);
      expect(specAfter).toContain("REQ-001");
      expect(srcAfter).toContain("REQ-001");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
