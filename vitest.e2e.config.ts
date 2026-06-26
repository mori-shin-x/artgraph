import { defineConfig } from "vitest/config";

// E2E suite — spawns the built `dist/cli.js` via real OS process boundaries
// to catch bugs the in-process suite is structurally blind to (bin-entry
// guard regressions, stdin pipe semantics, dist/src divergence). Runs in
// a single forked worker so the spawned bins don't fight the test runner
// for CPU.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    testTimeout: 60000,
    pool: "forks",
    forks: { singleFork: true },
    fileParallelism: false,
    globalSetup: ["./tests/e2e/global-setup.ts"],
    retry: 1,
  },
});
