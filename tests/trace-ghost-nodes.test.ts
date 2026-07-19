// issue #275 — `ingestTrace`'s `buildSymbolNameTable` resolves against
// `config.include` only, while `buildGraph`'s own code-file set is
// `[...config.include, ...config.testPatterns]`. A negative pattern that
// lives ONLY in `testPatterns` narrows the GRAPH's file set below the
// symbol table's, so a trace hit against a file the symbol table still
// considers in-scope resolves to a "ghost" node id — one `IngestedTrace`
// carries (in `perReq`/`reqsByNode`/`hashesAtTrace`) but the graph itself
// has no node for. `src/trace/ingest.ts`'s `filterTraceToGraph` (wired into
// every direct `IngestedTrace` consumer: `check`, `impact --tests`,
// `trace status`/`report`) is the fix — these tests pin its effect end to
// end via the real CLI, following `tests/check-evidence.test.ts` /
// `tests/trace-cli.test.ts`'s established fixture style.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runAt } from "./helpers.js";
import { SCHEMA_VERSION, hashContent } from "../src/trace/schema.js";
import { buildGraph } from "../src/graph/builder.js";
import { buildSymbolNameTable } from "../src/trace/symbol-table.js";
import type { ArtgraphConfig } from "../src/types.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function makeRepo(
  files: Record<string, string>,
  configExtra: Record<string, unknown> = {},
): string {
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-trace-ghost-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      mode: "symbol",
      ...configExtra,
    }),
    "utf-8",
  );
  return tmp;
}

function metaLine(): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "meta",
    runToken: "run-1",
    pool: "forks",
    vitest: "4.1.10",
    startedAt: "2026-07-10T14:00:00Z",
  });
}

function testLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "test",
    testName: "[REQ-900] a test",
    suitePath: [],
    testFile: "tests/x.test.ts",
    passed: true,
    hits: [],
    hashes: {},
    ...overrides,
  });
}

function writeShard(tmp: string, name: string, lines: string[]): void {
  const dir = join(tmp, ".artgraph/trace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n"), "utf-8");
}

// `src/ghost.ts` matches `include` (so `buildSymbolNameTable` sees it and
// resolves hits against it normally) but is excluded from the GRAPH via a
// `testPatterns`-only negative pattern (issue #275's exact drift). REQ-900
// has NO `@impl` anywhere — its only evidence is the ghost hit — so any
// rescue/finding attributable to it can only come from the ghost node.
function makeGhostFixture(configExtra: Record<string, unknown> = {}): string {
  const tmp = makeRepo(
    {
      "src/ghost.ts": "export function ghostFn() {}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-900: only ever reached via ghost.ts.\n",
    },
    { testPatterns: ["!src/ghost.ts"], ...configExtra },
  );
  writeShard(tmp, "w1.jsonl", [
    metaLine(),
    testLine({
      testName: "[REQ-900] exercises ghostFn",
      testFile: "tests/req900.test.ts",
      hits: [{ file: "src/ghost.ts", fn: "ghostFn" }],
      hashes: { "src/ghost.ts": hashContent("export function ghostFn() {}\n") },
    }),
  ]);
  return tmp;
}

