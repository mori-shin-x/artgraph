import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { writeLock } from "../src/lock.js";

const TMP = resolve(import.meta.dirname, "fixtures/lock-test");

describe("writeLock path safety (S2)", () => {
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("writes the lock within the project root", () => {
    const root = resolve(TMP, "root");
    mkdirSync(root, { recursive: true });
    writeLock(root, ".trace.lock", {});
    expect(existsSync(resolve(root, ".trace.lock"))).toBe(true);
  });

  it("refuses to write through a symlinked directory escaping the root", () => {
    const root = resolve(TMP, "root2");
    const outside = resolve(TMP, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // The lockPath "link/.trace.lock" passes loadConfig's string-only check, but
    // "link" is a symlink pointing outside the root — writeLock must reject it.
    symlinkSync(outside, resolve(root, "link"), "dir");
    expect(() => writeLock(root, "link/.trace.lock", {})).toThrow("outside project root");
  });
});
