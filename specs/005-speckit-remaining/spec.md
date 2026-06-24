# Feature Specification: Spec Kit 残対応 — Phase 1 (FR-007 / FR-008 / FR-011) + Phase 2 (FR-009 / FR-010 / FR-012)

Feature Branch: `005-speckit-remaining`

Created: 2026-06-20

Last Updated: 2026-06-24

Status:

- **Phase 1 — FR-007 (US1) / FR-008 (US2) / FR-011 (US4)**: **Implemented**（[PR #27](https://github.com/ShintaroMorimoto/artgraph/pull/27) でマージ済 / 2026-06-22）
  - FR-007 / FR-008 はコード実装あり。FR-011 は既存 `specDirs` 再帰スキャンで満たされており追加実装なしと判断され closed。
  - User Story 1 / 2 / 4 の Acceptance Scenarios はマージ済 PR の test suite (`config.test.ts` / `markdown.test.ts` 254 件) で担保。
- **Phase 2 — FR-009 (US3) / FR-010 (US3) / FR-012 (US3 supporting)**: **In Progress**（[Issue #28](https://github.com/ShintaroMorimoto/artgraph/issues/28) / 本 PR）
  - FR-012 は 2026-06-24 の Clarifications で User Story 3 を成立させるために追加された supporting requirement。

Input: Spec Kit パース対応の残タスク（設定可能な ID パターン、frontmatter メタデータ、plan.md/tasks.md 連携、パス規約認識）を完了する。本 spec は Phase 1 完了の歴史的記録と、Phase 2（Issue #28）の作業範囲を併記する。

## Clarifications

### Session 2026-06-24

FR-009 / FR-010（Issue #28）の実装に向けた設計決定を記録する。

- Q: plan.md / tasks.md 内の個別タスク項目をどの NodeKind で表現するか? → A: 新規 `task` NodeKind を `types.ts` に追加する（既存 `req` 流用は `verifies/implements` エッジの方向性と矛盾するため不採用）。
- Q: タスク ID の抽出戦略は? (Kiro / OpenSpec 等への拡張性を含む) → A: 規約プリセット方式 — Built-in `spec-kit`（`tasks.md` / `T\d+`）と `kiro`（`tasks.md` / 階層数字 `\d+(?:\.\d+)*`）を実装し、`.artgraph.json` の `taskConventions` フィールドで OpenSpec 等のカスタムプリセットを追加可能にする。C-3 の `CONVENTION_EDGES` と同じ思想で、ファイル名 stem 検出 → 該当プリセットの regex を適用。
- Q: `@impl(target-id)` の target はどう解決するか? → A: 自由形式 ID — `@impl(X)` は無条件で `task → implements → X` エッジを生成し、X の存在確認・解決は builder 段に委ねる。未解決は既存 `orphan-doc` 系の警告に集約。現行 TS パーサの `// @impl REQ-001` と同じ哲学を維持し、`auth-login` のような論理 ID も `REQ-001` のような req ID もコード path (`src/auth/login.ts`) も同一パスで扱える。
- Q: tasks.md の `[REQ-XXX]` タグの target ID 処理は? → A: `REQ-` prefix を **残す** — `[REQ-AUTH-001]` → target=`REQ-AUTH-001`。現行 TS パーサ (`typescript.ts:254`) と一致させ、`coverage.ts` / `lock.ts` 等の下流処理を既存のまま再利用する。元の Acceptance Scenario の "AUTH-001" 表記は編集ミスとして本 spec 内で訂正済み。
- Q: `@impl(...)` / `[REQ-]` タグの認識スコープはファイル名で限定するか?（U1） → A: **`taskConventions` プリセットの file-stem に一致するファイル全てで両タグを認識する**。FR-009 は plan.md、FR-010 は tasks.md と例示しているが、本質は「プリセットが認識する task ファイル全体で両タグを扱う」こと。symmetric 認識のほうが UX が素直で実装も簡素（[research.md §R3](./research.md)）。FR-009 / FR-010 の本文にも反映。
- Q: 新規 `task` ノードを `.trace.lock` の drift / orphan 判定対象にするか?（U2） → A: **本 Issue では対象外**。`task` は `coverage` / `lock` に積まない。理由: (a) Constitution Principle III「Spec が ID を所有」の "Spec" はトップレベル要件であり、tasks.md の `T001` は実装段ラベルのためカバレッジ集計対象として扱うのは原則の境界外、(b) task は `implements` / `verifies` エッジの **source** であり、target の req が既に lock 連動するため二重集計を避ける、(c) impact 分析の入口としては `traverse.ts` で task を出発点に認めれば十分。将来 task 単位のドリフト検出が必要になれば separate issue で。
- Q: `task` NodeKind 追加で NodeKind が増加するが、将来の進化に対するガードレールは?（CV1） → A: **Constitution Principle II の規定通り** `plan.md` の Constitution Check で justify する（Principle II は NON-NEGOTIABLE ではなく「まずどのノード/エッジ型に写像できるかを検討し、追加する場合は plan.md の Constitution Check で正当性を説明する」と定めるのみ）。前提として Principle II は 4 抽象層（req / doc / code / test）を宣言しており、現行実装は code 層を `file` と `symbol` の 2 NodeKind で表現しているため現行 5 NodeKind、本 PR では `task` を追加し 6 NodeKind とする。追加の累積カウンタや専用 tracking issue は設けない（Principle II が要求しない ceremony を避ける）。Constitution 本文の改訂が必要になる場合は別途 `speckit-constitution` で発議する。

## User Scenarios & Testing (mandatory)

### Implemented Stories (Phase 1, PR #27 / 2026-06-22)

以下の User Story 1 / 2 / 4 は PR #27 で実装完了。各 Acceptance Scenario は同 PR 内のテストでカバー済みのため、本 spec では履歴として残し詳細は PR #27 / 該当テストファイルを参照すること。

| Story | Priority | FR | 完了確認 |
|---|---|---|---|
| US1 — 設定可能な ID パターン | P2 | FR-007 | `tests/config.test.ts` reqPatterns 系 5 件 + `tests/markdown.test.ts` 5 件 |
| US2 — Spec Kit frontmatter メタデータの読み取り | P3 | FR-008 | `tests/markdown.test.ts` metadata 系 5 件 |
| US4 — `.artgraph.json` の Spec Kit パス規約認識 | P4 | FR-011 | 既存 `specDirs` 再帰スキャンで充足（追加実装なしで closed） |

### Active Story (Phase 2, Issue #28 / In Progress)

User Story 3 (FR-009 / FR-010 / FR-012) のみが本 PR で実装される outstanding なストーリー。詳細は下記。

---

### User Story 1 - 設定可能な ID パターン (Priority: P2) — **Implemented (PR #27)**

ユーザが `.artgraph.json` の `reqPatterns` フィールドにカスタム正規表現を指定し、プロジェクト固有の要件 ID フォーマット（例: `JIRA-\d+`, `US\d+` など）を artgraph に認識させる。`ReqPatternConfig` 型は `types.ts` に定義済みだが、`markdown.ts` のパーサには未接続のため、この接続を確立する。

Why this priority: `ReqPatternConfig` 型とコンフィグ読み込みは実装済みで接続するだけの低コスト作業であり、カスタムパターンを使いたいユーザの即時ニーズに対応する。

Independent Test: `.artgraph.json` にカスタムパターンを設定し、そのパターンに合致する ID を含む Markdown ファイルをパースして、正しくノードが抽出されることを確認する。

Acceptance Scenarios:

1. Given `.artgraph.json` に `reqPatterns.listItem` が `"^(JIRA-\\d+)[:\\s]"` と設定されている, When `JIRA-123: ログイン機能` というリスト項目を含む Markdown をパースする, Then ID `JIRA-123` の `req` ノードが抽出される
2. Given `.artgraph.json` に `reqPatterns.heading` が `"^(US-?\\d+)\\s*:"` と設定されている, When `### US-42: ユーザ登録` という見出しを含む Markdown をパースする, Then ID `US-42`（キャプチャグループ 1 をそのまま使用）の `req` ノードが抽出される
3. Given `.artgraph.json` に `reqPatterns` が未設定, When Markdown をパースする, Then 現行の `LIST_ITEM_RE` と `KIRO_HEADING_RE` がデフォルトとして使用される
4. Given `.artgraph.json` に `reqPatterns.listItem` のみ設定されている, When Markdown をパースする, Then リスト項目にはカスタムパターンが、見出しにはデフォルトの `KIRO_HEADING_RE` が適用される
5. Given `reqPatterns.listItem` に無効な正規表現が設定されている, When 設定をロードする, Then 明確なエラーメッセージが表示され、パースが中断される

---

### User Story 2 - Spec Kit frontmatter メタデータの読み取り (Priority: P3) — **Implemented (PR #27)**

Spec Kit 形式の Markdown ファイルの YAML frontmatter から `title`, `status`, `priority`, `owner` を読み取り、doc ノードの属性として保持する。これによりグラフ上でドキュメントの状態や責任者を参照可能になる。ただし `status` 値を coverage 判定のヒントとしては使用しない（Deterministic Integrity 原則）。

Why this priority: メタデータの読み取り自体は低リスクだが、downstream の活用シナリオが未確定のため、まずデータ保持のみに留める。

Independent Test: frontmatter に `title`, `status`, `priority`, `owner` を含む Markdown をパースし、生成された `GraphNode` の `metadata` フィールドにそれらの値が格納されていることを確認する。

Acceptance Scenarios:

1. Given frontmatter に `title: "認証設計"`, `status: "draft"`, `priority: "P1"`, `owner: "yamada"` が記載されている, When その Markdown をパースする, Then doc ノードの `metadata` に `{ title: "認証設計", status: "draft", priority: "P1", owner: "yamada" }` が格納される
2. Given frontmatter に `title` のみ存在する, When パースする, Then `metadata` に `{ title: "..." }` のみが格納され、未指定フィールドはキーとして存在しない
3. Given frontmatter が存在しない Markdown, When パースする, Then `metadata` フィールドは `undefined` のまま
4. Given frontmatter に `status: "implemented"` が設定されている, When coverage チェックを実行する, Then `status` 値は coverage 判定に影響せず、構造的な `@impl` / テストタグのみで判定される

---

### User Story 3 - plan.md / tasks.md とコードの紐付き (Priority: P3) — **In Progress (Issue #28)**

Spec Kit の plan.md に記載されたタスクが `@impl` タグでソースコードに紐づき、tasks.md の項目がテストの `[REQ-xxxx]` タグで検証される関係をグラフに表現する。Spec Kit 側のフォーマットが安定してから着手する前提。

Why this priority: Spec Kit の plan.md / tasks.md フォーマットがまだ流動的なため、フォーマット安定後に着手する。現行のグラフモデルの拡張性を確認する意味合いが強い。

Independent Test: plan.md 内の `@impl(SRC-xxx)` タグと tasks.md 内の `[REQ-xxx]` タグを含むフィクスチャを用意し、パース後のグラフに `implements` / `verifies` エッジが正しく生成されることを確認する。

Acceptance Scenarios（fixture では一貫して `REQ-FR-NNN` 形式で例示する。命名は形式自由）:

1. Given plan.md に `@impl(auth-login)` タグ付きのタスクが存在する, When plan.md をパースする, Then `task` ノードから `auth-login` への `implements` エッジが生成される（FR-009 §1）
2. Given tasks.md に `[REQ-FR-001]` タグ付きの項目が存在する, When tasks.md をパースする, Then `task` ノードから `REQ-FR-001` への `verifies` エッジが生成される（`REQ-` prefix は剥がさず、bracket 内文字列をそのまま target ID とする）（FR-010 §1）
3. Given plan.md と tasks.md の両方が存在する, When グラフを構築する, Then spec.md の要件 → plan.md のタスク → コードファイル、および tasks.md の項目 → テストファイルの完全なトレーサビリティチェーンが形成される（FR-009 / FR-010 / FR-012 統合）
4. Given plan.md 内のタスクに `[REQ-FR-002]` が記載されている（FR 例の逆スコープ）, When plan.md をパースする, Then `task → verifies → REQ-FR-002` エッジが生成される（U1: タグはプリセット適用ファイル全てで認識）
5. Given tasks.md 内のタスクに `@impl(stripe-client)` が記載されている, When tasks.md をパースする, Then `task → implements → stripe-client` エッジが生成される（U1 対称）

---

### User Story 4 - .artgraph.json の Spec Kit パス規約認識 (Priority: P4) — **Implemented (PR #27, no code change required)**

`specs/NNN-feature/spec.md` というディレクトリ構造を `.artgraph.json` のパス規約として認識し、番号付きフィーチャーディレクトリ内のファイルを自動的にスキャン対象に含める。`specs/` は既にデフォルトの `specDirs` に含まれているため、ディレクトリ構造のパターンマッチングを追加する。

Why this priority: `specDirs` に `specs` が既に含まれており、現状でもサブディレクトリは再帰的にスキャンされる。明示的なパターン認識はフィーチャー単位のフィルタリングが必要になったときに対応すればよい。

Independent Test: `specs/001-auth/spec.md` と `specs/002-billing/spec.md` が存在する状態でグラフを構築し、両方のファイルからノードが抽出されることを確認する。フィーチャー番号による選択的スキャンの動作もテストする。

Acceptance Scenarios:

1. Given `specDirs` に `specs` が含まれている, When `specs/001-auth/spec.md` と `specs/002-billing/spec.md` が存在する, Then 両方のファイルが自動的にパース対象になる
2. Given `.artgraph.json` にフィーチャーフィルタ設定が追加されている, When 特定のフィーチャー番号（例: `001`）を指定してスキャンする, Then そのフィーチャーディレクトリのファイルのみがパースされる
3. Given `specs/` ディレクトリに `spec.md`, `plan.md`, `tasks.md` が存在するフィーチャーディレクトリがある, When グラフを構築する, Then 各ファイルが適切な種別（spec → doc/req, plan → doc, tasks → doc）で認識される

---

### Edge Cases

- `reqPatterns.listItem` に空文字列が指定された場合、エラーとして扱いデフォルトにフォールバックしない（明示的な設定ミスを見逃さない）
- frontmatter の `status` フィールドに任意の文字列が入る可能性があるが、バリデーションは行わずそのまま保持する（Spec Kit 側の責務）
- `reqPatterns` のカスタム正規表現にキャプチャグループが含まれない場合、エラーメッセージでキャプチャグループの必要性を示す
- plan.md / tasks.md が Spec Kit フォーマットに従わない場合、通常の Markdown としてパースし、タグ未検出でもエラーにしない（Incremental Adoption 原則）
- 同一フィーチャーディレクトリ内の spec.md と plan.md で同名の ID が定義された場合、既存の名前空間衝突解決（`specDir/ID` 修飾）が適用される
- frontmatter に `artgraph.node_id` と Spec Kit メタデータ（`title` 等）の両方が存在する場合、両方を独立して処理する（`artgraph.node_id` は本 spec 外で定義される doc ノード ID オーバライド機構。実装は `packages/artgraph/src/parsers/markdown.ts` の `VALID_ARTGRAPH_KEYS` 定数 = `["node_id", "derives_from", "depends_on"]` に基づく。設計の出所は `docs/design/document-graph.md` および Spec 008-document-graph。シンボル参照を優先し行番号は明記しない — リファクタで陳腐化するため）

## Requirements (mandatory)

### Functional Requirements

Phase 1（PR #27 で **Implemented**）:

- **FR-007** _(Implemented)_: `.artgraph.json` の `reqPatterns` フィールドで、リスト項目パターン（`listItem`）と見出しパターン（`heading`）をカスタム正規表現で指定できる。未設定時は現行の `LIST_ITEM_RE` / `KIRO_HEADING_RE` をデフォルトとして使用する。
- **FR-008** _(Implemented)_: Spec Kit 形式の frontmatter から `title`, `status`, `priority`, `owner` フィールドを読み取り、`GraphNode` の `metadata` フィールドに `Record<string, string>` として格納する。`status` 値は coverage 判定に使用しない。
- **FR-011** _(Implemented, no code change)_: `specs/NNN-feature/` ディレクトリ構造をフィーチャー単位として認識し、特定フィーチャーに限定したスキャンを可能にする。既存 `specDirs` 再帰スキャンで充足。

Phase 2（Issue #28 / 本 PR で **In Progress**）:

- **FR-009** _(In Progress)_: `task` ノードから実装ターゲットへの `implements` エッジを生成する。タグ書式は **preset がそれぞれ供給する `implementsTagRe`** に従う (parser に hardcoded な共通 regex は無い)。spec-kit は `@impl(target-id)`、Kiro は実装ポインタタグを使わない (`implementsTagRe` 未定義のため implements edge は生成されない)。`target-id` は自由形式文字列として扱い、parser 段では存在確認を行わない (builder 段で突き合わせ、未解決時は `orphan-doc` 系警告)。**認識対象ファイル**: [Clarifications U1](#clarifications) を参照 (`taskConventions` プリセット適用ファイル全て)。詳細 Acceptance: [US3 §1, §5](#user-story-3---planmd--tasksmd-とコードの紐付き-priority-p3----in-progress-issue-28)
- **FR-010** _(In Progress)_: `task` ノードから要件への `verifies` エッジを生成する。タグ書式は **preset がそれぞれ供給する `verifiesTagRe`** に従う。spec-kit は `[REQ-xxxx]` (bracket 内文字列をそのまま、`REQ-` prefix は剥がさない、例: `[REQ-FR-001]` → target = `REQ-FR-001`)、Kiro は `_Requirements: 1.1, 2.3_` (italic カンマ区切り、各 ID を 1 件ずつ抽出)。spec-kit の ID 形式は TS パーサ (`typescript.ts:254`) と一致し、`coverage.ts` / `lock.ts` の既存ロジックを再利用できる。**認識対象ファイル**: [Clarifications U1](#clarifications) を参照。詳細 Acceptance: [US3 §2, §4](#user-story-3---planmd--tasksmd-とコードの紐付き-priority-p3----in-progress-issue-28)
- **FR-012** _(In Progress)_: タスク ID 抽出 + cross-link タグ抽出は **規約プリセット方式** で行う。`TaskConventionPreset` は `name` / `fileStems` / `taskIdRe` (必須) と `implementsTagRe` / `verifiesTagRe` (optional) を持ち、SDD ツール別に書式を切り替え可能。Built-in プリセット: `spec-kit` (`plan` / `tasks` stem、`T\d+` ID、`@impl()` + `[REQ-]` tag)、`kiro` (`tasks` stem、階層数字 ID、`_Requirements:` tag のみ)。`.artgraph.json` の `taskConventions` で OpenSpec 等のカスタムプリセットを追加可能。検出はファイル名 stem 一致で行い、複数プリセットが該当した場合は両方を適用、エッジ dedup (`source|target|kind`) で重複排除する。

### Non-Functional Requirements

- NFR-001: カスタム正規表現に無効なパターンが指定された場合、パース開始前にバリデーションエラーを発生させ、エラー箇所を特定可能なメッセージを出力する。**対象は `reqPatterns` (Phase 1, PR #27 で実装済) と `taskConventions` (Phase 2) の両方**。同一の `validate*` ヘルパ ([config.ts:28](../../packages/artgraph/src/config.ts) `validateReqPatterns` を再利用または並列) で 200 文字上限 / nested quantifier / capture group / 重複 name のチェックを行い、エラーメッセージは [contracts/config-schema.md §検証ルール](./contracts/config-schema.md) の表を出典とする。
- NFR-002: frontmatter メタデータの読み取りは既存のパース処理に 5% 以上のパフォーマンス劣化を与えない。
  - **計測方法**: `packages/artgraph/tests/fixtures/specs/` 配下の既存全 fixture（>= 20 ファイル）を入力に、`buildGraph(rootDir, DEFAULT_CONFIG)` を 10 回実行した中央値で比較する。ベースラインは PR #27 マージ直後の `main` (`a6176c1`) の同条件実行値。
  - **閾値運用**: **< 5%** → 情報提供のみ（PR 本文に貼付）、**5% 〜 10%** → 原因調査（プロファイルログ等を PR コメントに残す。ブロッカーではない）、**> 10%** → リリースブロッカー（マージ前に最適化または NFR-002 改訂が必要）。
- NFR-003: FR-007 / FR-008 は既存テストを破壊しない（後方互換性の維持）。
- NFR-004: FR-009 / FR-010 / FR-012 も既存テスト (PR #27 完了時点の `pnpm test` 565 件) を破壊しない（Phase 2 後方互換性）。`taskConventions` 未設定時に builtin が静かに有効化されても、既存 fixture には task ID 行が無いため task ノード生成数ゼロを期待する（[research.md §R2](./research.md) 参照）。

### Key Entities

- ReqPatternConfig: カスタム要件 ID パターンの設定を保持する型。`listItem` と `heading` フィールドに正規表現文字列を格納する。`types.ts` に定義済み。
- GraphNode.metadata: doc ノードに付与される Spec Kit frontmatter メタデータ。`Record<string, string>` 型のオプショナルフィールド。
- ArtgraphConfig.reqPatterns: `.artgraph.json` から読み込まれるパターン設定。`config.ts` で読み込み済みだがパーサに未接続。
- FeatureDirectory: `specs/NNN-feature/` 形式のディレクトリ。spec.md, plan.md, tasks.md を含むフィーチャー単位のまとまり。
- TaskNode: plan.md / tasks.md 内のタスク項目を表すノード。`NodeKind = "task"`（FR-009/FR-010 で新規追加）。`task` は `req`（WHAT）と対をなす HOW レベルの抽象で、`implements`/`verifies` エッジのソースとなる。
- TaskConventionPreset: `{ name: string; fileStems: string[]; taskIdRe: string }` の純データ型。`fileStems` は同一プリセットを複数 stem に適用するための配列（例: spec-kit は `["plan", "tasks"]` で両ファイルを task ファイルとして扱う）。Built-in `spec-kit` / `kiro` を `parsers/markdown.ts`（または `graph/conventions.ts`）に定義し、`ArtgraphConfig.taskConventions` でユーザ拡張可。OpenSpec 対応はカスタムプリセット追加 1 件で完結する設計。詳細スキーマ: [contracts/config-schema.md](./contracts/config-schema.md)。

## Success Criteria (mandatory)

### Measurable Outcomes

Phase 1（PR #27 で **Achieved**）:

- **SC-001** _(Achieved)_: `reqPatterns` にカスタムパターンを設定した場合、そのパターンに合致する ID がパース結果に含まれる（FR-007 / US1 Acceptance Scenarios §1–5 で検証済）
- **SC-002** _(Achieved)_: Spec Kit frontmatter の `title`, `status`, `priority`, `owner` が `GraphNode.metadata` に正しく格納される（FR-008 / US2 Acceptance Scenarios §1–4 で検証済）
- **SC-003** _(Achieved)_: `reqPatterns` 未設定時に既存の全テストが変更なしで通過する（後方互換性、PR #27 254 件全 PASS）
- **SC-006** _(Achieved, no code change)_: `specs/NNN-feature/` ディレクトリ構造内のファイルが自動的にスキャン対象に含まれる（FR-011 / US4 Acceptance Scenarios §1, §3 で検証済）

Phase 2（Issue #28 / 本 PR で達成目標）:

- **SC-004** _(Pending)_: plan.md の `@impl` タグから `implements` エッジが正しく生成される（FR-009 / [US3 Acceptance Scenario §1](#user-story-3---planmd--tasksmd-とコードの紐付き-priority-p3----in-progress-issue-28) §5 で検証 — `tasks.md` 上の `@impl` も含む）
- **SC-005** _(Pending)_: tasks.md の `[REQ-xxxx]` タグから `verifies` エッジが正しく生成される（FR-010 / [US3 Acceptance Scenario §2](#user-story-3---planmd--tasksmd-とコードの紐付き-priority-p3----in-progress-issue-28) §4 で検証 — `plan.md` 上の `[REQ-]` も含む）。target ID は bracket 内文字列をそのまま使用（TS パーサと整合）。
- **SC-007** _(Pending)_: 規約プリセット方式により Built-in (`spec-kit`, `kiro`) およびユーザ追加プリセット (例: OpenSpec) が同一の経路で動作する（FR-012 / [quickstart.md Scenario 3 / 5](./quickstart.md) で検証）。
- **SC-008** _(Pending)_: Phase 2 後の `pnpm --filter artgraph test` で既存 565 件 + 新規テスト全件が PASS（NFR-004 の運用化）。

## Assumptions

- Spec Kit の spec.md フォーマット（frontmatter + Markdown body）は安定しており、大幅な変更は想定しない
- plan.md / tasks.md のフォーマットは現時点で流動的であり、FR-009/010 の実装時にフォーマット仕様が確定している前提
- `ReqPatternConfig` 型と `config.ts` の `reqPatterns` 読み込みは PR #6 の成果物としてそのまま使用可能
- カスタム正規表現のキャプチャグループ位置（1 番目）は固定とし、ユーザがグループ位置を指定する機能は含めない
- `GraphNode` への `metadata` フィールド追加は TypeScript のオプショナルプロパティとして行い、既存コードへの影響を最小化する
- `specs/` ディレクトリは既に `specDirs` のデフォルトに含まれているため、サブディレクトリの再帰スキャンは現行動作で対応済み
- (Phase 2 / FR-010) ユーザは spec.md 内の req ID 形式（例 `FR-001`）と tasks.md 内の `[REQ-FR-001]` の `REQ-` prefix 差を意識する必要がある。`task → verifies → REQ-FR-001` エッジの target は spec の `FR-001` ノードと **異なる ID** となり、graph 上は未解決 (`orphan-doc` 系警告で illumination される) になる。これは現行 TS パーサ ([typescript.ts](../../packages/artgraph/src/parsers/typescript.ts) の `[REQ-001]` → `REQ-001`) と同じ挙動で、Phase 2 でこの不一致を解消する意図はない。spec 側で `REQ-FR-001` を採用するか、`reqPatterns` で `[A-Z]+-[A-Z]+-\d+` を許容するなどの上位設計に委ねる
