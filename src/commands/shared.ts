// Helpers shared across two or more `src/commands/*` modules. Extracted
// verbatim from `src/cli.ts`'s `registerCommands` closure (issue #162) — no
// behavior change, only relocation so each command module can import just
// what it needs instead of everything living in one 2,000-line file.

import { InvalidArgumentError } from "commander";
import type { ArtgraphConfig, SymbolEntry, TestResultMap } from "../types.js";
import { parseAgentsList, AgentsParseError } from "../agents/parse-agents.js";
import { AGENT_IDS, type AgentId } from "../agents/descriptors.js";
import type { BuildWarning } from "../graph/builder.js";
import { printWarnings } from "./presenters/warnings.js";

// issue #306 (PR #304 review F6/F7) — commander's required option-args are
// greedy: a value-taking `--flag` immediately followed by ANOTHER flag
// consumes that flag as its value (commander Readme, "Options with an
// expected option-argument are greedy"). On a gate-relevant command the
// swallowed flag is typically `--gate` itself, so a CI variable expanding to
// nothing (`--ignore $CSV --gate` → `--ignore --gate`) silently DISARMS the
// gate and the run exits 0 — fail-open. This parse-time guard mirrors
// `check --base`'s bespoke validator (spec 023, contracts/cli-check-base.md
// §1): a value may never start with `-`. `allowEmpty` distinguishes flags
// whose empty value is legal-by-design (`--ignore ""`, T178-4) from flags
// where an empty value can only be an unset variable (paths / dirs).
export function nonOptionValue(
  flag: string,
  { allowEmpty = false, hint }: { allowEmpty?: boolean; hint?: string } = {},
): (value: string) => string {
  return (value: string): string => {
    if (!allowEmpty && value === "") {
      throw new InvalidArgumentError(`${flag} value must not be empty (is a CI variable unset?).`);
    }
    if (value.startsWith("-")) {
      throw new InvalidArgumentError(
        `${flag} value must not start with "-" (got "${value}" — a missing value swallows the next flag${hint ? `; ${hint}` : ""}).`,
      );
    }
    return value;
  };
}

// The escape hatch for a path that genuinely starts with `-` (mirrors the
// `check --base` guard documenting its `refs/...` spelling — review F3).
export const DASH_PATH_HINT =
  'prefix a relative path with "./" for a name that really starts with "-"';

// spec 016 (R-003) — direct CLI / --diff inputs come in as raw
// strings (file paths or `path:symbol` declarations). lift each into the
// `SymbolEntry` shape expected by `resolveStartIds`. Keep this regex in sync
// with `src/parsers/sdd-files.ts:PATH_SYMBOL_RE` so direct CLI inputs accept
// the same syntax as the parser does for `Files:` sections.
export const CLI_PATH_SYMBOL_RE = /^([^:\s]+\.[\w]+):([^\s,()]+)$/;

/**
 * spec 016 (T027, R-003, contracts/cli-flags.md §1.1) — lift bare string
 * targets to `SymbolEntry[]`. Each string matched against `CLI_PATH_SYMBOL_RE`:
 *  - match  → `{ path, symbol, line: 1 }`
 *  - no match → `{ path, line: 1 }` (symbol undefined, file-unit semantics)
 *
 * `line` is 1 because direct CLI input has no source line; the value is only
 * used for diagnostic display when a symbol miss is reported.
 */
export function pathsToEntries(paths: string[]): SymbolEntry[] {
  return paths.map((p) => {
    const m = CLI_PATH_SYMBOL_RE.exec(p);
    if (m) {
      return { path: m[1]!, symbol: m[2]!, line: 1 };
    }
    return { path: p, line: 1 };
  });
}

// Resolve test-result paths from the `.artgraph.json` `testResultPaths`
// field, then load them. Returns undefined when unset so callers fall back
// to legacy (verifies-edge-only) coverage. Shared by `scan` and `check`.
export async function resolveTestResults(
  config: ArtgraphConfig,
  rootDir: string,
): Promise<TestResultMap | undefined> {
  const paths = config.testResultPaths;
  if (paths && paths.length > 0) {
    const { loadTestResults } = await import("../test-results.js");
    return loadTestResults(paths, rootDir);
  }
  return undefined;
}

