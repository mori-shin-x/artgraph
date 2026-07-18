// issue #333 — unresolved re-export / import specifiers used to be a SILENT
// `continue` in `extractImports` (4 sites: a plain `import` statement, and
// the named/`export *`/`export * as ns` re-export forms, plus the S3-C3/
// S3-C4 source-null forms) — see docs/architecture.md §11 known-limitation
// (g) and specs/018-reexport-symbol-precision/spec.md's "Out of scope" list
// (both now updated to point at this fix). This suite pins the new
// `unresolved-reexport` / `unresolved-import` `TsParseWarning` /
// `BuildWarning` types:
//   (a) all three statement-level re-export forms (named / `export *` /
//       `export * as ns`) each produce an `unresolved-reexport` warning,
//       observable in `warnings[]` (the exact array `scan --format json`
//       serializes — see src/scan.ts / src/cli.ts).
//   (b) a plain unresolved `import` produces `unresolved-import`.
//   (c) both types are SILENT by default (suppressed from the stderr
//       presenter, per `SILENT_WARNING_TYPES` — the CLI has no `--verbose`
//       flag, so `scan --format json` is the only observation path).
//   (d) a warm cache re-run replays the SAME warnings (INV-L4): the parser
//       warning travels with the persisted `TsFragment.warnings` field.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph, isSilentWarning, type BuildWarning } from "../src/graph/builder.js";
import { printWarnings } from "../src/commands/presenters/warnings.js";
import type { ArtgraphConfig } from "../src/types.js";

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>): string {
  tmp = mkdtempSync(join(tmpdir(), "artgraph-333-"));
  // node_modules present so the parse cache activates — needed for the (d)
  // warm/cold replay assertion below.
  mkdirSync(join(tmp, "node_modules"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return tmp;
}

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: [],
  lockFile: ".trace.lock",
  mode: "symbol",
};

const FILES: Record<string, string> = {
  "src/named.ts": 'export { x } from "./missing-named";\n',
  "src/star.ts": 'export * from "./missing-star";\n',
  "src/ns.ts": 'export * as ns from "./missing-ns";\n',
  "src/plain-import.ts": 'import { y } from "./missing-import";\nexport const use = y;\n',
};

describe("issue #333 (AC a) — unresolved-reexport: all three statement-level forms", () => {
  it('named re-export (`export { x } from "./missing"`) warns', () => {
    const root = makeRepo(FILES);
    const { warnings } = buildGraph(root, config);
    const w = warnings.find(
      (x) => x.type === "unresolved-reexport" && x.files[0] === "src/named.ts",
    );
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/named re-export/);
    expect(w?.message).toMatch(/missing-named/);
  });

  it("plain `export *` warns", () => {
    const root = makeRepo(FILES);
    const { warnings } = buildGraph(root, config);
    const w = warnings.find(
      (x) => x.type === "unresolved-reexport" && x.files[0] === "src/star.ts",
    );
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/export \*/);
    expect(w?.message).toMatch(/missing-star/);
  });

  it("`export * as ns from` warns", () => {
    const root = makeRepo(FILES);
    const { warnings } = buildGraph(root, config);
    const w = warnings.find((x) => x.type === "unresolved-reexport" && x.files[0] === "src/ns.ts");
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/export \* as ns/);
    expect(w?.message).toMatch(/missing-ns/);
  });
});

describe("issue #333 (AC b) — unresolved-import: a plain unresolved import statement", () => {
  it("warns with type unresolved-import", () => {
    const root = makeRepo(FILES);
    const { warnings } = buildGraph(root, config);
    const w = warnings.find(
      (x) => x.type === "unresolved-import" && x.files[0] === "src/plain-import.ts",
    );
    expect(w).toBeDefined();
    expect(w?.message).toMatch(/missing-import/);
  });
});

describe("issue #333 (AC c) — both new types are SILENT by default", () => {
  it("isSilentWarning is true for unresolved-reexport / unresolved-import", () => {
    expect(isSilentWarning("unresolved-reexport")).toBe(true);
    expect(isSilentWarning("unresolved-import")).toBe(true);
  });

  it("the default stderr presenter prints nothing for these warnings", () => {
    const root = makeRepo(FILES);
    const { warnings } = buildGraph(root, config);
    const relevant = warnings.filter(
      (w) => w.type === "unresolved-reexport" || w.type === "unresolved-import",
    );
    expect(relevant.length).toBeGreaterThanOrEqual(4);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      printWarnings(warnings as BuildWarning[]);
      const printed = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).not.toMatch(/missing-named|missing-star|missing-ns|missing-import/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("issue #333 (AC d) — warm cache replays the same warnings (INV-L4)", () => {
  it("a second (warm) build emits byte-identical unresolved-* warnings to the first (cold) build", () => {
    const root = makeRepo(FILES);
    const first = buildGraph(root, config);
    const firstRelevant = first.warnings.filter(
      (w) => w.type === "unresolved-reexport" || w.type === "unresolved-import",
    );
    expect(firstRelevant.length).toBeGreaterThanOrEqual(4);

    const second = buildGraph(root, config); // warm — should reuse cached fragments
    const secondRelevant = second.warnings.filter(
      (w) => w.type === "unresolved-reexport" || w.type === "unresolved-import",
    );

    // M2 (PR #349 review) — compare in OUTPUT ORDER, not sorted: a warm run
    // reusing cached fragments can silently reorder warnings relative to a
    // cold run even when the SET of warnings is identical, and a sorted
    // comparison would hide that regression (INV-L4). If this ever fails,
    // that is a real order divergence between cold and warm — not a flaky
    // test to re-sort away.
    expect(JSON.stringify(secondRelevant)).toBe(JSON.stringify(firstRelevant));
  });
});
