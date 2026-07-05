export type NodeKind = "req" | "doc" | "file" | "symbol" | "test" | "task";

export type EdgeKind =
  | "depends_on"
  | "derives_from"
  | "implements"
  | "verifies"
  | "imports"
  | "contains";

// Tuple type alias enforcing "at least one element" statically.
// See specs/011-edge-provenance/contracts/edge-provenance-type.md.
export type NonEmptyArray<T> = readonly [T, ...T[]];

// Origin of an edge. Lets downstream consumers tell convention/frontmatter/
// annotation/inline-link/code-tag/task-tag/ts-import/structural-derived edges
// apart. See specs/011-edge-provenance/ for the formalisation (issue #35).
export type EdgeProvenance =
  | "annotation"
  | "frontmatter"
  | "convention"
  | "code-tag"
  | "task-tag"
  | "inline-link"
  | "ts-import"
  | "structural";

// Run-time value set for the EdgeProvenance literal union. Kept in sync with
// the type union above so format.ts / lock.ts can validate a provenance
// value at serialization time without trusting the wire shape.
// SC-008 / INV-T4: type union element count == set size.
export const EDGE_PROVENANCE_VALUES: ReadonlySet<EdgeProvenance> = new Set([
  "annotation",
  "frontmatter",
  "convention",
  "code-tag",
  "task-tag",
  "inline-link",
  "ts-import",
  "structural",
]);

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
  // NonEmpty: every edge must record at least one provenance.
  // See specs/011-edge-provenance/contracts/edge-provenance-type.md §INV-T1.
  provenances: NonEmptyArray<EdgeProvenance>;
}

export interface ArtifactGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

/**
 * spec 016 (FR-001 / R-001 / R-002) — Stage A `Files:` entry. `symbol === undefined`
 * encodes a file-unit declaration (`Files: src/a.ts`); a defined `symbol`
 * encodes a symbol-unit declaration (`Files: src/a.ts:fn1`). `line` is the
 * 1-based source line of the Stage A entry (header or bullet).
 *
 * Lives here rather than in `parsers/sdd-files.ts` because it is shared
 * between the sdd-files parser (producer) and graph traversal / plan-coverage
 * / CLI (consumers) — keeping it in the parser forced a reverse
 * graph→parsers import edge (issue #164).
 */
export interface SymbolEntry {
  path: string;
  symbol?: string;
  line: number;
}

export interface LockEntry {
  specFile?: string;
  contentHash: string;
  impl?: string[];
  tests?: string[];
  // Schema v2: structured to carry provenance per reference.
  // See specs/011-edge-provenance/contracts/lock-schema-v2.md.
  dependsOn?: Array<{ id: string; provenances: EdgeProvenance[] }>;
  lastReconciled: string;
}

export type LockFile = Record<string, LockEntry>;

export type CoverageStatus = "untagged" | "impl-only" | "verified";

export interface ImpactResult {
  affectedFiles: string[];
  affectedDocs: string[];
  /**
   * spec 016 (INV-S7): renamed from `affectedReqs` to `impactReqs` for
   * symmetry with the new `originReqs` axis. Same semantics as spec 014's
   * `affectedReqs` (forward BFS reach restricted to req nodes).
   */
  impactReqs: string[];
  affectedTasks: string[];
  drifted: DriftEntry[];
  /**
   * spec 016 (INV-S6, R-015): union of REQ ids reached by following each
   * startId's `implements` edge 1 hop in reverse — the set of REQs whose
   * `@impl` claim points at the startId. Dedup'd + reqId-asc sorted. `[]`
   * when no startId has an `@impl` claim. Populated by the CLI / plan-
   * coverage layer via `resolveOriginReqs`; `impact()` itself does not
   * change (R-006).
   */
  originReqs: string[];
  summary?: ImpactSummary;
}

export interface ImpactSummary {
  docs: number;
  reqs: number;
  files: number;
  tasks: number;
}

