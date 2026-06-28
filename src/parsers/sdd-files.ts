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
import { resolve as resolvePath } from "node:path";
import type { ArtifactGraph } from "../types.js";

export type Diagnostic = {
  /**
   * Stage A surfaced a path it could not resolve against either the graph or
   * the working tree. The path is still kept in `files` (Stage A trusts the
   * author's explicit declaration); the diagnostic exists so a typo is visible.
   */
  kind: "unresolvedFilePath";
  path: string;
};

export type ExtractResult = {
  /** dedup + sort 済み — both stages return a stable, lexicographic order. */
  files: string[];
  stage: "files-section" | "regex-fallback" | "empty";
  diagnostics: Diagnostic[];
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

    const candidates: string[] = [];

    // Inline form: comma-separated tail on the header line itself.
    const inlineTail = header[1].trim();
    if (inlineTail !== "") {
      const stripped = stripTrailingInlinePunct(inlineTail);
      for (const piece of stripped.split(",")) {
        const v = stripTrailingAnnotation(piece.trim());
        if (v !== "") candidates.push(v);
      }
    }

    // Bullet form: `- path` / `* path` lines (nested bullets included; depth
    // is intentionally ignored per contract).
    for (let j = scopeStart; j < scopeEnd; j++) {
      const m = BULLET_RE.exec(lines[j]);
      if (!m) continue;
      const v = stripTrailingAnnotation(m[1].trim());
      if (v !== "") candidates.push(v);
    }

    for (const path of candidates) {
      if (isAbsolutePath(path)) {
        // Absolute paths are dropped from `files[]` but surfaced as a
        // diagnostic so the author can correct them.
        diagnostics.push({ kind: "unresolvedFilePath", path });
        continue;
      }
      accepted.push(path);
      // Soft validation: if the path is neither registered in the graph nor
      // present on disk, surface a typo warning. The path is still accepted.
      const inGraph = options.graph.nodes.has(`file:${path}`);
      const onFs = existsSync(resolvePath(options.repoRoot, path));
      if (!inGraph && !onFs) {
        diagnostics.push({ kind: "unresolvedFilePath", path });
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

export function extractFiles(text: string, options: ExtractOptions): ExtractResult {
  const lines = text.split("\n");
  const stageA = runStageA(lines, options);

  if (stageA.files.length > 0) {
    return {
      files: Array.from(new Set(stageA.files)).sort(),
      stage: "files-section",
      diagnostics: stageA.diagnostics,
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
    };
  }

  return {
    files: [],
    stage: "empty",
    diagnostics: stageA.diagnostics,
  };
}
