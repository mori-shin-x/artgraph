import { defineConfig } from "vitest/config";

// Main suite — fast, in-process, parallel across files. The perf suite
// (tests/perf/**) is excluded here and runs under `vitest.perf.config.ts`
// so its `spawnSync` doesn't fight the in-process workers for CPU.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/**",
      "examples/**",
      "tests/perf/**",
    ],
    testTimeout: 30000,
  },
});
