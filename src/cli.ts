#!/usr/bin/env node

import { Command, CommanderError, Option } from "commander";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { scan, reconcile } from "./scan.js";
import { impact, resolveStartIds, resolveOriginReqs } from "./graph/traverse.js";
import { extractFiles, type SymbolEntry } from "./parsers/sdd-files.js";

// spec 016 (R-003) — direct CLI / hook-pretool / --diff inputs come in as raw
// strings (file paths or `path:symbol` declarations). lift each into the
// `SymbolEntry` shape expected by `resolveStartIds`. Keep this regex in sync
// with `src/parsers/sdd-files.ts:PATH_SYMBOL_RE` so direct CLI inputs accept
// the same syntax as the parser does for `Files:` sections.
const CLI_PATH_SYMBOL_RE = /^([^:\s]+\.[\w]+):([^\s,()]+)$/;

/**
 * spec 016 (T027, R-003, contracts/cli-flags.md §1.1) — lift bare string
 * targets to `SymbolEntry[]`. Each string matched against `CLI_PATH_SYMBOL_RE`:
 *  - match  → `{ path, symbol, line: 1 }`
 *  - no match → `{ path, line: 1 }` (symbol undefined, file-unit semantics)
 *
 * `line` is 1 because direct CLI input has no source line; the value is only
 * used for diagnostic display when a symbol miss is reported.
 */
function pathsToEntries(paths: string[]): SymbolEntry[] {
  return paths.map((p) => {
    const m = CLI_PATH_SYMBOL_RE.exec(p);
    if (m) {
      return { path: m[1]!, symbol: m[2]!, line: 1 };
    }
    return { path: p, line: 1 };
  });
}
import { formatGraphText, formatGraphJSON } from "./graph/format.js";
import type { NodeKind } from "./types.js";
import type { BuildWarning } from "./graph/builder.js";
import { check } from "./check.js";
import { computeCoverage } from "./coverage.js";
import { readLock } from "./lock.js";
import { getGitDiffFiles } from "./diff.js";
import {
  parseHookInput,
  extractFilePaths,
  toRelativePath,
  formatAdditionalContext,
  buildHookOutput,
} from "./hook-pretool.js";
import type { ArtgraphConfig, TestResultMap } from "./types.js";
import { runInit } from "./init.js";
import { runPlanCoverage } from "./plan-coverage/index.js";
import { resolveSpecDir } from "./plan-coverage/spec-resolver.js";
import { loadTestResults } from "./test-results.js";
import { executeRename, executeSplit, executeMerge } from "./rename-executor.js";
import type { RenameResult } from "./rename-executor.js";
import { getProviderStatuses, registerBuiltinProviders, runIntegrate } from "./integrate/index.js";
import type { IntegrateResult, IntegrationProviderId } from "./types.js";
import { parseAgentsList, AgentsParseError } from "./agents/parse-agents.js";
import type { AgentId } from "./agents/descriptors.js";

// Wire up the built-in integration providers (speckit / kiro) before
// commander parses argv. Today the registration body is empty (T014); US1
// / US2 fill it in.
registerBuiltinProviders();

// Test seam: when set, hook-pretool reads this string instead of process.stdin.
// Lets `runCli({stdin})` drive hook-pretool entirely in-process without having
// to mock the global stdin stream.
let _hookStdinOverride: string | undefined;

function buildProgram(): Command {
  const program = new Command();
  program.name("artgraph").description("Typed artifact graph for TS/JS").version("0.1.0");
  registerCommands(program);
  return program;
}

