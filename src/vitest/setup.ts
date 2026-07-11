// spec 020 (Phase A-1, US1, T007) — `artgraph/vitest/config`
// (`package.json#exports["./vitest/config"]`): `withTrace()`, a config
// wrapper that wires this package's runner (T006) + a shard-cleanup
// `globalSetup` into a user's vitest config (contracts/cli-surface.md §1).
//
// Dependency boundary (plan.md Structure Decision): node builtins only —
// same isolation rule as runner.ts (src/vitest/**'s only allowed `src/`
// import is `src/trace/schema.ts`, and this file doesn't even need that).
import { existsSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

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
 */
export interface WithTraceConfig {
  test?: {
    runner?: string;
    globalSetup?: string | string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * contracts/cli-surface.md §1:
 * ```ts
 * import { withTrace } from 'artgraph/vitest/config';
 * export default defineConfig(withTrace({ test: { ... } }));
 * ```
 * Sets `test.runner` to this package's runner and appends this package's
 * `globalSetup` (shard cleanup, see `setup` below) — every other `test.*`
 * key (`reporters`, `setupFiles`, `pool`, …) and every top-level key is
 * spread through unchanged. If the caller already listed a `globalSetup`
 * (string or array), this package's entry is appended, not substituted
 * (idempotent — appending twice is a no-op).
 */
export function withTrace<T extends WithTraceConfig>(userConfig: T = {} as T): T {
  const existing = userConfig.test?.globalSetup;
  const existingArr = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const globalSetup = existingArr.includes(SETUP_PATH) ? existingArr : [...existingArr, SETUP_PATH];

  return {
    ...userConfig,
    test: {
      ...userConfig.test,
      runner: RUNNER_PATH,
      globalSetup,
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
