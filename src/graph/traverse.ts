import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ArtifactGraph, DriftEntry, EdgeKind, ImpactResult, SymbolEntry } from "../types.js";
import type { LockFile } from "../types.js";

// ============================================================================
// History (spec 019 / #215, #286, #303) — WHY the BFS below does not treat
// every edge kind as unconditionally, symmetrically bidirectional.
// ============================================================================
//
// spec 019 (FR-001〜006, issue #215) — `contains` (doc -> req|task) was the
// FIRST edge kind found to need a direction constraint. Spec Kit / Kiro's
// standard layout is "1 feature = 1 spec.md with multiple REQs"; treating
// `contains` as bidirectional let a symbol-unit BFS walk
// req -> (reverse contains) parent doc -> (forward contains) sibling req ->
// sibling req's implementors, dragging the WHOLE feature's REQ set into
// `impactReqs` / `affectedFiles` / `drifted` even when the target symbol has
// zero code dependency on the sibling (specs/019-impact-doc-containment/
// spec.md US1). The fix: `contains` reverse traversal is blocked outright
// (R1, below); the parent doc is not simply dropped, though — after the BFS
// completes, `impact()` re-attaches each visited req/task's parent doc(s) via
// a one-hop, non-recursive post-processing pass (FR-004〜006, "attribution",
// unchanged by #361 — see MEDIUM-2 note there). File→symbol expansion (the
// `node.kind === "file"` branch below) is the reason a file startId still
// drags in same-file symbols; for symbol startIds `resolveStartIds`
// deliberately omits the parent file node (spec 016 R-006).
//
// issue #286 (PR #299 Option 2B) — `exercises` (req -> symbol|file,
// coverage-derived) was the SECOND edge kind found to need a direction
// constraint, for the same "hub bridges unrelated siblings" shape: a
// symbol-start BFS reverse-following `exercises` (node -> req) reached every
// REQ whose test happened to CALL that symbol, not just the REQ(s) the
// symbol actually implements. The historical (pre-#361) fix allowed reverse
// `exercises` ONLY for a REQ with NO `implements` edge anywhere
// (evidence-only, `reqsWithImplements` below) — since check/plan-coverage
// fold `impact()`'s results into their `--diff --gate` scope, fully blocking
// reverse `exercises` would make the `acceptExercises: true` evidence-only
// workflow (spec 020 FR-012〜015) permanently unreachable from a
// symbol/file startId and silently drop it from gate scope.
//
// issue #303 — Option 2B closed the reverse-`exercises` leak but the SAME
// symptom reproduced through `verifies`/`imports`, which stayed
// unconditionally bidirectional: a TEST node is a natural hub for both (one
// test file `verifies` several sibling REQs and `imports` several sibling
// src symbols). The historical fix: a node reached via a REVERSE
// `verifies`/`imports` hop onto a `kind === "test"` node became a
// "restricted test hub" — its own forward `verifies` only continued to
// evidence-only REQs, and its own forward `imports` was blocked outright.
//
// Both fixes shared a structural weak point later formalized as issue #322 /
// Step 0-pre HIGH-2: the evidence-only exemption was a per-EDGE predicate
// keyed only by "does this REQ have an `implements` edge", not a per-(origin,
// REQ) one — so once a BFS legitimately reached ONE evidence-only REQ through
// a hub, that REQ's own bare hub-membership became a "passport" letting the
// walk continue OUT the other side to unrelated evidence-only siblings, and
// the same shape could daisy-chain hub-to-hub indefinitely. Tagging the
// passport with more state does not fix this: the exemption condition and
// the onward-passage condition were the same predicate, so any tag applied
// to satisfy one automatically satisfies the other for the next hop too.
//
// ============================================================================
// Current model (issue #361) — two-layer propagation + matching predicate.
// ============================================================================
//
// #361 replaces the single-axis "restricted"/"unrestricted" test-hub state
// (and the bare `reqsWithImplements`-only exemption above) with a THREE-state
// `ReachState` model and moves every one of R1-R5 below into ONE explicit
// classification function (`classifyEdgeTraversal`) instead of leaving them
// scattered across separate `if` branches:
//
//   - `"expandable"` — the node may be dequeued and its own edges explored.
//     Every DECLARED edge (`implements`, `contains` forward, `verifies`/
//     `imports` reached any way OTHER than through a restricted hub's own
//     forward hop, and `depends_on`/`derives_from` carrying at least one
//     EXPLICIT-declaration provenance) grants this state — "strong",
//     transitive, exactly like every edge kind behaved pre-#361.
//   - `"restricted"` — a `kind === "test"` node reached via a reverse
//     `verifies`/`imports` hop (the #303 hub-arrival shape). Still
//     EXPANDABLE (it IS dequeued), but its OWN forward `verifies`/`imports`
//     edges are narrowed per R3a/R3b below. A later, unrestricted arrival at
//     the SAME node upgrades and re-expands it (unchanged from #303).
//   - `"terminal"` — a WEAK, "collect but do not re-open" reach: the node
//     lands in `visited` (so it still contributes to `impactReqs` /
//     `affectedFiles` / `affectedDocs` / `reqProvenance` / post-BFS
//     attribution, all of which key off `visited`'s KEYS only) but is NEVER
//     enqueued — its own outgoing/incoming edges are never explored. A weak
//     reach can therefore never become anyone's passport to a further hop;
//     this is the structural fix for HIGH-2 / issue #322 (a terminal REQ
//     cannot reverse-walk back out to a sibling through the hub that
//     terminally reached it, and a terminal file cannot cascade to its
//     same-file symbols via the `node.kind === "file"` expansion below,
//     which — like every other expansion step — only runs for a DEQUEUED,
//     i.e. non-terminal, node). A later STRONG arrival at the same node still
//     upgrades it to `"expandable"` and re-enqueues it for full expansion
//     (`isNewReach`'s total order below), so weak-then-strong reach is not
//     lossy — only strong-only-via-weak-hops is blocked.
//
// `classifyEdgeTraversal` (below) is the SSOT for every edge kind's
// direction x provenance x hub-context classification — R1-R5 (still true,
// now expressed there instead of inline):
//   R1  `contains` reverse: always blocked (issue #215, unchanged).
//   R2  `exercises` reverse (symbol/file -> req): blocked when the source REQ
//       has an `implements` edge anywhere (`reqsWithImplements`, unchanged
//       eligibility test from Option 2B) — but when ALLOWED, the reach is now
//       `"terminal"` (was `"unrestricted"` pre-#361): an evidence-only REQ
//       reached this way still lands in `impactReqs`/gate scope (Option 2B's
//       guarantee is preserved — see the gate-reachability regression test),
//       it just can no longer reverse-walk onward to a sibling.
//   R3a restricted hub's forward `verifies`: blocked when the target REQ has
//       an `implements` edge anywhere (unchanged). Otherwise (evidence-only)
//       NOW additionally requires the **matching predicate** below; on a
//       match the reach is `"terminal"` (was `"unrestricted"`) — this is the
//       #361 fix for HIGH-2/#322's daisy-chain (a terminal REQ cannot
//       reverse-walk back out to reach the hub's OTHER evidence-only
//       siblings, closing the residual leak `tests/impact-test-hub-303.test
//       .ts`'s old "known limitation, issue #322 pin" block documented).
//       H1 (issue #363): the matching predicate REQUIRES `exercises` evidence
//       to exist, so it fails open — bare hub membership suffices, as
//       pre-#361 — whenever the WHOLE graph has zero `exercises` edges
//       (`graphHasExercisesEdges`, see below): a project that has never
//       ingested a trace shard can never satisfy the predicate by
//       construction, and applying it anyway silently erases every
//       evidence-only REQ from `impactReqs`/gate scope rather than legitimately
//       finding no match. See the matching-predicate paragraph below for the
//       partial-trace residual limitation this fallback does NOT cover.
//   R3b restricted hub's forward `imports`: always blocked (unchanged).
//   R4  a stale `exercises` edge (`excludeStaleExercises`) is skipped
//       entirely, before classification runs at all (unchanged).
//   R5  file→symbol expansion only runs when a `file` node is DEQUEUED — so
//       it never fires for a terminally-reached file (unchanged mechanism,
//       new consequence: a file reached only via forward `exercises` no
//       longer sweeps in its same-file symbols).
//
// New for #361 — the `exercises` edge kind's FORWARD direction (req ->
// symbol|file) is now ALSO `"terminal"` (was `"expandable"`/unconditional
// pre-#361): a REQ's own coverage-derived `exercises` edge to the code it
// happens to exercise is observational evidence, not a declared dependency,
// so it should not itself grant transitive reach onward from the exercised
// node — this closes the forward cascade axis (`fnA -implements-> REQ-901
// -exercises-> fnB -implements-> REQ-902`, where REQ-902 used to leak in via
// REQ-901's own unrelated test coverage of fnB; fnB itself, one hop away,
// still legitimately lands in `affectedFiles`).
//
// New for #361 — `depends_on`/`derives_from` (doc <-> doc/req, both
// directions symmetric) now classify per EDGE by provenance instead of being
// unconditionally `"expandable"`: an edge carrying at least one EXPLICIT
// declaration provenance (`frontmatter`, `annotation`, `convention` — i.e.
// anything other than `inline-link`) is `"expandable"` (strong, transitive,
// unchanged from pre-#361); an edge whose provenances are `inline-link`
// ONLY is `"terminal"` (weak, collect-but-do-not-reopen) — a markdown link
// between two docs is an incidental cross-reference an author happened to
// write, not a declared "this doc depends on that doc" relationship, and
// pre-#361 this was the #254 unbounded-fan-out source (a hub doc's ONE
// inline link could drag in every doc the LINKED doc itself links to,
// unbounded). `dedupEdges` (canonical.ts) unions provenances by (source,
// target, kind) — a single physical edge can carry BOTH `frontmatter` and
// `inline-link` provenances (e.g. an explicit frontmatter declaration that
// happens to also be phrased as a markdown link in the body); such an edge
// is `"expandable"` (any one explicit-declaration provenance is enough,
// verified against `dedupEdges`'s actual merge behavior before relying on
// this).
//
// The matching predicate (Step 0-pre Q2) — a candidate evidence-only REQ `R`
// reached via a restricted hub's forward `verifies` (R3a above) is collected
// ONLY when `R` itself has an `exercises` edge landing on a node in the BFS's
// fixed ORIGIN set (`originIds` below: `startIds` plus the same-file-symbol
// expansion of any file-kind startId — computed ONCE, before the BFS loop
// starts, from the immutable input, never from the evolving `visited` state).
// This is the (origin, REQ)-pair-grained check HIGH-2's own analysis called
// for: it is no longer enough for a REQ to merely SHARE a hub with the
// current walk — the REQ's own coverage evidence must actually reach back to
// where this walk started. Computing `originIds` from the frozen input
// (rather than from `visited`, which grows as the BFS explores) is what
// keeps this predicate from becoming a NEW passport-transfer mechanism itself
// (a node visited mid-walk must never retroactively count as "origin").
//
// H1 (issue #363) fail-open fallback — the matching predicate above can only
// ever be satisfied by a real `exercises` edge, so a project that has never
// ingested a trace shard (zero `exercises` edges anywhere in the graph) has a
// PERMANENTLY EMPTY predicate: every evidence-only REQ would be unconditionally
// blocked at R3a, not because matching legitimately failed but because
// matching is impossible in principle for that project. `classifyEdgeTraversal`
// therefore short-circuits R3a's matching-predicate check behind
// `graphHasExercisesEdges` (computed once, hoisted to the top of `impact()` —
// the same boolean spec 020's `reqProvenance` gate already needed, now shared
// rather than duplicated) and falls back to the pre-#361/#303-era rule: bare
// hub membership is enough, fail-open, preserving the OLD guarantee that a
// trace-absent project's evidence-only REQs still surface. The moment the
// graph has even ONE `exercises` edge anywhere, real evidence exists somewhere
// and the matching predicate becomes mandatory again for every restricted-hub
// R3a decision graph-wide (not just for the REQ that has the edge) — so a
// PARTIAL-trace project (one REQ traced via `exercises`, an evidence-only
// sibling REQ sharing the same hub with NO `exercises` edge of its own) still
// excludes that untraced sibling exactly as #361 intended (tracked as a
// follow-up issue).
//
// `maxDepth` gets no new default here — the weak/terminal layer already stops
// every unbounded-cascade axis structurally, so depth-limiting is not needed
// as a mitigation (unlike some historical proposals). `reqProvenance`'s
// external "static"/"evidence" JSON contract (spec 020 FR-017) is unchanged;
// `impact --diff --tests` (`ingestedTrace.reqsByNode`) is BFS-independent and
// untouched by any of this.
//
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

