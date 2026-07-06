// Presenter: `impact` result → stdout text. Extracted verbatim from
// `src/cli.ts` (issue #162) — no behavior change.

// spec 016 T032 / FR-015 / FR-023 / contracts/cli-flags.md §5.2 — text formatter.
// Three REQ-axis sections:
//   - Impact reqs        = forward BFS reach
//   - Origin reqs        = startId `@impl` claims (1-hop reverse)
//   - Drift candidates   = (impactReqs \ originReqs), section omitted when empty
export function printImpactText(result: any) {
  const impactReqs: string[] = Array.isArray(result.impactReqs) ? result.impactReqs : [];
  const originReqs: string[] = Array.isArray(result.originReqs) ? result.originReqs : [];

  if (impactReqs.length > 0) {
    console.log("Impact reqs:");
    for (const r of impactReqs) console.log(`  ${r}  (req)`);
  } else {
    // Keep a visible header even for empty impact so downstream readers /
    // tests don't have to special-case "no impact" output.
    console.log("Impact reqs:");
    console.log("  (none)");
  }

  // Origin section: always emit so the JSON consumer's text mirror is
  // unambiguous; show `(none)` when the startIds have no @impl claim.
  console.log("");
  console.log("Origin reqs (@impl claims):");
  if (originReqs.length > 0) {
    for (const r of originReqs) console.log(`  ${r}  (req)`);
  } else {
    console.log("  (none)");
  }

  // Drift candidates — FR-015: omit the section entirely when the set
  // difference is empty so a clean run doesn't print noise.
  const originSet = new Set(originReqs);
  const drift = impactReqs.filter((r) => !originSet.has(r));
  if (drift.length > 0) {
    console.log("");
    console.log("Drift candidates (impact \\ origin):");
    for (const r of drift) console.log(`  ${r}  (req)`);
  }

  if (result.affectedTasks && result.affectedTasks.length > 0) {
    console.log("");
    console.log("Affected Tasks:");
    for (const t of result.affectedTasks) console.log(`  ${t}`);
  }
  if (result.affectedDocs && result.affectedDocs.length > 0) {
    console.log("");
    console.log("Affected Docs:");
    for (const d of result.affectedDocs) console.log(`  ${d}`);
  }
  if (result.affectedFiles && result.affectedFiles.length > 0) {
    console.log("");
    console.log("Affected Files:");
    for (const f of result.affectedFiles) console.log(`  ${f}`);
  }
  if (result.drifted && result.drifted.length > 0) {
    console.log("");
    console.log("Drifted:");
    for (const d of result.drifted) console.log(`  ${d.nodeId} (${d.kind})`);
  }
  if (result.summary) {
    const taskPart = result.summary.tasks > 0 ? `, ${result.summary.tasks} tasks` : "";
    console.log(
      `Summary: ${result.summary.docs} docs, ${result.summary.reqs} reqs, ${result.summary.files} files${taskPart}`,
    );
  }
}
