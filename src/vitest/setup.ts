// spec 020 (Phase A-1, US1, T007) — `artgraph/vitest/config`
// (`package.json#exports["./vitest/config"]`): `withTrace()`, a config
// wrapper that wires this package's runner (T006) + a shard-cleanup
// `globalSetup` into a user's vitest config (contracts/cli-surface.md §1).
//
// Dependency boundary (plan.md Structure Decision; revised spec 021 tasks.md
// T015): this module runs in the MAIN process (it builds a vitest config
// object, never a worker), so — unlike runner.ts, which must stay
// vitest/runners-free for the worker boundary — it MAY import the v2
// instrumentation plugin (src/vitest/plugin.ts) and, transitively, that
// module's own main-process dependencies (oxc-parser, magic-string,
// src/trace/schema.ts). It still must never import `vitest/runners` itself
// or anything worker-only.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import artgraphTracePlugin, { PLUGIN_NAME } from "./plugin.js";

// Mirrors runner.ts's `resolveTraceDir` exactly (kept duplicated rather than
// factored into a shared module — see runner.ts's dependency-boundary
// comment). Both must resolve to the same directory for the "delete last
// run's shards before this run starts" contract to hold.
function resolveTraceDir(root: string): string {
  const override = process.env.ARTGRAPH_TRACE_DIR;
  if (!override) return resolve(root, ".artgraph/trace");
  return isAbsolute(override) ? override : resolve(root, override);
}

// Resolved once, relative to this module's own location — `runner.js` ships
// alongside `setup.js` in `dist/vitest/` (package.json#exports), so this
// works whether the package is consumed from `node_modules` or (in this
// repo's own e2e/tests) directly out of `dist/`.
const RUNNER_PATH = fileURLToPath(new URL("./runner.js", import.meta.url));
const SETUP_PATH = fileURLToPath(import.meta.url);

/**
 * Loose structural shape of the subset of a Vitest `UserConfig` this module
 * touches. Deliberately not `vitest/config`'s own `UserConfig` type — that
 * type is only available via Vite's module augmentation of `vite`'s
 * `UserConfig`, which isn't re-exported under a plain name, and pinning to
 * it would couple this wrapper to one exact vitest major version. Every
 * other key (any Vite/Vitest option) passes through untouched via the index
 * signature.
 *
 * `plugins` (spec 021 T015, contracts/config-surface.md §plugin の適用範囲)
 * is a top-level Vite config key, not a `test.*` one — mirrored here as a
 * loosely-typed structural array (not `vite`'s own `PluginOption[]`, for the
 * same not-a-direct-dependency reason `WithTraceConfig` itself isn't `vite`'s
 * `UserConfig`) so `withTrace` can detect and append its own plugin by name.
 */
