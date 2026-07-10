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
 */
function reqExercises(trace: IngestedTrace, reqId: string, node: string): boolean {
  const coverage = trace.perReq.get(reqId);
  if (!coverage) return false;
  return coverage.symbols.includes(node) || coverage.files.includes(node);
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
 * ANY exercises evidence but NO `implements` claim (from any REQ) is then
 * classified purely by how many distinct REQs exercise it:
 *   - exactly 1  -> `suggestedImpls`
 *   - >= threshold -> `infrastructure`
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

  for (const edge of graph.edges) {
    if (edge.kind !== "implements") continue;
    const node = edge.source;
    const reqId = edge.target;
    claimedNodes.add(node);
    if (reqExercises(trace, reqId, node)) {
      corroborated.push({ reqId, node });
    } else {
      unexercisedClaims.push({ reqId, node });
    }
  }

  const suggestedImpls: ClaimEvidencePair[] = [];
  const infrastructure: InfrastructureEntry[] = [];
  for (const [node, reqIds] of trace.reqsByNode) {
    if (claimedNodes.has(node)) continue; // already handled above (FR-013: "implements なし" only)
    if (reqIds.size >= sharedThreshold) {
      infrastructure.push({ node, reqCount: reqIds.size });
    } else if (isExclusiveNode(trace, node)) {
      const [reqId] = reqIds;
      suggestedImpls.push({ reqId: reqId!, node });
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

function ownerFilePath(nodeId: string): string | undefined {
  if (nodeId.startsWith("file:")) return nodeId.slice("file:".length);
  if (nodeId.startsWith("symbol:")) {
    const rest = nodeId.slice("symbol:".length);
    const hashIdx = rest.indexOf("#");
    return hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  }
  return undefined;
}
