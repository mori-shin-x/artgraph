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

    // Updated for #286 Option 2B (PR #299 meta-review Finding 2): REQ-003
    // has no `@impl` anywhere in this fixture (evidence-only), so reverse
    // `exercises` traversal is now ALLOWED for it — the file-start impact
    // DOES reach REQ-003 through the graph-level BFS (unlike a REQ that also
    // carries an `implements` edge, which stays blocked per #286). `--tests`
    // independently surfaces REQ-003's tests below via the separate
    // `ingestedTrace.reqsByNode` path, which is BFS-independent either way.
    expect(result.impactReqs).toContain("REQ-003");

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

describe("impact-evidence (T021b, US3-2, updated for #286 Option 2B / PR #299 Finding 2): static REQ reachable from symbol via implements; evidence-only REQ is ALSO reachable via the now-conditional reverse exercises allowance", () => {
  it("REQ-004 (declared @impl) -> reachable with provenance ['static']; REQ-003 (evidence only, no @impl anywhere) -> ALSO reachable from symbol side with provenance ['evidence'] (Option 2B)", async () => {
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

    // Updated for #286 Option 2B (PR #299 meta-review Finding 2): reverse
    // `exercises` traversal is blocked only for a REQ that has an
    // `implements` edge somewhere in the graph — REQ-004 has one (so if it
    // were ALSO the source of a reverse-followed exercises edge, that would
    // stay blocked), but REQ-003 has none anywhere (true evidence-only, the
    // `acceptExercises: true` workflow), so the symbol-start BFS now reaches
    // it too. REQ-004 remains reachable via forward `implements`. Both
    // entries carry their own single provenance bucket here: REQ-004 is
    // ['static'] (implements only), REQ-003 is ['evidence'] (exercises
    // only) — no sibling-REQ leak occurs because REQ-003's only edge in the
    // whole graph is its own exercises edge to this exact symbol.
    expect(result.impactReqs.sort()).toEqual(["REQ-003", "REQ-004"]);
    const byReq: Record<string, string[]> = {};
    for (const p of result.reqProvenance ?? []) byReq[p.reqId] = p.provenance;
    expect(byReq["REQ-004"]).toEqual(["static"]);
    expect(byReq["REQ-003"]).toEqual(["evidence"]);
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

describe("impact-evidence (T021d, ⑥edge case, FR-017, updated for #286 Option 2B): staleness=exclude drops stale exercises edges from traversal REGARDLESS of the Option 2B reverse-allowance; a non-stale evidence-only REQ's reverse exercises is otherwise reachable", () => {
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

  it("warn (no exclusion set passed): symbol -> REQ via reverse exercises is ALLOWED (Option 2B — REQ-010 has no implements edge anywhere, so it's evidence-only)", () => {
    // Pre-#286: reverse exercises made REQ-010 reachable from the symbol.
    // #286 then blocked reverse `exercises` unconditionally. Option 2B (PR
    // #299 Finding 2) narrows that block to REQs that have an `implements`
    // edge somewhere in the graph — REQ-010 has none, so it's evidence-only
    // and the reverse walk is allowed again, restoring reachability for
    // exactly this case without reopening the sibling-REQ leak (a REQ with
    // its own `@impl` claim stays blocked in reverse; see the T021b /
    // #286-regression describe blocks for that contrast). The stale-
    // exclusion pathway (below) still short-circuits the SAME edge
    // unconditionally, so "warn" and "exclude" diverge here: "warn" now
    // reaches REQ-010, "exclude" still does not. See traverse.ts's
    // file-header comment for the full #286 / Option 2B rationale.
    const graph = buildGraph();
    const result = impact(graph, ["symbol:src/x.ts#fn"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-010"]);
  });

  it("exclude: the stale exercises edge is skipped entirely, REQ-010 is NOT reachable (staleness exclusion wins over the Option 2B allowance)", () => {
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

describe("impact-evidence (T021f, updated for #286 Option 2B): exercises edges traverse forward always, and reverse (node->req) only for a REQ with no `implements` edge anywhere (evidence-only) — a REQ with an @impl claim stays reverse-blocked to prevent the sibling-REQ leak from incidentally-called symbols", () => {
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

  it("symbol -> (reverse exercises) stays BLOCKED when the REQ has an `implements` claim elsewhere (#286 leak class, unaffected by Option 2B) — starting from an incidentally-exercised symbol does NOT reach the REQ", () => {
    // REQ-021 has a real `@impl` claim on a DIFFERENT symbol (fnOwn), so it
    // is NOT evidence-only — this is exactly the #286 leak shape (a REQ
    // reachable through its own claim must not ALSO be reachable in reverse
    // through an incidentally-exercised sibling symbol). Option 2B's
    // conditional allowance only applies to REQs with NO `implements` edge
    // anywhere, so this case is unaffected by it and stays blocked.
    const nodes = new Map<string, GraphNode>([
      ["REQ-021", node("REQ-021", "req", "specs/x.md")],
      ["symbol:src/z.ts#fnOwn", node("symbol:src/z.ts#fnOwn", "symbol", "src/z.ts")],
      ["symbol:src/z.ts#fn", node("symbol:src/z.ts#fn", "symbol", "src/z.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/z.ts#fnOwn",
        target: "REQ-021",
        kind: "implements",
        provenances: ["code-tag"],
      },
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

  it("symbol -> (reverse exercises) is ALLOWED when the REQ is evidence-only (no `implements` edge anywhere, Option 2B) — starting from the exercised symbol DOES reach the REQ", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-022", node("REQ-022", "req", "specs/x.md")],
      ["symbol:src/z2.ts#fn", node("symbol:src/z2.ts#fn", "symbol", "src/z2.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "REQ-022",
        target: "symbol:src/z2.ts#fn",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/z2.ts#fn"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-022"]);
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

  it("impact(fnA) still returns REQ-901 via the forward @impl / implements edge — but a residual forward cascade also carries REQ-902 in (documented, tracked as #300)", () => {
    // Path: fnA -(forward implements)-> REQ-901 -(forward exercises)-> fnB
    // -(forward implements)-> REQ-902. Option A skips REVERSE exercises but
    // preserves FORWARD, so the cascade "REQ -> incidentally-exercised symbol
    // -> that symbol's OTHER @impl claim" still leaks. This forward-cascade
    // closure is tracked as #300 — a distinct follow-up from #298 (which
    // covers reverse traversal re-enable / Option C only, per PR #299's
    // meta-review Finding 1). Closing #300 would skip forward-exercises hops
    // into symbols whose @impl belongs to a different REQ. Pinning current
    // behavior so any change to it is intentional.
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

describe("impact-evidence (#286 Option 2B): evidence-only REQ (no @impl) is still reachable via reverse exercises so check --diff --gate does not silently drop it", () => {
  it("impact(symbol) reaches an evidence-only REQ (no implements edge for it)", () => {
    // Setup: REQ-500 has NO @impl claim — only an exercises edge from
    // running its test. This is the acceptExercises: true workflow.
    const nodes = new Map<string, GraphNode>([
      ["REQ-500", node("REQ-500", "req", "specs/x.md")],
      ["symbol:src/x.ts#fn", node("symbol:src/x.ts#fn", "symbol", "src/x.ts")],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "REQ-500",
        target: "symbol:src/x.ts#fn",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/x.ts#fn"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-500"]);
  });

  it("impact(symbol:fnB) still does NOT drag REQ-901 in (the #286 case, REQ-901 has an @impl claim on fnA)", () => {
    // Same as the earlier #286 regression setup but explicit here so a future
    // refactor of the earlier block doesn't accidentally weaken this pin.
    const nodes = new Map<string, GraphNode>([
      ["REQ-901", node("REQ-901", "req", "specs/x.md")],
      ["REQ-902", node("REQ-902", "req", "specs/x.md")],
      ["symbol:src/sample.ts#fnA", node("symbol:src/sample.ts#fnA", "symbol", "src/sample.ts")],
      ["symbol:src/sample.ts#fnB", node("symbol:src/sample.ts#fnB", "symbol", "src/sample.ts")],
    ]);
    const edges: GraphEdge[] = [
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
      {
        source: "REQ-901",
        target: "symbol:src/sample.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const result = impact({ nodes, edges }, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).toEqual(["REQ-902"]);
    expect(result.impactReqs).not.toContain("REQ-901");
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
