import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ArtifactGraph, DriftEntry, ImpactResult, SymbolEntry } from "../types.js";
import type { LockFile } from "../types.js";

// spec 019 (FR-001〜006, issue #215) — `contains` (doc -> req|task) is the
// ONE edge kind the BFS below does not treat as bidirectional. Every other
// edge kind (`depends_on` / `derives_from` / `implements` / `verifies` /
// `imports`) and the file→symbol expansion (the `node.kind === "file"`
// branch below) keep the spec 014/016 bidirectional semantics unchanged.
//
// Why: Spec Kit / Kiro's standard layout is "1 feature = 1 spec.md with
// multiple REQs". Treating `contains` as bidirectional let a symbol-unit
// BFS walk req -> (reverse contains) parent doc -> (forward contains)
// sibling req -> sibling req's implementors, dragging the WHOLE feature's
// REQ set into `impactReqs` / `affectedFiles` / `drifted` even when the
// target symbol has zero code dependency on the sibling. That defeated the
// per-change-context value proposition `artgraph impact` exists for (see
// specs/019-impact-doc-containment/spec.md US1). The same amplification
// happens one hub further for tasks: a task's `implements` edge to its REQ
// plus tasks.md's `contains` edges to every sibling task reconstructs the
// same blowup through the task layer, so the direction constraint applies
// uniformly to `contains` edges regardless of whether the target is a req
// or a task node (FR-003) — restricting only req targets leaves the task
// path wide open and the symptom returns almost unchanged.
//
// The parent doc is not simply dropped: after the BFS below completes,
// `impact()` re-attaches each visited req/task's parent doc(s) via a
// one-hop, non-recursive post-processing pass (FR-004〜006, "attribution").
// Attributed docs land in `affectedDocs` and participate in drift detection
// exactly like BFS-reached docs, but nothing is expanded FROM an attributed
// doc — so attribution restores "which spec is this REQ's home" context
// without reopening the sibling-REQ leak. `maxDepth` no longer needs to
// double as a `contains`-blast-radius mitigation (the old comment's
// workaround is gone): attribution is a depth-independent post-BFS step,
// so `maxDepth` keeps its one meaning — how many graph-edge hops the BFS
// itself takes.
//
// File→symbol expansion (the `node.kind === "file"` branch below) is the
// reason a file startId still drags in same-file symbols; for symbol startIds
// `resolveStartIds` deliberately omits the parent file node so a symbol-unit
// input doesn't sweep up its siblings (spec 016 R-006 mitigation).
// spec 020 (FR-017, contracts/cli-surface.md §5) — `impact()`'s optional 5th
// argument. Kept as a trailing options object (rather than widening the
// existing `maxDepth?: number` 4th param) so every pre-020 call site
// (`impact(graph, startIds, lock)`, `impact(graph, startIds, lock, 1)`)
// keeps compiling unchanged.
export interface ImpactTraversalOptions {
  /**
   * `trace.staleness === "exclude"` node-id set (`computeStaleNodeIds`'s
   * output, or the subset of it the caller cares about). Every `exercises`
   * edge touching one of these nodes is skipped ENTIRELY during BFS — not
   * just one direction — since an `exercises` edge only ever connects a req
   * to the symbol/file it exercises (`edge.target`, data-model.md §4: "req
   * -> symbol|file, forward only"); skipping it once at that check covers
   * both the req->node forward walk and the node->req reverse walk in the
   * same loop iteration. Every other edge kind, and every non-stale
   * `exercises` edge, traverses exactly as before (US3 baseline unaffected).
   */
  excludeStaleExercises?: ReadonlySet<string>;
}

