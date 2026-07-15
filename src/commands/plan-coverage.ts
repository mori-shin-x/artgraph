// `artgraph plan-coverage` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DASH_PATH_HINT, nonOptionValue, reportGraphWarnings } from "./shared.js";

// spec 014 (FR-013 — FR-020): plan-coverage subcommand. Reads tasks.md /
// plan.md (and the current spec.md) to detect REQs that are *affected*
// (via the file → impact() blast) but *never mentioned* in the source
// trio — i.e. the SDD author silently dragged in side effects.
//
// All defaults follow contracts/cli-flags.md §plan-coverage:
//   --format text (default), --gate off, --ignore "", requireFilesSection
//   off unless `.artgraph.json`'s `planCoverage.requireFilesSection` is true.
export function registerPlanCoverageCommand(program: Command): void {
  program
    .command("plan-coverage")
    .description(
      "Detect implicit REQ impacts: REQs reached by tasks.md/plan.md `Files:` that are never mentioned in the spec trio.",
    )
    // issue #306 — parse-time swallow guards (see `nonOptionValue` in
    // shared.ts): this command carries `--gate`, so a value-taking option
    // whose CI variable expands to nothing (`--ignore $CSV --gate` →
    // `--ignore --gate`) consumes `--gate` as its value and silently
    // disarms the gate (verified fail-open: exit 0 with the ignore list
    // showing "--gate"). The path/dir flags (`--spec`/`--tasks`/`--plan`)
    // swallow `--gate` the same way but then usually fail on the bogus
    // path (exit 1) — guarded anyway so the error names the real mistake
    // instead of "tasks.md not found: --gate". Paths/dirs also reject the
    // empty string (an empty override can only be an unset variable);
    // `--ignore ""` stays legal-by-design, mirroring `check --ignore`.
    .addOption(
      new Option(
        "--spec <dir>",
        "Spec directory (auto-detected via SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)",
      ).argParser(nonOptionValue("--spec", { hint: DASH_PATH_HINT })),
    )
    .addOption(
      new Option(
        "--tasks <path>",
        "Override the tasks.md path (default: <spec-dir>/tasks.md)",
      ).argParser(nonOptionValue("--tasks", { hint: DASH_PATH_HINT })),
    )
    .addOption(
      new Option(
        "--plan <path>",
        "Override the plan.md path (default: <spec-dir>/plan.md if present)",
      ).argParser(nonOptionValue("--plan", { hint: DASH_PATH_HINT })),
    )
    .addOption(
      new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"),
    )
    .option("--gate", "Exit 1 when implicit impacts or diagnostics are non-empty (CI use)")
    .addOption(
      new Option("--ignore <csv>", "Comma-separated REQ-IDs to drop from implicit list (one-shot)")
        .default("")
        .argParser(nonOptionValue("--ignore", { allowEmpty: true })),
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { resolveSpecDir } = await import("../plan-coverage/spec-resolver.js");
      const { loadConfig } = await import("../config.js");
      const { runPlanCoverage } = await import("../plan-coverage/index.js");

      // Resolve spec dir per the contract precedence.
      const resolved = resolveSpecDir({
        explicitFlag: opts.spec,
        env: process.env,
        repoRoot: rootDir,
      });
      if ("error" in resolved) {
        console.error(resolved.error);
        process.exit(1);
      }
      const specDir = resolved.dir;

      // Resolve tasks.md / plan.md against the spec dir unless overridden.
      const tasksPath: string = opts.tasks ? (opts.tasks as string) : resolve(specDir, "tasks.md");
      if (!existsSync(tasksPath)) {
        console.error(`error: tasks.md not found: ${tasksPath}`);
        process.exit(1);
      }
      // CORR-1 / SPEC-3: when the user passes `--plan` explicitly, a missing
      // path is a hard error (mirrors `--tasks` above). When omitted, the
      // default `<spec-dir>/plan.md` is *optional*: silent fallback is fine
      // because plan.md is not required by the contract.
      let planPath: string | undefined;
      if (opts.plan) {
        const explicitPlan = opts.plan as string;
        if (!existsSync(explicitPlan)) {
          console.error(`error: --plan path not found: ${explicitPlan}`);
          process.exit(1);
        }
        planPath = explicitPlan;
      } else {
        const defaultPlan = resolve(specDir, "plan.md");
        planPath = existsSync(defaultPlan) ? defaultPlan : undefined;
      }

      // Parse --ignore CSV. Empty entries are dropped silently so
      // `--ignore ""` or trailing commas don't generate spurious IDs.
      const ignore = ((opts.ignore as string) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // `.artgraph.json`'s planCoverage section drives requireFilesSection
      // (default false).
      const config = loadConfig(rootDir);
      const requireFilesSection: boolean = config.planCoverage?.requireFilesSection ?? false;

      const format: "json" | "text" = opts.format === "json" ? "json" : "text";

      try {
        const result = runPlanCoverage({
          repoRoot: rootDir,
          specDir,
          tasksPath,
          planPath,
          format,
          gate: opts.gate === true,
          ignore,
          requireFilesSection,
        });

        if (format === "json") {
          // review F2 — fold `buildGraph()`'s warnings into the JSON payload,
          // matching `impact`/`trace`/`check`'s convention (issue #265).
          console.log(JSON.stringify({ ...result.json, warnings: result.warnings }));
        } else {
          process.stdout.write(result.text);
          reportGraphWarnings(result.warnings, format);
        }
        if (result.exitCode !== 0) {
          process.exit(result.exitCode);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
