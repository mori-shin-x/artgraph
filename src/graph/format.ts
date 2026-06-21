import type { ArtifactGraph, NodeKind, GraphNode, GraphEdge } from "../types.js";

export function formatGraphText(graph: ArtifactGraph, kindFilter?: NodeKind): string {
  const { filteredNodes, filteredEdges } = applyFilter(graph, kindFilter);

  // Find root nodes — nodes that are upstream-most in the graph.
  // derives_from / depends_on: source=downstream, target=upstream
  //   -> the target is the *root* direction, so being a target does NOT disqualify.
  // contains / implements / verifies / imports: source=parent/upstream, target=child
  //   -> being a target DOES disqualify (the node has a parent).
  // Strategy: a node is a root when it never appears as a *downstream* endpoint.
  //   - For derives_from/depends_on edges: downstream = source
  //   - For other edges: downstream = target
  const downstreamIds = new Set<string>();
  for (const e of filteredEdges) {
    if (e.kind === "derives_from" || e.kind === "depends_on") {
      downstreamIds.add(e.source);
    } else {
      downstreamIds.add(e.target);
    }
  }
  const roots = [...filteredNodes.values()].filter((n) => !downstreamIds.has(n.id));

  // If no roots found, use all nodes as roots (cyclic graph)
  const rootList = roots.length > 0 ? roots : [...filteredNodes.values()];

  const lines: string[] = [];
  const visited = new Set<string>();

  for (let i = 0; i < rootList.length; i++) {
    if (i > 0) lines.push("");
    dfs(rootList[i].id, 0, filteredNodes, filteredEdges, visited, lines);
  }

  return lines.join("\n");
}

function dfs(
  nodeId: string,
  depth: number,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  visited: Set<string>,
  lines: string[],
): void {
  if (visited.has(nodeId)) return;
  visited.add(nodeId);

  if (depth === 0) {
    lines.push(nodeId);
  }

  // Find outgoing edges from this node (source === nodeId, meaning node -> target direction)
  // For derives_from / depends_on: the source is the dependent, the target is the dependency
  // For display purposes, we show children that point TO this node (reverse direction)
  const childEdges = edges.filter((e) => e.target === nodeId && !visited.has(e.source));

  for (const edge of childEdges) {
    const indent = "  ".repeat(depth + 1);
    lines.push(`${indent}└─[${edge.kind}]─ ${edge.source}`);
    dfs(edge.source, depth + 1, nodes, edges, visited, lines);
  }

  // Also show edges where this node is the source (contains, implements, etc.)
  const forwardEdges = edges.filter((e) => e.source === nodeId && !visited.has(e.target));

  for (const edge of forwardEdges) {
    const indent = "  ".repeat(depth + 1);
    lines.push(`${indent}└─[${edge.kind}]─ ${edge.target}`);
    dfs(edge.target, depth + 1, nodes, edges, visited, lines);
  }
}

export function formatGraphJSON(graph: ArtifactGraph, kindFilter?: NodeKind): string {
  const { filteredNodes, filteredEdges } = applyFilter(graph, kindFilter);

  const nodes = [...filteredNodes.values()].map((n) => ({
    id: n.id,
    kind: n.kind,
    filePath: n.filePath,
    label: n.label ?? n.id,
    contentHash: n.contentHash,
  }));

  const edges = filteredEdges.map((e) => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
  }));

  return JSON.stringify({ nodes, edges }, null, 2);
}

function applyFilter(
  graph: ArtifactGraph,
  kindFilter?: NodeKind,
): { filteredNodes: Map<string, GraphNode>; filteredEdges: GraphEdge[] } {
  if (!kindFilter) {
    return { filteredNodes: graph.nodes, filteredEdges: graph.edges };
  }

  const filteredNodes = new Map<string, GraphNode>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === kindFilter) {
      filteredNodes.set(id, node);
    }
  }

  const filteredEdges = graph.edges.filter(
    (e) => filteredNodes.has(e.source) && filteredNodes.has(e.target),
  );

  return { filteredNodes, filteredEdges };
}