export interface WithTraceConfig {
  plugins?: unknown[];
  test?: {
    runner?: string;
    globalSetup?: string | string[];
    env?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** spec 021 (contracts/config-surface.md §`withTrace(config, options?)`). */
export type TraceEngine = "instrument" | "cdp";

/** `withTrace`'s new, optional second argument (spec 021 T015). */
export interface WithTraceOptions {
  /**
   * Capture engine to wire up. Default `'instrument'`. Invalid values throw
   * synchronously at `withTrace()` call time — fail-fast, no silent
   * fallback (contracts/config-surface.md).
   */
  engine?: TraceEngine;
}

const VALID_ENGINES: readonly TraceEngine[] = ["instrument", "cdp"];

const ENV_ENGINE_KEY = "ARTGRAPH_TRACE_ENGINE";

/**
 * contracts/cli-surface.md §1 / contracts/config-surface.md
 * §`withTrace(config, options?)`:
 * ```ts
 * import { withTrace } from 'artgraph/vitest/config';
 * export default defineConfig(withTrace({ test: { ... } }, { engine: 'instrument' }));
 * ```
 * Sets `test.runner` to this package's runner and appends this package's
 * `globalSetup` (shard cleanup, see `setup` below) — every other `test.*`
 * key (`reporters`, `setupFiles`, `pool`, …) and every top-level key is
 * spread through unchanged. If the caller already listed a `globalSetup`
 * (string or array), this package's entry is appended, not substituted
 * (idempotent — appending twice is a no-op).
 *
 * `options.engine` (spec 021 T015, default `'instrument'`) picks the capture
 * engine — subject to contracts/config-surface.md §環境変数's priority
 * order (high → low): the process environment variable
 * `ARTGRAPH_TRACE_ENGINE` (read HERE, at config-evaluation time in the main
 * process, where a shell-level override is visible — `ARTGRAPH_TRACE_ENGINE=cdp
 * pnpm vitest run`) wins over `options.engine`, which wins over the
 * `'instrument'` default:
 * - invalid values (from either source) throw synchronously here (fail-fast,
 *   no silent fallback — this is also why the check moved ahead of a worker
 *   ever spawning: quickstart.md §7's `ARTGRAPH_TRACE_ENGINE=bogus` case must
 *   fail at config evaluation, not inside a worker);
 * - `'instrument'` appends the v2 instrumentation plugin (`plugin.ts`) to
 *   top-level `plugins`, preserving any existing entries — detected by
 *   `PLUGIN_NAME` so applying `withTrace` twice never double-injects it
 *   (same idempotence shape as the `globalSetup` append above);
 * - `'cdp'` injects no plugin;
 * - either way, `test.env.ARTGRAPH_TRACE_ENGINE` is set to the resolved
 *   engine so the worker (runner.ts) can read it back — unless the caller
 *   already set that key themselves, in which case their value wins (the
 *   §環境変数 "ユーザー値優先" carve-out, orthogonal to the process-env vs.
 *   `options.engine` precedence above).
 */
export function withTrace<T extends WithTraceConfig>(
  userConfig: T = {} as T,
  options?: WithTraceOptions,
): T {
  // contracts/config-surface.md §環境変数: process env > withTrace option >
  // default. Read here (main process, config-evaluation time) rather than
  // baking `options.engine` into `test.env` for a worker to resolve later —
  // a worker never sees a shell-level env var that vitest's own config
  // loading already established the process env for, but reading it THERE
  // (runner.ts, historically) is too late: it can only see what `test.env`
  // handed it, so a real shell override was silently lost.
  const envEngine = process.env[ENV_ENGINE_KEY];
  const engine = (envEngine as TraceEngine | undefined) ?? options?.engine ?? "instrument";
  if (!VALID_ENGINES.includes(engine)) {
    throw new Error(
      `artgraph: withTrace({ engine }) received invalid value ${JSON.stringify(engine)}` +
        `${envEngine !== undefined ? ` (from process.env.${ENV_ENGINE_KEY})` : ""} — ` +
        `must be one of: ${VALID_ENGINES.join(", ")}.`,
    );
  }

  const existing = userConfig.test?.globalSetup;
  const existingArr = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const globalSetup = existingArr.includes(SETUP_PATH) ? existingArr : [...existingArr, SETUP_PATH];

  const existingPlugins = userConfig.plugins ?? [];
  const alreadyInjected = existingPlugins.some(
    (p) => p !== null && typeof p === "object" && (p as { name?: unknown }).name === PLUGIN_NAME,
  );
  const plugins =
    engine === "instrument" && !alreadyInjected
      ? [...existingPlugins, artgraphTracePlugin()]
      : existingPlugins;
  // Only surface a `plugins` key when there is something to say: the caller
  // already had one, or `instrument` just injected into it. This keeps `cdp`
  // with no pre-existing `plugins` from growing an empty array out of
  // nowhere (contracts/config-surface.md "'cdp' のとき: plugin を注入しない").
  const includePlugins = userConfig.plugins !== undefined || engine === "instrument";

  const existingEnv = userConfig.test?.env;
  const userSetEngineEnv = existingEnv !== undefined && Object.hasOwn(existingEnv, ENV_ENGINE_KEY);
  const env: Record<string, string> = {
    ...existingEnv,
    ...(userSetEngineEnv ? {} : { [ENV_ENGINE_KEY]: engine }),
  };

  return {
    ...userConfig,
    ...(includePlugins ? { plugins } : {}),
    test: {
      ...userConfig.test,
      runner: RUNNER_PATH,
      globalSetup,
      env,
    },
  };
}

interface GlobalSetupContext {
  config?: { root?: string };
}

/**
 * The `globalSetup` module `withTrace` wires in (also usable directly via
 * `test.globalSetup: ['artgraph/vitest/config']` without `withTrace`).
 * Vitest calls the default export once per run, passing the project/vitest
 * context (`{ config: { root, ... }, ... }`) — see `@vitest/runner`'s
 * `loadGlobalSetupFile`. Deletes every stale `*.jsonl` shard under the trace
 * dir before the run starts: generation replacement (contract §ファイル配置
 * "世代: run 開始時に globalSetup が既存 *.jsonl を削除") so this run's
 * shards never mix with a previous run's leftovers (⑤ 実運用の事故パターン —
 * a killed/interrupted prior run leaving shards behind).
 */
export default async function setup(ctx?: GlobalSetupContext): Promise<void> {
  const root = ctx?.config?.root ?? process.cwd();
  const dir = resolveTraceDir(root);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".jsonl")) {
      rmSync(resolve(dir, entry), { force: true });
    }
  }
}
