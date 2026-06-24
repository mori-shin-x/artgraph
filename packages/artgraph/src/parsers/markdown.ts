import { readFileSync } from "node:fs";
import { relative, resolve as resolvePath, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import { createHash } from "node:crypto";
import type { GraphNode, GraphEdge, ReqPatternConfig } from "../types.js";

export interface ParseMarkdownOptions {
  rootDir?: string;
  specDirPrefix?: string;
  reqPatterns?: ReqPatternConfig;
}

const LIST_ITEM_RE = /^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/;
const KIRO_HEADING_RE = /^Requirement\s+(\d+)\s*:/;
const DEFAULT_CODE_ID_RE = /^[A-Z][A-Za-z]*-\d+$/;
// Inline req→req annotation: `(depends_on: A, B, ...)` or `(derives_from: ...)`.
// - Keywords are strict-lowercase + underscore (rejects `depends on`, `DEPENDS_ON`).
// - `[^()]*?` (non-greedy, no nested parens) so `(depends_on: A)(depends_on: B)`
//   splits into two matches.
// - Used for both extraction (via exec/matchAll, capture groups) and stripping
//   (via replace, where the leading `\s*` eats any space directly before `(`).
const ANNOTATION_RE = /\(\s*(depends_on|derives_from)\s*:\s*([^()]*?)\s*\)/g;
// Same shape but with line-local (space/tab) padding on both sides — used by
// stripAnnotations so the whitespace adjacent to an annotation collapses
// consistently regardless of whether the author left a space before/after
// the parenthesis. Adjacent newlines are NOT consumed (the surrounding
// paragraph block keeps its line structure).
const ANNOTATION_STRIP_RE = /[ \t]*\(\s*(?:depends_on|derives_from)\s*:\s*[^()]*?\s*\)[ \t]*/g;
const METADATA_FIELDS = ["title", "status", "priority", "owner"] as const;
// Matches `<scheme>:` at the start of an href (e.g. `http:`, `mailto:`, `tel:`,
// `javascript:`). Used to skip absolute URLs — only relative paths point at
// another file in the workspace.
// The scheme requires at least 2 characters so single-letter prefixes like
// `C:/foo.md` (Windows drive letters) aren't mistaken for URL schemes; no real
// scheme is a single letter (RFC 3986 allows it in theory but none are deployed).
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

export interface ParseWarning {
  type:
    | "invalid-relation"
    | "reserved-prefix"
    | "invalid-annotation-id"
    | "empty-annotation";
  key: string;
  filePath: string;
}

// Extracted req→req annotation. Internal to the parser; the surrounding
// req visit turns each AnnotationExtract into one or more GraphEdges.
// `targets` is post-split (comma), post-trim, post-`**`-strip, and only
// contains IDs that matched `reqPatterns.codeId`. Invalid IDs are reported
// via warnings and do NOT appear here.
export interface AnnotationExtract {
  reqId: string;
  kind: "depends_on" | "derives_from";
  targets: string[];
  sourceLine: number;
}

export interface InlineLinkRef {
  // The doc node id of the source markdown file. Resolved at parse time using
  // the same logic as the doc node itself, so the builder can treat it as the
  // edge's source without re-deriving it.
  sourceDocId: string;
  // Project-root-relative path of the target .md file. Anchor (`#...`) and
  // query (`?...`) are stripped and the path is percent-decoded so the builder
  // can map it 1-to-1 onto a doc node.
  targetRelPath: string;
  // The raw href as written in the source markdown — kept for diagnostics so
  // unresolved/out-of-scope warnings can quote what the author wrote.
  rawHref: string;
}

interface ParsedSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: ParseWarning[];
  inlineLinks: InlineLinkRef[];
}

