// spec 020 (contracts/cli-surface.md §2, data-model.md §7) — the `@impl`
// claim x exercises-evidence cross-check (FR-012/013). Consumed by
// `src/commands/trace.ts` (T011, Phase A `trace report` — graph/lock
// READ-ONLY) and, later, `src/coverage.ts` (T020, Phase C `check` findings:
// `unexercisedClaims` / `suggestedImpls` / `staleEvidence` reuse the same
// classification so the two commands never drift on what counts as
// "exclusive" or "corroborated" — one classifier, two consumers).
//
// Pure functions of (graph, IngestedTrace): never reads files, never writes
// graph/lock. `src/graph/builder.ts` (T015) later folds `exercises` edges
// into the graph itself; until that lands this module is the only place the
// claim/evidence comparison happens.

import type { ArtifactGraph } from "../types.js";
import type { IngestedTrace, ReqCoverage } from "./ingest.js";
// issue #285 — `classifyEvidence` shares `computeCoverage`'s REQ-scoped
// "already claimed" definition (`buildClaimedReqIds`, task-sourced
// `implements` edges excluded) instead of re-deriving a node-scoped one, so
// `suggestedImpls`'s suppression can never drift from `check`'s exercised/
// uncovered computation. This is a deliberate module-cycle (`../coverage.js`
// itself imports `isExclusiveNode` from THIS module) — safe because both
// sides only reference the other's export from inside a function body
// (`classifyEvidence` below / `computeCoverage`), never at module top-level,
// so it never depends on load order.
import { buildClaimedReqIds } from "../coverage.js";

export const DEFAULT_SHARED_THRESHOLD = 3;

export interface ClaimEvidencePair {
  reqId: string;
  node: string;
}

export interface InfrastructureEntry {
  node: string;
  reqCount: number;
}

export interface EvidenceReport {
  /** `@impl` claim AND the claiming REQ's non-stale evidence reaches the
   * same node — "backed up" (data-model.md §7's `implements あり ∧
   * exercises あり`). */
  corroborated: ClaimEvidencePair[];
  /** `@impl` claim but the claiming REQ's green-tagged-test evidence never
   * reaches the node (FR-012, SC-003). */
  unexercisedClaims: ClaimEvidencePair[];
  /** No `@impl` claim anywhere on the node, and exactly one REQ's evidence
   * reaches it (FR-013 exclusivity). */
  suggestedImpls: ClaimEvidencePair[];
  /** No `@impl` claim, and `sharedThreshold` or more REQs' evidence reaches
   * the node — downgraded out of `suggestedImpls` as infra noise (FR-013). */
  infrastructure: InfrastructureEntry[];
}

