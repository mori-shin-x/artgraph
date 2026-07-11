// Presenter: `check` result → stdout text.
//
// Two shapes (spec 017, FR-008):
//   - non-`--diff` runs (plain `check` / `check --gate`): the legacy full
//     listing of every scoped issue + a trailing "All checks passed." — kept
//     verbatim so existing callers / tests are unaffected.
//   - `--diff` runs: a baseline-aware summary whose size tracks the number of
//     NEW issues, not the width of the blast radius (SC-004). Pre-existing
//     debt is collapsed to a suppressed count and a pointer to `impact --diff`.

import type { CheckResult, NewIssues } from "../../types.js";

interface PrintOptions {
  diff?: boolean;
  gate?: boolean;
}

export function printCheckText(result: CheckResult, opts?: PrintOptions): void {
  // Plain (non-diff) check keeps the historical full listing.
  if (!opts?.diff) {
    printScopedIssues(result);
    return;
  }

  // spec 017 §4.4 / §4.5 — baseline could not be established. Without `--gate`
  // we fall back to the full listing (the command prints a stderr WARNING and
  // exits 0); with `--gate` the command prints an ERROR and exits 1, so the
  // issue list is intentionally suppressed here (contract cli-check-gate §4.4).
  if (result.baselineStatus === "unavailable") {
    if (!opts.gate) printScopedIssues(result);
    return;
  }

  // computed / empty / skipped → new-issue summary.
  const newCount = countIssues(result.newIssues);

  if (newCount === 0) {
    console.log("No new issues introduced by this change.");
    if (result.suppressedCount > 0) {
      console.log(`(${suppressedLine(result.suppressedCount)})`);
    }
    return;
  }

  console.log(`${newCount} new ${plural(newCount, "issue")} introduced by this change:`);
  printNewCategory(
    "DRIFT",
    result.newIssues.drifted.map((d) => `${d.nodeId} (${d.kind})`),
  );
  printNewCategory("ORPHANS", result.newIssues.orphans);
  printNewCategory("UNCOVERED", result.newIssues.uncovered);
  printNewCategory("TEST FAILURES", result.newIssues.testFailures);

  if (result.suppressedCount > 0) {
    console.log("");
    console.log(`  ${suppressedLine(result.suppressedCount)}`);
    console.log("  Run `artgraph impact --diff` to see full propagation.");
  }
}

function printNewCategory(label: string, items: string[]): void {
  if (items.length === 0) return;
  console.log(`  ${label} (${items.length}):`);
  for (const item of items) console.log(`    ${item}`);
}

function suppressedLine(count: number): string {
  return `${count} pre-existing ${plural(count, "issue")} in blast radius ${count === 1 ? "was" : "were"} suppressed.`;
}

function countIssues(n: NewIssues): number {
  return n.drifted.length + n.orphans.length + n.uncovered.length + n.testFailures.length;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// Legacy full listing (pre-017 `printCheckText` body). Lists every scoped
// issue; used for plain `check` and for the `--diff` baseline-unavailable
// display-only fallback (§4.5).
function printScopedIssues(result: CheckResult): void {
  if (result.drifted?.length > 0) {
    console.log("DRIFT:");
    for (const d of result.drifted) console.log(`  ${d.nodeId} (${d.kind})`);
  }
  if (result.orphans?.length > 0) {
    console.log("ORPHANS:");
    for (const o of result.orphans) console.log(`  ${o}`);
  }
  if (result.uncovered?.length > 0) {
    console.log("UNCOVERED:");
    for (const u of result.uncovered) console.log(`  ${u}`);
  }
  if (result.testFailures?.length > 0) {
    console.log("TEST FAILURES:");
    for (const t of result.testFailures) console.log(`  ${t}`);
  }
  if (result.coverage?.length > 0) {
    console.log("COVERAGE:");
    for (const c of result.coverage) {
      console.log(`  ${c.reqId}: ${c.status}`);
    }
  }
  // spec 020 (contracts/cli-surface.md §4) — new finding headings, same
  // `UPPER-CASE:` style as `DRIFT:`/`ORPHANS:`/etc above and as
  // `printTraceReportText`'s Phase A precedent. Fields are `undefined`
  // (never present) on a trace-absent project (FR-010), so these sections
  // are silently skipped there exactly like every other empty section here.
  if (result.unexercisedClaims && result.unexercisedClaims.length > 0) {
    console.log("UNEXERCISED CLAIM:");
    for (const p of result.unexercisedClaims) console.log(`  ${p.reqId} -> ${p.node}`);
  }
  if (result.suggestedImpls && result.suggestedImpls.length > 0) {
    console.log("SUGGESTED IMPL:");
    for (const p of result.suggestedImpls) console.log(`  ${p.reqId} -> ${p.node}`);
  }
  if (result.staleEvidence && result.staleEvidence.length > 0) {
    console.log("STALE EVIDENCE:");
    for (const s of result.staleEvidence) console.log(`  ${s.reqId}: ${s.symbols.join(", ")}`);
  }
  if (result.pass) {
    console.log("All checks passed.");
  }
}
