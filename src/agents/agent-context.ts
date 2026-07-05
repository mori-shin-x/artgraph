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
// Concurrency: every writer here is atomic (tmp + rename) but does NOT
// coordinate concurrent `artgraph init` runs on the same file. Two processes
// racing on AGENTS.md / a wrapper file follow last-writer-wins semantics; an
// interleaved user editor save between one process's read and write can be
// silently overwritten. Callers must serialize concurrent runs on the same
// project root — see B8 in the PR #114 review.
//
// `src/init.ts` wires these helpers in T021. `tests/agent-context.test.ts`
// (T022) exercises every export at the unit level.

import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "../integrate/atomic-write.js";
import { execPrefix, type PackageManager } from "../package-manager.js";
import { renderTemplate } from "../template.js";
import type { AgentDescriptor } from "./descriptors.js";

// `templates/agent-context/` lives next to `dist/` (tsc preserves the
// directory layout, so this module compiles to `dist/agents/agent-context.js`
// — two levels below the package root). Same convention as
// SKILLS_TEMPLATE_DIR / HOOKS_TEMPLATE_PATH in src/init.ts.
const AGENTS_MD_TEMPLATE_PATH = resolve(
  import.meta.dirname,
  "../../templates/agent-context/agents-md-snippet.md",
);

// ---------------------------------------------------------------------------
// Marker block (T018)
// ---------------------------------------------------------------------------

/** Literal opening marker (canonical / lowercase). Writers always emit this. */
export const MARKER_BEGIN = "<!-- artgraph:begin -->";
/** Literal closing marker (canonical / lowercase). Writers always emit this. */
export const MARKER_END = "<!-- artgraph:end -->";

/**
 * Thrown by {@link applyMarkerBlock} when the input file contains a stray
 * `<!-- artgraph:begin -->` (or `end`) line but no matched pair. Silently
 * appending in that state would grow half-broken markers into an unrecoverable
 * lazy-match span on the next round (see PR #114 finding A3).
 *
 * Callers that want to self-heal should surface the message and hint the user
 * to run `artgraph doctor` for a per-file diagnosis.
 */
export class MarkerBlockCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkerBlockCorruptError";
  }
}

// Line-anchored (multiline) so prose or code-fence occurrences of the literal
// marker string cannot silently absorb user text between them (A1). The `i`
// flag self-heals IDE autocorrect that title-cases the marker into
// `<!-- artgraph:Begin -->` / `<!-- artgraph:End -->` (OPS-9). Trailing
// `\r?$` keeps CRLF line endings well-behaved (Windows / git autocrlf).
const MARKER_RE = /^<!--\s*artgraph:begin\s*-->[\s\S]*?<!--\s*artgraph:end\s*-->\r?$/im;
/** Global variant for enumeration / duplicate-block detection (A2). */
const MARKER_RE_GLOBAL = /^<!--\s*artgraph:begin\s*-->[\s\S]*?<!--\s*artgraph:end\s*-->\r?$/gim;

/** Begin/end discovery regexes for the `inspectMarkerBlock` diagnostic. */
const BEGIN_RE = /^<!--\s*artgraph:begin\s*-->\r?$/im;
const END_RE = /^<!--\s*artgraph:end\s*-->\r?$/im;

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
 *   - If a single marker block is present, it is replaced in-place. Anything
 *     outside the markers is preserved byte-for-byte (FR-009 / FR-010).
 *   - If MORE THAN ONE block is present (duplicate / stale copies), the first
 *     block is replaced with the canonical version and every subsequent block
 *     is removed. This self-heals the case where an IDE autocorrect or a
 *     stale append accidentally produced duplicates (A2 / OPS-9).
 *   - If a stray `<!-- artgraph:begin -->` or `<!-- artgraph:end -->` line
 *     lingers without a matched pair, {@link MarkerBlockCorruptError} is
 *     thrown. Silently appending would let the next round's lazy match
 *     swallow user prose between the stray marker and the newly appended
 *     canonical marker (A3).
 *   - Otherwise the block is appended at EOF. When the existing content is
 *     empty (or whitespace-only, BND-6) the leading `\n\n` separator is
 *     omitted so the new file does not begin with blank lines.
 *
 * `body` is inserted verbatim between `${MARKER_BEGIN}\n` and `\n${MARKER_END}`,
 * so callers must NOT pass the markers themselves.
 */
