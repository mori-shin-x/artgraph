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
const METADATA_FIELDS = ["title", "status", "priority", "owner"] as const;
// Matches `<scheme>:` at the start of an href (e.g. `http:`, `mailto:`, `tel:`,
// `javascript:`). Used to skip absolute URLs — only relative paths point at
// another file in the workspace.
// The scheme requires at least 2 characters so single-letter prefixes like
// `C:/foo.md` (Windows drive letters) aren't mistaken for URL schemes; no real
// scheme is a single letter (RFC 3986 allows it in theory but none are deployed).
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

export interface ParseWarning {
  type: "invalid-relation" | "reserved-prefix";
  key: string;
  filePath: string;
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
  const raw = readFileSync(filePath, "utf-8");
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

  const docId = artgraphMeta?.node_id ?? `doc:${docRelPath}`;
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

  visit(tree, "listItem", (node: any) => {
    const firstParagraph = node.children?.find((c: any) => c.type === "paragraph");
    const labelText = firstParagraph ? toString(firstParagraph) : toString(node);
    const match = labelText.match(listItemRE);
    if (!match || match[1] == null) return;

    const reqId = match[1];
    const reqHash = hash(toString(node));

    nodes.push({
      id: reqId,
      kind: "req",
      filePath: relPath,
      label: labelText,
      contentHash: reqHash,
    });
  });

  visit(tree, "heading", (node: any) => {
    const text = extractText(node);
    const match = text.match(headingRE);
    if (!match || match[1] == null) return;

    const reqId = headingRE === KIRO_HEADING_RE ? `Requirement-${match[1]}` : match[1];
    const headingContent = extractSectionContent(content, node.position.start.line);
    const reqHash = hash(headingContent);

    nodes.push({
      id: reqId,
      kind: "req",
      filePath: relPath,
      label: text,
      contentHash: reqHash,
    });
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

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Minimal YAML-frontmatter splitter. Replaces gray-matter to drop the js-yaml v3
// advisory chain (GHSA-h67p-54hq-rp68 / issue #42); the YAML body is parsed by
// eemeli/yaml which is already a workspace dependency.
function parseFrontmatter(raw: string): { data: Record<string, any>; content: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const firstNl = text.indexOf("\n");
  if (firstNl < 0) return { data: {}, content: raw };
  const firstLine = text.slice(0, firstNl).replace(/\r$/, "");
  if (firstLine !== "---") return { data: {}, content: raw };

  const rest = text.slice(firstNl + 1);
  const closeRe = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;
  const match = closeRe.exec(rest);
  if (!match) return { data: {}, content: raw };

  const yamlBody = rest.slice(0, match.index);
  const content = rest.slice(match.index + match[0].length);

  const parsed = parseYaml(yamlBody);
  if (parsed == null) return { data: {}, content };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter is not a YAML mapping");
  }
  return { data: parsed as Record<string, any>, content };
}
