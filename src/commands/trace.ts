// `artgraph trace status` / `artgraph trace report` — spec 020 Phase A
// (T011), contracts/cli-surface.md §2. Both subcommands are READ-ONLY: they
// build the graph via `scan()` (in-memory only — never calls `reconcile()` /
// `writeLock`) and read trace shards via `ingestTrace()`. Neither the graph
// nor `.trace.lock` is ever written by this module (Phase A's contract:
// "採取+突き合わせレポートだけ").

import { Command } from "commander";
import type { ArtifactGraph } from "../types.js";
import type { TraceDiagnostics } from "../trace/schema.js";
import type { BuildWarning } from "../graph/builder.js";
import { reportGraphWarnings, TRACE_NO_SHARDS_GUIDANCE, withFatalErrors } from "./shared.js";
import { printTraceReportText, printTraceStatusText } from "./presenters/trace.js";

export interface TraceStatusResult {
  shardCount: number;
  testCount: number;
  skippedCount: number;
  diagnostics: TraceDiagnostics & { stale: number };
  /** stale / (# distinct nodes with a recorded trace-capture hash), 0 when
   * there are none — avoids a NaN in the JSON/text output on an empty trace. */
  staleRate: number;
  // issue #265 — `buildGraph()`'s warnings (pathological-bracket-nesting,
  // class-member-collision, …), threaded through so `--format json` embeds
  // them like scan/init/check do; text mode prints them via
  // `reportGraphWarnings` instead of embedding.
  warnings: BuildWarning[];
}

export interface TraceReportResult {
  corroborated: Array<{ reqId: string; node: string }>;
  unexercisedClaims: Array<{ reqId: string; node: string }>;
  suggestedImpls: Array<{ reqId: string; node: string }>;
  infrastructure: Array<{ node: string; reqCount: number }>;
  diagnostics: TraceDiagnostics & { stale: number };
  // issue #265 — see TraceStatusResult.warnings above.
  warnings: BuildWarning[];
}

// `status`'s "record counts" are derived from `IngestedTrace` itself rather
// than re-parsing shards (which would duplicate `src/trace/ingest.ts`'s
// `loadShards` — perspective ⑦, no second implementation of shard
// discovery). `testCount` is the union, across every REQ's bucket, of
// green-tagged tests that contributed evidence (`ReqCoverage.tests`) — the
// same set `impact --tests` (T022) will eventually list per-REQ.
function countTaggedTests(trace: import("../trace/ingest.js").IngestedTrace): number {
  const seen = new Set<string>();
  for (const coverage of trace.perReq.values()) {
    for (const t of coverage.tests) seen.add(`${t.testFile} ${t.testName}`);
  }
  return seen.size;
}

function buildDiagnostics(
  diagnostics: TraceDiagnostics,
  staleCount: number,
): TraceDiagnostics & { stale: number } {
  return { ...diagnostics, stale: staleCount };
}

async function loadTraceInputs(rootDir: string): Promise<{
  config: import("../types.js").ArtgraphConfig;
  graph: ArtifactGraph;
  trace: import("../trace/ingest.js").IngestedTrace;
  // issue #265 — previously discarded (`const { graph } = scan(...)`), so
  // `trace status` / `trace report` never surfaced build warnings.
  warnings: BuildWarning[];
}> {
  const { loadConfig } = await import("../config.js");
  const { scan } = await import("../scan.js");
  const { ingestTrace, filterTraceToGraph } = await import("../trace/ingest.js");
  const config = loadConfig(rootDir);
  const { graph, warnings } = scan(rootDir, config);
  // issue #275 — `status`/`report` both read `IngestedTrace` directly
  // (no `mergeTraceEdges` step in between), so a ghost node must be dropped
  // here before `computeStaleNodeIds`/`classifyEvidence` ever see it.
  const trace = filterTraceToGraph(ingestTrace(config, rootDir), graph);
  return { config, graph, trace, warnings };
}

export function registerTraceCommand(program: Command): void {
  const trace = program
    .command("trace")
    .description("Coverage-derived traceability: shard status and @impl-vs-evidence report");

  trace
    .command("status")
    .description("Report trace shard counts, diagnostics, and staleness rate")
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();
      // issue #279 / issue #336 (meta-review F1) — `loadTraceInputs` (which
      // calls `loadConfig()` then `scan()`, both inside this one wrapped
      // call) had no catch of its own before issue #279, so any error used
      // to propagate uncaught to cli.ts's format-blind top-level catch.
      // `withOxcLoadErrorFatal` (issue #279) only narrowed on `OxcLoadError`
      // and rethrew everything else, so a malformed `.artgraph.json`
      // (`loadConfig()`'s plain `Error`) still escaped uncaught even though
      // it was structurally inside the wrap — `withFatalErrors` (issue #336)
      // closes that gap by also catching every other `Error`.
      const {
        graph,
        trace: ingested,
        warnings,
      } = await withFatalErrors(opts.format, () => loadTraceInputs(rootDir));
      const { computeStaleNodeIds } = await import("../trace/report.js");

      const staleNodeIds = computeStaleNodeIds(graph, ingested);
      const totalHashed = ingested.hashesAtTrace.size;
      const staleRate = totalHashed === 0 ? 0 : staleNodeIds.size / totalHashed;

      const result: TraceStatusResult = {
        shardCount: ingested.shardCount,
        testCount: countTaggedTests(ingested),
        skippedCount: ingested.diagnostics.skipped,
        diagnostics: buildDiagnostics(ingested.diagnostics, staleNodeIds.size),
        staleRate,
        warnings,
      };

      if (opts.format === "json") {
        console.log(JSON.stringify(result));
      } else {
        printTraceStatusText(result);
        reportGraphWarnings(warnings, opts.format);
      }
    });

  trace
    .command("report")
    .description("Cross-check @impl claims against test-execution evidence (Phase A)")
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();
      // issue #279 / issue #336 — see the identical comment on `trace status`
      // above.
      const {
        config,
        graph,
        trace: ingested,
        warnings,
      } = await withFatalErrors(opts.format, () => loadTraceInputs(rootDir));

      // contracts/cli-surface.md §2 — zero shards is a hard error, not an
      // empty report: the report's entire premise (evidence exists to
      // cross-check against) doesn't hold, so silently printing four empty
      // arrays would hide the real problem (no trace was ever captured).
      if (ingested.shardCount === 0) {
        console.error(TRACE_NO_SHARDS_GUIDANCE);
        // review F1 — this hard error exits before any JSON payload is ever
        // produced, so warnings would otherwise be silently lost regardless
        // of `--format`. Print unconditionally, mirroring `impact.ts`'s
        // early-exit paths.
        reportGraphWarnings(warnings);
        process.exit(1);
      }

      const { classifyEvidence, computeStaleNodeIds } = await import("../trace/report.js");
      const sharedThreshold = config.trace?.sharedThreshold ?? 3;
      const evidence = classifyEvidence(graph, ingested, sharedThreshold);
      const staleNodeIds = computeStaleNodeIds(graph, ingested);

      const result: TraceReportResult = {
        ...evidence,
        diagnostics: buildDiagnostics(ingested.diagnostics, staleNodeIds.size),
        warnings,
      };

      if (opts.format === "json") {
        console.log(JSON.stringify(result));
      } else {
        printTraceReportText(result);
        reportGraphWarnings(warnings, opts.format);
      }
    });
}