export function applyMarkerBlock(existingContent: string, body: string): MarkerBlockResult {
  const block = `${MARKER_BEGIN}\n${body}\n${MARKER_END}`;

  const allMatches = [...existingContent.matchAll(MARKER_RE_GLOBAL)];

  if (allMatches.length === 1) {
    return {
      found: true,
      newContent: existingContent.replace(MARKER_RE, block),
    };
  }

  if (allMatches.length > 1) {
    // Collapse duplicates to a single canonical block at the position of the
    // FIRST match. Iterate the trailing matches back-to-front so earlier
    // indices remain valid as we slice them out. Then rewrite the first
    // match with the canonical body.
    let result = existingContent;
    for (let i = allMatches.length - 1; i > 0; i--) {
      const m = allMatches[i];
      if (m.index === undefined) continue;
      const start = m.index;
      const end = start + m[0].length;
      result = result.slice(0, start) + result.slice(end);
    }
    result = result.replace(MARKER_RE, block);
    return { found: true, newContent: result };
  }

  // No matched pair. Refuse when a stray begin OR end lingers alone; the
  // next round would otherwise lazy-match through user prose (A3).
  if (BEGIN_RE.test(existingContent) || END_RE.test(existingContent)) {
    throw new MarkerBlockCorruptError(
      "artgraph marker block is corrupt: found a stray `<!-- artgraph:begin -->` " +
        "or `<!-- artgraph:end -->` line with no matching pair. Fix the markers " +
        "by hand, or run `artgraph doctor` for a per-file diagnosis.",
    );
  }

  // Treat any all-whitespace existingContent as empty for the append separator
  // (BND-6). Otherwise `"\n"` alone would produce three consecutive blank
  // lines at the head of the output.
  if (existingContent.trim().length === 0) {
    return { found: false, newContent: `${block}\n` };
  }

  return { found: false, newContent: `${existingContent}\n\n${block}\n` };
}

export interface MarkerBlockHealth {
  /** True iff at least one line-anchored `<!-- artgraph:begin -->` is present. */
  hasBegin: boolean;
  /** True iff at least one line-anchored `<!-- artgraph:end -->` is present. */
  hasEnd: boolean;
  /** True iff a complete begin/end pair (begin appearing before end) exists. */
  hasMatchedPair: boolean;
  /**
   * The body text between the markers when `hasMatchedPair` is true; `null`
   * otherwise. The body is returned without the surrounding newlines that
   * `applyMarkerBlock` adds around `${body}`. CRLF-safe.
   */
  bodyText: string | null;
}

/**
 * Diagnose the health of the marker block in `content`. Used by doctor
 * (`agents-md-marker-broken` finding) to distinguish "no block at all" from
 * "half-written / corrupted block".
 */
export function inspectMarkerBlock(content: string): MarkerBlockHealth {
  const hasBegin = BEGIN_RE.test(content);
  const hasEnd = END_RE.test(content);

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
      // inside the block intact. CRLF-safe via `\r?\n` (BND-5).
      bodyText = inner.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    }
  }

  return { hasBegin, hasEnd, hasMatchedPair, bodyText };
}

// ---------------------------------------------------------------------------
// AGENTS.md body builder + writer (T019)
// ---------------------------------------------------------------------------

/**
 * Canonical artgraph block body that lives inside AGENTS.md. Rendered from
 * `templates/agent-context/agents-md-snippet.md` (9 Skills + workflows +
 * quickstart — contracts/agent-context-format.md §AGENTS.md). The text is the
 * artgraph guide itself, NOT a wrapper.
 *
 * PM independence (#110): command examples embed the exec prefix for the
 * package manager detected at init time (`npx artgraph`, `pnpm exec artgraph`,
 * …) via `{{ARTGRAPH_EXEC}}`. `{{PM_NOTICE}}` renders a leading HTML comment
 * telling readers which PM the block was generated for and how to regenerate
 * after switching — the passive Default-Drift breadcrumb from #110; there is
 * no runtime drift warning.
 *
 * `detectedPm === null` (no lockfile / packageManager field) degrades to the
 * bare `artgraph` binary rather than skipping the stage — unlike the Stop
 * hook, prose guidance stays useful without a runnable exec prefix.
 *
 * Returned without surrounding markers — `applyMarkerBlock` adds them.
 * Throws when the packaged template is missing or references a variable not
 * supplied here (both are packaging faults, not user errors).
 */
