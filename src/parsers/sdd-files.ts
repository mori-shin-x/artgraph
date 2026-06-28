// Two-stage file-path / symbol extractor for `tasks.md` / `plan.md` (spec 016).
//
// Stage A — `Files:` section: structured, trusted (human-authored). Each entry
// is parsed as either a `path:symbol` symbol-unit declaration or a path-only
// file-unit declaration (FR-001/FR-002, spec 016 R-003). The author may
// declare a brand-new file that the upcoming task will create; we surface
// unresolved entries as `unresolvedFilePath` / `unresolvedSymbol` diagnostics
// so typos / scan-mode mismatches don't silently fall through.
//
// Stage B — regex fallback: free-text scan, untrusted. Only accept candidates
// that exist in the graph or on the filesystem so README boilerplate like
// `node_modules/foo.js` or `<img src="logo.png">` doesn't seed a phantom
// impact start point. Stage B never assigns a `symbol` (FR-006).
//
// The contract is documented in
// `specs/016-impact-plan-symbol-level/contracts/sdd-files-parser.md`.
// Edge cases there are mirrored 1:1 in tests/sdd-files-parser.test.ts.

import { existsSync } from "node:fs";
import { relative, resolve as resolvePath, sep } from "node:path";
import type { ArtifactGraph } from "../types.js";

/**
 * spec 016 (FR-001 / R-001 / R-002) — Stage A `Files:` entry. `symbol === undefined`
 * encodes a file-unit declaration (`Files: src/a.ts`); a defined `symbol`
 * encodes a symbol-unit declaration (`Files: src/a.ts:fn1`). `line` is the
 * 1-based source line of the Stage A entry (header or bullet).
 */
export interface SymbolEntry {
  path: string;
  symbol?: string;
  line: number;
}

export type Diagnostic =
  | {
      /**
       * Stage A surfaced a path it could not resolve against either the graph
       * or the working tree. The entry is still kept in `entries` (Stage A
       * trusts the author's explicit declaration); the diagnostic exists so a
       * typo is visible.
       */
      kind: "unresolvedFilePath";
      path: string;
      /** 1-based line number of the offending header or bullet. */
      line: number;
    }
  | {
      /**
       * spec 016 (FR-004, R-009, INV-S1) — Stage A `path:symbol` syntax where
       * the path is registered (graph node or fs file) but the symbol is not
       * registered in the graph (no `symbol:<path>#<symbol>` node). Per-entry
       * exclusive with `unresolvedFilePath` (path miss takes precedence).
       */
      kind: "unresolvedSymbol";
      sourceFile: string;
      symbol: string;
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
  /**
   * spec 016 (FR-007, R-001) — canonical Stage A / Stage B entries. Each
   * entry is `{ path, symbol?, line }`. Input order is preserved within a
   * stage; `(path, symbol ?? null)` is dedup'd. Stage B (regex fallback)
   * never assigns a symbol. When neither stage matches `entries === []` and
   * `stage === "empty"`.
   *
   * `files: string[]` is intentionally absent. Callers that need a file-only
   * view derive it from `entries.map(e => e.path)` and dedup themselves.
   */
  entries: SymbolEntry[];
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
// spec 016 (R-003): `path:symbol` syntax. group 1 = path (extension required,
// no `:`/whitespace); group 2 = symbol (no whitespace / commas / parens; the
// `:` between groups is the first `:` in the entry and consumed once — any
// further `:` falls into the symbol body per FR-005). The extension
// requirement keeps tokens like `REQ-003` from being mis-detected as paths.
const PATH_SYMBOL_RE = /^([^:\s]+\.[\w]+):([^\s,()]+)$/;
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
 * without admitting it to `entries[]`). A trailing `/` (directory marker) is
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
  entries: SymbolEntry[];
  diagnostics: Diagnostic[];
}