export function parseMarkdown(filePath: string, options?: ParseMarkdownOptions): ParsedSpec {
  // Normalize line endings so downstream offsets, regexes, and hashes see a
  // single `\n` regardless of how the file was checked out (CRLF on Windows
  // git workspaces, lone CR from legacy editors). Without this, an authored
  // `(depends_on: X)\r\n` line bypasses ANNOTATION_RE_LINE in the rewriter
  // while still being parsed as an annotation here — i.e. parser/rewriter
  // parity breaks on CRLF files (meta-review additional F4).
  const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rootDir = options?.rootDir;
  const specDirPrefix = options?.specDirPrefix;
  const relPath = rootDir ? relative(rootDir, filePath) : filePath;
  const docRelPath =
    specDirPrefix && relPath.startsWith(specDirPrefix + "/")
      ? relPath.slice(specDirPrefix.length + 1)
      : relPath;

  const listItemRE = options?.reqPatterns?.listItem
    ? new RegExp(options.reqPatterns.listItem)
    : LIST_ITEM_RE;
  const headingRE = options?.reqPatterns?.heading
    ? new RegExp(options.reqPatterns.heading)
    : KIRO_HEADING_RE;
  const codeIdRE = options?.reqPatterns?.codeId
    ? new RegExp(options.reqPatterns.codeId)
    : DEFAULT_CODE_ID_RE;

  let frontmatter: Record<string, any> = {};
  let content: string;
  try {
    const parsed = parseFrontmatter(raw);
    frontmatter = parsed.data;
    content = parsed.content;
  } catch {
    content = raw;
  }

  const tree = unified().use(remarkParse).parse(content);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: ParseWarning[] = [];

  const fileHash = hash(raw);

  const VALID_ARTGRAPH_KEYS = new Set(["node_id", "derives_from", "depends_on"]);

  const artgraphMeta = frontmatter?.artgraph as
    | { node_id?: string; derives_from?: string[]; depends_on?: string[]; [key: string]: unknown }
    | undefined;

  // `node_id` is consumed downstream as a string (graph node id, JSON-serialized).
  // A circular YAML alias or unexpected tag (e.g. !!binary) could otherwise put a
  // non-string here and break `JSON.stringify` of the graph output.
  const docId =
    typeof artgraphMeta?.node_id === "string" ? artgraphMeta.node_id : `doc:${docRelPath}`;
  const metadata = extractMetadata(frontmatter);
  nodes.push({
    id: docId,
    kind: "doc",
    filePath: relPath,
    label: docId,
    contentHash: fileHash,
    ...(metadata && { metadata }),
  });

  if (artgraphMeta) {
    // Validate keys (T018: invalid-relation warning)
    for (const key of Object.keys(artgraphMeta)) {
      if (!VALID_ARTGRAPH_KEYS.has(key)) {
        warnings.push({
          type: "invalid-relation",
          key,
          filePath: relPath,
        });
      }
    }

    // Generate derives_from edges (T017)
    if (Array.isArray(artgraphMeta.derives_from)) {
      for (const target of artgraphMeta.derives_from) {
        if (typeof target === "string") {
          edges.push({
            source: docId,
            target,
            kind: "derives_from",
          });
        }
      }
    }

    // Generate depends_on edges (T017)
    if (Array.isArray(artgraphMeta.depends_on)) {
      for (const target of artgraphMeta.depends_on) {
        if (typeof target === "string") {
          edges.push({
            source: docId,
            target,
            kind: "depends_on",
          });
        }
      }
    }
  }

  // Pre-collect list-items that live inside a blockquote subtree. Annotation
  // grammar (annotation-grammar.md §「検出位置」) does not extend to quoted
  // content; we still register the req node itself so existing inventories
  // aren't lost, but skip annotation extraction for it.
  const blockquoteListItems = new WeakSet<object>();
  visit(tree, "blockquote", (bq: any) => {
    visit(bq, "listItem", (li: any) => {
      blockquoteListItems.add(li);
    });
  });

  visit(tree, "listItem", (node: any) => {
    const firstParagraph = node.children?.find((c: any) => c.type === "paragraph");
    const labelText = firstParagraph ? toString(firstParagraph) : toString(node);
    const match = labelText.match(listItemRE);
    if (!match || match[1] == null) return;

    const reqId = match[1];
    // Strip annotations BEFORE hashing so adding/removing/changing a req→req
    // dependency annotation does not flip the req's contentHash and trip drift.
    const reqHash = hash(stripAnnotations(toString(node)));

    nodes.push({
      id: reqId,
      kind: "req",
      filePath: relPath,
      label: labelText,
      contentHash: reqHash,
    });

    // Skip annotation extraction inside blockquote. The req itself stays in
    // the graph but its quoted `(depends_on: ...)` doesn't create edges, in
    // line with how inline-link extraction (extractInlineLinks) honors AST
    // node kinds rather than flattened text.
    if (blockquoteListItems.has(node)) return;

    // T012: req→req annotation edges. Extract from the first paragraph's text
    // using an AST-walk that strips inline code, HTML comments, and code
    // subtrees so an authored `(depends_on: …)` inside `` `...` `` or
    // `<!-- ... -->` doesn't become a phantom edge (meta-review C1).
    const annotationText = firstParagraph
      ? extractAnnotationContextText(firstParagraph)
      : labelText;
    const sourceLine = node.position?.start?.line ?? 0;
    const { extracts, warnings: annWarnings } = extractAnnotations(
      annotationText,
      reqId,
      sourceLine,
      { filePath: relPath, codeIdRE },
    );
    warnings.push(...annWarnings);
    for (const extract of extracts) {
      for (const target of extract.targets) {
        edges.push({
          source: extract.reqId,
          target,
          kind: extract.kind,
          provenance: "annotation",
        });
      }
    }
  });

  visit(tree, "heading", (node: any) => {
    const text = extractText(node);
    const match = text.match(headingRE);
    if (!match || match[1] == null) return;

    const reqId = headingRE === KIRO_HEADING_RE ? `Requirement-${match[1]}` : match[1];
    const startLine = node.position.start.line;
    const headingContent = extractSectionContent(content, startLine);
    const paragraph = extractFirstParagraphAfterHeading(content, startLine);

    // T018/meta-review C3: strip annotations from EVERY line of the first
    // paragraph block (not just head/tail) so a req→req annotation anywhere
    // in the paragraph keeps the heading-req's contentHash stable. When the
    // paragraph dissolves completely (e.g. a standalone `(depends_on: …)`
    // block), the surrounding blank line is also collapsed so the result
    // matches the no-annotation baseline `## R\n\nbody\n`.
    let strippedContent = headingContent;
    if (paragraph) {
      const sectionLines = headingContent.split("\n");
      const sectionStartIdx = startLine - 1;
      const headIdx = paragraph.startLine - sectionStartIdx;
      const tailIdx = paragraph.endLine - sectionStartIdx;

      const strippedPara: string[] = [];
      for (let l = headIdx; l <= tailIdx; l++) {
        strippedPara.push(stripAnnotations(sectionLines[l]));
      }
      const paragraphCollapsed = strippedPara.every((l) => l.trim() === "");

      const kept: string[] = [];
      for (let i = 0; i < sectionLines.length; i++) {
        if (i >= headIdx && i <= tailIdx) {
          if (paragraphCollapsed) continue;
          const stripped = strippedPara[i - headIdx];
          if (stripped.trim() === "") continue;
          kept.push(stripped);
        } else {
          kept.push(sectionLines[i]);
        }
      }

      if (paragraphCollapsed && headIdx > 0 && sectionLines[headIdx - 1].trim() === "") {
        kept.splice(headIdx - 1, 1);
      }
      strippedContent = kept.join("\n");
    }
    const reqHash = hash(strippedContent);

    nodes.push({
      id: reqId,
      kind: "req",
      filePath: relPath,
      label: text,
      contentHash: reqHash,
    });

    // T017: extract annotations from heading's first paragraph head/tail
    // lines only. Mid-paragraph lines and the heading line itself are
    // intentionally excluded — see contracts/annotation-grammar.md §「最初の
    // 段落ブロックの定義」.
    if (paragraph) {
      const contentLines = content.split("\n");
      const pushExtracts = (line: string, sourceLineNum: number) => {
        // Block-level masking: blockquote prefix lines never carry req→req
        // annotations, even when the heading itself was registered as a req.
        if (/^\s*>/.test(line)) return;
        // Mask inline code spans and HTML comments line-locally so a
        // `<!-- (depends_on: X) -->` or `` `(depends_on: X)` `` in the
        // heading's first paragraph head/tail doesn't become a phantom edge.
        const masked = maskInlineProtectedSpans(line);
        const { extracts, warnings: ws } = extractAnnotations(masked, reqId, sourceLineNum, {
          filePath: relPath,
          codeIdRE,
        });
        warnings.push(...ws);
        for (const extract of extracts) {
          for (const target of extract.targets) {
            edges.push({
              source: extract.reqId,
              target,
              kind: extract.kind,
              provenance: "annotation",
            });
          }
        }
      };
      pushExtracts(contentLines[paragraph.startLine], paragraph.startLine + 1);
      if (paragraph.endLine !== paragraph.startLine) {
        pushExtracts(contentLines[paragraph.endLine], paragraph.endLine + 1);
      }
    }
  });

  const inlineLinks = extractInlineLinks(tree, {
    sourceAbsPath: filePath,
    rootDir,
    sourceDocId: docId,
  });

  return { nodes, edges, warnings, inlineLinks };
}

