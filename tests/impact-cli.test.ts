// spec 016 — Phase 4 (US2) tests for `artgraph impact`.
//
// Targets contracts/cli-flags.md §6 (acceptance cases 1-8) plus the US2 AS#7
// extension for multi-symbol direct input. The previous spec 014 test file
// kept REQ-ID / doc:/ mutually-exclusive validation; spec 016 keeps every one
// of those code paths so we preserve those tests verbatim and bolt the
// symbol-mode / two-axis scenarios on top.
//
// Fixture choices:
//   * `tests/fixtures/symbol-mode/` (3 exports / 3 REQs, mode: symbol) is the
//     primary symbol-mode rig. It already ships with `Files: src/auth.ts:
//     validateToken` plus a file-unit comparison task — we reuse it for every
//     symbol scenario. A second copy is mutated per-test for the depends_on
//     drift case.
//   * Tests that don't need symbol resolution stay on the canonical auth
//     fixture (FIXTURE_DIR) so we don't pay the symbol-mode scan cost.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAt, FIXTURE_DIR } from "./helpers.js";

// ---------------------------------------------------------------------------
// Symbol-mode rig — copies tests/fixtures/symbol-mode/ to a tmp directory so
// each test can mutate spec.md / tasks.md / src/auth.ts without bleeding into
// the canonical fixture. Two helpers:
//   addSession()  — write src/session.ts so US2 AS#7 (multi-symbol) has a
//                   second file to point at.
//   addDependsOn() — rewrite spec.md so REQ-001 depends_on REQ-007 (US2 AS
//                    Scenario 7 — drift via depends_on).
// ---------------------------------------------------------------------------

const SYMBOL_MODE_SRC = join(FIXTURE_DIR, "symbol-mode");

function setupSymbolModeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "artgraph-impact-symmode-"));
  cpSync(SYMBOL_MODE_SRC, root, { recursive: true });
  return root;
}

function addSessionExport(root: string): void {
  // `@impl` MUST be a `//` line comment inside the function body so the
  // symbol-mode parser attributes the edge to the symbol (mirrors the rules
  // documented in tests/fixtures/symbol-mode/src/auth.ts).
  writeFileSync(
    join(root, "src", "session.ts"),
    [
      "// Companion fixture file for US2 AS#7 (multi-symbol direct input).",
      "",
      "export function createSession(userId: string): string {",
      "  // @impl REQ-003",
      "  return `session:${userId}`;",
      "}",
      "",
    ].join("\n"),
  );
  // Add REQ-003 to the spec.md so the graph has a target for @impl REQ-003.
  const specPath = join(root, "specs", "001-symbol-demo", "spec.md");
  const orig = readFileSync(specPath, "utf-8");
  if (!orig.includes("REQ-003")) {
    writeFileSync(
      specPath,
      orig.trimEnd() + "\n- REQ-003: createSession must mint a fresh session record for a user.\n",
    );
  }
}

