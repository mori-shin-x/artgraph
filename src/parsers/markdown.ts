import { readFileSync } from "node:fs";
import { relative } from "node:path";
import matter from "gray-matter";
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

export interface ParseWarning {
  type: "invalid-relation" | "reserved-prefix";
  key: string;
  filePath: string;
}

interface ParsedSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: ParseWarning[];
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

  const VALID_SPECTRACE_KEYS = new Set(["node_id", "derives_from", "depends_on"]);

  const spectraceMeta = frontmatter?.spectrace as
    | { node_id?: string; derives_from?: string[]; depends_on?: string[]; [key: string]: unknown }
    | undefined;

  const docId = spectraceMeta?.node_id ?? `doc:${docRelPath}`;
  const metadata = extractMetadata(frontmatter);
  nodes.push({
    id: docId,
    kind: "doc",
    filePath: relPath,
    label: docId,
    contentHash: fileHash,
    ...(metadata && { metadata }),
  });

  if (spectraceMeta) {
    // Validate keys (T018: invalid-relation warning)
    for (const key of Object.keys(spectraceMeta)) {
      if (!VALID_SPECTRACE_KEYS.has(key)) {
        warnings.push({
          type: "invalid-relation",
          key,
          filePath: relPath,
        });
      }
    }

    // Generate derives_from edges (T017)
    if (Array.isArray(spectraceMeta.derives_from)) {
      for (const target of spectraceMeta.derives_from) {
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
    if (Array.isArray(spectraceMeta.depends_on)) {
      for (const target of spectraceMeta.depends_on) {
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
    if (!match) return;

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
    if (!match) return;

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

  return { nodes, edges, warnings };
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