interface ExtractInlineLinksContext {
  sourceAbsPath: string;
  rootDir?: string;
  sourceDocId: string;
}

function extractInlineLinks(tree: any, ctx: ExtractInlineLinksContext): InlineLinkRef[] {
  if (!ctx.rootDir) return [];

  // Definitions can appear anywhere in the file (often at the bottom), so we
  // collect them first and then resolve linkReferences against this map.
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node: any) => {
    if (typeof node.identifier === "string" && typeof node.url === "string") {
      definitions.set(node.identifier, node.url);
    }
  });

  const links: InlineLinkRef[] = [];

  const handle = (rawHref: string) => {
    const target = resolveInlineHref(rawHref, ctx.sourceAbsPath, ctx.rootDir!);
    if (target == null) return;
    links.push({
      sourceDocId: ctx.sourceDocId,
      targetRelPath: target,
      rawHref,
    });
  };

  // remark-parse never emits `link`/`linkReference` children inside `code`,
  // `inlineCode`, or `image` nodes, so fenced/indented code blocks, inline
  // code spans, and images are naturally excluded without explicit handling.
  visit(tree, "link", (node: any) => {
    if (typeof node.url === "string") handle(node.url);
  });

  visit(tree, "linkReference", (node: any) => {
    if (typeof node.identifier !== "string") return;
    const url = definitions.get(node.identifier);
    if (typeof url === "string") handle(url);
  });

  return links;
}

