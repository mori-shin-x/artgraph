// spec 013 T018 / T019 / T020 — agent-context module.
//
// Owns the artgraph-managed marker block that lives inside
//   - AGENTS.md                              (canonical, FR-005)
//   - CLAUDE.md                              (wrapper, FR-006)
//   - .github/copilot-instructions.md        (wrapper, FR-007)
//
// Marker boundary format and parse / write semantics are fixed by
//   specs/013-cross-agent-extensions/contracts/agent-context-format.md
//   specs/013-cross-agent-extensions/research.md §R2 / §R6
//   specs/013-cross-agent-extensions/data-model.md §4 (AgentContextBlock)
//
// Constitution Principle V: this module performs **structural** updates only
// (marker-bounded literal-text replace + atomic write). No semantic parsing,
// no markdown AST traversal, no link resolution — those concerns belong to
// downstream Skills / doctor.
//
// `src/init.ts` wires these helpers in T021. `tests/agent-context.test.ts`
// (T022) exercises every export at the unit level.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "../integrate/atomic-write.js";

// ---------------------------------------------------------------------------
// Marker block (T018)
// ---------------------------------------------------------------------------

/** Literal opening marker. Case-sensitive (R2). */
export const MARKER_BEGIN = "<!-- artgraph:begin -->";
/** Literal closing marker. Case-sensitive (R2). */
export const MARKER_END = "<!-- artgraph:end -->";

/**
 * Match the first artgraph-managed block in a file. Allows optional inner
 * whitespace around `artgraph:begin` / `artgraph:end` so manually-edited
 * markers do not get orphaned, but the rest is case-sensitive (per spec).
 * Body match is lazy (`*?`) so we always stop at the first `artgraph:end`.
 */
const MARKER_RE = /<!--\s*artgraph:begin\s*-->[\s\S]*?<!--\s*artgraph:end\s*-->/;

/** Begin/end discovery regexes for the `inspectMarkerBlock` diagnostic. */
const BEGIN_RE = /<!--\s*artgraph:begin\s*-->/;
const END_RE = /<!--\s*artgraph:end\s*-->/;

export interface MarkerBlockResult {
  /** True iff the existing content already contained a marker block. */
  found: boolean;
  /** Complete file content to write back. Caller is responsible for the IO. */
  newContent: string;
}

/**
 * Build the file content after applying `body` inside the artgraph marker
 * block. Pure function — no IO.
 *
 *   - If a marker block is present, it is replaced in-place. Anything outside
 *     the markers is preserved byte-for-byte (FR-009 / FR-010).
 *   - If no marker block is present, the block is appended at EOF. When the
 *     existing content is empty the leading `\n\n` separator is omitted so
 *     the new file does not begin with blank lines.
 *
 * `body` is inserted verbatim between `${MARKER_BEGIN}\n` and `\n${MARKER_END}`,
 * so callers must NOT pass the markers themselves.
 */
export function applyMarkerBlock(existingContent: string, body: string): MarkerBlockResult {
  const block = `${MARKER_BEGIN}\n${body}\n${MARKER_END}`;

  if (MARKER_RE.test(existingContent)) {
    return {
      found: true,
      newContent: existingContent.replace(MARKER_RE, block),
    };
  }

  if (existingContent.length === 0) {
    return { found: false, newContent: `${block}\n` };
  }

  return { found: false, newContent: `${existingContent}\n\n${block}\n` };
}

export interface MarkerBlockHealth {
  /** True iff at least one `<!-- artgraph:begin -->` marker is present. */
  hasBegin: boolean;
  /** True iff at least one `<!-- artgraph:end -->` marker is present. */
  hasEnd: boolean;
  /** True iff a complete begin/end pair (begin appearing before end) exists. */
  hasMatchedPair: boolean;
  /**
   * The body text between the markers when `hasMatchedPair` is true; `null`
   * otherwise. The body is returned without the surrounding newlines that
   * `applyMarkerBlock` adds around `${body}`.
   */
  bodyText: string | null;
}

