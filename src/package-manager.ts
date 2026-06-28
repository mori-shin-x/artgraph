import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "./types.js";

export type { PackageManager } from "./types.js";

/**
 * Detect the package manager for a project, following the truth table in
 * specs/015-pkg-mgr-agnostic/contracts/package-manager.md §1. This is a
 * verbatim TypeScript port of the bash snippet in
 * templates/skills/_shared/package-manager.md — the two MUST stay in sync
 * (SC-007). The bash version exists because the `artgraph-setup` Skill runs it
 * during bootstrap, before artgraph itself is installed, so it cannot call this.
 *
 * Default PM is **pnpm**: the signal-less default, the Yarn fallback, and the
 * downstream fallback all resolve to pnpm. Only an explicit npm signal
 * (`package-lock.json` / `packageManager: npm@x`) returns npm.
 *
 * @returns the detected PM, or `null` when nothing can be detected (no
 *          package.json, no lockfile, no deno marker).
 */
export function detectPackageManager(rootDir: string): PackageManager | null {
  const has = (name: string): boolean => existsSync(join(rootDir, name));
  const pkgJsonPath = join(rootDir, "package.json");
  const hasPkgJson = existsSync(pkgJsonPath);

  // (1) Corepack-style "packageManager" field in package.json.
  if (hasPkgJson) {
    const field = readPackageManagerField(pkgJsonPath);
    switch (field) {
      case "pnpm":
      case "bun":
      case "npm":
        return field;
      case "yarn":
        warn(
          'packageManager=yarn but Yarn is not supported; falling back to pnpm',
        );
        return "pnpm";
      // Unknown / malformed value: fall through to lockfile sniffing.
    }
  }

  // (2) Lockfile / config sniffing (first match wins).
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (!hasPkgJson && (has("deno.lock") || has("deno.json") || has("deno.jsonc"))) {
    return "deno";
  }
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) {
    warn("yarn.lock found but Yarn is not supported; falling back to pnpm");
    return "pnpm";
  }
  if (has("package-lock.json")) return "npm";

  // (3) package.json present but no other signal → pnpm (artgraph default).
  if (hasPkgJson) return "pnpm";

  // (4) Nothing detectable.
  warn("Cannot detect package manager; record skipped");
  return null;
}

/**
 * Parse the corepack-style `packageManager` field (e.g. "pnpm@9.0.0") and return
 * the bare PM name. Returns null when the field is absent or unparseable.
 */
function readPackageManagerField(pkgJsonPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(pkgJsonPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as { packageManager?: unknown }).packageManager;
  if (typeof value !== "string") return null;
  const match = /^([a-z]+)@/.exec(value);
  return match ? match[1] : null;
}

/**
 * Build the exec command that runs the local `artgraph` binary under a given PM.
 * Mapping per contracts/package-manager.md §2 — keep in sync with the bash
 * Command mapping table (SC-003).
 */
export function buildExecCommand(pm: PackageManager, subcommand = ""): string {
  const prefix: Record<PackageManager, string> = {
    npm: "npx artgraph",
    pnpm: "pnpm exec artgraph",
    bun: "bunx artgraph",
    deno: "deno run -A npm:artgraph/cli",
  };
  const sub = subcommand.trim();
  return sub ? `${prefix[pm]} ${sub}` : prefix[pm];
}

/**
 * Build the command that installs artgraph as a dev dependency under a given PM.
 * Mapping per contracts/package-manager.md §3. Unused by spec 015 itself but
 * provided as a primitive for #109 / #110.
 */
export function buildInstallCommand(pm: PackageManager): string {
  const map: Record<PackageManager, string> = {
    npm: "npm install -D artgraph",
    pnpm: "pnpm add -D artgraph",
    bun: "bun add -d artgraph",
    deno: "deno add npm:artgraph",
  };
  return map[pm];
}

function warn(message: string): void {
  // Mirror the bash snippet, which writes warnings to stderr.
  console.error(`WARNING: ${message}`);
}
