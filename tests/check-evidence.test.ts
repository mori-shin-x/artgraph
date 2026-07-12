// spec 020 (tasks.md T019, contracts/cli-surface.md §4, data-model.md §6/§7,
// spec.md US2/US4/US5) — Red tests fixing the `check` findings + `exercised`
// status + staleness decision matrix. CLI-level fixtures follow
// `tests/trace-cli.test.ts` / `tests/trace-graph.test.ts`'s established
// style (temp repo, hand-written shard JSONL, `runAt` in-process harness);
// a handful of surgical cases (verified-status precedence, threshold-vs-
// exclusivity independence, failing-test non-evidence) use a hand-built
// `ArtifactGraph` + `IngestedTrace` and call `check()` directly for tighter
// control, mirroring `tests/traverse.test.ts` / `tests/check.test.ts`.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runAt } from "./helpers.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";
import { check } from "../src/check.js";
import type { ArtifactGraph, LockFile, TestResultMap, GraphNode, GraphEdge } from "../src/types.js";
import type { IngestedTrace } from "../src/trace/ingest.js";

// ---------------------------------------------------------------------------
// Shared CLI-fixture helpers (verbatim style of tests/trace-cli.test.ts).
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
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-check-evidence-")));
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
// (a) full decision matrix — trace present/absent x acceptExercises on/off x
// staleness warn/exclude/gate x --gate on/off (US2-1..6 / US4-1..3 / US5-1..3)
// ---------------------------------------------------------------------------
//
// One shared fixture exercises every branch of FR-012/013 at once:
//   REQ-001 -> claimFn      : FALSE @impl, REQ-001's own test never hits it
//                                                          -> unexercisedClaims
//   REQ-002 -> exclusiveFn  : no @impl, exclusive               -> suggestedImpls / exercised
//   REQ-003 -> pairFn       : real @impl AND REQ-003's test hits it (US2-4)
//                                                          -> corroborated (no finding)
//   REQ-004 -> failOnlyFn   : no @impl, ONLY a FAILING REQ-004 test hits it
//                             (US2-6) -> zero evidence, no finding at all
//   REQ-010/011/012 -> sharedFn (3 reqs, default sharedThreshold) -> infra,
//                             never suggestedImpls, never exercised
//   REQ-020/021 -> silentFn (2 reqs, below default threshold) -> silent:
//                             appears in NO check finding, and (per FR-014's
//                             literal "reqCount == 1" wording) NOT exercised
//                             either — exclusivity, not "non-infra", gates
//                             `exercised`.

const APP_TS = [
  "export function claimFn() {",
  "  // @impl REQ-001",
  "}",
  "",
  "export function exclusiveFn() {}",
  "",
  "export function pairFn() {",
  "  // @impl REQ-003",
  "}",
  "",
  "export function failOnlyFn() {}",
  "",
  "export function sharedFn() {}",
  "",
  "export function silentFn() {}",
  "",
].join("\n");

const SPEC_MD = [
  "# Fixture spec",
  "",
  "- REQ-001: claimFn does the claimed thing.",
  "- REQ-002: exclusiveFn is exclusively exercised.",
  "- REQ-003: pairFn is declared and exercised.",
  "- REQ-004: failOnlyFn is only reached by a failing test.",
  "- REQ-010: uses sharedFn (a).",
  "- REQ-011: uses sharedFn (b).",
  "- REQ-012: uses sharedFn (c).",
  "- REQ-020: uses silentFn (a).",
  "- REQ-021: uses silentFn (b).",
  "",
].join("\n");

