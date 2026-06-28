// spec 016 — Phase 5 (US3) JSON schema CONTRACT tests for `runPlanCoverage`.
//
// Reference contracts:
//   - specs/016-impact-plan-symbol-level/contracts/plan-coverage-json.md (§2,
//     §3, §4 — ImpactGroup / ImplicitImpactByReq / unresolvedSymbol shape)
//   - specs/016-impact-plan-symbol-level/spec.md US3 Acceptance Scenarios 1–5
//
// These are CONTRACT tests, distinct from the integration tests in
// `tests/plan-coverage.test.ts` and `tests/plan-coverage-integration.test.ts`:
// they pin the *shape* of the JSON output (key presence / absence, field set)
// at the schema level, independent of the behavioural assertions exercised
// elsewhere. The point is that even if a future refactor preserves correct
// values, it must NOT reintroduce spec-014-era keys (`reqs`, `sourceFiles`)
// nor leak `sourceSymbol` onto file-unit entries.
//
// Each `it` carries a `[contract]` prefix so the contract layer is greppable
// in CI output and a single failing test points to the canonical schema doc.
//
// Tasks covered:
//   T035 — US3 AS#1: symbol entry, `reqs` key absent + 4 mandatory fields
//   T036 — US3 AS#2: file-unit entry, `sourceSymbol` key omitted + originReqs:[]
//   T037 — US3 AS#3: 1 file × 2 symbols → 2 distinct entries, independent originReqs
//   T038 — US3 AS#4: implicitImpactsByReq schema (`sourceFiles` key absent)
//   T039 — US3 AS#5: unresolvedSymbol diagnostic shape + entry exclusion

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runPlanCoverage,
  type PlanCoverageRunResult,
} from "../src/plan-coverage/index.js";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------
//
// Mirrors `setupSymbolFixture` in tests/plan-coverage.test.ts but stripped to
// the minimum schema-pinning needs:
//   - src/auth.ts with three exports, each `@impl REQ-001 / REQ-005 / REQ-009`
//     placed INSIDE the function body so the symbol-mode parser attributes
//     each edge to the symbol (not the file).
//   - Sibling spec dir owning the REQ catalogue (autoContains: false in
//     .artgraph.json keeps doc → REQ contains edges from polluting BFS).
//   - The analysis-target spec dir's spec.md / plan.md stay REQ-literal-free
//     so the mention detector never eclipses an implicit REQ in these tests.
//
// `tasksBody` is the only knob each test toggles (different `Files:` lines).

interface SymbolContractFixture {
  root: string;
  specDir: string;
  tasksPath: string;
  planPath: string;
}

function setupContractFixture(tasksBody: string): SymbolContractFixture {
  const root = mkdtempSync(join(tmpdir(), "artgraph-pc-contract-"));
  const specDir = join(root, "specs/001-symbol-demo");
  mkdirSync(specDir, { recursive: true });

  writeFileSync(
    join(specDir, "spec.md"),
    [
      "# Symbol Demo Spec",
      "",
      "Intentionally REQ-ID-free body so the plan-coverage mention detector",
      "does not eclipse implicitImpacts.",
      "",
    ].join("\n"),
  );

  const externalSpec = join(root, "specs/auth-design");
  mkdirSync(externalSpec, { recursive: true });
  writeFileSync(
    join(externalSpec, "requirements.md"),
    [
      "# Auth Requirements",
      "",
      "## Requirements",
      "",
      "- REQ-001: validateToken must reject empty bearer tokens.",
      "- REQ-005: issueToken must mint a fresh bearer token tied to a user id.",
      "- REQ-009: revokeToken must mark a token as revoked.",
      "",
    ].join("\n"),
  );

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/auth.ts"),
    [
      "export function validateToken(token: string): boolean {",
      "  // @impl REQ-001",
      "  return token.length > 0;",
      "}",
      "export function issueToken(userId: string): string {",
      "  // @impl REQ-005",
      "  return `token:${userId}`;",
      "}",
      "export function revokeToken(token: string): void {",
      "  // @impl REQ-009",
      "  void token;",
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
      mode: "symbol",
      docGraph: { autoContains: false },
    }),
  );

  const tasksPath = join(specDir, "tasks.md");
  writeFileSync(tasksPath, tasksBody);
  const planPath = join(specDir, "plan.md");
  writeFileSync(planPath, "# Plan\n\nNo REQ references.\n");
  return { root, specDir, tasksPath, planPath };
}

function runJson(fx: SymbolContractFixture): PlanCoverageRunResult {
  return runPlanCoverage({
    repoRoot: fx.root,
    specDir: fx.specDir,
    tasksPath: fx.tasksPath,
    planPath: fx.planPath,
    format: "json",
    gate: false,
    ignore: [],
    requireFilesSection: false,
  });
}

// `hasOwn` semantics for both the live in-memory object AND the JSON-
// roundtripped form so a future change can't silently swap `undefined` for
// an omitted key (which JSON serialises identically but the spec calls out
// as a distinction — "JSON key そのものが省略").
function expectKeyAbsent(obj: unknown, key: string): void {
  expect(Object.prototype.hasOwnProperty.call(obj, key)).toBe(false);
  const round = JSON.parse(JSON.stringify(obj));
  expect(Object.prototype.hasOwnProperty.call(round, key)).toBe(false);
}

