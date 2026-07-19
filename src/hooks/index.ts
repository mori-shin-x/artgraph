// issue #366 (scope A) — cross-agent Stop-hook install dispatch. Replaces
// the original Claude-only `installHooks()` in `src/init.ts` (pre-#366),
// which is now a thin wrapper delegating here.

import { findDescriptor, type AgentId } from "../agents/descriptors.js";
import { execPrefix as buildExecPrefix, type PackageManager } from "../package-manager.js";
import type { HookOutcome } from "../types.js";
import { writeFilePerHook } from "./file-per-hook.js";
import { writeJsonEventArrayHook } from "./json-event-array.js";
import type { HookWriteOutcome } from "./types.js";

export interface HooksInstallResult {
  perAgent: HookOutcome[];
  anyFailure: boolean;
}

/**
 * Install (or merge) the artgraph Stop hook for every agent in `agentsList`
 * that has a `hook` config on its `AgentDescriptor` (`src/agents/
 * descriptors.ts`). Agents not in `agentsList` are simply absent from
 * `perAgent` — this is a per-agent filter, not a "skipped" outcome for
 * every unselected Tier 1 id.
 *
 * `execPrefix` here is the detected package manager (or `null` when
 * undetectable) — the actual `pnpm exec artgraph`-style command string is
 * built per writer call via `buildExecPrefix(pm)` once a hook config is
 * confirmed to exist for the agent.
 *
 * HIGH-1 (Step 0-pre): a single-shape `InitResult.hooksInstall` let one
 * agent's success overwrite a sibling's failure, silencing the CLI's
 * conflict warning and exit code. `perAgent` + `anyFailure` (aggregated
 * below) fixes that — every agent's outcome survives, and any one failure
 * flips the whole result to a non-zero exit.
 */
export function installHooks(
  rootDir: string,
  agentsList: readonly AgentId[],
  execPrefix: PackageManager | null,
): HooksInstallResult {
  const perAgent: HookOutcome[] = [];

  for (const agentId of agentsList) {
    const descriptor = findDescriptor(agentId);
    if (!descriptor) {
      // Defensive: parse-agents.ts / runInit's pre-flight already validates
      // every id in agentsList; a programmatic caller could still bypass it.
      // Mirrors runInit's identical defensive check for skillDescriptors.
      throw new Error(`unknown agent id passed to installHooks: ${agentId}`);
    }

    if (!descriptor.hook) {
      perAgent.push({ agentId, action: "skipped-no-hook-config", failure: false });
      continue;
    }

    if (execPrefix === null) {
      perAgent.push({ agentId, action: "skipped-no-pm", failure: false });
      continue;
    }

    const prefix = buildExecPrefix(execPrefix);
    const hook = descriptor.hook;
    let outcome: HookWriteOutcome;
    switch (hook.format) {
      case "json-event-array":
        outcome = writeJsonEventArrayHook(rootDir, hook, prefix);
        break;
      case "file-per-hook":
        outcome = writeFilePerHook(rootDir, hook, prefix);
        break;
      default:
        outcome = assertNeverHookFormat(hook);
    }
    perAgent.push({ agentId, ...outcome });
  }

  return {
    perAgent,
    anyFailure: perAgent.some((o) => o.failure === true),
  };
}

/**
 * Exhaustiveness guard: a new `HookConfig.format` variant fails `tsc` here
 * instead of silently falling through with no writer invoked.
 */
function assertNeverHookFormat(value: never): never {
  throw new Error(`unhandled hook format variant: ${JSON.stringify(value)}`);
}
