// issue #366 (scope A) — internal types shared by the per-format hook
// writers (`json-event-array.ts` / `file-per-hook.ts`) and the dispatch
// layer (`index.ts`). Not part of the package's public surface.

import type { HookConfig } from "../agents/descriptors.js";
import type { HookOutcome } from "../types.js";

/** Narrowed `HookConfig` variant for the Claude Code / Codex CLI writer. */
export type HookConfigJsonEventArray = Extract<HookConfig, { format: "json-event-array" }>;

/** Narrowed `HookConfig` variant for the Kiro IDE writer. */
export type HookConfigFilePerHook = Extract<HookConfig, { format: "file-per-hook" }>;

/**
 * A single writer's outcome, before the dispatcher (`index.ts`) attaches the
 * `agentId` it was invoked for. Writers only see a `HookConfig`, never the
 * `AgentId` it came from, so they cannot populate `HookOutcome.agentId`
 * themselves — the dispatcher stamps it on after the call.
 */
export type HookWriteOutcome = Omit<HookOutcome, "agentId">;
