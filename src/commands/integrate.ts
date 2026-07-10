// `artgraph integrate` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import type { IntegrationProviderId } from "../types.js";
import { loadIntegrate } from "./shared.js";
import { printIntegrateText, toListJson } from "./presenters/integrate.js";

// `integrate` accepts a single positional that is either a provider id
// (`speckit` / `kiro`) or the sub-command verb `list`. Commander 13's
// nested sub-commands struggle with this hybrid shape (the parent's
// positional arg collides with `.command("list")`), so we dispatch on the
// argument inside the handler. Both surfaces share the same `--format`
// option to keep CLI ergonomics consistent.
export function registerIntegrateCommand(program: Command): void {
  program
    .command("integrate <tool>")
    .description(
      "Integrate artgraph into an SDD tool's workflow (speckit | kiro), or 'list' to show providers",
    )
    .option(
      "--gate",
      "(speckit only) Wire before_implement as a BLOCKING gate (artgraph check --gate). Default wiring is a non-blocking check --diff preview. Note: on a brand-new spec the gate always fails until the first implementation lands.",
    )
    .option("--no-gate", "(speckit only) Remove artgraph's before_implement hook entirely")
    .option("--force", "Overwrite existing files")
    .option("--uninstall", "Remove the integration (delete files / hook entries)")
    .addOption(
      new Option("--format <format>", "Output format").choices(["text", "json"]).default("text"),
    )
    .action(async (tool: string, opts) => {
      const rootDir = process.cwd();
      const { runIntegrate } = await loadIntegrate();

      // Sub-command dispatch: `integrate list` reuses the same option surface
      // (only --format applies; the rest are ignored for `list`).
      if (tool === "list") {
        await runIntegrateList(rootDir, opts.format);
        return;
      }

      // commander stores --gate / --no-gate in `opts.gate`:
      //   --gate         -> true
      //   --no-gate      -> false
      //   (neither)      -> undefined (option absent)
      // We must preserve `undefined` so the provider can distinguish
      // "no opinion" from "explicitly off" (FR-003 declarative semantics).
      const gate: boolean | undefined = Object.prototype.hasOwnProperty.call(opts, "gate")
        ? (opts.gate as boolean)
        : undefined;

      try {
        const result = runIntegrate(rootDir, tool as IntegrationProviderId, {
          force: opts.force,
          gate,
          uninstall: opts.uninstall,
        });

        if (opts.format === "json") {
          console.log(JSON.stringify(result));
        } else {
          printIntegrateText(result, tool as IntegrationProviderId);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (opts.format === "json") {
          console.error(JSON.stringify({ error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
    });
}

async function runIntegrateList(rootDir: string, format: string): Promise<void> {
  const { getProviderStatuses } = await loadIntegrate();
  const statuses = getProviderStatuses(rootDir);

  if (format === "json") {
    console.log(JSON.stringify({ providers: statuses.map(toListJson) }));
    return;
  }

  // Text format: contracts/integrate-cli.md §2.
  //   speckit    Spec Kit    [ detected: yes, installed: yes ]
  //   kiro       Kiro        [ detected: yes, installed: no  ] → run: artgraph integrate kiro
  const idCol = Math.max(8, ...statuses.map((s) => s.providerId.length));
  const nameCol = Math.max(8, ...statuses.map((s) => s.displayName.length));

  console.log("Available integrations:");
  console.log("");
  for (const s of statuses) {
    const id = s.providerId.padEnd(idCol);
    const name = s.displayName.padEnd(nameCol);
    const det = s.detected ? "yes" : "no ";
    const ins = s.installed ? "yes" : "no ";
    const suffix = s.detected && !s.installed ? ` → run: artgraph integrate ${s.providerId}` : "";
    console.log(`  ${id}  ${name}  [ detected: ${det}, installed: ${ins} ]${suffix}`);
  }
  console.log("");
  console.log("(Future providers: openspec — coming soon)");
}