// #361 — canonical reach-state a node can be in during one `impact()` BFS
// run. See the file-header "Current model (issue #361)" section for the
// full semantics. Intentionally a 3-value union rather than a boolean pair:
// the ORDER (`"terminal"` < `"restricted"` < `"expandable"`, see
// `REACH_RANK`/`isNewReach` below) is itself meaningful — a later arrival
// only ever upgrades a node rightward along this order, never downgrades it.
type ReachState = "expandable" | "restricted" | "terminal";

const REACH_RANK: Record<ReachState, number> = { terminal: 0, restricted: 1, expandable: 2 };

// #361 — the single classification function every edge kind x direction x
// hub-context decision goes through, consolidating what used to be separate
// inline `if` branches for R1 (`contains` reverse), R2 (`exercises`
// reverse), and R3a/R3b (restricted hub's own forward `verifies`/`imports`).
// See the file-header "Current model" section for the full R1-R5 table and
// the matching-predicate rationale this applies for R3a.
//
// `fromRestricted` is true only when the node CURRENTLY BEING EXPANDED
// (i.e. the BFS dequeue this call's edges belong to) is itself in
// `"restricted"` state — the only state that narrows what its OWN forward
// edges may do. An `"expandable"` node's forward edges are never narrowed by
// this function — every edge kind keeps its pre-#303 unconditional
// semantics for a non-restricted expansion, exactly like a startId or a
// forward-reached node always could.
function classifyEdgeTraversal(
  edge: { source: string; target: string; kind: EdgeKind; provenances: readonly string[] },
  direction: "forward" | "reverse",
  fromRestricted: boolean,
  ctx: {
    graph: ArtifactGraph;
    reqsWithImplements: ReadonlySet<string>;
    reqsExercisingOrigin: ReadonlySet<string>;
    graphHasExercisesEdges: boolean;
  },
): { blocked: true } | { blocked: false; state: ReachState } {
  switch (edge.kind) {
    case "contains":
      // R1 — forward-only (doc -> req|task, or class -> method per spec
      // 021); reverse always blocked (issue #215, spec 019 FR-001〜003).
      // Never narrowed by hub context — `contains` is never emitted from a
      // `kind === "test"` source.
      //
      // HIGH-3 (issue #361 Step 9 retro) pin — `src/trace/report.ts`'s
      // `reqExercises()` independently re-implements a `contains` walk (its
      // claim-corroboration evidence roll-up) and MUST agree with this
      // forward-only direction: `reqExercises` only walks DOWN via
      // `containsIndex` (source -> targets, i.e. a claim on a container is
      // corroborated by a contained node's evidence), never up from a
      // contained node to its container — the exact same asymmetry as R1
      // here. See `reqExercises`'s own doc comment for its side of this
      // cross-reference, and `tests/impact-contains-direction-361.test.ts`
      // for the pinned integration test asserting both implementations
      // agree on one shared fixture.
      return direction === "forward" ? { blocked: false, state: "expandable" } : { blocked: true };

    case "implements":
      // Always strong both directions — a declared `@impl` claim is never
      // gated by hub context or provenance.
      return { blocked: false, state: "expandable" };

    case "verifies": {
      if (direction === "forward") {
        if (!fromRestricted) return { blocked: false, state: "expandable" };
        // R3a — restricted hub's own forward `verifies`. Blocked when the
        // target REQ already has an `implements` edge anywhere (unchanged
        // eligibility test from Option 2B/#303).
        if (ctx.reqsWithImplements.has(edge.target)) return { blocked: true };
        // Evidence-only target REQ: the #361 matching predicate — collect it
        // ONLY when ITS OWN `exercises` evidence reaches the BFS's fixed
        // origin set. Bare hub-membership is no longer sufficient by itself
        // (the HIGH-2/#322 daisy-chain fix).
        //
        // H1 (issue #363) fail-open fallback — the matching predicate above
        // is built exclusively from `exercises` edges (`reqsExercisingOrigin`
        // below), so a project that has never ingested a trace shard has a
        // permanently EMPTY predicate: applying it here would unconditionally
        // block every evidence-only REQ, silently erasing them from
        // `impactReqs` / `check --diff --gate` scope even though matching is
        // simply not possible yet, not failing. Fail-open when the graph has
        // ZERO `exercises` edges anywhere (trace-absent, matching is
        // impossible in principle): fall back to the pre-#361/#303-era rule
        // where bare hub membership is enough. The moment the graph has even
        // ONE `exercises` edge, real evidence exists and the matching
        // predicate becomes mandatory again — a partial-trace project (one
        // REQ traced, a sibling evidence-only REQ sharing the same hub not
        // traced) still excludes that untraced sibling (tracked as a
        // follow-up issue).
        if (ctx.graphHasExercisesEdges && !ctx.reqsExercisingOrigin.has(edge.target)) {
          return { blocked: true };
        }
        return { blocked: false, state: "terminal" };
      }
      // reverse `verifies` (req -> its verifying test): unconditional;
      // landing on a `kind === "test"` node is the #303 hub ARRIVAL.
      return {
        blocked: false,
        state: ctx.graph.nodes.get(edge.source)?.kind === "test" ? "restricted" : "expandable",
      };
    }

    case "imports": {
      if (direction === "forward") {
        // R3b — restricted hub's own forward `imports`: always blocked.
        if (fromRestricted) return { blocked: true };
        return { blocked: false, state: "expandable" };
      }
      const landsOnTest = ctx.graph.nodes.get(edge.source)?.kind === "test";
      return { blocked: false, state: landsOnTest ? "restricted" : "expandable" };
    }

    case "exercises": {
      // Forward (req -> symbol|file): #361 — always weak/`"terminal"` now
      // (the forward-cascade fix: a REQ's own incidental coverage of a
      // symbol/file must not itself grant transitive reach onward from
      // there). Staleness (R4) is filtered out by the caller before this
      // function is ever reached for a stale edge.
      if (direction === "forward") return { blocked: false, state: "terminal" };
      // Reverse (symbol|file -> req): R2 eligibility unchanged (blocked when
      // the source REQ already has an `implements` edge anywhere — the #286
      // leak class); when allowed, #361 makes the reach `"terminal"` (was
      // `"expandable"` pre-#361) — an evidence-only REQ still lands in
      // `impactReqs`/gate scope (Option 2B's guarantee), it just can no
      // longer reverse-walk onward to a sibling through shared edges.
      if (ctx.reqsWithImplements.has(edge.source)) return { blocked: true };
      return { blocked: false, state: "terminal" };
    }

    case "depends_on":
    case "derives_from": {
      // #361 — classify per edge by provenance, symmetric both directions:
      // any EXPLICIT-declaration provenance (`frontmatter` / `annotation` /
      // `convention` — anything other than `inline-link`) makes the edge
      // strong/`"expandable"` (transitive, unchanged from pre-#361).
      // `inline-link`-ONLY makes it weak/`"terminal"` — an incidental
      // markdown cross-reference, not a declared dependency (the #254
      // unbounded-fan-out fix). `dedupEdges` (canonical.ts) unions
      // provenances by (source, target, kind), so a single physical edge
      // carrying BOTH `frontmatter` and `inline-link` (an explicit
      // declaration an author also happened to phrase as a link) is still
      // `"expandable"` — any one explicit provenance is enough.
      const isWeak = edge.provenances.every((p) => p === "inline-link");
      return { blocked: false, state: isWeak ? "terminal" : "expandable" };
    }
  }
}

