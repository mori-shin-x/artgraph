export type NodeKind = "req" | "doc" | "file" | "symbol" | "test";

export type EdgeKind =
  | "depends_on"
  | "derives_from"
  | "implements"
  | "verifies"
  | "imports"
  | "contains";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  filePath: string;
  label?: string;
  contentHash: string;
  metadata?: Record<string, string>;
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
  summary?: ImpactSummary;
}

export interface ImpactSummary {
  docs: number;
  reqs: number;
  files: number;
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

export interface ScanSummary {
  nodeCount: number;
  edgeCount: number;
  reqCount: number;
  docCount: number;
  fileCount: number;
  testCount: number;
}

export interface SddToolInfo {
  name: string;
  marker: string;
}

export interface DetectionResult {
  hasSrc: boolean;
  hasSpecs: boolean;
  hasDocs: boolean;
  sddTools: SddToolInfo[];
}

export interface InitOptions {
  force?: boolean;
  noScan?: boolean;
}

export interface ReqPatternConfig {
  listItem?: string;
  heading?: string;
  // Regex matching a bare requirement ID *token* as it appears in code/test tags
  // (`@impl <id>`, `[<id>]`, `req: "<id>"`). Keep this consistent with the IDs
  // captured by `listItem`/`heading` so spec-side and code-side IDs connect.
  codeId?: string;
}

export interface TestResultRecord {
  reqId: string;
  testName: string;
  passed: boolean;
}

export type TestResultMap = Map<string, TestResultRecord[]>;

export interface DocGraphConfig {
  autoNodes?: boolean;
  autoContains?: boolean;
}

export interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  docGraph?: DocGraphConfig;
  mode?: "file" | "symbol";
  testResultPaths?: string[];
}

export const DEFAULT_CONFIG: SpectraceConfig = {
  include: ["src/**/*.ts", "src/**/*.tsx"],
  specDirs: ["specs", "docs"],
  testPatterns: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx"],
  lockFile: ".trace.lock",
};
