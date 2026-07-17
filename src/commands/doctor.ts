// `artgraph doctor` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import type { AgentId } from "../agents/descriptors.js";
import { parseAgentsFlag, printFatalCatchAll, printOxcLoadError } from "./shared.js";
// See commands/shared.ts's `withFatalErrors` doc comment for why this static
// import is free (cli.ts's own top-level catch already pays it
// unconditionally on every real CLI invocation).
import { OxcLoadError } from "../parsers/typescript.js";

// spec 013 T028 — `artgraph doctor` subcommand. Diagnoses Tier 1 distribution
// health (Skills sha256 / AGENTS.md marker / wrappers / extraneous files).
// Independent of `artgraph check` per FR-012: the doctor MUST NOT participate
// in the `check --gate` decision (regression-tested in
// `tests/check-gate-no-regression.test.ts`).
// @impl 013-cross-agent-extensions/FR-012
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose Tier 1 cross-agent distribution health")
    .option("--agents <list>", "Comma-separated agent ids to diagnose (default: all detected)")
    .addOption(
      new Option("--format <format>", "Output format").choices(["text", "json"]).default("text"),
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { runDoctor, formatDoctorReportJson, formatDoctorReportText } =
        await import("../doctor.js");
      // E-adj-A5: parseAgentsFlag centralizes the parseAgentsList catch — same
      // as init's --agents branch. `init` and `doctor` used to inline a byte-
      // identical try/catch; migrating doctor onto the helper keeps them in
      // sync when the error-to-exit behavior changes.
      //
      // issue #336 (meta-review F1) — `opts.format` is now threaded through
      // so an `AgentsParseError` here gets the same format-aware treatment
      // (json envelope / unchanged text) as every other fatal error, instead
      // of always printing bare text regardless of `--format json`.
      const agents: AgentId[] | undefined =
        opts.agents !== undefined ? parseAgentsFlag(String(opts.agents), opts.format) : undefined;
      // C1 — mirror the `init` action's try/catch so `SkillsInstallError`,
      // `EACCES` reads, unknown-agent throws, etc. surface as a single
      // `Error: <msg>` line rather than a raw Node stack trace.
      //
      // issue #336 (meta-review F1) — this catch-all used to be plain-text-
      // only (`console.error(\`Error: ${msg}\`)`) regardless of `--format`,
      // so a `--format json` consumer piping doctor's fatal errors to `jq`
      // got a parse error instead of a `{"error": ...}` envelope. `loadConfig()`
      // (inside `runDoctor`, see doctor.ts's own `loadConfig` call) is the
      // most common way to reach this — a malformed `.artgraph.json` now
      // surfaces cleanly here instead of as a raw Node stack trace.
      try {
        const report = runDoctor({ rootDir, agents });
        const out =
          opts.format === "json" ? formatDoctorReportJson(report) : formatDoctorReportText(report);
        console.log(out);
        if (report.summary.failCount > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        if (e instanceof OxcLoadError) {
          printOxcLoadError(opts.format, e);
          process.exit(1);
        }
        const msg = e instanceof Error ? e.message : String(e);
        printFatalCatchAll(opts.format, msg);
        process.exit(1);
      }
    });
}