function addDependsOnReq007(root: string): void {
  // Annotation syntax is `(depends_on: REQ-007)` — that's what the markdown
  // parser's ANNOTATION_RE captures. Adding REQ-007 as its own list item so
  // the graph has a real target node for the edge.
  //
  // We also delete `specs/auth-design/` (a sibling fixture used by other
  // tests for ambiguous-mention semantics). Rewriting `001-symbol-demo/spec.md`
  // changes REQ-001's content hash, which would collide with auth-design's
  // REQ-001 → the builder scopes both as `001-symbol-demo/REQ-001` and
  // `auth-design/REQ-001`, breaking the `@impl REQ-001` lookup in src/auth.ts.
  // For the drift scenario we only need 001-symbol-demo.
  rmSync(join(root, "specs", "auth-design"), { recursive: true, force: true });

  const specPath = join(root, "specs", "001-symbol-demo", "spec.md");
  writeFileSync(
    specPath,
    [
      "# Symbol Demo Spec",
      "",
      "## Requirements",
      "",
      "- REQ-001: validateToken must reject empty bearer tokens. (depends_on: REQ-007)",
      "- REQ-005: issueToken must mint a fresh bearer token tied to a user id.",
      "- REQ-007: Audit log requirement that REQ-001 builds on.",
      "- REQ-009: revokeToken must mark a token as revoked.",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// US2 / contracts/cli-flags.md §6 Case 1
// ---------------------------------------------------------------------------

describe("CLI: impact symbol-mode direct input (US2 / FR-008 / FR-014)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSymbolModeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Case 1: `impact src/auth.ts:validateToken --format json` → exit 0, impactReqs=[REQ-001], originReqs=[REQ-001]", async () => {
    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "src/auth.ts:validateToken",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // forward BFS via @impl REQ-001 only reaches REQ-001 (sibling symbols are
    // intentionally excluded by resolveStartIds for symbol input — R-006).
    expect(result.impactReqs).toContain("REQ-001");
    expect(result.impactReqs).not.toContain("REQ-005");
    expect(result.impactReqs).not.toContain("REQ-009");
    // origin = startId's direct @impl claim
    expect(result.originReqs).toEqual(["REQ-001"]);
  });

  it("Case 1 (text variant): text output renders the three REQ sections", async () => {
    const { stdout, exitCode } = await runAt(root, ["impact", "src/auth.ts:validateToken"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Impact reqs:");
    expect(stdout).toMatch(/REQ-001\s+\(req\)/);
    expect(stdout).toContain("Origin reqs (@impl claims):");
    // Drift candidates section MUST be omitted when impact == origin (FR-015).
    expect(stdout).not.toContain("Drift candidates");
  });

  it("Case 2: missing symbol → exit 1, stderr quotes the path:symbol that missed", async () => {
    const { exitCode, stderr } = await runAt(root, ["impact", "src/auth.ts:doesNotExist"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No matching symbol found");
    expect(stderr).toContain("src/auth.ts:doesNotExist");
  });
});

// ---------------------------------------------------------------------------
// US2 / Case 3 — scan-mode mismatch (file-mode graph + symbol input)
// ---------------------------------------------------------------------------

describe("CLI: impact scan-mode mismatch (US2 / FR-013 / R-010)", () => {
  let root: string;
  beforeEach(() => {
    // Use the canonical file-mode fixture: graph has no `symbol` nodes.
    root = mkdtempSync(join(tmpdir(), "artgraph-impact-filegraph-"));
    cpSync(join(FIXTURE_DIR, "src"), join(root, "src"), { recursive: true });
    cpSync(join(FIXTURE_DIR, "specs"), join(root, "specs"), { recursive: true });
    cpSync(join(FIXTURE_DIR, "tests"), join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
        // Deliberately omit `mode: "symbol"` so scan stays in file mode.
      }),
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Case 3: file-mode graph + symbol input → exit 1, stderr asks for config mode symbol", async () => {
    const { exitCode, stderr } = await runAt(root, ["impact", "src/auth/login.ts:doesNotMatter"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("symbol-level input requires");
    expect(stderr).toContain('`mode: "symbol"` in `.artgraph.json`');
  });
});

// ---------------------------------------------------------------------------
// US2 / Case 4 — REQ-ID + symbol input → REQ-ID rejection fires FIRST (FR-012)
// ---------------------------------------------------------------------------

describe("CLI: impact REQ-ID rejection precedes symbol detection (US2 / FR-012)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSymbolModeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Case 4: `impact REQ-001 src/auth.ts:validateToken` → navigational REQ-ID error before symbol resolution", async () => {
    const { exitCode, stderr } = await runAt(root, [
      "impact",
      "REQ-001",
      "src/auth.ts:validateToken",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("REQ-ID");
    expect(stderr).toContain("--diff");
    expect(stderr).toContain("plan-coverage");
    // The symbol miss path must NOT have fired — the REQ-ID gate caught it.
    expect(stderr).not.toContain("No matching symbol found");
  });
});

// ---------------------------------------------------------------------------
// US2 / Case 6 — file + symbol mixed direct input
// US2 AS#7 (Additional Acceptance Case) — multi-symbol direct input
// ---------------------------------------------------------------------------

describe("CLI: impact mixed / multi-symbol direct input (US2 AS#7)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSymbolModeFixture();
    addSessionExport(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Case 6: file + symbol mixed (`impact src/auth.ts:validateToken src/session.ts`) → BFS union, originReqs union", async () => {
    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "src/auth.ts:validateToken",
      "src/session.ts",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // validateToken claims REQ-001; session.ts (file unit) drags in any
    // @impl on the file or its symbols — here createSession @impl REQ-003.
    expect(result.impactReqs).toContain("REQ-001");
    expect(result.impactReqs).toContain("REQ-003");
    // origin = union of (validateToken @impl REQ-001) and
    //                  (createSession @impl REQ-003 via file → symbol expansion)
    expect(result.originReqs).toEqual(expect.arrayContaining(["REQ-001", "REQ-003"]));
  });

  it("US2 AS#7: two-symbol direct input → impactReqs union (REQ-001 ∪ REQ-003), originReqs union", async () => {
    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "src/auth.ts:validateToken",
      "src/session.ts:createSession",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.impactReqs).toContain("REQ-001");
    expect(result.impactReqs).toContain("REQ-003");
    // Sibling symbols on src/auth.ts (issueToken / revokeToken) must NOT leak
    // in — that's the whole point of symbol-unit BFS.
    expect(result.impactReqs).not.toContain("REQ-005");
    expect(result.impactReqs).not.toContain("REQ-009");
    // origin must contain both claims — union, not intersection.
    expect(result.originReqs).toEqual(["REQ-001", "REQ-003"]);
  });
});

// ---------------------------------------------------------------------------
// US2 / Case 7 — depends_on → Drift candidates section appears
// US2 / Case 8 — no drift → section omitted
// ---------------------------------------------------------------------------

describe("CLI: impact text Drift candidates section (US2 / FR-015)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSymbolModeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Case 7: `REQ-001 depends_on REQ-007` → text shows `Drift candidates: REQ-007`", async () => {
    addDependsOnReq007(root);
    const { stdout, exitCode } = await runAt(root, ["impact", "src/auth.ts:validateToken"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Impact reqs:");
    expect(stdout).toMatch(/REQ-001\s+\(req\)/);
    expect(stdout).toMatch(/REQ-007\s+\(req\)/);
    expect(stdout).toContain("Origin reqs (@impl claims):");
    expect(stdout).toContain("Drift candidates (impact \\ origin):");
    // Drift body must list REQ-007 (not REQ-001 — that's in the origin set).
    const driftIndex = stdout.indexOf("Drift candidates");
    expect(driftIndex).toBeGreaterThan(-1);
    const driftSection = stdout.slice(driftIndex);
    expect(driftSection).toContain("REQ-007");
  });

  it("Case 7 (json): JSON keeps the two axes; consumer computes drift", async () => {
    addDependsOnReq007(root);
    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "src/auth.ts:validateToken",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.impactReqs).toEqual(expect.arrayContaining(["REQ-001", "REQ-007"]));
    expect(result.originReqs).toEqual(["REQ-001"]);
    const drift = result.impactReqs.filter((r: string) => !result.originReqs.includes(r));
    expect(drift).toContain("REQ-007");
  });

  it("Case 8: `impactReqs == originReqs` (no depends_on) → `Drift candidates` section omitted", async () => {
    const { stdout, exitCode } = await runAt(root, ["impact", "src/auth.ts:validateToken"]);
    expect(exitCode).toBe(0);
    // Three REQ sections become two: Impact + Origin only.
    expect(stdout).toContain("Impact reqs:");
    expect(stdout).toContain("Origin reqs (@impl claims):");
    expect(stdout).not.toContain("Drift candidates");
  });
});

// ---------------------------------------------------------------------------
// #191 — barrel-symbol origin resolution shared with `plan-coverage`.
// `entryOriginIds` (traverse.ts) walks `imports` edges transitively so a
// barrel symbol input reaches the origin's `@impl` claim. Without this,
// `artgraph impact src/index.ts:validateToken` used to report
// impactReqs=[REQ-001], originReqs=[] → false-positive drift.
// ---------------------------------------------------------------------------

describe("CLI: impact — barrel-symbol origin resolution (#191)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSymbolModeFixture();
    // Add a barrel that re-exports validateToken from ./auth.
    writeFileSync(join(root, "src", "index.ts"), 'export { validateToken } from "./auth";\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("`impact src/index.ts:validateToken` reaches origin's @impl through the barrel — no false-positive drift", async () => {
    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "src/index.ts:validateToken",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.impactReqs).toContain("REQ-001");
    // Before the fix originReqs was []; drift = impactReqs \ originReqs
    // then surfaced REQ-001 as a false-positive drift candidate — the same
    // asymmetry #196 fixed in plan-coverage but that impact still had.
    expect(result.originReqs).toContain("REQ-001");
  });

  it("text output does NOT emit the `Drift candidates` section for a barrel-symbol input", async () => {
    const { stdout, exitCode } = await runAt(root, ["impact", "src/index.ts:validateToken"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Impact reqs:");
    expect(stdout).toContain("Origin reqs (@impl claims):");
    expect(stdout).not.toContain("Drift candidates");
  });
});

// ---------------------------------------------------------------------------
// specs/018 T13 — `artgraph impact <path:symbol>` on a symbol that only
// exists via a `export * from` chain. Before specs/018 the barrel node did
// not exist and the CLI errored with `unresolvedSymbol`; if resolved via
// file fallback, origin's REQ would drift-flag. With builder star expansion
// the barrel symbol materialises, `resolveStartIds` finds it, and
// `entryOriginIds` walks the symbol-hop chain to origin's `@impl`.
// ---------------------------------------------------------------------------

describe("CLI: impact — `export *` star-barrel entry (specs/018 T13)", () => {
  let root: string;
  beforeEach(() => {
    root = setupSymbolModeFixture();
    // Overwrite src/index.ts to use plain `export *` (star) instead of the
    // #191 named re-export. The origin `src/auth.ts` still carries the
    // @impl claim for REQ-001.
    writeFileSync(join(root, "src", "index.ts"), 'export * from "./auth";\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("`impact src/index.ts:validateToken` (through `export *`) reaches origin's REQ, no false-positive drift", async () => {
    const { stdout, exitCode } = await runAt(root, [
      "impact",
      "src/index.ts:validateToken",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // Star expansion emits `symbol:src/index.ts#validateToken` → forward BFS
    // reaches REQ-001 via origin's @impl.
    expect(result.impactReqs).toContain("REQ-001");
    // `entryOriginIds` walks the symbol chain
    // (symbol:src/index.ts#validateToken → symbol:src/auth.ts#validateToken)
    // and lands on origin's @impl claim — originReqs contains REQ-001.
    // Pre-specs/018 the barrel symbol did not exist, so this returned []
    // (or unresolvedSymbol) and drift = impactReqs \ originReqs flagged
    // REQ-001 as a false positive.
    expect(result.originReqs).toContain("REQ-001");
    const drift = (result.impactReqs as string[]).filter(
      (r) => !(result.originReqs as string[]).includes(r),
    );
    expect(drift).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Spec 014 → 016 validation regressions — kept so the redesign doesn't
// quietly break the navigational error / mutually-exclusive channels /
// no-source plumbing.
// ---------------------------------------------------------------------------

describe("CLI: impact — input validation (spec 016 keeps spec 014 behavior)", () => {
  it("rejects REQ-ID positional input with the navigational error (exit 1)", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact", "AUTH-001"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("REQ-ID");
    expect(stderr).toContain("--diff");
    expect(stderr).toContain("plan-coverage");
    expect(stderr).toMatch(/<file>|file path/i);
  });

  it.each([
    ["REQ-001", "all-uppercase REQ-ID"],
    ["AUTH-1", "uppercase prefix + small numeric tail"],
    ["FR-32", "FR-style REQ-ID"],
    ["Requirement-3", "Pascal-case Kiro-style prefix"],
    ["auth/FR-2", "scoped prefix"],
    ["AUTH-1.2", "dotted numeric tail"],
  ])("rejects %s as a REQ-ID input (UX-1: broadened regex — %s)", async (input, _label) => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact", input]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("REQ-ID");
  });

  it("rejects `doc:` prefix positional input", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact", "doc:auth-design"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--diff");
    expect(stderr).toContain("plan-coverage");
  });

  it("accepts an existing file path as positional input", async () => {
    const { stdout, exitCode } = await runAt(FIXTURE_DIR, [
      "impact",
      "src/auth/login.ts",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.impactReqs).toContain("AUTH-001");
  });

  it("rejects mutually exclusive start sources (positional + --diff)", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, [
      "impact",
      "src/auth/login.ts",
      "--diff",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/mutually exclusive|specify only one|choose one/i);
  });

  it("rejects when no start source is given", async () => {
    const { exitCode, stderr } = await runAt(FIXTURE_DIR, ["impact"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no.*target|no start source/i);
  });
});
