import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION,
  parseShardLines,
  normalizeTrace,
  type ShardMetaRecord,
  type ShardTestRecord,
  type ShardSkippedRecord,
} from "../src/trace/schema.js";

// spec 020 (contracts/trace-artifact.md) — shard JSONL schema, the SSOT that
// the (future) vitest runner writes and `src/trace/ingest.ts` reads. This
// suite fixes T003's Red scenarios; `src/trace/schema.ts` (T004) makes it
// Green.

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
    testName: "[REQ-001] signIn accepts valid credentials",
    suitePath: ["auth"],
    testFile: "tests/auth.test.ts",
    passed: true,
    hits: [{ file: "src/auth.ts", fn: "signIn" }],
    hashes: { "src/auth.ts": "sha256:abc" },
    ...overrides,
  });
}

function skippedLine(overrides: Partial<Omit<ShardSkippedRecord, "kind">> = {}): string {
  return JSON.stringify({
    kind: "skipped",
    testName: "[REQ-009] flaky concurrent test",
    testFile: "tests/x.test.ts",
    reason: "concurrent",
    ...overrides,
  });
}

describe("SCHEMA_VERSION", () => {
  it("is the current shard schema generation (1)", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("parseShardLines", () => {
  // ①境界: 空 shard
  it("returns empty structures for an empty shard", () => {
    const shard = parseShardLines("");
    expect(shard.meta).toBeUndefined();
    expect(shard.tests).toEqual([]);
    expect(shard.skipped).toEqual([]);
    expect(shard.corruptedLines).toBe(0);
    expect(shard.unknownSchema).toBe(false);
  });

  // ①境界: meta 行のみ
  it("parses a meta-only shard", () => {
    const shard = parseShardLines(metaLine() + "\n");
    expect(shard.meta?.runToken).toBe("run-1");
    expect(shard.meta?.pool).toBe("forks");
    expect(shard.tests).toEqual([]);
    expect(shard.skipped).toEqual([]);
    expect(shard.unknownSchema).toBe(false);
  });

  // ①境界: hits 空配列のテストレコード
  it("parses a test record with an empty hits array", () => {
    const shard = parseShardLines([metaLine(), testLine({ hits: [], hashes: {} })].join("\n"));
    expect(shard.tests).toHaveLength(1);
    expect(shard.tests[0]!.hits).toEqual([]);
    expect(shard.tests[0]!.passed).toBe(true);
  });

  it("parses a skipped record", () => {
    const shard = parseShardLines([metaLine(), skippedLine()].join("\n"));
    expect(shard.skipped).toHaveLength(1);
    expect(shard.skipped[0]!.reason).toBe("concurrent");
  });

  // ④例外: schemaVersion 未知
  it("flags an unknown schemaVersion on the shard (does not throw)", () => {
    const shard = parseShardLines([metaLine({ schemaVersion: 999 }), testLine()].join("\n"));
    expect(shard.unknownSchema).toBe(true);
    // The record is still parsed — exclusion from derivation is normalizeTrace's job,
    // not parseShardLines's, so silent loss can't happen at either layer.
    expect(shard.tests).toHaveLength(1);
  });

  // ④例外: JSONL 破損行(途中 kill された run)
  it("counts a corrupted (truncated) JSONL line as a diagnostic without aborting the rest of the shard", () => {
    const truncated = '{"kind":"test","testName":"[REQ-001] broken';
    const shard = parseShardLines([metaLine(), truncated, testLine()].join("\n"));
    expect(shard.corruptedLines).toBe(1);
    expect(shard.tests).toHaveLength(1);
  });

  it("counts a structurally-invalid record (valid JSON, wrong shape) as corrupted", () => {
    const shard = parseShardLines(
      [metaLine(), JSON.stringify({ kind: "test", testName: "missing required fields" })].join(
        "\n",
      ),
    );
    expect(shard.corruptedLines).toBe(1);
    expect(shard.tests).toHaveLength(0);
  });

  it("ignores blank lines without counting them as corrupted", () => {
    const shard = parseShardLines([metaLine(), "", testLine(), ""].join("\n"));
    expect(shard.corruptedLines).toBe(0);
    expect(shard.tests).toHaveLength(1);
  });
});

describe("normalizeTrace", () => {
  it("produces empty output for an empty shard", () => {
    const trace = normalizeTrace([parseShardLines("")]);
    expect(trace.tests).toEqual([]);
    expect(trace.skipped).toEqual([]);
    expect(trace.diagnostics).toEqual({ unknownSchema: 0, corrupted: 0, skipped: 0, dangling: 0 });
  });

  // ⑥エッジ: 同一レコード重複 → dedup
  it("dedups byte-identical duplicate test records", () => {
    const shard = parseShardLines([metaLine(), testLine(), testLine()].join("\n"));
    const trace = normalizeTrace([shard]);
    expect(trace.tests).toHaveLength(1);
  });

  // ⑥エッジ: 同一テスト名が複数ファイルに存在 → dedup 対象ではない
  it("keeps same-named tests in different files as distinct entries", () => {
    const shardA = parseShardLines(
      [metaLine(), testLine({ testFile: "tests/a.test.ts" })].join("\n"),
    );
    const shardB = parseShardLines(
      [metaLine(), testLine({ testFile: "tests/b.test.ts" })].join("\n"),
    );
    const trace = normalizeTrace([shardA, shardB]);
    expect(trace.tests).toHaveLength(2);
    expect(trace.tests.map((t) => t.testFile)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });

  // ④例外: unknownSchema shard → 診断カウント + エッジ導出には使わない(silent skip 禁止)
  it("excludes an unknown-schemaVersion shard's records but counts the diagnostic", () => {
    const shard = parseShardLines([metaLine({ schemaVersion: 999 }), testLine()].join("\n"));
    const trace = normalizeTrace([shard]);
    expect(trace.tests).toEqual([]);
    expect(trace.diagnostics.unknownSchema).toBe(1);
  });

  it("propagates corrupted-line counts from parsed shards", () => {
    const shard = parseShardLines([metaLine(), '{"kind":"test"', testLine()].join("\n"));
    const trace = normalizeTrace([shard]);
    expect(trace.diagnostics.corrupted).toBe(1);
    expect(trace.tests).toHaveLength(1);
  });

  it("counts skipped records in diagnostics", () => {
    const shard = parseShardLines([metaLine(), skippedLine()].join("\n"));
    const trace = normalizeTrace([shard]);
    expect(trace.skipped).toHaveLength(1);
    expect(trace.diagnostics.skipped).toBe(1);
  });

  it("normalizes hit order + dedups repeated hits within a single record", () => {
    const shard = parseShardLines(
      [
        metaLine(),
        testLine({
          hits: [
            { file: "src/b.ts", fn: "y" },
            { file: "src/a.ts", fn: "x" },
            { file: "src/a.ts", fn: "x" },
          ],
        }),
      ].join("\n"),
    );
    const trace = normalizeTrace([shard]);
    expect(trace.tests[0]!.hits).toEqual([
      { file: "src/a.ts", fn: "x" },
      { file: "src/b.ts", fn: "y" },
    ]);
  });

  // 決定性: shard 読込み順のシャッフル
  it("is deterministic under shard-order shuffling", () => {
    const shardA = parseShardLines(
      [
        metaLine({ runToken: "a" }),
        testLine({ testFile: "tests/a.test.ts", testName: "[REQ-001] a" }),
      ].join("\n"),
    );
    const shardB = parseShardLines(
      [
        metaLine({ runToken: "b" }),
        testLine({ testFile: "tests/b.test.ts", testName: "[REQ-002] b" }),
      ].join("\n"),
    );
    const forward = normalizeTrace([shardA, shardB]);
    const reversed = normalizeTrace([shardB, shardA]);
    expect(forward).toEqual(reversed);
  });

  // 決定性: shard 内の行順のシャッフル
  it("is deterministic under line-order shuffling within a shard", () => {
    const lines = [
      metaLine(),
      testLine({
        testFile: "tests/a.test.ts",
        testName: "[REQ-001] a",
        hits: [
          { file: "src/a.ts", fn: "a" },
          { file: "src/b.ts", fn: "b" },
        ],
      }),
      testLine({ testFile: "tests/c.test.ts", testName: "[REQ-002] c" }),
      skippedLine({ testFile: "tests/d.test.ts", testName: "[REQ-003] d" }),
    ];
    const forward = normalizeTrace([parseShardLines(lines.join("\n"))]);
    const shuffled = [lines[0]!, lines[3]!, lines[1]!, lines[2]!];
    const afterShuffle = normalizeTrace([parseShardLines(shuffled.join("\n"))]);
    expect(forward).toEqual(afterShuffle);
  });
});