function pairCompare(a: ClaimEvidencePair, b: ClaimEvidencePair): number {
  if (a.reqId !== b.reqId) return a.reqId < b.reqId ? -1 : 1;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/**
 * Does REQ `reqId`'s ingested evidence reach `node`? Checks both grains
 * (`symbols` and `files`) — a claim on a node that only resolved to its
 * file-grain fallback still counts as exercised at that same grain (FR-007
 * fail-safe symmetry: the claim and the evidence must be compared at
 * whatever grain the evidence actually landed at).
 *
 * spec 020 x spec 021 (issue #255) — `contains` ROLL-UP, claim-corroboration
 * ONLY. When `node` itself isn't directly exercised, this also checks every
 * node reachable from it via a `contains` edge (e.g. spec 021's class ->
 * method edge, FR-006) and counts `node` as exercised if ANY of them is
 * exercised for the SAME `reqId`. Rationale: a class-level `@impl` claim and
 * a method-level trace hit are both real signal for the same requirement —
 * `symbol-table.ts`'s Source 2 now resolves a method hit to the METHOD's own
 * symbol id when one exists, so without this roll-up a class-level claim
 * would go "unexercised" purely because the evidence lands one containment
 * level below the claimed node, not because the requirement is actually
 * unproven. Recursive with a cycle guard (`seen`) — today's only `contains`
 * producer is one level deep (class -> method), but nothing here assumes
 * that stays true. Forward-only, mirroring `graph/traverse.ts`'s `contains`
 * BFS (spec 019 FR-001〜003) — a node never rolls UP into its container,
 * only DOWN into what it contains.
 *
 * SCOPE: used ONLY inside `classifyEvidence`'s `implements`-edge loop below
 * (claim corroboration: `corroborated` / `unexercisedClaims`). Do NOT reuse
 * this for `suggestedImpls`, `infrastructure`, or `isExclusiveNode` — those
 * intentionally read `trace.reqsByNode` / `perReq` directly, unrolled.
 * Rolling evidence up through `contains` for THOSE would double-count a
 * method's exercised evidence at its class and reintroduce the false
 * suggestedImpls-on-class-node this fix closes (verified experimentally
 * while designing this fix — a naive "resolve members to the class"
 * approach broke corroboration; the inverse "roll up everywhere" approach
 * broke exclusivity). PR #268 review F2 (issue #255 follow-up) later adds
 * `hasAncestorClaim`, a SEPARATE `contains`-walking helper that DOES touch
 * `suggestedImpls` — it is not a relaxation of this rule: it never reads
 * evidence (`perReq`/`reqsByNode`) at all, only pre-existing `implements`
 * claims, so it cannot reintroduce the double-counting this note warns
 * against. See that function's doc, below `buildContainerIndex`.
 *
 * issue #267 adds a THIRD, narrower exception, `ctorClassExercised` (below):
 * a constructor's evidence is recorded by the capture engine under the
 * CLASS's own name (V8-compatible naming — see `src/vitest/plugin.ts`'s
 * `kind === "constructor" ? className : ...`), never under the ctor's own
 * `Class.constructor` symbol id (spec 021), so it lands one containment
 * level ABOVE the claim instead of below it — the mirror image of the
 * class-claim / method-evidence case this function's roll-up already
 * handles. That direction is intentionally NOT generalized here (a claim
 * corroborating from ANY exercised descendant OR ancestor would let a
 * sibling method's evidence corroborate an unrelated method's claim); it is
 * special-cased to `.constructor`-suffixed claim nodes only, directly in
 * `classifyEvidence`'s loop, not folded into this function.
 */
function reqExercises(
  containsIndex: Map<string, string[]>,
  trace: IngestedTrace,
  reqId: string,
  node: string,
  seen: Set<string> = new Set(),
): boolean {
  const coverage = trace.perReq.get(reqId);
  if (!coverage) return false;
  if (coverage.symbols.includes(node) || coverage.files.includes(node)) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  for (const target of containsIndex.get(node) ?? []) {
    if (reqExercises(containsIndex, trace, reqId, target, seen)) return true;
  }
  return false;
}

/**
 * issue #267 — ctor-only, PARENT-ward corroboration check, the mirror image
 * of `reqExercises`'s child-ward roll-up above. A `symbol:<path>#Class.
 * constructor` `@impl` claim's evidence is recorded by the capture engine
 * (cdp AND instrument both — `src/vitest/plugin.ts`) under the CLASS's own
 * V8-compatible name, because V8 itself has no distinct `functionName` for a
 * constructor call; `src/trace/symbol-table.ts` Source 1 then resolves that
 * class name straight to the class's OWN symbol id, never to the ctor's. So
 * a real constructor execution always shows up as evidence on the CLASS
 * node, one containment level ABOVE the ctor claim, never below it or on
 * the ctor node itself — `reqExercises`'s existing (child-ward) roll-up
 * structurally cannot see it.
 *
 * Deliberately NOT a general "roll evidence up to any claim" rule (that
 * direction is exactly what `reqExercises`'s own doc above forbids — it
 * would let a sibling method's or property's evidence corroborate an
 * unrelated method's claim). It is safe ONLY for `.constructor`: a method
 * hit is recorded under the method's OWN name, a getter/setter under `"get
 * <key>"`/`"set <key>"` (`src/vitest/plugin.ts`'s `accessorName`), and a
 * static block is not attributed to any member symbol at all — none of
 * those ever land on the bare class name, so resolving a class-name hit as
 * ctor-corroboration can never accidentally corroborate a different
 * member's claim. Checked at ONE level only (the direct container via
 * `containerIndex`), and only the parent's OWN direct evidence — NOT a
 * further `reqExercises` roll-down from the parent, which would reopen the
 * "sibling method corroborates via the class" hole this function exists to
 * avoid while staying narrow.
 *
 * JS additionally permits `static constructor() {}` — a static method
 * literally named "constructor" — which spec 021 FR-003's same-name
 * convergence resolves to the SAME `symbol:<path>#Class.constructor` node as
 * the instance ctor, so a claim on that node is corroborated by
 * instantiation evidence exactly as above; this is just FR-003's existing
 * "a merged symbol's claim is corroborated by evidence from any of its
 * occurrences" semantics, not a new case. TypeScript rejects the same code
 * with TS1089 (`'static' modifier cannot appear on a constructor
 * declaration`), so this path is unreachable there.
 */
function ctorClassExercised(
  containerIndex: Map<string, string[]>,
  trace: IngestedTrace,
  reqId: string,
  node: string,
): boolean {
  const coverage = trace.perReq.get(reqId);
  if (!coverage) return false;
  for (const parent of containerIndex.get(node) ?? []) {
    if (coverage.symbols.includes(parent) || coverage.files.includes(parent)) return true;
  }
  return false;
}

/**
 * `contains` adjacency (source -> targets), built ONCE per `classifyEvidence`
 * call so `reqExercises` doesn't rescan `graph.edges` per claim — that scan
 * is O(claims x edges), quadratic-ish on repos where class-level `@impl` is
 * the norm (measured: ~13s at 20k classes vs milliseconds with this index).
 * Deliberately kind-blind beyond `contains`: today's producers (spec 021's
 * class -> method, builder.ts's doc -> req|task) live in disjoint id
 * namespaces so a symbol-node lookup can never reach a doc-sourced edge —
 * revisit this assumption before adding any new `contains` producer whose
 * source can be a `symbol:`/`file:` node.
 */
function buildContainsIndex(graph: ArtifactGraph): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const targets = index.get(edge.source);
    if (targets) targets.push(edge.target);
    else index.set(edge.source, [edge.target]);
  }
  return index;
}