/**
 * Diagnose the health of the marker block in `content`. Used by doctor
 * (`agents-md-marker-broken` finding) to distinguish "no block at all" from
 * "half-written / corrupted block".
 */
export function inspectMarkerBlock(content: string): MarkerBlockHealth {
  const beginMatch = content.match(BEGIN_RE);
  const endMatch = content.match(END_RE);
  const hasBegin = beginMatch !== null;
  const hasEnd = endMatch !== null;

  const pairMatch = content.match(MARKER_RE);
  const hasMatchedPair = pairMatch !== null;

  let bodyText: string | null = null;
  if (hasMatchedPair && pairMatch) {
    const whole = pairMatch[0];
    // Strip the begin marker + its trailing whitespace and the end marker +
    // its leading whitespace. We use the literal MARKER_BEGIN / MARKER_END
    // for the strip (they are what `applyMarkerBlock` writes); the regex
    // tolerates inner whitespace variations but the body strip targets the
    // canonical form, so a hand-edited oddly-spaced marker still surfaces
    // through `hasMatchedPair` even if `bodyText` ends up containing the
    // residual whitespace from the actual marker.
    const beginIdx = whole.search(BEGIN_RE);
    const endIdx = whole.search(END_RE);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const afterBegin = whole.slice(beginIdx).match(BEGIN_RE);
      const beginLen = afterBegin ? afterBegin[0].length : MARKER_BEGIN.length;
      const inner = whole.slice(beginIdx + beginLen, endIdx);
      // Drop the single leading and trailing newline that `applyMarkerBlock`
      // inserts around the body, but leave any user-authored blank lines
      // inside the block intact.
      bodyText = inner.replace(/^\n/, "").replace(/\n$/, "");
    }
  }

  return { hasBegin, hasEnd, hasMatchedPair, bodyText };
}

// ---------------------------------------------------------------------------
// AGENTS.md body builder + writer (T019)
// ---------------------------------------------------------------------------

/**
 * Canonical artgraph block body that lives inside AGENTS.md. Mirrors
 * contracts/agent-context-format.md §AGENTS.md verbatim (8 Skills + workflows
 * + quickstart). The text is the artgraph guide itself, NOT a wrapper.
 *
 * Returned without surrounding markers — `applyMarkerBlock` adds them.
 */
export function buildAgentsMdBody(): string {
  return [
    "## artgraph — Cross-agent traceability",
    "",
    "artgraph manages the trace lock and provides 8 Skills for spec ↔ code ↔ test traceability.",
    "",
    "### Available Skills",
    "",
    "- `artgraph-setup` — install artgraph in this project",
    "- `artgraph-detect` — report artgraph installation state",
    "- `artgraph-integrate` — wire artgraph into Spec Kit / Kiro",
    "- `artgraph-impact` — file/symbol → REQs impact",
    "- `artgraph-plan-coverage` — reverse audit of tasks.md / plan.md",
    "- `artgraph-coverage` — per-REQ coverage status",
    "- `artgraph-verify` — `artgraph check --diff` self-check",
    "- `artgraph-rename` — safe rename / split / merge of REQ IDs",
    "",
    "See `<agent_skills_path>/<skill-name>/SKILL.md` for each Skill's full description (where `<agent_skills_path>` is `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.kiro/skills/` depending on your agent).",
    "",
    "### Common workflows",
    "",
    "- After editing `tasks.md` / `plan.md`: run **artgraph-plan-coverage** to catch implicit REQ impacts.",
    "- Before review: run **artgraph-verify** (`artgraph check --diff`).",
    "- When proposing a code change: invoke **artgraph-impact** with `path:symbol`.",
    "",
    "### Quickstart",
    "",
    "```bash",
    "artgraph init --agents=<list>          # provision Skills + agent-context",
    "artgraph doctor                        # diagnose distribution health",
    "```",
    "",
    "For full CLI reference, run `artgraph --help` or see https://github.com/ShintaroMorimoto/artgraph.",
  ].join("\n");
}

