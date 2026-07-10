// Helpers shared across two or more `src/commands/*` modules. Extracted
// verbatim from `src/cli.ts`'s `registerCommands` closure (issue #162) — no
// behavior change, only relocation so each command module can import just
// what it needs instead of everything living in one 2,000-line file.

import type { ArtgraphConfig, SymbolEntry, TestResultMap } from "../types.js";
import { parseAgentsList, AgentsParseError } from "../agents/parse-agents.js";
import { AGENT_IDS, type AgentId } from "../agents/descriptors.js";

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
