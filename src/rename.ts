import type { ReqPatternConfig, TaskConventionPreset } from "./types.js";
import {
  BUILTIN_TASK_PRESETS,
  findFrontmatterBounds,
  maskInlineProtectedSpans,
} from "./parsers/markdown.js";
import { LIST_ITEM_RE, KIRO_HEADING_RE } from "./grammar/tokens.js";

// ── Types ────────────────────────────────────────────────────────────

export type ReferenceKind =
  | "spec-list-item"
  | "spec-heading"
  | "impl-tag"
  | "test-tag"
  | "frontmatter-depends-on"
  | "annotation-target"
  | "lock-key"
  // spec 020 T017 (FR-016) — a `testName`/`suitePath` REQ ID rewritten inside
  // a `.artgraph/trace/*.jsonl` shard (src/rename-trace.ts).
  | "trace-shard";

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

export interface RewriteOptions {
  reqPatterns?: ReqPatternConfig;
  // Active task conventions so the rewriter recognises `- [x] T001 ...` /
  // `- [x] 1.1 ...` etc. as definition lines. Without these the parser sees a
  // task definition but the rewriter doesn't, producing the half-applied
  // rename described in the PR meta-review (code-side @impl rewritten but
  // spec-side definition left untouched → orphans).
  taskConventions?: TaskConventionPreset[];
  disableBuiltinTaskConventions?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Escape a string for use inside a RegExp.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The file extension, lower-cased, including the leading dot ("" if none).
 */
export function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

/**
 * Build a regex that matches `id` at a word-like boundary suitable for
 * ID tokens.  The ID may contain `/` (namespace-qualified) or `:` (doc:xxx),
 * so we cannot simply use `\b`.  Instead we assert that the character
 * immediately before/after the ID is NOT alphanumeric, `-`, `/`, or `:`.
 */
function idBoundaryRegex(id: string, flags: string = "g"): RegExp {
  const escaped = escapeRegExp(id);
  return new RegExp(`(?<![A-Za-z0-9_/:-])${escaped}(?![A-Za-z0-9_/:-])`, flags);
}

/**
 * Return the set of 0-based line indices that fall *inside* fenced code
 * blocks (``` or ~~~), including the fence lines themselves. The markdown
 * parser treats fenced blocks as opaque `code` nodes, so IDs appearing in
 * examples must not be rewritten (F6).
 */
function fencedLineSet(lines: string[]): Set<number> {
  const set = new Set<number>();
  let fenceChar: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(/^(`{3,}|~{3,})/);
    if (fenceChar === null) {
      if (m) {
        fenceChar = m[1][0];
        set.add(i);
      }
    } else {
      set.add(i);
      if (m && m[1][0] === fenceChar) {
        fenceChar = null;
      }
    }
  }
  return set;
}

function listItemRegex(opts?: RewriteOptions): RegExp {
  return opts?.reqPatterns?.listItem ? new RegExp(opts.reqPatterns.listItem) : LIST_ITEM_RE;
}

// Every active task preset's `taskIdRe`, with built-ins filtered by the disable
// list. The rewriter tries these in addition to `listItemRegex` so a `T001` /
// `1.1` definition can also be renamed.
function taskItemRegexes(opts?: RewriteOptions): RegExp[] {
  const disabled = new Set(opts?.disableBuiltinTaskConventions ?? []);
  const presets = [
    ...BUILTIN_TASK_PRESETS.filter((p) => !disabled.has(p.name)),
    ...(opts?.taskConventions ?? []),
  ];
  return presets.map((p) => new RegExp(p.taskIdRe));
}

function listItemRegexes(opts?: RewriteOptions): RegExp[] {
  return [listItemRegex(opts), ...taskItemRegexes(opts)];
}

function headingRegex(opts?: RewriteOptions): RegExp {
  return opts?.reqPatterns?.heading ? new RegExp(opts.reqPatterns.heading) : KIRO_HEADING_RE;
}

/**
 * Content-based wrapper for the fenced-code line index set (see fencedLineSet).
 */
export function fencedLines(content: string): Set<number> {
  return fencedLineSet(content.split("\n"));
}

/**
 * If `line` *defines* a requirement (a markdown list item or a heading the
 * parser would turn into a req node), return that requirement's ID; otherwise
 * null. Mirrors the parser's list-item / heading grammar so split/merge can
 * remove the exact lines the parser treats as definitions.
 */
export function specDefinitionId(line: string, opts?: RewriteOptions): string | null {
  const pm = line.match(/^(\s*[-*]\s+)/);
  if (pm) {
    const rest = line.slice(pm[0].length);
    for (const re of listItemRegexes(opts)) {
      const m = rest.match(re);
      if (m && m[1] != null) return m[1];
    }
  }
  const hm = line.match(/^(#+\s+)(.*)$/);
  if (hm) {
    const headRe = headingRegex(opts);
    const m = hm[2].match(headRe);
    if (m && m[1] != null) {
      return headRe.source === KIRO_HEADING_RE.source ? `Requirement-${m[1]}` : m[1];
    }
  }
  return null;
}

// ── Rewriters ────────────────────────────────────────────────────────

/**
 * Rewrite spec list items such as:
 *   - REQ-001: description
 *   - **REQ-001**: description
 *
 * Honours a custom `reqPatterns.listItem` by locating the ID via the active
 * regex's capture group (the same the parser uses) and replacing only that
 * span. Lines inside fenced code blocks are skipped (F6).
 */
export function rewriteSpecListItem(
  content: string,
  oldId: string,
  newId: string,
  opts?: RewriteOptions,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];
  const fenced = fencedLineSet(lines);
  const itemRegexes = listItemRegexes(opts);
  // Markdown list prefix (`- ` / `* `). The parser matches its list-item
  // regex against the AST label text, which already excludes this marker.
  const prefixRe = /^(\s*[-*]\s+)/;

  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const pm = lines[i].match(prefixRe);
    if (!pm) continue;

    const rest = lines[i].slice(pm[0].length);
    let matched: { match: RegExpMatchArray } | null = null;
    for (const itemRe of itemRegexes) {
      const m = rest.match(itemRe);
      if (m && m[1] === oldId) {
        matched = { match: m };
        break;
      }
    }
    if (!matched) continue;
    const m = matched.match;

    // Locate the captured ID within the match so bold markers / prefixes are
    // preserved, then splice in newId.
    const idOffsetInMatch = m[0].indexOf(m[1]);
    if (idOffsetInMatch === -1) continue;
    const idStart = pm[0].length + (m.index ?? 0) + idOffsetInMatch;

    const before = lines[i];
    lines[i] = lines[i].slice(0, idStart) + newId + lines[i].slice(idStart + oldId.length);

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
 *   ### Requirement 1: description     (ID form: Requirement-1)
 *
 * For the default heading grammar the `Requirement-N` ↔ `Requirement N`
 * representation is converted. For a custom `reqPatterns.heading` whose
 * capture group is the verbatim ID, the captured span is replaced directly.
 */
export function rewriteSpecHeading(
  content: string,
  oldId: string,
  newId: string,
  opts?: RewriteOptions,
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];
  const fenced = fencedLineSet(lines);
  const headRe = headingRegex(opts);

  const usingDefault = headRe.source === KIRO_HEADING_RE.source;

  if (usingDefault) {
    const oldMatch = oldId.match(/^Requirement-(\d+)$/);
    const newMatch = newId.match(/^Requirement-(\d+)$/);
    if (!oldMatch || !newMatch) return { content, changes };
    const oldNum = oldMatch[1];
    const newNum = newMatch[1];

    const re = new RegExp(`^(#+\\s+)Requirement\\s+${escapeRegExp(oldNum)}(\\s*:)`);
    for (let i = 0; i < lines.length; i++) {
      if (fenced.has(i)) continue;
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

  // Custom heading grammar: heading text after the leading `#`s is matched by
  // headRe; capture group 1 holds the verbatim ID.
  const headingLineRe = /^(#+\s+)(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const hm = lines[i].match(headingLineRe);
    if (!hm) continue;
    const m = hm[2].match(headRe);
    if (!m || m[1] !== oldId) continue;
    const idOffsetInMatch = m[0].indexOf(m[1]);
    if (idOffsetInMatch === -1) continue;
    const idStart = hm[1].length + (m.index ?? 0) + idOffsetInMatch;
    const before = lines[i];
    lines[i] = lines[i].slice(0, idStart) + newId + lines[i].slice(idStart + oldId.length);
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
 * `// @impl REQ-001 REQ-002`. Only the target `oldId` is replaced.
 */
export function rewriteImplTags(content: string, oldId: string, newId: string): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  const implLineRe = /\/\/[^\S\n]*@impl[^\S\n]+/;
  const idRe = idBoundaryRegex(oldId);

  for (let i = 0; i < lines.length; i++) {
    if (!implLineRe.test(lines[i])) continue;

    idRe.lastIndex = 0;
    if (!idRe.test(lines[i])) continue;

    const before = lines[i];
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
 * Rewrite test tags, mirroring the parser's TEST_REQ_RE and TEST_ANNOTATION_RE:
 *   - `[REQ-001]` bracket-wrapped ID
 *   - `req: "REQ-001"` / `req: REQ-001` — case-sensitive `req:` only
 *
 * The parser tracks `req:` exclusively (not `requirement:`/`spec:` and not
 * case-insensitively), so the rewriter matches the same to avoid touching text
 * the tooling does not treat as a reference (M1).
 */
export function rewriteTestTags(content: string, oldId: string, newId: string): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  const escaped = escapeRegExp(oldId);

  // [REQ-001]
  const bracketRe = new RegExp(`\\[${escaped}\\]`, "g");
  // req: "REQ-001" | req: 'REQ-001' | req: REQ-001  (case-sensitive `req:`)
  const annotationRe = new RegExp(`(req:\\s*["']?)${escaped}(["']?)`, "g");

  for (let i = 0; i < lines.length; i++) {
    bracketRe.lastIndex = 0;
    annotationRe.lastIndex = 0;

    const hasBracket = bracketRe.test(lines[i]);
    const hasAnnotation = annotationRe.test(lines[i]);
    if (!hasBracket && !hasAnnotation) continue;

    const before = lines[i];
    bracketRe.lastIndex = 0;
    annotationRe.lastIndex = 0;

    if (hasBracket) lines[i] = lines[i].replace(bracketRe, `[${newId}]`);
    if (hasAnnotation) lines[i] = lines[i].replace(annotationRe, `$1${newId}$2`);

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

// ── Frontmatter ──────────────────────────────────────────────────────

const FM_BLOCK_KEY_RE = /^(\s*)(depends_on|derives_from)\s*:(.*)$/;
const FM_NODE_ID_RE = /^(\s*node_id:\s*["']?)(.+?)(["']?\s*)$/;

/**
 * True for a line that is part of an active `depends_on`/`derives_from` block
 * sequence (a `- …` list item or a blank continuation line).
 */
function isBlockItemLine(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("-");
}

/**
 * Rewrite a single ID reference inside YAML frontmatter:
 *   - `node_id: "doc:xxx"`
 *   - any reference to `oldId` within `depends_on:` / `derives_from:` blocks
 *     (string items, `id:` objects, inline `{ id: … }` flow maps and inline
 *     `[ … ]` arrays)
 *
 * Body content outside the frontmatter delimiters is never touched.
 */
export function rewriteFrontmatter(content: string, oldId: string, newId: string): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  const bounds = findFrontmatterBounds(content);
  if (!bounds) return { content, changes };

  const idRe = idBoundaryRegex(oldId);
  let inBlock = false;

  // Opening fence is always line 0 (findFrontmatterBounds invariant); body lines
  // sit at 1..bounds.end-1.
  for (let i = 1; i < bounds.end; i++) {
    const line = lines[i];

    // node_id: "<id>"
    const nm = line.match(FM_NODE_ID_RE);
    if (nm && nm[2] === oldId) {
      const before = line;
      lines[i] = nm[1] + newId + nm[3];
      changes.push({
        filePath: "",
        line: i + 1,
        kind: "frontmatter-depends-on",
        before,
        after: lines[i],
      });
      inBlock = false;
      continue;
    }

    // depends_on: / derives_from: key (with optional inline value)
    const bm = line.match(FM_BLOCK_KEY_RE);
    if (bm) {
      inBlock = true;
      if (bm[3].trim() !== "") {
        idRe.lastIndex = 0;
        if (idRe.test(line)) {
          const before = line;
          idRe.lastIndex = 0;
          lines[i] = line.replace(idRe, newId);
          changes.push({
            filePath: "",
            line: i + 1,
            kind: "frontmatter-depends-on",
            before,
            after: lines[i],
          });
        }
      }
      continue;
    }

    if (inBlock) {
      if (!isBlockItemLine(line)) {
        inBlock = false;
        continue;
      }
      idRe.lastIndex = 0;
      if (idRe.test(line)) {
        const before = line;
        idRe.lastIndex = 0;
        lines[i] = line.replace(idRe, newId);
        changes.push({
          filePath: "",
          line: i + 1,
          kind: "frontmatter-depends-on",
          before,
          after: lines[i],
        });
      }
    }
  }

  return { content: lines.join("\n"), changes };
}

/**
 * Split-aware frontmatter rewrite: a single reference to `oldId` inside a
 * `depends_on`/`derives_from` block is *expanded* into one entry per newId,
 * preserving the original item's indentation and style. Fixes the iterative
 * single-replace bug where only the first new ID survived (F5).
 */
export function expandFrontmatterDependsOn(
  content: string,
  oldId: string,
  newIds: string[],
): RewriteResult {
  const lines = content.split("\n");
  const changes: RewriteChange[] = [];

  const bounds = findFrontmatterBounds(content);
  if (!bounds || newIds.length === 0) return { content, changes };

  const idRe = idBoundaryRegex(oldId);
  const out: string[] = [];
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip the opening fence (line 0) and everything at/after the closing fence.
    if (i === 0 || i >= bounds.end) {
      out.push(line);
      continue;
    }

    const bm = line.match(FM_BLOCK_KEY_RE);
    if (bm) {
      // Only block sequences expand line-by-line; an inline array stays inline.
      inBlock = bm[3].trim() === "";
      out.push(line);
      continue;
    }

    idRe.lastIndex = 0;
    if (inBlock && line.trim().startsWith("-") && idRe.test(line)) {
      // Expand: emit one list item per newId, cloning this line's template.
      for (const newId of newIds) {
        idRe.lastIndex = 0;
        const expanded = line.replace(idRe, newId);
        out.push(expanded);
        changes.push({
          filePath: "",
          line: i + 1,
          kind: "frontmatter-depends-on",
          before: line,
          after: expanded,
        });
      }
      continue;
    }

    if (inBlock && !isBlockItemLine(line)) inBlock = false;
    out.push(line);
  }

  return { content: out.join("\n"), changes };
}

// ── Orchestrator ─────────────────────────────────────────────────────

/**
 * Apply the appropriate rewriters for the given file type and stamp each
 * returned `RewriteChange` with the provided `filePath`.
 */
// T025: rewrite req IDs that appear inside inline req→req annotations
// (`(depends_on: A, OLD, B)` → `(depends_on: A, NEW, B)`). Mirrors the parser
// grammar in src/parsers/markdown.ts (ANNOTATION_RE / extractAnnotations) so
// only annotations the parser would extract are rewritten. fenced code blocks
// are skipped (F6). Position constraints (list-item line / heading first
// paragraph head/tail) are NOT enforced here — see research.md R5: rewriting
// a paren expression outside those positions is harmless because the parser
// won't have emitted an edge for it anyway, and duplicating the position
// gate in the rewriter would mean two sources of truth.
const ANNOTATION_RE_LINE = /(\(\s*(?:depends_on|derives_from)\s*:\s*)([^()]*?)(\s*\))/g;

export function rewriteAnnotationIds(
  content: string,
  oldId: string,
  newId: string,
  opts?: RewriteOptions,
): RewriteResult {
  if (oldId === newId) return { content, changes: [] };
  const lines = content.split("\n");
  const fenced = fencedLineSet(lines);
  const changes: RewriteChange[] = [];
  const escapedOld = escapeRegExp(oldId);
  // Token boundary inside the comma-separated ID list: separator is `,` or
  // start/end of capture group; spaces and `**` may surround the ID. Match the
  // exact ID surrounded by these boundary chars (or `**`) so a partial token
  // like `AUTH-001` inside `AUTH-001-X` is not rewritten. Both `**` are kept
  // optional (the parser strips them as a pair); a degenerate `**OLD` with no
  // matching close bold is left as-is by also requiring the boldness to be
  // symmetrical via a backreference.
  const idTokenRE = new RegExp(`(^|,)(\\s*)(\\*\\*)?(${escapedOld})(\\*\\*)?(\\s*)(?=,|$)`, "g");
  // When provided, validate that `oldId` looks like a real ID under the
  // user's reqPatterns.codeId. If not, the rewriter is a no-op — this keeps
  // parser/rewriter parity (parser would reject the token via
  // invalid-annotation-id, so the rewriter should not silently mutate it).
  if (opts?.reqPatterns?.codeId) {
    const codeIdRE = new RegExp(opts.reqPatterns.codeId);
    if (!codeIdRE.test(oldId)) return { content, changes: [] };
  }

  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const original = lines[i];
    // Block-level protection: blockquote prefix lines never carry req→req
    // annotations (the parser doesn't extract them either — see meta-review
    // C1). Skip the line wholesale so authored prose inside `> ...` stays
    // intact.
    if (/^\s*>/.test(original)) continue;
    // Span-level protection: mask inline-code and HTML-comment spans so any
    // `(depends_on: OLD)` written inside `` `...` `` or `<!-- ... -->` is
    // preserved verbatim. We rewrite on the original line but consult the
    // masked copy at each match position to decide whether the match sits
    // inside a protected span.
    const masked = maskInlineProtectedSpans(original);
    const rewritten = original.replace(ANNOTATION_RE_LINE, (match, head, body, tail, offset) => {
      const slice = masked.slice(offset, offset + match.length);
      // If the same span in the masked copy is entirely whitespace, the
      // match overlaps a protected region — leave it untouched.
      if (slice.replace(/\s/g, "") === "") return match;
      const newBody = body.replace(
        idTokenRE,
        (
          _m: string,
          sep: string,
          leadWS: string,
          bold1: string | undefined,
          _id: string,
          bold2: string | undefined,
          trailWS: string,
        ) => `${sep}${leadWS}${bold1 ?? ""}${newId}${bold2 ?? ""}${trailWS}`,
      );
      return head + newBody + tail;
    });
    if (rewritten !== original) {
      changes.push({
        filePath: "",
        line: i + 1,
        kind: "annotation-target",
        before: original,
        after: rewritten,
      });
      lines[i] = rewritten;
    }
  }

  return { content: lines.join("\n"), changes };
}

export function rewriteFile(
  filePath: string,
  content: string,
  oldId: string,
  newId: string,
  opts?: RewriteOptions,
): RewriteResult {
  const ext = extOf(filePath);
  const allChanges: RewriteChange[] = [];

  // Normalize CRLF/CR to LF for the rewrite pipeline so line-based regexes
  // and annotation matching behave identically across platforms. Restore the
  // original newline style at the end (meta-review additional F4 — without
  // this, the rewriter no-ops on Windows-checked-out spec files while the
  // parser still produces edges).
  const originalNewline = content.includes("\r\n") ? "\r\n" : "\n";
  let current = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const apply = (fn: (c: string) => RewriteResult) => {
    const result = fn(current);
    current = result.content;
    allChanges.push(...result.changes);
  };

  if (ext === ".md") {
    apply((c) => rewriteSpecListItem(c, oldId, newId, opts));
    apply((c) => rewriteSpecHeading(c, oldId, newId, opts));
    apply((c) => rewriteFrontmatter(c, oldId, newId));
    apply((c) => rewriteAnnotationIds(c, oldId, newId, opts));
  } else if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    apply((c) => rewriteImplTags(c, oldId, newId));
    apply((c) => rewriteTestTags(c, oldId, newId));
  }

  for (const change of allChanges) {
    change.filePath = filePath;
  }

  if (originalNewline !== "\n") {
    current = current.replace(/\n/g, originalNewline);
  }

  return { content: current, changes: allChanges };
}
