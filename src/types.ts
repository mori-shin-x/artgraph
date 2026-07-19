export type NodeKind = "req" | "doc" | "file" | "symbol" | "test" | "task";

export type EdgeKind =
  | "depends_on"
  | "derives_from"
  | "implements"
  | "verifies"
  | "imports"
  | "contains"
  // spec 020 (data-model.md §4, FR-006/007/008) — req -> symbol|file, forward
  // only. Execution evidence: "this REQ's tagged green tests ran this code",
  // as opposed to `implements`'s declared intent. Never generated in reverse.
  | "exercises";

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
  | "structural"
  // spec 020 (data-model.md §4, FR-009) — execution evidence (per-test
  // coverage join, `src/trace/ingest.ts`). Sole provenance on `exercises`
  // edges; appended to an existing `implements` edge's provenances when a
  // declared claim and evidence agree on the same (req, symbol|file) pair
  // (FR-008).
  | "coverage";

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
  "coverage",
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
  // spec 020 (data-model.md §5, FR-011) — target nodeIds of this req's
  // `exercises` edges (`[...new Set()].sort()`, same dedupe+sort convention
  // as `impl`/`tests`). Omitted when empty so a project with no trace
  // artifacts round-trips byte-identical to pre-spec-020 lock output.
  exercises?: string[];
  // Schema v2: structured to carry provenance per reference.
  // See specs/011-edge-provenance/contracts/lock-schema-v2.md.
  dependsOn?: Array<{ id: string; provenances: EdgeProvenance[] }>;
  lastReconciled: string;
}

export type LockFile = Record<string, LockEntry>;

// spec 020 (data-model.md §6, FR-014) — `exercised` is the 4th coverage
// status, appearing ONLY when `.artgraph.json`'s `trace.acceptExercises` is
// true: an untagged REQ (no `implements` edge) with >=1 non-stale, exclusive
// `exercises` edge. It is a rescue for untagged REQs only — `impl-only` /
// `verified` REQs never become `exercised` (the declared-REQ evaluation axis
// is unchanged, data-model.md §6).
export type CoverageStatus = "untagged" | "exercised" | "impl-only" | "verified";

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
  /**
   * spec 020 (FR-017, contracts/cli-surface.md §5) — per-`impactReqs`-entry
   * provenance: was this REQ reached (at least in part) through a direct
   * `exercises` edge ("evidence"), through any other edge kind directly
   * incident to it ("static"), or both? Present ONLY when the graph contains
   * at least one `exercises` edge at all (trace-absent scans have zero, so
   * this key is omitted rather than emitted as an all-`["static"]` array —
   * FR-010 byte-identical requirement, T021(e)). Sorted by `reqId`.
   */
  reqProvenance?: Array<{ reqId: string; provenance: Array<"static" | "evidence"> }>;
  /**
   * spec 020 (FR-018, contracts/cli-surface.md §5) — `impact --tests`'
   * output: the tagged tests of every REQ whose (non-stale, per
   * `trace.staleness`) exercises evidence directly reaches one of the
   * resolved start nodes. Present only when `--tests` was passed (undefined
   * otherwise, so the flag is a pure opt-in addition to the JSON schema).
   *
   * Note: `testsToRun[].reqId` may reference a REQ absent from `impactReqs`.
   * `testsToRun` is derived from `ingestedTrace.reqsByNode` (BFS-independent,
   * spec 020 FR-018), while `impactReqs` reflects BFS reachability. Since
   * #286 restricted BFS reverse-`exercises` traversal, evidence-only REQ
   * tests may still surface here without the REQ appearing in `impactReqs`.
   */
  testsToRun?: Array<{ testFile: string; testName: string; reqId: string }>;
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

// spec 020 (data-model.md §7, FR-012/013) — one `(reqId, node)` pair, shared
// shape for both `check`'s `unexercisedClaims`/`suggestedImpls` findings and
// `src/trace/report.ts`'s Phase A `ClaimEvidencePair` (kept as a structurally
// identical, independently-defined type here rather than importing from
// `trace/report.ts` — that module already imports THIS file for
// `ArtifactGraph`, so importing back would be circular).
export interface CoverageClaimEvidencePair {
  reqId: string;
  node: string;
}

