import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION,
  parseShardLines,
  normalizeTrace,
  isExcludedRelPath,
  TEST_FILE_RE,
  REGISTRY_KEY,
  REGISTRY_VERSION,
  type ShardMetaRecord,
  type ShardTestRecord,
  type ShardSkippedRecord,
  type ModuleRegistration,
  type TraceRegistry,
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
    expect(trace.diagnostics).toEqual({
      unknownSchema: 0,
      corrupted: 0,
      skipped: 0,
      dangling: 0,
      offGraph: 0,
    });
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

// spec 022 (tasks.md T003, contracts/instrumentation-runtime.md §変換のスキップ) —
// boundary tests for the exclusion-rule SSOT (観点1: 境界条件). Shared by
// `src/vitest/plugin.ts` (skip transform) and both runner engines via
// `src/trace/schema.ts`'s `isExcludedRelPath` / `TEST_FILE_RE`.
describe("isExcludedRelPath", () => {
  // ①境界: 相対化で `..` に出るパス(プロジェクトルート外)
  it("excludes a path that relativizes outside the project root (leading `..`)", () => {
    expect(isExcludedRelPath("../outside.ts")).toBe(true);
    expect(isExcludedRelPath("../../outside.ts")).toBe(true);
  });

  // ①境界: 絶対パス
  it("excludes an absolute path", () => {
    expect(isExcludedRelPath("/abs/path.ts")).toBe(true);
  });

  // ①境界: `node_modules/` を中間に含むパス
  it("excludes a path with `node_modules/` anywhere in the middle", () => {
    expect(isExcludedRelPath("node_modules/pkg/index.ts")).toBe(true);
    expect(isExcludedRelPath("src/node_modules/pkg/index.ts")).toBe(true);
    expect(isExcludedRelPath("packages/app/node_modules/pkg/deep/file.ts")).toBe(true);
  });

  // ①境界: `.test.`/`.spec.` × 全対象拡張子(js|jsx|ts|tsx|cjs|mjs|cts|mts)の全組合せ
  const extensions = ["js", "jsx", "ts", "tsx", "cjs", "mjs", "cts", "mts"] as const;
  const markers = ["test", "spec"] as const;
  for (const marker of markers) {
    for (const ext of extensions) {
      it(`excludes a \`.${marker}.${ext}\` test file`, () => {
        expect(isExcludedRelPath(`src/foo.${marker}.${ext}`)).toBe(true);
        expect(TEST_FILE_RE.test(`src/foo.${marker}.${ext}`)).toBe(true);
      });
    }
  }

  // ⑥エッジ: `node_modules` を**含まない**類似名は除外されないこと
  it("does NOT exclude a directory whose name merely resembles `node_modules`", () => {
    expect(isExcludedRelPath("my_node_modules/foo.ts")).toBe(false);
    expect(isExcludedRelPath("src/my_node_modules/foo.ts")).toBe(false);
    expect(isExcludedRelPath("node_modules_backup/foo.ts")).toBe(false);
  });

  // 正常系サニティ: 通常のプロジェクト内ソースは除外されない
  it("does not exclude an ordinary project-relative source path", () => {
    expect(isExcludedRelPath("src/index.ts")).toBe(false);
    expect(isExcludedRelPath("src/trace/schema.ts")).toBe(false);
  });
});

// spec 022 (tasks.md T005, contracts/instrumentation-runtime.md) — SSOT pair
// (c) equivalence: the `globalThis[REGISTRY_KEY]` shape this module defines
// must match the contract doc's literal description, byte-for-byte on the
// two constants and structurally on `ModuleRegistration`.
describe("instrumentation registry contract (contracts/instrumentation-runtime.md)", () => {
  it("REGISTRY_KEY matches the contract's documented globalThis key", () => {
    expect(REGISTRY_KEY).toBe("__ARTGRAPH_TRACE_REGISTRY__");
  });

  it("REGISTRY_VERSION matches the contract's documented version (1)", () => {
    expect(REGISTRY_VERSION).toBe(1);
  });

  it("a well-formed ModuleRegistration satisfies fns.length === hits.length", () => {
    const registration: ModuleRegistration = {
      file: "src/example.ts",
      hash: "0123456789abcdef",
      fns: ["foo", "bar", "baz"],
      hits: new Uint8Array(3),
    };
    expect(registration.fns.length).toBe(registration.hits.length);
  });

  it("an empty-module ModuleRegistration (zero functions) also satisfies the invariant", () => {
    const registration: ModuleRegistration = {
      file: "src/empty.ts",
      hash: "0123456789abcdef",
      fns: [],
      hits: new Uint8Array(0),
    };
    expect(registration.fns.length).toBe(registration.hits.length);
  });

  it("modules.set(file, registration) replaces a prior registration for the same relPath", () => {
    const registry: TraceRegistry = { version: REGISTRY_VERSION, modules: new Map() };
    const stale: ModuleRegistration = {
      file: "src/reeval.ts",
      hash: "aaaaaaaaaaaaaaaa",
      fns: ["old"],
      hits: new Uint8Array([1]),
    };
    const fresh: ModuleRegistration = {
      file: "src/reeval.ts",
      hash: "bbbbbbbbbbbbbbbb",
      fns: ["old", "new"],
      hits: new Uint8Array([0, 0]),
    };
    registry.modules.set(stale.file, stale);
    registry.modules.set(fresh.file, fresh);
    expect(registry.modules.size).toBe(1);
    expect(registry.modules.get("src/reeval.ts")).toBe(fresh);
  });
});
