import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setup, { withTrace } from "../src/vitest/setup.js";
import { PLUGIN_NAME } from "../src/vitest/plugin.js";

// spec 020 (Phase A-1, US1, T007) — `withTrace()` config wrapper + the
// shard-cleanup `globalSetup` it wires in
// (contracts/cli-surface.md §1, contract §ファイル配置 "世代" — a killed or
// interrupted prior run must never leave shards that contaminate this run,
// ⑤ 実運用の事故パターン).
//
// spec 021 (Phase 5, US3, T014) — `withTrace(config, options?)`'s second
// argument, `{ engine?: 'instrument' | 'cdp' }`
// (contracts/config-surface.md §`withTrace(config, options?)`).

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

// spec 021 T014 (観点 2・3・5) — `withTrace(config, options?)`'s `engine`
// option (contracts/config-surface.md).
describe("withTrace engine option", () => {
  // ③不正な状態遷移: bogus engine values must fail fast, not silently fall
  // back to a default (contracts/config-surface.md "不正値は withTrace 呼び
  // 出し時に throw").
  it("throws synchronously for an invalid engine value, naming the valid values", () => {
    expect(() => withTrace({}, { engine: "bogus" as never })).toThrowError(/instrument/);
    expect(() => withTrace({}, { engine: "bogus" as never })).toThrowError(/cdp/);
  });

  it("defaults to the instrument engine when options is omitted entirely", () => {
    const merged = withTrace({});
    const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
    expect(plugins.filter((p) => p?.name === PLUGIN_NAME)).toHaveLength(1);
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("instrument");
  });

  it("defaults to the instrument engine when options.engine is omitted", () => {
    const merged = withTrace({}, {});
    const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
    expect(plugins.filter((p) => p?.name === PLUGIN_NAME)).toHaveLength(1);
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("instrument");
  });

  // ②組合せ (観点2・5): applying withTrace twice with engine: 'instrument'
  // must not duplicate the plugin — idempotent by plugin name (PLUGIN_NAME),
  // mirroring the existing globalSetup idempotence test above.
  it("injects the trace plugin exactly once even when withTrace is applied twice", () => {
    const once = withTrace({}, { engine: "instrument" });
    const twice = withTrace(once, { engine: "instrument" });
    const plugins = (twice.plugins ?? []) as Array<{ name?: string }>;
    expect(plugins.filter((p) => p?.name === PLUGIN_NAME)).toHaveLength(1);
  });

  it("preserves pre-existing plugins alongside the injected trace plugin", () => {
    const existingPlugin = { name: "user-existing-plugin" };
    const merged = withTrace({ plugins: [existingPlugin] }, { engine: "instrument" });
    const plugins = merged.plugins as Array<{ name?: string }>;
    expect(plugins).toContainEqual(existingPlugin);
    expect(plugins.filter((p) => p?.name === PLUGIN_NAME)).toHaveLength(1);
  });

  it("does not inject the trace plugin for the cdp engine", () => {
    const existingPlugin = { name: "user-existing-plugin" };
    const merged = withTrace({ plugins: [existingPlugin] }, { engine: "cdp" });
    const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
    expect(plugins.some((p) => p?.name === PLUGIN_NAME)).toBe(false);
    expect(plugins).toContainEqual(existingPlugin);
  });

  it("sets test.env.ARTGRAPH_TRACE_ENGINE to 'cdp' for the cdp engine", () => {
    const merged = withTrace({}, { engine: "cdp" });
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("cdp");
  });

  it("sets test.env.ARTGRAPH_TRACE_ENGINE to 'instrument' for the instrument engine", () => {
    const merged = withTrace({}, { engine: "instrument" });
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("instrument");
  });

  // contracts/config-surface.md 環境変数: "withTrace オプションより優先" —
  // if the user already set test.env.ARTGRAPH_TRACE_ENGINE, withTrace must
  // not overwrite it, for either engine.
  it("does not overwrite a user-provided test.env.ARTGRAPH_TRACE_ENGINE (instrument)", () => {
    const merged = withTrace(
      { test: { env: { ARTGRAPH_TRACE_ENGINE: "user-set-value" } } },
      { engine: "instrument" },
    );
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("user-set-value");
  });

  it("does not overwrite a user-provided test.env.ARTGRAPH_TRACE_ENGINE (cdp)", () => {
    const merged = withTrace(
      { test: { env: { ARTGRAPH_TRACE_ENGINE: "user-set-value" } } },
      { engine: "cdp" },
    );
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("user-set-value");
  });

  it("preserves other test.env keys untouched", () => {
    const merged = withTrace({ test: { env: { OTHER_VAR: "keep-me" } } }, { engine: "instrument" });
    expect(merged.test?.env?.OTHER_VAR).toBe("keep-me");
    expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("instrument");
  });

  // ②組合せの直積 (観点2): engine(instrument/cdp) × 既存 plugins(有/無) ×
  // 既存 globalSetup(string/array/none) × ユーザー設定済み test.env の
  // ARTGRAPH_TRACE_ENGINE(有/無) — every combination must still uphold the
  // invariants above (runner set, globalSetup appended once, plugin
  // injection matches engine, user env value never overwritten).
  const ENGINES = ["instrument", "cdp"] as const;
  const PLUGIN_PRESENCE = [true, false] as const;
  const GLOBAL_SETUP_SHAPES = ["string", "array", "none"] as const;
  const USER_ENV_PRESENCE = [true, false] as const;

  type Combo = {
    engine: (typeof ENGINES)[number];
    pluginsPresent: boolean;
    globalSetupShape: (typeof GLOBAL_SETUP_SHAPES)[number];
    userEnvSet: boolean;
  };

  const combos: Combo[] = [];
  for (const engine of ENGINES) {
    for (const pluginsPresent of PLUGIN_PRESENCE) {
      for (const globalSetupShape of GLOBAL_SETUP_SHAPES) {
        for (const userEnvSet of USER_ENV_PRESENCE) {
          combos.push({ engine, pluginsPresent, globalSetupShape, userEnvSet });
        }
      }
    }
  }

  it.each(combos)(
    "engine=$engine pluginsPresent=$pluginsPresent globalSetup=$globalSetupShape userEnvSet=$userEnvSet",
    ({ engine, pluginsPresent, globalSetupShape, userEnvSet }) => {
      const existingPlugin = { name: "user-existing-plugin" };
      const userConfig: Record<string, unknown> = {
        test: {
          reporters: ["default"],
          ...(userEnvSet ? { env: { ARTGRAPH_TRACE_ENGINE: "user-set-value" } } : {}),
          ...(globalSetupShape === "string"
            ? { globalSetup: "./my-setup.ts" }
            : globalSetupShape === "array"
              ? { globalSetup: ["./a.ts", "./b.ts"] }
              : {}),
        },
        ...(pluginsPresent ? { plugins: [existingPlugin] } : {}),
      };

      const merged = withTrace(userConfig, { engine });

      // Regression: test.runner is always set, other test.* keys pass through.
      expect(typeof merged.test?.runner).toBe("string");
      expect(merged.test?.runner).toMatch(/runner\.js$/);
      expect(merged.test?.reporters).toEqual(["default"]);

      // Regression: globalSetup is always appended (once), never replaced.
      const globalSetup = merged.test?.globalSetup as string[];
      expect(Array.isArray(globalSetup)).toBe(true);
      const expectedLength =
        globalSetupShape === "string" ? 2 : globalSetupShape === "array" ? 3 : 1;
      expect(globalSetup).toHaveLength(expectedLength);
      if (globalSetupShape === "string") expect(globalSetup[0]).toBe("./my-setup.ts");
      if (globalSetupShape === "array")
        expect(globalSetup.slice(0, 2)).toEqual(["./a.ts", "./b.ts"]);

      // Plugin injection matches engine, existing plugins always preserved.
      const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
      if (pluginsPresent) expect(plugins).toContainEqual(existingPlugin);
      const injectedCount = plugins.filter((p) => p?.name === PLUGIN_NAME).length;
      expect(injectedCount).toBe(engine === "instrument" ? 1 : 0);

      // test.env.ARTGRAPH_TRACE_ENGINE: user value wins; otherwise set to engine.
      expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe(userEnvSet ? "user-set-value" : engine);
    },
  );
});

