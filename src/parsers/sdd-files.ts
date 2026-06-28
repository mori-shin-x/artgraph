// Two-stage file-path extractor for `tasks.md` / `plan.md` (spec 014).
//
// Stage A — `Files:` section: structured, trusted (human-authored). Accept the
// path even when not yet on disk (the author may be declaring a brand-new file
// that the upcoming task will create), and surface unresolved entries as
// `unresolvedFilePath` diagnostics so a typo doesn't go unnoticed.
//
// Stage B — regex fallback: free-text scan, untrusted. Only accept candidates
// that exist in the graph or on the filesystem so README boilerplate like
// `node_modules/foo.js` or `<img src="logo.png">` doesn't seed a phantom
// impact start point.
//
// The contract is documented in
// `specs/014-reinvent-impact-cli/contracts/sdd-files-parser.md`.
// Edge cases there are mirrored 1:1 in tests/sdd-files-parser.test.ts.

import { existsSync } from "node:fs";
import { relative, resolve as resolvePath, sep } from "node:path";
import type { ArtifactGraph } from "../types.js";

export type Diagnostic = {
  /**
   * Stage A surfaced a path it could not resolve against either the graph or
   * the working tree. The path is still kept in `files` (Stage A trusts the
   * author's explicit declaration); the diagnostic exists so a typo is visible.
   */
  kind: "unresolvedFilePath";
  path: string;
  /** 1-based line number of the offending header or bullet. */
  line: number;
};

/**
 * spec 014 (US1 / FR-018) — Task block surface info for `plan-coverage
 * --require-files-section`. Populated only when the input text has heading-
 * delimited task blocks (e.g. `### T013: ...`). Each entry records whether
 * the block declares a `Files:` section so the caller can emit a
 * `missingFilesSection` diagnostic. `taskId` is captured from the heading
 * line via a heuristic regex; if the regex doesn't match (the block has a
 * heading but no T-id prefix) the entry is omitted.
 */
export interface TaskBlock {
  /** Task ID parsed from the heading (e.g. `T013`). */
  taskId: string;
  /** 1-based line number of the heading. */
  line: number;
  /** True if a `Files:` section was found inside the block scope. */
  hasFilesSection: boolean;
}

export type ExtractResult = {
  /** dedup + sort 済み — both stages return a stable, lexicographic order. */
  files: string[];
  stage: "files-section" | "regex-fallback" | "empty";
  diagnostics: Diagnostic[];
  /**
   * spec 014: heading-delimited task blocks and their `Files:` status. Empty
   * array when the input has no `### T<NNN>` headings (e.g. plan.md or a
   * tasks.md that uses a different convention).
   */
  taskBlocks?: TaskBlock[];
};

export interface ExtractOptions {
  graph: ArtifactGraph;
  /** Absolute repo root used to resolve relative paths for `fs.existsSync`. */
  repoRoot: string;
}

// Header is line-anchored and **case-sensitive** (`Files:`). Per contract:
// `files:` / `FILES:` / `File:` are intentionally rejected to keep the
// grammar narrow and the parser simple.
const HEADER_RE = /^Files:[ \t]*(.*)$/;
// Next markdown heading terminates the Stage A scope; together with the
// two-consecutive-blank-lines rule it keeps `Files:` extraction inside one
// task block (e.g. `### T013`).
const HEADING_RE = /^#+\s/;
const BULLET_RE = /^\s*[-*]\s+(.+?)\s*$/;
// Trailing-only `(...)` annotation (e.g. ` (new)` / ` (deleted)`). Anchored
// with `$` so a path that legitimately contains `(...)` mid-string is left
// alone (no real path does, but the safety is free).
const TRAILING_ANNOTATION_RE = /\s*\([^)]*\)\s*$/;
// Stage B path-shaped token. The boundary lookarounds keep us from biting
// into a longer continuous path-char run on either side (so we don't, e.g.,
// pull `b.ts` out of `src/b.ts`). The `\.\w+` tail rules out extensionless
// words like `README` or bare identifiers.
//
// Recreated per-call (instead of a module-level `/g` regex) so we don't have
// to micromanage `lastIndex` between invocations of `extractFiles`.
const STAGE_B_PATTERN = /(?<![\w./-])[\w./-]+\.\w+(?![\w./-])/g;