export interface WriteResult {
  /** True iff the file content was changed on disk. */
  written: boolean;
  /** Absolute path of the target file. */
  path: string;
}

/**
 * Write (or refresh) the artgraph block inside `<rootDir>/AGENTS.md`. Returns
 * `written: false` when the on-disk content already matches the desired
 * output — guarantees idempotency across repeated `artgraph init` runs
 * (FR-005, SC-003 invariant: AGENTS.md sha256 stable when nothing changed).
 *
 * Writes are atomic (tmp + rename) via `atomicWriteFile`, the same primitive
 * used by integrate providers — see `src/integrate/atomic-write.ts`.
 */
export function writeAgentsMd(rootDir: string): WriteResult {
  const absPath = resolve(rootDir, "AGENTS.md");
  return writeMarkerFile(absPath, buildAgentsMdBody());
}

// ---------------------------------------------------------------------------
// Wrapper body builders + writer (T020)
// ---------------------------------------------------------------------------

/**
 * CLAUDE.md wrapper body. Repo-root relative link (`./AGENTS.md`) plus the
 * `@AGENTS.md` literal so Claude Code expands AGENTS.md natively (R6).
 *
 * Intentionally short — SC-003 requires the wrapper to NOT duplicate AGENTS.md
 * body. The Markdown link is for human reviewers; the `@AGENTS.md` line is
 * the load directive.
 */
export function buildClaudeWrapperBody(): string {
  return [
    "## artgraph",
    "",
    "See [AGENTS.md](./AGENTS.md) for cross-agent artgraph instructions.",
    "",
    "@AGENTS.md",
  ].join("\n");
}

/**
 * `.github/copilot-instructions.md` wrapper body. Same shape as the Claude
 * wrapper but uses `../AGENTS.md` (the wrapper lives one directory below the
 * repo root). `@AGENTS.md` is plain text for Copilot but still acts as a
 * documented load directive — Copilot auto-loads AGENTS.md natively (R6).
 */
export function buildCopilotWrapperBody(): string {
  return [
    "## artgraph",
    "",
    "See [AGENTS.md](../AGENTS.md) for cross-agent artgraph instructions.",
    "",
    "@AGENTS.md",
  ].join("\n");
}

/**
 * Write (or refresh) the artgraph wrapper file for `agentId`. Returns
 * `written: false` when no on-disk change is needed (idempotent).
 *
 *   - `claude`  → `<rootDir>/CLAUDE.md`
 *   - `copilot` → `<rootDir>/.github/copilot-instructions.md` (mkdir -p
 *                 `.github/` if missing)
 *
 * Marker-bounded write preserves any user content outside the block — see
 * `applyMarkerBlock` for the exact contract.
 */
export function writeWrapper(rootDir: string, agentId: "claude" | "copilot"): WriteResult {
  const relPath = agentId === "claude" ? "CLAUDE.md" : ".github/copilot-instructions.md";
  const body = agentId === "claude" ? buildClaudeWrapperBody() : buildCopilotWrapperBody();
  const absPath = resolve(rootDir, relPath);

  // For the copilot wrapper, `.github/` may not exist yet — create it
  // before any read attempt so writeMarkerFile's atomic rename has a target
  // directory. mkdirSync recursive is a no-op when the directory already
  // exists, so this is safe to call unconditionally for both agents.
  const parent = dirname(absPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  return writeMarkerFile(absPath, body);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Shared write path for AGENTS.md and the two wrappers. Reads the existing
 * file (treating ENOENT as empty content), recomputes the marker-bounded
 * output, and only writes when the bytes actually differ — guarantees byte-
 * stable idempotency on repeated runs.
 */
function writeMarkerFile(absPath: string, body: string): WriteResult {
  const existing = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
  const { newContent } = applyMarkerBlock(existing, body);
  if (newContent === existing) {
    return { written: false, path: absPath };
  }
  atomicWriteFile(absPath, newContent);
  return { written: true, path: absPath };
}
