// spec 020 (tasks.md T021, contracts/cli-surface.md §5, data-model.md §4,
// spec.md US3, FR-017/018) — Red tests fixing `impact`'s `exercises`-edge
// traversal, provenance output, and `--tests` test-impact-analysis flag.
//
// (a)-(c) are CLI-level (`runAt`, temp git repo + hand-written shard JSONL —
// mirrors `tests/check-evidence.test.ts` / `tests/trace-cli.test.ts`).
// (d)-(f) use hand-built `ArtifactGraph`s and call `impact()` directly
// (mirrors `tests/traverse.test.ts`'s style) for tight control over BFS
// reachability and the spec 019 `contains`-direction-constraint interaction,
// WITHOUT editing `tests/traverse.test.ts` itself (T021(e): existing spec 019
// tests must stay green, unedited).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runAt, gitInit, gitCommitAll } from "./helpers.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";
import { TRACE_NO_SHARDS_GUIDANCE } from "../src/commands/shared.js";
import { impact } from "../src/graph/traverse.js";
import type { ArtifactGraph, GraphNode, GraphEdge, LockFile } from "../src/types.js";

// ---------------------------------------------------------------------------
// CLI-fixture helpers (same convention as tests/check-evidence.test.ts).
// ---------------------------------------------------------------------------

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
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-impact-evidence-")));
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

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
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

// ---------------------------------------------------------------------------
// (a) US3-1: --diff --tests lists exactly the exclusively-exercising REQ's
// tagged tests.
// ---------------------------------------------------------------------------

