import { readFileSync } from "node:fs";
import { relative } from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import { createHash } from "node:crypto";
import type { GraphNode, GraphEdge } from "../types.js";

const LIST_ITEM_RE = /^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/;
const KIRO_HEADING_RE = /^Requirement\s+(\d+)\s*:/;

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

export function parseMarkdown(filePath: string, rootDir?: string, specDirPrefix?: string): ParsedSpec {
  const raw = readFileSync(filePath, "utf-8");
  const relPath = rootDir ? relative(rootDir, filePath) : filePath;
  const docRelPath =
    specDirPrefix && relPath.startsWith(specDirPrefix + "/")
      ? relPath.slice(specDirPrefix.length + 1)
      : relPath;

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

  // Always generate a doc node (US1: T026)
  // Auto-generated ID uses specDir-relative path per FR-001 / research R3
  const docId = spectraceMeta?.node_id ?? `doc:${docRelPath}`;
  nodes.push({
    id: docId,
    kind: "doc",
    filePath: relPath,
    label: docId,
    contentHash: fileHash,
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
    const match = labelText.match(LIST_ITEM_RE);
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
    const match = text.match(KIRO_HEADING_RE);
    if (!match) return;

    const reqId = `Requirement-${match[1]}`;
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
