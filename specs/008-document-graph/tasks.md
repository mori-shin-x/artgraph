# Tasks: ドキュメント間グラフ構造

Input: Design documents from `specs/008-document-graph/`

Prerequisites: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

Tests: TDD を推奨（constitution の Development Workflow に記載）。各タスクにテストを含める。

Organization: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- [P]: Can run in parallel (different files, no dependencies)
- [Story]: Which user story this task belongs to
- Include exact file paths in descriptions

---

## Phase 1: Setup

Purpose: 型定義の拡張、設定の追加、テストフィクスチャの準備

- [ ] T001 `src/types.ts` の EdgeKind に `"contains"` を追加する: `export type EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports" | "contains";`
- [ ] T002 `src/types.ts` に `DocGraphConfig` インターフェースを追加する: `{ autoNodes?: boolean; autoContains?: boolean; }` （デフォルト: いずれも true）
- [ ] T003 `src/types.ts` の `SpectraceConfig` に `docGraph?: DocGraphConfig` フィールドを追加する
- [ ] T004 `src/types.ts` の `ImpactResult` に `summary?: ImpactSummary` を追加し、`ImpactSummary` インターフェース `{ docs: number; reqs: number; files: number; }` を追加する
- [ ] T005 `src/graph/builder.ts` の `BuildWarning.type` union に `"orphan-doc" | "invalid-relation" | "reserved-prefix"` を追加し、`message?: string` フィールドを追加する
- [ ] T006 `src/parsers/markdown.ts` の `ParsedSpec` に `warnings: ParseWarning[]` を追加し、`ParseWarning` インターフェース `{ type: "invalid-relation" | "reserved-prefix"; key: string; filePath: string; }` を定義する
- [ ] T007 [P] `tests/fixtures/specs/prose-only.md` を作成する: frontmatter なし、要求 ID なしの散文のみ Markdown
- [ ] T008 [P] `tests/fixtures/specs/doc-chain/requirements.md` を作成する: frontmatter に `spectrace: { node_id: "requirements" }` を記述
- [ ] T009 [P] `tests/fixtures/specs/doc-chain/design.md` を作成する: frontmatter に `spectrace: { node_id: "design", derives_from: ["requirements"] }` を記述
- [ ] T010 [P] `tests/fixtures/specs/doc-chain/tasks.md` を作成する: frontmatter に `spectrace: { derives_from: ["design"] }` を記述
- [ ] T011 [P] `tests/fixtures/specs/doc-with-reqs.md` を作成する: frontmatter に `spectrace: { node_id: "auth-spec" }` を記述し、本文に `- FR-001: ...` リスト項目を含む

Checkpoint: 型定義が拡張され、テストフィクスチャが準備された状態。`pnpm build` が通ること。

---

## Phase 2: Foundational — 設定読み込みと frontmatter パーサ変更

Purpose: docGraph 設定の読み込みと frontmatter スキーマのフラット化。全 User Story の前提。

### Tests for Foundational

- [ ] T012 `tests/config.test.ts` に `docGraph` 設定テストを追加する: `.spectrace.json` に `{ "docGraph": { "autoNodes": false } }` を指定した場合に `config.docGraph.autoNodes === false` が返ること
- [ ] T013 [P] `tests/config.test.ts` に `docGraph` 省略時のデフォルトテストを追加する: `docGraph` 未指定時に `config.docGraph` が `undefined` であること（ランタイムで `?? true` によりデフォルト true として扱う）
- [ ] T014 `tests/markdown.test.ts` に frontmatter フラット化テストを追加する: `spectrace: { derives_from: ["requirements.md"] }` が `derives_from` エッジを生成すること（旧 `depends_on: [{ id, relation }]` 形式からの移行）

### Implementation for Foundational

- [ ] T015 `src/config.ts` の `loadConfig` に `docGraph` の読み込みを追加する: `raw.docGraph` を `SpectraceConfig.docGraph` にマッピング
- [ ] T016 `src/parsers/markdown.ts` の `spectraceMeta` 型定義をフラット形式に変更する: `{ node_id?: string; derives_from?: string[]; depends_on?: string[]; [key: string]: unknown }` 。旧形式 `depends_on: [{ id, relation }]` のパースロジックを新形式に置き換える
- [ ] T017 `src/parsers/markdown.ts` のエッジ生成ロジックを更新する: `derives_from` 配列から `derives_from` エッジ、`depends_on` 配列から `depends_on` エッジをそれぞれ直接生成する
- [ ] T018 `src/parsers/markdown.ts` に `invalid-relation` 警告を追加する: `spectrace` ブロック内の `node_id` / `derives_from` / `depends_on` 以外のキーを検出し `ParseWarning` として返す
- [ ] T019 既存テスト（`pnpm test`）が通ることを確認する。frontmatter 形式の変更により既存テストの期待値更新が必要な場合は修正する