// spec 020 (data-model.md §7, FR-015) — one REQ's stale evidence: the subset
// of its `exercises`-evidence nodeIds whose trace-capture-time hash no
// longer matches the current graph (`computeStaleNodeIds`), sorted.
export interface StaleEvidenceEntry {
  reqId: string;
  symbols: string[];
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
   * Derived from the SAME underlying `OrphanEdge[]` that `orphans`
   * descriptors are formatted from, but stripped down to just the source
   * ids so `Set.has(node.id)` works directly. See issue #155 (B1).
   */
  orphanNodeIds: string[];
  uncovered: string[];
  coverage: { reqId: string; status: CoverageStatus }[];
  // REQs whose tests ran and failed (only populated when test results are
  // supplied). These fail the gate in addition to drift/orphans/uncovered.
  testFailures: string[];
  // spec 017 (R8, data-model §1.1) — **meaning changed**: `pass` used to mean
  // "every scoped issue is clear"; it now means "no issue is NEW relative to
  // the baseline" (= gate 合否). The scoped issue arrays above are unchanged
  // (they still list all in-scope issues for display / json back-compat), so a
  // `pass:true` result can coexist with a non-empty `orphans`/`uncovered` (all
  // pre-existing). See spec 017 FR-001.
  pass: boolean;

  // ── spec 017 baseline-diff additions (back-compat, append-only) ──
  // `newIssues` is the `current \ baseline` subset that decides the gate.
  newIssues: NewIssues;
  // Count of scoped issues suppressed as pre-existing (not surfaced as new).
  suppressedCount: number;
  baselineStatus: BaselineStatus;
  // spec 017 (Critical fix B1, issue #182 review) — diagnostic message
  // captured when `baselineStatus === "unavailable"`: the caught exception's
  // message (a `git rev-parse` failure, a `git worktree add` failure, a
  // `scan()` exception, an `mkdtemp` error, etc.), so SKILL/CI consumers can
  // see *why* the baseline could not be established instead of a single
  // generic "unavailable" string. Always a non-empty string when present;
  // unset (undefined) for every other `baselineStatus` value.
  baselineError?: string;

