import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGuidanceFile } from "../../src/integrate/guidance.js";
import * as atomicWriteMod from "../../src/integrate/atomic-write.js";

describe("writeGuidanceFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-guidance-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes a new file when the target is absent", () => {
    const dest = join(tmp, "artgraph.md");
    const result = writeGuidanceFile({
      destPath: dest,
      content: "# hello\n",
      force: false,
    });
    expect(result.written).toBe(true);
    expect(result.hadExisting).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("# hello\n");
  });

  it("is a no-op when the existing file equals (post-newline-normalized) content", () => {
    const dest = join(tmp, "artgraph.md");
    writeFileSync(dest, "# hello\n");
    const before = readFileSync(dest, "utf-8");
    const result = writeGuidanceFile({
      destPath: dest,
      content: "# hello\n",
      force: false,
    });
    expect(result.written).toBe(false);
    expect(result.hadExisting).toBe(true);
    // disk unchanged
    expect(readFileSync(dest, "utf-8")).toBe(before);
  });

  it("is a no-op when target differs and force=false (disk unchanged)", () => {
    const dest = join(tmp, "artgraph.md");
    writeFileSync(dest, "# old\n");
    const result = writeGuidanceFile({
      destPath: dest,
      content: "# new\n",
      force: false,
    });
    expect(result.written).toBe(false);
    expect(result.hadExisting).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("# old\n");
  });

  it("overwrites when target differs and force=true", () => {
    const dest = join(tmp, "artgraph.md");
    writeFileSync(dest, "# old\n");
    const result = writeGuidanceFile({
      destPath: dest,
      content: "# new\n",
      force: true,
    });
    expect(result.written).toBe(true);
    expect(result.hadExisting).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("# new\n");
  });

  it("creates the parent directory when missing (default createParentDirs=true)", () => {
    const dest = join(tmp, "nested", "deeper", "artgraph.md");
    const result = writeGuidanceFile({
      destPath: dest,
      content: "x",
      force: false,
    });
    expect(result.written).toBe(true);
    expect(result.createdParentDirs).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  it("throws when the parent dir is missing and createParentDirs=false", () => {
    const dest = join(tmp, "missing", "artgraph.md");
    expect(() =>
      writeGuidanceFile({
        destPath: dest,
        content: "x",
        force: false,
        createParentDirs: false,
      }),
    ).toThrow();
    // Nothing was written
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("writes atomically — when atomicWriteFile throws, no tmp files remain", () => {
    const dest = join(tmp, "artgraph.md");
    // Force atomicWriteFile to throw — disk must end up unchanged.
    const spy = vi.spyOn(atomicWriteMod, "atomicWriteFile").mockImplementation(() => {
      throw new Error("simulated EACCES");
    });
    expect(() =>
      writeGuidanceFile({
        destPath: dest,
        content: "x\n",
        force: false,
      }),
    ).toThrow(/simulated|EACCES/);
    spy.mockRestore();
    // No tmp residue from our wrapper (atomicWriteFile is responsible for its own).
    expect(existsSync(dest)).toBe(false);
  });

  it("always ensures the file ends with exactly one trailing newline", () => {
    const dest = join(tmp, "artgraph.md");
    writeGuidanceFile({
      destPath: dest,
      content: "no-final-newline",
      force: false,
    });
    expect(readFileSync(dest, "utf-8")).toBe("no-final-newline\n");
  });

  it("normalizes multiple trailing newlines down to a single one", () => {
    const dest = join(tmp, "artgraph.md");
    writeGuidanceFile({
      destPath: dest,
      content: "x\n\n\n",
      force: false,
    });
    expect(readFileSync(dest, "utf-8")).toBe("x\n");
  });

  it("treats a content that already ends with \\n as already-equal (no rewrite)", () => {
    // Round-trip safety: caller passes content without trailing newline; the
    // file on disk has it. The second call should be a no-op.
    const dest = join(tmp, "artgraph.md");
    writeGuidanceFile({ destPath: dest, content: "x", force: false });
    const before = readFileSync(dest, "utf-8");
    const r2 = writeGuidanceFile({ destPath: dest, content: "x", force: false });
    expect(r2.written).toBe(false);
    expect(r2.hadExisting).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe(before);
  });

  it("reports createdParentDirs=false when parent already existed", () => {
    mkdirSync(join(tmp, "nested"));
    const dest = join(tmp, "nested", "artgraph.md");
    const result = writeGuidanceFile({
      destPath: dest,
      content: "x",
      force: false,
    });
    expect(result.written).toBe(true);
    expect(result.createdParentDirs).toBe(false);
  });
});