/**
 * `contains` adjacency inverted (target -> sources, i.e. a node's direct
 * CONTAINERS) — the parent-ward mirror of `buildContainsIndex` above, built
 * ONCE per `classifyEvidence` call for the same reason: `hasAncestorClaim`
 * (below) walks upward per `suggestedImpls` candidate, and rescanning
 * `graph.edges` per candidate would reintroduce the O(candidates x edges)
 * cost `buildContainsIndex`'s doc already measured on the forward direction.
 */
function buildContainerIndex(graph: ArtifactGraph): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const sources = index.get(edge.target);
    if (sources) sources.push(edge.source);
    else index.set(edge.target, [edge.source]);
  }
  return index;
}

/**
 * PR #268 review F2 (issue #255 follow-up) — a DIFFERENT mechanism from
 * `reqExercises`'s evidence roll-up above, despite the superficial
 * similarity (both walk `contains`, both cycle-guard with `seen`). This one
 * never touches `trace.perReq`/`reqsByNode` at all: it asks "does any
 * CONTAINER of `node`, at any depth, already carry an `@impl reqId` CLAIM?"
 * purely from `claimsByNode` (the `implements`-edge map built in
 * `classifyEvidence` below). Used ONLY to decide whether to hold back a
 * `suggestedImpls` entry, never to affect `corroborated`/`unexercisedClaims`
 * — `reqExercises`'s SCOPE note above still holds: evidence never rolls up
 * into `suggestedImpls`. Rationale: in repos that tag `@impl` at class
 * granularity, a class-level claim already answers "is REQ-X's code
 * identified" for that REQ; once the class claims REQ-X, member-level
 * suggestions to ALSO tag REQ-X are noise, not signal — but a claim on
 * REQ-X's ancestor says nothing about a DIFFERENT REQ-Y the same member is
 * exclusively exercised for, so this only suppresses a same-`reqId` match.
 */
function hasAncestorClaim(
  containerIndex: Map<string, string[]>,
  claimsByNode: Map<string, Set<string>>,
  reqId: string,
  node: string,
  seen: Set<string> = new Set(),
): boolean {
  for (const parent of containerIndex.get(node) ?? []) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    if (claimsByNode.get(parent)?.has(reqId)) return true;
    if (hasAncestorClaim(containerIndex, claimsByNode, reqId, parent, seen)) return true;
  }
  return false;
}

