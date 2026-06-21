import { resolve, relative, basename, dirname } from "node:path";
import { globSync } from "glob";
import { parseMarkdown } from "../parsers/markdown.js";
import { createTSParser } from "../parsers/typescript.js";
import type { ArtifactGraph, GraphNode, GraphEdge, SpectraceConfig } from "../types.js";

export interface BuildWarning {
  type: "duplicate-id" | "ambiguous-id";
  id: string;
  files: string[];
}

interface CollectedReq {
  id: string;
  specDir: string;
  node: GraphNode;
  edges: GraphEdge[];
}

export function buildGraph(
  rootDir: string,
  config: SpectraceConfig,
): { graph: ArtifactGraph; warnings: BuildWarning[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const warnings: BuildWarning[] = [];

  const specFiles = config.specDirs.flatMap((dir) => globSync(resolve(rootDir, dir, "**/*.md")));

  // Pass 1: collect all req nodes and detect collisions
  const collected: CollectedReq[] = [];
  const nonReqNodes: GraphNode[] = [];
  const nonReqEdges: GraphEdge[] = [];

  for (const file of specFiles) {
    const result = parseMarkdown(file, rootDir);
    const relFile = relative(rootDir, file);
    const specDir = extractSpecDir(relFile, config.specDirs);

    for (const node of result.nodes) {
      if (node.kind === "req") {
        collected.push({ id: node.id, specDir, node, edges: [] });
      } else {
        nonReqNodes.push(node);
      }
    }

    for (const edge of result.edges) {
      const isFromReq = collected.some((c) => c.node.id === edge.source || c.id === edge.source);
      if (isFromReq) {
        const req = collected.find((c) => c.node.id === edge.source || c.id === edge.source);
        if (req) req.edges.push(edge);
      } else {
        nonReqEdges.push(edge);
      }
    }
  }

  // Detect collisions: same raw ID in different spec dirs
  const idToDirs = new Map<string, Set<string>>();
  for (const req of collected) {
    const dirs = idToDirs.get(req.id) ?? new Set();
    dirs.add(req.specDir);
    idToDirs.set(req.id, dirs);
  }

  const collidingIds = new Set<string>();
  for (const [id, dirs] of idToDirs) {
    if (dirs.size > 1) {
      collidingIds.add(id);
    }
  }

  // Pass 2: register nodes with qualified IDs for collisions
  const idMapping = new Map<string, string>();

  for (const req of collected) {
    let finalId: string;
    if (collidingIds.has(req.id)) {
      finalId = `${req.specDir}/${req.id}`;
    } else {
      finalId = req.id;
    }

    idMapping.set(`${req.specDir}/${req.id}`, finalId);

    const node: GraphNode = {
      ...req.node,
      id: finalId,
    };

    const existing = nodes.get(finalId);
    if (existing && existing.filePath !== node.filePath) {
      warnings.push({
        type: "duplicate-id",
        id: finalId,
        files: [existing.filePath, node.filePath],
      });
    }
    nodes.set(finalId, node);

    for (const edge of req.edges) {
      edges.push({
        ...edge,
        source: edge.source === req.id ? finalId : edge.source,
        target: edge.target === req.id ? finalId : edge.target,
      });
    }
  }

  for (const node of nonReqNodes) {
    nodes.set(node.id, node);
  }

  // Remap non-req edge targets that reference colliding IDs
  for (const edge of nonReqEdges) {
    const remappedTarget = remapId(edge.target, idMapping, collidingIds);
    if (collidingIds.has(edge.target) && remappedTarget === edge.target) {
      const dirs = idToDirs.get(edge.target)!;
      warnings.push({
        type: "ambiguous-id",
        id: edge.target,
        files: [...dirs],
      });
    }
    edges.push({ ...edge, target: remappedTarget });
  }

  // Parse TypeScript files
  const codePatterns = [...config.include, ...config.testPatterns];
  const tsParser = createTSParser(rootDir, codePatterns, config.mode ?? "file");
  const tsResult = tsParser.parse();

  for (const node of tsResult.nodes) {
    addNodeWithDupCheck(nodes, node, warnings);
  }

  // Remap @impl/@verifies edge targets for colliding IDs
  for (const edge of tsResult.edges) {
    if ((edge.kind === "implements" || edge.kind === "verifies") && collidingIds.has(edge.target)) {
      const dirs = idToDirs.get(edge.target)!;
      warnings.push({
        type: "ambiguous-id",
        id: edge.target,
        files: [...dirs],
      });
    } else if (
      (edge.kind === "implements" || edge.kind === "verifies") &&
      edge.target.includes("/")
    ) {
      if (!nodes.has(edge.target)) {
        warnings.push({
          type: "ambiguous-id",
          id: edge.target,
          files: [],
        });
      }
      edges.push(edge);
    } else {
      edges.push(edge);
    }
  }

  return { graph: { nodes, edges }, warnings };
}

function extractSpecDir(relFilePath: string, specDirs: string[]): string {
  for (const specDir of specDirs) {
    if (relFilePath.startsWith(specDir + "/")) {
      const rest = relFilePath.slice(specDir.length + 1);
      const parts = rest.split("/");
      if (parts.length > 1) {
        return parts[0];
      }
    }
  }
  return basename(dirname(relFilePath));
}

function remapId(id: string, idMapping: Map<string, string>, collidingIds: Set<string>): string {
  if (!collidingIds.has(id)) return id;

  // Try to find a unique mapping
  const matches: string[] = [];
  for (const [qualifiedKey, finalId] of idMapping) {
    if (qualifiedKey.endsWith(`/${id}`)) {
      matches.push(finalId);
    }
  }

  // If ambiguous, return as-is (warning already emitted or will be)
  return matches.length === 1 ? matches[0] : id;
}

function addNodeWithDupCheck(
  nodes: Map<string, GraphNode>,
  node: GraphNode,
  warnings: BuildWarning[],
) {
  const existing = nodes.get(node.id);
  if (existing && existing.filePath !== node.filePath) {
    warnings.push({
      type: "duplicate-id",
      id: node.id,
      files: [existing.filePath, node.filePath],
    });
  }
  nodes.set(node.id, node);
}