export interface DriftEntry {
  nodeId: string;
  kind: NodeKind;
  lockedHash: string;
  currentHash: string;
}

export interface CheckResult {
  drifted: DriftEntry[];
  /**
   * Human-readable descriptor strings, one per orphan edge, in the format
   * `"<source> -> <target> (<kind>)"` (e.g.
   * `"file:src/auth/login.ts -> FAKE-9999 (implements)"`). Consumed by the
   * text CLI (`printCheckText`) and by JSON pipelines that mirror the CLI
   * text output. Do NOT treat entries as node ids — use `orphanNodeIds`
   * for that. See issue #155 (B1).
   */
  orphans: string[];
  /**
   * Deduplicated + ascending-sorted bare source node ids of every orphan
   * edge — the nodes the `--serve` UI should mark with the `orphan` state.
   * Derived from the SAME underlying `OrphanEntry[]` that `orphans`
   * descriptors are formatted from, but stripped down to just the source
   * ids so `Set.has(node.id)` works directly. See issue #155 (B1).
   */
  orphanNodeIds: string[];
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
  // Issue #122 follow-up (review A4): `scan()` already computes this via
  // `ScanResult.taskCount`; without a field here `init`'s scanSummary
  // silently dropped it, so a `docGraph.autoNodes:false` repo whose tasks.md
  // was already decomposed into task nodes looked identical to one with zero
  // task breakdown.
  taskCount: number;
  // Issue #122 follow-up (review A3): true when the graph contains at least
  // one `implements`/`verifies` edge sourced from an inline `@impl`/`@verifies`
  // code tag whose target REQ/doc node doesn't exist in the graph. The
  // existing "orphan-edge" warning only covers `annotation` provenance, so a
  // dangling code-tag edge is otherwise invisible to `init`'s closing hint —
  // without this flag the brownfield "no @impl claims detected yet" message
  // would contradict a codebase that already has (unmatched) `@impl` tags.
  hasDanglingCodeTag: boolean;
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
  /**
   * Stage gating (P0 redesign, spec 012-skills-expansion, contracts/cli-flags.md).
   *
   * Default behavior (no flags) runs the full agent-native setup:
   *   1. .artgraph.json (config)
   *   2. scan + reconcile (unless noScan)
   *   3. install Skills into .claude/skills/ (unless noSkills)
   *   4. auto-integrate detected SDD tools (unless noIntegrate)
   *   5. install Stop hook into .claude/settings.json (unless noHooks)
   *   6. inject CLAUDE.md / AGENTS.md snippet (unless noAgentContext)         [P1]
   *
   * `--minimal` short-circuits stages 2–6 to off; each can be re-enabled with
   * the matching `with*` flag.
   */
  minimal?: boolean;
  noScan?: boolean;
  noSkills?: boolean;
  noIntegrate?: boolean;
  noHooks?: boolean;
  noAgentContext?: boolean;
  withSkills?: boolean;
  withIntegrate?: boolean;
  withHooks?: boolean;
  withAgentContext?: boolean;
  /**
   * Explicit one-shot integrations to run as part of `init`. When set, overrides
   * the default auto-detect behavior. Each id must resolve to a registered
   * provider; the special string `"all"` expands to every provider whose
   * `detect()` is true.
   *
   * Unmatched / undetected ids produce a warning and are skipped — the init
   * itself still completes with exit 0.
   */
  integrations?: IntegrationProviderId[] | "all";
  /**
   * Forwarded `--integrate-gate` / `--no-integrate-gate` for the speckit
   * provider. The CLI defaults this to `true` when neither flag is passed
   * (contracts/cli-flags.md §integrate-gate, spec.md §FR-003) so a fresh
   * Spec Kit repo gets the `before_implement` gate hook by default.
   * Other providers ignore this flag.
   */
  integrateGate?: boolean;
  /**
   * spec 013 (FR-001 / FR-002) — Tier 1 agent ids the user selected via
   * `--agents=<csv>`. Alpha-sorted, deduped, fully validated by
   * `parseAgentsList`. The Skills and agent-context distribution stages
   * iterate over this list; the SDD-integrate stage ignores it.
   *
   * Empty array means the user passed `--no-skills --no-agent-context` (or
   * `--minimal`) and explicitly opted out of every cross-agent stage. The
   * CLI layer enforces "required when Skills/agent-context runs" before
   * `runInit` is called, so by the time the array reaches here it is
   * either non-empty (will be used) or empty (every cross-agent stage is
   * gated off).
   */
  agents?: import("./agents/descriptors.js").AgentId[];
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
   * - false: artgraph が登録した before_implement hook を削除
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
  /** 出力先（絶対パス推奨）。例: ".kiro/steering/artgraph.md" */
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

// Convention preset for extracting task IDs from list items in a Markdown file,
// plus the SDD tool's cross-linking tag syntax. Built-ins (spec-kit, kiro) ship in
// parsers/markdown.ts; users add tools like OpenSpec via `.artgraph.json`
// `taskConventions`. See specs/005-speckit-remaining/data-model.md §2.
export interface TaskConventionPreset {
  name: string;
  fileStems: string[];
  /** Regex extracting the task ID from a list item's first paragraph. capture group 1 = task ID. */
  taskIdRe: string;
  /**
   * Optional regex extracting `implements`-edge target IDs from the task's listItem subtree.
   * Each match's capture group 1 becomes one edge target. Applied with /g semantics.
   * Omit if the SDD tool doesn't express implementation pointers (e.g. Kiro).
   */
  implementsTagRe?: string;
  /**
   * Optional regex extracting `verifies`-edge target IDs from the task's listItem subtree.
   * Each match's capture group 1 becomes one edge target. Applied with /g semantics.
   * Examples: spec-kit's `[REQ-...]` brackets; kiro's `_Requirements: X, Y, Z_` lists
   * (the regex iterates each ID via lookbehind-free alternation).
   */
  verifiesTagRe?: string;
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

export interface PlanCoverageConfig {
  /**
   * When true, `artgraph plan-coverage` adds a `missingFilesSection`
   * diagnostic for each task block in tasks.md that does not declare a
   * `Files:` section. Defaults to false so existing projects without the
   * `Files:` convention are not broken. The CLI `--require-files-section`
   * flag overrides this on a per-run basis. See spec 014 FR-018.
   */
  requireFilesSection?: boolean;
}

/**
 * Supported package managers. Yarn is intentionally excluded — it falls back to
 * pnpm (the default PM) with a warning. See specs/015-pkg-mgr-agnostic/.
 */
export type PackageManager = "npm" | "pnpm" | "bun" | "deno";

export interface ArtgraphConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  /**
   * Package manager detected at `init` time and recorded so downstream tooling
   * (hooks / agent-context / plugin templating in #109/#110/#111) can build the
   * right exec command without re-sniffing lockfiles. Absent when detection
   * failed. Optional.
   */
  packageManager?: PackageManager;
  reqPatterns?: ReqPatternConfig;
  docGraph?: DocGraphConfig;
  mode?: "file" | "symbol";
  testResultPaths?: string[];
  taskConventions?: TaskConventionPreset[];
  /**
   * Names of built-in task-convention presets to disable. With a built-in
   * disabled the user may supply a `taskConventions` entry of the same name
   * (e.g. to ship a Kiro variant that uses a checkbox-less ID format).
   * Without this opt-out, built-ins silently shadow any user override.
   */
  disableBuiltinTaskConventions?: string[];
  /**
   * Optional spec 014 plan-coverage configuration. Absent on a fresh
   * project; the CLI treats every nested field as defaulted to false.
   */
  planCoverage?: PlanCoverageConfig;
}

export const DEFAULT_CONFIG: ArtgraphConfig = {
  include: ["src/**/*.ts", "src/**/*.tsx"],
  specDirs: ["specs", "docs"],
  testPatterns: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx"],
  lockFile: ".trace.lock",
};
