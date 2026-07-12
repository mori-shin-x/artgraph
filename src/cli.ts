#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildProgram } from "./build-program.js";
import { installBaselineSignalHandlers } from "./baseline.js";
import { OxcLoadError } from "./parsers/typescript.js";

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
  //
  // issue #263 — ONE deliberate, narrow exception to that "stack trace"
  // default: `OxcLoadError` is a specifically-anticipated, actionable
  // environment failure (oxc-parser's native binding missing/broken) whose
  // whole point is a clear diagnostic FOR THE USER, not a debugging aid for
  // artgraph's own internals — a Node stack trace under it (dist file paths,
  // `node:internal/modules/cjs/loader` frames, …) is noise that competes
  // with, rather than adds to, the message's own cause/fix guidance. This is
  // NOT a general-purpose "pretty error" layer: every OTHER thrown error
  // still falls through unchanged to the exact pre-existing behavior this
  // comment describes (rethrown here, then the default stack-trace-and-exit
  // path). Scoped to real CLI invocations only — `runCli` (the in-process
  // test harness) has its own independent, pre-existing catch and is not
  // touched by this.
  try {
    await program.parseAsync();
  } catch (e) {
    if (e instanceof OxcLoadError) {
      console.error(e.message);
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}