Checkpoint: 設定読み込みと frontmatter パーサのフラット化が完了。既存テストが全てパス。

---

## Phase 3: User Story 1 — 散文 Markdown のグラフ自動登録 (Priority: P1)

Goal: frontmatter の有無に関わらず各 md ファイルを `doc` ノードとしてグラフに自動登録する（FR-001）

Independent Test: frontmatter を含まない散文のみの md ファイルを配置し `spectrace scan` で doc ノードとして認識されることを確認する

### Tests for User Story 1

- [ ] T020 [US1] `tests/markdown.test.ts` に doc ノード自動生成テストを追加する: frontmatter なしの `prose-only.md` をパースし `{ id: "doc:prose-only.md", kind: "doc" }` ノードが返ること
- [ ] T021 [P] [US1] `tests/markdown.test.ts` に frontmatter `node_id` 指定テストを追加する: `spectrace.node_id: "custom-id"` が指定された場合に `{ id: "custom-id", kind: "doc" }` ノードが返ること
- [ ] T022 [P] [US1] `tests/markdown.test.ts` に doc ノードの contentHash テストを追加する: ファイル全体のハッシュが doc ノードの contentHash に設定されること
- [ ] T023 [P] [US1] `tests/markdown.test.ts` に doc + req 併存テストを追加する: 要求 ID を含む md から doc ノードと req ノードの両方が返ること
- [ ] T024 [P] [US1] `tests/builder.test.ts` に `docGraph.autoNodes: false` テストを追加する: 設定で無効化時に frontmatter `node_id` がない md からは doc ノードが生成されないこと
- [ ] T025 [P] [US1] `tests/builder.test.ts` に doc ノード ID 自動採番テストを追加する: `doc:<specDir からの相対パス>` 形式で ID が生成されること

### Implementation for User Story 1

- [ ] T026 [US1] `src/parsers/markdown.ts` の `parseMarkdown` を変更し、全ての md ファイルで doc ノードを常時生成する: frontmatter `spectrace.node_id` がある場合はその値を ID に、無い場合は `doc:<relPath>` を ID にする。contentHash はファイル全体のハッシュ
- [ ] T027 [US1] `src/graph/builder.ts` の `buildGraph` に `docGraph.autoNodes` 設定チェックを追加する: `autoNodes === false` かつ frontmatter `node_id` が無い場合、doc ノードを除外する
- [ ] T028 [US1] `src/graph/builder.ts` に `reserved-prefix` 警告を追加する: req ID が `doc:` / `file:` / `test:` / `symbol:` で始まる場合に `BuildWarning` を発行する

Checkpoint: `pnpm test` が通り、散文のみの md ファイルが doc ノードとしてグラフに登録される

---

## Phase 4: User Story 2 — ドキュメント間の依存チェーン表現 (Priority: P1)

Goal: frontmatter の `spectrace` ブロックで doc→doc 依存（derives_from / depends_on）を宣言し、グラフに反映する（FR-002, FR-005, FR-006）

Independent Test: frontmatter で derives_from 関係を記述した 3 ファイルの連鎖を配置し、`spectrace scan` で doc→doc エッジが正しく張られることを確認する

### Tests for User Story 2

- [ ] T029 [US2] `tests/builder.test.ts` に derives_from チェーンテストを追加する: `doc-chain/` フィクスチャの 3 ファイルをビルドし `design --derives_from--> requirements` と `tasks --derives_from--> design` のエッジが生成されること
- [ ] T030 [P] [US2] `tests/builder.test.ts` に `orphan-doc` 警告テストを追加する: frontmatter の依存先に存在しないノード ID を指定した場合に `orphan-doc` 警告が返ること
- [ ] T031 [P] [US2] `tests/builder.test.ts` に `invalid-relation` 警告テストを追加する: frontmatter に `extends` 等の不正キーがある場合に `invalid-relation` 警告が返ること
- [ ] T032 [P] [US2] `tests/builder.test.ts` にエッジデデュープテストを追加する: 同じ source, target, kind の組が複数存在する場合に 1 本に統合されること
- [ ] T033 [P] [US2] `tests/builder.test.ts` に `duplicate-id` テストを追加する: 異なるファイルが同じ `node_id` を frontmatter で指定した場合に `duplicate-id` 警告が出ること

