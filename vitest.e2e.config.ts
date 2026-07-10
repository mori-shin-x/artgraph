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
    // beforeAll in tests/e2e/bin.e2e.test.ts pack path may take up to 5 min
    // (pnpm pack spawnSync timeout 120s + npm install spawnSync timeout 180s).
    // Vitest default hookTimeout (10s) is far too short and would kill the
    // hook before its own internal timeouts fire. See PR #231 review.
    hookTimeout: 300000,
    pool: "forks",
    forks: { singleFork: true },
    fileParallelism: false,
    // Cold `pnpm install && pnpm test:e2e` has no built vendor asset yet
    // (that's normally produced by the `prebuild` hook); populate it before
    // the dist-build setup below runs.
    globalSetup: ["./tests/global-setup-vendor.ts", "./tests/e2e/global-setup.ts"],
    retry: 1,
  },
});
