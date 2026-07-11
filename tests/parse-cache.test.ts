// Incremental parse cache (src/parse-cache.ts). The cache memoizes per-file
// parser fragments under node_modules/.cache/artgraph/parse-cache.json; these
// tests pin the contract that a warm build is OBSERVABLY IDENTICAL to a cold
// one (graph nodes/edges, lock bytes) and that every invalidation path falls
// back to a correct re-parse.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import type { ArtifactGraph, ArtgraphConfig } from "../src/types.js";

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.test.ts"],
  lockFile: ".trace.lock",
};

const CACHE_REL = join("node_modules", ".cache", "artgraph", "parse-cache.json");

// Serialize everything a downstream consumer can observe. Map iteration order
// is part of the contract (builder sorts nodes/edges), so JSON order captures
// it too. `lastReconciled` is stamped with the wall clock on every
// buildLockFromGraph call, so normalize it — everything else in the lock must
// be byte-identical between warm and cold builds.
function snapshotGraph(graph: ArtifactGraph): string {
  const lock = buildLockFromGraph(graph);
  for (const entry of Object.values(lock)) {
    entry.lastReconciled = "<normalized>";
  }
  return JSON.stringify({
    nodes: [...graph.nodes.entries()],
    edges: graph.edges,
    lock,
  });
}

// Reference result: what a cache-less build of the CURRENT tree produces.
// Accepts an optional config so symbol-mode fixtures can compare against a
// cold symbol-mode reference (the T12/T16 star tests need this because the
// module-level `config` defaults to file mode).
function buildWithoutCache(dir: string, cfg: ArtgraphConfig = config): string {
  process.env.ARTGRAPH_CACHE = "0";
  try {
    return snapshotGraph(buildGraph(dir, cfg).graph);
  } finally {
    delete process.env.ARTGRAPH_CACHE;
  }
}

