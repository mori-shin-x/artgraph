import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerImpactCommand } from "./commands/impact.js";
import { registerPlanCoverageCommand } from "./commands/plan-coverage.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerCoverageCommand } from "./commands/coverage.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
import { registerGraphCommand } from "./commands/graph.js";
import { registerHookPretoolCommand } from "./commands/hook-pretool.js";
import { registerIntegrateCommand } from "./commands/integrate.js";
import { registerRenameCommand } from "./commands/rename.js";

// Composition root (issue #162): each command is registered from its own
// module in `src/commands/`. `buildProgram` wires them onto a fresh
// commander tree — callers (the CLI entry point, `runCli`) build a new
// program per invocation so no state leaks between calls.
export function buildProgram(): Command {
  const program = new Command();
  program.name("artgraph").description("Typed artifact graph for TS/JS").version("0.1.0");

  registerInitCommand(program);
  registerScanCommand(program);
  registerImpactCommand(program);
  registerPlanCoverageCommand(program);
  registerCheckCommand(program);
  registerDoctorCommand(program);
  registerCoverageCommand(program);
  registerReconcileCommand(program);
  registerGraphCommand(program);
  registerHookPretoolCommand(program);
  registerIntegrateCommand(program);
  registerRenameCommand(program);

  return program;
}
