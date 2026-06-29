import { readFileSync, statSync } from "node:fs";
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
  // Use isFile() (not existsSync) so a directory or symlink named like a
  // lockfile (e.g. `mkdir bun.lockb`) does not get mistaken for the real
  // lockfile. Mirrors `[ -f <name> ]` in the bash snippet.
  const hasFile = (name: string): boolean => {
    const stat = statSync(join(rootDir, name), { throwIfNoEntry: false });
    return stat?.isFile() ?? false;
  };
  const pkgJsonPath = join(rootDir, "package.json");
  const hasPkgJson = hasFile("package.json");

  // (1) Corepack-style "<pm>@<version>" field in package.json. Corepack itself
  // only ships npm/pnpm/yarn; artgraph extends the same shape to Bun.
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
  if (hasFile("bun.lockb") || hasFile("bun.lock")) return "bun";
  if (
    !hasPkgJson &&
    (hasFile("deno.lock") || hasFile("deno.json") || hasFile("deno.jsonc"))
  ) {
    return "deno";
  }
  if (hasFile("pnpm-lock.yaml")) return "pnpm";
  if (hasFile("yarn.lock")) {
    warn("yarn.lock found but Yarn is not supported; falling back to pnpm");
    return "pnpm";
  }
  if (hasFile("package-lock.json")) return "npm";

  // (3) package.json present but no other signal → pnpm (artgraph default).
  if (hasPkgJson) return "pnpm";

  // (4) Nothing detectable. Match the bash snippet's stderr prefix exactly
  // ("ERROR:") so SSOT scripts and the TS detector emit identical text.
  error("Cannot detect package manager; ask the user which to use");
  return null;
}

/**
 * Parse the Corepack-style `<pm>@<version>` `packageManager` field
 * (e.g. "pnpm@9.0.0") and return the bare PM name. Returns null when the field
 * is absent, the value lacks the required `@version` suffix (bare "npm" etc.),
 * or the JSON itself is unparseable. Strips a leading UTF-8 BOM before parsing
 * so the TS detector matches the bash snippet (`node -e ...`) on BOM-prefixed
 * package.json files (SC-007).
 */
function readPackageManagerField(pkgJsonPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(pkgJsonPath, "utf-8");
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
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
  const prefix = execPrefix(pm);
  const sub = subcommand.trim();
  return sub ? `${prefix} ${sub}` : prefix;
}

function execPrefix(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "npx artgraph";
    case "pnpm":
      return "pnpm exec artgraph";
    case "bun":
      return "bunx artgraph";
    case "deno":
      return "deno run -A npm:artgraph/cli";
    default:
      return assertNever(pm);
  }
}

/**
 * Build the command that installs artgraph as a dev dependency under a given PM.
 * Mapping per contracts/package-manager.md §3. Unused by spec 015 itself but
 * provided as a primitive for #109 / #110.
 */
export function buildInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "npm install -D artgraph";
    case "pnpm":
      return "pnpm add -D artgraph";
    case "bun":
      return "bun add -d artgraph";
    case "deno":
      return "deno add npm:artgraph";
    default:
      return assertNever(pm);
  }
}

/**
 * Exhaustiveness guard: when a new variant is added to the `PackageManager`
 * union, any `switch` that forgets to handle it fails `tsc` here instead of
 * silently returning `undefined` at runtime.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled PackageManager variant: ${String(value)}`);
}

function warn(message: string): void {
  // Mirror the bash snippet, which writes warnings to stderr.
  console.error(`WARNING: ${message}`);
}

function error(message: string): void {
  // Mirror the bash snippet's `ERROR: ...` prefix exactly (SC-007).
  console.error(`ERROR: ${message}`);
}