// spec 021 T023 real bug — contracts/config-surface.md §環境変数's stated
// priority (process env > withTrace option > default) was inverted in the
// implementation: `withTrace` baked `options.engine` straight into
// `test.env.ARTGRAPH_TRACE_ENGINE`, so a shell-level
// `ARTGRAPH_TRACE_ENGINE=cdp pnpm vitest run` never reached the worker (it
// read `process.env` in the WORKER, which only ever saw what `test.env`
// handed it — `withTrace`'s own baked-in value, not the real shell env).
// This block reads `process.env.ARTGRAPH_TRACE_ENGINE` at withTrace-call
// time (main process, where the shell var IS visible) and restores it in
// `finally` so no test leaks its override into a sibling test.
describe("withTrace: process.env.ARTGRAPH_TRACE_ENGINE precedence (contracts/config-surface.md §環境変数)", () => {
  const prevEnv = () => process.env.ARTGRAPH_TRACE_ENGINE;

  it("(a) process.env='cdp' + options.engine unset -> resolves cdp (no plugin, test.env='cdp')", () => {
    const prev = prevEnv();
    try {
      process.env.ARTGRAPH_TRACE_ENGINE = "cdp";
      const merged = withTrace({});
      const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
      expect(plugins.some((p) => p?.name === PLUGIN_NAME)).toBe(false);
      expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("cdp");
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_ENGINE;
      else process.env.ARTGRAPH_TRACE_ENGINE = prev;
    }
  });

  it("(b) process.env='cdp' + options.engine='instrument' -> env wins, resolves cdp", () => {
    const prev = prevEnv();
    try {
      process.env.ARTGRAPH_TRACE_ENGINE = "cdp";
      const merged = withTrace({}, { engine: "instrument" });
      const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
      expect(plugins.some((p) => p?.name === PLUGIN_NAME)).toBe(false);
      expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("cdp");
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_ENGINE;
      else process.env.ARTGRAPH_TRACE_ENGINE = prev;
    }
  });

  it("(c) process.env='instrument' + options.engine='cdp' -> env wins, resolves instrument (plugin injected)", () => {
    const prev = prevEnv();
    try {
      process.env.ARTGRAPH_TRACE_ENGINE = "instrument";
      const merged = withTrace({}, { engine: "cdp" });
      const plugins = (merged.plugins ?? []) as Array<{ name?: string }>;
      expect(plugins.filter((p) => p?.name === PLUGIN_NAME)).toHaveLength(1);
      expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("instrument");
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_ENGINE;
      else process.env.ARTGRAPH_TRACE_ENGINE = prev;
    }
  });

  it("(d) process.env='bogus' -> withTrace throws synchronously (fail-fast moved to config-eval time, quickstart §7)", () => {
    const prev = prevEnv();
    try {
      process.env.ARTGRAPH_TRACE_ENGINE = "bogus";
      expect(() => withTrace({})).toThrowError(/instrument/);
      expect(() => withTrace({})).toThrowError(/cdp/);
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_ENGINE;
      else process.env.ARTGRAPH_TRACE_ENGINE = prev;
    }
  });

  it("(e) process.env unset -> unchanged from prior behavior (options.engine / default decide)", () => {
    const prev = prevEnv();
    try {
      delete process.env.ARTGRAPH_TRACE_ENGINE;

      const withOption = withTrace({}, { engine: "cdp" });
      expect(withOption.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("cdp");
      const optionPlugins = (withOption.plugins ?? []) as Array<{ name?: string }>;
      expect(optionPlugins.some((p) => p?.name === PLUGIN_NAME)).toBe(false);

      const withDefault = withTrace({});
      expect(withDefault.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("instrument");
      const defaultPlugins = (withDefault.plugins ?? []) as Array<{ name?: string }>;
      expect(defaultPlugins.filter((p) => p?.name === PLUGIN_NAME)).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_ENGINE;
      else process.env.ARTGRAPH_TRACE_ENGINE = prev;
    }
  });

  it("a user-explicit test.env.ARTGRAPH_TRACE_ENGINE still wins over process.env (existing carve-out, unchanged)", () => {
    const prev = prevEnv();
    try {
      process.env.ARTGRAPH_TRACE_ENGINE = "cdp";
      const merged = withTrace(
        { test: { env: { ARTGRAPH_TRACE_ENGINE: "user-set-value" } } },
        { engine: "instrument" },
      );
      expect(merged.test?.env?.ARTGRAPH_TRACE_ENGINE).toBe("user-set-value");
    } finally {
      if (prev === undefined) delete process.env.ARTGRAPH_TRACE_ENGINE;
      else process.env.ARTGRAPH_TRACE_ENGINE = prev;
    }
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