function runStageA(lines: string[], options: ExtractOptions): StageAExtraction {
  const accepted: SymbolEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  // (path, symbol ?? null) dedup key to honor spec 016 R-001: same entry
  // declared multiple times yields a single SymbolEntry.
  const seenKeys = new Set<string>();
  const dedupKey = (path: string, symbol: string | undefined): string =>
    `${path} ${symbol ?? ""}`;

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
    const candidates: Array<{ raw: string; line: number }> = [];

    // Inline form: comma-separated tail on the header line itself.
    const inlineTail = header[1].trim();
    if (inlineTail !== "") {
      const stripped = stripTrailingInlinePunct(inlineTail);
      for (const piece of stripped.split(",")) {
        const v = stripTrailingAnnotation(piece.trim());
        if (v !== "") candidates.push({ raw: v, line: i + 1 });
      }
    }

    // Bullet form: `- path` / `* path` lines (nested bullets included; depth
    // is intentionally ignored per contract).
    for (let j = scopeStart; j < scopeEnd; j++) {
      const m = BULLET_RE.exec(lines[j]);
      if (!m) continue;
      const v = stripTrailingAnnotation(m[1].trim());
      if (v !== "") candidates.push({ raw: v, line: j + 1 });
    }

    for (const { raw, line } of candidates) {
      // spec 016 (R-003, FR-001/002/005): split `path:symbol` after the
      // annotation strip but before any further validation. The regex
      // demands an extension on the path, so non-path tokens (`REQ-003`)
      // don't match and fall through to the path-only branch as `raw`.
      const symMatch = PATH_SYMBOL_RE.exec(raw);
      const rawPath = symMatch ? symMatch[1] : raw;
      const symbol = symMatch ? symMatch[2] : undefined;

      if (isAbsolutePath(rawPath)) {
        // Absolute paths are dropped from `entries[]` but surfaced as a
        // diagnostic so the author can correct them. Symbol miss is not
        // reported (path miss takes precedence, INV-S1).
        diagnostics.push({ kind: "unresolvedFilePath", path: rawPath, line });
        continue;
      }
      // Normalize `./foo` / `foo/../bar` so the downstream graph lookup
      // (which keys on canonical repo-relative paths like `src/foo.ts`)
      // doesn't miss. Paths that escape the repo are rejected.
      const normalized = normalizeStagePath(rawPath, options.repoRoot);
      if (normalized === null) {
        diagnostics.push({ kind: "unresolvedFilePath", path: rawPath, line });
        continue;
      }

      const key = dedupKey(normalized, symbol);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      accepted.push({ path: normalized, symbol, line });

      // Soft validation. Path-side first: if the path is neither registered
      // in the graph nor present on disk, surface a typo warning and skip
      // the symbol check (INV-S1: per-entry exclusive).
      const inGraph = options.graph.nodes.has(`file:${normalized}`);
      const onFs = existsSync(resolvePath(options.repoRoot, normalized));
      if (!inGraph && !onFs) {
        diagnostics.push({ kind: "unresolvedFilePath", path: normalized, line });
        continue;
      }
      // Path OK: when a symbol is present, verify it resolves to a
      // graph-registered `symbol:<path>#<name>` node (spec 016 FR-004).
      if (symbol !== undefined) {
        const symId = `symbol:${normalized}#${symbol}`;
        if (!options.graph.nodes.has(symId)) {
          diagnostics.push({
            kind: "unresolvedSymbol",
            sourceFile: normalized,
            symbol,
            line,
          });
        }
      }
    }

    // Jump past the consumed scope — Stage A scopes never overlap.
    i = scopeEnd;
  }

  return { entries: accepted, diagnostics };
}

function runStageB(text: string, options: ExtractOptions): SymbolEntry[] {
  // Stage B is strict: only candidates that we can verify (graph node OR
  // on disk relative to repoRoot) are accepted. This is what filters out
  // URLs (`https://...` → the regex picks up `//example.com/foo.md` which
  // doesn't exist) and HTML attribute values (`<img src="logo.png">` → no
  // such file in repo). symbol detection is intentionally disabled here
  // (FR-006): free-text scans are too noisy to interpret `:name` tails
  // reliably (URLs, ports, etc.).
  const seen = new Set<string>();
  const accepted: SymbolEntry[] = [];
  for (const match of text.matchAll(STAGE_B_PATTERN)) {
    const candidate = match[0];
    if (seen.has(candidate)) continue;
    const inGraph = options.graph.nodes.has(`file:${candidate}`);
    // `path.resolve` returns `candidate` unchanged when it's already absolute,
    // so this works uniformly for both relative and absolute candidates.
    const onFs = existsSync(resolvePath(options.repoRoot, candidate));
    if (!inGraph && !onFs) continue;
    seen.add(candidate);
    // 1-based line number of the first occurrence of `candidate` so callers
    // can point users at the right span. `text.indexOf` is enough — we only
    // care about the first hit.
    const idx = match.index ?? text.indexOf(candidate);
    const line = idx === -1 ? 1 : text.slice(0, idx).split("\n").length;
    accepted.push({ path: candidate, line });
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

  if (stageA.entries.length > 0) {
    return {
      entries: stageA.entries,
      stage: "files-section",
      diagnostics: stageA.diagnostics,
      taskBlocks,
    };
  }

  // Stage A produced no usable entries — fall through to the regex scan.
  // Stage A's diagnostics (e.g. for skipped absolute paths) are preserved
  // so the caller still sees the typo warning even when no fallback hits.
  const stageBEntries = runStageB(text, options);
  if (stageBEntries.length > 0) {
    return {
      entries: stageBEntries,
      stage: "regex-fallback",
      diagnostics: stageA.diagnostics,
      taskBlocks,
    };
  }

  return {
    entries: [],
    stage: "empty",
    diagnostics: stageA.diagnostics,
    taskBlocks,
  };
}
