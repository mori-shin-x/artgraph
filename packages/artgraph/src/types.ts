export type NodeKind = "req" | "doc" | "file" | "symbol" | "test" | "task";

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
  // REQs whose tests ran and failed (only populated when test results are
  // supplied). These fail the gate in addition to drift/orphans/uncovered.
  testFailures: string[];
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
  /**
   * Integration provider statuses (detected / installed) for every
   * registered provider. Used by `init`'s Tip output (FR-012/013) and the
   * `integrate list` surface. Populated lazily via `getProviderStatuses`.
   *
   * Optional only to preserve back-compat for callers that constructed
   * DetectionResult literals before this field existed (tests).
   */
  integrations?: IntegrationStatus[];
}

export interface InitOptions {
  force?: boolean;
  noScan?: boolean;
  withSkills?: boolean;
  /**
   * One-shot integrations to run as part of `init` (FR-022). Each id must
   * resolve to a registered provider; the special string `"all"` expands to
   * every provider whose `detect()` is true.
   *
   * Unmatched / undetected ids produce a warning and are skipped — the init
   * itself still completes with exit 0.
   */
  integrations?: IntegrationProviderId[] | "all";
  /**
   * Forwarded `--gate` / `--no-gate` for the speckit provider (FR-024).
   * Other providers ignore this flag.
   */
  integrateGate?: boolean;
}

// ---------------------------------------------------------------------------
// Integration provider types (specs/009-sdd-integration §data-model.md)
// ---------------------------------------------------------------------------

/**
 * SDD ツール統合 provider の識別子。CLI で `integrate <id>` の引数になる。
 * 将来 OpenSpec 対応時は "openspec" を union に追加（FR-018）。
 */
export type IntegrationProviderId = "speckit" | "kiro";

export type HookTrigger =
  | "before_specify"
  | "after_specify"
  | "before_clarify"
  | "after_clarify"
  | "before_plan"
  | "after_plan"
  | "before_tasks"
  | "after_tasks"
  | "before_implement"
  | "after_implement";

/** Spec Kit `extensions.yml` の `hooks.<trigger>` 配列要素。 */
export interface HookEntry {
  extension: string;
  command: string;
  enabled: boolean;
  optional: boolean;
  priority: number;
  prompt: string;
  description: string;
  condition: string | null;
}

export interface InstallOptions {
  /** 既存ファイルの上書きを許可（--force） */
  force?: boolean;
  /**
   * Spec Kit の --gate / --no-gate 宣言型フラグ（FR-003）。
   * - true: before_implement に check --gate hook を追加
   * - false: spectrace が登録した before_implement hook を削除
   * - undefined: 何もしない（gate なし状態と等価。明示削除はしない）
   *
   * 注: speckit 以外の provider は本フラグを無視する。
   */
  gate?: boolean;
}

/** `integrate <tool>` 実行結果（FR-015 の構造化出力）。 */
export interface IntegrateResult {
  providerId: IntegrationProviderId;
  /** rootDir からの相対パス */
  created: string[];
  /** rootDir からの相対パス */
  modified: string[];
  /** rootDir からの相対パス */
  removed: string[];
  /** 冪等再実行・統合済み等で何も変わらなかった場合 true */
  noop: boolean;
  /** ユーザーに次に推奨するコマンド（CLI text 出力用、複数行を想定） */
  nextSteps: string[];
  /** 非エラー警告（例: --gate なしで実行されたが gate が既存）。CLI 出力で表示 */
  warnings: string[];
}

/** `integrate list` 出力で provider × 検出状態 × 導入状態を表すクロス表。 */
export interface IntegrationStatus {
  providerId: IntegrationProviderId;
  displayName: string;
  marker: string;
  /** 当該 SDD ツールがこのリポジトリにあるか */
  detected: boolean;
  /** artgraph integration が既に導入済みか */
  installed: boolean;
}

/**
 * 統合 provider のライフサイクル契約。
 * 契約詳細: specs/009-sdd-integration/contracts/integration-provider.md
 */
export interface IntegrationProvider {
  /** Provider 識別子。例: "speckit", "kiro" */
  readonly id: IntegrationProviderId;
  /** ヒューマンリーダブル名。例: "Spec Kit", "Kiro" */
  readonly displayName: string;
  /** 検出マーカー（init での案内・list 表で利用）。例: ".specify", ".kiro" */
  readonly marker: string;

  /** リポジトリにこのツールがあるかを判定。副作用なし。 */
  detect(rootDir: string): boolean;
  /** すでに本機能でインストール済みかを判定。副作用なし。 */
  isInstalled(rootDir: string): boolean;
  /** 統合をインストール / 更新する。冪等。失敗時は throw。 */
  install(rootDir: string, opts: InstallOptions): IntegrateResult;
  /** 統合を削除する（installed リスト entry + hook + 生成ディレクトリ）。 */
  uninstall(rootDir: string): IntegrateResult;
}

/** 共通 agent-guidance generator の入力。 */
export interface GuidanceWriteRequest {
  /** 出力先（絶対パス推奨）。例: ".kiro/steering/spectrace.md" */
  destPath: string;
  /** 書き込む内容。テンプレート展開済みの最終 string */
  content: string;
  /** 既存ファイルがあるときに上書きするか（CLI --force と直結） */
  force: boolean;
  /** 親ディレクトリが存在しない場合に自動作成するか（既定 true） */
  createParentDirs?: boolean;
}

export interface GuidanceWriteResult {
  /** 実際に書き込みが起きたか（既存 == content で no-op の場合は false） */
  written: boolean;
  /** 既存ファイルがあったか */
  hadExisting: boolean;
  /** 親ディレクトリを新規作成したか */
  createdParentDirs: boolean;
}

export interface ReqPatternConfig {
  listItem?: string;
  heading?: string;
  // Regex matching a bare requirement ID *token* as it appears in code/test tags
  // (`@impl <id>`, `[<id>]`, `req: "<id>"`). Keep this consistent with the IDs
  // captured by `listItem`/`heading` so spec-side and code-side IDs connect.
  codeId?: string;
}

// Convention preset for extracting task IDs from list items in a Markdown file.
// Built-ins (spec-kit, kiro) ship in parsers/markdown.ts; users add tools like
// OpenSpec via `.artgraph.json` `taskConventions`. See specs/005-speckit-remaining/data-model.md §2.
export interface TaskConventionPreset {
  name: string;
  fileStems: string[];
  taskIdRe: string;
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
  // Auto-infer doc→doc `derives_from` edges from folder/file-name conventions
  // (kiro: requirements/design/tasks, spec-kit: spec/plan/tasks/research).
  // Defaults to true.
  autoConventions?: boolean;
  // Auto-extract doc→doc `depends_on` edges from inline markdown links.
  // Defaults to true. `linkWarnings` controls per-link warning emission.
  inlineLinks?: boolean;
  linkWarnings?: {
    unresolved?: boolean;
    outOfScope?: boolean;
  };
}

export interface ArtgraphConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  docGraph?: DocGraphConfig;
  mode?: "file" | "symbol";
  testResultPaths?: string[];
  taskConventions?: TaskConventionPreset[];
}

export const DEFAULT_CONFIG: ArtgraphConfig = {
  include: ["src/**/*.ts", "src/**/*.tsx"],
  specDirs: ["specs", "docs"],
  testPatterns: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx"],
  lockFile: ".trace.lock",
};