function mainFixtureShardLines(fileHash: string): string[] {
  const hashes = { "src/app.ts": fileHash };
  return [
    metaLine(),
    testLine({
      testName: "[REQ-001] claims falsely",
      testFile: "tests/req001.test.ts",
      hits: [],
      hashes,
    }),
    testLine({
      testName: "[REQ-002] exercises exclusiveFn",
      testFile: "tests/req002.test.ts",
      hits: [{ file: "src/app.ts", fn: "exclusiveFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-003] exercises pairFn",
      testFile: "tests/req003.test.ts",
      hits: [{ file: "src/app.ts", fn: "pairFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-004] fails while touching failOnlyFn",
      testFile: "tests/req004.test.ts",
      passed: false,
      hits: [{ file: "src/app.ts", fn: "failOnlyFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-010] a",
      testFile: "tests/req010.test.ts",
      hits: [{ file: "src/app.ts", fn: "sharedFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-011] b",
      testFile: "tests/req011.test.ts",
      hits: [{ file: "src/app.ts", fn: "sharedFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-012] c",
      testFile: "tests/req012.test.ts",
      hits: [{ file: "src/app.ts", fn: "sharedFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-020] a",
      testFile: "tests/req020.test.ts",
      hits: [{ file: "src/app.ts", fn: "silentFn" }],
      hashes,
    }),
    testLine({
      testName: "[REQ-021] b",
      testFile: "tests/req021.test.ts",
      hits: [{ file: "src/app.ts", fn: "silentFn" }],
      hashes,
    }),
  ];
}

function makeMainFixture(configExtra: Record<string, unknown> = {}): string {
  const tmp = makeRepo({ "src/app.ts": APP_TS, "specs/spec.md": SPEC_MD }, configExtra);
  writeShard(tmp, "w1.jsonl", mainFixtureShardLines(hashOf(APP_TS)));
  return tmp;
}

describe("check-evidence (T019a): findings + status matrix — trace present, acceptExercises off (default)", () => {
  it("--format json: unexercisedClaims / suggestedImpls appear; corroborated pair and failing-test coverage emit NO finding; shared/silent bands excluded from suggestedImpls; coverage status unaffected (acceptExercises off)", async () => {
    const tmp = makeMainFixture();
    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.unexercisedClaims).toContainEqual({
      reqId: "REQ-001",
      node: "symbol:src/app.ts#claimFn",
    });
    expect(result.suggestedImpls).toContainEqual({
      reqId: "REQ-002",
      node: "symbol:src/app.ts#exclusiveFn",
    });

    const allPairs = [...result.unexercisedClaims, ...result.suggestedImpls].map(
      (p: { node: string }) => p.node,
    );
    // US2-4: declared + exercised on the SAME pair -> corroborated, no finding.
    expect(allPairs).not.toContain("symbol:src/app.ts#pairFn");
    // US2-6: the only evidence for failOnlyFn comes from a FAILING test ->
    // never counted as evidence at all, so no finding of any kind names it.
    expect(allPairs).not.toContain("symbol:src/app.ts#failOnlyFn");
    // Shared (>= sharedThreshold) never suggested.
    expect(result.suggestedImpls.some((p: { node: string }) => p.node.includes("sharedFn"))).toBe(
      false,
    );
    // Silent band (2 reqs, below default threshold 3) never suggested either.
    expect(result.suggestedImpls.some((p: { node: string }) => p.node.includes("silentFn"))).toBe(
      false,
    );

    // acceptExercises defaults to false: REQ-002's status is untouched
    // despite its exclusive evidence, and it remains in `uncovered`.
    const req002 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-002");
    expect(req002.status).toBe("untagged");
    expect(result.uncovered).toContain("REQ-002");

    // Fresh trace (hashes match current file content) -> no stale evidence.
    expect(result.staleEvidence).toEqual([]);
  });

  it("--format text: UNEXERCISED CLAIM: / SUGGESTED IMPL: / STALE EVIDENCE: headings (contracts/cli-surface.md §4)", async () => {
    const tmp = makeMainFixture();
    const { stdout, exitCode } = await runAt(tmp, ["check"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("UNEXERCISED CLAIM:");
    expect(stdout).toContain("REQ-001 -> symbol:src/app.ts#claimFn");
    expect(stdout).toContain("SUGGESTED IMPL:");
    expect(stdout).toContain("REQ-002 -> symbol:src/app.ts#exclusiveFn");
    expect(stdout).not.toContain("STALE EVIDENCE:");
  });
});

describe("check-evidence (T019a/d, US4-1/2): acceptExercises toggling — untagged <-> exercised", () => {
  it("acceptExercises: false (default) -> REQ-002 stays untagged/uncovered (US4-1)", async () => {
    const tmp = makeMainFixture({ trace: { acceptExercises: false } });
    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);
    const req002 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-002");
    expect(req002.status).toBe("untagged");
    expect(result.uncovered).toContain("REQ-002");
  });

  it("acceptExercises: true -> REQ-002 becomes exercised and leaves uncovered (US4-2); shared/silent bands stay untagged (exclusivity, not merely non-infra, gates exercised)", async () => {
    const tmp = makeMainFixture({ trace: { acceptExercises: true } });
    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    const req002 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-002");
    expect(req002.status).toBe("exercised");
    expect(result.uncovered).not.toContain("REQ-002");

    for (const reqId of ["REQ-010", "REQ-011", "REQ-012", "REQ-020", "REQ-021"]) {
      const entry = result.coverage.find((c: { reqId: string }) => c.reqId === reqId);
      expect(entry.status).toBe("untagged");
      expect(result.uncovered).toContain(reqId);
    }

    // REQ-001's claim is unexercised, not exercised (it retains its declared
    // implFiles, so it is never eligible for `exercised` regardless of
    // acceptExercises — the rescue only applies to fully-untagged REQs).
    const req001 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-001");
    expect(req001.status).toBe("impl-only");
  });
});

describe("check-evidence (T019d/US4-3): a REQ with @impl + passing verifies + exercises stays verified, not downgraded/relabeled", () => {
  it("verified status takes precedence over exercised (unit-level, direct check() call)", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-900", { id: "REQ-900", kind: "req", filePath: "specs/x.md", contentHash: "h1" }],
      [
        "file:src/x.ts",
        { id: "file:src/x.ts", kind: "file", filePath: "src/x.ts", contentHash: "hfile" },
      ],
      [
        "symbol:src/x.ts#fn",
        { id: "symbol:src/x.ts#fn", kind: "symbol", filePath: "src/x.ts", contentHash: "h3" },
      ],
      [
        "test:tests/x.test.ts",
        {
          id: "test:tests/x.test.ts",
          kind: "test",
          filePath: "tests/x.test.ts",
          contentHash: "h4",
        },
      ],
    ]);
    const edges: GraphEdge[] = [
      {
        source: "symbol:src/x.ts#fn",
        target: "REQ-900",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: "test:tests/x.test.ts",
        target: "REQ-900",
        kind: "verifies",
        provenances: ["annotation"],
      },
      {
        source: "REQ-900",
        target: "symbol:src/x.ts#fn",
        kind: "exercises",
        provenances: ["coverage"],
      },
    ];
    const graph: ArtifactGraph = { nodes, edges };
    const lock: LockFile = {};
    const testResults: TestResultMap = new Map([
      ["REQ-900", [{ reqId: "REQ-900", testName: "t", passed: true }]],
    ]);
    const trace: IngestedTrace = {
      perReq: new Map([
        [
          "REQ-900",
          {
            symbols: ["symbol:src/x.ts#fn"],
            files: [],
            tests: [{ testFile: "tests/x.test.ts", testName: "t" }],
          },
        ],
      ]),
      hashesAtTrace: new Map(),
      diagnostics: { dangling: 0, corrupted: 0, skipped: 0, unknownSchema: 0 },
      reqsByNode: new Map([["symbol:src/x.ts#fn", new Set(["REQ-900"])]]),
      shardCount: 1,
    };

    const result = check(graph, lock, undefined, testResults, undefined, false, {
      trace,
      staleNodeIds: new Set(),
      acceptExercises: true,
      staleness: "warn",
      sharedThreshold: 3,
    });

    expect(result.coverage.find((c) => c.reqId === "REQ-900")?.status).toBe("verified");
    // REQ-900 has a real @impl claim + matching evidence -> corroborated,
    // not unexercisedClaims/suggestedImpls.
    expect(result.unexercisedClaims).toEqual([]);
    expect(result.suggestedImpls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) ③ state transitions — fresh -> stale -> regenerate -> clears
// (US5-1/2/4, data-model.md §9 lifecycle)
// ---------------------------------------------------------------------------

describe("check-evidence (T019b): staleness lifecycle — fresh -> stale -> regenerate -> clears", () => {
  it("US5-1/4: staleEvidence appears after the symbol's owning file is edited (hash mismatch) and clears once a fresh shard is written", async () => {
    const originalSrc = "export function staleFn() {}\n";
    const tmp = makeRepo({
      "src/stale.ts": originalSrc,
      "specs/spec.md": "# Fixture\n\n- REQ-500: staleFn does a thing.\n",
    });
    // Trace captured while file content == originalSrc: hashes match.
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-500] exercises staleFn",
        testFile: "tests/req500.test.ts",
        hits: [{ file: "src/stale.ts", fn: "staleFn" }],
        hashes: { "src/stale.ts": hashOf(originalSrc) },
      }),
    ]);

    const fresh = await runAt(tmp, ["check", "--format", "json"]);
    const freshResult = JSON.parse(fresh.stdout);
    expect(freshResult.staleEvidence).toEqual([]);
    expect(fresh.exitCode).toBe(0);

    // Edit the symbol's owning file WITHOUT touching the shard — trace is
    // now stale relative to the current graph.
    const editedSrc = "export function staleFn() {\n  // edited after trace capture\n}\n";
    writeFileSync(join(tmp, "src/stale.ts"), editedSrc, "utf-8");

    const stale = await runAt(tmp, ["check", "--format", "json"]);
    const staleResult = JSON.parse(stale.stdout);
    expect(staleResult.staleEvidence).toEqual([
      { reqId: "REQ-500", symbols: ["symbol:src/stale.ts#staleFn"] },
    ]);
    // staleness defaults to "warn": exit code is unaffected.
    expect(stale.exitCode).toBe(0);

    // Regenerate: rewrite the shard (world replacement, not append) with the
    // hash of the CURRENT content — simulates re-running the test suite.
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-500] exercises staleFn",
        testFile: "tests/req500.test.ts",
        hits: [{ file: "src/stale.ts", fn: "staleFn" }],
        hashes: { "src/stale.ts": hashOf(editedSrc) },
      }),
    ]);

    const regenerated = await runAt(tmp, ["check", "--format", "json"]);
    const regeneratedResult = JSON.parse(regenerated.stdout);
    expect(regeneratedResult.staleEvidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) ① exclusivity boundaries — 1 (suggested) / 2..threshold-1 (silent) /
// >= threshold (infra); `exercised` eligibility depends ONLY on exclusivity
// (=1), never on `sharedThreshold` (SC-004 / FR-013 ruling, verified above
// too via silentFn/sharedFn staying untagged with acceptExercises:true).
// ---------------------------------------------------------------------------

describe("check-evidence (T019c): sharedThreshold boundary reclassifies suggestedImpls without touching exercised eligibility", () => {
  it("sharedThreshold: 1 pushes even an exclusive (1-req) node into infrastructure -> suggestedImpls is empty, but exercised status is UNCHANGED (exclusivity-only rule)", async () => {
    const tmp = makeMainFixture({ trace: { sharedThreshold: 1, acceptExercises: true } });
    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    // threshold=1: reqCount(1) >= sharedThreshold(1) for EVERY exercised
    // node, so nothing is left in the 1-exclusive suggestedImpls band.
    expect(result.suggestedImpls).toEqual([]);

    // exercised eligibility is untouched: REQ-002 (exclusiveFn) is still the
    // sole exerciser of its node, so it is STILL rescued to `exercised`.
    const req002 = result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-002");
    expect(req002.status).toBe("exercised");
  });

  it("sharedThreshold: 10 moves the 3-req sharedFn OUT of infrastructure into the silent band — still never suggestedImpls, still never exercised", async () => {
    const tmp = makeMainFixture({ trace: { sharedThreshold: 10, acceptExercises: true } });
    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.suggestedImpls.some((p: { node: string }) => p.node.includes("sharedFn"))).toBe(
      false,
    );
    for (const reqId of ["REQ-010", "REQ-011", "REQ-012"]) {
      expect(result.coverage.find((c: { reqId: string }) => c.reqId === reqId)?.status).toBe(
        "untagged",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (e) ⑤ all-tests-failed trace: zero evidence effect, uncovered unchanged
// ---------------------------------------------------------------------------

describe("check-evidence (T019e): a trace whose only tagged test is failing contributes ZERO evidence", () => {
  it("REQ-700 stays uncovered/untagged even with acceptExercises: true — failing coverage never counts (US2-6 restated at the coverage-status level)", async () => {
    const tmp = makeRepo(
      {
        "src/onlyfail.ts": "export function onlyFn() {}\n",
        "specs/spec.md": "# Fixture\n\n- REQ-700: onlyFn is only reached by a failing run.\n",
      },
      { trace: { acceptExercises: true } },
    );
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-700] a CI-red run",
        testFile: "tests/req700.test.ts",
        passed: false,
        hits: [{ file: "src/onlyfail.ts", fn: "onlyFn" }],
        hashes: { "src/onlyfail.ts": hashOf("export function onlyFn() {}\n") },
      }),
    ]);

    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.uncovered).toContain("REQ-700");
    expect(result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-700")?.status).toBe(
      "untagged",
    );
    expect(result.suggestedImpls).toEqual([]);
    expect(result.unexercisedClaims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) ④ trace absent: zero findings fields, byte-identical output (US2-5 /
// FR-010 / G1)
// ---------------------------------------------------------------------------

describe("check-evidence (T019d/regression): trace-absent output never carries the new finding keys, and is byte-identical with vs without an EMPTY trace dir", () => {
  it("no trace dir vs an empty trace dir: byte-identical check --format json output, and neither has unexercisedClaims/suggestedImpls/staleEvidence/staleGate", async () => {
    const files = {
      "src/plain.ts": "export function plainFn() {\n  // @impl REQ-800\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-800: plainFn does a thing.\n",
    };
    const withoutTraceDir = makeRepo(files);
    const withEmptyTraceDir = makeRepo(files);
    mkdirSync(join(withEmptyTraceDir, ".artgraph", "trace"), { recursive: true });

    const a = await runAt(withoutTraceDir, ["check", "--format", "json"]);
    const b = await runAt(withEmptyTraceDir, ["check", "--format", "json"]);
    expect(a.stdout).toBe(b.stdout);

    const resultA = JSON.parse(a.stdout);
    for (const key of ["unexercisedClaims", "suggestedImpls", "staleEvidence", "staleGate"]) {
      expect(Object.prototype.hasOwnProperty.call(resultA, key)).toBe(false);
    }
  });

  it("text output has none of the new headings when trace is absent", async () => {
    const tmp = makeRepo({
      "src/plain.ts": "export function plainFn() {\n  // @impl REQ-800\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-800: plainFn does a thing.\n",
    });
    const { stdout } = await runAt(tmp, ["check"]);
    expect(stdout).not.toContain("UNEXERCISED CLAIM:");
    expect(stdout).not.toContain("SUGGESTED IMPL:");
    expect(stdout).not.toContain("STALE EVIDENCE:");
  });
});

// ---------------------------------------------------------------------------
// (f) ② staleness=exclude removes stale evidence from ALL decisions;
// staleness=gate + --gate + stale present -> exit 2 (US5-2/3)
// ---------------------------------------------------------------------------

describe("check-evidence (T019f): staleness: exclude removes stale evidence from findings AND exercised status", () => {
  it("a stale exclusive node no longer appears in suggestedImpls, and its REQ is not `exercised` even with acceptExercises: true", async () => {
    const originalSrc = "export function excludedFn() {}\n";
    const tmp = makeRepo(
      { "src/excl.ts": originalSrc, "specs/spec.md": "# Fixture\n\n- REQ-600: excludedFn.\n" },
      { trace: { staleness: "exclude", acceptExercises: true } },
    );
    // Deliberately wrong hash from the start — this evidence is stale from
    // the first read (simulates "trace captured, then code edited before
    // the very first check run").
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-600] exercises excludedFn",
        testFile: "tests/req600.test.ts",
        hits: [{ file: "src/excl.ts", fn: "excludedFn" }],
        hashes: { "src/excl.ts": "0000000000000000" },
      }),
    ]);

    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.suggestedImpls).toEqual([]);
    expect(result.coverage.find((c: { reqId: string }) => c.reqId === "REQ-600")?.status).toBe(
      "untagged",
    );
    expect(result.uncovered).toContain("REQ-600");
    // The stale finding is STILL reported (diagnostic, independent of the
    // exclusion policy) even though the evidence itself was excluded from
    // every decision above.
    expect(result.staleEvidence).toEqual([
      { reqId: "REQ-600", symbols: ["symbol:src/excl.ts#excludedFn"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// issue #284 — `exercisableUncovered`: a counterfactual hint listing
// `uncovered` REQs that would be rescued to `exercised` if
// `trace.acceptExercises` were turned on. Purely informational (never
// touches `pass`/gate); see src/check.ts's issue #284 comment.
// ---------------------------------------------------------------------------

describe("check-evidence (issue #284): exercisableUncovered counterfactual hint", () => {
  it("acceptExercises off: an uncovered REQ with exclusive evidence appears in exercisableUncovered; uncovered/pass/gate are unaffected by the new field", async () => {
    const tmp = makeMainFixture();
    const { stdout, exitCode } = await runAt(tmp, ["check", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);

    expect(result.exercisableUncovered).toEqual(["REQ-002"]);
    expect(result.uncovered).toContain("REQ-002");
    // Every non-exclusive band (shared >= threshold infra, and the silent
    // 2-req band below threshold) must NOT be suggested — exclusivity-only
    // rule, same as suggestedImpls/exercised.
    for (const reqId of ["REQ-010", "REQ-011", "REQ-012", "REQ-020", "REQ-021"]) {
      expect(result.exercisableUncovered).not.toContain(reqId);
    }
    // `pass` is unaffected: this fixture has other uncovered REQs regardless
    // of the new field, so the gate outcome is unchanged by its presence.
    expect(result.pass).toBe(false);
  });

  it("text output: HINT appears right after UNCOVERED: when acceptExercises is off, naming the eligible REQ and the config flag to add", async () => {
    const tmp = makeMainFixture();
    const { stdout, exitCode } = await runAt(tmp, ["check"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("UNCOVERED:");
    expect(stdout).toContain("HINT: REQ-002 has exclusive execution evidence");
    expect(stdout).toContain('{"trace": {"acceptExercises": true}}');
    // HINT comes after the UNCOVERED: block, not before it.
    expect(stdout.indexOf("UNCOVERED:")).toBeLessThan(stdout.indexOf("HINT:"));
  });

  it("text output: no HINT when acceptExercises is already on", async () => {
    const tmp = makeMainFixture({ trace: { acceptExercises: true } });
    const { stdout } = await runAt(tmp, ["check"]);
    expect(stdout).not.toContain("HINT:");
  });

  it("acceptExercises on: exercisableUncovered is [] (anything rescuable already left `uncovered`)", async () => {
    const tmp = makeMainFixture({ trace: { acceptExercises: true } });
    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.exercisableUncovered).toEqual([]);
    expect(result.uncovered).not.toContain("REQ-002");
  });

  it("no trace ingested: `exercisableUncovered` key is entirely absent (FR-010-style byte-identical guarantee)", async () => {
    const tmp = makeRepo({
      "src/plain.ts": "export function plainFn() {\n  // @impl REQ-800\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-800: plainFn does a thing.\n",
    });
    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);
    expect(Object.prototype.hasOwnProperty.call(result, "exercisableUncovered")).toBe(false);
  });

  it("staleness: exclude + entirely stale evidence -> the REQ is NOT in exercisableUncovered", async () => {
    const originalSrc = "export function excludedFn() {}\n";
    const tmp = makeRepo(
      { "src/excl.ts": originalSrc, "specs/spec.md": "# Fixture\n\n- REQ-600: excludedFn.\n" },
      { trace: { staleness: "exclude", acceptExercises: false } },
    );
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-600] exercises excludedFn",
        testFile: "tests/req600.test.ts",
        hits: [{ file: "src/excl.ts", fn: "excludedFn" }],
        hashes: { "src/excl.ts": "0000000000000000" }, // deliberately stale from the start
      }),
    ]);

    const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.uncovered).toContain("REQ-600");
    expect(result.exercisableUncovered).not.toContain("REQ-600");
  });

  it("scoped call: a REQ outside scope with otherwise-eligible evidence is excluded (exercisableUncovered inherits --diff-style scoping from `uncovered`)", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-800", { id: "REQ-800", kind: "req", filePath: "specs/x.md", contentHash: "h1" }],
      ["REQ-801", { id: "REQ-801", kind: "req", filePath: "specs/x.md", contentHash: "h2" }],
      [
        "symbol:src/x.ts#fn800",
        { id: "symbol:src/x.ts#fn800", kind: "symbol", filePath: "src/x.ts", contentHash: "h3" },
      ],
      [
        "symbol:src/x.ts#fn801",
        { id: "symbol:src/x.ts#fn801", kind: "symbol", filePath: "src/x.ts", contentHash: "h4" },
      ],
    ]);
    const graph: ArtifactGraph = { nodes, edges: [] };
    const lock: LockFile = {};
    const trace: IngestedTrace = {
      perReq: new Map([
        ["REQ-800", { symbols: ["symbol:src/x.ts#fn800"], files: [], tests: [] }],
        ["REQ-801", { symbols: ["symbol:src/x.ts#fn801"], files: [], tests: [] }],
      ]),
      hashesAtTrace: new Map(),
      diagnostics: { dangling: 0, corrupted: 0, skipped: 0, unknownSchema: 0 },
      reqsByNode: new Map([
        ["symbol:src/x.ts#fn800", new Set(["REQ-800"])],
        ["symbol:src/x.ts#fn801", new Set(["REQ-801"])],
      ]),
      shardCount: 1,
    };
    const traceOptions = {
      trace,
      staleNodeIds: new Set<string>(),
      acceptExercises: false,
      staleness: "warn" as const,
      sharedThreshold: 3,
    };

    // Unscoped: both REQ-800 and REQ-801 are exclusive-evidence candidates.
    const unscoped = check(graph, lock, undefined, undefined, undefined, false, traceOptions);
    expect(unscoped.exercisableUncovered).toEqual(expect.arrayContaining(["REQ-800", "REQ-801"]));

    // Scoped to REQ-800 only (mirrors a --diff scope): REQ-801 must not
    // appear even though its evidence is equally eligible.
    const scoped = check(
      graph,
      lock,
      new Set(["REQ-800"]),
      undefined,
      undefined,
      false,
      traceOptions,
    );
    expect(scoped.exercisableUncovered).toEqual(["REQ-800"]);
    expect(scoped.uncovered).toEqual(["REQ-800"]);
  });

  it("foreign `implements` claim on the exclusive-evidence node: exercisableUncovered still includes the REQ (counterfactual of `exercised`, not `suggestedImpls`'s claimed-node exclusion), while suggestedImpls omits that node", () => {
    // REQ-A has NO `implements` edge of its own (untagged) and its tests
    // exclusively exercise symbol:src/y.ts#fnA. REQ-B — a completely
    // different req — happens to carry an `@impl` claim on that SAME node.
    // `classifyEvidence`'s `suggestedImpls` treats the node as already
    // "claimed" (by REQ-B) and skips it as report noise (src/trace/report.ts
    // line ~350: `if (claimedNodes.has(node)) continue;`). But
    // `exercisableUncovered`'s predicate is the `exercised` counterfactual
    // (`isExclusiveNode` — only asks "does exactly one REQ's evidence reach
    // this node", never consults `claimedNodes`), so REQ-A must still be
    // rescued here even though the node is claimed by someone else.
    const nodes = new Map<string, GraphNode>([
      ["REQ-A", { id: "REQ-A", kind: "req", filePath: "specs/y.md", contentHash: "h1" }],
      ["REQ-B", { id: "REQ-B", kind: "req", filePath: "specs/y.md", contentHash: "h2" }],
      [
        "symbol:src/y.ts#fnA",
        { id: "symbol:src/y.ts#fnA", kind: "symbol", filePath: "src/y.ts", contentHash: "h3" },
      ],
    ]);
    const edges: GraphEdge[] = [
      // Foreign claim: REQ-B (not REQ-A) declares `@impl` on the node that
      // REQ-A's tests exclusively exercise. `implements` edges point
      // source=code-node -> target=req (see src/coverage.ts's `e.target` /
      // `e.source` indexing and classifyEvidence's `node = edge.source`,
      // `reqId = edge.target` above).
      {
        source: "symbol:src/y.ts#fnA",
        target: "REQ-B",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ];
    const graph: ArtifactGraph = { nodes, edges };
    const lock: LockFile = {};
    const trace: IngestedTrace = {
      perReq: new Map([["REQ-A", { symbols: ["symbol:src/y.ts#fnA"], files: [], tests: [] }]]),
      hashesAtTrace: new Map(),
      diagnostics: { dangling: 0, corrupted: 0, skipped: 0, unknownSchema: 0 },
      reqsByNode: new Map([["symbol:src/y.ts#fnA", new Set(["REQ-A"])]]),
      shardCount: 1,
    };
    const traceOptions = {
      trace,
      staleNodeIds: new Set<string>(),
      acceptExercises: false,
      staleness: "warn" as const,
      sharedThreshold: 3,
    };

    const result = check(graph, lock, undefined, undefined, undefined, false, traceOptions);

    expect(result.exercisableUncovered).toContain("REQ-A");
    expect(result.suggestedImpls ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ node: "symbol:src/y.ts#fnA" })]),
    );
  });
});

describe("check-evidence (T019f): staleness: gate composes with --gate (exit 2), independent of warn/exclude", () => {
  function makeStaleGateFixture(staleness: "warn" | "exclude" | "gate"): string {
    // `@impl REQ-650` is planted on gateFn so the fixture has ZERO other
    // scoped issues (no uncovered/orphan/drift) — the only possible cause
    // of a gate failure here is the staleness gate itself, isolating the
    // FR-015 x --gate composition from spec 017's baseline gate.
    const tmp = makeRepo(
      {
        "src/gatefn.ts": "export function gateFn() {\n  // @impl REQ-650\n}\n",
        "specs/spec.md": "# Fixture\n\n- REQ-650: gateFn.\n",
      },
      { trace: { staleness } },
    );
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-650] exercises gateFn",
        testFile: "tests/req650.test.ts",
        hits: [{ file: "src/gatefn.ts", fn: "gateFn" }],
        hashes: { "src/gatefn.ts": "0000000000000000" }, // deliberately stale
      }),
    ]);
    return tmp;
  }

  it.each([
    { staleness: "warn" as const, gateFlag: true, expectedExit: 0 },
    { staleness: "exclude" as const, gateFlag: true, expectedExit: 0 },
    { staleness: "gate" as const, gateFlag: false, expectedExit: 0 },
    { staleness: "gate" as const, gateFlag: true, expectedExit: 2 },
  ])(
    "staleness=$staleness, --gate=$gateFlag -> exit $expectedExit",
    async ({ staleness, gateFlag, expectedExit }) => {
      const tmp = makeStaleGateFixture(staleness);
      const args = ["check", "--format", "json"];
      if (gateFlag) args.push("--gate");
      const { exitCode } = await runAt(tmp, args);
      expect(exitCode).toBe(expectedExit);
    },
  );
});