describe("impact-evidence (T021a, US3-1): --diff --tests lists only the exclusively-exercising REQ's tagged tests", () => {
  it("charge changed, exercised exclusively by REQ-003 -> testsToRun == REQ-003's tagged tests only", async () => {
    const originalBilling = ["export function charge() {", "  // @impl REQ-004", "}", ""].join(
      "\n",
    );
    const tmp = makeRepo({
      "src/billing.ts": originalBilling,
      "specs/spec.md": [
        "# Fixture",
        "",
        "- REQ-003: charge bills a positive amount (evidence-only).",
        "- REQ-004: charge bills a positive amount (declared).",
        "",
      ].join("\n"),
    });
    gitInit(tmp);
    gitCommitAll(tmp, "init");

    // Uncommitted edit to charge's body ONLY — this is the working-tree diff
    // `impact --diff` picks up. The `@impl REQ-004` tag survives the edit
    // (REQ-004 stays a declared/static claim).
    const editedBilling = [
      "export function charge() {",
      "  // @impl REQ-004",
      "  // billing logic edited after the commit",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(tmp, "src/billing.ts"), editedBilling, "utf-8");

    // Trace captured against the CURRENT (edited) content: REQ-003's tagged
    // test exclusively exercises `charge`; REQ-004 has no tagged test at all
    // (its claim is purely declared/static).
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-003] charge bills a positive amount",
        testFile: "tests/billing.test.ts",
        hits: [{ file: "src/billing.ts", fn: "charge" }],
        hashes: { "src/billing.ts": hashOf(editedBilling) },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, [
      "impact",
      "--diff",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.testsToRun).toEqual([
      {
        testFile: "tests/billing.test.ts",
        testName: "[REQ-003] charge bills a positive amount",
        reqId: "REQ-003",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// (a2) US3-1 in FILE mode (regression, coordinator repro 2026-07-10): in a
// default-mode (file) project the graph has no symbol nodes, so `--diff`
// startIds resolve to `file:<path>` — but `ingestTrace`'s `reqsByNode` is
// keyed at SYMBOL grain regardless of graph mode (the ingest-side name table
// resolves `hits` names from source text, independent of `.artgraph.json`'s
// `mode`; it is `src/graph/builder.ts` that later degrades the edge target
// to file grain when merging into a file-mode graph). An exact-id lookup of
// startIds against `reqsByNode` therefore NEVER matches in file mode and
// `testsToRun` silently comes back `[]` even though `impactReqs` /
// `reqProvenance` prove the evidence path is intact. FR-018 doesn't restrict
// grain — file mode must work too.
// ---------------------------------------------------------------------------

describe("impact-evidence (T021a2, US3-1 file-mode regression): --diff --tests works in a default (file-mode) project", () => {
  it("file-grain changed node + symbol-grain evidence keys -> REQ-003's tagged test is still listed", async () => {
    const originalBilling = ["export function charge() {}", ""].join("\n");
    const tmp = makeRepo(
      {
        "src/billing.ts": originalBilling,
        "src/util.ts": "export function validateEmail() {}\n",
        "specs/spec.md": [
          "# Fixture",
          "",
          "- REQ-003: charge bills a positive amount.",
          "- REQ-005: validateEmail (exercised via util.ts, NOT in the diff).",
          "",
        ].join("\n"),
      },
      { mode: "file" }, // explicit, but identical to omitting `mode` (default)
    );
    gitInit(tmp);
    gitCommitAll(tmp, "init");

    // Working-tree edit to billing.ts only — util.ts stays untouched, so
    // REQ-005 (which exercises ONLY util.ts) must NOT contribute tests.
    const editedBilling = [
      "export function charge() {",
      "  // billing logic edited after the commit",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(tmp, "src/billing.ts"), editedBilling, "utf-8");

    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-003] charge bills a positive amount",
        testFile: "tests/billing.test.ts",
        hits: [{ file: "src/billing.ts", fn: "charge" }],
        hashes: { "src/billing.ts": hashOf(editedBilling) },
      }),
      testLine({
        testName: "[REQ-005] validates an email",
        testFile: "tests/util.test.ts",
        hits: [{ file: "src/util.ts", fn: "validateEmail" }],
        hashes: { "src/util.ts": hashOf("export function validateEmail() {}\n") },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, [
      "impact",
      "--diff",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    // Updated for #286: reverse exercises traversal is blocked, so a
    // file-start impact no longer reaches REQ-003 through the graph-level
    // BFS. `--tests` still surfaces REQ-003's tests below via the separate
    // `ingestedTrace.reqsByNode` path, which is BFS-independent. Evidence-only
    // REQ recovery in `impactReqs` from the symbol/file side is tracked as
    // #298 (provenance-aware reverse traversal follow-up).
    expect(result.impactReqs).not.toContain("REQ-003");

    expect(result.testsToRun).toEqual([
      {
        testFile: "tests/billing.test.ts",
        testName: "[REQ-003] charge bills a positive amount",
        reqId: "REQ-003",
      },
    ]);
    // Precision is preserved: REQ-005 exercises only src/util.ts, which is
    // not in the diff — its test must not be swept in by the grain fix.
    expect(result.testsToRun.some((t: { reqId: string }) => t.reqId === "REQ-005")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) US3-2: static-only vs evidence-only REQ, both reachable, distinguished
// by provenance.
// ---------------------------------------------------------------------------

describe("impact-evidence (T021b, US3-2, updated for #286): static REQ reachable from symbol; evidence-only REQ is NOT (reverse exercises blocked, see #298 follow-up)", () => {
  it("REQ-004 (declared @impl) -> reachable with provenance ['static']; REQ-003 (evidence only) -> NOT reachable from symbol side (reverse exercises blocked by #286)", async () => {
    const billing = ["export function charge() {", "  // @impl REQ-004", "}", ""].join("\n");
    const tmp = makeRepo({
      "src/billing.ts": billing,
      "specs/spec.md": [
        "# Fixture",
        "",
        "- REQ-003: charge (evidence-only).",
        "- REQ-004: charge (declared).",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-003] exercises charge",
        testFile: "tests/billing.test.ts",
        hits: [{ file: "src/billing.ts", fn: "charge" }],
        hashes: { "src/billing.ts": hashOf(billing) },
      }),
    ]);

    const { stdout, exitCode } = await runAt(tmp, [
      "impact",
      "src/billing.ts:charge",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    // Updated for #286: reverse exercises traversal is blocked, so REQ-003
    // (evidence-only, reached only through reverse exercises pre-fix) is no
    // longer in `impactReqs` when starting from the symbol. REQ-004 remains
    // (forward implements). The `evidence` provenance bucket is now populated
    // only when the evidence path is also reached forward (REQ -> node), or
    // through a different path — not from symbol-side starts. #298 tracks
    // provenance-aware reverse traversal that would restore evidence-only
    // REQ reachability without reopening the #286 sibling-REQ leak.
    expect(result.impactReqs).toEqual(["REQ-004"]);
    const byReq: Record<string, string[]> = {};
    for (const p of result.reqProvenance ?? []) byReq[p.reqId] = p.provenance;
    expect(byReq["REQ-004"]).toEqual(["static"]);
    expect(byReq["REQ-003"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) US3-3 / FR-018: no shards + --tests -> exit 1 + shared guidance
// (identical string to `trace report`'s zero-shard error).
// ---------------------------------------------------------------------------

describe("impact-evidence (T021c, US3-3/FR-018): --tests with zero trace shards", () => {
  it("exits 1 with TRACE_NO_SHARDS_GUIDANCE (same wording as `trace report`)", async () => {
    const tmp = makeRepo({ "src/x.ts": "export function foo() {}\n" });
    const { stdout, stderr, exitCode } = await runAt(tmp, [
      "impact",
      "--diff",
      "--tests",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(TRACE_NO_SHARDS_GUIDANCE);
  });

  it("`impact --diff` WITHOUT --tests does not require a trace at all", async () => {
    const tmp = makeRepo({ "src/x.ts": "export function foo() {\n  // @impl REQ-001\n}\n" });
    gitInit(tmp);
    gitCommitAll(tmp, "init");
    writeFileSync(join(tmp, "src/x.ts"), "export function foo() {\n  // @impl REQ-001\n  1;\n}\n");
    const { exitCode } = await runAt(tmp, ["impact", "--diff", "--format", "json"]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (d)-(f): hand-built graphs, direct impact() calls — precise control over
// BFS + spec 019 interaction, no dependency on the CLI/scan pipeline.
// ---------------------------------------------------------------------------

function node(id: string, kind: GraphNode["kind"], filePath: string, hash = "h"): GraphNode {
  return { id, kind, filePath, contentHash: hash };
}

describe("impact-evidence (T021d, ⑥edge case, FR-017): staleness=exclude drops stale exercises edges from traversal; warn keeps them", () => {
  function buildGraph(): ArtifactGraph {
    const nodes = new Map<string, GraphNode>([
      ["REQ-010", node("REQ-010", "req", "specs/x.md")],
      ["symbol:src/x.ts#fn", node("symbol:src/x.ts#fn", "symbol", "src/x.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "REQ-010",
        target: "symbol:src/x.ts#fn",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    return { nodes, edges };
  }

  it("warn (no exclusion set passed): symbol -> REQ via reverse exercises is BLOCKED (updated for #286 fix — was reachable pre-#286)", () => {
    // Pre-#286: reverse exercises made REQ-010 reachable from the symbol.
    // Post-#286: `exercises` is forward-only (REQ->symbol), so a symbol-start
    // BFS no longer walks backwards to the REQ. The stale-exclusion pathway
    // (below) short-circuits the same edge in a different way, so both
    // "warn" and "exclude" now converge on `impactReqs === []` when starting
    // from the symbol side. See traverse.ts's file-header comment for #286.
    const graph = buildGraph();
    const result = impact(graph, ["symbol:src/x.ts#fn"], {} as LockFile);
    expect(result.impactReqs).toEqual([]);
  });

  it("exclude: the stale exercises edge is skipped entirely, REQ-010 is NOT reachable", () => {
    const graph = buildGraph();
    const result = impact(graph, ["symbol:src/x.ts#fn"], {} as LockFile, undefined, {
      excludeStaleExercises: new Set(["symbol:src/x.ts#fn"]),
    });
    expect(result.impactReqs).toEqual([]);
  });

  it("exclude, traversal from the REQ side (forward): the REQ cannot reach the stale symbol either", () => {
    const graph = buildGraph();
    const result = impact(graph, ["REQ-010"], {} as LockFile, undefined, {
      excludeStaleExercises: new Set(["symbol:src/x.ts#fn"]),
    });
    expect(result.affectedFiles).toEqual([]);
  });
});

describe("impact-evidence (T021f, updated for #286): exercises edges traverse ONLY forward (req->node); reverse (node->req) is skipped to prevent sibling-REQ leak from incidentally-called symbols", () => {
  it("req -> exercises -> symbol (forward) reaches the symbol's file", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-020", node("REQ-020", "req", "specs/x.md")],
      ["symbol:src/y.ts#fn", node("symbol:src/y.ts#fn", "symbol", "src/y.ts")],
      ["file:src/y.ts", node("file:src/y.ts", "file", "src/y.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "REQ-020",
        target: "symbol:src/y.ts#fn",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["REQ-020"], {} as LockFile);
    expect(result.affectedFiles).toEqual(["src/y.ts"]);
  });

  it("symbol -> (reverse exercises) is now BLOCKED — starting from an incidentally-exercised symbol does NOT reach the REQ (#286 fix)", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-021", node("REQ-021", "req", "specs/x.md")],
      ["symbol:src/z.ts#fn", node("symbol:src/z.ts#fn", "symbol", "src/z.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "REQ-021",
        target: "symbol:src/z.ts#fn",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/z.ts#fn"], {} as LockFile);
    expect(result.impactReqs).toEqual([]);
  });

  it("spec 019 pin: a doc `contains`-ing two sibling REQs, one reached via `implements`, the other only via a DIFFERENT REQ's `exercises` edge elsewhere — impacting the implements-side symbol must NOT drag the sibling (or its exercises target) in, exercises edges present in the graph notwithstanding", () => {
    const nodes = new Map<string, GraphNode>([
      ["doc:spec", node("doc:spec", "doc", "specs/spec.md")],
      ["REQ-A", node("REQ-A", "req", "specs/spec.md")],
      ["REQ-B", node("REQ-B", "req", "specs/spec.md")],
      ["symbol:src/a.ts#fnA", node("symbol:src/a.ts#fnA", "symbol", "src/a.ts")],
      ["symbol:src/b.ts#fnB", node("symbol:src/b.ts#fnB", "symbol", "src/b.ts")],
    ]);
    const edges: GraphEdge[] = [
      { source: "doc:spec", target: "REQ-A", kind: "contains", provenances: ["structural"] },
      { source: "doc:spec", target: "REQ-B", kind: "contains", provenances: ["structural"] },
      {
        source: "symbol:src/a.ts#fnA",
        target: "REQ-A",
        kind: "implements",
        provenances: ["code-tag"],
      },
      // REQ-B is exercised by evidence pointing at a DIFFERENT, unrelated
      // symbol — this is the exact shape that would leak through the old
      // (pre spec-019) bidirectional `contains` traversal: doc:spec would be
      // reached via REQ-A's attribution, then (if `contains` were reverse-
      // traversable) walked forward again into REQ-B, then REQ-B's
      // `exercises` edge would drag fnB in too.
      {
        source: "REQ-B",
        target: "symbol:src/b.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/a.ts#fnA"], {} as LockFile);

    expect(result.impactReqs).toEqual(["REQ-A"]);
    expect(result.impactReqs).not.toContain("REQ-B");
    expect(result.affectedFiles).not.toContain("src/b.ts");
    // Attribution still surfaces the shared parent doc (spec 019 behavior,
    // unaffected by the exercises edge elsewhere in the graph).
    expect(result.affectedDocs).toEqual(["doc:spec"]);
  });
});

describe("impact-evidence (#286 regression): reverse `exercises` traversal does not drag sibling REQs whose tests incidentally exercise a symbol", () => {
  // Reproduces the exact scenario from #286: fnB is @impl-claimed by REQ-902
  // only, but a REQ-901 test happens to call fnB for side verification. Before
  // this fix, `impact(symbol:fnB)` returned both REQ-901 and REQ-902. After
  // the fix (traverse.ts forward-only for `exercises`), only REQ-902 remains.
  const setup = () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnA", node("symbol:src/sample.ts#fnA", "symbol", "src/sample.ts")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
    ]);
    const edges: GraphEdge[] = [
      // @impl claims (static)
      {
        source: "symbol:src/sample.ts#fnA",
        target: "REQ-901",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "symbol:src/sample.ts#fnB",
        target: "REQ-902",
        kind: "implements",
        provenances: ["code-tag"],
      },
      // Coverage-derived exercises edges: REQ-901's test called both fnA (its own impl)
      // AND fnB (incidental "verify state" call). REQ-902's test called fnB.
      {
        source: "REQ-901",
        target: "symbol:src/sample.ts#fnA",
        kind: "exercises",
        provenances: ["coverage"],
      },
      {
        source: "REQ-901",
        target: "symbol:src/sample.ts#fnB", // incidental
        kind: "exercises",
        provenances: ["coverage"],
      },
      {
        source: "REQ-902",
        target: "symbol:src/sample.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    return { nodes, edges };
  };

  it("impact(fnB) returns ONLY REQ-902 (its @impl claim), NOT REQ-901 (the incidental exerciser)", () => {
    const { nodes, edges } = setup();
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-902"]);
    expect(result.impactReqs).not.toContain("REQ-901");
  });

  it("impact(fnA) still returns REQ-901 via the forward @impl / implements edge — but a residual forward cascade also carries REQ-902 in (documented, tracked as #298)", () => {
    // Path: fnA -(forward implements)-> REQ-901 -(forward exercises)-> fnB
    // -(forward implements)-> REQ-902. Option A skips REVERSE exercises but
    // preserves FORWARD, so the cascade "REQ -> incidentally-exercised symbol
    // -> that symbol's OTHER @impl claim" still leaks. Provenance-aware
    // reverse traversal (#298) is the intended follow-up that would also
    // cut this cascade by skipping forward-exercises hops into symbols whose
    // @impl belongs to a different REQ. Pinning current behavior so any
    // change to it is intentional.
    const { nodes, edges } = setup();
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnA"], {} as LockFile);
    expect(result.impactReqs.sort()).toEqual(["REQ-901", "REQ-902"]);
  });

  it("impact(REQ-901) still forward-follows exercises: fnA and fnB (as executed by REQ-901's test) are BOTH in affectedFiles's src/sample.ts", () => {
    const { nodes, edges } = setup();
    const result = impact({ nodes, edges }, ["REQ-901"], {} as LockFile);
    // Both fnA and fnB live in src/sample.ts, so affectedFiles collapses to one entry.
    expect(result.affectedFiles).toEqual(["src/sample.ts"]);
  });
});

// ---------------------------------------------------------------------------
// (e) ⑦ regression: JSON schema is unchanged when the graph has zero
// exercises edges (trace-absent scans); trace-absent impact output stays
// byte-identical. Existing tests/traverse.test.ts is NOT touched — this is a
// pin living alongside it.
// ---------------------------------------------------------------------------

describe("impact-evidence (T021e, ⑦regression): trace-absent impact output is byte-identical, reqProvenance/testsToRun are omitted entirely", () => {
  it("no trace dir vs an empty trace dir: byte-identical impact --format json, neither has reqProvenance/testsToRun", async () => {
    const files = {
      "src/plain.ts": "export function plainFn() {\n  // @impl REQ-800\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-800: plainFn does a thing.\n",
    };
    const withoutTraceDir = makeRepo(files);
    const withEmptyTraceDir = makeRepo(files);
    mkdirSync(join(withEmptyTraceDir, ".artgraph", "trace"), { recursive: true });

    const args = ["impact", "src/plain.ts", "--format", "json"];
    const runA = await runAt(withoutTraceDir, args);
    const runB = await runAt(withEmptyTraceDir, args);
    expect(runA.stdout).toBe(runB.stdout);

    const resultA = JSON.parse(runA.stdout);
    expect(Object.prototype.hasOwnProperty.call(resultA, "reqProvenance")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(resultA, "testsToRun")).toBe(false);
  });

  it("impact() called directly on a graph with NO exercises edges never sets reqProvenance", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-030", node("REQ-030", "req", "specs/x.md")],
      ["symbol:src/w.ts#fn", node("symbol:src/w.ts#fn", "symbol", "src/w.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/w.ts#fn",
        target: "REQ-030",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/w.ts#fn"], {} as LockFile);
    expect(result.reqProvenance).toBeUndefined();
  });
});
