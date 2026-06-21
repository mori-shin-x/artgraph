// ── Types ────────────────────────────────────────────────────────────

export type ReferenceKind =
  | "spec-list-item"
  | "spec-heading"
  | "impl-tag"
  | "test-tag"
  | "frontmatter-depends-on"
  | "lock-key";

export interface RewriteChange {
  filePath: string;
  line: number;
  kind: ReferenceKind;
  before: string;
  after: string;
}

interface RewriteResult {
  content: string;
  changes: RewriteChange[];
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Escape a string for use inside a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex that matches `id` at a word-like boundary suitable for
 * ID tokens.  The ID may contain `/` (namespace-qualified) or `:` (doc:xxx),
 * so we cannot simply use `\b`.  Instead we assert that the character
 * immediately before/after the ID is NOT alphanumeric, `-`, `/`, or `:`.
 *
 * When the ID appears at the start/end of the string the assertion is
 * trivially satisfied.
 */
function idBoundaryRegex(id: string, flags: string = "g"): RegExp {
  const escaped = escapeRegExp(id);
  return new RegExp(
    `(?<![A-Za-z0-9_/:-])${escaped}(?![A-Za-z0-9_/:-])`,
    flags,
  );
}

// ── Rewriters ────────────────────────────────────────────────────────

/**
 * Rewrite spec list items such as:
 *   - REQ-001: description
 *   - **REQ-001**: description
 *
 * Matches the same patterns as the parser's LIST_ITEM_RE.
 */
export function rewriteSpecListItem(
  content: string,
  oldId: string,
  newId: string,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  // Pattern mirrors LIST_ITEM_RE = /^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/
  // but anchored to a markdown list prefix (`- ` or `* `) and targeting a
  // specific oldId.
  const escaped = escapeRegExp(oldId);
  const re = new RegExp(
    `^(\\s*[-*]\\s+)(\\*\\*)?${escaped}(\\*\\*)?(?=[:\\s])`,
  );

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (!match) continue;

    const before = lines[i];
    // Reconstruct with newId, preserving bold markers and prefix.
    const prefix = match[1];
    const boldOpen = match[2] ?? "";
    const boldClose = match[3] ?? "";
    lines[i] =
      prefix +
      boldOpen +
      newId +
      boldClose +
      lines[i].slice(match[0].length);

    changes.push({
      filePath: "",
      line: i + 1,
      kind: "spec-list-item",
      before,
      after: lines[i],
    });
  }

  return { content: lines.join("\n"), changes };
}

/**
 * Rewrite Kiro-style headings:
 *   ### Requirement 1: description
 *
 * Only applies when `oldId` is in the `Requirement-N` format.  The heading
 * text uses `Requirement N:` (space, not dash), so the rewriter converts
 * between the two representations.
 */
export function rewriteSpecHeading(
  content: string,
  oldId: string,
  newId: string,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  // Extract the numeric part from `Requirement-N`.
  const oldMatch = oldId.match(/^Requirement-(\d+)$/);
  if (!oldMatch) return { content, changes };
  const oldNum = oldMatch[1];

  // The new ID must also be Requirement-N for a heading rewrite to make sense.
  const newMatch = newId.match(/^Requirement-(\d+)$/);
  if (!newMatch) return { content, changes };
  const newNum = newMatch[1];

  // Matches `Requirement N:` inside a heading line (preceded by `#`s).
  const re = new RegExp(
    `^(#+\\s+)Requirement\\s+${escapeRegExp(oldNum)}(\\s*:)`,
  );

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (!match) continue;

    const before = lines[i];
    lines[i] = match[1] + "Requirement " + newNum + match[2] + lines[i].slice(match[0].length);

    changes.push({
      filePath: "",
      line: i + 1,
      kind: "spec-heading",
      before,
      after: lines[i],
    });
  }

  return { content: lines.join("\n"), changes };
}

/**
 * Rewrite `// @impl REQ-001` and multi-ID variants like
 * `// @impl REQ-001 REQ-002`.
 *
 * Only the target `oldId` is replaced; other IDs on the same line are left
 * untouched.  Also handles `doc:xxx` IDs.
 */
export function rewriteImplTags(
  content: string,
  oldId: string,
  newId: string,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  // Detect @impl lines (mirrors IMPL_RE).
  const implLineRe = /\/\/[^\S\n]*@impl[^\S\n]+/;
  const idRe = idBoundaryRegex(oldId);

  for (let i = 0; i < lines.length; i++) {
    if (!implLineRe.test(lines[i])) continue;

    // Reset the regex (it has the `g` flag).
    idRe.lastIndex = 0;
    if (!idRe.test(lines[i])) continue;

    const before = lines[i];
    // Replace all occurrences of oldId on this line (there should normally
    // be at most one, but handle duplicates defensively).
    idRe.lastIndex = 0;
    lines[i] = lines[i].replace(idRe, newId);

    changes.push({
      filePath: "",
      line: i + 1,
      kind: "impl-tag",
      before,
      after: lines[i],
    });
  }

  return { content: lines.join("\n"), changes };
}

