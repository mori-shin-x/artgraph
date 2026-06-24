import { readFileSync } from "node:fs";
import { relative, resolve as resolvePath, dirname, basename } from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import { createHash } from "node:crypto";
import type {
  GraphNode,
  GraphEdge,
  ReqPatternConfig,
  TaskConventionPreset,
} from "../types.js";
import { NAMESPACED_ID_TOKEN } from "../req-id.js";

export interface ParseMarkdownOptions {
  rootDir?: string;
  specDirPrefix?: string;
  reqPatterns?: ReqPatternConfig;
  taskConventions?: TaskConventionPreset[];
}

const LIST_ITEM_RE = /^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/;
const KIRO_HEADING_RE = /^Requirement\s+(\d+)\s*:/;

// Built-in task convention presets. spec-kit covers plan.md/tasks.md with the
// `T\d+` ID shape + `@impl(...)` / `[REQ-...]` tag syntax. kiro covers tasks.md
// with hierarchical numerics (`1`, `1.1`) + `_Requirements: X, Y_` italic lists.
// Users add OpenSpec or other SDD tools via `.artgraph.json` `taskConventions`,
// which are merged after these built-ins (see research.md §R8).
const BUILTIN_TASK_PRESETS: TaskConventionPreset[] = [
  {
    name: "spec-kit",
    fileStems: ["plan", "tasks"],
    taskIdRe: "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(T\\d+)\\b",
    // Spec Kit puts `@impl(target)` on the same line as the task ID.
    // `[^)\n]+` keeps the target single-line (an unclosed paren can't swallow the next line).
    implementsTagRe: "@impl\\(([^)\\n]+)\\)",
    // Spec Kit's verifies tag preserves the bracket inner literally so a
    // `[REQ-FR-001]` author-side ID round-trips verbatim through the graph.
    // Two branches: chained `REQ-<...>` (e.g. REQ-FR-001) and a single
    // NAMESPACED_ID_TOKEN (e.g. FR-001 / Requirement-3 / ns/FR-1).
    verifiesTagRe: `\\[((?:REQ-[\\w/-]+)|(?:${NAMESPACED_ID_TOKEN}))\\]`,
  },
  {
    // Kiro tasks.md: require the checkbox prefix so ordinary numbered prose
    // (`- 1 release shipped`) doesn't false-match as a task. Users with a
    // checkbox-less Kiro variant can override via `.artgraph.json` `taskConventions`.
    name: "kiro",
    fileStems: ["tasks"],
    taskIdRe: "^\\[[xX ]\\][\\s\\u00A0]+(\\d+(?:\\.\\d+)*)\\.?[\\s\\u00A0]",
    // Kiro doesn't use `@impl(...)` — implementation pointers live in the spec
    // narrative, not the task tag. Omit implementsTagRe.
    //
    // Cross-link to requirements is `_Requirements: 1.1, 2.3, 3.1_` (italic,
    // comma-separated). mdast `toString` strips the `_` emphasis markers, so the
    // lookbehind keys on the literal `Requirements:` label and a comma/digit-only
    // run between it and the captured ID — that constrains matches to the
    // requirements list and ignores stray numerics like "Set up 3 workers".
    verifiesTagRe: "(?<=Requirements:[\\s\\d.,]*)(\\d+(?:\\.\\d+)*)",
  },
];
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
    const parsed = matter(raw, { language: "yaml", engines: {} });
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

  // Build the per-file list of task convention presets whose `fileStems`
  // match this file's stem. Empty when the file isn't a recognized task
  // surface (e.g. a regular spec.md / design.md), so the visit() callback
  // skips the task-extraction branch entirely with no extra cost.
  interface ApplicablePreset {
    name: string;
    idRe: RegExp;
    implRe?: RegExp;
    verifiesRe?: RegExp;
  }
  const fileStem = basename(relPath)
    .replace(/\.(md|markdown)$/i, "")
    .toLowerCase();
  const applicableTaskPresets: ApplicablePreset[] = [];
  const seenPresetNames = new Set<string>();
  for (const preset of [...BUILTIN_TASK_PRESETS, ...(options?.taskConventions ?? [])]) {
    if (seenPresetNames.has(preset.name)) continue;
    seenPresetNames.add(preset.name);
    if (!preset.fileStems.includes(fileStem)) continue;
    applicableTaskPresets.push({
      name: preset.name,
      idRe: new RegExp(preset.taskIdRe),
      implRe: preset.implementsTagRe ? new RegExp(preset.implementsTagRe, "g") : undefined,
      verifiesRe: preset.verifiesTagRe ? new RegExp(preset.verifiesTagRe, "g") : undefined,
    });
  }

  // Does this listItem's first paragraph match any applicable task ID regex?
  // Used to skip nested-task subtrees when collecting tag-scope paragraphs —
  // otherwise a parent task would inherit edges from every nested sub-task.
  const isTaskListItem = (li: any): boolean => {
    if (!li || li.type !== "listItem") return false;
    const fp = li.children?.find((c: any) => c.type === "paragraph");
    if (!fp) return false;
    const text = toString(fp);
    for (const preset of applicableTaskPresets) {
      if (preset.idRe.test(text)) return true;
    }
    return false;
  };

  // Yields each paragraph reachable from `taskNode`, but stops descending into
  // any nested listItem that is itself a task. Per-paragraph iteration prevents
  // a `(?<=Requirements:...)`-style regex from leaking across paragraph
  // boundaries — each paragraph is matched in isolation.
  function* paragraphsInScope(taskNode: any): Generator<string> {
    function* walk(n: any, isRoot: boolean): Generator<string> {
      if (!isRoot && n.type === "listItem" && isTaskListItem(n)) return;
      if (n.type === "paragraph") {
        yield toString(n);
        return;
      }
      if (n.children) {
        for (const child of n.children) yield* walk(child, false);
      }
    }
    yield* walk(taskNode, true);
  }

  visit(tree, "listItem", (node: any) => {
    const firstParagraph = node.children?.find((c: any) => c.type === "paragraph");
    const labelText = firstParagraph ? toString(firstParagraph) : toString(node);

    if (applicableTaskPresets.length > 0) {
      let matched: { taskId: string; preset: ApplicablePreset } | null = null;
      for (const preset of applicableTaskPresets) {
        const m = labelText.match(preset.idRe);
        if (m && m[1] != null) {
          matched = { taskId: m[1], preset };
          break;
        }
      }
      if (matched !== null) {
        const { taskId, preset } = matched;
        nodes.push({
          id: taskId,
          kind: "task",
          filePath: relPath,
          label: labelText,
          contentHash: hash(labelText),
        });

        if (preset.implRe || preset.verifiesRe) {
          for (const paragraphText of paragraphsInScope(node)) {
            if (preset.implRe) {
              preset.implRe.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = preset.implRe.exec(paragraphText)) !== null) {
                const target = m[1].trim();
                if (target === "") continue;
                edges.push({ source: taskId, target, kind: "implements" });
              }
            }
            if (preset.verifiesRe) {
              preset.verifiesRe.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = preset.verifiesRe.exec(paragraphText)) !== null) {
                const target = m[1].trim();
                if (target === "") continue;
                edges.push({ source: taskId, target, kind: "verifies" });
              }
            }
          }
        }
        return;
      }
    }

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
