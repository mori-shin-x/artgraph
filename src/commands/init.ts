// `artgraph init` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import { AGENT_IDS, type AgentId } from "../agents/descriptors.js";
import {
  AGENTS_REQUIRED_ERROR,
  loadIntegrate,
  parseAgentsFlag,
  reportGraphWarnings,
} from "./shared.js";
import { printIntegrateText } from "./presenters/integrate.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Initialize artgraph for this project (default: config + scan + Skills + auto-integrate detected SDD tools + Stop hook + AGENTS.md / wrapper injection). Use --minimal for bare config only.",
    )
    .option(
      "--force",
      "Overwrite existing .artgraph.json, distributed Skill files, and integration files. Also overrides the lock schema-version write guard (downgrades a newer-schema .trace.lock, printing a warning; see `artgraph reconcile`). Refuses symlinks even with --force.",
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
      const { runInit } = await import("../init.js");
      const { DistributionError } = await import("../agents/distribute.js");

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
            reportGraphWarnings(result.warnings);
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
