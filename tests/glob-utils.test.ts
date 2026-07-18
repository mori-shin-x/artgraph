// issue #335 (Step 0-pre HIGH-1) — unit tests for the shared file-enumeration
// wrapper (`src/glob-utils.ts`) that unifies the markdown-side spec glob and
// the TS-side `globCodeFiles` behind one fast-glob option set. Two things are
// pinned here at the wrapper level (builder-level end-to-end coverage lives
// in tests/resource-guard-tsconfig-glob.test.ts and
// tests/builder-symlink.test.ts):
//
//   1. Determinism — the wrapper explicitly `.sort()`s its result, so output
//      order never depends on OS readdir order (fast-glob itself does not
//      sort).
//   2. `listFilesGuarded`'s EMFILE/ENFILE fail-safe behavior in isolation
//      from any `graph/builder.ts` wiring.
import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("glob-utils: listFilesOrThrow / listFilesGuarded determinism (issue #335)", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("listFilesOrThrow returns a sorted result regardless of file creation order", async () => {
    root = mkdtempSync(join(tmpdir(), "artgraph-glob-utils-sort-"));
    // Deliberately create files in a non-alphabetical order — a plain
    // fast-glob call (no explicit sort) would very likely (though not
    // guaranteedly) return them in creation/readdir order on most
    // filesystems, which is exactly the OS-dependent behavior this wrapper
    // eliminates.
    writeFileSync(join(root, "zeta.md"), "# z\n");
    writeFileSync(join(root, "alpha.md"), "# a\n");
    writeFileSync(join(root, "mu.md"), "# m\n");

    const { listFilesOrThrow } = await import("../src/glob-utils.js");
    const files = listFilesOrThrow(join(root, "*.md"));
    const basenames = files.map((f) => f.slice(f.lastIndexOf("/") + 1));

    expect(basenames).toEqual(["alpha.md", "mu.md", "zeta.md"]);
  });

  it("listFilesGuarded also returns a sorted result on the success path", async () => {
    root = mkdtempSync(join(tmpdir(), "artgraph-glob-utils-sort-guarded-"));
    writeFileSync(join(root, "c.ts"), "export const c = 1;\n");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 1;\n");

    const { listFilesGuarded } = await import("../src/glob-utils.js");
    const result = listFilesGuarded(join(root, "*.ts"));
    const basenames = result.files.map((f) => f.slice(f.lastIndexOf("/") + 1));

    expect(result.resourceExhaustedCode).toBeUndefined();
    expect(basenames).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("listFilesOrThrow: onlyFiles excludes directories, dot excludes dotfiles (pinned default options)", async () => {
    root = mkdtempSync(join(tmpdir(), "artgraph-glob-utils-opts-"));
    mkdirSync(join(root, "subdir.md"), { recursive: true });
    writeFileSync(join(root, ".hidden.md"), "# hidden\n");
    writeFileSync(join(root, "visible.md"), "# visible\n");

    const { listFilesOrThrow } = await import("../src/glob-utils.js");
    const files = listFilesOrThrow(join(root, "*.md"));
    const basenames = files.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort();

    expect(basenames).toEqual(["visible.md"]);
  });
});

describe("glob-utils: listFilesGuarded EMFILE/ENFILE fail-safe (issue #335)", () => {
  afterEach(() => {
    vi.doUnmock("fast-glob");
    vi.resetModules();
  });

  it("catches EMFILE, returns an empty file list, and reports the code", async () => {
    vi.resetModules();
    vi.doMock("fast-glob", () => ({
      default: {
        sync: () => {
          const err = new Error("simulated EMFILE") as NodeJS.ErrnoException;
          err.code = "EMFILE";
          throw err;
        },
      },
    }));
    const { listFilesGuarded } = await import("../src/glob-utils.js");
    const result = listFilesGuarded("**/*.md");
    expect(result.files).toEqual([]);
    expect(result.resourceExhaustedCode).toBe("EMFILE");
  });

  it("catches ENFILE, returns an empty file list, and reports the code", async () => {
    vi.resetModules();
    vi.doMock("fast-glob", () => ({
      default: {
        sync: () => {
          const err = new Error("simulated ENFILE") as NodeJS.ErrnoException;
          err.code = "ENFILE";
          throw err;
        },
      },
    }));
    const { listFilesGuarded } = await import("../src/glob-utils.js");
    const result = listFilesGuarded("**/*.md");
    expect(result.files).toEqual([]);
    expect(result.resourceExhaustedCode).toBe("ENFILE");
  });

  it("does NOT swallow a non-resource error — it propagates from both listFilesOrThrow and listFilesGuarded", async () => {
    vi.resetModules();
    vi.doMock("fast-glob", () => ({
      default: {
        sync: () => {
          const err = new Error("simulated EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        },
      },
    }));
    const { listFilesOrThrow, listFilesGuarded } = await import("../src/glob-utils.js");
    expect(() => listFilesOrThrow("**/*.md")).toThrow(/EPERM/);
    expect(() => listFilesGuarded("**/*.md")).toThrow(/EPERM/);
  });
});