describe("trace-ghost-nodes (#275, closed for the testPatterns-only case by #350): filterTraceToGraph drops nodes the graph doesn't have", () => {
  // issue #350 — every test below used `testPatterns: ["!src/ghost.ts"]`
  // (a negative pattern living ONLY in `testPatterns`) as its ghost-repro
  // mechanism: pre-#350, that negation excluded `src/ghost.ts` from the
  // WHOLE graph (the merged discovery pool) while `buildSymbolNameTable`
  // (which resolves trace hits, and always discovers from `config.include`
  // ONLY — see `src/trace/ingest.ts`) still saw the file, producing a
  // `symbol:src/ghost.ts#ghostFn` id with evidence but no matching graph
  // node — a "ghost". Pool separation (`discoverCodeFiles`,
  // `src/parsers/typescript.ts`) makes the graph's own discovered file set
  // `include ∪ testPatterns` — a pool `include` is always part of — so ANY
  // file `buildSymbolNameTable` can see (include-only) is now STRUCTURALLY
  // GUARANTEED to also be a real graph node. The specific "testPatterns-only
  // negative pattern" ghost this suite pinned can therefore no longer be
  // constructed at all: `src/ghost.ts` is now a perfectly ordinary graph
  // member, and its evidence is real, not a ghost. `filterTraceToGraph` /
  // `resolveTraceGraphNodeId` (src/trace/ingest.ts) are UNCHANGED and still
  // exist as defense-in-depth against any OTHER divergence — see A-T4a/b/c
  // below, which are unaffected by #350 and continue to pin that code path.
  // These five tests are updated to pin the NEW, corrected behavior instead
  // of being deleted, so a future regression that reopens this gap (e.g. a
  // future change to `buildSymbolNameTable`'s own file-discovery patterns)
  // still has a failing test to catch it.
  it("A-T1 [closed by #350]: src/ghost.ts's evidence is real (not a ghost) — with acceptExercises: true it legitimately rescues REQ-900 to `exercised`", async () => {
    const tmp = makeGhostFixture({ trace: { acceptExercises: true } });
    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    const req900 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-900");
    expect(req900.status).toBe("exercised");
    expect(result.uncovered).not.toContain("REQ-900");
  });

  it("A-T2 [closed by #350]: src/ghost.ts is a real node now — its deliberately-wrong hashesAtTrace entry is a genuine staleness finding and correctly trips the gate", async () => {
    // REQ-900 also gets a REAL `@impl` on a REAL (non-ghost) function so the
    // fixture has ZERO other scoped issues (mirrors the isolation technique
    // `check-evidence.test.ts`'s "T019f" staleness=gate fixture uses) — the
    // only issue here is `src/ghost.ts`'s deliberately-wrong `hashesAtTrace`
    // entry. Pre-#350 that entry belonged to a ghost node and was harmless
    // (dropped by `filterTraceToGraph` before `computeStaleNodeIds` ever saw
    // it). Post-#350, `src/ghost.ts` is a REAL graph member, so the wrong
    // hash is genuine stale evidence and SHOULD trip `staleness: "gate"`.
    const tmp = makeRepo(
      {
        "src/real.ts": "export function realFn() {\n  // @impl REQ-900\n}\n",
        "src/ghost.ts": "export function ghostFn() {}\n",
        "specs/spec.md": "# Fixture\n\n- REQ-900: realFn, plus unrelated ghost evidence.\n",
      },
      { testPatterns: ["!src/ghost.ts"], trace: { staleness: "gate" } },
    );
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-900] exercises ghostFn",
        testFile: "tests/req900.test.ts",
        hits: [{ file: "src/ghost.ts", fn: "ghostFn" }],
        // Deliberately wrong hash — `src/ghost.ts` is a real graph member
        // post-#350, so this now genuinely disagrees with the current
        // `symbol:src/ghost.ts#ghostFn` content hash.
        hashes: { "src/ghost.ts": "0000000000000000" },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json", "--gate"]);
    const result = JSON.parse(stdout);

    const req900Stale = result.staleEvidence.find((s: { reqId: string }) => s.reqId === "REQ-900");
    expect(req900Stale?.symbols).toEqual(["symbol:src/ghost.ts#ghostFn"]);
    expect(result.staleGate).toBe(true);
    expect(exitCode).toBe(2);
  });

  it("A-T3 [closed by #350]: src/ghost.ts is real now — its exclusive, unclaimed evidence surfaces as an ordinary suggestedImpls finding", async () => {
    const tmp = makeGhostFixture();
    const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-900", node: "symbol:src/ghost.ts#ghostFn" },
    ]);
  });

  it("A-T4a [over-filter prevention, file mode — most important]: symbol-grain evidence whose OWNING FILE is a real file-mode graph node survives filtering (acceptExercises rescue still fires)", async () => {
    const src = "export function exclusiveFn() {}\n";
    const tmp = makeRepo(
      {
        "src/foo.ts": src,
        "specs/spec.md": "# Fixture\n\n- REQ-950: exclusiveFn is exercised (file-mode graph).\n",
      },
      { mode: "file", trace: { acceptExercises: true } },
    );
    // No testPatterns trickery here — src/foo.ts is a perfectly normal graph
    // member. `ingestTrace`'s SymbolNameTable still resolves the hit at
    // SYMBOL grain (`symbol:src/foo.ts#exclusiveFn`) regardless of the
    // graph's own `mode: "file"` (see `src/trace/symbol-table.ts`'s header
    // comment) — a naive `graph.nodes.has(id)` filter would treat that
    // symbol id as a ghost (file-mode graphs have zero `symbol:` nodes) and
    // wrongly drop real evidence. `resolveTraceGraphNodeId`'s file-grain
    // degrade must keep it.
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-950] exercises exclusiveFn",
        testFile: "tests/req950.test.ts",
        hits: [{ file: "src/foo.ts", fn: "exclusiveFn" }],
        hashes: { "src/foo.ts": hashContent(src) },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    const req950 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-950");
    expect(req950.status).toBe("exercised");
    expect(result.uncovered).not.toContain("REQ-950");
  });

  it("A-T4b [over-filter prevention, symbol mode]: evidence whose exact node id already exists in a symbol-mode graph is unaffected by filtering", async () => {
    const tmp = makeRepo({
      "src/bar.ts": [
        "export function claimedFn() {",
        "  // @impl REQ-951",
        "}",
        "",
        "export function suggestedFn() {}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-951] exercises claimedFn",
        testFile: "tests/req951.test.ts",
        hits: [{ file: "src/bar.ts", fn: "claimedFn" }],
      }),
      testLine({
        testName: "[REQ-952] exercises suggestedFn",
        testFile: "tests/req952.test.ts",
        hits: [{ file: "src/bar.ts", fn: "suggestedFn" }],
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.corroborated).toEqual([
      { reqId: "REQ-951", node: "symbol:src/bar.ts#claimedFn" },
    ]);
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-952", node: "symbol:src/bar.ts#suggestedFn" },
    ]);
  });

  it("A-T4c [F2 rekey pin, file mode]: kept evidence is rekeyed to the resolved graph id — no `symbol:` id ever surfaces from a file-mode graph, and same-file evidence merges to file-level exclusivity", async () => {
    const fooSrc = "export function soloFn() {}\n";
    const barSrc = ["export function fnA() {}", "", "export function fnB() {}", ""].join("\n");
    const tmp = makeRepo(
      {
        "src/foo.ts": fooSrc,
        "src/bar.ts": barSrc,
        "specs/spec.md": [
          "# Fixture",
          "",
          "- REQ-960: soloFn (exclusive, expect a FILE-id suggestion).",
          "- REQ-961: fnA (shares src/bar.ts with REQ-962 after degrade).",
          "- REQ-962: fnB (shares src/bar.ts with REQ-961 after degrade).",
          "",
        ].join("\n"),
      },
      { mode: "file" },
    );
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-960] exercises soloFn",
        testFile: "tests/req960.test.ts",
        hits: [{ file: "src/foo.ts", fn: "soloFn" }],
      }),
      testLine({
        testName: "[REQ-961] exercises fnA",
        testFile: "tests/req961.test.ts",
        hits: [{ file: "src/bar.ts", fn: "fnA" }],
      }),
      testLine({
        testName: "[REQ-962] exercises fnB",
        testFile: "tests/req962.test.ts",
        hits: [{ file: "src/bar.ts", fn: "fnB" }],
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    // F2 pin: a file-mode graph has zero `symbol:` nodes, so once
    // `filterTraceToGraph` REKEYS (not just filters) kept evidence, no
    // `symbol:` id may survive into any report field.
    expect(stdout).not.toContain('"symbol:');
    const result = JSON.parse(stdout);
    // soloFn's evidence degrades to `file:src/foo.ts`, exercised exclusively
    // by REQ-960 → suggested at the FILE id (pre-F2 this reported the
    // graph-nonexistent `symbol:src/foo.ts#soloFn`).
    expect(result.suggestedImpls).toEqual([{ reqId: "REQ-960", node: "file:src/foo.ts" }]);
    // fnA/fnB merge onto `file:src/bar.ts` (degrade union): two distinct
    // REQs now share one node, so exclusivity is judged at FILE grain and
    // neither is suggested (2 < default sharedThreshold 3 → not
    // infrastructure either; silent) — file-level exclusivity is the correct
    // semantics for a file-grain graph.
    expect(result.infrastructure).toEqual([]);
  });

  it("A-T5 [closed by #350]: src/ghost.ts's evidence is no longer filtered out — diagnostics.offGraph is 0 (json and text)", async () => {
    const tmp = makeGhostFixture();
    const { stdout: jsonOut, exitCode } = await runAt(tmp, ["trace", "status", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(jsonOut);
    expect(result.diagnostics.offGraph).toBe(0);

    const { stdout: textOut } = await runAt(tmp, ["trace", "status"]);
    expect(textOut).toContain("offGraph:      0");
  });

  it("A-T6 [closed by #350]: staleness: exclude — src/ghost.ts's evidence is real, so acceptExercises: true rescues REQ-900 to `exercised` here too", async () => {
    const tmp = makeGhostFixture({ trace: { staleness: "exclude", acceptExercises: true } });
    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    const req900 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-900");
    expect(req900.status).toBe("exercised");
    expect(result.uncovered).not.toContain("REQ-900");
    expect(result.staleEvidence).toEqual([]);
  });
});

