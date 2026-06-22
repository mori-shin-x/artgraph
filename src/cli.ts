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
import type { SpectraceConfig, TestResultMap } from "./types.js";
import { runInit } from "./init.js";
import { loadTestResults } from "./test-results.js";
import { executeRename, executeSplit, executeMerge } from "./rename-executor.js";
import type { RenameResult } from "./rename-executor.js";

const program = new Command();

program.name("spectrace").description("Typed artifact graph for TS/JS").version("0.1.0");

function applyMode(config: SpectraceConfig, modeFlag?: string): SpectraceConfig {
  if (modeFlag === "symbol" || modeFlag === "file") {
    return { ...config, mode: modeFlag };
  }
  return config;
}

// Resolve test-result paths from the `--test-results` flag (preferred) or the
// `.spectrace.json` `testResultPaths` field, then load them. Returns undefined
// when neither is set so callers fall back to legacy (verifies-edge-only)
// coverage. Shared by `scan`, `check`, and `coverage`.
function resolveTestResults(
  opts: { testResults?: string[] },
  config: SpectraceConfig,
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
  .description("Initialize spectrace for this project")
  .option("--force", "Overwrite existing .spectrace.json")
  .option("--no-scan", "Generate config only, skip scan and reconcile")
  .option("--format <format>", "Output format: json | text", "text")
  .action((opts) => {
    const rootDir = process.cwd();
    try {
      const result = runInit(rootDir, { force: opts.force, noScan: !opts.scan });

      if (opts.format === "json") {
        console.log(
          JSON.stringify({
            configPath: result.configPath,
            config: result.config,
            sddTools: result.sddTools,
            scanSummary: result.scanSummary ?? null,
            warnings: result.warnings,
            lockPath: result.lockPath ?? null,
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
          for (const w of result.warnings) {
            if (w.type === "ambiguous-id") {
              const hint = w.files.length > 0 ? ` (candidates: ${w.files.join(", ")})` : "";
              console.error(`WARNING: ambiguous ID "${w.id}"${hint}`);
            } else {
              console.error(`WARNING: duplicate ID "${w.id}" in ${w.files.join(", ")}`);
            }
          }
          console.log(`\nCreated .spectrace.json`);
          console.log(`Created ${result.config.lockFile}`);
          console.log(`\nRun "spectrace check" to verify traceability.`);
          console.log(`Run "spectrace impact --diff" to see impact of your changes.`);
        } else {
          console.log(`Created .spectrace.json (scan skipped)`);
          console.log(`\nTo scan later, run: spectrace scan && spectrace reconcile`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

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
    let testResultStats: { totalTests: number; passedTests: number; failedTests: number } | undefined;
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
        warnings: result.warnings,
      };
      if (testResultStats) {
        output.testResultStats = testResultStats;
      }
      console.log(JSON.stringify(output));
    } else {
      console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
      if (result.symbolCount > 0) {
        console.log(
          `  req: ${result.reqCount}  doc: ${result.docCount}  file: ${result.fileCount}  symbol: ${result.symbolCount}  test: ${result.testCount}`,
        );
      } else {
        console.log(
          `  req: ${result.reqCount}  doc: ${result.docCount}  file: ${result.fileCount}  test: ${result.testCount}`,
        );
      }
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
    new Option("--kind <kind>", "Filter by node kind").choices(["doc", "req", "file", "test"]),
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
        process.stderr.write("spectrace: failed to parse hook input\n");
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const filePaths = extractFilePaths(input);
      if (filePaths.length === 0) {
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const relativePaths = filePaths.map((fp) => toRelativePath(fp, rootDir));

      if (!existsSync(resolve(rootDir, ".spectrace.json"))) {
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      let config;
      try {
        config = loadConfig(rootDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`spectrace: config load failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      let graph;
      try {
        const scanResult = scan(rootDir, config);
        graph = scanResult.graph;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`spectrace: scan failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const startIds = resolveStartIds(graph, relativePaths);
      if (startIds.length === 0) {
        process.stdout.write(JSON.stringify(buildHookOutput("spectrace impact: (none)")));
        const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        process.stderr.write(`spectrace: hook-pretool completed in ${Math.round(elapsed)}ms\n`);
        return;
      }

      let lock;
      try {
        lock = readLock(rootDir, config.lockFile);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`spectrace: lock read failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      let result;
      try {
        result = impact(graph, startIds, lock);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`spectrace: impact failed: ${msg}\n`);
        process.stdout.write(JSON.stringify(buildHookOutput("")));
        return;
      }

      const additionalContext = formatAdditionalContext(result);
      process.stdout.write(JSON.stringify(buildHookOutput(additionalContext)));

      const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      process.stderr.write(`spectrace: hook-pretool completed in ${Math.round(elapsed)}ms\n`);
    } catch {
      process.stderr.write("spectrace: failed to read stdin\n");
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
      case "invalid-relation":
        console.error(
          `WARNING: invalid relation "${w.id}" in ${w.files.join(", ")}. Use "derives_from" or "depends_on"`,
        );
        break;
      case "reserved-prefix":
        console.error(`WARNING: reserved prefix in ID "${w.id}" in ${w.files.join(", ")}`);
        break;
    }
  }
}

function printImpactText(result: any) {
  if (result.affectedReqs.length > 0) {
    console.log("Affected REQs:");
    for (const r of result.affectedReqs) console.log(`  ${r}`);
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
    console.log(
      `Summary: ${result.summary.docs} docs, ${result.summary.reqs} reqs, ${result.summary.files} files`,
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

program
  .command("rename")
  .description("Rename, split, or merge spec IDs across the project")
  .option("--from <id>", "Source ID to rename")
  .option("--to <id>", "Target ID for rename")
  .option("--split <id>", "Source ID to split")
  .option("--merge <ids...>", "Source IDs to merge")
  .option("--into <ids...>", "Target ID(s) for split or merge")
  .option("--dry-run", "Show changes without applying them")
  .addOption(new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"))
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