export function impact(
  graph: ArtifactGraph,
  startIds: string[],
  lock: LockFile,
  maxDepth?: number,
  options?: ImpactTraversalOptions,
): ImpactResult {
  const staleExercisesNodes = options?.excludeStaleExercises;

  // H1 (issue #363) / spec 020 (FR-017) — hoisted to the top of `impact()`
  // since #363 gave it a SECOND consumer: the R3a matching-predicate
  // fail-open check in `classifyEdgeTraversal` (below, via `classifyCtx`)
  // needs it up front just like `reqsWithImplements`/`reqsExercisingOrigin`
  // do, and the `reqProvenance` gate further down (originally the only
  // caller) now just reads this same value instead of recomputing it.
  const graphHasExercisesEdges = graph.edges.some((e) => e.kind === "exercises");

  // PR #299 meta-review Finding 2 (Option 2B) — precompute which REQ ids
  // have at least one `implements` edge ANYWHERE in the graph (not just
  // within the eventual `visited` set — this must be known up front,
  // independent of BFS order, since `classifyEdgeTraversal` (R2/R3a) needs
  // it to decide eligibility before any traversal happens). A REQ in this
  // set is the #286 leak class (reachable via its own `@impl` claim); a REQ
  // absent from this set is evidence-only.
  const reqsWithImplements = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "implements") continue;
    const target = graph.nodes.get(edge.target);
    if (target?.kind === "req") reqsWithImplements.add(edge.target);
  }

  // #361 (HIGH-2/#322 matching predicate) — the BFS's fixed ORIGIN node id
  // set: `startIds` plus the same-file-symbol expansion of every file-kind
  // startId (mirroring the `node.kind === "file"` expansion the BFS itself
  // does below, computed here ONCE from the immutable `startIds` input
  // rather than from the evolving `visited` state — see the file-header
  // "Current model" section for why this distinction is load-bearing: a node
  // visited MID-walk must never retroactively count as origin, or the
  // matching predicate becomes a new passport-transfer mechanism itself).
  const originIds = new Set<string>(startIds);
  for (const startId of startIds) {
    const startNode = graph.nodes.get(startId);
    if (!startNode || startNode.kind !== "file") continue;
    for (const [symId, symNode] of graph.nodes) {
      if (symNode.kind === "symbol" && symNode.filePath === startNode.filePath) {
        originIds.add(symId);
      }
    }
  }

  // #361 — REQ ids whose OWN `exercises` edge lands on a node in `originIds`
  // above. This is `classifyEdgeTraversal`'s R3a matching-predicate lookup:
  // a restricted hub's forward `verifies` to an evidence-only REQ collects
  // that REQ only when it is a member of this set.
  const reqsExercisingOrigin = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "exercises") continue;
    if (originIds.has(edge.target)) reqsExercisingOrigin.add(edge.source);
  }

  const classifyCtx = { graph, reqsWithImplements, reqsExercisingOrigin, graphHasExercisesEdges };

  // #361 — `visited` now carries one of THREE reach states (`ReachState`,
  // above); see the file-header "Current model" section for the full
  // semantics. `isNewReach` encodes the total order every transition must
  // move rightward along (terminal -> restricted -> expandable, never
  // backward) — shared by the dequeue-time re-processing guard and every
  // reach attempt below so they can never disagree about what counts as
  // "worth (re-)recording". `visited`'s KEYS (not its values) are what every
  // downstream aggregation loop (`affectedFiles`/`impactReqs`/drift/
  // provenance) reads, and a key is only ever added once — this still holds
  // under the 3-state model exactly as it did under #303's 2-state one.
  const visited = new Map<string, ReachState>();
  const queue: Array<{ id: string; depth: number; state: "expandable" | "restricted" }> =
    startIds.map((id) => ({ id, depth: 0, state: "expandable" }));

  const isNewReach = (existing: ReachState | undefined, next: ReachState): boolean =>
    REACH_RANK[next] > (existing === undefined ? -1 : REACH_RANK[existing]);

  // #361 — the single place a node's reach is ever recorded. A `"terminal"`
  // (weak) reach is recorded DIRECTLY into `visited` and never queued — by
  // construction it has nothing left to do (it is never dequeued, so it can
  // never expand its own edges or trigger the file→symbol expansion below).
  // An `"expandable"`/`"restricted"` reach is only ever pushed to the queue;
  // the authoritative `visited.set` for those happens at dequeue time
  // (below), matching #303's original push-time-is-just-a-dedup-hint /
  // dequeue-time-is-authoritative split.
  const attemptReach = (id: string, depth: number, state: ReachState): void => {
    if (state === "terminal") {
      if (isNewReach(visited.get(id), "terminal")) visited.set(id, "terminal");
      return;
    }
    if (isNewReach(visited.get(id), state)) {
      queue.push({ id, depth, state });
    }
  };

  while (queue.length > 0) {
    const { id, depth, state } = queue.shift()!;
    if (!isNewReach(visited.get(id), state)) continue;
    visited.set(id, state);

    if (maxDepth !== undefined && depth >= maxDepth) continue;

    // R5 — file→symbol expansion only ever runs for a DEQUEUED (i.e.
    // expandable/restricted, never terminal) file node; a file reached only
    // via a weak/terminal edge (e.g. forward `exercises`) does not sweep in
    // its same-file symbols (#361 consequence of "weak reach grants no
    // passage", not a special case here).
    const node = graph.nodes.get(id);
    if (node && node.kind === "file") {
      for (const [symId, symNode] of graph.nodes) {
        if (symNode.kind === "symbol" && symNode.filePath === node.filePath) {
          attemptReach(symId, depth + 1, "expandable");
        }
      }
    }

    const fromRestricted = state === "restricted";
    for (const edge of graph.edges) {
      // R4 — spec 020 (FR-017, US5-2/US3 ⑥): a stale `exercises` edge is
      // excluded from traversal altogether when `staleness: "exclude"`.
      if (
        edge.kind === "exercises" &&
        staleExercisesNodes &&
        staleExercisesNodes.has(edge.target)
      ) {
        continue;
      }
      if (edge.source === id) {
        const result = classifyEdgeTraversal(edge, "forward", fromRestricted, classifyCtx);
        if (!result.blocked) attemptReach(edge.target, depth + 1, result.state);
      }
      if (edge.target === id) {
        const result = classifyEdgeTraversal(edge, "reverse", fromRestricted, classifyCtx);
        if (!result.blocked) attemptReach(edge.source, depth + 1, result.state);
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
  // (`"expandable"`: attribution is a declarative one-hop lookup, not a
  // hub-arrival or a weak/`exercises`/`inline-link` reach, so it carries
  // none of the #303/#361 restrictions — setting on an already-visited req
  // is a no-op either way) purely so the shared drift loop below covers both
  // BFS-reached and attribution-reached docs without duplicating the
  // lock-comparison logic. The exact state value is otherwise unread beyond
  // this point — every downstream loop keys off `visited`'s presence only.
  for (const id of affectedDocs) {
    visited.set(id, "expandable");
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
  // `ImpactResult` — FR-010 byte-identical requirement (T021(e)). (`graphHasExercisesEdges`
  // is now hoisted to the top of `impact()` — H1/#363 — since the R3a
  // matching-predicate fail-open check needs the same value earlier.)
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
