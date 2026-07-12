// issue #255 — spec 020 (trace evidence) x spec 021 (class-method-grain
// symbols) cross-cutting behavior. Before this fix, `src/trace/symbol-table.ts`
// Source 2 always resolved a class member's V8-reported bare name to the
// OWNING CLASS's symbol id, never the member's own id — so a method-level
// `@impl` claim (which attributes to `symbol:<path>#Class.method`, per spec
// 021) and a method-level trace hit (which landed on `symbol:<path>#Class`)
// never agreed on a node, producing false `unexercisedClaims` AND false
// `suggestedImpls` on the class. Fixed by (1) resolving a member name to its
// OWN symbol id when `extractClassMembers` actually symbolized it
// (`src/trace/symbol-table.ts`), and (2) a `contains`-edge roll-up scoped to
// claim corroboration only (`src/trace/report.ts`'s `reqExercises`) so a
// class-level claim still corroborates against a method-level hit.
//
// Follows `tests/trace-cli.test.ts`'s fixture style (hand-written TS sources
// + hand-written shard JSONL, `mode: "symbol"`, driven end-to-end through the
// real `trace report` CLI command so the real graph — including spec 021's
// class -> method `contains` edges — is what `classifyEvidence` sees).
//
// issue #267 (below, "issue #267 (1..3)") adds the ctor-specific follow-up:
// a constructor claim (`symbol:<path>#Class.constructor`) whose evidence the
// capture engine records under the CLASS's own V8-compatible name, landing
// one containment level ABOVE the claim — the mirror image of #255's
// class-claim / method-evidence case, needing its own narrow, ctor-only
// PARENT-ward check (`src/trace/report.ts`'s `ctorClassExercised`) plus a
// matching `suggestedImpls` noise suppression (`hasDescendantClaim`).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runAt } from "./helpers.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";

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
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-trace-method-grain-")));
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
    testName: "[" + "REQ-900] a test",
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

