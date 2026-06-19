#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { scan, reconcile } from "./scan.js";
import { impact, resolveStartIds } from "./graph/traverse.js";
import { check } from "./check.js";
import { readLock } from "./lock.js";

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
        }),
      );
    } else {
      console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
      console.log(
        `  req: ${result.reqCount}  doc: ${result.docCount}  file: ${result.fileCount}  test: ${result.testCount}`,
      );
    }
  });

program
  .command("impact")
  .description("Show impact from changed files or REQ-IDs")
  .argument("<targets...>", "File paths or REQ-IDs")
  .option("--format <format>", "Output format: json | text", "text")
  .action((targets: string[], opts) => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
    const { graph } = scan(rootDir, config);
    const lock = readLock(rootDir, config.lockFile);

    const startIds = resolveStartIds(graph, targets);
    if (startIds.length === 0) {
      console.error(`No matching nodes found for: ${targets.join(", ")}`);
      process.exit(1);
    }

    const result = impact(graph, startIds, lock);

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
  .option("--format <format>", "Output format: json | text", "text")
  .action((opts) => {
    const rootDir = process.cwd();
    const config = loadConfig(rootDir);
    const { graph } = scan(rootDir, config);
    const lock = readLock(rootDir, config.lockFile);
    const result = check(graph, lock);

    if (opts.format === "json") {
      console.log(JSON.stringify(result));
    } else {
      printCheckText(result);
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
  if (result.orphans.length > 0) {
    console.log("Orphans:");
    for (const o of result.orphans) console.log(`  ${o}`);
  }
  if (result.uncovered.length > 0) {
    console.log("Uncovered:");
    for (const u of result.uncovered) console.log(`  ${u}`);
  }
}

function printCheckText(result: any) {
  if (result.pass) {
    console.log("All checks passed.");
    return;
  }
  if (result.drifted.length > 0) {
    console.log("DRIFT:");
    for (const d of result.drifted) console.log(`  ${d.nodeId} (${d.kind})`);
  }
  if (result.orphans.length > 0) {
    console.log("ORPHANS:");
    for (const o of result.orphans) console.log(`  ${o}`);
  }
  if (result.uncovered.length > 0) {
    console.log("UNCOVERED:");
    for (const u of result.uncovered) console.log(`  ${u}`);
  }
}

program.parse();