function registerCommands(program: Command): void {

function applyMode(config: ArtgraphConfig, modeFlag?: string): ArtgraphConfig {
  if (modeFlag === "symbol" || modeFlag === "file") {
    return { ...config, mode: modeFlag };
  }
  return config;
}

// Resolve test-result paths from the `--test-results` flag (preferred) or the
// `.artgraph.json` `testResultPaths` field, then load them. Returns undefined
// when neither is set so callers fall back to legacy (verifies-edge-only)
// coverage. Shared by `scan`, `check`, and `coverage`.
function resolveTestResults(
  opts: { testResults?: string[] },
  config: ArtgraphConfig,
  rootDir: string,
): TestResultMap | undefined {
  const paths = opts.testResults ?? config.testResultPaths;
  if (paths && paths.length > 0) {
    return loadTestResults(paths, rootDir);
  }
  return undefined;
}

program
  .command("init")
  .description(
    "Initialize artgraph for this project (default: config + scan + Skills + auto-integrate detected SDD tools + AGENTS.md / wrapper injection; Stop hook lands in PR-B). Use --minimal for bare config only.",
  )
  .option("--force", "Overwrite existing .artgraph.json")
  .option("--minimal", "Bare config only — opt out of every extra setup stage")
  // Stage opt-outs (in default mode)
  .option("--no-scan", "Skip initial scan + reconcile")
  .option("--no-skills", "Skip Skills distribution to the selected --agents (default mode only — already off under --minimal)")
  .option("--no-integrate", "Skip SDD-tool auto-integration (default mode only)")
  .option("--no-hooks", "Skip Stop hook installation (default mode only; P1 deliverable)")
  .option("--no-agent-context", "Skip AGENTS.md / wrapper injection (default mode only)")
  // Stage opt-ins (used with --minimal)
  .option("--with-skills", "Distribute Skills to the selected --agents canonical paths (use with --minimal)")
  .option("--with-integrate", "Auto-integrate detected SDD tools (use with --minimal)")
  .option("--with-hooks", "Install Stop hook (use with --minimal; P1 deliverable, no effect yet)")
  .option("--with-agent-context", "Inject AGENTS.md + wrapper(s) for the selected --agents (use with --minimal)")
  // Explicit integrate list (overrides auto-detect)
  .option(
    "--integrations <tools>",
    "Comma-separated SDD tools to integrate (overrides auto-detect; e.g. speckit,kiro or all)",
  )
  .option("--integrate-gate", "Pass --gate to speckit during integration")
  .option("--no-integrate-gate", "Pass --no-gate to speckit during integration")
  // spec 013 (FR-001 / FR-002) — Tier 1 agent ids the user wants to target.
  // Required when Skills or agent-context distribution runs; rejected
  // (with a "Did you mean ...?" hint) for unknown / uppercase / empty /
  // duplicate values per contracts/cli-flags.md.
  .option(
    "--agents <list>",
    "Comma-separated Tier 1 agent ids to target (claude, codex, cursor, copilot, kiro). Required for Skills / agent-context distribution.",
  )
  .option("--format <format>", "Output format: json | text", "text")
  .action((opts) => {
    const rootDir = process.cwd();

    // M24: detect mutually-exclusive --no-X + --with-X combinations before
    // doing any work. commander otherwise silently lets --with-X "win"
    // (last flag), which has bitten users in PR #103 review.
    const conflicts: string[] = [];
    if (opts.skills === false && opts.withSkills === true) conflicts.push("--no-skills / --with-skills");
    if (opts.integrate === false && opts.withIntegrate === true) conflicts.push("--no-integrate / --with-integrate");
    if (opts.hooks === false && opts.withHooks === true) conflicts.push("--no-hooks / --with-hooks");
    if (opts.agentContext === false && opts.withAgentContext === true) conflicts.push("--no-agent-context / --with-agent-context");
    if (conflicts.length > 0) {
      console.error(`Error: mutually exclusive flag combinations: ${conflicts.join("; ")}`);
      process.exit(1);
    }

    // C1: --with-hooks is accepted (so the flag surface is stable for PR-B)
    // but currently no-op. Warn so the user doesn't think they got hooks
    // without checking output. --with-agent-context now lands real output
    // (AGENTS.md + wrappers, spec 013 T021); the warning was removed.
    if (opts.withHooks === true) {
      console.error("WARNING: --with-hooks is a P1 deliverable; the flag has no effect in this release.");
    }

    // Parse --integrations: "all" stays as the literal sentinel; otherwise
    // it's a comma-separated provider id list. Empty/undefined leaves
    // integrations unspecified so runInit's auto-detect kicks in.
    const integrations = parseInitIntegrations(opts.integrations);

    // M12: surface valid provider ids when the user fat-fingers an
    // --integrations value. runInit's own warning also fires later, but
    // showing the valid set here gives the user the hint *before* init runs.
    const VALID_PROVIDER_IDS = new Set(["speckit", "kiro"]);
    if (Array.isArray(integrations)) {
      const invalid = integrations.filter((id) => !VALID_PROVIDER_IDS.has(id as string));
      if (invalid.length > 0) {
        const valid = [...VALID_PROVIDER_IDS].join(", ");
        console.error(`WARNING: unknown integration provider(s): ${invalid.join(", ")} (valid: ${valid})`);
      }
    }

    // H2: commander stores --integrate-gate / --no-integrate-gate in
    // `opts.integrateGate`. When neither was supplied, the contract
    // (contracts/cli-flags.md:48, spec.md:258) says default to gate-on for
    // speckit. Returning `undefined` here left speckit gateless by default.
    const integrateGate: boolean = Object.prototype.hasOwnProperty.call(
      opts,
      "integrateGate",
    )
      ? (opts.integrateGate as boolean)
      : true; // contract default

    // spec 013 (T005 / T006) — --agents=<csv> parsing + orthogonality.
    //
    // Parse the raw flag value first so a malformed list (uppercase,
    // duplicate, unknown id) fails with the canonical "Did you mean ...?"
    // hint before we even look at the other gates. The parser throws
    // `AgentsParseError` with the full stderr-ready message; we surface it
    // verbatim and exit 1.
    let parsedAgents: AgentId[] | undefined;
    if (opts.agents !== undefined) {
      try {
        parsedAgents = parseAgentsList(String(opts.agents));
      } catch (e) {
        if (e instanceof AgentsParseError) {
          console.error(e.message);
          process.exit(1);
        }
        throw e;
      }
    }

    // Orthogonality rules (FR-013, contracts/cli-flags.md):
    //   - --minimal:                  every cross-agent stage off, --agents ignored (warn if given)
    //   - --no-skills --no-agent-context: both off, --agents ignored (warn if given)
    //   - else:                       --agents required, error with 3-option UX if missing
    //
    // We deliberately key the "skip" decision on the user-facing flag
    // intent (NOT computeStageGates) so that --with-skills under --minimal
    // does NOT bypass the spec-013 requirement: --minimal stays "all off"
    // for the cross-agent stages regardless of the legacy --with-* opt-ins.
    const skipDueToMinimal = opts.minimal === true;
    const skipDueToBothStagesOff =
      !skipDueToMinimal && opts.skills === false && opts.agentContext === false;

    if (skipDueToMinimal && parsedAgents !== undefined) {
      console.error(
        "WARNING: --minimal overrides --agents (all cross-agent stages disabled)",
      );
      parsedAgents = undefined;
    } else if (skipDueToBothStagesOff && parsedAgents !== undefined) {
      console.error(
        "WARNING: --no-skills --no-agent-context disables every cross-agent stage; --agents value is ignored",
      );
      parsedAgents = undefined;
    }

    const agentsRequired = !(skipDueToMinimal || skipDueToBothStagesOff);
    if (agentsRequired && parsedAgents === undefined) {
      console.error(AGENTS_REQUIRED_ERROR);
      process.exit(1);
    }

    try {
      const result = runInit(rootDir, {
        force: opts.force,
        minimal: opts.minimal,
        // commander's --no-X negation sets opts.X = false when the flag is
        // passed, true otherwise. Convert to the noX form runInit expects.
        noScan: opts.scan === false,
        noSkills: opts.skills === false,
        noIntegrate: opts.integrate === false,
        noHooks: opts.hooks === false,
        noAgentContext: opts.agentContext === false,
        withSkills: opts.withSkills === true,
        withIntegrate: opts.withIntegrate === true,
        withHooks: opts.withHooks === true,
        withAgentContext: opts.withAgentContext === true,
        integrations,
        integrateGate,
        agents: parsedAgents,
      });

      if (opts.format === "json") {
        console.log(
          JSON.stringify({
            configPath: result.configPath,
            config: result.config,
            sddTools: result.sddTools,
            scanSummary: result.scanSummary ?? null,
            warnings: result.warnings,
            lockPath: result.lockPath ?? null,
            // H6: split SKILL.md installs from shared fragments / references
            // so the JSON consumer can count Skills accurately.
            skillsInstalled: result.skillsInstalled
              ? {
                  skills: result.skillsInstalled.filter(
                    (p) => p.endsWith("/SKILL.md") || p.endsWith("\\SKILL.md"),
                  ),
                  fragments: result.skillsInstalled.filter(
                    (p) => !p.endsWith("/SKILL.md") && !p.endsWith("\\SKILL.md"),
                  ),
                }
              : null,
            integrationResults: result.integrationResults ?? null,
            integrationWarnings: result.integrationWarnings ?? null,
          }),
        );
      } else {
        for (const tool of result.sddTools) {
          console.log(`${tool.name} detected (${tool.marker}/)`);
        }

        if (result.scanSummary) {
          console.log(
            `\nNodes: ${result.scanSummary.nodeCount}  Edges: ${result.scanSummary.edgeCount}`,
          );
          console.log(
            `  req: ${result.scanSummary.reqCount}  doc: ${result.scanSummary.docCount}  file: ${result.scanSummary.fileCount}  test: ${result.scanSummary.testCount}`,
          );
          printWarnings(result.warnings);
          console.log(`\nCreated .artgraph.json`);
          console.log(`Created ${result.config.lockFile}`);
        } else {
          console.log(`Created .artgraph.json (scan skipped)`);
          console.log(`\nTo scan later, run: artgraph scan && artgraph reconcile`);
        }
        if (result.skillsInstalled && result.skillsInstalled.length > 0) {
          // H6: SKILL.md files are the user-discoverable Skills; the rest
          // are shared fragments and references that travel with them.
          // Reporting the combined count as "skills" was misleading.
          const skills = result.skillsInstalled.filter(
            (p) => p.endsWith("/SKILL.md") || p.endsWith("\\SKILL.md"),
          );
          const fragments = result.skillsInstalled.filter((p) => !skills.includes(p));
          console.log(`\nInstalled ${skills.length} Claude Code skills:`);
          for (const path of skills) console.log(`  ${path}`);
          if (fragments.length > 0) {
            console.log(`\nInstalled ${fragments.length} shared fragments / references:`);
            for (const path of fragments) console.log(`  ${path}`);
          }
        }

        // ---- one-shot integration output (FR-022/023): per-tool sections ----
        if (result.integrationResults && result.integrationResults.length > 0) {
          for (const r of result.integrationResults) {
            console.log("");
            console.log(`=== Integration: ${r.providerId} ===`);
            printIntegrateText(r, r.providerId);
          }
        }
        if (result.integrationWarnings && result.integrationWarnings.length > 0) {
          for (const w of result.integrationWarnings) {
            // Warnings already carry their own "WARNING:" prefix when needed.
            console.error(w);
          }
        }

        // Closing hints + integration Tips (FR-012/013). Tips appear *after*
        // the standard next-step lines so the user sees the actionable
        // discovery cue last.
        if (result.scanSummary) {
          console.log(`\nRun "artgraph check" to verify traceability.`);
          console.log(`Run "artgraph impact --diff" to see impact of your changes.`);
        }

        // Skip Tips entirely if the user already requested one-shot integration —
        // the per-tool sections above already cover discovery.
        if (!integrations) {
          printIntegrationTips(rootDir);
        }
      }

      // H1: any integration that failed should surface as a non-zero exit
      // so CI / wrapper scripts catch it. We still emit the per-tool
      // sections above so the user has the full picture before exit.
      if (result.integrationFailureCount && result.integrationFailureCount > 0) {
        process.exitCode = 1;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

/**
 * Parse the comma-separated value passed to `--integrate`. Returns:
 *   - undefined when the flag was not supplied
 *   - "all" when the user passed the special sentinel
 *   - an array of provider ids otherwise (no validation here; `runInit`
 *     handles unknown / undetected tools with a warning)
 */
function parseInitIntegrations(
  raw: string | undefined,
): IntegrationProviderId[] | "all" | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "all") return "all";
  // M11: ",,," / "," / etc. previously returned `[]` while "" returned
  // undefined. The two are semantically equivalent ("no provider chosen")
  // so collapse to undefined for consistent Tip suppression downstream.
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return undefined;
  return ids as IntegrationProviderId[];
}

/**
 * Emit per-provider "Tip:" lines for any registered integration that is
 * detected but not yet installed (FR-012/013). Silent when nothing is
 * pending so a fully-integrated repo doesn't see stale hints.
 */
function printIntegrationTips(rootDir: string): void {
  const statuses = getProviderStatuses(rootDir);
  for (const s of statuses) {
    if (!s.detected || s.installed) continue;
    if (s.providerId === "speckit") {
      console.log(
        `\nTip: Spec Kit detected. Run "artgraph integrate speckit" to wire artgraph into the SDD workflow.`,
      );
    } else if (s.providerId === "kiro") {
      console.log(
        `\nTip: Kiro detected. Run "artgraph integrate kiro" to add a steering file for the agent.`,
      );
    } else {
      console.log(
        `\nTip: ${s.displayName} detected. Run "artgraph integrate ${s.providerId}" to integrate.`,
      );
    }
  }
}

program
  .command("scan")
  .description("Build the artifact graph and show summary")
  .option("--format <format>", "Output format: json | text", "text")
  .option("--test-results <paths...>", "Test result files (Vitest JSON / JUnit XML)")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((opts) => {
    const rootDir = process.cwd();
    const config = applyMode(loadConfig(rootDir), opts.mode);
    const result = scan(rootDir, config);

    const testResults = resolveTestResults(opts, config, rootDir);
    let testResultStats:
      | { totalTests: number; passedTests: number; failedTests: number }
      | undefined;
    if (testResults) {
      let totalTests = 0;
      let passedTests = 0;
      let failedTests = 0;
      for (const records of testResults.values()) {
        for (const r of records) {
          totalTests++;
          if (r.passed) passedTests++;
          else failedTests++;
        }
      }
      testResultStats = { totalTests, passedTests, failedTests };
    }

    if (opts.format === "json") {
      const output: Record<string, unknown> = {
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        reqCount: result.reqCount,
        docCount: result.docCount,
        fileCount: result.fileCount,
        symbolCount: result.symbolCount,
        testCount: result.testCount,
        taskCount: result.taskCount,
        warnings: result.warnings,
      };
      if (testResultStats) {
        output.testResultStats = testResultStats;
      }
      console.log(JSON.stringify(output));
    } else {
      console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
      const parts = [
        `req: ${result.reqCount}`,
        `doc: ${result.docCount}`,
        `file: ${result.fileCount}`,
      ];
      if (result.symbolCount > 0) parts.push(`symbol: ${result.symbolCount}`);
      parts.push(`test: ${result.testCount}`);
      if (result.taskCount > 0) parts.push(`task: ${result.taskCount}`);
      console.log(`  ${parts.join("  ")}`);
      if (testResultStats) {
        console.log(
          `\nTest Results: total=${testResultStats.totalTests} passed=${testResultStats.passedTests} failed=${testResultStats.failedTests}`,
        );
      }
      printWarnings(result.warnings);
    }
  });

// spec 013 (FR-002 / SC-006) — verbatim error UX emitted to stderr when
// `--agents=<list>` is missing on a path that runs the Skills or
// agent-context distribution stage. The 3-option enumeration is part of
// the spec contract and is asserted as plain text by the CLI error tests
// (T013 in Phase 3); changes here must be mirrored in contracts/cli-flags.md.
const AGENTS_REQUIRED_ERROR = [
  "ERROR: --agents=<list> is required when Skills or agent-context distribution runs.",
  "",
  "Supported values: claude, codex, cursor, copilot, kiro",
  "",
  "To resolve, choose one:",
  "  1. Specify target agents:",
  "       artgraph init --agents=<list>          (e.g. --agents=claude,codex)",
  "  2. Skip Skills and agent-context distribution:",
  "       artgraph init --no-skills --no-agent-context",
  "  3. Skip every extra setup stage:",
  "       artgraph init --minimal",
].join("\n");

// spec 014 (FR-001 / FR-003): REQ-ID inputs are no longer accepted here.
// The four supported start sources are listed in this error so the user is
// pushed onto the right tool for their actual intent. Kept as a const at
// module scope so the wording stays in sync with the contract file and the
// CLI tests can assert against a single canonical string.
const IMPACT_REQ_ID_REJECTION = [
  "error: REQ-ID inputs are not accepted by `artgraph impact`.",
  "use one of the following start sources:",
  "  artgraph impact <file>...          # explicit file paths",
  "  artgraph impact --from-tasks <p>   # extract files from tasks.md",
  "  artgraph impact --from-plan <p>    # extract files from plan.md",
  "  artgraph impact --diff             # use git diff",
].join("\n");

// `doc:` prefix is also rejected (FR-001 / FR-002). Surface the same 4
// start sources so the user has a complete menu — the underlying mental
// model is identical: `impact` is now file-only.
const IMPACT_DOC_PREFIX_REJECTION = [
  "error: `doc:` prefix inputs are not accepted by `artgraph impact`.",
  "use one of the following start sources:",
  "  artgraph impact <file>...          # explicit file paths",
  "  artgraph impact --from-tasks <p>   # extract files from tasks.md",
  "  artgraph impact --from-plan <p>    # extract files from plan.md",
  "  artgraph impact --diff             # use git diff",
].join("\n");

// spec 014 (UX-1): Broaden REQ-ID input detection so the navigational error
// fires for every REQ-ID shape the artgraph ecosystem documents (README §
// "valid REQ-ID grammar"). Without this widening, Kiro `Requirement-3` and
// scoped `auth/FR-2` inputs slip past the early reject and hit the generic
// "No matching nodes found" path with no migration hint.
//
// Matches:
//   - REQ-001 / FR-032 / AUTH-001  (all-uppercase prefix + numeric tail)
//   - Requirement-3                (Pascal-case Kiro-style prefix)
//   - auth/FR-2 / auth-2fa/REQ-1   (scoped: <scope>/<base>)
//   - REQ-1.2 / Requirement-1.1    (dotted numeric tail for hierarchical IDs)
//
// We deliberately *under*-match: only inputs that look like a REQ-ID get
// routed to the 4-path navigational error; everything else (file path,
// non-conforming string) continues to the file-resolution path so the
// existing "No matching nodes found" message still fires.
const REQ_ID_INPUT_RE = /^(?:[A-Za-z][\w-]*\/)?[A-Z][A-Za-z]*-\d+(?:\.\d+)*$/;

program
  .command("impact")
  .description(
    "Show forward impact from file paths or symbol entries (spec 016: file or `path:symbol`)",
  )
  .argument(
    "[targets...]",
    "File paths or `path:symbol` entries — REQ-IDs and `doc:` prefix are rejected",
  )
  .option("--from-tasks <path>", "Extract files from a tasks.md and use them as the start set")
  .option("--from-plan <path>", "Extract files from a plan.md and use them as the start set")
  .option("--diff", "Use git diff to detect changed files")
  .option("--depth <depth>", "Limit BFS traversal depth")
  .option("--format <format>", "Output format: json | text", "text")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((targets: string[], opts) => {
    const rootDir = process.cwd();

    // spec 016 T026 / contracts/cli-flags.md §2 — validation order:
    //   1. REQ-ID rejection
    //   2. doc: prefix rejection
    //   3. Mutually exclusive source check
    //   4. (symbol syntax detection happens implicitly inside pathsToEntries)
    //   5. graph scan + resolve start ids
    //   6. scan-mode mismatch (R-010)
    //   7. impact BFS

    // ----- Input validation: reject REQ-ID / doc: prefix BEFORE we touch
    // the filesystem so the user gets the 4-path navigational error even on
    // a repo without `.artgraph.json`. FR-012.
    for (const t of targets) {
      if (REQ_ID_INPUT_RE.test(t)) {
        console.error(IMPACT_REQ_ID_REJECTION);
        process.exit(1);
      }
      if (t.startsWith("doc:")) {
        console.error(IMPACT_DOC_PREFIX_REJECTION);
        process.exit(1);
      }
    }

    // ----- Mutually exclusive start sources. Each of `targets[]`,
    // `--from-tasks`, `--from-plan`, `--diff` counts as a single channel;
    // contracts/cli-flags.md requires exactly one to be present.
    const sourcesPicked = [
      targets.length > 0 ? "targets" : null,
      opts.fromTasks ? "--from-tasks" : null,
      opts.fromPlan ? "--from-plan" : null,
      opts.diff ? "--diff" : null,
    ].filter((s): s is string => s !== null);

    if (sourcesPicked.length > 1) {
      console.error(
        `error: start sources are mutually exclusive (specify only one): ${sourcesPicked.join(", ")}`,
      );
      process.exit(1);
    }
    if (sourcesPicked.length === 0) {
      console.error(
        "error: no start source specified. pass file paths, --from-tasks, --from-plan, or --diff.",
      );
      process.exit(1);
    }

    const config = applyMode(loadConfig(rootDir), opts.mode);
    const { graph } = scan(rootDir, config);
    const lock = readLock(rootDir, config.lockFile);

    // ----- Build SymbolEntry[] from the chosen channel:
    //   * --from-tasks / --from-plan → parser's ExtractResult.entries verbatim
    //     (T028; symbol-unit declarations propagate through `resolveStartIds`).
    //   * --diff → file-unit only (contracts/cli-flags.md §1.3; git diff has
    //     no symbol resolution).
    //   * positional targets → CLI_PATH_SYMBOL_RE lift in `pathsToEntries`
    //     (T027). Symbol detection is a SIDE EFFECT of building the entries,
    //     so it happens after #1-#3 above per the validation order.
    let entries: SymbolEntry[];
    let inputDisplayLabels: string[]; // for "No matching nodes found" message
    if (opts.fromTasks || opts.fromPlan) {
      const sourcePath = (opts.fromTasks ?? opts.fromPlan) as string;
      const sourceLabel = opts.fromTasks ? "--from-tasks" : "--from-plan";
      if (!existsSync(sourcePath)) {
        console.error(`error: ${sourceLabel} path not found: ${sourcePath}`);
        process.exit(1);
      }
      const text = readFileSync(sourcePath, "utf-8");
      const extracted = extractFiles(text, { graph, repoRoot: rootDir });
      // SPEC-2: surface every `unresolvedFilePath` diagnostic as a warning so
      // typos in a `Files:` section (e.g. `src/auht.ts`) don't silently fall
      // through to an empty start set. Mirrors plan-coverage's diagnostic
      // flattening so the two CLIs stay consistent.
      for (const d of extracted.diagnostics) {
        if (d.kind === "unresolvedFilePath") {
          const loc =
            "line" in d && typeof d.line === "number" ? ` (line ${d.line})` : "";
          console.error(
            `WARNING: unresolved file path "${d.path}"${loc} in ${sourcePath}`,
          );
        }
      }
      if (extracted.stage === "empty" || extracted.entries.length === 0) {
        console.error(
          `error: no files extracted from ${sourcePath}. add a \`Files: <path>\` section or reference existing file paths in the body.`,
        );
        process.exit(1);
      }
      // T028: hand `entries` straight to `resolveStartIds` so symbol-unit
      // declarations propagate as `symbol:<path>#<name>` startIds.
      entries = extracted.entries;
      inputDisplayLabels = entries.map((e) =>
        e.symbol ? `${e.path}:${e.symbol}` : e.path,
      );
    } else if (opts.diff) {
      const diffFiles = getGitDiffFiles(rootDir);
      if (diffFiles.length === 0) {
        console.log("No changes detected in git diff.");
        process.exit(0);
      }
      entries = diffFiles.map((p) => ({ path: p, line: 1 }));
      inputDisplayLabels = diffFiles.slice();
    } else {
      entries = pathsToEntries(targets);
      inputDisplayLabels = targets.slice();
    }

    const hasSymbolInput = entries.some((e) => e.symbol !== undefined);

    const { startIds, unresolvedSymbols } = resolveStartIds(graph, entries);

    // T029 / R-010 / contracts/cli-flags.md §4.2 — scan-mode mismatch.
    // When the input includes any symbol entry but the current graph has zero
    // `symbol` nodes, that's a global "you didn't scan in symbol mode" miss
    // — every entry would otherwise pile up as `unresolvedSymbol`. Emit the
    // dedicated global error so the user knows to flip `.artgraph.json`'s
    // mode rather than going hunting for typos.
    if (hasSymbolInput) {
      let hasSymbolNode = false;
      for (const node of graph.nodes.values()) {
        if (node.kind === "symbol") {
          hasSymbolNode = true;
          break;
        }
      }
      if (!hasSymbolNode) {
        console.error(
          [
            "ERROR: symbol-level input requires `artgraph scan --mode symbol`.",
            "       Set `mode: \"symbol\"` in `.artgraph.json` and re-run scan to enable",
            "       symbol-mode lookup.",
          ].join("\n"),
        );
        process.exit(1);
      }
    }

    // T030 / R-009 / contracts/cli-flags.md §4.1 — per-entry symbol miss.
    // Symbol nodes exist but this specific `path:symbol` isn't registered —
    // typo, export rename, or a stale graph. Surface one line per entry so
    // the user can target the fix.
    if (unresolvedSymbols.length > 0) {
      for (const u of unresolvedSymbols) {
        const label = `${u.path}:${u.symbol}`;
        console.error(`ERROR: No matching symbol found for: ${label}`);
        console.error(
          `  hint: check the export name with \`grep "export.*${u.symbol}" ${u.path}\``,
        );
        console.error(
          `        or verify that \`mode: "symbol"\` is set in \`.artgraph.json\` and re-scan.`,
        );
      }
      process.exit(1);
    }

    if (startIds.length === 0) {
      console.error(`No matching nodes found for: ${inputDisplayLabels.join(", ")}`);
      process.exit(1);
    }

    let maxDepth: number | undefined;
    if (opts.depth !== undefined) {
      const parsed = parseInt(opts.depth, 10);
      if (isNaN(parsed)) {
        console.error(`Invalid --depth value: "${opts.depth}". Must be a non-negative integer.`);
        process.exit(1);
      }
      if (parsed < 0) {
        console.error(`Invalid --depth value: "${opts.depth}". Must be a non-negative integer.`);
        process.exit(1);
      }
      maxDepth = parsed;
    }
    const result = impact(graph, startIds, lock, maxDepth);

    // T031 / FR-014 / INV-S6 — populate `originReqs` axis. `impact()` itself
    // stays purely forward-BFS; the origin axis is the union of each startId's
    // direct `@impl` claim (1-hop reverse `implements` edge). Recompute here so
    // the JSON / text outputs always carry both axes.
    result.originReqs = resolveOriginReqs(graph, startIds);

    if (opts.format === "json") {
      console.log(JSON.stringify(result));
    } else {
      printImpactText(result);
    }
  });

// spec 014 (FR-013 — FR-020): plan-coverage subcommand. Reads tasks.md /
// plan.md (and the current spec.md) to detect REQs that are *affected*
// (via the file → impact() blast) but *never mentioned* in the source
// trio — i.e. the SDD author silently dragged in side effects.
//
// All defaults follow contracts/cli-flags.md §plan-coverage:
//   --format text (default), --gate off, --ignore "", --require-files-section
//   off unless `.artgraph.json`'s `planCoverage.requireFilesSection` is true.
program
  .command("plan-coverage")
  .description(
    "Detect implicit REQ impacts: REQs reached by tasks.md/plan.md `Files:` that are never mentioned in the spec trio.",
  )
  .option("--spec <dir>", "Spec directory (auto-detected via SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)")
  .option("--tasks <path>", "Override the tasks.md path (default: <spec-dir>/tasks.md)")
  .option("--plan <path>", "Override the plan.md path (default: <spec-dir>/plan.md if present)")
  .addOption(
    new Option("--format <format>", "Output format")
      .choices(["json", "text"])
      .default("text"),
  )
  .option("--gate", "Exit 1 when implicit impacts or diagnostics are non-empty (CI use)")
  .option("--ignore <csv>", "Comma-separated REQ-IDs to drop from implicit list (one-shot)", "")
  .option(
    "--require-files-section",
    "Emit a missingFilesSection diagnostic for every task block without a Files: header",
  )
  .action((opts) => {
    const rootDir = process.cwd();

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
    const tasksPath: string = opts.tasks
      ? (opts.tasks as string)
      : resolve(specDir, "tasks.md");
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

    // `--require-files-section` flag overrides config; absence means we
    // fall back to the planCoverage section's requireFilesSection (default
    // false).
    const config = loadConfig(rootDir);
    const requireFilesSection: boolean =
      opts.requireFilesSection === true
        ? true
        : config.planCoverage?.requireFilesSection ?? false;

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
        console.log(JSON.stringify(result.json));
      } else {
        process.stdout.write(result.text);
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

program
  .command("check")
  .description("Check for drift, orphans, and uncovered REQs")
  .option("--gate", "Exit 2 on any issue (for Stop hook)")
  .option("--diff", "Scope check to files changed in git diff")
  .option("--format <format>", "Output format: json | text", "text")
  .option("--test-results <paths...>", "Test result files (Vitest JSON / JUnit XML)")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((opts) => {
    const rootDir = process.cwd();
    const config = applyMode(loadConfig(rootDir), opts.mode);
    const { graph, warnings } = scan(rootDir, config);
    const lock = readLock(rootDir, config.lockFile);

    const testResults = resolveTestResults(opts, config, rootDir);

    let scopedNodeIds: Set<string> | undefined;
    if (opts.diff) {
      const diffFiles = getGitDiffFiles(rootDir);
      if (diffFiles.length === 0) {
        console.log("No changes detected in git diff.");
        process.exit(0);
      }
      const { startIds } = resolveStartIds(graph, pathsToEntries(diffFiles));
      if (startIds.length === 0) {
        console.log("Changed files are not tracked in the graph.");
        process.exit(0);
      }
      const impactResult = impact(graph, startIds, lock);
      scopedNodeIds = new Set([
        ...startIds,
        ...impactResult.impactReqs.map((r) => r),
        ...impactResult.affectedDocs.map((d) => d),
        ...impactResult.affectedFiles.map((f) => `file:${f}`),
      ]);
      for (const f of impactResult.affectedFiles) {
        for (const [id, node] of graph.nodes) {
          if (node.kind === "symbol" && node.filePath === f) {
            scopedNodeIds.add(id);
          }
        }
      }
    }
    const result = check(graph, lock, scopedNodeIds, testResults);

    if (opts.format === "json") {
      console.log(JSON.stringify({ ...result, warnings }));
    } else {
      printCheckText(result);
      printWarnings(warnings);
    }

    if (opts.gate && !result.pass) {
      process.exit(2);
    }
  });

program
  .command("coverage")
  .description("Show coverage status for each requirement")
  .addOption(
    new Option("--format <format>", "Output format: json | text")
      .choices(["json", "text"])
      .default("text"),
  )
  .option("--test-results <paths...>", "Test result files (Vitest JSON / JUnit XML)")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((opts) => {
    const rootDir = process.cwd();
    const config = applyMode(loadConfig(rootDir), opts.mode);
    const { graph } = scan(rootDir, config);

    const testResults = resolveTestResults(opts, config, rootDir);
    const entries = computeCoverage(graph, testResults);

    if (opts.format === "json") {
      printCoverageJson(entries);
    } else {
      printCoverageText(entries);
    }
  });

program
  .command("reconcile")
  .description("Update the lock file to match current state")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((opts) => {
    const rootDir = process.cwd();
    const config = applyMode(loadConfig(rootDir), opts.mode);
    const { graph } = scan(rootDir, config);
    reconcile(rootDir, config, graph);
    console.log(`Lock file updated: ${config.lockFile}`);
  });

program
  .command("graph")
  .description("Show the artifact graph")
  .option("--format <format>", "Output format: text | json", "text")
  .addOption(
    new Option("--kind <kind>", "Filter by node kind").choices([
      "doc",
      "req",
      "file",
      "test",
      "task",
    ]),
  )
  .action((opts) => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
    const { graph } = scan(rootDir, config);

    const kindFilter = opts.kind as NodeKind | undefined;

    if (opts.format === "json") {
      console.log(formatGraphJSON(graph, kindFilter));
    } else {
      console.log(formatGraphText(graph, kindFilter));
    }
  });

program
  .command("hook-pretool")
  .description("PreToolUse hook: analyze impact before Edit/Write/MultiEdit")
  .action(async () => {
    const startTime = process.hrtime.bigint();
    const rootDir = process.cwd();

    try {
      let stdinText: string;
      if (_hookStdinOverride !== undefined) {
        stdinText = _hookStdinOverride;
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        stdinText = Buffer.concat(chunks).toString("utf-8");
      }

      const input = parseHookInput(stdinText);
      if (!input) {
        process.stderr.write("artgraph: failed to parse hook input\n");
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const filePaths = extractFilePaths(input);
      if (filePaths.length === 0) {
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const relativePaths = filePaths.map((fp) => toRelativePath(fp, rootDir));

      if (!existsSync(resolve(rootDir, ".artgraph.json"))) {
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      let config;
      try {
        config = loadConfig(rootDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`artgraph: config load failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      let graph;
      try {
        const scanResult = scan(rootDir, config);
        graph = scanResult.graph;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`artgraph: scan failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const { startIds } = resolveStartIds(graph, pathsToEntries(relativePaths));
      if (startIds.length === 0) {
        process.stdout.write(JSON.stringify(buildHookOutput("artgraph impact: (none)")));
        const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        process.stderr.write(`artgraph: hook-pretool completed in ${Math.round(elapsed)}ms\n`);
        return;
      }

      let lock;
      try {
        lock = readLock(rootDir, config.lockFile);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`artgraph: lock read failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      let result;
      try {
        result = impact(graph, startIds, lock);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`artgraph: impact failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const additionalContext = formatAdditionalContext(result);
      process.stdout.write(JSON.stringify(buildHookOutput(additionalContext)));

      const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      process.stderr.write(`artgraph: hook-pretool completed in ${Math.round(elapsed)}ms\n`);
    } catch {
      process.stderr.write("artgraph: failed to read stdin\n");
      process.stdout.write(JSON.stringify(buildHookOutput("")));
    }
  });

function printWarnings(warnings: BuildWarning[]) {
  for (const w of warnings) {
    switch (w.type) {
      case "ambiguous-id": {
        const hint = w.files.length > 0 ? ` (candidates: ${w.files.join(", ")})` : "";
        console.error(`WARNING: ambiguous ID "${w.id}"${hint}`);
        break;
      }
      case "duplicate-id":
        console.error(`WARNING: duplicate ID "${w.id}" in ${w.files.join(", ")}`);
        break;
      case "orphan-doc":
        console.error(`WARNING: orphan-doc "${w.id}" referenced from ${w.files.join(", ")}`);
        break;
      case "orphan-edge":
        console.error(
          `WARNING: orphan-edge "${w.id}"${w.files.length > 0 ? ` referenced from ${w.files.join(", ")}` : ""}${w.message ? ` (${w.message})` : ""}`,
        );
        break;
      case "invalid-relation":
        console.error(
          `WARNING: invalid relation "${w.id}" in ${w.files.join(", ")}. Use "derives_from" or "depends_on"`,
        );
        break;
      case "reserved-prefix":
        console.error(`WARNING: reserved prefix in ID "${w.id}" in ${w.files.join(", ")}`);
        break;
      case "unresolved-link":
        console.error(
          `WARNING: unresolved-link "${w.id}" referenced from ${w.files.join(", ")}`,
        );
        break;
      case "out-of-scope-link":
        console.error(
          `WARNING: out-of-scope-link "${w.id}" referenced from ${w.files.join(", ")} (outside specDirs)`,
        );
        break;
      case "invalid-annotation-id":
        console.error(
          `WARNING: invalid-annotation-id "${w.id}"${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
        );
        break;
      case "empty-annotation":
        console.error(
          `WARNING: empty-annotation${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
        );
        break;
      case "self-reference-annotation":
        console.error(
          `WARNING: self-reference-annotation "${w.id}"${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
        );
        break;
      default: {
        // Exhaustiveness check: if `BuildWarning.type` gains a new variant
        // without a matching case, TypeScript flags the assignment below at
        // compile time. Keeps the CLI surface in sync with the warning union.
        const _exhaustive: never = w.type;
        void _exhaustive;
      }
    }
  }
}

// spec 016 T032 / FR-015 / FR-023 / contracts/cli-flags.md §5.2 — text formatter.
// Three REQ-axis sections:
//   - Impact reqs        = forward BFS reach
//   - Origin reqs        = startId `@impl` claims (1-hop reverse)
//   - Drift candidates   = (impactReqs \ originReqs), section omitted when empty
function printImpactText(result: any) {
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

function printCoverageJson(entries: { reqId: string; status: string }[]) {
  const items = entries.map((e) => ({ reqId: e.reqId, status: e.status }));
  const summary = {
    total: entries.length,
    verified: entries.filter((e) => e.status === "verified").length,
    implOnly: entries.filter((e) => e.status === "impl-only").length,
    untagged: entries.filter((e) => e.status === "untagged").length,
  };
  console.log(JSON.stringify({ items, summary }));
}

function printCoverageText(entries: { reqId: string; status: string }[]) {
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

function printCheckText(result: any) {
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

// `integrate` accepts a single positional that is either a provider id
// (`speckit` / `kiro`) or the sub-command verb `list`. Commander 13's
// nested sub-commands struggle with this hybrid shape (the parent's
// positional arg collides with `.command("list")`), so we dispatch on the
// argument inside the handler. Both surfaces share the same `--format`
// option to keep CLI ergonomics consistent.
program
  .command("integrate <tool>")
  .description(
    "Integrate artgraph into an SDD tool's workflow (speckit | kiro), or 'list' to show providers",
  )
  .option("--gate", "(speckit only) Add before_implement gate hook")
  .option("--no-gate", "(speckit only) Remove before_implement gate hook")
  .option("--force", "Overwrite existing files")
  .option("--uninstall", "Remove the integration (delete files / hook entries)")
  .addOption(
    new Option("--format <format>", "Output format").choices(["text", "json"]).default("text"),
  )
  .action((tool: string, opts) => {
    const rootDir = process.cwd();

    // Sub-command dispatch: `integrate list` reuses the same option surface
    // (only --format applies; the rest are ignored for `list`).
    if (tool === "list") {
      runIntegrateList(rootDir, opts.format);
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

function runIntegrateList(rootDir: string, format: string): void {
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

// JSON shape for `integrate list` — matches contracts/integrate-cli.md §2.
// Using `id` (not `providerId`) on the wire for parity with the contract
// example; internally we still carry `providerId`.
function toListJson(s: import("./types.js").IntegrationStatus): {
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

// Display-name lookup for the integrate text formatter. The registry stores
// the canonical name on the provider instance, but we don't want to depend
// on registry state here (the registry might be cleared by tests).
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  speckit: "Spec Kit",
  kiro: "Kiro",
};

function printIntegrateText(result: IntegrateResult, tool: string): void {
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

program
  .command("rename")
  .description("Rename, split, or merge spec IDs across the project")
  .option("--from <id>", "Source ID to rename")
  .option("--to <id>", "Target ID for rename")
  .option("--split <id>", "Source ID to split")
  .option("--merge <ids...>", "Source IDs to merge")
  .option("--into <ids...>", "Target ID(s) for split or merge")
  .option("--dry-run", "Show changes without applying them")
  .addOption(
    new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"),
  )
  .action((opts) => {
    const rootDir = process.cwd();
    const format: "json" | "text" = opts.format;
    const baseOpts = { dryRun: !!opts.dryRun, format, rootDir };

    const fail = (msg: string): never => {
      // Honour --format json even on the error path so JSON consumers never
      // have to parse a plain-text line (F7).
      if (format === "json") {
        console.error(JSON.stringify({ error: msg }));
      } else {
        console.error(`Error: ${msg}`);
      }
      process.exit(1);
    };

    try {
      let result: RenameResult;

      if (opts.from && opts.to) {
        // rename mode
        result = executeRename({ ...baseOpts, from: opts.from, to: opts.to });
      } else if (opts.split && opts.into) {
        // split mode
        result = executeSplit({ ...baseOpts, splitId: opts.split, intoIds: opts.into });
      } else if (opts.merge && opts.into) {
        // merge mode
        if (opts.into.length !== 1) {
          fail("--merge requires exactly one --into target ID.");
        }
        result = executeMerge({ ...baseOpts, mergeIds: opts.merge, intoId: opts.into[0] });
      } else {
        fail("Specify --from/--to, --split/--into, or --merge/--into.");
        return;
      }

      if (format === "json") {
        printRenameJson(result);
      } else {
        printRenameText(result);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(msg);
    }
  });

function printRenameText(result: RenameResult) {
  if (result.changes.length === 0 && result.lockChanges.length === 0) {
    console.log("No references found.");
    return;
  }

  if (result.operation === "rename") {
    console.log(`Renamed ${result.from} → ${result.to}`);
  } else if (result.operation === "split") {
    console.log(`Split ${result.from} → ${(result.intoIds ?? []).join(", ")}`);
  } else if (result.operation === "merge") {
    console.log(`Merged ${(result.sourceIds ?? []).join(", ")} → ${result.to}`);
  }

  for (const c of result.changes) {
    const before = c.before.trim().slice(0, 60);
    const after = c.after.trim().slice(0, 60);
    console.log(`  ${c.filePath}:${c.line}  ${before} → ${after}`);
  }

  for (const w of result.warnings) {
    console.log(
      `WARNING: ${w.filePath} contains @impl ${w.oldId} — manual assignment to ${w.newIds.join(", ")} needed`,
    );
  }

  if (!result.applied) {
    console.log("(dry-run: no files were modified)");
  }
}

function printRenameJson(result: RenameResult) {
  console.log(JSON.stringify(result));
}
}

/**
 * @internal
 * Test seam — intentionally hidden from the public package surface via the
 * `exports` field in package.json. Mutates global process state during the
 * call (cwd / exit / console / stdout / stderr) and is unsafe for external
 * use. Tests reach it via the in-repo path `../src/cli.js`.
 */
export interface RunCliOptions {
  /** Working directory the CLI sees as `process.cwd()` for the duration of the call. */
  cwd?: string;
  /** Optional stdin string injected into hook-pretool (replaces process.stdin reads). */
  stdin?: string;
}

/** @internal */
export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class CliExitError extends Error {
  exitCode: number;
  constructor(exitCode: number) {
    super(`artgraph CLI exited with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/**
 * @internal
 * Run the artgraph CLI in-process and capture its stdout/stderr/exitCode.
 * Used by the test suite to avoid the ~150–300 ms per-spawn Node startup +
 * ts-morph reload cost. Behaves like a fresh `artgraph <argv>` invocation:
 * builds a new commander tree, redirects console/process.stdout/process.stderr,
 * intercepts `process.exit`, and temporarily chdirs into `opts.cwd`.
 *
 * NOT a public API — the package's `exports` field deliberately blocks
 * deep imports so external consumers cannot reach this. It mutates global
 * process state (cwd / exit / console / stdout / stderr) and is unsafe
 * to call concurrently within a single Node process.
 */
export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origCwd = process.cwd();
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const hadStdinOverride = _hookStdinOverride !== undefined;
  const prevStdinOverride = _hookStdinOverride;

  const pushStdout = (s: string) => stdoutChunks.push(s);
  const pushStderr = (s: string) => stderrChunks.push(s);

  let exitCode = 0;

  try {
    if (opts.cwd) process.chdir(opts.cwd);
    if (opts.stdin !== undefined) _hookStdinOverride = opts.stdin;

    console.log = (...args: unknown[]) => {
      pushStdout(args.map(formatLogArg).join(" ") + "\n");
    };
    console.error = (...args: unknown[]) => {
      pushStderr(args.map(formatLogArg).join(" ") + "\n");
    };
    process.stdout.write = ((chunk: unknown) => {
      pushStdout(chunkToString(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      pushStderr(chunkToString(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new CliExitError(code ?? 0);
    }) as typeof process.exit;

    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: pushStdout,
      writeErr: pushStderr,
    });

    try {
      await program.parseAsync(argv, { from: "user" });
    } catch (e) {
      if (e instanceof CliExitError) {
        exitCode = e.exitCode;
      } else if (e instanceof CommanderError) {
        // Help / version exits are conventionally success.
        const code = e.code;
        if (code === "commander.helpDisplayed" || code === "commander.version") {
          exitCode = 0;
        } else {
          exitCode = e.exitCode ?? 1;
        }
      } else {
        throw e;
      }
    }
  } finally {
    process.chdir(origCwd);
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    _hookStdinOverride = hadStdinOverride ? prevStdinOverride : undefined;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}

// Only invoke commander when this module is the entry point of a real CLI
// process. Importing `cli.ts` from tests must not trigger argv parsing.
//
// `realpathSync` is essential: when invoked via an npm/pnpm bin shim
// (`./node_modules/.bin/artgraph`), Node's ESM loader resolves the module
// URL to the symlink target (the real `dist/cli.js`), but `process.argv[1]`
// stays as the shim path. Without realpath normalization the two are
// different strings and the guard never fires — bin-shim invocations
// would silently exit without parsing argv. See PR #99 review.
function resolveEntryHref(): string {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return "";
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return "";
  }
}
if (import.meta.url === resolveEntryHref()) {
  const program = buildProgram();
  program.parse();
}
