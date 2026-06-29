// spec 013 T005 — `--agents=<csv>` parser.
//
// Pure function: takes the raw flag value (e.g. `"claude,codex"`) and returns
// a normalized, alpha-sorted `AgentId[]`. Any input that violates the
// contract throws `AgentsParseError` with a human-readable message that the
// CLI layer surfaces verbatim on stderr.
//
// Contract: specs/013-cross-agent-extensions/contracts/cli-flags.md
//
// Rules enforced (in evaluation order):
//   1. Non-empty string                         (`--agents=` → error)
//   2. Split on `,`, trim each element
//   3. No empty elements                        (`a,,b` / trailing comma → error)
//   4. No duplicates                            (`claude,claude` → error)
//   5. Lowercase only — NO internal normalization (A1 clarification).
//      `Claude` → error with `Did you mean "claude"?` hint.
//   6. Every element must be a Tier 1 id        (else "Unknown agent..." error)
//
// The function never mutates global state and never touches the filesystem.

import { AGENT_IDS, type AgentId, findDescriptor } from "./descriptors.js";

export class AgentsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsParseError";
  }
}

const SUPPORTED_LIST = AGENT_IDS.join(", ");

/**
 * Parse the raw `--agents=<csv>` value into a normalized, alpha-sorted
 * `AgentId[]`. Throws `AgentsParseError` on any contract violation.
 */
export function parseAgentsList(raw: string): AgentId[] {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AgentsParseError(emptyError());
  }

  // Split on `,` first so we can detect empty elements (trailing comma,
  // adjacent commas, leading comma) before trimming everything down.
  const rawTokens = raw.split(",");
  const trimmed = rawTokens.map((t) => t.trim());

  if (trimmed.some((t) => t.length === 0)) {
    throw new AgentsParseError(emptyError());
  }

  // Reject uppercase / mixed-case BEFORE the "unknown agent" check so the
  // user gets the "Did you mean ...?" hint specifically tailored to the
  // lowercased form (A1 spec clarification).
  const nonLowercase = trimmed.filter((t) => t !== t.toLowerCase());
  if (nonLowercase.length > 0) {
    const formatted = nonLowercase.map((t) => `"${t}"`).join(", ");
    // Suggest the lowercase form only when it would resolve to a known id.
    const suggestion = nonLowercase
      .map((t) => t.toLowerCase())
      .find((t) => findDescriptor(t) !== undefined);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
    throw new AgentsParseError(
      `ERROR: Unknown agent identifier(s): ${formatted}.${hint} Supported values: ${SUPPORTED_LIST}.`,
    );
  }

  // Duplicate detection — reported with the offending value(s) listed.
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const t of trimmed) {
    if (seen.has(t)) dupes.add(t);
    seen.add(t);
  }
  if (dupes.size > 0) {
    const formatted = [...dupes].sort().map((t) => `"${t}"`).join(", ");
    throw new AgentsParseError(
      `ERROR: Duplicate agent identifier(s): ${formatted}. Supported values: ${SUPPORTED_LIST}.`,
    );
  }

  // Unknown-agent rejection (all-lowercase by this point).
  const unknown = trimmed.filter((t) => findDescriptor(t) === undefined);
  if (unknown.length > 0) {
    const formatted = unknown.map((t) => `"${t}"`).join(", ");
    throw new AgentsParseError(
      `ERROR: Unknown agent identifier(s): ${formatted}. Supported values: ${SUPPORTED_LIST}.`,
    );
  }

  // Alpha-sort so callers get a canonical order regardless of input order.
  return [...trimmed].sort() as AgentId[];
}

function emptyError(): string {
  return [
    `ERROR: --agents=<list> requires at least one non-empty value.`,
    `Supported values: ${SUPPORTED_LIST}`,
    `Example: --agents=claude,codex`,
  ].join("\n");
}
