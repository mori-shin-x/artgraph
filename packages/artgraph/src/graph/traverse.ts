import type { ArtifactGraph, ImpactResult, DriftEntry } from "../types.js";
import type { LockFile } from "../types.js";

// BFS traversal is BIDIRECTIONAL: edges are followed in both directions regardless
// of their declared source/target. This means:
//   - From a req node, traversal reaches the parent doc (via reverse contains edge)
//   - From a doc node, traversal reaches child reqs (via forward contains edge)
//   - Starting from any req, the blast radius includes sibling reqs in the same doc
//     (req -> parent doc -> sibling reqs -> their implementations)
// Use --depth to limit traversal when contains edges cause unexpectedly wide reach.
export function impact(
  graph: ArtifactGraph,
  startIds: string[],
  lock: LockFile,
  maxDepth?: number,
): ImpactResult {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = startIds.map((id) => ({ id, depth: 0 }));

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    if (maxDepth !== undefined && depth >= maxDepth) continue;

    const node = graph.nodes.get(id);
    if (node && node.kind === "file") {
      for (const [symId, symNode] of graph.nodes) {
        if (symNode.kind === "symbol" && symNode.filePath === node.filePath && !visited.has(symId)) {
          queue.push({ id: symId, depth: depth + 1 });
        }
      }
    }

    for (const edge of graph.edges) {
      if (edge.source === id && !visited.has(edge.target)) {
        queue.push({ id: edge.target, depth: depth + 1 });
      }
      if (edge.target === id && !visited.has(edge.source)) {
        queue.push({ id: edge.source, depth: depth + 1 });
      }
    }
  }

  const affectedFileSet = new Set<string>();
  const affectedDocs: string[] = [];
  const affectedReqs: string[] = [];
  const affectedTasks: string[] = [];
  const drifted: DriftEntry[] = [];

  for (const id of visited) {
    const node = graph.nodes.get(id);
    if (!node) continue;

    switch (node.kind) {
      case "file":
      case "symbol":
      case "test":
        affectedFileSet.add(node.filePath);
        break;
      case "doc":
        affectedDocs.push(id);
        break;
      case "req":
        affectedReqs.push(id);
        break;
      case "task":
        // task は planning node — req/doc とは別チャネルで集計する。
        // affectedReqs に混ぜると uncovered 計算が task ID を req と誤認する。
        affectedTasks.push(id);
        break;
    }

    if ((node.kind === "req" || node.kind === "doc") && lock[id]) {
      if (lock[id].contentHash !== node.contentHash) {
        drifted.push({
          nodeId: id,
          kind: node.kind,
          lockedHash: lock[id].contentHash,
          currentHash: node.contentHash,
        });
      }
    }
  }

  const affectedFiles = [...affectedFileSet];
  return {
    affectedFiles,
    affectedDocs,
    affectedReqs,
    affectedTasks,
    drifted,
    summary: {
      docs: affectedDocs.length,
      reqs: affectedReqs.length,
      files: affectedFiles.length,
      tasks: affectedTasks.length,
    },
  };
}

export function findOrphans(graph: ArtifactGraph): string[] {
  const orphans: string[] = [];

  for (const edge of graph.edges) {
    if (edge.kind === "implements" || edge.kind === "verifies") {
      // task → implements/verifies は planning artefact。target が必ずしも
      // graph 上の node とは限らない(Kiro の `_Requirements: 1.1, 2.3_` の
      // numeric ID は `Requirement-N` という別 ID として登録されるため)。
      // task-source の orphan は警告対象外。code-claim な orphan のみ拾う。
      if (graph.nodes.get(edge.source)?.kind === "task") continue;
      if (!graph.nodes.has(edge.target)) {
        orphans.push(`${edge.source} -> ${edge.target} (${edge.kind})`);
      }
    }
  }

  return orphans;
}

export function findUncovered(graph: ArtifactGraph): string[] {
  const uncovered: string[] = [];

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req") continue;

    // coverage.ts と同じく task-source の implements は除外 — planning 関係
    // で req を "覆われた" と誤判定するとゲートが空振りする。
    const hasImpl = graph.edges.some(
      (e) =>
        e.kind === "implements" &&
        e.target === id &&
        graph.nodes.get(e.source)?.kind !== "task",
    );
    if (!hasImpl) {
      uncovered.push(id);
    }
  }

  return uncovered;
}

export function resolveStartIds(graph: ArtifactGraph, inputs: string[]): string[] {
  const ids: string[] = [];

  for (const input of inputs) {
    if (graph.nodes.has(input)) {
      ids.push(input);
      continue;
    }

    const fileId = `file:${input}`;
    if (graph.nodes.has(fileId)) {
      ids.push(fileId);
      for (const [id, node] of graph.nodes) {
        if (node.kind === "symbol" && node.filePath === input) {
          ids.push(id);
        }
      }
      continue;
    }

    // T048: doc: prefix resolution
    const docId = `doc:${input}`;
    if (graph.nodes.has(docId)) {
      ids.push(docId);
      // Do NOT continue — fall through to filePath match so that
      // req/file nodes sharing the same filePath are also collected.
    }

    for (const [id, node] of graph.nodes) {
      if (node.filePath === input && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }

  return ids;
}
