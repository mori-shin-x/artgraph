#!/usr/bin/env node

import { Command, Option } from "commander";
import { loadConfig } from "./config.js";
import { scan, reconcile } from "./scan.js";
import { impact, resolveStartIds } from "./graph/traverse.js";
import { formatGraphText, formatGraphJSON } from "./graph/format.js";
import type { NodeKind } from "./types.js";
import type { BuildWarning } from "./graph/builder.js";
import { check } from "./check.js";
import { readLock } from "./lock.js";
import { getGitDiffFiles } from "./diff.js";

const program = new Command();

program.name("spectrace").description("Typed artifact graph for TS/JS").version("0.1.0");

program
  .command("scan")
  .description("Build the artifact graph and show summary")
  .option("--format <format>", "Output format: json | text", "text")
  .action((opts) => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
    const result = scan(rootDir, config);

    if (opts.format === "json") {
      console.log(
        JSON.stringify({
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          reqCount: result.reqCount,
          docCount: result.docCount,
          fileCount: result.fileCount,
          testCount: result.testCount,
          warnings: result.warnings,
        }),
      );
    } else {
      console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
      console.log(
        `  req: ${result.reqCount}  doc: ${result.docCount}  file: ${result.fileCount}  test: ${result.testCount}`,
      );
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
  .action((targets: string[], opts) => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
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
  .action((opts) => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
    const { graph, warnings } = scan(rootDir, config);
    const lock = readLock(rootDir, config.lockFile);

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
    }
    const result = check(graph, lock, scopedNodeIds);

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
  .command("reconcile")
  .description("Update the lock file to match current state")
  .action(() => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
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

program.parse();
