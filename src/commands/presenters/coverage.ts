// Presenter: `coverage` result → stdout text/json. Extracted verbatim from
// `src/cli.ts` (issue #162) — no behavior change.

export function printCoverageJson(entries: { reqId: string; status: string }[]) {
  const items = entries.map((e) => ({ reqId: e.reqId, status: e.status }));
  const summary = {
    total: entries.length,
    verified: entries.filter((e) => e.status === "verified").length,
    implOnly: entries.filter((e) => e.status === "impl-only").length,
    untagged: entries.filter((e) => e.status === "untagged").length,
  };
  console.log(JSON.stringify({ items, summary }));
}

export function printCoverageText(entries: { reqId: string; status: string }[]) {
  console.log("COVERAGE:");
  for (const e of entries) {
    console.log(`  ${e.reqId}: ${e.status}`);
  }
  const verified = entries.filter((e) => e.status === "verified").length;
  const implOnly = entries.filter((e) => e.status === "impl-only").length;
  const untagged = entries.filter((e) => e.status === "untagged").length;
  console.log(
    `\nSummary: total=${entries.length} verified=${verified} impl-only=${implOnly} untagged=${untagged}`,
  );
}
