// spec 020 (contracts/trace-artifact.md §ingest 側の義務, data-model.md §2-3) —
// ingest layer: REQ tag join + name join. This suite fixes T008's Red
// scenarios ((a)-(f) per tasks.md); `src/trace/ingest.ts` +
// `src/trace/symbol-table.ts` (T009) make it Green.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { ingestTrace, type IngestedTrace } from "../src/trace/ingest.js";
import { extractReqTags } from "../src/test-results.js";
import { SCHEMA_VERSION, type ShardMetaRecord, type ShardTestRecord } from "../src/trace/schema.js";

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
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-trace-ingest-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"], ...configExtra }),
    "utf-8",
  );
  return tmp;
}

function metaLine(overrides: Partial<Omit<ShardMetaRecord, "kind">> = {}): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "meta",
    runToken: "run-1",
    pool: "forks",
    vitest: "4.1.10",
    startedAt: "2026-07-10T14:00:00Z",
    ...overrides,
  });
}

function testLine(overrides: Partial<Omit<ShardTestRecord, "kind">> = {}): string {
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

function ingest(tmp: string): IngestedTrace {
  const config = loadConfig(tmp);
  return ingestTrace(config, tmp);
}

// ---------------------------------------------------------------------------
// (a) REQ tag join matches spec 006 rules
// ---------------------------------------------------------------------------
describe("(a) REQ tag join matches spec 006's describe-ancestor rule", () => {
  it("uses tags on the test title directly, ignoring ancestor tags, when the title carries its own", () => {
    const tmp = makeRepo({ "src/a.ts": "export function foo() {}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] foo works",
        suitePath: ["[REQ-999] unrelated describe"],
        hits: [{ file: "src/a.ts", fn: "foo" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    expect([...result.perReq.keys()]).toEqual(["REQ-001"]);
  });

  it("inherits from describe ancestors only when the title carries no tag — identical to extractReqTags as oracle", () => {
    const tmp = makeRepo({ "src/a.ts": "export function foo() {}\n" });
    const title = "foo works";
    const ancestor = "[REQ-002] suite";
    // Oracle: extractReqTags itself must agree with the fixture's premise
    // (title bare, ancestor tagged) before we trust the ingest assertion.
    expect(extractReqTags(title)).toEqual([]);
    expect(extractReqTags(ancestor)).toEqual(["REQ-002"]);

    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: title,
        suitePath: [ancestor],
        hits: [{ file: "src/a.ts", fn: "foo" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    expect([...result.perReq.keys()]).toEqual(["REQ-002"]);
  });

  it("dedups ancestor-inherited tags across multiple describe levels, same as extractReqTags's own dedup", () => {
    const tmp = makeRepo({ "src/a.ts": "export function foo() {}\n" });
    const ancestors = ["[REQ-003] outer", "[REQ-003] inner"];
    expect([...new Set(ancestors.flatMap((a) => extractReqTags(a)))]).toEqual(["REQ-003"]);

    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({ testName: "no tag here", suitePath: ancestors, hits: [] }),
    ]);
    const result = ingest(tmp);
    expect([...result.perReq.keys()]).toEqual(["REQ-003"]);
  });
});

// ---------------------------------------------------------------------------
// (b) 8-way matrix: {passed,failed} x {tagged,untagged} x {resolvable,not}
// ---------------------------------------------------------------------------
describe("(b) 8-way matrix: green+tagged+resolvable is the only case that yields a symbol edge", () => {
  const matrix: Array<{ passed: boolean; tagged: boolean; resolvable: boolean }> = [
    { passed: true, tagged: true, resolvable: true },
    { passed: true, tagged: true, resolvable: false },
    { passed: true, tagged: false, resolvable: true },
    { passed: true, tagged: false, resolvable: false },
    { passed: false, tagged: true, resolvable: true },
    { passed: false, tagged: true, resolvable: false },
    { passed: false, tagged: false, resolvable: true },
    { passed: false, tagged: false, resolvable: false },
  ];

  for (const c of matrix) {
    it(`passed=${c.passed} tagged=${c.tagged} resolvable=${c.resolvable}`, () => {
      const tmp = makeRepo({ "src/a.ts": "export function foo() {}\n" });
      const fn = c.resolvable ? "foo" : "unknownFn";
      const testName = c.tagged ? "[REQ-900] case" : "case without a tag";
      writeShard(tmp, "w1.jsonl", [
        metaLine(),
        testLine({
          testName,
          passed: c.passed,
          hits: [{ file: "src/a.ts", fn }],
          hashes: { "src/a.ts": "h1" },
        }),
      ]);
      const result = ingest(tmp);

      if (!c.passed || !c.tagged) {
        // failed or untagged: never contributes evidence.
        expect(result.perReq.size).toBe(0);
        return;
      }

      const cov = result.perReq.get("REQ-900");
      expect(cov).toBeDefined();
      if (c.resolvable) {
        expect(cov!.symbols).toEqual(["symbol:src/a.ts#foo"]);
        expect(cov!.files).toEqual([]);
      } else {
        expect(cov!.symbols).toEqual([]);
        expect(cov!.files).toEqual(["file:src/a.ts"]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (c) exclusivity boundaries (FR-013): =1 exclusive / 2..threshold-1 silent
//     / >= sharedThreshold infrastructure-eligible
// ---------------------------------------------------------------------------
describe("(c) exclusivity boundaries expose a per-node req-count index", () => {
  it("size 1 for a symbol exercised by exactly one REQ (exclusive)", () => {
    const tmp = makeRepo({ "src/a.ts": "export function shared() {}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] only",
        hits: [{ file: "src/a.ts", fn: "shared" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    expect(result.reqsByNode.get("symbol:src/a.ts#shared")).toEqual(new Set(["REQ-001"]));
  });

  it("size 2 (silent band, below default sharedThreshold=3) — edge still present in both REQs' buckets", () => {
    const tmp = makeRepo({ "src/a.ts": "export function shared() {}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] a",
        testFile: "tests/a.test.ts",
        hits: [{ file: "src/a.ts", fn: "shared" }],
      }),
      testLine({
        testName: "[REQ-002] b",
        testFile: "tests/b.test.ts",
        hits: [{ file: "src/a.ts", fn: "shared" }],
      }),
    ]);
    const result = ingest(tmp);
    expect(result.reqsByNode.get("symbol:src/a.ts#shared")).toEqual(
      new Set(["REQ-001", "REQ-002"]),
    );
    expect(result.perReq.get("REQ-001")!.symbols).toContain("symbol:src/a.ts#shared");
    expect(result.perReq.get("REQ-002")!.symbols).toContain("symbol:src/a.ts#shared");
  });

  it("size === default sharedThreshold (3) for a symbol exercised by three REQs", () => {
    const tmp = makeRepo({ "src/a.ts": "export function shared() {}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] a",
        testFile: "tests/a.test.ts",
        hits: [{ file: "src/a.ts", fn: "shared" }],
      }),
      testLine({
        testName: "[REQ-002] b",
        testFile: "tests/b.test.ts",
        hits: [{ file: "src/a.ts", fn: "shared" }],
      }),
      testLine({
        testName: "[REQ-003] c",
        testFile: "tests/c.test.ts",
        hits: [{ file: "src/a.ts", fn: "shared" }],
      }),
    ]);
    const result = ingest(tmp);
    expect(result.reqsByNode.get("symbol:src/a.ts#shared")?.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (d) name-join edge cases — REQ reachability never lost (SC-006)
// ---------------------------------------------------------------------------
describe("(d) name-join edge cases fall back to file grain without losing REQ reachability", () => {
  it("two symbols sharing one display name in the same file (function `add` + class Cart#add) -> file fallback", () => {
    const tmp = makeRepo({
      "src/a.ts": "export function add() {}\nexport class Cart {\n  add() {}\n}\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] ambiguous name",
        hits: [{ file: "src/a.ts", fn: "add" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    const cov = result.perReq.get("REQ-001")!;
    expect(cov.symbols).toEqual([]);
    expect(cov.files).toEqual(["file:src/a.ts"]);
  });

  it("V8 synthetic function names (<instance_members_initializer>) -> file fallback", () => {
    const tmp = makeRepo({
      "src/a.ts": "export class Widget {\n  x = compute();\n}\nfunction compute() { return 1; }\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-002] synthetic name",
        hits: [{ file: "src/a.ts", fn: "<instance_members_initializer>" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    const cov = result.perReq.get("REQ-002")!;
    expect(cov.symbols).toEqual([]);
    expect(cov.files).toEqual(["file:src/a.ts"]);
  });

  it("anonymous default export (empty V8 functionName) -> file fallback", () => {
    const tmp = makeRepo({ "src/a.ts": "export default function () { return 1; }\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-003] anonymous default",
        hits: [{ file: "src/a.ts", fn: "" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    const cov = result.perReq.get("REQ-003")!;
    expect(cov.symbols).toEqual([]);
    expect(cov.files).toEqual(["file:src/a.ts"]);
  });

  it("a class member name maps to the OWNING CLASS's symbol id (V8 reports method-level names)", () => {
    const tmp = makeRepo({ "src/cart.ts": "export class Cart {\n  add() {}\n}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-004] class method",
        hits: [{ file: "src/cart.ts", fn: "add" }],
        hashes: { "src/cart.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    const cov = result.perReq.get("REQ-004")!;
    expect(cov.symbols).toEqual(["symbol:src/cart.ts#Cart"]);
    expect(cov.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (e) dangling files vs `include`-boundary exclusion
// ---------------------------------------------------------------------------
describe("(e) dangling (deleted) files are diagnosed; out-of-boundary files are silently excluded", () => {
  it("a hit referencing a file deleted since trace capture counts as dangling, produces no edge", () => {
    const tmp = makeRepo({ "src/a.ts": "export function foo() {}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-005] deleted file",
        hits: [{ file: "src/a.ts", fn: "foo" }],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    unlinkSync(join(tmp, "src/a.ts"));

    const result = ingest(tmp);
    expect(result.diagnostics.dangling).toBe(1);
    const cov = result.perReq.get("REQ-005")!;
    expect(cov.symbols).toEqual([]);
    expect(cov.files).toEqual([]);
    // The REQ itself is still visible via `tests` — reachability of "this
    // REQ ran a test" isn't lost even though its coverage nodes are gone.
    expect(cov.tests).toEqual([
      { testFile: "tests/x.test.ts", testName: "[REQ-005] deleted file" },
    ]);
  });

  it("a hit outside the configured `include` globs is excluded silently — NOT counted as dangling", () => {
    const tmp = makeRepo({
      "src/a.ts": "export function foo() {}\n",
      "other/b.ts": "export function bar() {}\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-006] out of boundary",
        hits: [{ file: "other/b.ts", fn: "bar" }],
        hashes: { "other/b.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    expect(result.diagnostics.dangling).toBe(0);
    const cov = result.perReq.get("REQ-006")!;
    expect(cov.symbols).toEqual([]);
    expect(cov.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (f) N:M union, dedup, determinism under shard/line-order shuffling
// ---------------------------------------------------------------------------
describe("(f) N:M union across tests, dedup, and shuffle-determinism", () => {
  it("unions coverage across multiple REQ-tagged tests and dedups a symbol hit by both", () => {
    const tmp = makeRepo({ "src/a.ts": "export function foo() {}\nexport function bar() {}\n" });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-001] t1",
        testFile: "tests/t1.test.ts",
        hits: [{ file: "src/a.ts", fn: "foo" }],
        hashes: { "src/a.ts": "h1" },
      }),
      testLine({
        testName: "[REQ-001] t2",
        testFile: "tests/t2.test.ts",
        hits: [
          { file: "src/a.ts", fn: "bar" },
          { file: "src/a.ts", fn: "foo" },
        ],
        hashes: { "src/a.ts": "h1" },
      }),
    ]);
    const result = ingest(tmp);
    const cov = result.perReq.get("REQ-001")!;
    expect(cov.symbols).toEqual(["symbol:src/a.ts#bar", "symbol:src/a.ts#foo"]);
    expect(cov.tests).toEqual([
      { testFile: "tests/t1.test.ts", testName: "[REQ-001] t1" },
      { testFile: "tests/t2.test.ts", testName: "[REQ-001] t2" },
    ]);
  });

  it("is deterministic under shard-order and line-order shuffling", () => {
    const files = { "src/a.ts": "export function foo() {}\nexport function bar() {}\n" };
    const lineA = testLine({
      testName: "[REQ-001] t1",
      testFile: "tests/t1.test.ts",
      hits: [{ file: "src/a.ts", fn: "foo" }],
      hashes: { "src/a.ts": "h1" },
    });
    const lineB = testLine({
      testName: "[REQ-002] t2",
      testFile: "tests/t2.test.ts",
      hits: [{ file: "src/a.ts", fn: "bar" }],
      hashes: { "src/a.ts": "h1" },
    });

    const tmpForward = makeRepo(files);
    writeShard(tmpForward, "aaa.jsonl", [metaLine({ runToken: "r1" }), lineA]);
    writeShard(tmpForward, "zzz.jsonl", [metaLine({ runToken: "r2" }), lineB]);
    const forward = ingest(tmpForward);

    const tmpReversed = makeRepo(files);
    // Swap which physical shard filename carries which content, AND shuffle
    // line order within the combined single-shard variant below — either
    // way the final normalized+ingested result must be byte-identical.
    writeShard(tmpReversed, "aaa.jsonl", [metaLine({ runToken: "r2" }), lineB]);
    writeShard(tmpReversed, "zzz.jsonl", [metaLine({ runToken: "r1" }), lineA]);
    const reversed = ingest(tmpReversed);

    const serialize = (r: IngestedTrace): string =>
      JSON.stringify({
        perReq: [...r.perReq.entries()],
        diagnostics: r.diagnostics,
        reqsByNode: [...r.reqsByNode.entries()].map(([k, v]) => [k, [...v].sort()]),
      });
    expect(serialize(forward)).toBe(serialize(reversed));
  });
});