export function impact(
  graph: ArtifactGraph,
  startIds: string[],
  lock: LockFile,
  maxDepth?: number,
  options?: ImpactTraversalOptions,
): ImpactResult {
  const staleExercisesNodes = options?.excludeStaleExercises;
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
      // spec 020 (FR-017, US5-2/US3 ⑥) — a stale `exercises` edge is
      // excluded from traversal altogether when `staleness: "exclude"`.
      if (
        edge.kind === "exercises" &&
        staleExercisesNodes &&
        staleExercisesNodes.has(edge.target)
      ) {
        continue;
      }
      if (edge.source === id && !visited.has(edge.target)) {
        queue.push({ id: edge.target, depth: depth + 1 });
      }
      // spec 019 (FR-001〜003): reverse traversal (target -> source) skips
      // `contains` edges so a req/task node cannot walk "backwards" into its
      // parent doc during BFS. Every other edge kind keeps reverse traversal.
      if (edge.target === id && edge.kind !== "contains" && !visited.has(edge.source)) {
        queue.push({ id: edge.source, depth: depth + 1 });
      }
    }
  }

  const affectedFileSet = new Set<string>();
  const affectedDocsSet = new Set<string>();
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
        affectedDocsSet.add(id);
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
  }

  // spec 019 (FR-004〜006) — post-BFS attribution: resolve the parent doc(s)
  // of every visited req/task node via `contains` edges and union them into
  // `affectedDocs`. This is a one-hop, non-recursive lookup over `visited`
  // (not a queue push), so an attributed doc never seeds further expansion —
  // its OTHER children never enter `impactReqs` / `affectedFiles`.
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const target = graph.nodes.get(edge.target);
    if (!target || (target.kind !== "req" && target.kind !== "task")) continue;
    if (!visited.has(edge.target)) continue;
    // Symmetric with the target guard above: builder.ts only ever emits
    // `contains` from doc nodes, but impact() also receives hand-built
    // graphs (tests, embedders) — a dangling or non-doc source must not
    // leak into `affectedDocs`.
    if (graph.nodes.get(edge.source)?.kind !== "doc") continue;
    affectedDocsSet.add(edge.source);
  }

  const affectedDocs = [...affectedDocsSet];

  // spec 019 (FR-005) — attributed docs are drift-checked exactly like any
  // other visited node; docs unioned in above are added to `visited` here
  // (`Set.add` on an already-visited req is a no-op) purely so the shared
  // drift loop below covers both BFS-reached and attribution-reached docs
  // without duplicating the lock-comparison logic.
  for (const id of affectedDocs) {
    visited.add(id);
  }

  for (const id of visited) {
    const node = graph.nodes.get(id);
    if (!node || (node.kind !== "req" && node.kind !== "doc")) continue;
    if (!lock[id]) continue;
    if (lock[id].contentHash !== node.contentHash) {
      drifted.push({
        nodeId: id,
        kind: node.kind,
        lockedHash: lock[id].contentHash,
        currentHash: node.contentHash,
      });
    }
  }

  // spec 020 (FR-017, contracts/cli-surface.md §5) — post-BFS provenance
  // attribution, same one-hop non-recursive shape as the `contains`
  // attribution pass above: for every visited req, look at edges directly
  // incident to it (either direction) whose OTHER endpoint is ALSO visited,
  // and classify by edge kind. An `exercises` edge contributes "evidence"; any
  // other kind contributes "static" — a req can carry both when it's reached
  // through, say, a static import chain AND directly by a test's exercises
  // edge. Gated behind "does the graph have ANY exercises edge at all" so a
  // trace-absent scan (zero exercises edges) never adds this key to
  // `ImpactResult` — FR-010 byte-identical requirement (T021(e)).
  const graphHasExercisesEdges = graph.edges.some((e) => e.kind === "exercises");
  let reqProvenance: ImpactResult["reqProvenance"];
  if (graphHasExercisesEdges) {
    const provenanceByReq = new Map<string, Set<"static" | "evidence">>();
    for (const edge of graph.edges) {
      // `contains` (doc -> req|task) is an ATTRIBUTION relation, not a
      // code-reachability path — the post-BFS attribution pass above unions
      // a req's parent doc into `visited` regardless of how the req itself
      // was reached, so counting a `contains` edge here would mislabel an
      // evidence-only req as also "static" merely because it and some
      // sibling req share a parent doc. Only genuine reachability edge kinds
      // (`implements` / `verifies` / `depends_on` / `derives_from` /
      // `imports`, i.e. everything except `contains`/`exercises`) count as
      // "static".
      if (edge.kind === "contains") continue;
      const sourceIsReq = graph.nodes.get(edge.source)?.kind === "req";
      const targetIsReq = graph.nodes.get(edge.target)?.kind === "req";
      const reqSide = sourceIsReq ? edge.source : targetIsReq ? edge.target : undefined;
      if (reqSide === undefined || !visited.has(reqSide)) continue;
      const other = reqSide === edge.source ? edge.target : edge.source;
      if (!visited.has(other)) continue;
      let set = provenanceByReq.get(reqSide);
      if (!set) {
        set = new Set();
        provenanceByReq.set(reqSide, set);
      }
      set.add(edge.kind === "exercises" ? "evidence" : "static");
    }
    reqProvenance = [...provenanceByReq.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reqId, set]) => ({ reqId, provenance: [...set].sort() }));
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
    ...(reqProvenance ? { reqProvenance } : {}),
    summary: {
      docs: affectedDocs.length,
      reqs: impactReqs.length,
      files: affectedFiles.length,
      tasks: affectedTasks.length,
    },
  };
}