function isAbsolutePath(path: string): boolean {
  // POSIX-style absolute path. We don't try to detect Windows drive-letter
  // paths (`C:\...`) — the SDD tooling we target (Spec Kit / Kiro) targets
  // POSIX paths in `Files:` sections, and a stray Windows path would fall
  // through to the Stage A `unresolvedFilePath` typo warning anyway.
  return path.startsWith("/");
}

/**
 * Stage A path normalization. Resolves `./`, `../`, and intermediate
 * `foo/../bar` segments against `repoRoot` and re-emits the result as a
 * POSIX-separated, repo-relative path. Returns `null` when the resulting
 * path escapes the repo (so the caller can flag it as `unresolvedFilePath`
 * without admitting it to `files[]`). A trailing `/` (directory marker) is
 * preserved per contract — `path.relative` strips it.
 */
function normalizeStagePath(path: string, repoRoot: string): string | null {
  const trailingSlash = path.endsWith("/") || path.endsWith(`${sep}`);
  const abs = resolvePath(repoRoot, path);
  const rel = relative(repoRoot, abs);
  if (rel.length === 0) return trailingSlash ? "./" : ".";
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  const posix = rel.split(sep).join("/");
  return trailingSlash ? `${posix}/` : posix;
}

function stripTrailingInlinePunct(s: string): string {
  // Strip a single trailing `.` or `;` from the *inline tail* before splitting
  // on `,`. This is meant to absorb sentence-end punctuation like
  // `Files: a.ts, b.ts.` without nibbling at file extensions (the `.ts` of
  // each individual item is preserved because we run this on the whole tail,
  // not on each comma-separated piece).
  return s.replace(/[.;]\s*$/, "");
}

function stripTrailingAnnotation(s: string): string {
  return s.replace(TRAILING_ANNOTATION_RE, "").trim();
}

interface StageAExtraction {
  files: string[];
  diagnostics: Diagnostic[];
}

function runStageA(lines: string[], options: ExtractOptions): StageAExtraction {
  const accepted: string[] = [];
  const diagnostics: Diagnostic[] = [];

  let i = 0;
  while (i < lines.length) {
    const header = HEADER_RE.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }

    // Determine the scope: from the line after the header up to (exclusive)
    // either the next markdown heading, or the second of two consecutive
    // blank lines. Whichever comes first wins.
    const scopeStart = i + 1;
    let scopeEnd = lines.length;
    let blankRun = 0;
    for (let j = scopeStart; j < lines.length; j++) {
      const line = lines[j];
      if (HEADING_RE.test(line)) {
        scopeEnd = j;
        break;
      }
      if (line.trim() === "") {
        blankRun++;
        if (blankRun >= 2) {
          scopeEnd = j;
          break;
        }
      } else {
        blankRun = 0;
      }
    }

    // candidates carry their source line (1-based) so a diagnostic emitted
    // later can pinpoint the offending entry instead of just the section.
    const candidates: Array<{ path: string; line: number }> = [];

    // Inline form: comma-separated tail on the header line itself.
    const inlineTail = header[1].trim();
    if (inlineTail !== "") {
      const stripped = stripTrailingInlinePunct(inlineTail);
      for (const piece of stripped.split(",")) {
        const v = stripTrailingAnnotation(piece.trim());
        if (v !== "") candidates.push({ path: v, line: i + 1 });
      }
    }

    // Bullet form: `- path` / `* path` lines (nested bullets included; depth
    // is intentionally ignored per contract).
    for (let j = scopeStart; j < scopeEnd; j++) {
      const m = BULLET_RE.exec(lines[j]);
      if (!m) continue;
      const v = stripTrailingAnnotation(m[1].trim());
      if (v !== "") candidates.push({ path: v, line: j + 1 });
    }

    for (const { path, line } of candidates) {
      if (isAbsolutePath(path)) {
        // Absolute paths are dropped from `files[]` but surfaced as a
        // diagnostic so the author can correct them.
        diagnostics.push({ kind: "unresolvedFilePath", path, line });
        continue;
      }
      // Normalize `./foo` / `foo/../bar` so the downstream graph lookup
      // (which keys on canonical repo-relative paths like `src/foo.ts`)
      // doesn't miss. Paths that escape the repo are rejected.
      const normalized = normalizeStagePath(path, options.repoRoot);
      if (normalized === null) {
        diagnostics.push({ kind: "unresolvedFilePath", path, line });
        continue;
      }
      accepted.push(normalized);
      // Soft validation: if the path is neither registered in the graph nor
      // present on disk, surface a typo warning. The path is still accepted.
      const inGraph = options.graph.nodes.has(`file:${normalized}`);
      const onFs = existsSync(resolvePath(options.repoRoot, normalized));
      if (!inGraph && !onFs) {
        diagnostics.push({ kind: "unresolvedFilePath", path: normalized, line });
      }
    }

    // Jump past the consumed scope — Stage A scopes never overlap.
    i = scopeEnd;
  }

  return { files: accepted, diagnostics };
}

