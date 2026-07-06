// `artgraph hook-pretool` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathsToEntries } from "./shared.js";
import { getHookStdinOverride } from "../hook-stdin-override.js";

export function registerHookPretoolCommand(program: Command): void {
  program
    .command("hook-pretool")
    .description("PreToolUse hook: analyze impact before Edit/Write/MultiEdit")
    .action(async () => {
      const startTime = process.hrtime.bigint();
      const rootDir = process.cwd();
      const {
        parseHookInput,
        extractFilePaths,
        toRelativePath,
        formatAdditionalContext,
        buildHookOutput,
      } = await import("../hook-pretool.js");

      try {
        let stdinText: string;
        const hookStdinOverride = getHookStdinOverride();
        if (hookStdinOverride !== undefined) {
          stdinText = hookStdinOverride;
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
          const { loadConfig } = await import("../config.js");
          config = loadConfig(rootDir);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`artgraph: config load failed: ${msg}\n`);
          process.stdout.write(JSON.stringify(buildHookOutput("")));
          return;
        }

        let graph;
        try {
          const { scan } = await import("../scan.js");
          const scanResult = scan(rootDir, config);
          graph = scanResult.graph;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`artgraph: scan failed: ${msg}\n`);
          process.stdout.write(JSON.stringify(buildHookOutput("")));
          return;
        }

        const { impact, resolveStartIds } = await import("../graph/traverse.js");
        const { startIds } = resolveStartIds(graph, pathsToEntries(relativePaths));
        if (startIds.length === 0) {
          process.stdout.write(JSON.stringify(buildHookOutput("artgraph impact: (none)")));
          const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
          process.stderr.write(`artgraph: hook-pretool completed in ${Math.round(elapsed)}ms\n`);
          return;
        }

        let lock;
        try {
          const { readLock } = await import("../lock.js");
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
}
