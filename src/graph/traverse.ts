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
//
// issue #286 — `exercises` (req -> symbol|file, coverage-derived) is now the
// SECOND edge kind the BFS below does not unconditionally treat as
// bidirectional (alongside `contains` above), for the exact same class of
// reason. A symbol-start BFS that reverse-follows `exercises` (node -> req)
// reaches every REQ whose test happens to CALL that symbol, not just the
// REQ(s) the symbol actually implements — e.g. a "create X, then read X back
// to verify" test pattern means the read-verification symbol's `exercises`
// edge fans out to every REQ under test, even ones with zero code
// relationship to that symbol (reported against a real project: `getBookmark`
// picked up `markRead`/`favorite`/`archive` REQs solely because each of those
// REQs' tests called `getBookmark` to assert on resulting state).
//
// PR #299 meta-review Finding 2 (Option 2B, partial re-enable) — an
// unconditional reverse-`exercises` skip has a real cost: `check`/
// `plan-coverage` fold `impact()`'s `impactReqs`/`affectedDocs`/
// `affectedFiles` into their `--diff --gate` scope filter (see
// `src/commands/check.ts`'s `buildScope`, `src/plan-coverage/index.ts`), so a
// REQ with NO `implements` edge at all — the `acceptExercises: true`
// evidence-only workflow, spec 020 FR-012〜015 — becomes permanently
// unreachable from a symbol/file startId once reverse `exercises` is fully
// blocked, and `check --diff --gate` silently drops it from scope. The fix:
// reverse `exercises` traversal is BLOCKED only when the source REQ has at
// least one `implements` edge somewhere in the graph (the #286 leak class —
// a REQ that already has a real `@impl` claim doesn't need a reverse
// `exercises` walk to be reachable, and allowing it is what leaked sibling
// REQs). It is ALLOWED when the source REQ has NO `implements` edge at all
// (evidence-only REQ), since in that case there is no other path back to the
// REQ and no sibling-REQ leak risk (an evidence-only REQ's `exercises` edges
// are its ONLY edges, so reverse-walking them reaches only itself, never a
// sibling). `reqsWithImplements` (computed once per `impact()` call, below)
// is the precomputed membership check this conditional relies on. This is a
// partial fix, not full provenance-aware reverse traversal — a REQ that HAS
// an `@impl` claim on some OTHER symbol still cannot be reached in reverse
// from an incidentally-exercised symbol (the original #286 case stays
// fixed); full provenance-aware traversal (e.g. distinguishing "this REQ's
// own exclusive evidence" from "somebody else's incidental call") is tracked
// separately as issue #298. See specs/020's FR-017 note for the original
// analysis. `symbol -> REQ` reachability for a REQ that DOES have an
// `@impl` claim is NOT lost: it is carried by the (always-forward-and-
// reverse) `implements` edge, which only exists when the symbol genuinely
// claims the REQ via `@impl` — exactly the distinction #286 needs.
// `--tests` (`impact --diff --tests`) is unaffected by any of this: it
// resolves tests via `ingestedTrace.reqsByNode` directly, never via this BFS.
//
// issue #303 — Option 2B (above) closed the reverse-`exercises` leak but PR
// #299's own E2E verification found the SAME user-visible symptom
// ("unrelated REQ shows up in `impact(<symbol>)`") reproduces through a
// DIFFERENT mechanism it doesn't touch: `verifies` and `imports` are both
// unconditionally bidirectional, and a TEST node is a natural hub for both —
// one test file routinely `verifies` several sibling REQs (one per `it()`
// block) and `imports` several sibling src symbols/files it exercises. A
// symbol-start BFS that reverse-walks INTO a test hub for REQ-A's sake (via
// `verifies` or `imports`) and then forward-walks back OUT of that SAME hub
// picks up REQ-A's siblings too — REQs (or files) with zero code
// relationship to the original symbol. Two concrete paths from the repro:
//   (1) `symbol:fnB -(fwd implements)-> REQ-902 -(rev verifies)-> test file
//       -(fwd verifies)-> REQ-901` — REQ-901's test happens to import fnB's
//       module for a side-assertion, so fnB's own `implements` edge to
//       REQ-902 is enough to reach the shared test hub.
//   (2) `symbol:fnB -(rev imports)-> test file -(fwd verifies)-> REQ-901` —
//       even a bare `import { fnA, fnB } from "../src/sample"` (no
//       assertion at all) makes the test file a hub for fnB.
// This is the same "hub node bridges unrelated siblings" shape #215
// (`contains`) and #286 (`exercises`) already fixed for their own edge
// kinds, applied to the two kinds that survived those fixes. The mitigation
// (applied in the BFS loop below): a node reached via a REVERSE
// `verifies`/`imports` hop onto a `kind === "test"` node is a "restricted
// test hub" — its OWN forward `verifies` edges only continue to REQs that
// are evidence-only (`!reqsWithImplements.has(target)`, preserving the
// Option 2B evidence-only guarantee so this fix cannot repeat the #286
// gate-false-green regression), and its OWN forward `imports` edges are
// never followed at all (closing repro path (2) — a bare import declaration
// through a test hub has no assertion-based relationship to reach through).
// A test node reached any OTHER way (a startId, a forward hop, e.g. the
// test verifying/importing something that then reverse-reaches it from a
// DIFFERENT direction) stays fully unrestricted — see the `visited`
// two-state (`"restricted"` / `"unrestricted"`) bookkeeping below, which
// lets a later unrestricted arrival upgrade and re-expand a node an earlier
// restricted arrival under-explored. Every non-test node, and every
// reverse-`verifies`/`imports` hop that does NOT land on a test node,
// is entirely unaffected — this is strictly narrower than #215/#286's
// direction-level blocks.
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
   *
   * Note (issue #286 / PR #299 Finding 2, Option 2B): the loop below never
   * attempts a node->req reverse walk over a non-stale `exercises` edge whose
   * source REQ has an `implements` edge (the #286 leak class) — that much is
   * unconditional, staleness aside. But since Option 2B, reverse `exercises`
   * is CONDITIONALLY allowed for a REQ with NO `implements` edge at all
   * (evidence-only, `reqsWithImplements` doesn't contain it). This
   * `excludeStaleExercises` check runs FIRST in the loop and `continue`s
   * before either the forward or the conditional-reverse branch below is
   * reached, so a stale `exercises` edge is skipped regardless of whether its
   * REQ would otherwise qualify for the reverse-allowed case — staleness
   * exclusion always wins over the Option 2B allowance. The "covers both...in
   * the same loop iteration" language above still describes this option's own
   * short-circuit correctly; it does not mean non-stale `exercises` edges are
   * unconditionally bidirectional elsewhere in the function — reverse
   * traversal of a non-stale `exercises` edge remains gated by
   * `reqsWithImplements` as described in the file-header comment.
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

  // PR #299 meta-review Finding 2 (Option 2B) — precompute which REQ ids
  // have at least one `implements` edge ANYWHERE in the graph (not just
  // within the eventual `visited` set — this must be known up front,
  // independent of BFS order, since it gates whether a reverse `exercises`
  // walk is even attempted). A REQ in this set is the #286 leak class
  // (reachable via its own `@impl` claim, so reverse `exercises` must stay
  // blocked for it); a REQ absent from this set is evidence-only and reverse
  // `exercises` is its only possible path back, so it's allowed through.
  const reqsWithImplements = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "implements") continue;
    const target = graph.nodes.get(edge.target);
    if (target?.kind === "req") reqsWithImplements.add(edge.target);
  }

  // issue #303 — a `visited` node now carries one of two reach states:
  // `"restricted"` (reached ONLY via a reverse `verifies`/`imports` hop onto
  // a `kind === "test"` node, the pass-through-hub shape below) or
  // `"unrestricted"` (every other kind of arrival: a start id, a forward
  // hop, a reverse hop onto a non-test node, or a reverse hop over some
  // OTHER edge kind). `"unrestricted"` is always final. A node visited
  // `"restricted"` may later be UPGRADED by an `"unrestricted"` arrival
  // (e.g. the test file is also a startId, or a second, unrestricted path
  // reaches it) — the upgrade re-enters the queue and gets fully
  // re-expanded, since the earlier restricted visit may have skipped edges
  // an unrestricted visit is allowed to take. This does not double-count
  // anything: `visited`'s KEYS (not its values) are what every downstream
  // aggregation loop (`affectedFiles`/`impactReqs`/drift/provenance) reads,
  // and a key is only ever added once.
  const visited = new Map<string, "restricted" | "unrestricted">();
  const queue: Array<{ id: string; depth: number; restrictedTestHub: boolean }> = startIds.map(
    (id) => ({ id, depth: 0, restrictedTestHub: false }),
  );

  // Is `next` new information for a node currently at `existing` (undefined
  // = never visited)? Shared by the dequeue-time re-processing guard and
  // every push-time dedup guard below so they can never disagree about what
  // counts as "worth (re-)expanding".
  const isNewReach = (
    existing: "restricted" | "unrestricted" | undefined,
    next: "restricted" | "unrestricted",
  ): boolean => {
    if (existing === "unrestricted") return false;
    if (existing === "restricted") return next === "unrestricted";
    return true;
  };

  while (queue.length > 0) {
    const { id, depth, restrictedTestHub } = queue.shift()!;
    const state: "restricted" | "unrestricted" = restrictedTestHub ? "restricted" : "unrestricted";
    if (!isNewReach(visited.get(id), state)) continue;
    visited.set(id, state);

    if (maxDepth !== undefined && depth >= maxDepth) continue;

    const node = graph.nodes.get(id);
    if (node && node.kind === "file") {
      for (const [symId, symNode] of graph.nodes) {
        if (
          symNode.kind === "symbol" &&
          symNode.filePath === node.filePath &&
          isNewReach(visited.get(symId), "unrestricted")
        ) {
          queue.push({ id: symId, depth: depth + 1, restrictedTestHub: false });
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
      if (edge.source === id) {
        // issue #303 — `restrictedTestHub` is true only when THIS dequeue
        // instance reached a `kind === "test"` node via a reverse
        // `verifies`/`imports` hop (see the reverse-branch comment below).
        // That test node is a pass-through hub: a test file typically
        // `verifies` several sibling REQs and `imports` several sibling src
        // symbols/files that have nothing to do with each other, so
        // treating ITS OWN forward `verifies`/`imports` edges as
        // unconditionally bidirectional lets a BFS that arrived at the hub
        // for REQ-A's sake walk right back out to REQ-B (or REQ-B's
        // implementing file) — the hub-node leak class this issue reports
        // (see the file-header comment for the two concrete repro paths).
        // Two restrictions apply, ONLY when `restrictedTestHub` is true for
        // this node, and ONLY to these two edge kinds:
        //  (a) forward `verifies` (test -> req): blocked when the target
        //      REQ has an `implements` edge somewhere in the graph
        //      (`reqsWithImplements`) — that REQ has its own `@impl`-based
        //      reachability and doesn't need this hub to reach it (blocking
        //      it here is what closes the leak). Left OPEN when the target
        //      REQ has NO `implements` edge anywhere (evidence-only,
        //      `acceptExercises: true` workflow) — for that REQ, an
        //      exercising test IS its only path back, so blocking it here
        //      unconditionally would repeat the #286 gate-false-green
        //      regression Option 2B (PR #299) fixed for reverse `exercises`.
        //  (b) forward `imports` (test -> imported file/symbol): always
        //      blocked. This closes the 4th leak mechanism from the issue:
        //      reverse `imports` INTO a test (a bare import declaration,
        //      no assertion) followed by forward `imports` back OUT of that
        //      same test into an unrelated sibling src file, reaching that
        //      sibling's REQ purely because both files happen to be
        //      imported by the same test.
        // Every other forward edge kind, and every forward edge out of a
        // non-restricted node, keeps its pre-#303 unconditional semantics.
        let blocked = false;
        if (restrictedTestHub) {
          if (edge.kind === "verifies") {
            blocked = reqsWithImplements.has(edge.target);
          } else if (edge.kind === "imports") {
            blocked = true;
          }
        }
        if (!blocked && isNewReach(visited.get(edge.target), "unrestricted")) {
          queue.push({ id: edge.target, depth: depth + 1, restrictedTestHub: false });
        }
      }
      // spec 019 (FR-001〜003) / issue #286 / PR #299 Finding 2 (Option 2B):
      // reverse traversal (target -> source) skips `contains` edges so a
      // req/task node cannot walk "backwards" into its parent doc during
      // BFS. Reverse traversal of an `exercises` edge is BLOCKED only when
      // its source REQ has an `implements` edge somewhere in the graph (the
      // #286 leak class — see the file-header comment for the full
      // rationale and the readlater/getBookmark repro); it is ALLOWED when
      // the source REQ has no `implements` edge at all, so an evidence-only
      // REQ (`acceptExercises: true` workflow, no `@impl` anywhere) stays
      // reachable from the symbol/file it's exercised by — otherwise
      // `check --diff --gate` / `plan-coverage` would silently drop it from
      // scope (issue #286, full provenance-aware traversal tracked as
      // #298). Every other edge kind keeps unconditional reverse traversal.
      if (
        edge.target === id &&
        edge.kind !== "contains" &&
        !(edge.kind === "exercises" && reqsWithImplements.has(edge.source))
      ) {
        // issue #303 — a reverse hop that lands on a `kind === "test"` node
        // via `verifies` or `imports` is the pass-through-hub ARRIVAL: mark
        // it `restricted` so the forward-branch restriction above applies
        // when this dequeue instance is later expanded. A reverse hop onto
        // any OTHER node kind, or via any OTHER edge kind (`implements` /
        // `depends_on` / `derives_from` / the evidence-only-allowed
        // `exercises`), stays `unrestricted` — unchanged from pre-#303
        // behavior; only the test-hub arrival itself is new.
        const reachesTestHub =
          (edge.kind === "verifies" || edge.kind === "imports") &&
          graph.nodes.get(edge.source)?.kind === "test";
        const nextState: "restricted" | "unrestricted" = reachesTestHub
          ? "restricted"
          : "unrestricted";
        if (isNewReach(visited.get(edge.source), nextState)) {
          queue.push({ id: edge.source, depth: depth + 1, restrictedTestHub: reachesTestHub });
        }
      }
    }
  }

  const affectedFileSet = new Set<string>();
  const affectedDocsSet = new Set<string>();
  const impactReqs: string[] = [];
  const affectedTasks: string[] = [];
  const drifted: DriftEntry[] = [];

  for (const id of visited.keys()) {
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
  // (`"unrestricted"`: attribution is a declarative one-hop lookup, not a
  // hub-arrival, so it carries none of the #303 restriction — setting on an
  // already-visited req is a no-op either way) purely so the shared drift
  // loop below covers both BFS-reached and attribution-reached docs without
  // duplicating the lock-comparison logic.
  for (const id of affectedDocs) {
    visited.set(id, "unrestricted");
  }

  for (const id of visited.keys()) {
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
