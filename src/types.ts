export type NodeKind = "req" | "doc" | "file" | "symbol" | "test";

export type EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  filePath: string;
  label?: string;
  contentHash: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface ArtifactGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface LockEntry {
  specFile?: string;
  contentHash: string;
  impl?: string[];
  tests?: string[];
  dependsOn?: string[];
  lastReconciled: string;
}

export type LockFile = Record<string, LockEntry>;

export type CoverageStatus = "untagged" | "impl-only" | "verified";

export interface ImpactResult {
  affectedFiles: string[];
  affectedDocs: string[];
  affectedReqs: string[];
  drifted: DriftEntry[];
}

export interface DriftEntry {
  nodeId: string;
  kind: NodeKind;
  lockedHash: string;
  currentHash: string;
}

export interface CheckResult {
  drifted: DriftEntry[];
  orphans: string[];
  uncovered: string[];
  coverage: { reqId: string; status: CoverageStatus }[];
  pass: boolean;
}

export interface ReqPatternConfig {
  listItem?: string;
  heading?: string;
}

export interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
}

export const DEFAULT_CONFIG: SpectraceConfig = {
  include: ["src/**/*.ts", "src/**/*.tsx"],
  specDirs: ["specs", "docs"],
  testPatterns: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx"],
  lockFile: ".trace.lock",
};
