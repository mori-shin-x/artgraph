// Presenter: `integrate` result → stdout text/json. Extracted verbatim from
// `src/cli.ts` (issue #162) — no behavior change. Shared by `init` (one-shot
// per-tool sections) and the `integrate` command itself.

import type { IntegrateResult } from "../../types.js";

// Display-name lookup for the integrate text formatter. The registry stores
// the canonical name on the provider instance, but we don't want to depend
// on registry state here (the registry might be cleared by tests).
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  speckit: "Spec Kit",
  kiro: "Kiro",
};

export function printIntegrateText(result: IntegrateResult, tool: string): void {
  const display = PROVIDER_DISPLAY_NAMES[tool] ?? tool;
  if (result.noop) {
    console.log(`✓ Already integrated: ${tool} (${display}) — no changes`);
    if (result.warnings.length > 0) {
      console.log("");
      console.log(`Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) console.log(`  ${w}`);
    }
    return;
  }
  console.log(`✓ Integrated: ${tool} (${display})`);
  if (result.created.length > 0) {
    console.log("");
    console.log(`Created (${result.created.length}):`);
    for (const p of result.created) console.log(`  ${p}`);
  }
  if (result.modified.length > 0) {
    console.log("");
    console.log(`Modified (${result.modified.length}):`);
    for (const p of result.modified) console.log(`  ${p}`);
  }
  if (result.removed.length > 0) {
    console.log("");
    console.log(`Removed (${result.removed.length}):`);
    for (const p of result.removed) console.log(`  ${p}`);
  }
  if (result.nextSteps.length > 0) {
    console.log("");
    console.log("Next:");
    for (const s of result.nextSteps) console.log(`  ${s}`);
  }
  if (result.warnings.length > 0) {
    console.log("");
    console.log(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) console.log(`  ${w}`);
  }
}

// JSON shape for `integrate list` — matches contracts/integrate-cli.md §2.
// Using `id` (not `providerId`) on the wire for parity with the contract
// example; internally we still carry `providerId`.
export function toListJson(s: import("../../types.js").IntegrationStatus): {
  id: string;
  displayName: string;
  marker: string;
  detected: boolean;
  installed: boolean;
} {
  return {
    id: s.providerId,
    displayName: s.displayName,
    marker: s.marker,
    detected: s.detected,
    installed: s.installed,
  };
}
