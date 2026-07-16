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

describe("trace-ghost-nodes (#275): filterTraceToGraph drops nodes the graph doesn't have", () => {
  it("A-T1 [gate false-green pin]: acceptExercises: true + staleness: warn — a ghost node's evidence never rescues its REQ to `exercised`; it stays uncovered", async () => {
    const tmp = makeGhostFixture({ trace: { acceptExercises: true } });
    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    const req900 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-900");
    expect(req900.status).toBe("untagged");
    expect(result.uncovered).toContain("REQ-900");
    expect(result.exercisableUncovered).not.toContain("REQ-900");
  });

  it("A-T2 [gate false-red pin]: staleness: gate — a ghost node's hashesAtTrace entry does not trip the staleness gate (exit 2)", async () => {
    // REQ-900 also gets a REAL `@impl` on a REAL (non-ghost) function so the
    // fixture has ZERO other scoped issues (mirrors the isolation technique
    // `check-evidence.test.ts`'s "T019f" staleness=gate fixture uses) — the
    // only possible cause of a gate failure here is the ghost's stale-looking
    // hashesAtTrace entry, were it not filtered out first.
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
        // Deliberately wrong hash — if the ghost's hashesAtTrace entry
        // survived filtering, `computeStaleNodeIds` would ALSO already treat
        // it as stale simply because `file:src/ghost.ts` doesn't exist in
        // the graph at all (see its own "owning file no longer exists"
        // fallback), independent of the hash value chosen here.
        hashes: { "src/ghost.ts": "0000000000000000" },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json", "--gate"]);
    const result = JSON.parse(stdout);

    expect(result.staleEvidence).toEqual([]);
    expect(result.staleGate).toBe(false);
    expect(exitCode).toBe(0);
  });

  it("A-T3 [symptom pin]: a ghost node never appears in any trace report finding (corroborated/unexercisedClaims/suggestedImpls/infrastructure)", async () => {
    const tmp = makeGhostFixture();
    const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    const allNodes = [
      ...result.corroborated.map((p: { node: string }) => p.node),
      ...result.unexercisedClaims.map((p: { node: string }) => p.node),
      ...result.suggestedImpls.map((p: { node: string }) => p.node),
      ...result.infrastructure.map((i: { node: string }) => i.node),
    ];
    expect(allNodes.some((n) => n.includes("ghost"))).toBe(false);
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

  it("A-T5 [diagnostics]: the ghost node dropped by filtering is counted in diagnostics.offGraph (json and text)", async () => {
    const tmp = makeGhostFixture();
    const { stdout: jsonOut, exitCode } = await runAt(tmp, ["trace", "status", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(jsonOut);
    expect(result.diagnostics.offGraph).toBe(1);

    const { stdout: textOut } = await runAt(tmp, ["trace", "status"]);
    expect(textOut).toContain("offGraph:      1");
  });

  it("A-T6 [staleness: exclude — no regression]: the pre-existing incidental exclusion of ghost evidence (computeStaleNodeIds' 'owning file not in graph' fallback) still holds once the explicit #275 filter runs first", async () => {
    const tmp = makeGhostFixture({ trace: { staleness: "exclude", acceptExercises: true } });
    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    const req900 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-900");
    expect(req900.status).toBe("untagged");
    expect(result.uncovered).toContain("REQ-900");
    expect(result.staleEvidence).toEqual([]);
  });
});