export function buildAgentsMdBody(detectedPm: PackageManager | null): string {
  const exec = detectedPm === null ? "artgraph" : execPrefix(detectedPm);
  const notice =
    detectedPm === null
      ? "<!-- artgraph: no package manager was detected at init time; commands below assume a globally installed `artgraph`. After adding a lockfile, re-run `artgraph init --force` to regenerate this block. -->"
      : `<!-- artgraph: generated for packageManager=${detectedPm}. If you switch package managers, re-run \`${exec} init --force\` to regenerate this block. -->`;

  let raw: string;
  try {
    raw = readFileSync(AGENTS_MD_TEMPLATE_PATH, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `cannot read agent-context template at ${AGENTS_MD_TEMPLATE_PATH}: ` +
        `${err.message ?? String(e)} (broken artgraph installation — try reinstalling)`,
    );
  }

  // The template file ends with a POSIX trailing newline; strip exactly that
  // one so `applyMarkerBlock` (which wraps the body in `\n…\n`) does not
  // produce a blank line before the end marker.
  return renderTemplate(raw, { ARTGRAPH_EXEC: exec, PM_NOTICE: notice }).replace(/\n$/, "");
}

export interface WriteResult {
  /** True iff the file content was changed on disk. */
  written: boolean;
  /** Absolute path of the target file. */
  path: string;
}

// @impl 013-cross-agent-extensions/FR-005
/**
 * Write (or refresh) the artgraph block inside `<rootDir>/AGENTS.md`. Returns
 * `written: false` when the on-disk content already matches the desired
 * output — guarantees idempotency across repeated `artgraph init` runs
 * (FR-005, SC-003 invariant: AGENTS.md sha256 stable when nothing changed).
 *
 * Writes are atomic (tmp + rename) via `atomicWriteFile`, the same primitive
 * used by integrate providers — see `src/integrate/atomic-write.ts`.
 *
 * Contract note (OPS-7): the marker block is artgraph-managed and refreshed
 * idempotently on every call regardless of the top-level `--force` flag.
 * `--force` only gates user-drift Skill file overwrites in `distribute()`;
 * it does NOT gate the AGENTS.md / wrapper block bodies, which are always
 * treated as machine-owned canonical content.
 *
 * `detectedPm` selects the exec prefix embedded in the block's command
 * examples (see `buildAgentsMdBody`). A PM switch between runs therefore
 * surfaces as a normal body refresh (`written: true`) on the next init.
 */