/**
 * issue #267 F2 mirror-noise follow-up — the CHILD-ward counterpart of
 * `hasAncestorClaim` immediately above (same non-evidence, claims-only
 * nature: walks `claimsByNode` via `containsIndex`, never touches
 * `perReq`/`reqsByNode`). Asks "does any DESCENDANT of `node`, at any depth,
 * already carry an `@impl reqId` CLAIM?" Used ONLY to hold back a
 * `suggestedImpls` candidate, same as `hasAncestorClaim`.
 *
 * Motivating case (issue #267's ctor corroboration, above): a constructor
 * claims REQ-X, and the instantiation evidence resolves to the CLASS node
 * (never the ctor's own id — see `ctorClassExercised`'s doc). Once the ctor
 * claim corroborates via that mechanism, the class node's OWN evidence entry
 * in `trace.reqsByNode` still exists and, without this check, would surface
 * a redundant "@impl REQ-X on the class" suggestion — the class is already
 * covered one level down, so the suggestion is noise, not signal. As with
 * `hasAncestorClaim`, this only suppresses a same-`reqId` match: a
 * descendant claiming a DIFFERENT REQ says nothing about whether `node`
 * itself should claim reqId.
 */
function hasDescendantClaim(
  containsIndex: Map<string, string[]>,
  claimsByNode: Map<string, Set<string>>,
  reqId: string,
  node: string,
  seen: Set<string> = new Set(),
): boolean {
  for (const child of containsIndex.get(node) ?? []) {
    if (seen.has(child)) continue;
    seen.add(child);
    if (claimsByNode.get(child)?.has(reqId)) return true;
    if (hasDescendantClaim(containsIndex, claimsByNode, reqId, child, seen)) return true;
  }
  return false;
}

/**
 * FR-013 exclusivity predicate: exactly one distinct REQ's evidence reaches
 * `node`. Factored out of `classifyEvidence` (below) so `src/coverage.ts`'s
 * `exercised` status computation (FR-014) shares the EXACT same "what counts
 * as exclusive" rule instead of re-deriving it — one classifier, every
 * exclusivity-gated consumer (`trace report`'s `suggestedImpls`, `check`'s
 * `suggestedImpls` + `unexercisedClaims`' corroboration check via
 * `reqExercises`, and `check`/`coverage.ts`'s `exercised` status all agree).
 */
export function isExclusiveNode(trace: IngestedTrace, node: string): boolean {
  return (trace.reqsByNode.get(node)?.size ?? 0) === 1;
}

/**
 * FR-012/013 classification. `sharedThreshold` mirrors
 * `.artgraph.json`'s `trace.sharedThreshold` (default 3, `DEFAULT_SHARED_THRESHOLD`
 * here — callers resolve the config value themselves, this function only
 * takes the resolved number so it stays config-shape-agnostic).
 *
 * Every `implements` edge in the graph is checked against its claiming
 * REQ's evidence (-> `corroborated` / `unexercisedClaims`). Every node with
 * ANY exercises evidence is then classified purely by how many distinct
 * REQs exercise it:
 *   - exactly 1  -> `suggestedImpls`, UNLESS that one REQ already has a
 *     code-claim somewhere in the graph (issue #285's REQ-scoped
 *     `buildClaimedReqIds` — NOT "does this exact node have ANY claim",
 *     which used to let a claim from a completely different REQ silently
 *     hide a legitimately-unclaimed REQ's suggestion on a shared node)
 *   - >= threshold -> `infrastructure`, UNLESS the node itself already
 *     carries some claim (`claimedNodes`, unchanged — infra has no single
 *     claiming REQ to scope a REQ-level check to)
 *   - otherwise (2 .. threshold-1) -> silent (omitted from every list; the
 *     underlying exercises evidence is untouched and still reachable via
 *     impact traversal once T015 lands — this classifier only produces
 *     report findings).
 */