// Lazily load the integrate surface and wire up the built-in providers
// (speckit / kiro) exactly once per process. `registerProvider` throws on a
// duplicate id, and `runCli` builds a fresh commander tree per call within
// one process, so the once-guard preserves the old "register at module load"
// semantics without paying the integrate/yaml import on every invocation.
let builtinProvidersRegistered = false;
export async function loadIntegrate(): Promise<typeof import("../integrate/index.js")> {
  const mod = await import("../integrate/index.js");
  if (!builtinProvidersRegistered) {
    mod.registerBuiltinProviders();
    builtinProvidersRegistered = true;
  }
  return mod;
}

/**
 * E-adj-A5: `init` and `doctor` both need to parse `--agents=<csv>` and both
 * need the same "print `AgentsParseError.message` verbatim, exit 1"
 * wrapping around `parseAgentsList`. The two call sites used to duplicate
 * this try/catch byte-for-byte; centralizing it here means a future change
 * to the error-to-exit behavior only has to land once.
 *
 * Both `init` and `doctor` route --agents parsing through this helper.
 */
export function parseAgentsFlag(raw: string): AgentId[] {
  try {
    return parseAgentsList(raw);
  } catch (e) {
    if (e instanceof AgentsParseError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

// issue #265 — `scan`/`init`/`check` were the only commands wiring
// `printWarnings` to their `buildGraph()`-derived `BuildWarning[]`;
// `impact`/`trace`/`reconcile`/`rename` all build the same graph (directly
// or via `scan()`/`rename-executor.ts`) but silently discarded its warnings
// — a `pathological-bracket-nesting` or `class-member-collision` warning
// was invisible through any of those four commands. This helper centralizes
// the "when do we print" policy so a FUTURE command that builds the graph
// only has to call it, rather than re-deriving the format-aware rule itself
// (or forgetting to).
//
// Mirrors the scan/init/check convention exactly: text mode prints via
// `printWarnings` (stderr only, never stdout — see warnings.ts). In
// `--format json` mode this is a no-op: JSON-emitting commands fold
// `warnings` into their own structured payload instead (as scan/init/check
// already do), so the same information is never shown twice. Commands with
// no `--format json` mode at all (e.g. `reconcile`) simply call this with
// `format` left `undefined`, which also prints.
export function reportGraphWarnings(warnings: BuildWarning[], format?: string): void {
  if (format === "json") return;
  printWarnings(warnings);
}

// spec 020 (contracts/cli-surface.md §2 / §5, FR-018) — verbatim error UX
// emitted (and exit 1) when a trace-dependent command finds ZERO shard
// files. Shared by `artgraph trace report` (T011) and, later, `artgraph
// impact --diff --tests` (T022, FR-018 explicitly requires "同文言") — one
// wording, so the two commands never drift on how they point a user at
// runner setup. Kept in sync with contracts/cli-surface.md §1's `withTrace`
// example.
export const TRACE_NO_SHARDS_GUIDANCE = [
  "ERROR: no trace shards found.",
  "",
  "artgraph looked for trace artifacts matching `trace.artifacts`",
  "(default: .artgraph/trace/*.jsonl) and found none.",
  "",
  "To capture trace evidence, add the artgraph vitest runner to your",
  "vitest config and re-run your test suite:",
  "",
  '  import { withTrace } from "artgraph/vitest/config";',
  "  export default defineConfig(withTrace({ test: { /* ...your config... */ } }));",
  "",
  "then run `vitest run` (or your usual test command) to produce",
  "`.artgraph/trace/*.jsonl`, and re-run this command.",
].join("\n");

// spec 013 (FR-002 / SC-006) — verbatim error UX emitted to stderr when
// `--agents=<list>` is missing on a path that runs the Skills or
// agent-context distribution stage. The 3-option enumeration is part of
// the spec contract and is asserted as plain text by the CLI error tests
// (T013 in Phase 3); changes here must be mirrored in contracts/cli-flags.md.
export const AGENTS_REQUIRED_ERROR = [
  "ERROR: --agents=<list> is required when Skills or agent-context distribution runs.",
  "",
  // E-adj-A9 / BND-7: derive from AGENT_IDS instead of a second hardcoded
  // literal (descriptors.ts is the single source of truth).
  `Supported values: ${[...AGENT_IDS].sort().join(", ")}`,
  "",
  "To resolve, choose one:",
  "  1. Specify target agents:",
  "       artgraph init --agents=<list>          (e.g. --agents=claude,codex)",
  "  2. Skip Skills and agent-context distribution:",
  "       artgraph init --no-skills --no-agent-context",
  "  3. Skip every extra setup stage:",
  "       artgraph init --minimal",
].join("\n");
