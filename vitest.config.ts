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
    // Coverage is scoped to the unit suite — e2e/perf spawn the built bin
    // as a child process, so v8 instrumentation in this runner doesn't
    // reach that code. Run with `pnpm test:coverage`.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "dist/**",
        "tests/**",
        "examples/**",
      ],
      reportsDirectory: "coverage",
    },
  },
});