// issue #350 — positive regression pin: the exact `testPatterns`-only
// negative-pattern config every fixture above uses can no longer produce a
// ghost node at all (see the describe block's header comment). This directly
// exercises `filterTraceToGraph`'s `offGraph` count (rather than a
// downstream symptom) as the most direct possible pin of that closure.
describe("issue #350 — testPatterns-only negative pattern no longer produces any offGraph trace evidence", () => {
  it("offGraph stays 0 across acceptExercises/staleness variants", async () => {
    for (const traceConfig of [
      {},
      { acceptExercises: true },
      { staleness: "exclude" as const },
      { staleness: "gate" as const },
    ]) {
      const tmp = makeGhostFixture({ trace: traceConfig });
      try {
        const { stdout, exitCode } = await runAt(tmp, ["trace", "status", "--format", "json"]);
        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.diagnostics.offGraph).toBe(0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});

// PR #355 meta-review (M3) — every fixture above (`makeGhostFixture`) uses
// `testPatterns: ["!src/ghost.ts"]`: a pool with NO positive pattern at all.
// `globCodeFiles` (src/parsers/typescript.ts) short-circuits to `[]`
// whenever a pattern list's own positive matches are empty (issue #266's
// early return), so that negative pattern never gets a chance to exclude
// anything from a non-empty pool in the first place — every assertion above
// holds regardless of whether pool-scoped negation inside a REAL pool (one
// with a positive pattern too) actually works. This block instead uses a
// realistic config — `testPatterns: ["src/**/*.test.ts", "!src/legacy/**"]`,
// mirroring `tests/issue-350-pool-separation.test.ts`'s own repro — and pins
// the full trace ingestion path (`buildSymbolNameTable`, `filterTraceToGraph`,
// shard evidence resolution via `check`/`trace report`/`trace status`)
// against it end to end.
//
//   (a) src/legacy/orphan.test.ts — named and worded exactly like a test
//       file (it even carries a `[REQ-900]`-style title in its own source
//       text), and matches testPatterns' own positive pattern
//       (`src/**/*.test.ts`) by name. It still gets excluded from the
//       testPatterns POOL by that pool's own negative pattern
//       (`!src/legacy/**`) — but it also matches `include`
//       (`src/**/*.ts`), so it survives as an ordinary kind:"file" graph
//       member (post-#350 pool separation), and `buildSymbolNameTable`
//       (include-only discovery) sees it too.
//   (b) src/normal.test.ts — an ordinary test file, unaffected by the
//       legacy negation. Proves testPatterns' positive pattern is doing
//       real work elsewhere in this same fixture (kind:"test" + a real
//       `verifies` edge), not just coincidentally matching via `include`.
//   (c) src/normal.ts — an ordinary src file: the trace's second evidence
//       target, a plain include-pool control with no testPatterns
//       involvement at all.
function makeRealisticPoolFixture(configExtra: Record<string, unknown> = {}): string {
  const orphanTestContent =
    "export function legacyFn() {}\n\n" +
    `describe("[${"REQ-900"}] orphan", () => {\n` +
    '  it("calls legacyFn", () => {\n' +
    "    legacyFn();\n" +
    "  });\n" +
    "});\n";
  const normalTestContent =
    'import { normalFn } from "./normal.js";\n\n' +
    `describe("[${"REQ-902"}] normal", () => {\n` +
    '  it("calls normalFn", () => {\n' +
    "    normalFn();\n" +
    "  });\n" +
    "});\n";
  const normalSrcContent = "export function normalFn() {}\n";

  const tmp = makeRepo(
    {
      "src/legacy/orphan.test.ts": orphanTestContent,
      "src/normal.test.ts": normalTestContent,
      "src/normal.ts": normalSrcContent,
      "specs/spec.md":
        "# Fixture\n\n" +
        "- REQ-900: reached only via src/legacy/orphan.test.ts's trace evidence " +
        "(pool-excluded-from-testPatterns file).\n" +
        "- REQ-901: reached only via src/normal.ts's trace evidence " +
        "(plain include-pool file).\n",
    },
    {
      include: ["src/**/*.ts", "!**/node_modules/**"],
      testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
      ...configExtra,
    },
  );
  writeShard(tmp, "w1.jsonl", [
    metaLine(),
    testLine({
      testName: `[${"REQ-900"}] exercises legacyFn via the pool-excluded legacy file`,
      testFile: "tests/req900.test.ts",
      hits: [{ file: "src/legacy/orphan.test.ts", fn: "legacyFn" }],
      hashes: { "src/legacy/orphan.test.ts": hashContent(orphanTestContent) },
    }),
    testLine({
      testName: `[${"REQ-901"}] exercises normalFn via a plain include-pool file`,
      testFile: "tests/req901.test.ts",
      hits: [{ file: "src/normal.ts", fn: "normalFn" }],
      hashes: { "src/normal.ts": hashContent(normalSrcContent) },
    }),
  ]);
  return tmp;
}

describe("PR #355 meta-review (M3) — realistic testPatterns pool (positive pattern + pool-scoped negative pattern) trace ingestion", () => {
  it("M3-T1: pool separation keeps (a) a real, non-ghost graph member with NO verifies edge (negative pattern proven to actually apply), and acceptExercises rescues both REQs to exercised with offGraph 0", async () => {
    const tmp = makeRealisticPoolFixture({ trace: { acceptExercises: true } });
    try {
      const config: ArtgraphConfig = {
        include: ["src/**/*.ts", "!**/node_modules/**"],
        specDirs: ["specs"],
        testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
        mode: "symbol",
        lockFile: ".trace.lock",
      };

      // (1) pool separation: (a) survives as kind:"file" via `include` even
      // though testPatterns' own negative pattern drops it from the
      // testPatterns pool; (b) is a normal kind:"test" member, proving the
      // pool's positive pattern still does real work elsewhere.
      const { graph } = buildGraph(tmp, config);
      expect(graph.nodes.get("file:src/legacy/orphan.test.ts")?.kind).toBe("file");
      expect(graph.nodes.get("file:src/normal.test.ts")?.kind).toBe("test");
      // Symbol-mode decomposition of (a) as an ordinary (non-test) file
      // produces the exact node id `buildSymbolNameTable` will resolve the
      // trace hit to — so it is structurally impossible for this hit to be
      // a ghost.
      expect(graph.nodes.has("symbol:src/legacy/orphan.test.ts#legacyFn")).toBe(true);

      // (3) discriminating power: despite (a)'s source text carrying a
      // `[REQ-900]`-style test title (the same shape that gives (b) its
      // `verifies` edge below), (a) has NO `verifies` edge at all — proof
      // the pool's negative pattern actually excluded it from test
      // classification, not merely that it "happens" to still resolve.
      expect(
        graph.edges.some(
          (e) => e.kind === "verifies" && e.source === "file:src/legacy/orphan.test.ts",
        ),
      ).toBe(false);
      expect(
        graph.edges.some((e) => e.kind === "verifies" && e.source === "file:src/normal.test.ts"),
      ).toBe(true);

      // `buildSymbolNameTable` is include-only discovery (never testPatterns)
      // — (a) is in scope regardless of its testPatterns-pool exclusion, and
      // resolves the hit at symbol grain, matching the graph node above.
      const { table } = buildSymbolNameTable(tmp, config.include, config.testPatterns);
      expect(table.hasFile("src/legacy/orphan.test.ts")).toBe(true);
      expect(table.resolve("src/legacy/orphan.test.ts", "legacyFn")).toEqual({
        kind: "symbol",
        id: "symbol:src/legacy/orphan.test.ts#legacyFn",
      });

      // (2) end-to-end: neither REQ has an `@impl` anywhere, so (like A-T1)
      // `acceptExercises: true` is the only path to `exercised` — proving
      // the trace evidence for both (a) and (c) actually reached `check`.
      const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      const req900 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-900");
      const req901 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-901");
      expect(req900.status).toBe("exercised");
      expect(req901.status).toBe("exercised");
      expect(result.uncovered).not.toContain("REQ-900");
      expect(result.uncovered).not.toContain("REQ-901");

      // offGraph stays 0 — neither (a)'s nor (c)'s evidence was dropped as a
      // ghost by `filterTraceToGraph`.
      const { stdout: statusOut } = await runAt(tmp, ["trace", "status", "--format", "json"]);
      const statusResult = JSON.parse(statusOut);
      expect(statusResult.diagnostics.offGraph).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("M3-T2: same fixture without acceptExercises — trace report classifies both REQs' exclusive evidence as suggestedImpls (existing A-T3 convention), and (a) still has no verifies edge", async () => {
    const tmp = makeRealisticPoolFixture();
    try {
      const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.suggestedImpls).toEqual(
        expect.arrayContaining([
          { reqId: "REQ-900", node: "symbol:src/legacy/orphan.test.ts#legacyFn" },
          { reqId: "REQ-901", node: "symbol:src/normal.ts#normalFn" },
        ]),
      );

      // Re-pin the negative-pattern discriminating power on this variant
      // too: (a) must not have been reclassified as a test.
      const config: ArtgraphConfig = {
        include: ["src/**/*.ts", "!**/node_modules/**"],
        specDirs: ["specs"],
        testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
        mode: "symbol",
        lockFile: ".trace.lock",
      };
      const { graph } = buildGraph(tmp, config);
      expect(graph.nodes.get("file:src/legacy/orphan.test.ts")?.kind).toBe("file");
      expect(
        graph.edges.some(
          (e) => e.kind === "verifies" && e.source === "file:src/legacy/orphan.test.ts",
        ),
      ).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
