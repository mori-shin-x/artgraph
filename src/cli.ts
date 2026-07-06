#!/usr/bin/env node

import { Command, CommanderError, Option } from "commander";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Command implementations are imported lazily (`await import(...)`) inside
// each action handler instead of statically here. The scan/parse stack pulls
// in the native oxc-parser binding and the remark toolchain, which every
// invocation — including `--version` and `--help` — used to pay up front. Only commander, node
// builtins, and the two data-only modules needed to render help text
// (agents/descriptors, agents/parse-agents) stay static. Types are erased at
// compile time, so `import type` is free.
import type { SymbolEntry } from "./types.js";

// spec 016 (R-003) — direct CLI / --diff inputs come in as raw
// strings (file paths or `path:symbol` declarations). lift each into the
// `SymbolEntry` shape expected by `resolveStartIds`. Keep this regex in sync
// with `src/parsers/sdd-files.ts:PATH_SYMBOL_RE` so direct CLI inputs accept
// the same syntax as the parser does for `Files:` sections.
const CLI_PATH_SYMBOL_RE = /^([^:\s]+\.[\w]+):([^\s,()]+)$/;

/**
 * spec 016 (T027, R-003, contracts/cli-flags.md §1.1) — lift bare string
 * targets to `SymbolEntry[]`. Each string matched against `CLI_PATH_SYMBOL_RE`:
 *  - match  → `{ path, symbol, line: 1 }`
 *  - no match → `{ path, line: 1 }` (symbol undefined, file-unit semantics)
 *
 * `line` is 1 because direct CLI input has no source line; the value is only
 * used for diagnostic display when a symbol miss is reported.
 */
function pathsToEntries(paths: string[]): SymbolEntry[] {
  return paths.map((p) => {
    const m = CLI_PATH_SYMBOL_RE.exec(p);
    if (m) {
      return { path: m[1]!, symbol: m[2]!, line: 1 };
    }
    return { path: p, line: 1 };
  });
}
import type { ArtgraphConfig, TestResultMap } from "./types.js";
import type { BuildWarning } from "./graph/builder.js";
import type { RenameResult } from "./rename-executor.js";
import type { IntegrateResult, IntegrationProviderId } from "./types.js";
import { parseAgentsList, AgentsParseError } from "./agents/parse-agents.js";
import { AGENT_IDS, type AgentId } from "./agents/descriptors.js";

// Lazily load the integrate surface and wire up the built-in providers
// (speckit / kiro) exactly once per process. `registerProvider` throws on a
// duplicate id, and `runCli` builds a fresh commander tree per call within
// one process, so the once-guard preserves the old "register at module load"
// semantics without paying the integrate/yaml import on every invocation.
let builtinProvidersRegistered = false;
async function loadIntegrate(): Promise<typeof import("./integrate/index.js")> {
  const mod = await import("./integrate/index.js");
  if (!builtinProvidersRegistered) {
    mod.registerBuiltinProviders();
    builtinProvidersRegistered = true;
  }
  return mod;
}

function buildProgram(): Command {
  const program = new Command();
  program.name("artgraph").description("Typed artifact graph for TS/JS").version("0.1.0");
  registerCommands(program);
  return program;
}

