import { defineConfig } from "vitest/config";

// Main suite — fast, in-process, parallel across files. Suites that spawn
// the built bin (perf + e2e) run under their own configs so their
// `spawnSync` calls don't fight the in-process workers for CPU.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/**",
      "examples/**",
      "tests/perf/**",
      "tests/e2e/**",
    ],
    testTimeout: 30000,
  },
});
