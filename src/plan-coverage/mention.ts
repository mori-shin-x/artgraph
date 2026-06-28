// spec 014 — REQ-ID mention detector for `artgraph plan-coverage`.
//
// Contract: specs/014-reinvent-impact-cli/contracts/mention-semantics.md
//
// The rule is intentionally narrow and shipping-simple: for each affected
// REQ-ID `R`, search the concatenated source text (tasks + plan + spec) for
// `R` surrounded by **non-word** boundaries (POSIX `\b` would be ambiguous
// around the `-` in `REQ-3`, so we use explicit lookarounds against the
// `[A-Za-z0-9_]` class). Label keywords (`Considered:` / `Affected:` etc.)
// are NOT required — any occurrence counts.
//
// The result is the bisection of `affectedReqIds` into mentioned / implicit;
// `--ignore` filtering happens later in `runPlanCoverage` and never touches
// the detector itself.

export interface DetectMentionsSources {
  tasks: string;
  plan?: string;
  spec?: string;
}

export interface DetectMentionsResult {
  /** REQ-IDs from the input that matched somewhere in the union text. */
  mentioned: Set<string>;
  /**
   * REQ-IDs from the input that did NOT match, in input order. Returned as
   * an array (not a Set) so the caller can preserve traversal ordering
   * before later sort/ignore steps.
   */
  implicit: string[];
}

// Escape every regex meta character. REQ-IDs that match `/^[A-Z]+-\d+$/` are
// already safe, but future / user-defined ID schemes (`REQ.001`, `Story 42`)
// can carry meta chars, so we do the escape unconditionally — cheap insurance.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bisect `affectedReqIds` into mentioned vs implicit by scanning the union
 * of `sources.tasks` + `sources.plan` + `sources.spec`.
 *
 * Each REQ-ID is tested with `(?<![A-Za-z0-9_])<id>(?![A-Za-z0-9_])` so:
 *   - `REQ-3` matches `REQ-3`, `[REQ-3]`, `(REQ-3)`, `Considered: REQ-3`
 *   - `REQ-3` does NOT match `REQ-30`, `aREQ-3`, `_REQ-3`, `REQ-3xyz`
 *
 * Case sensitive (graph node IDs are case-sensitive). Multiple textual hits
 * for the same ID collapse to a single Set entry.
 */
export function detectMentions(
  affectedReqIds: string[],
  sources: DetectMentionsSources,
): DetectMentionsResult {
  // Join with newline so a REQ-ID never accidentally bridges file boundaries
  // (e.g. tasks ends with `REQ-` and plan starts with `3`). Newline is a
  // non-word char so it cannot be part of an ID on either side.
  const parts: string[] = [sources.tasks];
  if (sources.plan !== undefined) parts.push(sources.plan);
  if (sources.spec !== undefined) parts.push(sources.spec);
  const text = parts.join("\n");

  const mentioned = new Set<string>();
  for (const reqId of affectedReqIds) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(reqId)}(?![A-Za-z0-9_])`);
    if (re.test(text)) mentioned.add(reqId);
  }

  const implicit = affectedReqIds.filter((id) => !mentioned.has(id));
  return { mentioned, implicit };
}
