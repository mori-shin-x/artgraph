// Presenter: `trace status` / `trace report` results → stdout text.
// Heading style mirrors `printCheckText`'s legacy listing (`DRIFT:` /
// `ORPHANS:` etc — contracts/cli-surface.md §4 documents the same style for
// `check`'s future findings) so a user reading either command's text output
// sees one visual language.

import type { TraceReportResult, TraceStatusResult } from "../trace.js";

export function printTraceStatusText(result: TraceStatusResult): void {
  console.log(`Shards: ${result.shardCount}`);
  console.log(`Records: ${result.testCount} test, ${result.skippedCount} skipped`);
  console.log("Diagnostics:");
  console.log(`  dangling:      ${result.diagnostics.dangling}`);
  console.log(`  skipped:       ${result.diagnostics.skipped}`);
  console.log(`  unknownSchema: ${result.diagnostics.unknownSchema}`);
  console.log(`  corrupted:     ${result.diagnostics.corrupted}`);
  console.log(`  stale:         ${result.diagnostics.stale}`);
  console.log(`Stale rate: ${(result.staleRate * 100).toFixed(1)}%`);
}

export function printTraceReportText(result: TraceReportResult): void {
  if (result.corroborated.length > 0) {
    console.log("CORROBORATED:");
    for (const p of result.corroborated) console.log(`  ${p.reqId} -> ${p.node}`);
  }
  if (result.unexercisedClaims.length > 0) {
    if (result.corroborated.length > 0) console.log("");
    console.log("UNEXERCISED CLAIM:");
    for (const p of result.unexercisedClaims) console.log(`  ${p.reqId} -> ${p.node}`);
  }
  if (result.suggestedImpls.length > 0) {
    console.log("");
    console.log("SUGGESTED IMPL:");
    for (const p of result.suggestedImpls) console.log(`  ${p.reqId} -> ${p.node}`);
  }
  if (result.infrastructure.length > 0) {
    console.log("");
    console.log("INFRASTRUCTURE:");
    for (const i of result.infrastructure) console.log(`  ${i.node} (${i.reqCount} reqs)`);
  }
  if (
    result.corroborated.length === 0 &&
    result.unexercisedClaims.length === 0 &&
    result.suggestedImpls.length === 0 &&
    result.infrastructure.length === 0
  ) {
    console.log("No findings.");
  }
  console.log("");
  console.log("Diagnostics:");
  console.log(`  dangling:      ${result.diagnostics.dangling}`);
  console.log(`  skipped:       ${result.diagnostics.skipped}`);
  console.log(`  unknownSchema: ${result.diagnostics.unknownSchema}`);
  console.log(`  corrupted:     ${result.diagnostics.corrupted}`);
  console.log(`  stale:         ${result.diagnostics.stale}`);
}