describe("parse cache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-parse-cache-"));
    mkdirSync(join(tmp, "specs", "feat"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(
      join(tmp, "specs", "feat", "spec.md"),
      "# Feat\n\n- REQ-001: first requirement\n- REQ-002: second requirement\n",
    );
    writeFileSync(join(tmp, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(
      join(tmp, "src", "a.ts"),
      '// @impl REQ-001\nimport { b } from "./b.js";\nexport const a = b;\n',
    );
    writeFileSync(
      join(tmp, "tests", "a.test.ts"),
      '// [REQ-001]\nimport { a } from "../src/a.js";\nexport const t = a;\n',
    );
    // The cache only activates when node_modules exists (real installs have
    // one; tmp fixtures normally don't — that keeps every other suite on the
    // cold path). Opt this fixture in explicitly.
    mkdirSync(join(tmp, "node_modules"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.ARTGRAPH_CACHE;
  });

  it("writes the cache file under node_modules/.cache and reuses it warm", () => {
    const cold = snapshotGraph(buildGraph(tmp, config).graph);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(true);

    const warm = snapshotGraph(buildGraph(tmp, config).graph);
    expect(warm).toBe(cold);
  });

  it("warm build equals a cache-disabled build (nodes, edges, lock bytes)", () => {
    buildGraph(tmp, config); // populate cache
    const warm = snapshotGraph(buildGraph(tmp, config).graph);
    expect(warm).toBe(buildWithoutCache(tmp));
  });

  it("does not create a cache file when node_modules is absent", () => {
    rmSync(join(tmp, "node_modules"), { recursive: true, force: true });
    buildGraph(tmp, config);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(false);
  });

  it("does not create a cache file when ARTGRAPH_CACHE=0", () => {
    process.env.ARTGRAPH_CACHE = "0";
    buildGraph(tmp, config);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(false);
  });

  it("picks up a changed TS file (new @impl edge) on a warm build", () => {
    buildGraph(tmp, config); // populate cache
    appendFileSync(join(tmp, "src", "b.ts"), "// @impl REQ-002\n");

    const { graph } = buildGraph(tmp, config);
    const edge = graph.edges.find(
      (e) => e.source === "file:src/b.ts" && e.target === "REQ-002" && e.kind === "implements",
    );
    expect(edge).toBeDefined();
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
  });

  it("picks up a changed spec file (new req node) on a warm build", () => {
    buildGraph(tmp, config); // populate cache
    appendFileSync(join(tmp, "specs", "feat", "spec.md"), "- REQ-003: third requirement\n");

    const { graph } = buildGraph(tmp, config);
    expect(graph.nodes.has("REQ-003")).toBe(true);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
  });

  it("invalidates TS fragments when a file is deleted (import edge to it disappears)", () => {
    const { graph: before } = buildGraph(tmp, config); // populate cache
    expect(
      before.edges.some((e) => e.source === "file:src/a.ts" && e.target === "file:src/b.ts"),
    ).toBe(true);

    rmSync(join(tmp, "src", "b.ts"));
    const { graph } = buildGraph(tmp, config);
    expect(
      graph.edges.some((e) => e.source === "file:src/a.ts" && e.target === "file:src/b.ts"),
    ).toBe(false);
    expect(graph.nodes.has("file:src/b.ts")).toBe(false);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
  });

  it("invalidates when the analysis config changes (mode file -> symbol)", () => {
    buildGraph(tmp, config); // populate cache in file mode
    const symbolConfig: ArtgraphConfig = { ...config, mode: "symbol" };

    const { graph } = buildGraph(tmp, symbolConfig);
    expect(graph.nodes.has("symbol:src/a.ts#a")).toBe(true);

    process.env.ARTGRAPH_CACHE = "0";
    const reference = snapshotGraph(buildGraph(tmp, symbolConfig).graph);
    delete process.env.ARTGRAPH_CACHE;
    expect(snapshotGraph(graph)).toBe(reference);
  });

  it("falls back to a cold parse when the cache file is corrupt", () => {
    buildGraph(tmp, config); // populate cache
    writeFileSync(join(tmp, CACHE_REL), "{ not json !!");

    const { graph } = buildGraph(tmp, config);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
    // and the corrupt file was replaced with a fresh valid cache
    const warmAgain = snapshotGraph(buildGraph(tmp, config).graph);
    expect(warmAgain).toBe(snapshotGraph(graph));
  });

  // ---------------------------------------------------------------------------
  // specs/018 T12 / T16 — warm/cold parity across `export *` chains, and
  // fragment-invalidation propagation through star expansion. These pin the
  // INV-L4 property under the new `starExports` side-channel: the cache
  // persists the parser's plain-`export *` targets, and the builder re-runs
  // the whole star-expansion pass fresh on every build so a warm rebuild
  // produces exactly the same graph a cold one does.
  //
  // The base fixture (`beforeEach`) is file-mode. Both tests below opt into
  // `mode: "symbol"` by overriding the config so the star expansion path
  // fires at all (§9 "file mode 一切不変").
  // ---------------------------------------------------------------------------

  it("T12 (INV-L4): warm build of an `export *` chain yields the same lock bytes as cold", () => {
    // Set up a plain-star chain in the fixture root: leaf → mid → top, with
    // a consumer that imports one name through the top. Symbol mode so the
    // builder's star expansion actually runs.
    const symbolCfg: ArtgraphConfig = { ...config, mode: "symbol" };
    writeFileSync(join(tmp, "src", "b.ts"), "export const b = 1;\n"); // reset
    writeFileSync(join(tmp, "src", "leaf.ts"), "// @impl REQ-002\nexport function x() {}\n");
    writeFileSync(join(tmp, "src", "mid.ts"), 'export * from "./leaf.js";\n');
    writeFileSync(join(tmp, "src", "top.ts"), 'export * from "./mid.js";\n');
    writeFileSync(
      join(tmp, "src", "a.ts"),
      '// @impl REQ-001\nimport { x } from "./top.js";\nexport const a = x;\n',
    );

    // Cold: cache-disabled reference (symbol mode).
    const cold = buildWithoutCache(tmp, symbolCfg);
    // Warm: populate cache, then rebuild.
    buildGraph(tmp, symbolCfg);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(true);
    const warm = snapshotGraph(buildGraph(tmp, symbolCfg).graph);
    expect(warm).toBe(cold);
  });

  it("T16: adding a new @impl on the origin of a star chain propagates through the warm rebuild", () => {
    // Cold populate: chain leaf → mid → top, consumer imports `x`. Warm the
    // cache. Then EDIT ONLY the origin file (`leaf.ts`) to add a new @impl
    // tag on a NEW export, plus register that REQ in the spec.
    const symbolCfg: ArtgraphConfig = { ...config, mode: "symbol" };
    writeFileSync(join(tmp, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(tmp, "src", "leaf.ts"), "// @impl REQ-002\nexport function x() {}\n");
    writeFileSync(join(tmp, "src", "mid.ts"), 'export * from "./leaf.js";\n');
    writeFileSync(join(tmp, "src", "top.ts"), 'export * from "./mid.js";\n');
    writeFileSync(
      join(tmp, "src", "a.ts"),
      '// @impl REQ-001\nimport { x } from "./top.js";\nexport const a = x;\n',
    );
    buildGraph(tmp, symbolCfg); // populate cache

    // Mutate ONLY the origin file (leaf.ts) plus register REQ-020 in spec.
    writeFileSync(
      join(tmp, "src", "leaf.ts"),
      "// @impl REQ-002\nexport function x() {}\n// @impl REQ-020\nexport function y() {}\n",
    );
    appendFileSync(join(tmp, "specs", "feat", "spec.md"), "- REQ-020: new sibling\n");

    // Warm rebuild — mid.ts and top.ts fragments are UNCHANGED (their
    // content hash matches), so they come straight from the cache. Their
    // `starExports` side-channel (unchanged rel target `src/leaf.ts`) is
    // reused verbatim. The builder re-runs expansion end-to-end, so `#y`
    // now appears at every barrel level.
    const { graph } = buildGraph(tmp, symbolCfg);
    expect(graph.nodes.has("symbol:src/leaf.ts#y")).toBe(true);
    expect(graph.nodes.has("symbol:src/mid.ts#y")).toBe(true);
    expect(graph.nodes.has("symbol:src/top.ts#y")).toBe(true);
    // Warm build MUST equal cold build byte-for-byte (INV-L4 across a
    // mid-cache origin edit). Compare against a cold symbol-mode reference.
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp, symbolCfg));
  });

  it("rejects a cache file with a stale schemaVersion (SCHEMA_VERSION was bumped 4→5 in spec 021)", () => {
    // spec 021 (T016, issue #218): literal bumped 3→4 to 4→5 following the
    // parser's SCHEMA_VERSION bump for class-method-grain symbols. Populate
    // the cache normally, then hand-edit its schemaVersion down to the
    // pre-spec-021 value. `readParseCache` must reject it and force a cold
    // path — otherwise a warm build could serve a fragment that predates
    // per-method symbol nodes / class->method `contains` edges, silently
    // diverging from a cold rebuild (INV-L4 breach).
    buildGraph(tmp, config); // populate cache
    const rawPath = join(tmp, CACHE_REL);
    const cache = JSON.parse(readFileSync(rawPath, "utf-8"));
    expect(cache.schemaVersion).toBe(5);
    cache.schemaVersion = 4;
    writeFileSync(rawPath, JSON.stringify(cache));

    // The next build sees a schema-mismatched cache and must fall back to
    // a cold parse. Behaviorally identical to a cache-disabled build.
    const { graph } = buildGraph(tmp, config);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp));
    // The rewritten cache carries the current schemaVersion (=5).
    const rewritten = JSON.parse(readFileSync(rawPath, "utf-8"));
    expect(rewritten.schemaVersion).toBe(5);
  });

  // spec 021 (T016, issue #218) — warm/cold parity for the NEW parser output:
  // per-member symbol nodes (`#ClassName.memberName`) and class -> method
  // `contains` edges for an inline-exported ClassDeclaration. Mirrors the
  // T12 `export *` warm/cold pin above, but exercises the class-method-grain
  // path specifically (symbol mode; the base fixture is file-mode).
  it("spec 021: warm build of a class with methods yields the same lock bytes as cold (SCHEMA_VERSION 5)", () => {
    const symbolCfg: ArtgraphConfig = { ...config, mode: "symbol" };
    writeFileSync(
      join(tmp, "src", "sample.ts"),
      [
        "// @impl REQ-001",
        "export class Sample {",
        "  methodA(): void {",
        "    // @impl REQ-002",
        "  }",
        "",
        "  methodB(): void {",
        "    // @impl REQ-002",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    // Cold: cache-disabled reference (symbol mode).
    const cold = buildWithoutCache(tmp, symbolCfg);
    // Warm: populate cache, then rebuild.
    buildGraph(tmp, symbolCfg);
    expect(existsSync(join(tmp, CACHE_REL))).toBe(true);
    const { graph } = buildGraph(tmp, symbolCfg);
    expect(graph.nodes.has("symbol:src/sample.ts#Sample.methodA")).toBe(true);
    expect(graph.nodes.has("symbol:src/sample.ts#Sample.methodB")).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.kind === "contains" &&
          e.source === "symbol:src/sample.ts#Sample" &&
          e.target === "symbol:src/sample.ts#Sample.methodA",
      ),
    ).toBe(true);
    const warm = snapshotGraph(graph);
    expect(warm).toBe(cold);
  });

  // spec 021 (T016) — editing ONLY a method body must invalidate the file's
  // cached TS fragment (content-hash mismatch on the file) and the warm
  // rebuild must still equal a cold rebuild — including the new member
  // symbol's contentHash (which folds ALL occurrences, so an edit anywhere
  // in the class re-derives the whole per-member map, not just the touched
  // member).
  it("spec 021: editing a method body invalidates the cached fragment and stays warm/cold identical", () => {
    const symbolCfg: ArtgraphConfig = { ...config, mode: "symbol" };
    writeFileSync(
      join(tmp, "src", "sample.ts"),
      [
        "// @impl REQ-001",
        "export class Sample {",
        "  methodA(): void {",
        "    // @impl REQ-002",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    buildGraph(tmp, symbolCfg); // populate cache

    writeFileSync(
      join(tmp, "src", "sample.ts"),
      [
        "// @impl REQ-001",
        "export class Sample {",
        "  methodA(): void {",
        "    // @impl REQ-002",
        "    return;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const { graph } = buildGraph(tmp, symbolCfg);
    expect(snapshotGraph(graph)).toBe(buildWithoutCache(tmp, symbolCfg));
  });
});
