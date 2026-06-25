/**
 * M-H6 regression guard — architecture-level invariant.
 *
 * contracts/integration-provider.md §副作用境界 requires that integration
 * provider modules NEVER call `fs.writeFileSync` (or its async / append
 * cousins) directly. All filesystem mutation must go through the
 * `atomicWriteFile` helper so that:
 *
 *  - rollback can spy on a single chokepoint, and
 *  - partial writes are impossible (tmp + rename is the only write path).
 *
 * The single exception is `src/integrate/atomic-write.ts` itself, which
 * implements the chokepoint.
 *
 * This test enforces the rule by grepping the source of every provider /
 * guidance module. If a future PR sneaks in a direct `writeFileSync`, this
 * test fails BEFORE the broken module ever ships.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const INTEGRATE_DIR = resolve(import.meta.dirname, "../../src/integrate");
const PROVIDERS_DIR = resolve(INTEGRATE_DIR, "providers");

// Single allow-listed module: `atomic-write.ts` IS the chokepoint, so it
// gets to call writeFileSync. Any other file that needs to be added here
// is a code smell — push the write through atomicWriteFile instead.
const ALLOWED_DIRECT_WRITERS = new Set(["atomic-write.ts"]);

const FS_WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile)\s*\(/;
const FS_WRITE_IMPORT =
  /from\s+["']node:fs["'][^;]*\b(writeFileSync|writeFile|appendFileSync|appendFile)\b/;

/**
 * Strip `// line comments` and `/* block comments *​/` from `src` so a
 * doc-comment that legitimately mentions "writeFileSync" doesn't trip the
 * grep. Naive but sufficient: our source files don't contain literal `//`
 * or `/​*` inside strings (a quick visual audit confirms).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function readTsFiles(dir: string): Array<{ name: string; path: string; src: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => {
      const path = resolve(dir, f);
      return { name: f, path, src: readFileSync(path, "utf-8") };
    });
}

describe("integrate module — fs write-call ban (M-H6 / contracts/integration-provider.md §副作用境界)", () => {
  it("no provider under src/integrate/providers/ calls fs.writeFileSync directly", () => {
    const offenders: string[] = [];
    for (const file of readTsFiles(PROVIDERS_DIR)) {
      if (ALLOWED_DIRECT_WRITERS.has(file.name)) continue;
      const stripped = stripComments(file.src);
      if (FS_WRITE_CALL.test(stripped) || FS_WRITE_IMPORT.test(stripped)) {
        offenders.push(file.path);
      }
    }
    expect(
      offenders,
      `These providers must route writes through atomicWriteFile, not fs.writeFileSync:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("guidance.ts does not call fs.writeFileSync directly", () => {
    const path = resolve(INTEGRATE_DIR, "guidance.ts");
    const stripped = stripComments(readFileSync(path, "utf-8"));
    expect(FS_WRITE_CALL.test(stripped)).toBe(false);
    expect(FS_WRITE_IMPORT.test(stripped)).toBe(false);
  });

  it("atomic-write.ts is the single allow-listed direct writer", () => {
    // Anchor the exception so a future refactor can't quietly add a second
    // module to the allow-list without a reviewer noticing.
    expect([...ALLOWED_DIRECT_WRITERS]).toEqual(["atomic-write.ts"]);
    // And confirm that the file we exempted actually does use writeFileSync
    // — otherwise the exemption is dead code and should be removed.
    const path = resolve(INTEGRATE_DIR, "atomic-write.ts");
    const src = readFileSync(path, "utf-8");
    expect(FS_WRITE_CALL.test(src) || FS_WRITE_IMPORT.test(src)).toBe(true);
  });
});