### Implementation for User Story 2

- [ ] T034 [US2] `src/graph/builder.ts` に doc→doc エッジの生成ロジックを追加する: `parseMarkdown` が返す `derives_from` / `depends_on` エッジ（Phase 2 で実装済み）をグラフに登録する
- [ ] T035 [US2] `src/graph/builder.ts` に `orphan-doc` 警告を追加する: 全ノード登録後に doc→doc エッジのターゲットがグラフに存在しない場合に `BuildWarning` を発行する
- [ ] T036 [US2] `src/graph/builder.ts` に `ParseWarning` → `BuildWarning` 変換を追加する: `parseMarkdown` が返す `invalid-relation` 警告を `BuildWarning` に変換する
- [ ] T037 [US2] `src/graph/builder.ts` にエッジデデュープロジックを追加する（FR-006）: 全エッジ確定後に source, target, kind の組をキーとして重複を除去する

Checkpoint: `pnpm test` が通り、doc→doc 依存チェーンがグラフに正しく反映され、orphan-doc / invalid-relation 警告が出力される

---

## Phase 5: User Story 3 — ドキュメントから要求・実装への一気通貫トレース (Priority: P1)

Goal: doc ノードとその中の req ノード間に `contains` エッジを自動生成し、doc→req→実装の一気通貫トレースを可能にする（FR-003, FR-009, FR-010, FR-011）

Independent Test: 要求 ID を含む spec.md とその要求を実装するコードを配置し、spec.md 起点の `impact` が実装ファイルまで到達することを確認する

### Tests for User Story 3

- [ ] T038 [US3] `tests/builder.test.ts` に contains エッジ自動生成テストを追加する: doc ノードと同一ファイル内の req ノード間に `contains` エッジが生成されること
- [ ] T039 [P] [US3] `tests/builder.test.ts` に `docGraph.autoContains: false` テストを追加する: 設定で無効化時に contains エッジが生成されないこと
- [ ] T040 [P] [US3] `tests/builder.test.ts` に contains エッジの remap テストを追加する: 名前空間衝突で req ID が remap される場合に contains エッジのターゲットも remap 後の ID に更新されること
- [ ] T041 [P] [US3] `tests/traverse.test.ts` に depth 制限テストを追加する: `impact` に `maxDepth: 2` を指定した場合に depth 2 を超えるノードに到達しないこと
- [ ] T042 [P] [US3] `tests/traverse.test.ts` に `resolveStartIds` の `doc:` プレフィクス対応テストを追加する: ファイルパスを入力した場合に対応する doc ノードも起点に含まれること
- [ ] T043 [P] [US3] `tests/traverse.test.ts` に一気通貫トレーステストを追加する: doc 起点で contains → req → implements → file まで到達すること
- [ ] T044 [P] [US3] `tests/traverse.test.ts` に `ImpactSummary` テストを追加する: impact 結果に `summary: { docs, reqs, files }` が含まれること

### Implementation for User Story 3

- [ ] T045 [US3] `src/graph/builder.ts` に contains エッジ自動生成ロジックを追加する: 同一 `filePath` を持つ doc ノードと req ノードの間に `{ source: docId, target: reqId, kind: "contains" }` エッジを生成する。`docGraph.autoContains === false` の場合は生成しない
- [ ] T046 [US3] `src/graph/builder.ts` の contains エッジで remap 対応を追加する: 名前空間衝突により req ID が修飾された場合、contains エッジのターゲットも修飾後の ID を使用する
- [ ] T047 [US3] `src/graph/traverse.ts` の `impact` 関数に `maxDepth` パラメータを追加する: BFS キューの各要素に depth カウンタを持たせ、`maxDepth` 指定時は `depth >= maxDepth` のノードから隣接ノードをキューに追加しない。デフォルトは無制限（既存動作を維持）
- [ ] T048 [US3] `src/graph/traverse.ts` の `resolveStartIds` に `doc:` プレフィクス対応を追加する: `doc:${input}` でのノード解決をステップ 2（`file:` 解決）の後に追加する（FR-010）
- [ ] T049 [US3] `src/graph/traverse.ts` の `impact` 関数の戻り値に `summary` フィールドを追加する: `{ docs: affectedDocs.length, reqs: affectedReqs.length, files: affectedFiles.length }` を計算して返す（FR-009）

