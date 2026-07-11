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
    // Intended side effect of member-id resolution, not a regression: the
    // class-level claim only covers the CLASS node (rolled up for
    // corroboration above), so `Engine.run` itself — now a distinct,
    // unclaimed node with exactly one REQ's evidence — separately qualifies
    // as its own suggestion. `suggestedImpls`/`isExclusiveNode` deliberately
    // do NOT roll up (see `reqExercises`'s doc in src/trace/report.ts), so
    // this entry existing alongside the class's corroboration is correct.
    expect(result.suggestedImpls).toEqual([
      { reqId: "REQ-102", node: "symbol:src/engine.ts#Engine.run" },
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
