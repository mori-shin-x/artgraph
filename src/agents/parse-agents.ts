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

// OUT-6 — parseAgentsList() returns its result alpha-sorted (line ~121),
// so keep the error-message list in the same order to avoid surprising the
// user with two different orderings for the same agent set.
const SUPPORTED_LIST = [...AGENT_IDS].sort().join(", ");

// @impl 013-cross-agent-extensions/FR-001
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
    // E1: suggest the lowercase form for EVERY mismatched token that would
    // resolve to a known id — not just the first one (`.find` previously
    // dropped every suggestion after the first match, so
    // `--agents=CLAUDE,CODEX` only hinted at "claude").
    const suggestions = [
      ...new Set(
        nonLowercase
          .map((t) => t.toLowerCase())
          .filter((t) => findDescriptor(t) !== undefined),
      ),
    ];
    const hint =
      suggestions.length > 0
        ? ` Did you mean ${suggestions.map((s) => `"${s}"`).join(", ")}?`
        : "";

    // E1: also surface case-normalized duplicates in this same error so a
    // combo like `Claude,claude` doesn't force the user through two
    // sequential fix-and-retry cycles (uppercase error, then — once fixed —
    // a separate duplicate error).
    const lowercased = trimmed.map((t) => t.toLowerCase());
    const seenLower = new Set<string>();
    const dupesLower = new Set<string>();
    for (const t of lowercased) {
      if (seenLower.has(t)) dupesLower.add(t);
      seenLower.add(t);
    }
    const dupeNote =
      dupesLower.size > 0
        ? ` Also duplicated once case is normalized: ${[...dupesLower]
            .sort()
            .map((t) => `"${t}"`)
            .join(", ")}.`
        : "";

    throw new AgentsParseError(
      `ERROR: Unknown agent identifier(s): ${formatted}.${hint}${dupeNote} Supported values: ${SUPPORTED_LIST}.`,
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