// ---------------------------------------------------------------------------
// T035 — US3 AS#1
// ---------------------------------------------------------------------------

describe("[contract] plan-coverage JSON — ImpactGroup symbol entry shape (T035 / US3 AS#1)", () => {
  let fx: SymbolContractFixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("[contract] symbol entry exposes exactly { sourceFile, sourceSymbol, impactReqs, originReqs } and omits the spec-014 `reqs` key", () => {
    fx = setupContractFixture(
      [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth.ts:validateToken",
        "",
      ].join("\n"),
    );
    const result = runJson(fx);
    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];

    // Mandatory presence — all four canonical fields.
    expect(Object.prototype.hasOwnProperty.call(g, "sourceFile")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(g, "sourceSymbol")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(g, "impactReqs")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(g, "originReqs")).toBe(true);

    // Spec-014 `reqs` key MUST NOT reappear (FR-016 — the field was renamed
    // to `impactReqs`, NOT aliased).
    expectKeyAbsent(g, "reqs");

    // Strictness: the entry has no surprise extra keys either.
    expect(new Set(Object.keys(g))).toEqual(
      new Set(["sourceFile", "sourceSymbol", "impactReqs", "originReqs"]),
    );

    // Value sanity (keeps the contract test self-contained — if a refactor
    // empties the arrays while preserving keys, the schema test still fails).
    expect(g.sourceFile).toBe("src/auth.ts");
    expect(g.sourceSymbol).toBe("validateToken");
    expect(g.impactReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(g.originReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
  });
});

// ---------------------------------------------------------------------------
// T036 — US3 AS#2
// ---------------------------------------------------------------------------

describe("[contract] plan-coverage JSON — ImpactGroup file-unit shape (T036 / US3 AS#2)", () => {
  let fx: SymbolContractFixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("[contract] file-unit entry omits the `sourceSymbol` JSON key entirely and reports originReqs:[] when file-top has no @impl tag", () => {
    fx = setupContractFixture(
      ["# Tasks", "", "### T001", "", "Files: src/auth.ts", ""].join("\n"),
    );
    const result = runJson(fx);
    expect(result.json.implicitImpacts).toHaveLength(1);
    const g = result.json.implicitImpacts[0];

    // The CORE contract assertion: key omission, not `undefined`. Both
    // live-object hasOwn and the JSON roundtrip must agree the key is gone.
    expectKeyAbsent(g, "sourceSymbol");

    // Field set is exactly the file-unit triple.
    expect(new Set(Object.keys(g))).toEqual(
      new Set(["sourceFile", "impactReqs", "originReqs"]),
    );

    // originReqs MUST be the empty array, NOT omitted: the contract makes
    // an explicit distinction ("空配列を必ず populate、key 省略はしない").
    expect(Object.prototype.hasOwnProperty.call(g, "originReqs")).toBe(true);
    expect(g.originReqs).toEqual([]);

    // The file unit still reaches the three @impl REQs via BFS — that's
    // the behavioural side of US3 AS#2 (no over/under detection while the
    // schema is being pinned).
    expect(g.sourceFile).toBe("src/auth.ts");
    expect(g.impactReqs.map((r) => r.reqId).sort()).toEqual([
      "REQ-001",
      "REQ-005",
      "REQ-009",
    ]);
  });
});

// ---------------------------------------------------------------------------
// T037 — US3 AS#3
// ---------------------------------------------------------------------------

describe("[contract] plan-coverage JSON — 1 file × 2 symbols (T037 / US3 AS#3)", () => {
  let fx: SymbolContractFixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("[contract] same sourceFile with two different sourceSymbols produces 2 distinct ImpactGroups (no dedup) with independent originReqs", () => {
    fx = setupContractFixture(
      [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth.ts:validateToken, src/auth.ts:issueToken",
        "",
      ].join("\n"),
    );
    const result = runJson(fx);

    // Two ImpactGroups, NOT merged — dedup is (sourceFile, sourceSymbol).
    expect(result.json.implicitImpacts).toHaveLength(2);

    // Both entries share sourceFile but carry distinct sourceSymbols.
    const files = result.json.implicitImpacts.map((g) => g.sourceFile);
    expect(files).toEqual(["src/auth.ts", "src/auth.ts"]);
    const symbols = result.json.implicitImpacts.map((g) => g.sourceSymbol);
    expect(new Set(symbols)).toEqual(new Set(["validateToken", "issueToken"]));

    // Each entry's keys are the symbol-entry shape (no `reqs`, four fields).
    for (const g of result.json.implicitImpacts) {
      expect(new Set(Object.keys(g))).toEqual(
        new Set(["sourceFile", "sourceSymbol", "impactReqs", "originReqs"]),
      );
      expectKeyAbsent(g, "reqs");
    }

    // Independent claims — the entries are NOT cross-pollinated. validateToken
    // claims REQ-001 only; issueToken claims REQ-005 only.
    const validateGroup = result.json.implicitImpacts.find(
      (g) => g.sourceSymbol === "validateToken",
    )!;
    const issueGroup = result.json.implicitImpacts.find(
      (g) => g.sourceSymbol === "issueToken",
    )!;
    expect(validateGroup.originReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(issueGroup.originReqs.map((r) => r.reqId)).toEqual(["REQ-005"]);
    expect(validateGroup.impactReqs.map((r) => r.reqId)).toEqual(["REQ-001"]);
    expect(issueGroup.impactReqs.map((r) => r.reqId)).toEqual(["REQ-005"]);
  });
});

// ---------------------------------------------------------------------------
// T038 — US3 AS#4
// ---------------------------------------------------------------------------

describe("[contract] plan-coverage JSON — ImplicitImpactByReq shape (T038 / US3 AS#4)", () => {
  let fx: SymbolContractFixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("[contract] implicitImpactsByReq entries expose exactly { reqId, sourceLocations } and omit the spec-014 `sourceFiles` key", () => {
    fx = setupContractFixture(
      [
        "# Tasks",
        "",
        "### T001",
        "",
        "Files: src/auth.ts:validateToken, src/auth.ts:issueToken",
        "",
      ].join("\n"),
    );
    const result = runJson(fx);

    // We get one by-REQ entry per impacted REQ (REQ-001 + REQ-005).
    expect(result.json.implicitImpactsByReq.length).toBeGreaterThanOrEqual(2);
    const reqIds = result.json.implicitImpactsByReq.map((r) => r.reqId);
    expect(new Set(reqIds)).toEqual(new Set(["REQ-001", "REQ-005"]));

    for (const r of result.json.implicitImpactsByReq) {
      // Field set is EXACTLY the two-field canonical shape — no surprises.
      expect(new Set(Object.keys(r))).toEqual(
        new Set(["reqId", "sourceLocations"]),
      );
      // Spec-014's `sourceFiles: string[]` field MUST NOT reappear.
      expectKeyAbsent(r, "sourceFiles");

      // sourceLocations entries themselves carry { file, symbol? } — the
      // symbol key MUST be present (these tasks are both symbol-unit).
      expect(Array.isArray(r.sourceLocations)).toBe(true);
      expect(r.sourceLocations.length).toBeGreaterThan(0);
      for (const loc of r.sourceLocations) {
        expect(typeof loc.file).toBe("string");
        expect(Object.prototype.hasOwnProperty.call(loc, "symbol")).toBe(true);
      }
    }

    // Cross-check value: each REQ resolves to its expected symbol location.
    const req1 = result.json.implicitImpactsByReq.find((r) => r.reqId === "REQ-001")!;
    const req5 = result.json.implicitImpactsByReq.find((r) => r.reqId === "REQ-005")!;
    expect(req1.sourceLocations).toEqual([
      { file: "src/auth.ts", symbol: "validateToken" },
    ]);
    expect(req5.sourceLocations).toEqual([
      { file: "src/auth.ts", symbol: "issueToken" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// T039 — US3 AS#5
// ---------------------------------------------------------------------------

describe("[contract] plan-coverage JSON — unresolvedSymbol diagnostic shape (T039 / US3 AS#5)", () => {
  let fx: SymbolContractFixture;
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
  });

  it("[contract] unknown symbol surfaces as a { kind:'unresolvedSymbol', sourceFile, symbol, line } diagnostic and the entry is excluded from implicitImpacts", () => {
    fx = setupContractFixture(
      [
        "# Tasks",                                  // line 1
        "",                                         // line 2
        "### T001",                                 // line 3
        "",                                         // line 4
        "Files: src/auth.ts:doesNotExist",          // line 5
        "",
      ].join("\n"),
    );
    const result = runJson(fx);

    // The entry must NOT contribute an ImpactGroup (its startId never
    // resolved — contract §4.2).
    expect(result.json.implicitImpacts).toEqual([]);
    expect(result.json.implicitImpactsByReq).toEqual([]);

    // Exactly one unresolvedSymbol diagnostic surfaces.
    const unresolved = result.json.diagnostics.filter(
      (d) => d.kind === "unresolvedSymbol",
    );
    expect(unresolved).toHaveLength(1);
    const d = unresolved[0];

    // Field set: { kind, sourceFile, symbol, line } — no extras.
    expect(new Set(Object.keys(d))).toEqual(
      new Set(["kind", "sourceFile", "symbol", "line"]),
    );

    // Value pinning per contract §4.
    expect(d).toEqual({
      kind: "unresolvedSymbol",
      sourceFile: "src/auth.ts",
      symbol: "doesNotExist",
      line: 5,
    });

    // Exclusion rule (contract §4.1): no `unresolvedFilePath` should fire
    // for the same entry — the two are per-entry mutually exclusive and
    // `unresolvedSymbol` is the chosen kind here (path resolves, symbol
    // does not).
    const sameFilePathDiagnostic = result.json.diagnostics.filter(
      (x) => x.kind === "unresolvedFilePath" && x.sourceFile === "src/auth.ts",
    );
    expect(sameFilePathDiagnostic).toEqual([]);
  });
});
