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
// issue #279 — statically imported, same as `cli.ts`'s own top-level catch
// (issue #263) already does unconditionally: this module's import cost is
// cheap (no native binding load at import time — see the doc comment on
// `OxcLoadError` in parsers/typescript.ts), and `cli.ts` already pays it on
// EVERY real CLI invocation regardless of which command runs, so importing
// it again here (this file is itself statically imported by every
// `commands/*.ts` module) adds no new cost.
import { OxcLoadError } from "../parsers/typescript.js";

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
 *
 * issue #336 (PR #336 meta-review) — `parseAgentsFlag` used to take no
 * `format` parameter and always print `e.message` bare to stderr, ignoring
 * `--format json` entirely (both call sites resolve their own `opts.format`
 * before this runs — see `init.ts` / `doctor.ts`). `AgentsParseError.message`
 * is already a complete, pre-formatted diagnostic (starts with `ERROR: `),
 * exactly like `OxcLoadError.message` — so it goes through the same
 * `printBareFatalMessage` a plain `printFatalCatchAll` would double-prefix
 * (`Error: ERROR: Unknown agent...`). Text mode stays byte-identical to the
 * pre-#336 behavior (bare message, no added prefix); json mode now wraps it
 * in the same `{"error": ...}` envelope every other fatal error here uses.
 */
export function parseAgentsFlag(raw: string, format?: string): AgentId[] {
  try {
    return parseAgentsList(raw);
  } catch (e) {
    if (e instanceof AgentsParseError) {
      printBareFatalMessage(format, e.message);
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

// issue #279 / issue #336 (PR #336 meta-review F1) — `OxcLoadError` (oxc-
// parser's native binding missing/broken, issue #263) is a specifically-
// anticipated, actionable environment failure. Before issue #279, the ONLY
// place that caught it was `cli.ts`'s top-level `program.parseAsync()` catch
// — a layer that has no idea what `--format` the just-parsed command
// requested, so it always printed plain text to stderr regardless of
// `--format json`.
//
// issue #279's original helper (`withOxcLoadErrorFatal`) only narrowed on
// `OxcLoadError` and rethrew everything else — which meant a call site whose
// wrapped region also covers `loadConfig()` (e.g. `trace.ts#loadTraceInputs`,
// `rename-executor.ts#loadScanContext`, the reference implementation) still
// let a malformed `.artgraph.json`'s plain `Error` (`config.ts`'s
// `Failed to parse ...`) escape uncaught to `cli.ts`'s format-blind
// top-level catch — a full raw Node stack trace with internal `dist/`/`src/`
// file paths, exactly like `OxcLoadError` before #279, just for a different
// (much more commonly hit) error type. `withFatalErrors` widens the catch:
// `OxcLoadError` still gets its own dedicated bare-message printer
// (`printOxcLoadError`), and now EVERY other `Error` gets the generic
// `{"error": ...}` / `Error: <msg>` envelope via `printFatalCatchAll`
// instead of rethrowing. Each command action that can reach
// `loadConfig()`/`scan()`/`buildGraph()` (directly, or via a helper like
// `plan-coverage/index.ts#runPlanCoverage` or `trace.ts#loadTraceInputs`)
// wraps that call (and, per the #336 fix, `loadConfig()` alongside it — see
// check/scan/impact/reconcile.ts) in this helper instead of wrapping its
// entire body — `format` is a normal command-local variable at every call
// site, so this runs at a layer that DOES know it, without a broader
// restructure. A `RenameValidationError` / `LockSchemaVersionError` /
// command-specific validation error thrown from INSIDE a `withFatalErrors`-
// wrapped call is caught here too (there is no more special-casing to
// rethrow it unwrapped) — its `.message` is exactly what the pre-#336
// dedicated catch for it would have printed, so this is not a behavior
// change for any error type that already had its own catch layered around
// `withOxcLoadErrorFatal`'s old call sites; it only closes the gap for
// errors that previously had NO catch at all. See docs/commands.md's "Fatal
// errors" section for the resulting stdout/stderr contract this implements.
export async function withFatalErrors<T>(
  format: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OxcLoadError) {
      printOxcLoadError(format, e);
      process.exit(1);
    }
    const msg = e instanceof Error ? e.message : String(e);
    printFatalCatchAll(format, msg);
    process.exit(1);
  }
}

// issue #279 — shared bare-message printer: json wraps in `{"error": ...}`,
// text prints the message with no added prefix. Used for errors whose
// `.message` is ALREADY a complete, self-formatted diagnostic (starts with
// its own `ERROR:`/similar lead-in, or is meant to stand alone) — as opposed
// to `printFatalCatchAll` below, which prefixes a bare exception message
// with `Error: ` in text mode. `OxcLoadError` (parsers/typescript.ts) and
// `AgentsParseError` (agents/parse-agents.ts, via `parseAgentsFlag` above)
// are both this shape.
export function printBareFatalMessage(format: string | undefined, msg: string): void {
  if (format === "json") {
    console.error(JSON.stringify({ error: msg }));
  } else {
    console.error(msg);
  }
}

// issue #279 — shared with `withFatalErrors` above AND with the handful of
// commands (`rename`, `plan-coverage`) that already had their own catch-all
// before issue #279 and just needed an extra `instanceof OxcLoadError`
// branch spliced in rather than a full call-site wrap. `OxcLoadError.message`
// is already a complete, formatted diagnostic (see parsers/typescript.ts),
// so this delegates to `printBareFatalMessage` — bare in text mode (no
// "Error:" prefix, matching `cli.ts`'s own pre-existing handling of this
// exact error), envelope in json mode.
export function printOxcLoadError(format: string | undefined, e: OxcLoadError): void {
  printBareFatalMessage(format, e.message);
}

// issue #279 — the generic `{"error": ...}` stderr envelope every fatal
// catch-all in this CLI converges on (`commands/rename.ts`'s original
// `fail()` is the reference implementation this was extracted from
// verbatim): text mode keeps the pre-existing plain `Error: <msg>` line,
// json mode gets a parseable envelope instead of nothing/plain-text noise.
// Both write to STDERR — this repo's existing convention (verified against
// `rename.ts`'s `fail()`) is that stdout carries ONLY a successful result
// payload; every diagnostic, `--format json` fatal errors included, goes to
// stderr. See docs/commands.md's "Fatal errors" section.
export function printFatalCatchAll(format: string | undefined, msg: string): void {
  if (format === "json") {
    console.error(JSON.stringify({ error: msg }));
  } else {
    console.error(`Error: ${msg}`);
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
