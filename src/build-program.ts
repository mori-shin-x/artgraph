import { createRequire } from "node:module";
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerImpactCommand } from "./commands/impact.js";
import { registerPlanCoverageCommand } from "./commands/plan-coverage.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
import { registerIntegrateCommand } from "./commands/integrate.js";
import { registerRenameCommand } from "./commands/rename.js";
import { registerTraceCommand } from "./commands/trace.js";

// `--version` reports package.json's version — the single source of truth.
// A hardcoded literal here drifts on every release-please bump (the release
// PR raises package.json but not source literals), which failed the bin
// e2e's version assertion on the first release branch. Resolved relative to
// this module so the lookup works both from `dist/` (published layout) and
// `src/` (tests importing the TS source directly) — package.json sits one
// level up in both.
const requireCjs = createRequire(import.meta.url);
const { version: PKG_VERSION } = requireCjs("../package.json") as { version: string };

// Composition root (issue #162): each command is registered from its own
// module in `src/commands/`. `buildProgram` wires them onto a fresh
// commander tree — callers (the CLI entry point, `runCli`) build a new
// program per invocation so no state leaks between calls.
export function buildProgram(): Command {
  const program = new Command();
  program.name("artgraph").description("Typed artifact graph for TS/JS").version(PKG_VERSION);

  registerInitCommand(program);
  registerScanCommand(program);
  registerImpactCommand(program);
  registerPlanCoverageCommand(program);
  registerCheckCommand(program);
  registerDoctorCommand(program);
  registerReconcileCommand(program);
  registerIntegrateCommand(program);
  registerRenameCommand(program);
  registerTraceCommand(program);

  return program;
}
