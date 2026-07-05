import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ArtifactGraph, EdgeKind, ImpactResult, DriftEntry } from "../types.js";
import type { LockFile } from "../types.js";
import type { SymbolEntry } from "../parsers/sdd-files.js";

/**
 * spec 007 / issue #155 — `findOrphans` output shape.
 *
 * Prior to the B1 fix `findOrphans` returned pre-formatted descriptor
 * strings (`"file:src/foo.ts -> REQ-999 (implements)"`), which the
 * `--serve` renderer then mistook for bare node ids and silently failed
 * to mark orphan nodes. Structured entries let both text output (via
 * `check.ts` -> `printCheckText`) and the render layer keep their own
 * projections of the same data (source id vs. descriptor line) without
 * re-parsing.
 */
export interface OrphanEntry {
  /** Bare id of the edge source (the file/symbol/test node that carries the orphan `@impl` / `@verifies` tag). */
  source: string;
  /** Bare id of the edge target — a REQ id that does NOT resolve to any node in the graph. */
  target: string;
  /** Which claim kind produced the orphan edge (`implements` or `verifies`). */
  kind: EdgeKind;
}

// spec 016 (R-006, data-model.md §2.3) — `impact()` BFS body is **unchanged
// from spec 014**. The redesign reroutes the startId construction (now via
// `resolveStartIds` taking `SymbolEntry[]`) and adds an out-of-band
// `originReqs` axis (via `resolveOriginReqs`) computed at the CLI / plan-
// coverage layer. The BFS traversal itself is BIDIRECTIONAL: edges are
// followed in both directions regardless of their declared source/target.
// This means:
//   - From a req node, traversal reaches the parent doc (via reverse contains edge)
//   - From a doc node, traversal reaches child reqs (via forward contains edge)
//   - Starting from any req, the blast radius includes sibling reqs in the same doc
//     (req -> parent doc -> sibling reqs -> their implementations)
// Use --depth to limit traversal when contains edges cause unexpectedly wide reach.
//
// File→symbol expansion (the `node.kind === "file"` branch below) is the
// reason a file startId still drags in same-file symbols; for symbol startIds
// `resolveStartIds` deliberately omits the parent file node so a symbol-unit
// input doesn't sweep up its siblings (R-006 mitigation).
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
        if (
          symNode.kind === "symbol" &&
          symNode.filePath === node.filePath &&
          !visited.has(symId)
        ) {
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
  const impactReqs: string[] = [];
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
        impactReqs.push(id);
        break;
      case "task":
        // task は planning node — req/doc とは別チャネルで集計する。
        // impactReqs に混ぜると uncovered 計算が task ID を req と誤認する。
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
    impactReqs,
    affectedTasks,
    drifted,
    // spec 016: `originReqs` is populated by callers (CLI / plan-coverage)
    // via `resolveOriginReqs` after impact() returns. impact() itself stays
    // strictly forward-BFS so the two axes remain independent (R-006).
    originReqs: [],
    summary: {
      docs: affectedDocs.length,
      reqs: impactReqs.length,
      files: affectedFiles.length,
      tasks: affectedTasks.length,
    },
  };
}

