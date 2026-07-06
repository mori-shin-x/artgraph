// Presenter: `check` result → stdout text. Extracted verbatim from
// `src/cli.ts` (issue #162) — no behavior change.

export function printCheckText(result: any) {
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
  if (result.pass) {
    console.log("All checks passed.");
  }
}