export function classifyEvidence(
  graph: ArtifactGraph,
  trace: IngestedTrace,
  sharedThreshold: number = DEFAULT_SHARED_THRESHOLD,
): EvidenceReport {
  const corroborated: ClaimEvidencePair[] = [];
  const unexercisedClaims: ClaimEvidencePair[] = [];
  const claimedNodes = new Set<string>();
  const claimsByNode = new Map<string, Set<string>>();
  const containsIndex = buildContainsIndex(graph);
  const containerIndex = buildContainerIndex(graph);
  // issue #285 — one O(edges) walk, same cost class as `buildContainsIndex`/
  // `buildContainerIndex` above.
  const claimedReqIds = buildClaimedReqIds(graph);

  for (const edge of graph.edges) {
    if (edge.kind !== "implements") continue;
    const node = edge.source;
    const reqId = edge.target;
    claimedNodes.add(node);
    const reqIdsForNode = claimsByNode.get(node);
    if (reqIdsForNode) reqIdsForNode.add(reqId);
    else claimsByNode.set(node, new Set([reqId]));
    // issue #267: a `.constructor`-suffixed symbol claim ALSO corroborates
    // when the DIRECT containing class node itself is exercised for the
    // same reqId — see `ctorClassExercised`'s doc for why this parent-ward
    // check is safe only for constructors (never generalized to any claim
    // node, which would let a sibling's evidence corroborate this one).
    const isCtorClaim = node.startsWith("symbol:") && node.endsWith(".constructor");
    if (
      reqExercises(containsIndex, trace, reqId, node) ||
      (isCtorClaim && ctorClassExercised(containerIndex, trace, reqId, node))
    ) {
      corroborated.push({ reqId, node });
    } else {
      unexercisedClaims.push({ reqId, node });
    }
  }

  const suggestedImpls: ClaimEvidencePair[] = [];
  const infrastructure: InfrastructureEntry[] = [];
  for (const [node, reqIds] of trace.reqsByNode) {
    if (reqIds.size >= sharedThreshold) {
      // Node-scoped, unchanged (issue #285 only touches the suggestedImpls
      // branch below — infra has no single claiming REQ to scope a
      // REQ-level check to; a node already carrying SOME claim is still
      // "already handled above", FR-013: "implements なし" only).
      if (claimedNodes.has(node)) continue;
      infrastructure.push({ node, reqCount: reqIds.size });
    } else if (isExclusiveNode(trace, node)) {
      const [reqId] = reqIds;
      // issue #285: REQ-scoped suppression — this REQ already has a
      // code-claim SOMEWHERE in the graph (not necessarily on `node`), so
      // `@impl`-tagging it here would be a redundant nudge, exactly the
      // "already found" rule `check`'s `implFiles.length === 0` uses (both
      // now share `src/coverage.ts`'s `buildClaimedReqIds`). Deliberately
      // NOT `claimedNodes.has(node)` (the pre-#285 node-scoped check) — that
      // silently hid THIS reqId's suggestion whenever a DIFFERENT REQ's
      // `@impl` happened to sit on the same exclusively-exercised node.
      //
      // PR #268 review F2 (kept as-is, `hasAncestorClaim`/`hasDescendantClaim`
      // doc above): in the common case this check is subsumed by
      // `claimedReqIds` above (any ancestor/descendant claim on `reqId`
      // already puts `reqId` in `claimedReqIds`), so the two look redundant.
      // It stays as an independent, narrower defense: `claimedReqIds` is
      // REQ-scoped ("does this REQ have a code-claim anywhere"), while this
      // is node-hierarchy-scoped ("does an ancestor/descendant of THIS node
      // claim this REQ") — a future change to `claimedReqIds`'s definition
      // should not have to also re-derive this hierarchy suppression.
      if (
        !claimedReqIds.has(reqId!) &&
        !hasAncestorClaim(containerIndex, claimsByNode, reqId!, node) &&
        !hasDescendantClaim(containsIndex, claimsByNode, reqId!, node)
      ) {
        suggestedImpls.push({ reqId: reqId!, node });
      }
    }
    // 2 .. sharedThreshold-1: silent by design (FR-013).
  }

  corroborated.sort(pairCompare);
  unexercisedClaims.sort(pairCompare);
  suggestedImpls.sort(pairCompare);
  infrastructure.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));

  return { corroborated, unexercisedClaims, suggestedImpls, infrastructure };
}

/**
 * Staleness diagnostic (FR-015's data source, though the "warn/exclude/gate"
 * POLICY is Phase C's `src/coverage.ts` job — Phase A only surfaces the
 * count, contract §2's `diagnostics.stale`). A node is stale when its
 * trace-capture-time file hash (`hashesAtTrace`, recorded at the FILE grain
 * — see `src/trace/ingest.ts`'s `IngestedTrace.hashesAtTrace` doc) no
 * longer matches that file's CURRENT contentHash in the graph.
 */