export function writeAgentsMd(rootDir: string, detectedPm: PackageManager | null): WriteResult {
  const absPath = resolve(rootDir, "AGENTS.md");
  return writeMarkerFile(absPath, buildAgentsMdBody(detectedPm));
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

// @impl 013-cross-agent-extensions/FR-006 013-cross-agent-extensions/FR-007
/**
 * Write (or refresh) the artgraph wrapper file for `agentId`. Returns
 * `written: false` when no on-disk change is needed (idempotent).
 *
 *   - `claude`  → `<rootDir>/CLAUDE.md`         (FR-006 — `@AGENTS.md` のみ、本文の二重コピーなし)
 *   - `copilot` → `<rootDir>/.github/copilot-instructions.md` (FR-007 — 同上、`mkdir -p`
 *                 `.github/` if missing)
 *
 * Marker-bounded write preserves any user content outside the block — see
 * `applyMarkerBlock` for the exact contract.
 *
 * EOF-append convention (OUT-8): when the wrapper file already contains
 * user prose OUTSIDE the marker block, the artgraph block is appended at
 * end-of-file with a single blank-line separator. In IDE flows where the
 * whole wrapper is fed to the model as a prompt, this means the artgraph
 * section appears AFTER user-authored context; if load-order priority
 * matters for a particular agent, edit the wrapper by hand to move the
 * marker block above your prose — the writer only round-trips whatever
 * position it finds on the next run.
 *
 * Contract note (OPS-7): the marker block is artgraph-managed and refreshed
 * regardless of `--force`. `--force` gates user-drift Skill file overwrites
 * only, not the wrapper body.
 *
 * Failure rollback (A-adj-2): when the wrapper's parent directory
 * (`.github/` for copilot) had to be created by this call and the atomic
 * write then fails, the newly-created directory is `rmdir`'d so a partial
 * failure does not leave an orphan empty `.github/` on disk. Pre-existing
 * parents are left untouched.
 */
export function writeWrapper(rootDir: string, agentId: "claude" | "copilot"): WriteResult {
  const relPath = agentId === "claude" ? "CLAUDE.md" : ".github/copilot-instructions.md";
  const body = agentId === "claude" ? buildClaudeWrapperBody() : buildCopilotWrapperBody();
  const absPath = resolve(rootDir, relPath);

  // For the copilot wrapper, `.github/` may not exist yet — create it
  // before any read attempt so writeMarkerFile's atomic rename has a target
  // directory. mkdirSync recursive is a no-op when the directory already
  // exists, so this is safe to call unconditionally for both agents. We
  // remember whether the directory existed pre-call so a downstream failure
  // can roll it back (A-adj-2).
  const parent = dirname(absPath);
  const parentExisted = existsSync(parent);
  if (!parentExisted) {
    mkdirSync(parent, { recursive: true });
  }

  try {
    return writeMarkerFile(absPath, body);
  } catch (e) {
    if (!parentExisted) {
      // Roll back the parent dir we just created if it is still empty.
      // Best-effort: any concurrent writer that dropped a sibling file
      // here means we should leave the dir in place.
      try {
        rmdirSync(parent);
      } catch {
        /* swallow: dir may already be non-empty or removed */
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// .gitattributes writer (OPS-2 partial mitigation)
// ---------------------------------------------------------------------------

/**
 * Contents of the user-repo `.gitattributes` file that pins the Skill dist
 * tree to LF line endings. Windows git default (`core.autocrlf=true`) would
 * otherwise translate LF → CRLF on checkout, and the LF-hashed doctor check
 * would silently `skill-file-drift` FAIL every SKILL.md.
 */
const GITATTRIBUTES_CONTENT = "** text eol=lf\n";

/**
 * Write (or refresh) `<rootDir>/<descriptor.skillsPath>/.gitattributes` with
 * the canonical `** text eol=lf` directive. Returns `written: false` when
 * the on-disk contents already match (idempotent).
 *
 * Motivation (OPS-2): git for Windows defaults to `core.autocrlf=true`; the
 * distributed SKILL.md files are LF and the doctor hash check is against the
 * LF originals. Without a pinned `.gitattributes` in the Skill dist tree,
 * every subsequent `git add` / `git checkout` in a Windows repo re-encodes
 * the files as CRLF and doctor reports every SKILL.md as `skill-file-drift`.
 *
 * Wired into `runInit` after every successful `distribute()` so each selected
 * agent's Skill dist tree carries a `.gitattributes` pinning `** text eol=lf`.
 * Writes atomically via `atomicWriteFile`.
 */
export function writeGitAttributes(rootDir: string, descriptor: AgentDescriptor): WriteResult {
  const absPath = resolve(rootDir, descriptor.skillsPath, ".gitattributes");

  // Parent may not exist on a fresh project (Skill dist tree not yet
  // populated). Create it so the atomic rename has a target dir.
  const parent = dirname(absPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  let existing: string | null = null;
  try {
    existing = readFileSync(absPath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw new Error(`cannot read existing file at ${absPath}: ${err.message ?? String(e)}`);
    }
  }

  if (existing === GITATTRIBUTES_CONTENT) {
    return { written: false, path: absPath };
  }
  atomicWriteFile(absPath, GITATTRIBUTES_CONTENT);
  return { written: true, path: absPath };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Shared write path for AGENTS.md and the two wrappers. Reads the existing
 * file (treating ENOENT as empty content), recomputes the marker-bounded
 * output, and only writes when the bytes actually differ — guarantees byte-
 * stable idempotency on repeated runs.
 *
 * Contract note (OPS-7): the block content is artgraph-managed and always
 * refreshed to match the canonical body on every call — `--force` at the
 * CLI layer does NOT gate this. Callers must not gate on it here.
 *
 * Error handling (A-adj-3): only `ENOENT` from `readFileSync` is treated as
 * "empty file, will create". `EACCES` / `EPERM` / `EISDIR` and other read
 * errors are re-thrown with the target path in the message so the CLI can
 * surface a specific error line instead of an opaque errno.
 */
function writeMarkerFile(absPath: string, body: string): WriteResult {
  let existing: string;
  try {
    existing = readFileSync(absPath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      existing = "";
    } else {
      throw new Error(`cannot read existing file at ${absPath}: ${err.message ?? String(e)}`);
    }
  }
  const { newContent } = applyMarkerBlock(existing, body);
  if (newContent === existing) {
    return { written: false, path: absPath };
  }
  atomicWriteFile(absPath, newContent);
  return { written: true, path: absPath };
}