async function report(tmp: string): Promise<any> {
  const { stdout, exitCode } = await runAt(tmp, ["trace", "report", "--format", "json"]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

describe("issue #255 (1): method-level claim + that method's hit -> corroborated, not unexercised", () => {
  it("resolves the hit to the method's OWN symbol id, matching the method-level @impl claim", async () => {
    const tmp = makeRepo({
      "src/widget.ts": [
        "export class Widget {",
        "  // @impl " + "REQ-101",
        "  start() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-101] starts",
        testFile: "tests/req101.test.ts",
        hits: [{ file: "src/widget.ts", fn: "start" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([
      { reqId: "REQ-101", node: "symbol:src/widget.ts#Widget.start" },
    ]);
    expect(result.unexercisedClaims).toEqual([]);
  });
});

describe("issue #255 (2): class-level claim + method hit -> corroborated via contains roll-up", () => {
  it("a claim on the class corroborates when only a member's evidence lands (roll-up), not a class-level regression", async () => {
    const tmp = makeRepo({
      "src/engine.ts": [
        "// @impl " + "REQ-102",
        "export class Engine {",
        "  run() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-102] engine runs",
        testFile: "tests/req102.test.ts",
        hits: [{ file: "src/engine.ts", fn: "run" }],
      }),
    ]);

    const result = await report(tmp);
    // The claim attributes to the CLASS (leading-trivia widening above the
    // class decl), while the hit resolves to the MEMBER's own id — without
    // the `contains` roll-up in `reqExercises` this would wrongly show up in
    // `unexercisedClaims` (the exact issue #255 false positive).
    expect(result.corroborated).toEqual([
      { reqId: "REQ-102", node: "symbol:src/engine.ts#Engine" },
    ]);
    expect(result.unexercisedClaims).toEqual([]);
    // PR #268 review F2: `Engine.run` is exclusively exercised by REQ-102,
    // and `Engine` (its ancestor via `contains`) already claims REQ-102 —
    // `hasAncestorClaim` suppresses the redundant member-level suggestion,
    // since the class-granularity `@impl` already "found" this requirement.
    // Before F2 this asserted the OPPOSITE (the entry existing was pinned as
    // intended behavior); the new spec treats that as noise instead.
    expect(result.suggestedImpls).toEqual([]);
  });
});

describe("PR #268 review F2: ancestor-claim suppression of suggestedImpls", () => {
  it("(a) ancestor class claims REQ-1; method exclusively exercised by REQ-1 -> suggestion suppressed", async () => {
    const tmp = makeRepo({
      "src/alpha.ts": ["// @impl " + "REQ-1", "export class Alpha {", "  run() {}", "}", ""].join(
        "\n",
      ),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-1] alpha runs",
        testFile: "tests/req1.test.ts",
        hits: [{ file: "src/alpha.ts", fn: "run" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([{ reqId: "REQ-1", node: "symbol:src/alpha.ts#Alpha" }]);
    const suggestedNodes = result.suggestedImpls.map((p: { node: string }) => p.node);
    expect(suggestedNodes).not.toContain("symbol:src/alpha.ts#Alpha.run");
    expect(result.suggestedImpls).toEqual([]);
  });

  it("(b) ancestor class claims REQ-1; method exclusively exercised by a DIFFERENT REQ-2 -> suggestion NOT suppressed", async () => {
    const tmp = makeRepo({
      "src/beta.ts": ["// @impl " + "REQ-1", "export class Beta {", "  run() {}", "}", ""].join(
        "\n",
      ),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-2] beta runs under a different requirement",
        testFile: "tests/req2.test.ts",
        hits: [{ file: "src/beta.ts", fn: "run" }],
      }),
    ]);

    const result = await report(tmp);
    // The class's REQ-1 claim is unexercised (REQ-1 has no evidence at all
    // here), and `Beta.run` is exclusively exercised by REQ-2 — a claim on
    // an ancestor for a DIFFERENT reqId must not suppress this suggestion.
    expect(result.unexercisedClaims).toEqual([{ reqId: "REQ-1", node: "symbol:src/beta.ts#Beta" }]);
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-2", node: "symbol:src/beta.ts#Beta.run" },
    ]);
  });

  it("(c) no ancestor claim at all -> suggestion reported as before (unaffected by F2)", async () => {
    const tmp = makeRepo({
      "src/gamma.ts": ["export class Gamma {", "  run() {}", "}", ""].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-3] gamma runs",
        testFile: "tests/req3.test.ts",
        hits: [{ file: "src/gamma.ts", fn: "run" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([]);
    expect(result.unexercisedClaims).toEqual([]);
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-3", node: "symbol:src/gamma.ts#Gamma.run" },
    ]);
  });
});

describe("issue #255 (3): an unhit method's claim stays unexercised (true positive preserved)", () => {
  it("a method claimed but never hit by its REQ's test is still reported unexercised", async () => {
    const tmp = makeRepo({
      "src/reporter.ts": [
        "export class Reporter {",
        "  // @impl " + "REQ-103",
        "  send() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-103] something else entirely",
        testFile: "tests/req103.test.ts",
        hits: [], // REQ-103's test runs but never touches Reporter#send
      }),
    ]);

    const result = await report(tmp);
    expect(result.unexercisedClaims).toEqual([
      { reqId: "REQ-103", node: "symbol:src/reporter.ts#Reporter.send" },
    ]);
    expect(result.corroborated).toEqual([]);
  });
});

describe("issue #255 (4): a claimed+hit method does not spuriously suggest an @impl on its class", () => {
  it("suggestedImpls contains neither the method (already claimed) nor the class (never itself exercised)", async () => {
    const tmp = makeRepo({
      "src/mailer.ts": [
        "export class Mailer {",
        "  // @impl " + "REQ-104",
        "  deliver() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-104] delivers",
        testFile: "tests/req104.test.ts",
        hits: [{ file: "src/mailer.ts", fn: "deliver" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([
      { reqId: "REQ-104", node: "symbol:src/mailer.ts#Mailer.deliver" },
    ]);
    const suggestedNodes = result.suggestedImpls.map((p: { node: string }) => p.node);
    expect(suggestedNodes).not.toContain("symbol:src/mailer.ts#Mailer");
    expect(suggestedNodes).not.toContain("symbol:src/mailer.ts#Mailer.deliver");
    expect(result.suggestedImpls).toEqual([]);
  });
});

describe("issue #255 (5): a non-function property's hit falls back to the class (extractClassMembers never symbolizes it)", () => {
  it("no @impl anywhere; a hit on a data property lands on the class and is exclusive -> suggestedImpls on the CLASS", async () => {
    const tmp = makeRepo({
      "src/cache.ts": ["export class Cache {", "  size = 0;", "}", ""].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-105] touches size",
        testFile: "tests/req105.test.ts",
        hits: [{ file: "src/cache.ts", fn: "size" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-105", node: "symbol:src/cache.ts#Cache" },
    ]);
    expect(result.corroborated).toEqual([]);
    expect(result.unexercisedClaims).toEqual([]);
  });
});

describe("issue #255 (6): same-named method on two classes in one file -> file-fallback fail-safe unchanged", () => {
  it("an ambiguous bare name across two classes still falls back to file grain, never guesses a class", async () => {
    const tmp = makeRepo({
      "src/shapes.ts": [
        "export class Foo {",
        "  run() {}",
        "}",
        "",
        "export class Bar {",
        "  run() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-106] ambiguous run",
        testFile: "tests/req106.test.ts",
        hits: [{ file: "src/shapes.ts", fn: "run" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.suggestedImpls).toEqual([{ reqId: "REQ-106", node: "file:src/shapes.ts" }]);
    const allNodes = [
      ...result.corroborated.map((p: { node: string }) => p.node),
      ...result.unexercisedClaims.map((p: { node: string }) => p.node),
      ...result.suggestedImpls.map((p: { node: string }) => p.node),
    ];
    expect(allNodes).not.toContain("symbol:src/shapes.ts#Foo");
    expect(allNodes).not.toContain("symbol:src/shapes.ts#Bar");
    expect(allNodes).not.toContain("symbol:src/shapes.ts#Foo.run");
    expect(allNodes).not.toContain("symbol:src/shapes.ts#Bar.run");
  });
});

describe("issue #255 (7): get/set same-name pin (PR #242 FR-003 convergence)", () => {
  it('get x / set x converge to ONE member symbol node, so a hit on "x" resolves unambiguously (not file-fallback)', async () => {
    // Per src/parsers/typescript.ts's extractClassMembers doc (FR-003), a
    // getter and setter of the same name converge to a SINGLE symbol node
    // (`Class.x`) rather than colliding as two candidates — so unlike case
    // (6) (two DIFFERENT classes sharing a name), this is not ambiguous at
    // all: both `get x` and `set x` resolve to the exact same member id.
    const tmp = makeRepo({
      "src/toggle.ts": [
        "export class Toggle {",
        "  private _x = false;",
        "  get x() { return this._x; }",
        "  set x(v) { this._x = v; }",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-107] toggles x",
        testFile: "tests/req107.test.ts",
        hits: [{ file: "src/toggle.ts", fn: "x" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-107", node: "symbol:src/toggle.ts#Toggle.x" },
    ]);
    const allNodes = [
      ...result.corroborated.map((p: { node: string }) => p.node),
      ...result.unexercisedClaims.map((p: { node: string }) => p.node),
      ...result.suggestedImpls.map((p: { node: string }) => p.node),
    ];
    expect(allNodes).not.toContain("file:src/toggle.ts");
  });
});

describe("issue #267 (1): ctor claim + instantiation evidence (recorded under the class name) -> corroborated at the ctor's OWN node", () => {
  it("a `.constructor`-suffixed claim corroborates via the ctor-only parent-ward check, and the class gets no redundant suggestion", async () => {
    const tmp = makeRepo({
      "src/widget267.ts": [
        "export class Widget267 {",
        "  // @impl " + "REQ-1",
        "  constructor() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-1] instantiates widget267",
        testFile: "tests/req1.test.ts",
        // The capture engine records a constructor call under the CLASS's
        // own V8-compatible name (`src/vitest/plugin.ts`), never the literal
        // string "constructor" — so this hit's `fn` is the class name.
        hits: [{ file: "src/widget267.ts", fn: "Widget267" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([
      { reqId: "REQ-1", node: "symbol:src/widget267.ts#Widget267.constructor" },
    ]);
    expect(result.unexercisedClaims).toEqual([]);
    // Without F2's descendant-claim suppression, the class node (which DOES
    // carry this exact instantiation evidence) would look like an
    // unclaimed, exclusively-exercised node and spuriously suggest
    // `@impl REQ-1` on the class too — redundant with the ctor's own claim.
    const suggestedNodes = result.suggestedImpls.map((p: { node: string }) => p.node);
    expect(suggestedNodes).not.toContain("symbol:src/widget267.ts#Widget267");
    expect(result.suggestedImpls).toEqual([]);
  });
});

describe("issue #267 (2): ctor claims REQ-1, instantiation evidence is REQ-2 only -> REQ-1 stays unexercised, REQ-2's class suggestion is NOT suppressed", () => {
  it("ctor-only corroboration and descendant-claim suppression are both reqId-scoped, not blanket", async () => {
    const tmp = makeRepo({
      "src/gadget267.ts": [
        "export class Gadget267 {",
        "  // @impl " + "REQ-1",
        "  constructor() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-2] instantiates gadget267 under a different requirement",
        testFile: "tests/req2.test.ts",
        hits: [{ file: "src/gadget267.ts", fn: "Gadget267" }],
      }),
    ]);

    const result = await report(tmp);
    // REQ-1's claim has no REQ-1 evidence anywhere (the only evidence here is
    // REQ-2's) -> stays unexercised; the ctor-only parent-ward check must not
    // corroborate across a DIFFERENT reqId.
    expect(result.unexercisedClaims).toEqual([
      { reqId: "REQ-1", node: "symbol:src/gadget267.ts#Gadget267.constructor" },
    ]);
    expect(result.corroborated).toEqual([]);
    // The class is exclusively exercised by REQ-2, and the only existing
    // claim (the ctor's) is for REQ-1, a DIFFERENT reqId -> descendant-claim
    // suppression (reqId-scoped, like `hasAncestorClaim`) must NOT apply, so
    // the REQ-2 suggestion on the class stands.
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-2", node: "symbol:src/gadget267.ts#Gadget267" },
    ]);
  });
});

describe("issue #267 (3): class-level claim + ctor execution -> direct match corroborated (no regression)", () => {
  it("a class-level claim already sits on the SAME node the ctor hit resolves to, so this needs no new machinery", async () => {
    const tmp = makeRepo({
      "src/lamp267.ts": [
        "// @impl " + "REQ-1",
        "export class Lamp267 {",
        "  constructor() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-1] instantiates lamp267",
        testFile: "tests/req1.test.ts",
        hits: [{ file: "src/lamp267.ts", fn: "Lamp267" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([
      { reqId: "REQ-1", node: "symbol:src/lamp267.ts#Lamp267" },
    ]);
    expect(result.unexercisedClaims).toEqual([]);
    expect(result.suggestedImpls).toEqual([]);
  });
});

describe("issue #255 (8): sharedThreshold interaction — 3 methods on one class, each claimed+hit by its OWN distinct REQ", () => {
  it("each method is classified independently at method grain; no false class-level infrastructure grouping", async () => {
    const tmp = makeRepo({
      "src/multi.ts": [
        "export class Multi {",
        "  // @impl " + "REQ-201",
        "  a() {}",
        "",
        "  // @impl " + "REQ-202",
        "  b() {}",
        "",
        "  // @impl " + "REQ-203",
        "  c() {}",
        "}",
        "",
      ].join("\n"),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-201] a",
        testFile: "tests/req201.test.ts",
        hits: [{ file: "src/multi.ts", fn: "a" }],
      }),
      testLine({
        testName: "[" + "REQ-202] b",
        testFile: "tests/req202.test.ts",
        hits: [{ file: "src/multi.ts", fn: "b" }],
      }),
      testLine({
        testName: "[" + "REQ-203] c",
        testFile: "tests/req203.test.ts",
        hits: [{ file: "src/multi.ts", fn: "c" }],
      }),
    ]);

    const result = await report(tmp);
    expect(result.corroborated).toEqual([
      { reqId: "REQ-201", node: "symbol:src/multi.ts#Multi.a" },
      { reqId: "REQ-202", node: "symbol:src/multi.ts#Multi.b" },
      { reqId: "REQ-203", node: "symbol:src/multi.ts#Multi.c" },
    ]);
    expect(result.unexercisedClaims).toEqual([]);
    // Current (intended) behavior: `reqsByNode` is keyed per resolved node —
    // each method individually reaches exactly ONE distinct REQ, so nothing
    // hits `sharedThreshold`; the CLASS node itself never appears in
    // `reqsByNode` at all (no hit ever resolves directly to it here), so it
    // cannot be misclassified as infrastructure either.
    expect(result.infrastructure).toEqual([]);
    expect(result.suggestedImpls).toEqual([]);
  });
});

describe("PR #271 meta-review META-D: hasDescendantClaim pin for a NON-ctor case", () => {
  it("class-node evidence + a method's OWN claim on the SAME reqId -> suggestedImpls suppressed even though the method's claim is itself unexercised (hasDescendantClaim is claim-only, symmetric with hasAncestorClaim)", async () => {
    const tmp = makeRepo({
      "src/pump.ts": ["export class Pump {", "  // @impl " + "REQ-1", "  run() {}", "}", ""].join(
        "\n",
      ),
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[" + "REQ-1] instantiates pump",
        testFile: "tests/req1.test.ts",
        // No constructor at all here -- this is a plain class-name landing
        // (e.g. instantiation), unrelated to the `.constructor`-suffixed
        // mechanism in `ctorClassExercised`. It never touches `run` itself.
        hits: [{ file: "src/pump.ts", fn: "Pump" }],
      }),
    ]);

    const result = await report(tmp);
    // `run`'s own claim is never corroborated -- its REQ-1 evidence never
    // lands on `run` itself (only on the class).
    expect(result.unexercisedClaims).toEqual([
      { reqId: "REQ-1", node: "symbol:src/pump.ts#Pump.run" },
    ]);
    expect(result.corroborated).toEqual([]);
    // The CLASS node is exclusively exercised by REQ-1 and carries no claim
    // of its own, so absent suppression it would be a `suggestedImpls`
    // candidate. But `run` (a descendant, via `contains`) already claims
    // this SAME reqId -- `hasDescendantClaim` suppresses the suggestion
    // regardless of whether that descendant claim is itself corroborated
    // (mirrors `hasAncestorClaim`'s symmetric claims-only semantics; see
    // `hasDescendantClaim`'s doc in src/trace/report.ts).
    expect(result.suggestedImpls).toEqual([]);
  });
});