export function findOrphans(graph: ArtifactGraph): OrphanEntry[] {
  const orphans: OrphanEntry[] = [];

  for (const edge of graph.edges) {
    if (edge.kind === "implements" || edge.kind === "verifies") {
      // task → implements/verifies は planning artefact。target が必ずしも
      // graph 上の node とは限らない(Kiro の `_Requirements: 1.1, 2.3_` の
      // numeric ID は `Requirement-N` という別 ID として登録されるため)。
      // task-source の orphan は警告対象外。code-claim な orphan のみ拾う。
      if (graph.nodes.get(edge.source)?.kind === "task") continue;
      if (!graph.nodes.has(edge.target)) {
        orphans.push({ source: edge.source, target: edge.target, kind: edge.kind });
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
        e.kind === "implements" && e.target === id && graph.nodes.get(e.source)?.kind !== "task",
    );
    if (!hasImpl) {
      uncovered.push(id);
    }
  }

  return uncovered;
}

/**
 * spec 016 (R-004, R-005, data-model.md §2.1) — single resolver for
 * `impact()` / `check()` / `hook-pretool` / `plan-coverage` start ids.
 * Replaces spec 014's `resolveFileStartIds` (now removed). Behavior per
 * entry:
 *
 *  - `entry.symbol !== undefined` → look up `symbol:<path>#<symbol>` in
 *    the graph. Hit → push to `startIds` (file node intentionally NOT
 *    added, so symbol-unit BFS doesn't sweep sibling symbols via the
 *    file parent — see R-006). Miss → push the entry to `unresolvedSymbols`
 *    so the caller can emit `unresolvedSymbol` diagnostics / error text.
 *  - `entry.symbol === undefined` → file-unit. Look up `file:<path>`; on
 *    hit push the file node id. Same-file symbols are reached during BFS
 *    via the file→symbol expansion in `impact()`. As an additional
 *    `filePath===` fallback (kept from spec 014), if the file node isn't
 *    registered, drag in any node whose `filePath` equals the path so a
 *    spec-md input (`specs/auth.md`) still surfaces its parsed doc / req
 *    nodes.
 *
 * `startIds` is dedup'd; order follows `entries[]` input order (INV-S2).
 */
export function resolveStartIds(
  graph: ArtifactGraph,
  entries: SymbolEntry[],
): { startIds: string[]; unresolvedSymbols: SymbolEntry[] } {
  const startIds: string[] = [];
  const seen = new Set<string>();
  const unresolvedSymbols: SymbolEntry[] = [];

  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    startIds.push(id);
  };

  for (const entry of entries) {
    // Defensive normalization: `./src/foo.ts` / `src/sub/../foo.ts` get
    // collapsed to `src/foo.ts` so the `file:<path>` / `symbol:<path>#<n>`
    // lookups find nodes the graph builder registered under the canonical
    // repo-relative path. The Stage A parser already normalizes, but
    // callers that hand-roll inputs still need the safety net.
    const path = normalizeForLookup(entry.path);

    if (entry.symbol !== undefined) {
      const symId = `symbol:${path}#${entry.symbol}`;
      if (graph.nodes.has(symId)) {
        push(symId);
      } else {
        unresolvedSymbols.push(entry);
      }
      continue;
    }

    // file-unit entry: file node first, then the filePath= fallback for
    // spec md paths and other non-file nodes parsed out of a file.
    const fileId = `file:${path}`;
    if (graph.nodes.has(fileId)) {
      push(fileId);
      // Spec 014 behavior preserved: include same-file symbols explicitly so
      // file-unit callers see them in `startIds`. impact()'s file→symbol
      // expansion would also reach them during BFS, but pre-populating
      // here keeps the contract observable to callers that don't run BFS.
      for (const [id, node] of graph.nodes) {
        if (node.kind === "symbol" && node.filePath === path) push(id);
      }
      continue;
    }

    // filePath match — catches doc / req nodes parsed out of a spec file
    // when the caller passes the spec path itself (e.g. `specs/auth.md`).
    for (const [id, node] of graph.nodes) {
      if (node.filePath === path) push(id);
    }
  }

  return { startIds, unresolvedSymbols };
}

/**
 * spec 016 (R-015, INV-S5/INV-S6) — collect the REQ ids reached by walking
 * each startId's `implements` edges 1 hop in reverse (edge.source ===
 * startId, edge.target.kind === "req"). Returns dedup'd, reqId-asc sorted
 * array. Empty when no startId has an `@impl` claim.
 *
 * The union semantics make this safe to call with a mixed set of file and
 * symbol startIds; each contributes only the REQs it directly claims.
 */
export function resolveOriginReqs(graph: ArtifactGraph, startIds: string[]): string[] {
  const startSet = new Set(startIds);
  const reqs = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "implements") continue;
    if (!startSet.has(edge.source)) continue;
    const target = graph.nodes.get(edge.target);
    if (!target || target.kind !== "req") continue;
    reqs.add(edge.target);
  }
  return [...reqs].sort();
}

function normalizeForLookup(input: string): string {
  // Skip absolute paths — they can't be safely re-mapped to a repo-relative
  // form without knowing the repo root, and graph nodes are always keyed
  // by repo-relative paths. Caller already filtered abs paths in Stage A.
  if (isAbsolute(input)) return input;
  // Resolve against a synthetic root so `..` segments collapse without
  // dragging in real filesystem state. Inputs that escape "above" the root
  // are passed through unchanged so the existing miss behaviour applies.
  const root = "/__artgraph__";
  const abs = resolvePath(root, input);
  const rel = relative(root, abs);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) return input;
  return rel.split(sep).join("/");
}