function runStageB(text: string, options: ExtractOptions): string[] {
  // Stage B is strict: only candidates that we can verify (graph node OR
  // on disk relative to repoRoot) are accepted. This is what filters out
  // URLs (`https://...` → the regex picks up `//example.com/foo.md` which
  // doesn't exist) and HTML attribute values (`<img src="logo.png">` → no
  // such file in repo).
  const candidates = new Set<string>();
  for (const match of text.matchAll(STAGE_B_PATTERN)) {
    candidates.add(match[0]);
  }

  const accepted: string[] = [];
  for (const candidate of candidates) {
    const inGraph = options.graph.nodes.has(`file:${candidate}`);
    // `path.resolve` returns `candidate` unchanged when it's already absolute,
    // so this works uniformly for both relative and absolute candidates.
    const onFs = existsSync(resolvePath(options.repoRoot, candidate));
    if (inGraph || onFs) accepted.push(candidate);
  }
  return accepted;
}

// spec 014 — heuristic to detect `### T013: ...` style task headings. The
// `T` prefix is optional so both spec-kit (T001) and numeric-only / dotted
// IDs (1, 1.1, 2.3.4) work. Heading depth (`#`, `##`, `###`, ...) is not
// constrained — tasks.md authors place T-IDs at varied levels.
const TASK_HEADING_RE = /^#+\s+(T?\d+(?:\.\d+)*)\b/;

function extractTaskBlocks(lines: string[]): TaskBlock[] {
  // Build the list of `(line, taskId)` headings first, then for each
  // heading scan its scope (up to the next heading) for a `Files:` line.
  // The scope rule is the same as Stage A so the two stay in lockstep.
  const blocks: TaskBlock[] = [];
  const headingPositions: Array<{ index: number; taskId: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_HEADING_RE.exec(lines[i]);
    if (m) headingPositions.push({ index: i, taskId: m[1] });
  }

  for (let k = 0; k < headingPositions.length; k++) {
    const { index, taskId } = headingPositions[k];
    // Scope: from the line after the heading to (exclusive) the next
    // markdown heading of any depth.
    let scopeEnd = lines.length;
    for (let j = index + 1; j < lines.length; j++) {
      if (HEADING_RE.test(lines[j])) {
        scopeEnd = j;
        break;
      }
    }
    let hasFilesSection = false;
    for (let j = index + 1; j < scopeEnd; j++) {
      if (HEADER_RE.test(lines[j])) {
        hasFilesSection = true;
        break;
      }
    }
    blocks.push({ taskId, line: index + 1, hasFilesSection });
  }

  return blocks;
}

export function extractFiles(text: string, options: ExtractOptions): ExtractResult {
  const lines = text.split("\n");
  const stageA = runStageA(lines, options);
  const taskBlocks = extractTaskBlocks(lines);

  if (stageA.files.length > 0) {
    return {
      files: Array.from(new Set(stageA.files)).sort(),
      stage: "files-section",
      diagnostics: stageA.diagnostics,
      taskBlocks,
    };
  }

  // Stage A produced no usable files — fall through to the regex scan.
  // Stage A's diagnostics (e.g. for skipped absolute paths) are preserved
  // so the caller still sees the typo warning even when no fallback hits.
  const stageBFiles = runStageB(text, options);
  if (stageBFiles.length > 0) {
    return {
      files: Array.from(new Set(stageBFiles)).sort(),
      stage: "regex-fallback",
      diagnostics: stageA.diagnostics,
      taskBlocks,
    };
  }

  return {
    files: [],
    stage: "empty",
    diagnostics: stageA.diagnostics,
    taskBlocks,
  };
}
