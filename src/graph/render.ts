import type { ArtifactGraph, CheckResult, EdgeKind, NodeKind } from "../types.js";

export type Layer = "req" | "doc" | "code" | "test";
export type NodeState = "ok" | "drift" | "orphan" | "uncovered";

export interface RenderNode {
  id: string;
  label: string;
  layer: Layer;
  kind: NodeKind;
  state: NodeState;
  filePath: string;
}

export interface RenderEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface RenderMeta {
  rootDir: string;
  generatedAt: string;
  stats: { total: number; drift: number; orphan: number; uncovered: number };
}

export interface RenderData {
  nodes: RenderNode[];
  edges: RenderEdge[];
  meta: RenderMeta;
}

export interface RenderOptions {
  rootDir: string;
  checkResult?: CheckResult;
  generatedAt?: string;
}

// GraphNode.kind → Layer. `task` returns null to signal "exclude from output".
function layerFor(kind: NodeKind): Layer | null {
  switch (kind) {
    case "req":
      return "req";
    case "doc":
      return "doc";
    case "file":
    case "symbol":
      return "code";
    case "test":
      return "test";
    case "task":
      return null;
  }
}

export function renderGraphData(graph: ArtifactGraph, options: RenderOptions): RenderData {
  const { rootDir, checkResult, generatedAt } = options;

  // Build state lookup sets. Precedence is enforced later at assignment time
  // (drift > orphan > uncovered) so a node appearing in multiple sets still
  // gets its highest-severity state.
  //
  // issue #155 (B1) — orphans are indexed by `orphanNodeIds` (bare source
  // node ids), NOT by `orphans` (which is the descriptor-string form used
  // by the text CLI). Using `orphans` here would compare `"file:X -> Y
  // (implements)"` against `node.id` and never match — silent false-clean
  // in the `--serve` UI.
  const driftIds = new Set<string>(checkResult?.drifted.map((d) => d.nodeId) ?? []);
  const orphanIds = new Set<string>(checkResult?.orphanNodeIds ?? []);
  const uncoveredIds = new Set<string>(checkResult?.uncovered ?? []);

  const nodes: RenderNode[] = [];
  const includedIds = new Set<string>();

  for (const node of graph.nodes.values()) {
    const layer = layerFor(node.kind);
    if (layer === null) continue; // task nodes are excluded

    let state: NodeState = "ok";
    if (driftIds.has(node.id)) {
      state = "drift";
    } else if (orphanIds.has(node.id)) {
      state = "orphan";
    } else if (uncoveredIds.has(node.id)) {
      state = "uncovered";
    }

    let label: string;
    if (node.label) {
      label = node.label;
    } else if (node.kind === "req") {
      label = node.id;
    } else {
      label = node.filePath.split("/").pop() ?? node.id;
    }

    nodes.push({
      id: node.id,
      label,
      layer,
      kind: node.kind,
      state,
      filePath: node.filePath,
    });
    includedIds.add(node.id);
  }

  const edges: RenderEdge[] = [];
  for (const edge of graph.edges) {
    if (!includedIds.has(edge.source) || !includedIds.has(edge.target)) continue;
    edges.push({ source: edge.source, target: edge.target, kind: edge.kind });
  }

  // Determinism: byte-stable ordering, matching format.ts/builder.ts style
  // (`<`/`>` instead of localeCompare so the output is locale-independent).
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    if (a.target !== b.target) return a.target < b.target ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  });

  let drift = 0;
  let orphan = 0;
  let uncovered = 0;
  for (const n of nodes) {
    if (n.state === "drift") drift++;
    else if (n.state === "orphan") orphan++;
    else if (n.state === "uncovered") uncovered++;
  }

  return {
    nodes,
    edges,
    meta: {
      rootDir,
      generatedAt: generatedAt ?? new Date().toISOString(),
      stats: { total: nodes.length, drift, orphan, uncovered },
    },
  };
}