Checkpoint: `pnpm test` が通り、doc 起点の impact が contains エッジを経由して req → 実装ファイルまで到達する

---

## Phase 6: User Story 4 — ドキュメント依存グラフの可視化 (Priority: P2)

Goal: `spectrace graph` コマンドでドキュメント依存チェーンを text / JSON 形式で出力する（FR-004）

Independent Test: doc 依存チェーンを持つプロジェクトで `spectrace graph` を実行し、text / JSON 両形式で依存構造が正しく出力されることを確認する

### Tests for User Story 4

- [ ] T050 [US4] `tests/graph-format.test.ts` を新規作成し、`formatGraphText` のテストを追加する: ルートノードからの深さ優先ツリーがインデント付きで出力されること
- [ ] T051 [P] [US4] `tests/graph-format.test.ts` に `formatGraphJSON` のテストを追加する: `{ nodes: [...], edges: [...] }` 形式の JSON 文字列が出力されること
- [ ] T052 [P] [US4] `tests/graph-format.test.ts` に `--kind doc` フィルタテストを追加する: doc ノードと doc 間エッジのみが出力されること（source と target の両方が doc の場合のみエッジを含む）
- [ ] T053 [P] [US4] `tests/graph-format.test.ts` に複数ルートノードのテストを追加する: 複数のルートがある場合に空行で区切られること
- [ ] T054 [P] [US4] `tests/cli.test.ts` に `spectrace graph` コマンドの統合テストを追加する: CLI 経由で graph コマンドが実行でき、text/JSON 形式で出力されること

### Implementation for User Story 4

- [ ] T055 [US4] `src/graph/format.ts` を新規作成する: `formatGraphText(graph: ArtifactGraph, kindFilter?: NodeKind): string` を実装する。ルートノード（他のノードの target になっていないノード）を起点に深さ優先でツリーを出力。インデントは 2 スペース x depth、エッジラベルは `[edge_kind]` 形式
- [ ] T056 [US4] `src/graph/format.ts` に `formatGraphJSON(graph: ArtifactGraph, kindFilter?: NodeKind): string` を実装する: `{ nodes: [...], edges: [...] }` 形式の JSON 文字列を返す。`--kind` フィルタ適用時は指定 kind のノードのみ含み、エッジは source と target の両方がフィルタを通過した場合のみ含む
- [ ] T057 [US4] `src/cli.ts` に `graph` コマンドを追加する: `program.command("graph")` で `--format <text|json>` と `--kind <doc|req|file|test>` オプションを受け取り、`formatGraphText` / `formatGraphJSON` を呼び出す

Checkpoint: `pnpm test` が通り、`spectrace graph` コマンドが text / JSON 形式で依存構造を出力する

---

## Phase 7: CLI 拡張と警告表示

Purpose: impact コマンドの --depth オプション、impact 出力の到達内訳表示、CLI の警告表示拡張

### Tests for CLI

- [ ] T058 `tests/cli.test.ts` に `impact --depth` オプションテストを追加する: `--depth 2` を指定した場合に depth 制限が impact 関数に渡されること
- [ ] T059 [P] `tests/cli.test.ts` に impact 到達内訳表示テストを追加する: text 形式の impact 出力に `Summary: N docs, N reqs, N files` が含まれること
- [ ] T060 [P] `tests/cli.test.ts` に新しい警告タイプの表示テストを追加する: `orphan-doc` / `invalid-relation` / `reserved-prefix` 警告が正しいフォーマットで stderr に出力されること

### Implementation for CLI

- [ ] T061 `src/cli.ts` の `impact` コマンドに `--depth <number>` オプションを追加する: `program.command("impact")` に `.option("--depth <depth>", "Limit BFS traversal depth")` を追加し、`impact()` 呼び出し時に `maxDepth` として渡す
- [ ] T062 `src/cli.ts` の `printImpactText` に到達内訳表示を追加する: `result.summary` がある場合に `Summary: N docs, N reqs, N files` を出力する（FR-009）
- [ ] T063 `src/cli.ts` の警告表示ロジックを switch 文に変更する: `orphan-doc` / `invalid-relation` / `reserved-prefix` の表示フォーマットを contracts/warning-types.md の仕様に従い追加する。scan コマンドと check コマンドの両方で共通の `printWarnings` ヘルパー関数を使用する

