import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { createHash } from "node:crypto";
import type { GraphNode, GraphEdge } from "../types.js";

const REQ_HEADING_RE = /(?<id>REQ-[0-9a-f]{4,})\s*(?:\((?<slug>[^)]+)\))?/;

interface ParsedSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function parseMarkdown(filePath: string): ParsedSpec {
  const raw = readFileSync(filePath, "utf-8");
  const { data: frontmatter, content } = matter(raw);
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
      filePath,
      label: docId,
      contentHash: fileHash,
    });

    if (spectraceMeta.depends_on) {
      for (const dep of spectraceMeta.depends_on) {
        const edgeKind =
          dep.relation === "derives_from"
            ? "derives_from"
            : dep.relation === "implements"
              ? "implements"
              : "depends_on";
        edges.push({
          source: docId,
          target: dep.id,
          kind: edgeKind as GraphEdge["kind"],
        });
      }
    }
  }

  visit(tree, "heading", (node: any) => {
    const text = extractText(node);
    const match = text.match(REQ_HEADING_RE);
    if (!match?.groups) return;

    const reqId = match.groups.id;
    const slug = match.groups.slug;

    const headingContent = extractSectionContent(content, node.position.start.line);
    const reqHash = hash(headingContent);

    nodes.push({
      id: reqId,
      kind: "req",
      filePath,
      slug,
      label: text,
      contentHash: reqHash,
    });
  });

  return { nodes, edges };
}

function extractText(node: any): string {
  let text = "";
  visit(node, "text", (t: any) => {
    text += t.value;
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