// spec 017 (FR-006, data-model §2) — an `@impl`/`@verifies` edge whose target
// REQ/doc node does not exist in the graph. Structured (rather than a flat
// string) so `check()` can strict-match `source` against the diff scope
// instead of the old substring `includes` heuristic. Also the shape consumed
// by the `--serve` renderer (issue #155) to compare bare node ids without
// re-parsing the formatted `orphans` strings.
export interface OrphanEdge {
  source: string; // e.g. "file:src/foo.ts" / "test:src/foo.test.ts"
  target: string; // the REQ/doc id that did not resolve
  kind: "implements" | "verifies";
}

// SSOT: the canonical `source -> target (kind)` rendering used everywhere an
// orphan is shown or turned into an identity key (spec 017 R4). Keeping this
// in one place means `CheckResult.orphans`, the baseline key set, and the
// presenter never drift on formatting.
export function formatOrphan(o: OrphanEdge): string {
  return `${o.source} -> ${o.target} (${o.kind})`;
}

export function findOrphans(graph: ArtifactGraph): OrphanEdge[] {
  const orphans: OrphanEdge[] = [];

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
 * `impact()` / `check()` / `plan-coverage` start ids.
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

/**
 * Primary origin node id set for an entry — used as input to
 * `resolveOriginReqs` so a file-unit entry does NOT inherit its children
 * symbols' `@impl` claims (data-model.md §3.2). `resolveStartIds`
 * deliberately expands file-unit entries to include same-file symbols for
 * BFS reach; that expansion is the WRONG basis for origin attribution.
 *
 * Barrel note (issue #191): a barrel symbol re-exported from another file
 * (`export { x } from "./origin"`) carries no `implements` edge of its
 * own; the `@impl` tag lives on the origin symbol. Walk `imports` edges
 * (symbol → symbol only) transitively from a symbol primary so
 * `resolveOriginReqs` reaches the origin's claim through however many
 * barrel hops separate them. `A ↔ B` cycles bounded by visited set.
 * Shared between `plan-coverage` and `artgraph impact` so both commands
 * see the same origin attribution.
 */
export function entryOriginIds(entry: SymbolEntry, graph: ArtifactGraph): string[] {
  const path = normalizeForLookup(entry.path);
  if (entry.symbol === undefined) return [`file:${path}`];
  const primary = `symbol:${path}#${entry.symbol}`;
  const visited = new Set<string>([primary]);
  const queue: string[] = [primary];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.kind !== "imports") continue;
      if (edge.source !== current) continue;
      if (!edge.target.startsWith("symbol:")) continue;
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      queue.push(edge.target);
    }
  }
  return [...visited];
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
