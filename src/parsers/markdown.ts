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

interface ParsedSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function parseMarkdown(filePath: string, rootDir?: string): ParsedSpec {
  const raw = readFileSync(filePath, "utf-8");
  const relPath = rootDir ? relative(rootDir, filePath) : filePath;

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

  const fileHash = hash(raw);

  const spectraceMeta = frontmatter?.spectrace as
    | { node_id?: string; depends_on?: Array<{ id: string; relation: string }> }
    | undefined;

  if (spectraceMeta?.node_id) {
    const docId = spectraceMeta.node_id;
    nodes.push({
      id: docId,
      kind: "doc",
      filePath: relPath,
      label: docId,
      contentHash: fileHash,
    });

    if (spectraceMeta.depends_on) {
      for (const dep of spectraceMeta.depends_on) {
        const edgeKind = dep.relation === "derives_from" ? "derives_from" : "depends_on";
        edges.push({
          source: docId,
          target: dep.id,
          kind: edgeKind as GraphEdge["kind"],
        });
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

  return { nodes, edges };
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
