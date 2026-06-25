import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../../src/integrate/atomic-write.js";

describe("atomicWriteFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-atomic-"));
  });

  afterEach(() => {
    try {
      // restore writable perms before removing
      chmodSync(tmp, 0o755);
    } catch {
      /* ignore */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a new file with the given content", () => {
    const dest = join(tmp, "foo.txt");
    atomicWriteFile(dest, "hello");
    expect(readFileSync(dest, "utf-8")).toBe("hello");
  });

  it("overwrites an existing file atomically (no trailing tmp files left)", () => {
    const dest = join(tmp, "foo.txt");
    writeFileSync(dest, "before");
    atomicWriteFile(dest, "after");
    expect(readFileSync(dest, "utf-8")).toBe("after");
    const leftovers = readdirSync(tmp).filter((n) => n !== "foo.txt");
    expect(leftovers).toEqual([]);
  });

  it("leaves the target file unchanged when the rename target dir is missing (mid-failure)", () => {
    // dest under a non-existent directory: write should throw, original
    // (which doesn't exist) remains absent and no tmp files survive in `tmp`.
    const dest = join(tmp, "nope", "missing.txt");
    expect(() => atomicWriteFile(dest, "x")).toThrow();
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("throws on EACCES when parent directory is not writable", () => {
    const ro = join(tmp, "ro");
    // create a read-only dir; under root, chmod is honored for non-root.
    // We skip the assertion if running as root by checking after the call.
    if (process.getuid && process.getuid() === 0) {
      // running as root — chmod doesn't deny us; skip
      return;
    }
    writeFileSync(join(tmp, "marker"), "");
    // create the dir then revoke write perms
    const dest = join(ro, "x.txt");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(() => atomicWriteFile(dest, "data")).toThrow();
    } finally {
      chmodSync(ro, 0o755);
    }
  });

  it("does not auto-append a trailing newline (callers are responsible)", () => {
    const dest = join(tmp, "no-nl.txt");
    atomicWriteFile(dest, "abc");
    expect(readFileSync(dest, "utf-8")).toBe("abc");
  });
});
