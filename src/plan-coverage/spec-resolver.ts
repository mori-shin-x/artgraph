// spec 014 — `artgraph plan-coverage --spec` resolver.
//
// Contract: specs/014-reinvent-impact-cli/contracts/cli-flags.md
// (Spec Kit canonical lookup) and FR-014.
//
// Lookup precedence:
//   1. explicit `--spec` flag value
//   2. SPECIFY_FEATURE_DIRECTORY env var (Spec Kit canonical)
//   3. .specify/feature.json#feature_directory (Spec Kit canonical, matches
//      github/spec-kit:scripts/bash/common.sh:get_feature_paths())
//   4. error — guide the user toward `--spec .specify/specs/<name>/` or
//      `--spec .kiro/specs/<name>/` (Kiro has no canonical current-spec
//      indicator, hence the explicit flag is required)
//
// Relative paths at each tier are resolved against `repoRoot`. Empty-string
// env var values are treated as unset (CI shells sometimes export them).
// Malformed `.specify/feature.json` falls through to the error branch
// instead of crashing — a stale file shouldn't take down the CLI.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

export interface ResolveSpecDirOptions {
  /** Value passed on the CLI as `--spec <dir>`, if any. */
  explicitFlag?: string;
  /** Environment dictionary, typically `process.env`. */
  env: Record<string, string | undefined>;
  /** Absolute repo root used to resolve any relative path tier. */
  repoRoot: string;
}

export type ResolveSpecDirResult = { dir: string } | { error: string };

const FALLBACK_ERROR = [
  "error: cannot resolve spec directory.",
  "either set SPECIFY_FEATURE_DIRECTORY, or run from a Spec Kit project,",
  "or pass --spec explicitly:",
  "  artgraph plan-coverage --spec .specify/specs/<name>/",
  "  artgraph plan-coverage --spec .kiro/specs/<name>/        # Kiro",
].join("\n");

function toAbsolute(path: string, repoRoot: string): string {
  return isAbsolute(path) ? path : resolvePath(repoRoot, path);
}

function tryReadFeatureJson(repoRoot: string): string | undefined {
  const featureJsonPath = resolvePath(repoRoot, ".specify/feature.json");
  if (!existsSync(featureJsonPath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(featureJsonPath, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — fall through to the error branch. Better to surface
    // a clear "pass --spec" message than to crash with a parse error.
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("feature_directory" in parsed)
  ) {
    return undefined;
  }
  const value = (parsed as { feature_directory: unknown }).feature_directory;
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

export function resolveSpecDir(options: ResolveSpecDirOptions): ResolveSpecDirResult {
  const { explicitFlag, env, repoRoot } = options;

  // Tier 1: explicit --spec.
  if (explicitFlag !== undefined && explicitFlag !== "") {
    return { dir: toAbsolute(explicitFlag, repoRoot) };
  }

  // Tier 2: SPECIFY_FEATURE_DIRECTORY env var.
  const envValue = env.SPECIFY_FEATURE_DIRECTORY;
  if (envValue !== undefined && envValue !== "") {
    return { dir: toAbsolute(envValue, repoRoot) };
  }

  // Tier 3: .specify/feature.json#feature_directory.
  const fromFile = tryReadFeatureJson(repoRoot);
  if (fromFile !== undefined) {
    return { dir: toAbsolute(fromFile, repoRoot) };
  }

  // Tier 4: error.
  return { error: FALLBACK_ERROR };
}
