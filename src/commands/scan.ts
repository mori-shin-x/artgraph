// `artgraph scan` — extracted verbatim from `src/cli.ts` (issue #162).

import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { resolveTestResults, reportGraphWarnings, withFatalErrors } from "./shared.js";

// issue #172 (C3) — `Number.parseInt` alone silently accepts trailing
// garbage (`--port 3737abc` -> 3737), truncates fractions (`--port 3.14` ->
// 3), and never validates range, so an out-of-range value (negative, or
// >=65536) only surfaced as a raw Node `RangeError` from deep inside
// `server.listen()`, far from the flag that caused it. Mirrors
// `src/commands/check.ts`'s `--base` validator's shape (InvalidArgumentError
// + a message naming the offending value) — `/^\d+$/` requires the ENTIRE
// value to be decimal digits (no sign, no fraction, no trailing text), so
// only a clean whole number ever reaches `Number.parseInt`. `--port 0` is a
// legal value (OS auto-assigns a free port — see graph/serve.ts's
// `formatServeUrl`/`server.address()` handling for how the actual bound
// port is surfaced).
function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      `--port must be a whole number with no extra characters (got "${value}").`,
    );
  }
  const port = Number.parseInt(value, 10);
  if (port > 65535) {
    throw new InvalidArgumentError(`--port must be between 0 and 65535 (got ${port}).`);
  }
  return port;
}

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Build the artifact graph and show summary (JSON output includes the full graph)")
    .option("--format <format>", "Output format: json | text", "text")
    .option("--serve", "Start a local HTTP server rendering the graph interactively")
    .option("--port <n>", "Port for --serve (default 3737)", parsePort)
    .option("--host <h>", "Host for --serve (default 127.0.0.1)")
    .option("--output <dir>", "Emit a static HTML export into <dir>")
    .option(
      "--force",
      "Overwrite --output's target directory even if it contains files artgraph doesn't manage",
    )
    .action(async (opts) => {
      const rootDir = process.cwd();

      // issue #172 (C1) — `--format` only affects the plain `scan` summary
      // printed at the bottom of this action; `--serve`/`--output` render
      // HTML instead and silently ignored an explicit `--format json`
      // before this warning. The default is "text", so `opts.format ===
      // "json"` can only be true here if the user passed it explicitly.
      if (opts.format === "json" && (opts.serve || opts.output)) {
        console.error("warning: --format is ignored with --serve/--output.");
      }
      // issue #172 (C8) — `--port`/`--host` only matter for `--serve`
      // (`--output` doesn't start a server); passing either without
      // `--serve` was silently a no-op. Warn instead.
      if ((opts.port !== undefined || typeof opts.host === "string") && !opts.serve) {
        console.error("warning: --port/--host are ignored without --serve.");
      }

      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      // issue #279 / issue #336 (meta-review F1) — format-aware fatal-error
      // handling for both `loadConfig()` and `scan()` (see check.ts's
      // identical comment for the full rationale): pre-#336, `loadConfig()`
      // ran unguarded, so a malformed `.artgraph.json` propagated uncaught
      // to cli.ts's format-blind top-level catch.
      const config = await withFatalErrors(opts.format, () => loadConfig(rootDir));
      const result = await withFatalErrors(opts.format, () => scan(rootDir, config));

      // --serve / --output render the same scan graph as an interactive HTML
      // page (issue #125). The dedicated `graph` command was folded into
      // `scan` (#135), so these are alternate renderings that sit alongside
      // the text / `--format json` output.
      //
      // They are mutually exclusive — both drive the same HTML pipeline and
      // combining them just papers over a misuse. Fail fast with a clear
      // message.
      if (opts.serve && opts.output) {
        console.error(
          "error: --serve and --output cannot be combined. Pick one (serve to preview locally, output for a static snapshot).",
        );
        process.exit(1);
      }

      if (opts.serve || opts.output) {
        // issue #274(1) — `--serve`/`--output` never called into
        // `printWarnings`/`reportGraphWarnings` at all: a
        // `pathological-bracket-nesting` or `class-member-collision` warning
        // from this same `scan()` call was silently dropped on both of these
        // paths. Neither branch has a JSON payload (they render HTML), so
        // print unconditionally — same rationale as `reconcile`'s
        // no-`--format json`-mode call. Runs before every early
        // return/`process.exit` below so the warning is never skipped
        // regardless of which branch (output vs. serve, success vs. error)
        // is taken.
        reportGraphWarnings(result.warnings);

        const { readLockWithMeta, warnIfNewerLockSchema } = await import("../lock.js");
        const { check } = await import("../check.js");
        const { renderGraphData } = await import("../graph/render.js");
        const { startServer, writeStaticExport } = await import("../graph/serve.js");

        // Try to enrich the render with drift/orphan/uncovered state from the
        // lock. Missing lock is fine (the file didn't exist yet); other read
        // failures (LockSchemaError, permissions) should surface — silently
        // swallowing them would hide real repo corruption.
        let checkResult;
        try {
          const { lock, schemaVersion } = readLockWithMeta(rootDir, config.lockFile);
          // issue #243 — this render path is read-only w.r.t. the lock: warn
          // on a newer schema and keep going (see commands/check.ts's
          // identical comment).
          warnIfNewerLockSchema(schemaVersion, config.lockFile);
          if (Object.keys(lock).length > 0) {
            checkResult = check(result.graph, lock);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`warning: could not read lock (${msg}); rendering without drift info.`);
        }

        const data = renderGraphData(result.graph, { rootDir, checkResult });

        if (opts.output) {
          const outputDir = resolve(rootDir, opts.output);
          try {
            await writeStaticExport({ data, outputDir, force: Boolean(opts.force) });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`error: ${msg}`);
            process.exit(1);
          }
          console.error(`artgraph scan: static export written to ${outputDir}`);
          return;
        }

        // --serve: keep the process alive on the http.Server. SIGINT/SIGTERM
        // trigger a graceful shutdown; without the handler Ctrl+C would still
        // work but skip the server.close() drain.
        // `opts.port` is either `undefined` (flag not passed) or a
        // validated non-NaN integer in [0, 65535] — `parsePort` above never
        // lets a malformed or out-of-range value reach here.
        const port = opts.port ?? 3737;
        const host = typeof opts.host === "string" ? opts.host : "127.0.0.1";
        try {
          const handle = await startServer({ data, port, host });
          console.error(`artgraph scan: serving at ${handle.url}`);
          const shutdown = async () => {
            try {
              await handle.close();
            } catch {
              // Ignore close errors during shutdown — we're exiting anyway.
            }
            process.exit(0);
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`error: ${msg}`);
          process.exit(1);
        }
        return;
      }

      const testResults = await resolveTestResults(config, rootDir);
      let testResultStats:
        | { totalTests: number; passedTests: number; failedTests: number }
        | undefined;
      if (testResults) {
        let totalTests = 0;
        let passedTests = 0;
        let failedTests = 0;
        for (const records of testResults.values()) {
          for (const r of records) {
            totalTests++;
            if (r.passed) passedTests++;
            else failedTests++;
          }
        }
        testResultStats = { totalTests, passedTests, failedTests };
      }

      if (opts.format === "json") {
        // Full graph payload (nodes / edges) rides along with the count
        // summary — `scan --format json` absorbed the old `graph` command.
        const { graphToJSON } = await import("../graph/format.js");
        const { nodes, edges } = graphToJSON(result.graph);
        const output: Record<string, unknown> = {
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          reqCount: result.reqCount,
          docCount: result.docCount,
          fileCount: result.fileCount,
          symbolCount: result.symbolCount,
          testCount: result.testCount,
          taskCount: result.taskCount,
          nodes,
          edges,
          warnings: result.warnings,
        };
        if (testResultStats) {
          output.testResultStats = testResultStats;
        }
        console.log(JSON.stringify(output));
      } else {
        console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
        const parts = [
          `req: ${result.reqCount}`,
          `doc: ${result.docCount}`,
          `file: ${result.fileCount}`,
        ];
        if (result.symbolCount > 0) parts.push(`symbol: ${result.symbolCount}`);
        parts.push(`test: ${result.testCount}`);
        if (result.taskCount > 0) parts.push(`task: ${result.taskCount}`);
        console.log(`  ${parts.join("  ")}`);
        if (testResultStats) {
          console.log(
            `\nTest Results: total=${testResultStats.totalTests} passed=${testResultStats.passedTests} failed=${testResultStats.failedTests}`,
          );
        }
        reportGraphWarnings(result.warnings);
      }
    });
}