function resolveInlineHref(rawHref: string, sourceAbsPath: string, rootDir: string): string | null {
  if (!rawHref) return null;
  // Pure-fragment links like `#section` and protocol-relative URLs like
  // `//cdn/...` are not workspace references.
  if (rawHref.startsWith("#") || rawHref.startsWith("//")) return null;
  if (URL_SCHEME_RE.test(rawHref)) return null;

  // Strip fragment first so a `?` inside the fragment isn't mistaken for query.
  let href = rawHref;
  const hashAt = href.indexOf("#");
  if (hashAt >= 0) href = href.slice(0, hashAt);
  const queryAt = href.indexOf("?");
  if (queryAt >= 0) href = href.slice(0, queryAt);
  if (!href) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // Malformed percent-encoding — skip rather than crash the whole parse.
    return null;
  }

  if (!decoded.toLowerCase().endsWith(".md")) return null;

  const absTarget = resolvePath(dirname(sourceAbsPath), decoded);
  const rel = relative(rootDir, absTarget);
  if (!rel || rel.startsWith("..")) {
    // Outside rootDir — drop silently here. The "rootDir-internal but outside
    // specDirs" case is handled by the builder via the `out-of-scope-link`
    // warning (which checks the file actually exists). Anything truly outside
    // the project tree gets no treatment at all.
    return null;
  }
  // Normalize path separators to forward slashes for cross-platform stability.
  return rel.split(/[\\/]/).join("/");
}

