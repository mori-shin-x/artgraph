// Ensure `dist/cli.js` exists and is up-to-date before any e2e test spawns
// the built bin. Mirrors `tests/perf/global-setup.ts` — kept as a separate
// file so each suite stays self-contained.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
    console.log("[e2e-setup] building dist/cli.js …");
    execSync("pnpm exec tsc", { stdio: "inherit" });
  }
}