  // ── spec 020 Phase C additions (contracts/cli-surface.md §4, data-model.md
  // §7) — present ONLY when a trace was ingested (shard files exist, FR-010:
  // trace-absent output must stay byte-identical, so these keys are omitted
  // entirely rather than set to `[]`/`false` when there is no trace). ──
  /** `@impl` claims whose claiming REQ's non-stale exercises evidence never
   * reaches the claimed node (FR-012, SC-003). */
  unexercisedClaims?: CoverageClaimEvidencePair[];
  /** No `@impl` claim anywhere, exactly one REQ's evidence reaches the node
   * (FR-013 exclusivity; `sharedThreshold`-or-more is `infrastructure` and
   * intentionally has no `check` finding — only `trace report` surfaces it). */
  suggestedImpls?: CoverageClaimEvidencePair[];
  /** Per-REQ stale exercises evidence (FR-015), computed from the trace
   * regardless of `trace.staleness` mode — the mode only changes whether
   * stale evidence still COUNTS for the findings/status above and whether
   * `staleGate` trips, not whether it is reported here. */
  staleEvidence?: StaleEvidenceEntry[];
  /** `trace.staleness === "gate"` AND `staleEvidence.length > 0` — the
   * signal `src/commands/check.ts` uses to exit 2 under `--gate`, kept
   * separate from `pass` (spec 017's baseline-diff gate) since staleness
   * gating is not part of the new-vs-pre-existing baseline model (FR-015). */
  staleGate?: boolean;
  /** issue #244 — lock entries whose id has no corresponding node in the
   * CURRENT graph (rename/refactor left a stale key behind, or a
   * `mode`/`include`/`exclude`/`ignoreIdPrefixes` config change stopped
   * resolving it — not rename-only). Computed BEFORE `scope` filtering
   * (unlike `drifted`/`orphans`/`uncovered`), deliberately: `scope`
   * (`src/commands/check.ts`) is a union of a current-graph BFS and a
   * BASELINE-graph BFS, so a renamed-away old id can still land in `scope`
   * via the baseline side. Scope-filtering this field would therefore only
   * surface the subset of stale ids that happen to be baseline-reachable
   * and hide the rest — a half-broken filter, defeating the point of a
   * full lock/graph reconciliation view. This field intentionally scans
   * the whole lock regardless of scope. Ascending-sorted,
   * deduplicated. Present ONLY when non-empty (mirrors the spec-020
   * optional-omit convention above, so trace-absent/no-stale output stays
   * byte-identical). Unrelated to `staleEvidence`/`staleGate` (those track
   * trace-evidence freshness against the graph; this tracks lock-key
   * existence in the graph) despite the similar name. Resolved by running
   * `artgraph reconcile`. */
  staleLockEntries?: string[];
  /** issue #284 — counterfactual hint: `uncovered` REQ ids that have
   * exclusive `exercises` evidence (staleness-filtered the same way the real
   * `exercised` computation is) and would be rescued to `exercised` (leaving
   * `uncovered`) if `.artgraph.json`'s
   * `trace.acceptExercises` were turned on. Purely informational — it never
   * affects `pass`, `newIssues`, `suppressedCount`, or any gate/exit-code
   * decision, and it is what the bootstrap Skill's "test-tag path" (issue
   * #284) points users at instead of leaving them at an unexplained
   * untagged/uncovered dead end. Present ONLY when a trace was ingested
   * (same FR-010 byte-identical rule as the other spec-020 optional keys
   * above); when `acceptExercises` is already true this is always `[]`
   * (anything it would rescue has already left `uncovered`). */
  exercisableUncovered?: string[];
}

// spec 017 (data-model §1.1) — the subset of scoped issues that are NEW
// relative to the baseline. Each array is a subset (by identity key) of the
// matching `CheckResult` field, so `orphans`/`uncovered` keep their `string[]`
// shape for json back-compat (R8).
export interface NewIssues {
  drifted: DriftEntry[];
  orphans: string[];
  uncovered: string[];
  testFailures: string[];
}

// spec 017 (data-model §1.1) — lifecycle of the baseline used to diff issues.
export type BaselineStatus =
  | "computed" // worktree で base graph を算出し差分を取った
  | "empty" // HEAD 無し初回コミット前 — baseline 空、全 current が new (FR-014)
  | "skipped" // 遅延評価: `--diff` あり + scope の current issue がゼロで baseline 未算出 (new もゼロ, R6)
  | "not_applicable" // spec 017 (Critical fix B6/D2, issue #182 review) — `--diff` フラグなしのプレーン `check` 実行。baseline 差分という概念自体が適用されない (`skipped` は `--diff` ありでの lazy eval、こちらは `--diff` 自体が無い)
  | "unavailable"; // 構築不能な異常系 (--gate 時は exit 1 の原因, FR-010)

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
   * `--minimal` short-circuits stages 2–6 to off.
   */
  minimal?: boolean;
  noScan?: boolean;
  noSkills?: boolean;
  noIntegrate?: boolean;
  noHooks?: boolean;
  noAgentContext?: boolean;
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
   * - true: before_implement に blocking な check --gate hook を追加
   *   （既存の artgraph エントリは置換）
   * - false: artgraph が登録した before_implement hook を削除
   * - undefined（デフォルト）: artgraph の before_implement エントリが
   *   未登録の場合のみ、非ブロッキングの check --diff プレビュー hook を
   *   追加する。登録済み（過去の --gate 選択を含む）なら触らない
   *   （issue #217: 新規 spec の初回実装で必ず落ちる blocking gate を
   *   デフォルト配線しない）。
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