function registerCommands(program: Command): void {
  // Resolve test-result paths from the `.artgraph.json` `testResultPaths`
  // field, then load them. Returns undefined when unset so callers fall back
  // to legacy (verifies-edge-only) coverage. Shared by `scan` and `check`.
  async function resolveTestResults(
    config: ArtgraphConfig,
    rootDir: string,
  ): Promise<TestResultMap | undefined> {
    const paths = config.testResultPaths;
    if (paths && paths.length > 0) {
      const { loadTestResults } = await import("./test-results.js");
      return loadTestResults(paths, rootDir);
    }
    return undefined;
  }

  program
    .command("init")
    .description(
      "Initialize artgraph for this project (default: config + scan + Skills + auto-integrate detected SDD tools + Stop hook + AGENTS.md / wrapper injection). Use --minimal for bare config only.",
    )
    .option(
      "--force",
      "Overwrite existing .artgraph.json, distributed Skill files, and integration files. Refuses symlinks even with --force.",
    )
    .option("--minimal", "Bare config only — opt out of every extra setup stage")
    // Stage opt-outs (in default mode)
    .option("--no-scan", "Skip initial scan + reconcile")
    .option(
      "--no-skills",
      "Skip Skills distribution to the selected --agents (default mode only — already off under --minimal)",
    )
    .option("--no-integrate", "Skip SDD-tool auto-integration (default mode only)")
    .option("--no-hooks", "Skip Stop hook installation (default mode only)")
    .option("--no-agent-context", "Skip AGENTS.md / wrapper injection (default mode only)")
    // spec 013 (FR-001 / FR-002) — Tier 1 agent ids the user wants to target.
    // Required when Skills or agent-context distribution runs; rejected
    // (with a "Did you mean ...?" hint) for unknown / uppercase / empty /
    // duplicate values per contracts/cli-flags.md.
    .option(
      "--agents <list>",
      // E-adj-A9 / BND-7: derive the id list from AGENT_IDS (descriptors.ts is
      // the single source of truth) instead of hardcoding it a second time —
      // a 6th agent id landing in descriptors.ts would otherwise leave this
      // help text silently stale.
      `Comma-separated Tier 1 agent ids to target (${[...AGENT_IDS].sort().join(", ")}). Required for Skills / agent-context distribution.`,
    )
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { runInit } = await import("./init.js");
      const { DistributionError } = await import("./agents/distribute.js");

      // spec 013 (T005 / T006) — --agents=<csv> parsing + orthogonality.
      //
      // Parse the raw flag value first so a malformed list (uppercase,
      // duplicate, unknown id) fails with the canonical "Did you mean ...?"
      // hint before we even look at the other gates. The parser throws
      // `AgentsParseError` with the full stderr-ready message; we surface it
      // verbatim and exit 1.
      let parsedAgents: AgentId[] | undefined;
      if (opts.agents !== undefined) {
        parsedAgents = parseAgentsFlag(String(opts.agents));
      }

      // @impl 013-cross-agent-extensions/FR-013
      // Orthogonality rules (FR-013, contracts/cli-flags.md):
      //   - --minimal:                  every cross-agent stage off, --agents ignored (warn if given)
      //   - --no-skills --no-agent-context: both off, --agents ignored (warn if given)
      //   - else:                       --agents required, error with 3-option UX if missing
      const skipDueToMinimal = opts.minimal === true;
      const skipDueToBothStagesOff =
        !skipDueToMinimal && opts.skills === false && opts.agentContext === false;

      if (skipDueToMinimal && parsedAgents !== undefined) {
        console.error("WARNING: --minimal overrides --agents (all cross-agent stages disabled)");
        parsedAgents = undefined;
      } else if (skipDueToBothStagesOff && parsedAgents !== undefined) {
        console.error(
          "WARNING: --no-skills --no-agent-context disables every cross-agent stage; --agents value is ignored",
        );
        parsedAgents = undefined;
      }

      // @impl 013-cross-agent-extensions/FR-002
      const agentsRequired = !(skipDueToMinimal || skipDueToBothStagesOff);
      if (agentsRequired && parsedAgents === undefined) {
        console.error(AGENTS_REQUIRED_ERROR);
        process.exit(1);
      }

      try {
        const result = runInit(rootDir, {
          force: opts.force,
          minimal: opts.minimal,
          // commander's --no-X negation sets opts.X = false when the flag is
          // passed, true otherwise. Convert to the noX form runInit expects.
          noScan: opts.scan === false,
          noSkills: opts.skills === false,
          noIntegrate: opts.integrate === false,
          noHooks: opts.hooks === false,
          noAgentContext: opts.agentContext === false,
          agents: parsedAgents,
        });

        if (opts.format === "json") {
          // A5 (issue #122 follow-up): the "Zero-tag ready" / classic closing
          // hint below is text-path-only UX copy, not a machine-readable
          // signal — this JSON branch intentionally does not add an
          // `isBrownfieldZeroTag`-equivalent boolean. JSON consumers already
          // get the raw `scanSummary` (including `reqCount`, `taskCount`,
          // `hasDanglingCodeTag`) and are expected to derive their own
          // brownfield/tag-zero classification from it if they need one.
          console.log(
            JSON.stringify({
              configPath: result.configPath,
              config: result.config,
              sddTools: result.sddTools,
              scanSummary: result.scanSummary ?? null,
              warnings: result.warnings,
              lockPath: result.lockPath ?? null,
              // H6: split SKILL.md installs from shared fragments / references
              // so the JSON consumer can count Skills accurately.
              skillsInstalled: result.skillsInstalled
                ? {
                    skills: result.skillsInstalled.filter(
                      (p) => p.endsWith("/SKILL.md") || p.endsWith("\\SKILL.md"),
                    ),
                    fragments: result.skillsInstalled.filter(
                      (p) => !p.endsWith("/SKILL.md") && !p.endsWith("\\SKILL.md"),
                    ),
                  }
                : null,
              integrationResults: result.integrationResults ?? null,
              integrationWarnings: result.integrationWarnings ?? null,
              hooksInstall: result.hooksInstall ?? null,
            }),
          );
        } else {
          for (const tool of result.sddTools) {
            console.log(`${tool.name} detected (${tool.marker}/)`);
          }

          if (result.scanSummary) {
            console.log(
              `\nNodes: ${result.scanSummary.nodeCount}  Edges: ${result.scanSummary.edgeCount}`,
            );
            console.log(
              `  req: ${result.scanSummary.reqCount}  doc: ${result.scanSummary.docCount}  file: ${result.scanSummary.fileCount}  test: ${result.scanSummary.testCount}`,
            );
            printWarnings(result.warnings);
            console.log(`\nCreated .artgraph.json`);
            console.log(`Created ${result.config.lockFile}`);
          } else {
            console.log(`Created .artgraph.json (scan skipped)`);
            console.log(`\nTo scan later, run: artgraph scan && artgraph reconcile`);
          }
          if (result.skillsInstalled && result.skillsInstalled.length > 0) {
            // H6: SKILL.md files are the user-discoverable Skills; the rest
            // are shared fragments and references that travel with them.
            // Reporting the combined count as "skills" was misleading.
            const skills = result.skillsInstalled.filter(
              (p) => p.endsWith("/SKILL.md") || p.endsWith("\\SKILL.md"),
            );
            const fragments = result.skillsInstalled.filter((p) => !skills.includes(p));
            console.log(`\nInstalled ${skills.length} Claude Code skills:`);
            for (const path of skills) console.log(`  ${path}`);
            if (fragments.length > 0) {
              console.log(`\nInstalled ${fragments.length} shared fragments / references:`);
              for (const path of fragments) console.log(`  ${path}`);
            }
          }

          // ---- one-shot integration output (FR-022/023): per-tool sections ----
          if (result.integrationResults && result.integrationResults.length > 0) {
            for (const r of result.integrationResults) {
              console.log("");
              console.log(`=== Integration: ${r.providerId} ===`);
              printIntegrateText(r, r.providerId);
            }
          }
          if (result.integrationWarnings && result.integrationWarnings.length > 0) {
            for (const w of result.integrationWarnings) {
              // Warnings already carry their own "WARNING:" prefix when needed.
              console.error(w);
            }
          }

          // Closing hints + integration Tips (FR-012/013). Tips appear *after*
          // the standard next-step lines so the user sees the actionable
          // discovery cue last.
          //
          // Issue #122: tag-zero brownfield onboarding. When the scan found TS
          // files but zero req/task nodes and no dangling @impl code tag, the
          // classic `check` message ("verify traceability") is misleading —
          // there's nothing to trace yet. Swap to a message that tells the user
          // impact analysis is ALREADY working off their imports and that
          // tagging is optional / incremental.
          //
          // Review follow-ups tightened the original `fileCount > 0 &&
          // reqCount === 0 && docCount === 0` heuristic:
          //   A1 — `fileCount` alone missed repos where `generateConfig`'s
          //        narrower `include` (no `src/`) left `fileCount === 0` while
          //        `testPatterns` still matched files (`testCount > 0`); the
          //        classic message's `impact --diff` would fail there too, so
          //        either count is treated as "there's something to scan".
          //   A2 — `docCount === 0` had nothing to do with "tagged": a plain
          //        `docs/` folder (README-style, no req syntax) is common and
          //        orthogonal to spec/@impl presence. Dropped.
          //   A4 — `taskCount` wasn't threaded into `ScanSummary` at all, so a
          //        `docGraph.autoNodes:false` repo whose tasks.md was already
          //        decomposed into task nodes still looked tag-zero.
          //   A3 — `hasDanglingCodeTag` catches an existing `@impl`/`@verifies`
          //        code tag with no matching spec node; "no @impl claims
          //        detected yet" would otherwise be factually wrong.
          if (result.scanSummary) {
            const summary = result.scanSummary;
            const hasFileSignal = summary.fileCount > 0 || summary.testCount > 0;
            const isZeroTagShape =
              hasFileSignal && summary.reqCount === 0 && summary.taskCount === 0;
            const isBrownfieldZeroTag = isZeroTagShape && !summary.hasDanglingCodeTag;

            if (isBrownfieldZeroTag) {
              console.log(`\nZero-tag ready: no specs or @impl claims detected yet.`);
              console.log(`Impact analysis works right now from your TS imports — try:`);
              console.log(`  artgraph impact --diff`);
              console.log(`Tags are optional; add them incrementally as your specs grow.`);
            } else if (isZeroTagShape && summary.hasDanglingCodeTag) {
              // A3: soften rather than suppress entirely — there IS @impl
              // signal in the code, it just doesn't resolve to a spec yet.
              console.log(`\n@impl tags found, but no matching specs yet.`);
              console.log(`Impact analysis works right now from your TS imports — try:`);
              console.log(`  artgraph impact --diff`);
              console.log(
                `Add the referenced specs so "artgraph check" can verify those @impl claims.`,
              );
            } else {
              console.log(`\nRun "artgraph check" to verify traceability.`);
              console.log(`Run "artgraph impact --diff" to see impact of your changes.`);
            }
          }

          // Stop hook install result (issue #109). Structured data comes from
          // `runInit`/`installHooks`; formatting is fully owned here so init.ts
          // stays print-free.
          if (result.hooksInstall) {
            switch (result.hooksInstall.action) {
              case "created":
                console.log("\nCreated .claude/settings.json with artgraph Stop hook");
                break;
              case "merged-b":
                console.log("\nAdded artgraph Stop hook to existing .claude/settings.json");
                break;
              case "merged-c":
                console.log("\nAdded artgraph Stop hook (other hooks preserved)");
                break;
              case "conflict":
                // A2: `.artgraph.json` has already been (re-)written by the
                // time we hit this branch, so a bare re-run of `artgraph init`
                // now trips the "already exists" guard. Point the user at
                // `--force` (with `--no-hooks` as the escape hatch) so they
                // know how to complete setup after resolving the Stop
                // conflict — that guidance was missing.
                console.error(
                  `\n[WARN] .claude/settings.json already has a Stop hook configured.\nartgraph did NOT modify this file to avoid clobbering your setup.\n\nTo add artgraph's gate, manually merge the following into hooks.Stop:\n\n  {\n    "hooks": [\n      { "type": "command", "command": "${result.hooksInstall.reason}" }\n    ]\n  }\n\n(artgraph's config and Skills were installed successfully; only the Stop hook was skipped.)\n\nAfter you have merged the snippet above, re-run \`artgraph init --force\` to\ncomplete setup (or run with \`--no-hooks\` if you prefer to keep the current\nStop hook and skip artgraph's gate).\n`,
                );
                break;
              case "invalid-json":
                console.error(
                  `\nERROR: .claude/settings.json is not valid JSON: ${result.hooksInstall.reason}. Not modifying.`,
                );
                break;
              case "io-error":
                console.error(`\nERROR: Stop hook install failed: ${result.hooksInstall.reason}`);
                break;
              case "skipped-no-pm":
                console.error(
                  "\nWARNING: Cannot detect package manager; skipping Stop hook install (config saved to .artgraph.json).",
                );
                break;
              default: {
                // E3: exhaustiveness guard — a new `hooksInstall.action`
                // variant will fail `tsc` here instead of silently skipping
                // the CLI-level formatting. Mirrors `printWarnings`.
                const _exhaustive: never = result.hooksInstall.action;
                void _exhaustive;
              }
            }
          }

          await printIntegrationTips(rootDir);
        }

        // H1: any integration that failed should surface as a non-zero exit
        // so CI / wrapper scripts catch it. We still emit the per-tool
        // sections above so the user has the full picture before exit.
        if (result.integrationFailureCount && result.integrationFailureCount > 0) {
          process.exitCode = 1;
        }
        if (result.hooksInstall?.failure) {
          process.exitCode = 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        // B6: `DistributionError.partiallyWritten` lists paths whose rollback
        // step itself failed (e.g. Windows AV / IDE holding a file open, or a
        // cross-agent survivor whose unlink hit EACCES). Silently dropping
        // these — as the previous catch did — left the user with no idea
        // which paths still needed manual cleanup. Surfacing them here means
        // the "manual cleanup required" hint arrives together with the error
        // that necessitates it.
        if (e instanceof DistributionError && e.partiallyWritten && e.partiallyWritten.length > 0) {
          console.error("");
          console.error("Partial writes could not be rolled back. Manual cleanup required:");
          for (const p of e.partiallyWritten) console.error(`  ${p}`);
        }
        process.exit(1);
      }
    });

  /**
   * E-adj-A5: `init` and `doctor` both need to parse `--agents=<csv>` and both
   * need the same "print `AgentsParseError.message` verbatim, exit 1"
   * wrapping around `parseAgentsList`. The two call sites used to duplicate
   * this try/catch byte-for-byte; centralizing it here means a future change
   * to the error-to-exit behavior only has to land once.
   *
   * Both `init` and `doctor` route --agents parsing through this helper.
   */
  function parseAgentsFlag(raw: string): AgentId[] {
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

  /**
   * Emit per-provider "Tip:" lines for any registered integration that is
   * detected but not yet installed (FR-012/013). Silent when nothing is
   * pending so a fully-integrated repo doesn't see stale hints.
   */
  async function printIntegrationTips(rootDir: string): Promise<void> {
    const { getProviderStatuses } = await loadIntegrate();
    const statuses = getProviderStatuses(rootDir);
    for (const s of statuses) {
      if (!s.detected || s.installed) continue;
      if (s.providerId === "speckit") {
        console.log(
          `\nTip: Spec Kit detected. Run "artgraph integrate speckit" to wire artgraph into the SDD workflow.`,
        );
      } else if (s.providerId === "kiro") {
        console.log(
          `\nTip: Kiro detected. Run "artgraph integrate kiro" to add a steering file for the agent.`,
        );
      } else {
        console.log(
          `\nTip: ${s.displayName} detected. Run "artgraph integrate ${s.providerId}" to integrate.`,
        );
      }
    }
  }

  program
    .command("scan")
    .description("Build the artifact graph and show summary (JSON output includes the full graph)")
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("./config.js");
      const { scan } = await import("./scan.js");
      const config = loadConfig(rootDir);
      const result = scan(rootDir, config);

      const testResults = await resolveTestResults(config, rootDir);
      let testResultStats:
        | { totalTests: number; passedTests: number; failedTests: number }
        | undefined;
      if (testResults) {
        let totalTests = 0;
        let passedTests = 0;
        let failedTests = 0;
        for (const records of testResults.values()) {
          for (const r of records) {
            totalTests++;
            if (r.passed) passedTests++;
            else failedTests++;
          }
        }
        testResultStats = { totalTests, passedTests, failedTests };
      }

      if (opts.format === "json") {
        // Full graph payload (nodes / edges) rides along with the count
        // summary — `scan --format json` absorbed the old `graph` command.
        const { graphToJSON } = await import("./graph/format.js");
        const { nodes, edges } = graphToJSON(result.graph);
        const output: Record<string, unknown> = {
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          reqCount: result.reqCount,
          docCount: result.docCount,
          fileCount: result.fileCount,
          symbolCount: result.symbolCount,
          testCount: result.testCount,
          taskCount: result.taskCount,
          nodes,
          edges,
          warnings: result.warnings,
        };
        if (testResultStats) {
          output.testResultStats = testResultStats;
        }
        console.log(JSON.stringify(output));
      } else {
        console.log(`Nodes: ${result.nodeCount}  Edges: ${result.edgeCount}`);
        const parts = [
          `req: ${result.reqCount}`,
          `doc: ${result.docCount}`,
          `file: ${result.fileCount}`,
        ];
        if (result.symbolCount > 0) parts.push(`symbol: ${result.symbolCount}`);
        parts.push(`test: ${result.testCount}`);
        if (result.taskCount > 0) parts.push(`task: ${result.taskCount}`);
        console.log(`  ${parts.join("  ")}`);
        if (testResultStats) {
          console.log(
            `\nTest Results: total=${testResultStats.totalTests} passed=${testResultStats.passedTests} failed=${testResultStats.failedTests}`,
          );
        }
        printWarnings(result.warnings);
      }
    });

  // spec 013 (FR-002 / SC-006) — verbatim error UX emitted to stderr when
  // `--agents=<list>` is missing on a path that runs the Skills or
  // agent-context distribution stage. The 3-option enumeration is part of
  // the spec contract and is asserted as plain text by the CLI error tests
  // (T013 in Phase 3); changes here must be mirrored in contracts/cli-flags.md.
  const AGENTS_REQUIRED_ERROR = [
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

  // spec 014 (FR-001 / FR-003): REQ-ID inputs are no longer accepted here.
  // The four supported start sources are listed in this error so the user is
  // pushed onto the right tool for their actual intent. Kept as a const at
  // module scope so the wording stays in sync with the contract file and the
  // CLI tests can assert against a single canonical string.
  const IMPACT_REQ_ID_REJECTION = [
    "error: REQ-ID inputs are not accepted by `artgraph impact`.",
    "use one of the following start sources:",
    "  artgraph impact <file>...          # explicit file paths",
    "  artgraph impact --diff             # use git diff",
    "for tasks.md / plan.md analysis, use `artgraph plan-coverage`.",
  ].join("\n");

  // `doc:` prefix is also rejected (FR-001 / FR-002). Surface the same
  // start sources so the user has a complete menu — the underlying mental
  // model is identical: `impact` is now file-only.
  const IMPACT_DOC_PREFIX_REJECTION = [
    "error: `doc:` prefix inputs are not accepted by `artgraph impact`.",
    "use one of the following start sources:",
    "  artgraph impact <file>...          # explicit file paths",
    "  artgraph impact --diff             # use git diff",
    "for tasks.md / plan.md analysis, use `artgraph plan-coverage`.",
  ].join("\n");

  // spec 014 (UX-1): Broaden REQ-ID input detection so the navigational error
  // fires for every REQ-ID shape the artgraph ecosystem documents (README §
  // "valid REQ-ID grammar"). Without this widening, Kiro `Requirement-3` and
  // scoped `auth/FR-2` inputs slip past the early reject and hit the generic
  // "No matching nodes found" path with no migration hint.
  //
  // Matches:
  //   - REQ-001 / FR-032 / AUTH-001  (all-uppercase prefix + numeric tail)
  //   - Requirement-3                (Pascal-case Kiro-style prefix)
  //   - auth/FR-2 / auth-2fa/REQ-1   (scoped: <scope>/<base>)
  //   - REQ-1.2 / Requirement-1.1    (dotted numeric tail for hierarchical IDs)
  //
  // We deliberately *under*-match: only inputs that look like a REQ-ID get
  // routed to the 4-path navigational error; everything else (file path,
  // non-conforming string) continues to the file-resolution path so the
  // existing "No matching nodes found" message still fires.
  const REQ_ID_INPUT_RE = /^(?:[A-Za-z][\w-]*\/)?[A-Z][A-Za-z]*-\d+(?:\.\d+)*$/;

  program
    .command("impact")
    .description(
      "Show forward impact from file paths or symbol entries (spec 016: file or `path:symbol`)",
    )
    .argument(
      "[targets...]",
      "File paths or `path:symbol` entries — REQ-IDs and `doc:` prefix are rejected",
    )
    .option("--diff", "Use git diff to detect changed files")
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (targets: string[], opts) => {
      const rootDir = process.cwd();

      // spec 016 T026 / contracts/cli-flags.md §2 — validation order:
      //   1. REQ-ID rejection
      //   2. doc: prefix rejection
      //   3. Mutually exclusive source check
      //   4. (symbol syntax detection happens implicitly inside pathsToEntries)
      //   5. graph scan + resolve start ids
      //   6. scan-mode mismatch (R-010)
      //   7. impact BFS

      // ----- Input validation: reject REQ-ID / doc: prefix BEFORE we touch
      // the filesystem so the user gets the 4-path navigational error even on
      // a repo without `.artgraph.json`. FR-012.
      for (const t of targets) {
        if (REQ_ID_INPUT_RE.test(t)) {
          console.error(IMPACT_REQ_ID_REJECTION);
          process.exit(1);
        }
        if (t.startsWith("doc:")) {
          console.error(IMPACT_DOC_PREFIX_REJECTION);
          process.exit(1);
        }
      }

      // ----- Mutually exclusive start sources. `targets[]` and `--diff` each
      // count as a single channel; contracts/cli-flags.md requires exactly one
      // to be present.
      if (targets.length > 0 && opts.diff) {
        console.error(
          "error: start sources are mutually exclusive (specify only one): targets, --diff",
        );
        process.exit(1);
      }
      if (targets.length === 0 && !opts.diff) {
        console.error("error: no start source specified. pass file paths or --diff.");
        process.exit(1);
      }

      const { loadConfig } = await import("./config.js");
      const { scan } = await import("./scan.js");
      const { readLock } = await import("./lock.js");
      const { impact, resolveStartIds, resolveOriginReqs } = await import("./graph/traverse.js");
      const config = loadConfig(rootDir);
      const { graph } = scan(rootDir, config);
      const lock = readLock(rootDir, config.lockFile);

      // ----- Build SymbolEntry[] from the chosen channel:
      //   * --diff → file-unit only (contracts/cli-flags.md §1.3; git diff has
      //     no symbol resolution).
      //   * positional targets → CLI_PATH_SYMBOL_RE lift in `pathsToEntries`
      //     (T027). Symbol detection is a SIDE EFFECT of building the entries,
      //     so it happens after #1-#3 above per the validation order.
      let entries: SymbolEntry[];
      let inputDisplayLabels: string[]; // for "No matching nodes found" message
      if (opts.diff) {
        const { getGitDiffFiles } = await import("./diff.js");
        const diffFiles = getGitDiffFiles(rootDir);
        if (diffFiles.length === 0) {
          // E4: this used to always print plain text + exit 0, ignoring
          // `--format json`. A JSON consumer (e.g. a CI script piping into
          // `jq`) would get invalid JSON on the common "no changes" case.
          // Emit the same shape as the normal `impact` JSON output
          // (`ImpactResult`), just all-empty, plus a `message` field so a
          // JSON consumer can still tell the no-diff case apart from a real
          // (but empty) blast radius.
          if (opts.format === "json") {
            console.log(
              JSON.stringify({
                affectedFiles: [],
                affectedDocs: [],
                impactReqs: [],
                affectedTasks: [],
                drifted: [],
                originReqs: [],
                summary: { docs: 0, reqs: 0, files: 0, tasks: 0 },
                message: "No changes detected in git diff.",
              }),
            );
          } else {
            console.log("No changes detected in git diff.");
          }
          process.exit(0);
        }
        entries = diffFiles.map((p) => ({ path: p, line: 1 }));
        inputDisplayLabels = diffFiles.slice();
      } else {
        entries = pathsToEntries(targets);
        inputDisplayLabels = targets.slice();
      }

      const hasSymbolInput = entries.some((e) => e.symbol !== undefined);

      const { startIds, unresolvedSymbols } = resolveStartIds(graph, entries);

      // T029 / R-010 / contracts/cli-flags.md §4.2 — scan-mode mismatch.
      // When the input includes any symbol entry but the current graph has zero
      // `symbol` nodes, that's a global "you didn't scan in symbol mode" miss
      // — every entry would otherwise pile up as `unresolvedSymbol`. Emit the
      // dedicated global error so the user knows to flip `.artgraph.json`'s
      // mode rather than going hunting for typos.
      if (hasSymbolInput) {
        let hasSymbolNode = false;
        for (const node of graph.nodes.values()) {
          if (node.kind === "symbol") {
            hasSymbolNode = true;
            break;
          }
        }
        if (!hasSymbolNode) {
          console.error(
            [
              "ERROR: symbol-level input requires a symbol-mode graph.",
              '       Set `mode: "symbol"` in `.artgraph.json` and re-run `artgraph scan`',
              "       to enable symbol-mode lookup.",
            ].join("\n"),
          );
          process.exit(1);
        }
      }

      // T030 / R-009 / contracts/cli-flags.md §4.1 — per-entry symbol miss.
      // Symbol nodes exist but this specific `path:symbol` isn't registered —
      // typo, export rename, or a stale graph. Surface one line per entry so
      // the user can target the fix.
      if (unresolvedSymbols.length > 0) {
        for (const u of unresolvedSymbols) {
          const label = `${u.path}:${u.symbol}`;
          console.error(`ERROR: No matching symbol found for: ${label}`);
          console.error(
            `  hint: check the export name with \`grep "export.*${u.symbol}" ${u.path}\``,
          );
          console.error(
            `        or verify that \`mode: "symbol"\` is set in \`.artgraph.json\` and re-scan.`,
          );
        }
        process.exit(1);
      }

      if (startIds.length === 0) {
        console.error(`No matching nodes found for: ${inputDisplayLabels.join(", ")}`);
        process.exit(1);
      }

      const result = impact(graph, startIds, lock);

      // T031 / FR-014 / INV-S6 — populate `originReqs` axis. `impact()` itself
      // stays purely forward-BFS; the origin axis is the union of each startId's
      // direct `@impl` claim (1-hop reverse `implements` edge). Recompute here so
      // the JSON / text outputs always carry both axes.
      result.originReqs = resolveOriginReqs(graph, startIds);

      if (opts.format === "json") {
        console.log(JSON.stringify(result));
      } else {
        printImpactText(result);
      }
    });

  // spec 014 (FR-013 — FR-020): plan-coverage subcommand. Reads tasks.md /
  // plan.md (and the current spec.md) to detect REQs that are *affected*
  // (via the file → impact() blast) but *never mentioned* in the source
  // trio — i.e. the SDD author silently dragged in side effects.
  //
  // All defaults follow contracts/cli-flags.md §plan-coverage:
  //   --format text (default), --gate off, --ignore "", requireFilesSection
  //   off unless `.artgraph.json`'s `planCoverage.requireFilesSection` is true.
  program
    .command("plan-coverage")
    .description(
      "Detect implicit REQ impacts: REQs reached by tasks.md/plan.md `Files:` that are never mentioned in the spec trio.",
    )
    .option(
      "--spec <dir>",
      "Spec directory (auto-detected via SPECIFY_FEATURE_DIRECTORY or .specify/feature.json)",
    )
    .option("--tasks <path>", "Override the tasks.md path (default: <spec-dir>/tasks.md)")
    .option("--plan <path>", "Override the plan.md path (default: <spec-dir>/plan.md if present)")
    .addOption(
      new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"),
    )
    .option("--gate", "Exit 1 when implicit impacts or diagnostics are non-empty (CI use)")
    .option("--ignore <csv>", "Comma-separated REQ-IDs to drop from implicit list (one-shot)", "")
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { resolveSpecDir } = await import("./plan-coverage/spec-resolver.js");
      const { loadConfig } = await import("./config.js");
      const { runPlanCoverage } = await import("./plan-coverage/index.js");

      // Resolve spec dir per the contract precedence.
      const resolved = resolveSpecDir({
        explicitFlag: opts.spec,
        env: process.env,
        repoRoot: rootDir,
      });
      if ("error" in resolved) {
        console.error(resolved.error);
        process.exit(1);
      }
      const specDir = resolved.dir;

      // Resolve tasks.md / plan.md against the spec dir unless overridden.
      const tasksPath: string = opts.tasks ? (opts.tasks as string) : resolve(specDir, "tasks.md");
      if (!existsSync(tasksPath)) {
        console.error(`error: tasks.md not found: ${tasksPath}`);
        process.exit(1);
      }
      // CORR-1 / SPEC-3: when the user passes `--plan` explicitly, a missing
      // path is a hard error (mirrors `--tasks` above). When omitted, the
      // default `<spec-dir>/plan.md` is *optional*: silent fallback is fine
      // because plan.md is not required by the contract.
      let planPath: string | undefined;
      if (opts.plan) {
        const explicitPlan = opts.plan as string;
        if (!existsSync(explicitPlan)) {
          console.error(`error: --plan path not found: ${explicitPlan}`);
          process.exit(1);
        }
        planPath = explicitPlan;
      } else {
        const defaultPlan = resolve(specDir, "plan.md");
        planPath = existsSync(defaultPlan) ? defaultPlan : undefined;
      }

      // Parse --ignore CSV. Empty entries are dropped silently so
      // `--ignore ""` or trailing commas don't generate spurious IDs.
      const ignore = ((opts.ignore as string) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // `.artgraph.json`'s planCoverage section drives requireFilesSection
      // (default false).
      const config = loadConfig(rootDir);
      const requireFilesSection: boolean = config.planCoverage?.requireFilesSection ?? false;

      const format: "json" | "text" = opts.format === "json" ? "json" : "text";

      try {
        const result = runPlanCoverage({
          repoRoot: rootDir,
          specDir,
          tasksPath,
          planPath,
          format,
          gate: opts.gate === true,
          ignore,
          requireFilesSection,
        });

        if (format === "json") {
          console.log(JSON.stringify(result.json));
        } else {
          process.stdout.write(result.text);
        }
        if (result.exitCode !== 0) {
          process.exit(result.exitCode);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  program
    .command("check")
    .description("Check for drift, orphans, and uncovered REQs")
    .option("--gate", "Exit 2 on any issue (for Stop hook)")
    .option("--diff", "Scope check to files changed in git diff")
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("./config.js");
      const { scan } = await import("./scan.js");
      const { readLock } = await import("./lock.js");
      const { check } = await import("./check.js");
      const config = loadConfig(rootDir);
      const { graph, warnings } = scan(rootDir, config);
      const lock = readLock(rootDir, config.lockFile);

      const testResults = await resolveTestResults(config, rootDir);

      let scopedNodeIds: Set<string> | undefined;
      if (opts.diff) {
        const { getGitDiffFiles } = await import("./diff.js");
        const { impact, resolveStartIds } = await import("./graph/traverse.js");
        const diffFiles = getGitDiffFiles(rootDir);
        if (diffFiles.length === 0) {
          // E4: same fix as `impact --diff` — don't ignore `--format json` on
          // the "no changes" case. Shape matches the normal `check
          // --format json` output (`CheckResult` + `warnings`), just all-clear,
          // plus a `message` field flagging the no-diff short-circuit.
          if (opts.format === "json") {
            console.log(
              JSON.stringify({
                drifted: [],
                orphans: [],
                uncovered: [],
                coverage: [],
                testFailures: [],
                pass: true,
                warnings,
                message: "No changes detected in git diff.",
              }),
            );
          } else {
            console.log("No changes detected in git diff.");
          }
          process.exit(0);
        }
        const { startIds } = resolveStartIds(graph, pathsToEntries(diffFiles));
        if (startIds.length === 0) {
          console.log("Changed files are not tracked in the graph.");
          process.exit(0);
        }
        const impactResult = impact(graph, startIds, lock);
        scopedNodeIds = new Set([
          ...startIds,
          ...impactResult.impactReqs.map((r) => r),
          ...impactResult.affectedDocs.map((d) => d),
          ...impactResult.affectedFiles.map((f) => `file:${f}`),
        ]);
        for (const f of impactResult.affectedFiles) {
          for (const [id, node] of graph.nodes) {
            if (node.kind === "symbol" && node.filePath === f) {
              scopedNodeIds.add(id);
            }
          }
        }
      }
      const result = check(graph, lock, scopedNodeIds, testResults);

      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, warnings }));
      } else {
        printCheckText(result);
        printWarnings(warnings);
      }

      if (opts.gate && !result.pass) {
        process.exit(2);
      }
    });

  // spec 013 T028 — `artgraph doctor` subcommand. Diagnoses Tier 1 distribution
  // health (Skills sha256 / AGENTS.md marker / wrappers / extraneous files).
  // Independent of `artgraph check` per FR-012: the doctor MUST NOT participate
  // in the `check --gate` decision (regression-tested in
  // `tests/check-gate-no-regression.test.ts`).
  // @impl 013-cross-agent-extensions/FR-012
  program
    .command("doctor")
    .description("Diagnose Tier 1 cross-agent distribution health")
    .option("--agents <list>", "Comma-separated agent ids to diagnose (default: all detected)")
    .addOption(
      new Option("--format <format>", "Output format").choices(["text", "json"]).default("text"),
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { runDoctor, formatDoctorReportJson, formatDoctorReportText } =
        await import("./doctor.js");
      // E-adj-A5: parseAgentsFlag centralizes the parseAgentsList catch — same
      // as init's --agents branch. `init` and `doctor` used to inline a byte-
      // identical try/catch; migrating doctor onto the helper keeps them in
      // sync when the error-to-exit behavior changes.
      const agents: AgentId[] | undefined =
        opts.agents !== undefined ? parseAgentsFlag(String(opts.agents)) : undefined;
      // C1 — mirror the `init` action's try/catch so `SkillsInstallError`,
      // `EACCES` reads, unknown-agent throws, etc. surface as a single
      // `Error: <msg>` line rather than a raw Node stack trace.
      try {
        const report = runDoctor({ rootDir, agents });
        const out =
          opts.format === "json" ? formatDoctorReportJson(report) : formatDoctorReportText(report);
        console.log(out);
        if (report.summary.failCount > 0) {
          process.exitCode = 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  program
    .command("reconcile")
    .description("Update the lock file to match current state")
    .action(async () => {
      const rootDir = process.cwd();
      const { loadConfig } = await import("./config.js");
      const { scan, reconcile } = await import("./scan.js");
      const config = loadConfig(rootDir);
      const { graph } = scan(rootDir, config);
      reconcile(rootDir, config, graph);
      console.log(`Lock file updated: ${config.lockFile}`);
    });

  function printWarnings(warnings: BuildWarning[]) {
    for (const w of warnings) {
      switch (w.type) {
        case "ambiguous-id": {
          const hint = w.files.length > 0 ? ` (candidates: ${w.files.join(", ")})` : "";
          console.error(`WARNING: ambiguous ID "${w.id}"${hint}`);
          break;
        }
        case "duplicate-id":
          console.error(`WARNING: duplicate ID "${w.id}" in ${w.files.join(", ")}`);
          break;
        case "orphan-doc":
          console.error(`WARNING: orphan-doc "${w.id}" referenced from ${w.files.join(", ")}`);
          break;
        case "orphan-edge":
          console.error(
            `WARNING: orphan-edge "${w.id}"${w.files.length > 0 ? ` referenced from ${w.files.join(", ")}` : ""}${w.message ? ` (${w.message})` : ""}`,
          );
          break;
        case "invalid-relation":
          console.error(
            `WARNING: invalid relation "${w.id}" in ${w.files.join(", ")}. Use "derives_from" or "depends_on"`,
          );
          break;
        case "reserved-prefix":
          console.error(`WARNING: reserved prefix in ID "${w.id}" in ${w.files.join(", ")}`);
          break;
        case "unresolved-link":
          console.error(`WARNING: unresolved-link "${w.id}" referenced from ${w.files.join(", ")}`);
          break;
        case "out-of-scope-link":
          console.error(
            `WARNING: out-of-scope-link "${w.id}" referenced from ${w.files.join(", ")} (outside specDirs)`,
          );
          break;
        case "invalid-annotation-id":
          console.error(
            `WARNING: invalid-annotation-id "${w.id}"${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
          );
          break;
        case "empty-annotation":
          console.error(
            `WARNING: empty-annotation${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
          );
          break;
        case "self-reference-annotation":
          console.error(
            `WARNING: self-reference-annotation "${w.id}"${w.files.length > 0 ? ` in ${w.files.join(", ")}` : ""}${w.message ? ` — ${w.message}` : ""}`,
          );
          break;
        default: {
          // Exhaustiveness check: if `BuildWarning.type` gains a new variant
          // without a matching case, TypeScript flags the assignment below at
          // compile time. Keeps the CLI surface in sync with the warning union.
          const _exhaustive: never = w.type;
          void _exhaustive;
        }
      }
    }
  }

  // spec 016 T032 / FR-015 / FR-023 / contracts/cli-flags.md §5.2 — text formatter.
  // Three REQ-axis sections:
  //   - Impact reqs        = forward BFS reach
  //   - Origin reqs        = startId `@impl` claims (1-hop reverse)
  //   - Drift candidates   = (impactReqs \ originReqs), section omitted when empty
  function printImpactText(result: any) {
    const impactReqs: string[] = Array.isArray(result.impactReqs) ? result.impactReqs : [];
    const originReqs: string[] = Array.isArray(result.originReqs) ? result.originReqs : [];

    if (impactReqs.length > 0) {
      console.log("Impact reqs:");
      for (const r of impactReqs) console.log(`  ${r}  (req)`);
    } else {
      // Keep a visible header even for empty impact so downstream readers /
      // tests don't have to special-case "no impact" output.
      console.log("Impact reqs:");
      console.log("  (none)");
    }

    // Origin section: always emit so the JSON consumer's text mirror is
    // unambiguous; show `(none)` when the startIds have no @impl claim.
    console.log("");
    console.log("Origin reqs (@impl claims):");
    if (originReqs.length > 0) {
      for (const r of originReqs) console.log(`  ${r}  (req)`);
    } else {
      console.log("  (none)");
    }

    // Drift candidates — FR-015: omit the section entirely when the set
    // difference is empty so a clean run doesn't print noise.
    const originSet = new Set(originReqs);
    const drift = impactReqs.filter((r) => !originSet.has(r));
    if (drift.length > 0) {
      console.log("");
      console.log("Drift candidates (impact \\ origin):");
      for (const r of drift) console.log(`  ${r}  (req)`);
    }

    if (result.affectedTasks && result.affectedTasks.length > 0) {
      console.log("");
      console.log("Affected Tasks:");
      for (const t of result.affectedTasks) console.log(`  ${t}`);
    }
    if (result.affectedDocs && result.affectedDocs.length > 0) {
      console.log("");
      console.log("Affected Docs:");
      for (const d of result.affectedDocs) console.log(`  ${d}`);
    }
    if (result.affectedFiles && result.affectedFiles.length > 0) {
      console.log("");
      console.log("Affected Files:");
      for (const f of result.affectedFiles) console.log(`  ${f}`);
    }
    if (result.drifted && result.drifted.length > 0) {
      console.log("");
      console.log("Drifted:");
      for (const d of result.drifted) console.log(`  ${d.nodeId} (${d.kind})`);
    }
    if (result.summary) {
      const taskPart = result.summary.tasks > 0 ? `, ${result.summary.tasks} tasks` : "";
      console.log(
        `Summary: ${result.summary.docs} docs, ${result.summary.reqs} reqs, ${result.summary.files} files${taskPart}`,
      );
    }
  }

  function printCheckText(result: any) {
    if (result.drifted?.length > 0) {
      console.log("DRIFT:");
      for (const d of result.drifted) console.log(`  ${d.nodeId} (${d.kind})`);
    }
    if (result.orphans?.length > 0) {
      console.log("ORPHANS:");
      for (const o of result.orphans) console.log(`  ${o}`);
    }
    if (result.uncovered?.length > 0) {
      console.log("UNCOVERED:");
      for (const u of result.uncovered) console.log(`  ${u}`);
    }
    if (result.testFailures?.length > 0) {
      console.log("TEST FAILURES:");
      for (const t of result.testFailures) console.log(`  ${t}`);
    }
    if (result.coverage?.length > 0) {
      console.log("COVERAGE:");
      for (const c of result.coverage) {
        console.log(`  ${c.reqId}: ${c.status}`);
      }
    }
    if (result.pass) {
      console.log("All checks passed.");
    }
  }

  // `integrate` accepts a single positional that is either a provider id
  // (`speckit` / `kiro`) or the sub-command verb `list`. Commander 13's
  // nested sub-commands struggle with this hybrid shape (the parent's
  // positional arg collides with `.command("list")`), so we dispatch on the
  // argument inside the handler. Both surfaces share the same `--format`
  // option to keep CLI ergonomics consistent.
  program
    .command("integrate <tool>")
    .description(
      "Integrate artgraph into an SDD tool's workflow (speckit | kiro), or 'list' to show providers",
    )
    .option("--gate", "(speckit only) Add before_implement gate hook")
    .option("--no-gate", "(speckit only) Remove before_implement gate hook")
    .option("--force", "Overwrite existing files")
    .option("--uninstall", "Remove the integration (delete files / hook entries)")
    .addOption(
      new Option("--format <format>", "Output format").choices(["text", "json"]).default("text"),
    )
    .action(async (tool: string, opts) => {
      const rootDir = process.cwd();
      const { runIntegrate } = await loadIntegrate();

      // Sub-command dispatch: `integrate list` reuses the same option surface
      // (only --format applies; the rest are ignored for `list`).
      if (tool === "list") {
        await runIntegrateList(rootDir, opts.format);
        return;
      }

      // commander stores --gate / --no-gate in `opts.gate`:
      //   --gate         -> true
      //   --no-gate      -> false
      //   (neither)      -> undefined (option absent)
      // We must preserve `undefined` so the provider can distinguish
      // "no opinion" from "explicitly off" (FR-003 declarative semantics).
      const gate: boolean | undefined = Object.prototype.hasOwnProperty.call(opts, "gate")
        ? (opts.gate as boolean)
        : undefined;

      try {
        const result = runIntegrate(rootDir, tool as IntegrationProviderId, {
          force: opts.force,
          gate,
          uninstall: opts.uninstall,
        });

        if (opts.format === "json") {
          console.log(JSON.stringify(result));
        } else {
          printIntegrateText(result, tool as IntegrationProviderId);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (opts.format === "json") {
          console.error(JSON.stringify({ error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
    });

  async function runIntegrateList(rootDir: string, format: string): Promise<void> {
    const { getProviderStatuses } = await loadIntegrate();
    const statuses = getProviderStatuses(rootDir);

    if (format === "json") {
      console.log(JSON.stringify({ providers: statuses.map(toListJson) }));
      return;
    }

    // Text format: contracts/integrate-cli.md §2.
    //   speckit    Spec Kit    [ detected: yes, installed: yes ]
    //   kiro       Kiro        [ detected: yes, installed: no  ] → run: artgraph integrate kiro
    const idCol = Math.max(8, ...statuses.map((s) => s.providerId.length));
    const nameCol = Math.max(8, ...statuses.map((s) => s.displayName.length));

    console.log("Available integrations:");
    console.log("");
    for (const s of statuses) {
      const id = s.providerId.padEnd(idCol);
      const name = s.displayName.padEnd(nameCol);
      const det = s.detected ? "yes" : "no ";
      const ins = s.installed ? "yes" : "no ";
      const suffix = s.detected && !s.installed ? ` → run: artgraph integrate ${s.providerId}` : "";
      console.log(`  ${id}  ${name}  [ detected: ${det}, installed: ${ins} ]${suffix}`);
    }
    console.log("");
    console.log("(Future providers: openspec — coming soon)");
  }

  // JSON shape for `integrate list` — matches contracts/integrate-cli.md §2.
  // Using `id` (not `providerId`) on the wire for parity with the contract
  // example; internally we still carry `providerId`.
  function toListJson(s: import("./types.js").IntegrationStatus): {
    id: string;
    displayName: string;
    marker: string;
    detected: boolean;
    installed: boolean;
  } {
    return {
      id: s.providerId,
      displayName: s.displayName,
      marker: s.marker,
      detected: s.detected,
      installed: s.installed,
    };
  }

  // Display-name lookup for the integrate text formatter. The registry stores
  // the canonical name on the provider instance, but we don't want to depend
  // on registry state here (the registry might be cleared by tests).
  const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    speckit: "Spec Kit",
    kiro: "Kiro",
  };

  function printIntegrateText(result: IntegrateResult, tool: string): void {
    const display = PROVIDER_DISPLAY_NAMES[tool] ?? tool;
    if (result.noop) {
      console.log(`✓ Already integrated: ${tool} (${display}) — no changes`);
      if (result.warnings.length > 0) {
        console.log("");
        console.log(`Warnings (${result.warnings.length}):`);
        for (const w of result.warnings) console.log(`  ${w}`);
      }
      return;
    }
    console.log(`✓ Integrated: ${tool} (${display})`);
    if (result.created.length > 0) {
      console.log("");
      console.log(`Created (${result.created.length}):`);
      for (const p of result.created) console.log(`  ${p}`);
    }
    if (result.modified.length > 0) {
      console.log("");
      console.log(`Modified (${result.modified.length}):`);
      for (const p of result.modified) console.log(`  ${p}`);
    }
    if (result.removed.length > 0) {
      console.log("");
      console.log(`Removed (${result.removed.length}):`);
      for (const p of result.removed) console.log(`  ${p}`);
    }
    if (result.nextSteps.length > 0) {
      console.log("");
      console.log("Next:");
      for (const s of result.nextSteps) console.log(`  ${s}`);
    }
    if (result.warnings.length > 0) {
      console.log("");
      console.log(`Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) console.log(`  ${w}`);
    }
  }

  program
    .command("rename")
    .description("Rename, split, or merge spec IDs across the project")
    .option("--from <id>", "Source ID to rename")
    .option("--to <id>", "Target ID for rename")
    .option("--split <id>", "Source ID to split")
    .option("--merge <ids...>", "Source IDs to merge")
    .option("--into <ids...>", "Target ID(s) for split or merge")
    .option("--dry-run", "Show changes without applying them")
    .addOption(
      new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"),
    )
    .action(async (opts) => {
      const rootDir = process.cwd();
      const { executeRename, executeSplit, executeMerge } = await import("./rename-executor.js");
      const format: "json" | "text" = opts.format;
      const baseOpts = { dryRun: !!opts.dryRun, format, rootDir };

      const fail = (msg: string): never => {
        // Honour --format json even on the error path so JSON consumers never
        // have to parse a plain-text line (F7).
        if (format === "json") {
          console.error(JSON.stringify({ error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      };

      try {
        let result: RenameResult;

        if (opts.from && opts.to) {
          // rename mode
          result = executeRename({ ...baseOpts, from: opts.from, to: opts.to });
        } else if (opts.split && opts.into) {
          // split mode
          result = executeSplit({ ...baseOpts, splitId: opts.split, intoIds: opts.into });
        } else if (opts.merge && opts.into) {
          // merge mode
          if (opts.into.length !== 1) {
            fail("--merge requires exactly one --into target ID.");
          }
          result = executeMerge({ ...baseOpts, mergeIds: opts.merge, intoId: opts.into[0] });
        } else {
          fail("Specify --from/--to, --split/--into, or --merge/--into.");
          return;
        }

        if (format === "json") {
          printRenameJson(result);
        } else {
          printRenameText(result);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        fail(msg);
      }
    });

  function printRenameText(result: RenameResult) {
    if (result.changes.length === 0 && result.lockChanges.length === 0) {
      console.log("No references found.");
      return;
    }

    if (result.operation === "rename") {
      console.log(`Renamed ${result.from} → ${result.to}`);
    } else if (result.operation === "split") {
      console.log(`Split ${result.from} → ${(result.intoIds ?? []).join(", ")}`);
    } else if (result.operation === "merge") {
      console.log(`Merged ${(result.sourceIds ?? []).join(", ")} → ${result.to}`);
    }

    for (const c of result.changes) {
      const before = c.before.trim().slice(0, 60);
      const after = c.after.trim().slice(0, 60);
      console.log(`  ${c.filePath}:${c.line}  ${before} → ${after}`);
    }

    for (const w of result.warnings) {
      console.log(
        `WARNING: ${w.filePath} contains @impl ${w.oldId} — manual assignment to ${w.newIds.join(", ")} needed`,
      );
    }

    if (!result.applied) {
      console.log("(dry-run: no files were modified)");
    }
  }

  function printRenameJson(result: RenameResult) {
    console.log(JSON.stringify(result));
  }
}

/**
 * @internal
 * Test seam — intentionally hidden from the public package surface via the
 * `exports` field in package.json. Mutates global process state during the
 * call (cwd / exit / console / stdout / stderr) and is unsafe for external
 * use. Tests reach it via the in-repo path `../src/cli.js`.
 */
export interface RunCliOptions {
  /** Working directory the CLI sees as `process.cwd()` for the duration of the call. */
  cwd?: string;
}

/** @internal */
export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class CliExitError extends Error {
  exitCode: number;
  constructor(exitCode: number) {
    super(`artgraph CLI exited with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/**
 * @internal
 * Run the artgraph CLI in-process and capture its stdout/stderr/exitCode.
 * Used by the test suite to avoid the ~150–300 ms per-spawn Node startup +
 * parser-stack reload cost. Behaves like a fresh `artgraph <argv>` invocation:
 * builds a new commander tree, redirects console/process.stdout/process.stderr,
 * intercepts `process.exit`, and temporarily chdirs into `opts.cwd`.
 *
 * NOT a public API — the package's `exports` field deliberately blocks
 * deep imports so external consumers cannot reach this. It mutates global
 * process state (cwd / exit / console / stdout / stderr) and is unsafe
 * to call concurrently within a single Node process.
 */
export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origCwd = process.cwd();
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  // Snapshot `process.exitCode` so we can restore it after this runCli call.
  // Commands may leave a non-zero exitCode (e.g. `init` on hooksInstall
  // failure) that would otherwise poison the surrounding vitest process's
  // exit state.
  const origProcessExitCode = process.exitCode;

  const pushStdout = (s: string) => stdoutChunks.push(s);
  const pushStderr = (s: string) => stderrChunks.push(s);

  let exitCode = 0;

  try {
    if (opts.cwd) process.chdir(opts.cwd);

    console.log = (...args: unknown[]) => {
      pushStdout(args.map(formatLogArg).join(" ") + "\n");
    };
    console.error = (...args: unknown[]) => {
      pushStderr(args.map(formatLogArg).join(" ") + "\n");
    };
    process.stdout.write = ((chunk: unknown) => {
      pushStdout(chunkToString(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      pushStderr(chunkToString(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new CliExitError(code ?? 0);
    }) as typeof process.exit;

    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: pushStdout,
      writeErr: pushStderr,
    });

    try {
      await program.parseAsync(argv, { from: "user" });
      // Commands may signal failure by mutating `process.exitCode` instead of
      // throwing (e.g. `init` on hooksInstall failure). Read it here so those
      // exits are visible in RunCliResult.
      if (typeof process.exitCode === "number" && process.exitCode !== 0) {
        exitCode = process.exitCode;
      }
    } catch (e) {
      if (e instanceof CliExitError) {
        exitCode = e.exitCode;
      } else if (e instanceof CommanderError) {
        // Help / version exits are conventionally success.
        const code = e.code;
        if (code === "commander.helpDisplayed" || code === "commander.version") {
          exitCode = 0;
        } else {
          exitCode = e.exitCode ?? 1;
        }
      } else {
        throw e;
      }
    }
  } finally {
    process.chdir(origCwd);
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    // Restore prior `process.exitCode` so a runCli call doesn't leak its
    // exit state into the surrounding test process.
    process.exitCode = origProcessExitCode;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}

// Only invoke commander when this module is the entry point of a real CLI
// process. Importing `cli.ts` from tests must not trigger argv parsing.
//
// `realpathSync` is essential: when invoked via an npm/pnpm bin shim
// (`./node_modules/.bin/artgraph`), Node's ESM loader resolves the module
// URL to the symlink target (the real `dist/cli.js`), but `process.argv[1]`
// stays as the shim path. Without realpath normalization the two are
// different strings and the guard never fires — bin-shim invocations
// would silently exit without parsing argv. See PR #99 review.
function resolveEntryHref(): string {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return "";
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return "";
  }
}
if (import.meta.url === resolveEntryHref()) {
  const program = buildProgram();
  // parseAsync (not parse): action handlers are async since the lazy-import
  // refactor, and commander's sync parse() would return before they finish.
  // Matches the parseAsync semantics runCli has always used. A rejected
  // handler surfaces as a top-level-await rejection — stack trace + exit 1 —
  // same outcome as the old sync-throw-through-parse() path.
  await program.parseAsync();
}
