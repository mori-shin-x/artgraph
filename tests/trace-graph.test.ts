// spec 020 (tasks.md T014, data-model.md §4, spec.md US1 acceptance
// scenarios 1/2/4/5/6, FR-006〜011) — Red tests fixing how coverage-derived
// `exercises` edges fold into `buildGraph`'s output. Fixtures are temp
// projects with hand-written TS sources + specs + hand-written shard JSONL
// (no real vitest execution needed — mirrors `tests/trace-cli.test.ts` /
// `tests/trace-ingest.test.ts`'s fixture style).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { graphToJSON } from "../src/graph/format.js";
import { buildLockFromGraph } from "../src/lock.js";
import { check } from "../src/check.js";
import { findOrphans, findUncovered } from "../src/graph/traverse.js";
import { computeCoverage } from "../src/coverage.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";
import type { ArtgraphConfig, GraphEdge } from "../src/types.js";

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

const BASE_CONFIG: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
  mode: "symbol",
};

function makeRepo(files: Record<string, string>): string {
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-trace-graph-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
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

function exercisesEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => e.kind === "exercises");
}

// ---------------------------------------------------------------------------
// (a) US1-1/2/4/5/6 — acceptance scenarios
// ---------------------------------------------------------------------------

describe("trace-graph (T014a): US1 acceptance scenarios", () => {
  it("US1-1: @impl-zero project — exercises edges land on the right REQ, no cross-contamination", () => {
    const tmp = makeRepo({
      "src/auth.ts": [
        "export function signIn() {}",
        "",
        "export function resetPassword() {}",
        "",
      ].join("\n"),
      "specs/spec.md": [
        "# Fixture",
        "",
        "- REQ-001: signIn authenticates a user.",
        "- REQ-002: resetPassword resets a user's password.",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] signs in",
        testFile: "tests/req001.test.ts",
        hits: [{ file: "src/auth.ts", fn: "signIn" }],
      }),
      testLine({
        testName: "[REQ-002] resets password",
        testFile: "tests/req002.test.ts",
        hits: [{ file: "src/auth.ts", fn: "resetPassword" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);
    const exEdges = exercisesEdges(graph.edges);

    expect(exEdges).toContainEqual({
      source: "REQ-001",
      target: "symbol:src/auth.ts#signIn",
      kind: "exercises",
      provenances: ["coverage"],
    });
    expect(exEdges).toContainEqual({
      source: "REQ-002",
      target: "symbol:src/auth.ts#resetPassword",
      kind: "exercises",
      provenances: ["coverage"],
    });

    // No cross-contamination: REQ-001 never reaches resetPassword and
    // vice-versa.
    expect(
      exEdges.some(
        (e) => e.source === "REQ-001" && e.target === "symbol:src/auth.ts#resetPassword",
      ),
    ).toBe(false);
    expect(
      exEdges.some((e) => e.source === "REQ-002" && e.target === "symbol:src/auth.ts#signIn"),
    ).toBe(false);
    expect(exEdges).toHaveLength(2);
  });

  it("US1-2 / SC-002: same files + same trace, scanned twice, are byte-identical", () => {
    const tmp = makeRepo({
      "src/auth.ts": "export function signIn() {}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-001: signIn authenticates a user.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] signs in",
        testFile: "tests/req001.test.ts",
        hits: [{ file: "src/auth.ts", fn: "signIn" }],
      }),
    ]);

    const run1 = graphToJSON(buildGraph(tmp, BASE_CONFIG).graph);
    const run2 = graphToJSON(buildGraph(tmp, BASE_CONFIG).graph);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it("US1-4: N:M union — REQ-001's exercises set is the union across its 3 tagged tests", () => {
    const tmp = makeRepo({
      "src/session.ts": [
        "export function signIn() {}",
        "",
        "export function refreshToken() {}",
        "",
        "export function logout() {}",
        "",
      ].join("\n"),
      "specs/spec.md": "# Fixture\n\n- REQ-001: session lifecycle.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] signs in",
        testFile: "tests/a.test.ts",
        hits: [{ file: "src/session.ts", fn: "signIn" }],
      }),
      testLine({
        testName: "[REQ-001] refreshes token",
        testFile: "tests/b.test.ts",
        hits: [{ file: "src/session.ts", fn: "refreshToken" }],
      }),
      testLine({
        testName: "[REQ-001] logs out",
        testFile: "tests/c.test.ts",
        hits: [{ file: "src/session.ts", fn: "logout" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);
    const targets = exercisesEdges(graph.edges)
      .filter((e) => e.source === "REQ-001")
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual([
      "symbol:src/session.ts#logout",
      "symbol:src/session.ts#refreshToken",
      "symbol:src/session.ts#signIn",
    ]);
  });

  it("US1-5: name ambiguity in the same file falls back to a file-grain edge, no symbol edge", () => {
    const tmp = makeRepo({
      "src/widget.ts": [
        "export function ambiguousName() {}",
        "",
        "export class Widget {",
        "  ambiguousName() {}",
        "}",
        "",
      ].join("\n"),
      "specs/spec.md": "# Fixture\n\n- REQ-050: widget behavior.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-050] does the ambiguous thing",
        testFile: "tests/req050.test.ts",
        hits: [{ file: "src/widget.ts", fn: "ambiguousName" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);
    const targets = exercisesEdges(graph.edges)
      .filter((e) => e.source === "REQ-050")
      .map((e) => e.target);
    expect(targets).toEqual(["file:src/widget.ts"]);
    expect(targets.some((t) => t.startsWith("symbol:"))).toBe(false);
  });

  it("US1-6: module-init-only test (no hits) never produces an exercises edge", () => {
    const tmp = makeRepo({
      "src/init.ts": "export function neverCalledByTest() {}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-060: module init behavior.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      // Runner already excludes module-init hits (FR-007) — a module-init-
      // only test's shard record simply has empty hits.
      testLine({
        testName: "[REQ-060] imports the module",
        testFile: "tests/req060.test.ts",
        hits: [],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);
    expect(exercisesEdges(graph.edges).filter((e) => e.source === "REQ-060")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) declaration x evidence exclusivity (FR-008)
// ---------------------------------------------------------------------------

describe("trace-graph (T014b): declared @impl x evidence exclusivity (FR-008)", () => {
  it("claim + evidence on the SAME (req, symbol) pair: implements gains coverage, no separate exercises edge", () => {
    const tmp = makeRepo({
      "src/billing.ts": ["export function charge() {", "  // @impl REQ-100", "}", ""].join("\n"),
      "specs/spec.md": "# Fixture\n\n- REQ-100: charge bills a customer.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-100] charges the customer",
        testFile: "tests/req100.test.ts",
        hits: [{ file: "src/billing.ts", fn: "charge" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);

    const implementsEdge = graph.edges.find(
      (e) =>
        e.kind === "implements" &&
        e.source === "symbol:src/billing.ts#charge" &&
        e.target === "REQ-100",
    );
    expect(implementsEdge).toBeDefined();
    expect(implementsEdge!.provenances).toEqual(["code-tag", "coverage"]);

    // No independent `exercises` edge for the SAME pair.
    expect(
      graph.edges.some(
        (e) =>
          e.kind === "exercises" &&
          e.source === "REQ-100" &&
          e.target === "symbol:src/billing.ts#charge",
      ),
    ).toBe(false);
  });

  it("evidence-only pair (no @impl anywhere): exercises edge only, no implements edge is fabricated", () => {
    const tmp = makeRepo({
      "src/billing.ts": ["export function refund() {}", ""].join("\n"),
      "specs/spec.md": "# Fixture\n\n- REQ-101: refund reimburses a customer.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-101] refunds the customer",
        testFile: "tests/req101.test.ts",
        hits: [{ file: "src/billing.ts", fn: "refund" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);

    expect(
      graph.edges.some(
        (e) =>
          e.kind === "exercises" &&
          e.source === "REQ-101" &&
          e.target === "symbol:src/billing.ts#refund",
      ),
    ).toBe(true);
    expect(graph.edges.some((e) => e.kind === "implements" && e.target === "REQ-101")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) trace absent — byte-identical to pre-feature output (FR-010, US1-3)
// ---------------------------------------------------------------------------

describe("trace-graph (T014c): trace absent is a full no-op (FR-010 / US1-3)", () => {
  it("no trace dir vs an EMPTY trace dir produce byte-identical graph JSON, and neither has exercises edges", () => {
    const files = {
      "src/auth.ts": "export function signIn() {\n  // @impl REQ-001\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-001: signIn authenticates a user.\n",
    };

    const withoutTraceDir = makeRepo(files);
    const withEmptyTraceDir = makeRepo(files);
    mkdirSync(join(withEmptyTraceDir, ".artgraph", "trace"), { recursive: true });

    const graphA = graphToJSON(buildGraph(withoutTraceDir, BASE_CONFIG).graph);
    const graphB = graphToJSON(buildGraph(withEmptyTraceDir, BASE_CONFIG).graph);

    expect(JSON.stringify(graphA)).toBe(JSON.stringify(graphB));
    expect(graphA.edges.some((e) => e.kind === "exercises")).toBe(false);
    expect(graphB.edges.some((e) => e.kind === "exercises")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) determinism — restated at the top level (shard read order shuffled)
// ---------------------------------------------------------------------------

describe("trace-graph (T014d): determinism across repeated scans", () => {
  it("scanning the same files + shards twice produces byte-identical graph JSON", () => {
    const tmp = makeRepo({
      "src/a.ts": "export function fnA() {}\n",
      "src/b.ts": "export function fnB() {}\n",
      "specs/spec.md": [
        "# Fixture",
        "",
        "- REQ-010: fnA does a thing.",
        "- REQ-011: fnB does a thing.",
        "",
      ].join("\n"),
    });
    // Two shards (simulating two worker files) — order of files on disk
    // shouldn't matter (ingest sorts shard paths before reading).
    writeShard(tmp, "w2.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-011] exercises fnB",
        testFile: "tests/b.test.ts",
        hits: [{ file: "src/b.ts", fn: "fnB" }],
      }),
    ]);
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-010] exercises fnA",
        testFile: "tests/a.test.ts",
        hits: [{ file: "src/a.ts", fn: "fnA" }],
      }),
    ]);

    const first = graphToJSON(buildGraph(tmp, BASE_CONFIG).graph);
    const second = graphToJSON(buildGraph(tmp, BASE_CONFIG).graph);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const exEdges = first.edges.filter((e) => e.kind === "exercises");
    expect(exEdges).toEqual([
      {
        source: "REQ-010",
        target: "symbol:src/a.ts#fnA",
        kind: "exercises",
        provenances: ["coverage"],
      },
      {
        source: "REQ-011",
        target: "symbol:src/b.ts#fnB",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Constraint regression: Phase B adds `exercises` edges to the graph, but
// `check`/`coverage.ts`/`findOrphans`/`findUncovered` must NOT consume them
// yet (that's Phase C, T019/T020 — gated behind `trace.acceptExercises`).
// Pins that a REQ with ONLY an `exercises` edge (no `implements`) still
// shows up as `uncovered`/`untagged`, and that `exercises` edges never
// surface as orphans (they intentionally point at a real, existing node
// here — the orphan-worthy failure mode covered elsewhere is a fabricated
// target, which `findOrphans` doesn't even look at since it filters by
// kind).
// ---------------------------------------------------------------------------

describe("trace-graph: exercises edges do not leak into the check pipeline (Phase B constraint)", () => {
  it("a REQ with only an exercises edge (no @impl) stays untagged/uncovered", () => {
    const tmp = makeRepo({
      "src/billing.ts": "export function refund() {}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-101: refund reimburses a customer.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-101] refunds the customer",
        testFile: "tests/req101.test.ts",
        hits: [{ file: "src/billing.ts", fn: "refund" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);
    // Sanity: the exercises edge really is in the graph for this REQ.
    expect(graph.edges.some((e) => e.kind === "exercises" && e.source === "REQ-101")).toBe(true);

    expect(findUncovered(graph)).toContain("REQ-101");
    expect(findOrphans(graph)).toEqual([]);

    const coverage = computeCoverage(graph);
    const req101 = coverage.find((c) => c.reqId === "REQ-101");
    expect(req101?.status).toBe("untagged");
    expect(req101?.implFiles).toEqual([]);

    const lock = buildLockFromGraph(graph);
    const result = check(graph, lock);
    expect(result.uncovered).toContain("REQ-101");
    expect(result.orphans).toEqual([]);
  });

  it("check()/coverage()/findOrphans()/findUncovered() output is unaffected by exercises edges beyond the pre-existing implements/verifies pass-through", () => {
    const filesWithTrace = {
      "src/billing.ts": "export function charge() {\n  // @impl REQ-100\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-100: charge bills a customer.\n",
    };
    const tmpNoTrace = makeRepo(filesWithTrace);
    const tmpWithTrace = makeRepo(filesWithTrace);
    writeShard(tmpWithTrace, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-100] charges the customer",
        testFile: "tests/req100.test.ts",
        hits: [{ file: "src/billing.ts", fn: "charge" }],
      }),
    ]);

    const graphNoTrace = buildGraph(tmpNoTrace, BASE_CONFIG).graph;
    const graphWithTrace = buildGraph(tmpWithTrace, BASE_CONFIG).graph;
    // Sanity: the trace run really does carry a coverage-provenance edge the
    // no-trace run lacks (the implements edge, corroborated).
    expect(
      graphWithTrace.edges.find((e) => e.kind === "implements" && e.target === "REQ-100")
        ?.provenances,
    ).toEqual(["code-tag", "coverage"]);
    expect(
      graphNoTrace.edges.find((e) => e.kind === "implements" && e.target === "REQ-100")
        ?.provenances,
    ).toEqual(["code-tag"]);

    // Every OTHER check/coverage output field is identical between the two
    // runs — the only difference `check`/`coverage` see is the (pre-existing,
    // spec-011) provenances array on the implements edge itself, which
    // `check()`'s CheckResult / `computeCoverage()`'s CoverageEntry don't
    // even surface (they report req ids / file lists, not provenances).
    const lockNoTrace = buildLockFromGraph(graphNoTrace);
    const lockWithTrace = buildLockFromGraph(graphWithTrace);
    const resultNoTrace = check(graphNoTrace, lockNoTrace);
    const resultWithTrace = check(graphWithTrace, lockWithTrace);
    expect(resultWithTrace.orphans).toEqual(resultNoTrace.orphans);
    expect(resultWithTrace.uncovered).toEqual(resultNoTrace.uncovered);
    expect(resultWithTrace.coverage).toEqual(resultNoTrace.coverage);
    expect(resultWithTrace.pass).toEqual(resultNoTrace.pass);

    expect(computeCoverage(graphWithTrace)).toEqual(computeCoverage(graphNoTrace));
    expect(findUncovered(graphWithTrace)).toEqual(findUncovered(graphNoTrace));
    expect(findOrphans(graphWithTrace)).toEqual(findOrphans(graphNoTrace));
  });
});
