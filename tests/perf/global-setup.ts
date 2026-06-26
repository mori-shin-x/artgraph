// Ensure `dist/cli.js` exists before any perf test runs `spawnSync("node",
// [CLI, ...])`. The perf suite is the only test surface that still relies
// on the built bin (the rest of the suite uses in-process `runCli`).
//
// Vitest invokes this once per perf-suite run.

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../../dist/cli.js");
const SRC_DIR = resolve(import.meta.dirname, "../../src");

function newestMtime(dir: string): number {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) max = Math.max(max, newestMtime(p));
    else max = Math.max(max, statSync(p).mtimeMs);
  }
  return max;
}

export async function setup(): Promise<void> {
  const needsBuild = !existsSync(CLI) || statSync(CLI).mtimeMs < newestMtime(SRC_DIR);
  if (needsBuild) {
    console.log("[perf-setup] building dist/cli.js …");
    execSync("pnpm exec tsc", { stdio: "inherit" });
  }
}
