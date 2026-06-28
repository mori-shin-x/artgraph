#!/usr/bin/env node

import { Command, CommanderError, Option } from "commander";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { scan, reconcile } from "./scan.js";
import { impact, resolveFileStartIds } from "./graph/traverse.js";
import { extractFiles } from "./parsers/sdd-files.js";
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
import { loadTestResults } from "./test-results.js";
import { executeRename, executeSplit, executeMerge } from "./rename-executor.js";
import type { RenameResult } from "./rename-executor.js";
import { getProviderStatuses, registerBuiltinProviders, runIntegrate } from "./integrate/index.js";
import type { IntegrateResult, IntegrationProviderId } from "./types.js";

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
    "Initialize artgraph for this project (default: config + scan + Skills + auto-integrate detected SDD tools; Stop hook and agent-context snippet land in PR-B). Use --minimal for bare config only.",
  )
  .option("--force", "Overwrite existing .artgraph.json")
  .option("--minimal", "Bare config only — opt out of every extra setup stage")
  // Stage opt-outs (in default mode)
  .option("--no-scan", "Skip initial scan + reconcile")
  .option("--no-skills", "Skip Claude Code Skills install (default mode only — already off under --minimal)")
  .option("--no-integrate", "Skip SDD-tool auto-integration (default mode only)")
  .option("--no-hooks", "Skip Stop hook installation (default mode only; P1 deliverable)")
  .option("--no-agent-context", "Skip CLAUDE.md / AGENTS.md snippet injection (default mode only; P1 deliverable)")
  // Stage opt-ins (used with --minimal)
  .option("--with-skills", "Install Claude Code Skills into .claude/skills/ (use with --minimal)")
  .option("--with-integrate", "Auto-integrate detected SDD tools (use with --minimal)")
  .option("--with-hooks", "Install Stop hook (use with --minimal; P1 deliverable, no effect yet)")
  .option("--with-agent-context", "Inject CLAUDE.md / AGENTS.md snippet (use with --minimal; P1 deliverable, no effect yet)")
  // Explicit integrate list (overrides auto-detect)
  .option(
    "--integrations <tools>",
    "Comma-separated SDD tools to integrate (overrides auto-detect; e.g. speckit,kiro or all)",
  )
  .option("--integrate-gate", "Pass --gate to speckit during integration")
  .option("--no-integrate-gate", "Pass --no-gate to speckit during integration")
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

    // C1: --with-hooks / --with-agent-context are accepted (so the flag
    // surface is stable for PR-B) but currently no-op. Warn so the user
    // doesn't think they got hooks/snippet without checking output.
    if (opts.withHooks === true) {
      console.error("WARNING: --with-hooks is a P1 deliverable; the flag has no effect in this release.");
    }
    if (opts.withAgentContext === true) {
      console.error("WARNING: --with-agent-context is a P1 deliverable; the flag has no effect in this release.");
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

const REQ_ID_INPUT_RE = /^[A-Z]+-\d+$/;

program
  .command("impact")
  .description("Show forward impact from file paths (spec 014: file-only)")
  .argument("[targets...]", "File paths only — REQ-IDs and `doc:` prefix are rejected")
  .option("--from-tasks <path>", "Extract files from a tasks.md and use them as the start set")
  .option("--from-plan <path>", "Extract files from a plan.md and use them as the start set")
  .option("--diff", "Use git diff to detect changed files")
  .option("--depth <depth>", "Limit BFS traversal depth")
  .option("--format <format>", "Output format: json | text", "text")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((targets: string[], opts) => {
    const rootDir = process.cwd();

    // ----- Input validation: reject REQ-ID / doc: prefix BEFORE we touch
    // the filesystem so the user gets the 4-path navigational error even on
    // a repo without `.artgraph.json`. FR-001 / FR-003.
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

    // ----- Resolve the start file list. `--from-tasks` / `--from-plan`
    // delegate to the spec 014 shared parser (`src/parsers/sdd-files.ts`),
    // `--diff` re-uses the existing git helper, and bare positional inputs
    // are taken as file paths verbatim.
    let inputFiles: string[];
    if (opts.fromTasks || opts.fromPlan) {
      const sourcePath = (opts.fromTasks ?? opts.fromPlan) as string;
      const sourceLabel = opts.fromTasks ? "--from-tasks" : "--from-plan";
      if (!existsSync(sourcePath)) {
        console.error(`error: ${sourceLabel} path not found: ${sourcePath}`);
        process.exit(1);
      }
      const text = readFileSync(sourcePath, "utf-8");
      const extracted = extractFiles(text, { graph, repoRoot: rootDir });
      if (extracted.stage === "empty" || extracted.files.length === 0) {
        console.error(
          `error: no files extracted from ${sourcePath}. add a \`Files: <path>\` section or reference existing file paths in the body.`,
        );
        process.exit(1);
      }
      inputFiles = extracted.files;
    } else if (opts.diff) {
      inputFiles = getGitDiffFiles(rootDir);
      if (inputFiles.length === 0) {
        console.log("No changes detected in git diff.");
        process.exit(0);
      }
    } else {
      inputFiles = targets;
    }

    const startIds = resolveFileStartIds(graph, inputFiles);
    if (startIds.length === 0) {
      console.error(`No matching nodes found for: ${inputFiles.join(", ")}`);
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

    if (opts.format === "json") {
      console.log(JSON.stringify(result));
    } else {
      printImpactText(result);
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
      const startIds = resolveFileStartIds(graph, diffFiles);
      if (startIds.length === 0) {
        console.log("Changed files are not tracked in the graph.");
        process.exit(0);
      }
      const impactResult = impact(graph, startIds, lock);
      scopedNodeIds = new Set([
        ...startIds,
        ...impactResult.affectedReqs.map((r) => r),
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

      const startIds = resolveFileStartIds(graph, relativePaths);
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

function printImpactText(result: any) {
  if (result.affectedReqs.length > 0) {
    console.log("Affected REQs:");
    for (const r of result.affectedReqs) console.log(`  ${r}`);
  }
  if (result.affectedTasks && result.affectedTasks.length > 0) {
    console.log("Affected Tasks:");
    for (const t of result.affectedTasks) console.log(`  ${t}`);
  }
  if (result.affectedDocs.length > 0) {
    console.log("Affected Docs:");
    for (const d of result.affectedDocs) console.log(`  ${d}`);
  }
  if (result.affectedFiles.length > 0) {
    console.log("Affected Files:");
    for (const f of result.affectedFiles) console.log(`  ${f}`);
  }
  if (result.drifted.length > 0) {
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