export function computeStaleNodeIds(graph: ArtifactGraph, trace: IngestedTrace): Set<string> {
  const stale = new Set<string>();
  for (const [nodeId, tracedHash] of trace.hashesAtTrace) {
    const relPath = ownerFilePath(nodeId);
    if (relPath === undefined) continue;
    const fileNode = graph.nodes.get(`file:${relPath}`);
    // The owning file no longer exists in the current graph at all — that's
    // a reachability loss `ingest`'s dangling diagnostic doesn't cover
    // (dangling is computed against the CURRENT tree at ingest time, not the
    // graph); conservatively count it as stale rather than silently drop it.
    if (!fileNode || fileNode.contentHash !== tracedHash) stale.add(nodeId);
  }
  return stale;
}

/**
 * FR-015 / US5-2 (`trace.staleness === "exclude"`): produce an `IngestedTrace`
 * with every stale nodeId (per `computeStaleNodeIds`) removed from both
 * `perReq[reqId].symbols`/`.files` AND `reqsByNode` — so a stale symbol
 * neither contributes to a REQ's evidence set NOR counts toward another
 * node's exclusivity tally. `perReq[reqId].tests` (the raw tagged-test list)
 * is left untouched: staleness is a property of EXECUTED-CODE evidence, not
 * of "did this test run" (a stale test's own tagged-test membership is not
 * itself evidence of anything — `impact --tests`, T022, still wants to know
 * a REQ HAS tests even if today's coverage snapshot of them is stale).
 *
 * Pure: returns a new `IngestedTrace`; never mutates `trace`. `hashesAtTrace`
 * / `diagnostics` / `shardCount` pass through unchanged — staleness exclusion
 * only touches the evidence-membership maps that findings/exercised-status
 * computations read.
 *
 * Shared by `src/coverage.ts` (T020, `exercised` status) and
 * `src/check.ts` (T020, `unexercisedClaims`/`suggestedImpls`) so both
 * consumers apply the exact same staleness-exclusion rule as
 * `src/graph/traverse.ts`'s `impact()` (T022, FR-017) does for traversal —
 * one exclusion rule, several consumers, per this module's existing
 * "one classifier" design note above.
 */
export function excludeStaleEvidence(
  trace: IngestedTrace,
  staleNodeIds: ReadonlySet<string>,
): IngestedTrace {
  if (staleNodeIds.size === 0) return trace;

  const perReq = new Map<string, ReqCoverage>();
  for (const [reqId, coverage] of trace.perReq) {
    perReq.set(reqId, {
      symbols: coverage.symbols.filter((s) => !staleNodeIds.has(s)),
      files: coverage.files.filter((f) => !staleNodeIds.has(f)),
      tests: coverage.tests,
    });
  }

  const reqsByNode = new Map<string, Set<string>>();
  for (const [node, reqIds] of trace.reqsByNode) {
    if (staleNodeIds.has(node)) continue;
    reqsByNode.set(node, new Set(reqIds));
  }

  return { ...trace, perReq, reqsByNode };
}

/**
 * The repo-relative path of the file a `file:`/`symbol:` node id belongs to
 * (`file:src/x.ts` -> `src/x.ts`, `symbol:src/x.ts#fn` -> `src/x.ts`),
 * `undefined` for any other id shape. Exported (spec 020 T022 follow-up,
 * file-mode `--tests` fix) so `src/commands/impact.ts` can join startIds
 * against `IngestedTrace.reqsByNode` keys across GRAINS: ingest keys its
 * evidence at symbol grain regardless of `.artgraph.json`'s `mode` (its name
 * table resolves hit names from source text; it is `src/graph/builder.ts`
 * that degrades the merged edge target to file grain in a file-mode graph),
 * while a file-mode graph's startIds are `file:` grain — so an exact node-id
 * comparison structurally never matches there.
 */
export function ownerFilePath(nodeId: string): string | undefined {
  if (nodeId.startsWith("file:")) return nodeId.slice("file:".length);
  if (nodeId.startsWith("symbol:")) {
    const rest = nodeId.slice("symbol:".length);
    const hashIdx = rest.indexOf("#");
    return hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  }
  return undefined;
}
