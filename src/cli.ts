#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildProgram } from "./build-program.js";
import { installBaselineSignalHandlers } from "./baseline.js";

// @internal re-export — the in-process test harness lives in
// `src/testing/run-cli.ts` (issue #162: composition root vs. test-harness
// split), but a small set of tests import it from `../src/cli.js` (the
// package's historical test seam, deliberately excluded from the public
// `exports` map in package.json). Re-exporting here keeps that import path
// working without those tests needing to know about the internal split.
export { runCli, type RunCliOptions, type RunCliResult } from "./testing/run-cli.js";

// Only invoke commander when this module is the entry point of a real CLI
// process. Importing `cli.ts` from tests must not trigger argv parsing.
//
// `realpathSync` is essential: when invoked via an npm/pnpm bin shim
// (`./node_modules/.bin/artgraph`), Node's ESM loader resolves the module
// URL to the symlink target (the real `dist/cli.js`), but `process.argv[1]`
// stays as the shim path. Without realpath normalization the two are
// different strings and the guard never fires — bin-shim invocations
// would silently exit without parsing argv. See PR #99 review.
function resolveEntryHref(): string {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return "";
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return "";
  }
}
if (import.meta.url === resolveEntryHref()) {
  // spec 017 (Critical fix A3, issue #182 review) — installed ONLY for the
  // real CLI entry point, deliberately not from module top-level: the
  // in-process test harness (`src/testing/run-cli.ts`) imports this module
  // to reach `runCli` without ever wanting global SIGINT/SIGTERM/
  // uncaughtException handlers registered into the shared vitest process.
  installBaselineSignalHandlers();
  const program = buildProgram();
  // parseAsync (not parse): action handlers are async since the lazy-import
  // refactor, and commander's sync parse() would return before they finish.
  // Matches the parseAsync semantics runCli has always used. A rejected
  // handler surfaces as a top-level-await rejection — stack trace + exit 1 —
  // same outcome as the old sync-throw-through-parse() path.
  await program.parseAsync();
}