/**
 * spec 020 (contracts/cli-surface.md §7, data-model.md §8) — `.artgraph.json`
 * `trace` section: shard artifact discovery + `exercises`-edge policy for
 * coverage-derived traceability. The section itself and every field are
 * optional (mirrors `DocGraphConfig`) — an absent field means "use the
 * documented default", applied by each downstream consumer (`src/trace/`,
 * `src/coverage.ts`, `src/commands/trace.ts`) rather than eagerly baked in
 * here, consistent with `docGraph`'s convention elsewhere in this file.
 */
export interface TraceConfig {
  /** Glob(s) for TraceShard JSONL files. Default: [".artgraph/trace/*.jsonl"]. */
  artifacts?: string[];
  /**
   * Opt-in to the `exercised` coverage status (data-model.md §6): a REQ with
   * no `implements` edge but an exclusive `exercises` edge counts as covered.
   * Default: false.
   */
  acceptExercises?: boolean;
  /**
   * How stale evidence (hashesAtTrace mismatched against the current graph)
   * is treated: "warn" surfaces a diagnostic only, "exclude" drops stale
   * `exercises` edges from traversal, "gate" additionally fails `--gate`
   * (FR-015). Default: "warn".
   */
  staleness?: "warn" | "exclude" | "gate";
  /**
   * A symbol/file exercised by this many distinct REQs' tests or more is
   * classified `infrastructure` rather than a `suggestedImpls` candidate
   * (FR-013). Must be a positive integer (>= 1). Default: 3.
   */
  sharedThreshold?: number;
}

export interface PlanCoverageConfig {
  /**
   * When true, `artgraph plan-coverage` adds a `missingFilesSection`
   * diagnostic for each task block in tasks.md that does not declare a
   * `Files:` section. Defaults to false so existing projects without the
   * `Files:` convention are not broken. See spec 014 FR-018.
   */
  requireFilesSection?: boolean;
}

/**
 * Supported package managers. Yarn is intentionally excluded — it falls back to
 * pnpm (the default PM) with a warning. See specs/015-pkg-mgr-agnostic/.
 */
export type PackageManager = "npm" | "pnpm" | "bun" | "deno";

/**
 * issue #366 (scope A) — per-agent outcome of the Stop-hook install stage.
 * One entry per agent in `--agents=<csv>` that has a `hook` config
 * (`src/agents/descriptors.ts`). Mirrors the single-agent `action`/`reason`/
 * `failure` shape the original Claude-only `installHooks()` returned, plus
 * `agentId` so `InitResult.hooksInstall` can report per-agent (BREAKING
 * CHANGE: `InitResult.hooksInstall` is now `{perAgent, anyFailure}` rather
 * than a single outcome — see `src/hooks/index.ts`).
 */
export type HookOutcome = {
  agentId: import("./agents/descriptors.js").AgentId;
  action:
    | "created"
    | "merged-b"
    | "merged-c"
    | "conflict"
    | "invalid-json"
    | "io-error"
    | "skipped-no-pm"
    | "skipped-no-hook-config";
  /** Detail for conflict/error outcomes: rendered command or parse/IO error message. */
  reason?: string;
  /** true → CLI translates this into a non-zero exit code. */
  failure?: boolean;
};