Checkpoint: `pnpm test` が通り、`impact --depth` と到達内訳が動作し、全警告タイプが正しく表示される

---

## Phase 8: Polish と最終検証

Purpose: 既存テストの互換性確認、quickstart シナリオの検証、全体の品質確認

- [ ] T064 既存テスト（`tests/builder.test.ts`）の doc ノード自動生成による影響を確認する: 既存フィクスチャから新たに doc ノードが生成されることで nodeCount アサーションの更新が必要な場合は修正する。または `docGraph: { autoNodes: false }` をテスト設定に追加して既存テストを変更せずに済ませる（research.md R5 参照）
- [ ] T065 [P] `src/lock.ts` の `buildLockFromGraph` が contains エッジを lock に含めないことを確認するテストを追加する: contains エッジは永続化しない（spec Assumption）
- [ ] T066 [P] `quickstart.md` の 5 つの検証シナリオを手動で実行し、全て通ることを確認する
- [ ] T067 全テスト（`pnpm test`）がパスし、ビルド（`pnpm build`）が成功することを確認する

Checkpoint: 全テストがパスし、quickstart シナリオが全て成功。008-document-graph 機能が完成。

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup): No dependencies -- can start immediately
- Phase 2 (Foundational): Depends on Phase 1 (型定義が更新されていること) -- BLOCKS all user stories
- Phase 3 (US1 - 散文 doc ノード): Depends on Phase 2 completion
- Phase 4 (US2 - doc→doc 依存チェーン): Depends on Phase 2 completion. Can run in parallel with Phase 3
- Phase 5 (US3 - 一気通貫トレース): Depends on Phase 3 and Phase 4 completion (doc ノードと doc→doc エッジの両方が必要)
- Phase 6 (US4 - graph コマンド): Depends on Phase 3 completion (doc ノードが必要). Can run in parallel with Phase 4/5
- Phase 7 (CLI 拡張): Depends on Phase 5 completion (depth 制限と summary が必要) and Phase 6 completion
- Phase 8 (Polish): Depends on all phases being complete

### User Story Dependencies

- US1 (P1 - 散文 doc ノード): Can start after Phase 2 -- No dependencies on other stories
- US2 (P1 - doc→doc 依存): Can start after Phase 2 -- Can run in parallel with US1
- US3 (P1 - 一気通貫トレース): Depends on US1 and US2 (doc ノードと doc→doc エッジの両方が前提)
- US4 (P2 - graph コマンド): Depends on US1 (doc ノードが必要). Can start before US2/US3 complete

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD)
- Parser / 型変更 before builder 変更 before traverse 変更 before CLI 変更
- Core implementation before integration

### Parallel Opportunities

- T007, T008, T009, T010, T011 can run in parallel (independent fixture files)
- T012, T013 can run in parallel (independent config tests)
- T020-T025 can run in parallel (independent test cases)
- T029-T033 can run in parallel (independent test cases)
- T038-T044 can run in parallel (independent test cases)
- T050-T054 can run in parallel (independent test cases)
- T058-T060 can run in parallel (independent test cases)
- US1 and US2 can run in parallel after Phase 2

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Complete Phase 1: Setup (型定義・フィクスチャ)
2. Complete Phase 2: Foundational (設定・frontmatter パーサ)
3. Complete Phase 3: US1 (散文 doc ノード自動登録)
4. Complete Phase 4: US2 (doc→doc 依存チェーン)
5. STOP and VALIDATE: 散文 md が doc ノードとして登録され、derives_from チェーンが動作することを確認

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (散文 doc ノード) → Test independently → 散文 md がグラフに参加
3. Add US2 (doc→doc 依存) → Test independently → ドキュメント連鎖が可視化
4. Add US3 (一気通貫トレース) → Test independently → doc→req→実装の完全トレース
5. Add US4 (graph コマンド) → Test independently → グラフ可視化
6. CLI 拡張 + Polish → 全機能統合、品質確認
7. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1 と US2 は独立して実装・テスト可能
- US3 は US1 + US2 の両方が動作している前提
- US4 は US1 完了後から着手可能
- 全フェーズで TDD: テストを先に書き、失敗を確認してから実装
- contains エッジは lock ファイルに永続化しない（毎回グラフから再生成）
- `docGraph.autoNodes: false` を既存テストに設定することで、doc ノード自動生成による既存テスト破壊を防ぐ
