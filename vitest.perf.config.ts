import { defineConfig } from "vitest/config";

// Perf suite for SC-004 wall-clock budgets. Runs sequentially in a single
// forked process so the bin under test owns the CPU during measurement —
// the main `pnpm test` runs this AFTER the in-process suite finishes.
export default defineConfig({
  test: {
    include: ["tests/perf/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    testTimeout: 30000,
    pool: "forks",
    // Vitest 4 moved pool flags to top-level. singleFork: true keeps the
    // perf bin spawn off the same CPU cores the unit workers were using.
    forks: { singleFork: true },
    fileParallelism: false,
    globalSetup: ["./tests/perf/global-setup.ts"],
  },
});
