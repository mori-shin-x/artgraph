import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setup, { withTrace } from "../src/vitest/setup.js";

// spec 020 (Phase A-1, US1, T007) — `withTrace()` config wrapper + the
// shard-cleanup `globalSetup` it wires in
// (contracts/cli-surface.md §1, contract §ファイル配置 "世代" — a killed or
// interrupted prior run must never leave shards that contaminate this run,
// ⑤ 実運用の事故パターン).

function mkTemp(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-vitest-setup-"));
}

describe("withTrace", () => {
  // ②組合せ: ラッパーがユーザーの既存 test 設定(reporters / setupFiles / pool)を破壊しない
  it("sets test.runner and preserves reporters / setupFiles / pool untouched", () => {
    const merged = withTrace({
      test: {
        reporters: ["default", "json"],
        setupFiles: ["./vitest.setup.ts"],
        pool: "threads",
      },
    });
    expect(merged.test?.reporters).toEqual(["default", "json"]);
    expect(merged.test?.setupFiles).toEqual(["./vitest.setup.ts"]);
    expect(merged.test?.pool).toBe("threads");
    expect(typeof merged.test?.runner).toBe("string");
    expect(merged.test?.runner).toMatch(/runner\.js$/);
  });

  it("preserves top-level config keys outside `test`", () => {
    const merged = withTrace({ resolve: { alias: {} }, test: {} });
    expect(merged).toHaveProperty("resolve");
    expect((merged as { resolve: unknown }).resolve).toEqual({ alias: {} });
  });

  it("defaults to an empty config when called with no argument", () => {
    const merged = withTrace();
    expect(typeof merged.test?.runner).toBe("string");
    expect(merged.test?.globalSetup).toHaveLength(1);
  });

  // 既存 globalSetup(string)への追記
  it("appends to an existing string globalSetup instead of replacing it", () => {
    const merged = withTrace({ test: { globalSetup: "./my-setup.ts" } });
    expect(Array.isArray(merged.test?.globalSetup)).toBe(true);
    const arr = merged.test?.globalSetup as string[];
    expect(arr[0]).toBe("./my-setup.ts");
    expect(arr).toHaveLength(2);
    expect(arr[1]).toMatch(/setup\.(js|ts)$/);
  });

  // 既存 globalSetup(array)への追記
  it("appends to an existing globalSetup array", () => {
    const merged = withTrace({ test: { globalSetup: ["./a.ts", "./b.ts"] } });
    const arr = merged.test?.globalSetup as string[];
    expect(arr.slice(0, 2)).toEqual(["./a.ts", "./b.ts"]);
    expect(arr).toHaveLength(3);
  });

  // idempotence: applying withTrace twice must not duplicate its own entry
  it("does not duplicate its own globalSetup entry when applied twice", () => {
    const once = withTrace({});
    const twice = withTrace(once);
    expect(twice.test?.globalSetup).toEqual(once.test?.globalSetup);
  });
});

describe("globalSetup (stale-shard cleanup)", () => {
  // ⑤事故パターン: 前回 run の旧 shard が残ったまま再実行 → globalSetup が削除
  it("deletes stale *.jsonl shards under <root>/.artgraph/trace before a run", async () => {
    const root = mkTemp();
    try {
      const traceDir = join(root, ".artgraph/trace");
      mkdirSync(traceDir, { recursive: true });
      writeFileSync(join(traceDir, "111-t0-oldrun.jsonl"), '{"kind":"meta"}\n');
      writeFileSync(join(traceDir, "222-t0-oldrun.jsonl"), '{"kind":"meta"}\n');
      writeFileSync(join(traceDir, "keep.txt"), "not a shard");

      await setup({ config: { root } });

      expect(readdirSync(traceDir)).toEqual(["keep.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the trace dir doesn't exist yet", async () => {
    const root = mkTemp();
    try {
      await expect(setup({ config: { root } })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to process.cwd() when called with no context (direct globalSetup wiring)", async () => {
    // Only asserts it doesn't throw — process.cwd() here is the repo/worktree
    // root, which has no `.artgraph/trace` shards to delete in a test run.
    await expect(setup()).resolves.toBeUndefined();
  });

  it("honors ARTGRAPH_TRACE_DIR, mirroring the runner's own trace-dir resolution", async () => {
    const root = mkTemp();
    const prev = process.env.ARTGRAPH_TRACE_DIR;
    try {
      const override = join(root, "custom-trace-dir");
      mkdirSync(override, { recursive: true });
      writeFileSync(join(override, "1-t0-a.jsonl"), "{}\n");
      process.env.ARTGRAPH_TRACE_DIR = override;

      await setup({ config: { root } });

      expect(readdirSync(override)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_DIR;
      else process.env.ARTGRAPH_TRACE_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