/**
 * Rewrite test tags:
 *   - `[REQ-001]` inside test description strings
 *   - `req: "REQ-001"` annotation patterns
 *
 * Mirrors TEST_REQ_RE and TEST_ANNOTATION_RE from the parser.
 */
export function rewriteTestTags(
  content: string,
  oldId: string,
  newId: string,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  const escaped = escapeRegExp(oldId);

  // Pattern 1: [REQ-001] — bracket-wrapped ID.
  const bracketRe = new RegExp(`\\[${escaped}\\]`, "g");

  // Pattern 2: req: "REQ-001" (or 'REQ-001').
  const annotationRe = new RegExp(
    `((?:req|requirement|spec):\\s*["'])${escaped}(["'])`,
    "gi",
  );

  for (let i = 0; i < lines.length; i++) {
    bracketRe.lastIndex = 0;
    annotationRe.lastIndex = 0;

    const hasBracket = bracketRe.test(lines[i]);
    const hasAnnotation = annotationRe.test(lines[i]);

    if (!hasBracket && !hasAnnotation) continue;

    const before = lines[i];

    bracketRe.lastIndex = 0;
    annotationRe.lastIndex = 0;

    if (hasBracket) {
      lines[i] = lines[i].replace(bracketRe, `[${newId}]`);
    }
    if (hasAnnotation) {
      lines[i] = lines[i].replace(annotationRe, `$1${newId}$2`);
    }

    changes.push({
      filePath: "",
      line: i + 1,
      kind: "test-tag",
      before,
      after: lines[i],
    });
  }

  return { content: lines.join("\n"), changes };
}

/**
 * Rewrite IDs inside YAML frontmatter (delimited by `---` lines):
 *   - `node_id: "doc:xxx"`
 *   - `id: "doc:xxx"` or `id: "REQ-001"` inside `depends_on` arrays
 *
 * Uses line-level string replacement to avoid YAML re-serialization and
 * the format changes it would introduce.
 */
export function rewriteFrontmatter(
  content: string,
  oldId: string,
  newId: string,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  // Locate frontmatter boundaries.
  let fmStart = -1;
  let fmEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      if (fmStart === -1) {
        fmStart = i;
      } else {
        fmEnd = i;
        break;
      }
    }
  }

  if (fmStart === -1 || fmEnd === -1) return { content, changes };

  const escaped = escapeRegExp(oldId);

  // Patterns to match inside frontmatter lines:
  //   node_id: "doc:xxx"  or  node_id: doc:xxx
  //   id: "REQ-001"       or  id: REQ-001
  const nodeIdRe = new RegExp(
    `^(\\s*node_id:\\s*["']?)${escaped}(["']?\\s*)$`,
  );
  const idRe = new RegExp(
    `^(\\s*(?:-\\s+)?id:\\s*["']?)${escaped}(["']?\\s*)$`,
  );

  for (let i = fmStart + 1; i < fmEnd; i++) {
    const nodeIdMatch = lines[i].match(nodeIdRe);
    const idMatch = lines[i].match(idRe);

    if (!nodeIdMatch && !idMatch) continue;

    const before = lines[i];
    const m = (nodeIdMatch ?? idMatch)!;
    lines[i] = m[1] + newId + m[2];

    changes.push({
      filePath: "",
      line: i + 1,
      kind: "frontmatter-depends-on",
      before,
      after: lines[i],
    });
  }

  return { content: lines.join("\n"), changes };
}

// ── Orchestrator ─────────────────────────────────────────────────────

/**
 * Apply the appropriate rewriters for the given file type and stamp each
 * returned `RewriteChange` with the provided `filePath`.
 */
export function rewriteFile(
  filePath: string,
  content: string,
  oldId: string,
  newId: string,
): RewriteResult {
  const ext = extOf(filePath);
  const allChanges: RewriteChange[] = [];
  let current = content;

  const apply = (fn: (c: string, o: string, n: string) => RewriteResult) => {
    const result = fn(current, oldId, newId);
    current = result.content;
    allChanges.push(...result.changes);
  };

  if (ext === ".md") {
    apply(rewriteSpecListItem);
    apply(rewriteSpecHeading);
    apply(rewriteFrontmatter);
  } else if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx"
  ) {
    apply(rewriteImplTags);
    apply(rewriteTestTags);
  }

  // Stamp filePath on every change.
  for (const change of allChanges) {
    change.filePath = filePath;
  }

  return { content: current, changes: allChanges };
}

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}