export interface ArtgraphConfig {
  /**
   * fast-glob patterns for source files, resolved relative to the repo root.
   * A leading `!` marks a pattern as an exclusion (issue #266) — see
   * `globCodeFiles` in `src/parsers/typescript.ts`.
   */
  include: string[];
  specDirs: string[];
  /**
   * fast-glob patterns for test files, resolved relative to the repo root.
   *
   * issue #350 (pool separation) — `include` and `testPatterns` are two
   * INDEPENDENT glob pools: `discoverCodeFiles`
   * (`src/parsers/typescript.ts`) globs each pool separately and unions the
   * positive matches. A `!`-prefixed pattern here applies ONLY to
   * `testPatterns`' own positive matches — it narrows test *classification*
   * (see the isTest note below) but does NOT remove a file from the graph
   * if `include` still matches it (the file survives at `kind: "file"` via
   * the `include` pool). Symmetrically, a negative pattern in `include`
   * does not narrow test classification on its own. **To exclude a path
   * from the graph entirely, add the same negative pattern to BOTH
   * `include` and `testPatterns`** — see docs/configuration.md's `include`
   * / `testPatterns` section. Before pool separation (PR #349, issue #350)
   * a negative `testPatterns` pattern silently excluded matching files from
   * the WHOLE scan (as if written under `include`), not just from test
   * classification — that surprise is what motivates writing the exclusion
   * in both places now that the two pools are independent.
   *
   * issue #323 — this is also the SOLE source of truth for whether a file is
   * a "test" (node kind `"test"` vs `"file"`, and whether `[REQ-x]` test-title
   * tags are extracted from it): `discoverCodeFiles`'s `testFiles` result
   * (the `testPatterns` pool's own match set) is what every `isTest` decision
   * derives from — there is no separate hardcoded filename heuristic.
   * Narrowing `testPatterns` therefore narrows (as intended) which files
   * contribute `verifies` edges and test-node coverage, independent of
   * whether those files stay in the graph via `include`.
   */
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
  /**
   * issue #216 — requirement-ID prefixes to exclude from tracking. An ID whose
   * bare token (after an optional `namespace/` qualifier) is exactly
   * `<prefix>-<digits>` for any listed prefix is invisible to the graph: no
   * req node is registered from specs, and code/test/task tags referencing it
   * emit no edges (so it can never surface as UNCOVERED or an orphan).
   * Canonical use case: Spec Kit's Success Criteria (`"ignoreIdPrefixes":
   * ["SC"]`). Default is empty — nothing is ignored.
   */
  ignoreIdPrefixes?: string[];
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
  /**
   * spec 013 follow-up (#158) — Tier 1 agent ids persisted by `artgraph init
   * --agents=<csv>`. Alpha-sorted, deduped. When defined, `artgraph doctor`
   * cross-checks against on-disk agent distribution directories and reports
   * drift. When `undefined` (legacy configs pre-dating this field), doctor
   * falls back to on-disk observation and emits an advisory finding.
   * Empty array is an explicit opt-out (--minimal / --no-skills).
   */
  agents?: import("./agents/descriptors.js").AgentId[];
  /**
   * spec 020 (contracts/cli-surface.md §7) — coverage-derived traceability
   * configuration. `undefined` when `.artgraph.json` omits the `trace` key
   * (every field falls back to its documented default downstream).
   */
  trace?: TraceConfig;
}

export const DEFAULT_CONFIG: ArtgraphConfig = {
  // issue #287 — the trailing negative pattern excludes node_modules at any
  // depth (including nested ones, e.g. `packages/*/node_modules` in a
  // monorepo): fast-glob does not exclude node_modules by default, so
  // without this a fresh `artgraph scan` would ingest thousands of vendored
  // .ts files into the graph. issue #350 (HIGH-2) — `testPatterns` below
  // carries the SAME negation for the same reason: since pool separation
  // made `include` and `testPatterns` independent discovery pools, this
  // pool needs its own `"!**/node_modules/**"` entry too, or a default
  // (unconfigured) project's `testPatterns` pool alone would newly ingest
  // vendored `*.test.ts`/`*.spec.ts` files that `include`'s negation no
  // longer implicitly protected once the two pools stopped sharing one
  // ignore list.
  include: ["src/**/*.ts", "src/**/*.tsx", "!**/node_modules/**"],
  specDirs: ["specs", "docs"],
  // issue #323 — `**/*.spec.tsx` was missing here even though the other
  // three test/spec x ts/tsx combinations are all present; this default was
  // simply asymmetric with itself. Now that `isTest` (node kind, `[REQ-x]`
  // tag extraction gating) is DERIVED from `testPatterns` rather than a
  // hardcoded regex (see `discoverCodeFiles` / `parseTSFile` in
  // `src/parsers/typescript.ts`), this default doubles as the fallback used
  // whenever a caller does not supply its own `testPatterns` — so the
  // asymmetry would otherwise have silently widened beyond file discovery.
  testPatterns: [
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.test.tsx",
    "**/*.spec.tsx",
    "!**/node_modules/**",
  ],
  lockFile: ".trace.lock",
};