function extractMetadata(fm: Record<string, any>): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  for (const field of METADATA_FIELDS) {
    if (field in fm && fm[field] != null) {
      metadata[field] = String(fm[field]);
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractText(node: any): string {
  let text = "";
  visit(node, (t: any) => {
    if (t.type === "text" || t.type === "inlineCode") {
      text += t.value;
    }
  });
  return text;
}

// Flatten an AST subtree to text for annotation extraction, skipping
// inlineCode / code / html / blockquote children. Mirrors the kinds the
// parser already treats as opaque (inline-link extraction in
// extractInlineLinks skips them implicitly via remark's node typing); we
// make the same boundary explicit for the annotation regex so a literal
// `(depends_on: X)` inside backticks or an HTML comment does NOT create a
// req→req edge.
function extractAnnotationContextText(node: any): string {
  let text = "";
  function walk(n: any) {
    if (!n || typeof n !== "object") return;
    if (
      n.type === "inlineCode" ||
      n.type === "code" ||
      n.type === "html" ||
      n.type === "blockquote"
    ) {
      return;
    }
    if (typeof n.value === "string") {
      text += n.value;
      return;
    }
    if (Array.isArray(n.children)) {
      for (const child of n.children) walk(child);
    }
  }
  walk(node);
  return text;
}

// Line-local masking for the heading-paragraph path where we work with raw
// lines (not an AST). Replaces inline-code spans (`…`, ``…``) and HTML
// comments (<!-- … -->) with same-length space runs so column positions stay
// stable, and the annotation regex finds nothing inside them. Multi-line
// comments / fenced code are not handled here on purpose — heading-paragraph
// extraction is by definition line-scoped (head and tail of the first
// paragraph block), and fenced code is excluded earlier by paragraph
// boundary detection.
export function maskInlineProtectedSpans(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/(`+)[^\n]*?\1/g, (m) => " ".repeat(m.length));
}

function extractSectionContent(content: string, startLine: number): string {
  const lines = content.split("\n");
  const headingLine = lines[startLine - 1];
  const headingLevel = headingLine.match(/^(#+)/)?.[1]?.length ?? 1;

  const sectionLines = [headingLine];
  for (let i = startLine; i < lines.length; i++) {
    const nextHeading = lines[i].match(/^(#+)\s/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join("\n");
}

// Locate the first non-blank "paragraph block" directly beneath a heading
// (no heading or blank line between). Returns 0-based startLine/endLine
// indices into `content.split("\n")`, or null when no such paragraph exists
// (e.g. the heading is immediately followed by another heading or EOF).
function extractFirstParagraphAfterHeading(
  content: string,
  headingLine: number,
): { startLine: number; endLine: number } | null {
  const lines = content.split("\n");
  let i = headingLine; // 0-based index of the line AFTER the heading (heading is 1-based)
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return null;
  if (/^#+\s/.test(lines[i])) return null;
  const startLine = i;
  while (i < lines.length && lines[i].trim() !== "" && !/^#+\s/.test(lines[i])) i++;
  return { startLine, endLine: i - 1 };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Remove inline req→req annotations from `text`, normalising the whitespace
// that surrounded the annotation so adding/removing/changing one does not
// flip the req's `contentHash` and trip drift — see
// specs/010-req-req-dependency/research.md (R3).
//
// Rules (line-local; newlines are never collapsed):
// - At a line edge (no character before/after, or `\n` neighbour) the
//   annotation and its adjacent spaces are removed outright. So a
//   standalone `(depends_on: X)` or a trailing `… (depends_on: X)` collapses
//   cleanly to its leading text.
// - Inside running text the annotation collapses to a single space, so
//   `X (ann) Y` and `X(ann)Y` both stabilise to `X Y` — matching the most
//   common authored baseline (with whitespace separators).
export function stripAnnotations(text: string): string {
  return (
    text
      .replace(ANNOTATION_STRIP_RE, (match, offset: number) => {
        const left = offset === 0 ? "" : text[offset - 1];
        const right = offset + match.length >= text.length ? "" : text[offset + match.length];
        if (left === "" || left === "\n" || right === "" || right === "\n") return "";
        return " ";
      })
      // Adjacent annotations (`X (ann1)(ann2)\n`) leave a trailing space
      // after the first collapse since the second still sees a `(` to its
      // right. Strip trailing line-local whitespace as a final pass so the
      // result matches the no-annotation baseline `X` rather than `X `.
      .replace(/[ \t]+(?=\n|$)/g, "")
  );
}

// Extract inline req→req annotations from `text` belonging to a single req.
// The caller decides what `text` to feed (list-item line vs. heading's first
// paragraph head/tail line) and passes positional context. Returns only valid
// extracts; invalid IDs and empty annotations are surfaced as warnings.
export function extractAnnotations(
  text: string,
  reqId: string,
  sourceLine: number,
  opts: { filePath: string; codeIdRE?: RegExp },
): { extracts: AnnotationExtract[]; warnings: ParseWarning[] } {
  const extracts: AnnotationExtract[] = [];
  const warnings: ParseWarning[] = [];
  const codeIdRE = opts.codeIdRE ?? DEFAULT_CODE_ID_RE;

  for (const m of text.matchAll(ANNOTATION_RE)) {
    const kind = m[1] as "depends_on" | "derives_from";
    const rawTargets = m[2];

    if (!rawTargets.trim()) {
      warnings.push({ type: "empty-annotation", key: kind, filePath: opts.filePath });
      continue;
    }

    const targets: string[] = [];
    let sawInvalid = false;
    for (const raw of rawTargets.split(",")) {
      // Drop empty/whitespace-only tokens silently — `(depends_on: A,,B)` /
      // `(depends_on: ,A)` / `(depends_on: A,)` should yield A and B without
      // emitting `invalid-annotation-id key=""` per separator. Fully-empty
      // bodies are still surfaced via the empty-annotation branch above.
      let id = raw.trim();
      if (id === "") continue;
      // Strip a single surrounding `**…**` (one pass — `***X***` → `*X*`).
      // Re-trim afterwards so `**  A-1  **` collapses to `A-1` rather than
      // failing the codeId pattern with internal whitespace.
      if (id.length >= 4 && id.startsWith("**") && id.endsWith("**")) {
        id = id.slice(2, -2).trim();
      }
      if (!codeIdRE.test(id)) {
        warnings.push({ type: "invalid-annotation-id", key: id, filePath: opts.filePath });
        sawInvalid = true;
        continue;
      }
      targets.push(id);
    }

    // All tokens were empty (e.g. `(depends_on: ,)` or `(depends_on: , ,)`).
    // Emit a single empty-annotation warning so the author still sees the
    // mistake without a flood of `key=""` invalid-id reports.
    if (targets.length === 0 && !sawInvalid) {
      warnings.push({ type: "empty-annotation", key: kind, filePath: opts.filePath });
      continue;
    }
    if (targets.length === 0) continue;
    extracts.push({ reqId, kind, targets, sourceLine });
  }

  return { extracts, warnings };
}

// Minimal YAML-frontmatter splitter. Replaces gray-matter to drop the js-yaml v3
// advisory chain (GHSA-h67p-54hq-rp68 / issue #42); the YAML body is parsed by
// eemeli/yaml which is already a workspace dependency.
function parseFrontmatter(raw: string): { data: Record<string, any>; content: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const firstNl = text.indexOf("\n");
  if (firstNl < 0) return { data: {}, content: raw };
  const firstLine = text.slice(0, firstNl).replace(/\r$/, "");
  // Trailing whitespace on the opening fence is symmetric with the closing fence
  // regex below — gray-matter accepted `--- ` / `---\t` and some editors auto-insert
  // it, so rejecting strictly would silently drop the whole frontmatter.
  if (!/^---[ \t]*$/.test(firstLine)) return { data: {}, content: raw };

  const rest = text.slice(firstNl + 1);
  const closeRe = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;
  const match = closeRe.exec(rest);
  if (!match) return { data: {}, content: raw };

  const yamlBody = rest.slice(0, match.index);
  const content = rest.slice(match.index + match[0].length);

  // `resolveKnownTags: false` keeps the YAML 1.2 core schema (str/seq/map/int/
  // float/bool/null) but drops opt-in tags like `!!binary` (→ Buffer) and
  // `!!timestamp` (→ Date) that would silently inject non-string objects into
  // fields the rest of the parser treats as strings.
  const parsed = parseYaml(yamlBody, { resolveKnownTags: false });
  if (parsed == null) return { data: {}, content };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter is not a YAML mapping");
  }
  return { data: parsed as Record<string, any>, content };
}
