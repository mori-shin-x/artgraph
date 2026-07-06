import type { ArtifactGraph } from "../types.js";
import { EDGE_PROVENANCE_VALUES } from "../types.js";

export interface GraphJSON {
  nodes: Array<{
    id: string;
    kind: string;
    filePath: string;
    label: string;
    contentHash: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: string;
    provenances: string[];
  }>;
}

export function graphToJSON(graph: ArtifactGraph): GraphJSON {
  const nodes = [...graph.nodes.values()].map((n) => ({
    id: n.id,
    kind: n.kind,
    filePath: n.filePath,
    label: n.label ?? n.id,
    contentHash: n.contentHash,
  }));

  // Per #35 / INV-O3, INV-O4: emit `provenances` (plural array) only. Element-
  // level filtering via EDGE_PROVENANCE_VALUES drops forward-incompatible
  // payloads silently; if every element is rejected, the edge itself is
  // omitted from the JSON output so the NonEmpty invariant survives the wire.
  const edges = graph.edges.flatMap((e) => {
    const valid = e.provenances.filter((p) => EDGE_PROVENANCE_VALUES.has(p));
    if (valid.length === 0) return [];
    const sorted = [...valid].sort();
    return [
      {
        source: e.source,
        target: e.target,
        kind: e.kind,
        provenances: sorted,
      },
    ];
  });

  return { nodes, edges };
}
