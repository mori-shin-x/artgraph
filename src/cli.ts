#!/usr/bin/env node

import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { scan, reconcile } from "./scan.js";
import { impact, resolveStartIds } from "./graph/traverse.js";
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

const program = new Command();

program.name("artgraph").description("Typed artifact graph for TS/JS").version("0.1.0");

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
  .description("Initialize artgraph for this project")
  .option("--force", "Overwrite existing .artgraph.json")
  .option("--no-scan", "Generate config only, skip scan and reconcile")
  .option(
    "--with-skills",
    "Install Claude Code skills (plan, verify, coverage, rename) into .claude/skills/",
  )
  .option(
    "--integrate <tools>",
    "Comma-separated SDD tools to integrate one-shot (speckit, kiro, all)",
  )
  .option("--integrate-gate", "Pass --gate to speckit during one-shot integration")
  .option("--no-integrate-gate", "Pass --no-gate to speckit during one-shot integration")
  .option("--format <format>", "Output format: json | text", "text")
  .action((opts) => {
    const rootDir = process.cwd();

    // Parse --integrate: "all" stays as the literal sentinel; otherwise it's
    // a comma-separated provider id list. Empty/undefined disables one-shot
    // integration entirely.
    const integrations = parseInitIntegrations(opts.integrate);

    // commander stores --integrate-gate / --no-integrate-gate in
    // `opts.integrateGate`. Preserve `undefined` so the speckit provider
    // distinguishes "no opinion" from "explicitly off" (FR-003 mirrors).
    const integrateGate: boolean | undefined = Object.prototype.hasOwnProperty.call(
      opts,
      "integrateGate",
    )
      ? (opts.integrateGate as boolean)
      : undefined;

    try {
      const result = runInit(rootDir, {
        force: opts.force,
        noScan: !opts.scan,
        withSkills: opts.withSkills,
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
            skillsInstalled: result.skillsInstalled ?? null,
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
          console.log(`\nInstalled ${result.skillsInstalled.length} Claude Code skills:`);
          for (const path of result.skillsInstalled) console.log(`  ${path}`);
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
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as IntegrationProviderId[];
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

program
  .command("impact")
  .description("Show impact from changed files or REQ-IDs")
  .argument("[targets...]", "File paths or REQ-IDs")
  .option("--diff", "Use git diff to detect changed files")
  .option("--depth <depth>", "Limit BFS traversal depth")
  .option("--format <format>", "Output format: json | text", "text")
  .addOption(new Option("--mode <mode>", "Analysis mode").choices(["file", "symbol"]))
  .action((targets: string[], opts) => {
    const rootDir = process.cwd();
    const config = applyMode(loadConfig(rootDir), opts.mode);
    const { graph } = scan(rootDir, config);
    const lock = readLock(rootDir, config.lockFile);

    const inputTargets = opts.diff ? getGitDiffFiles(rootDir) : targets;
    if (inputTargets.length === 0) {
      if (opts.diff) {
        console.log("No changes detected in git diff.");
      } else {
        console.error("No targets specified. Use file paths, REQ-IDs, or --diff.");
      }
      process.exit(opts.diff ? 0 : 1);
    }

    const startIds = resolveStartIds(graph, inputTargets);
    if (startIds.length === 0) {
      console.error(`No matching nodes found for: ${inputTargets.join(", ")}`);
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
      const startIds = resolveStartIds(graph, diffFiles);
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
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const stdinText = Buffer.concat(chunks).toString("utf-8");

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

      const startIds = resolveStartIds(graph, relativePaths);
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

program.parse();
