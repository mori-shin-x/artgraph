# Tasks: Spec Kit spec.md パース対応

Input: Design documents from `specs/001-speckit-spec-parse/`

Prerequisites: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

Tests: TDD を推奨（constitution の Development Workflow に記載）。各タスクにテストを含める。

Organization: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- [P]: Can run in parallel (different files, no dependencies)
- [Story]: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

Purpose: 型定義の更新とテストフィクスチャの準備

- [ ] T001 `src/types.ts` の GraphNode から `slug` フィールドを削除する
- [ ] T002 `src/types.ts` の LockEntry から `slug` を削除し `specFile?: string` を追加する
- [ ] T003 `src/types.ts` の CheckResult の coverage 型から `slug` を削除する
- [ ] T004 `src/types.ts` に `ReqPatternConfig` 型を追加し、`SpectraceConfig` に `reqPatterns?: ReqPatternConfig` を追加する
- [ ] T005 `src/config.ts` に `reqPatterns` の読み込みロジックを追加する（デフォルト値付き）
- [ ] T006 [P] `tests/fixtures/specs/speckit-style.md` を作成する（Spec Kit リスト項目形式: FR-001, FR-002, SC-001 を含む。太字形式 `**FR-001**` も混在）
- [ ] T007 [P] `tests/fixtures/specs/kiro-style.md` を作成する（Kiro 見出し形式: `### Requirement 1:`, `### Requirement 2:` を含む）
- [ ] T008 [P] `tests/fixtures/specs/auth.md` を新しい ID 形式（PREFIX-NNN）に更新する

Checkpoint: 型定義が更新され、テストフィクスチャが準備された状態。ビルドが通ること。

---

## Phase 2: Foundational (Blocking Prerequisites)

Purpose: slug 削除の波及を全ファイルに反映。全 User Story の前提。

- [ ] T009 `src/coverage.ts` の CoverageEntry から `slug` フィールドと参照を削除する
- [ ] T010 [P] `src/check.ts` の coverage 出力から `slug` を削除する
- [ ] T011 [P] `src/lock.ts` の `buildLockFromGraph` から slug 書き出しを削除し、`specFile` 書き出しを追加する
- [ ] T012 [P] `src/cli.ts` の `printCheckText` から slug 表示を削除する
- [ ] T013 `tests/coverage.test.ts` を更新し slug に依存するアサーションを削除する
- [ ] T014 [P] `tests/check.test.ts` を更新し slug に依存するアサーションを削除する
- [ ] T015 全テスト（`pnpm test`）が通ることを確認する

Checkpoint: slug 削除が完了し、既存テストが全てパス。User Story の実装に着手可能。

---

## Phase 3: User Story 1 — リスト項目の仕様 ID 認識 (Priority: P1)

Goal: Spec Kit / BMAD 形式のリスト項目 `- FR-001: ...` を `req` ノードとして認識する

Independent Test: `tests/fixtures/specs/speckit-style.md` を scan し、FR-001 等が req ノードとしてグラフに登録されることを確認

### Tests for User Story 1

- [ ] T016 [US1] `tests/markdown.test.ts` にリスト項目パターンのテストケースを追加する: `- FR-001: ...` → `{ id: "FR-001", kind: "req" }` ノードが返ること
- [ ] T017 [P] [US1] `tests/markdown.test.ts` に太字パターンのテストケースを追加する: `- **SC-001**: ...` → `{ id: "SC-001", kind: "req" }` ノードが返ること
- [ ] T018 [P] [US1] `tests/markdown.test.ts` にネストリスト項目の content-hash テストを追加する: 子項目を含む listItem 全体がハッシュ対象であること
- [ ] T019 [P] [US1] `tests/typescript.test.ts` に新 ID 形式の @impl テストを追加する: `// @impl FR-001` → `{ target: "FR-001", kind: "implements" }` エッジが返ること
- [ ] T020 [P] [US1] `tests/typescript.test.ts` に新 ID 形式のテストタグテストを追加する: `[FR-001]` → `{ target: "FR-001", kind: "verifies" }` エッジが返ること

### Implementation for User Story 1

- [ ] T021 [US1] `src/parsers/markdown.ts` の `parseMarkdown` にリスト項目走査を追加する: remark AST の `listItem` ノードを visit し、テキストに `PREFIX-NNN` パターンがマッチすれば `req` ノードを生成する
- [ ] T022 [US1] `src/parsers/markdown.ts` のリスト項目 content-hash を実装する: `listItem` ノードの全テキスト（ネスト子要素含む）を hash 対象にする
- [ ] T023 [US1] `src/parsers/typescript.ts` の IMPL_RE / REQ_ID_RE を更新する: `REQ-[0-9a-fA-F]{4,}` から `[A-Z][A-Za-z]*-\d+` パターンに変更する
- [ ] T024 [US1] `src/parsers/typescript.ts` の TEST_REQ_RE / TEST_ANNOTATION_RE を更新する: 新 ID パターンに対応させる
- [ ] T025 [US1] `tests/markdown.test.ts` の既存テストケースを新 ID 形式に更新する（auth.md フィクスチャの変更に合わせる）

Checkpoint: `pnpm test` が通り、Spec Kit 形式のリスト項目が req ノードとして認識される

---

## Phase 4: User Story 2 — 見出しの仕様 ID 認識 (Priority: P2)

Goal: Kiro 形式の見出し `### Requirement 1: ...` を `req` ノードとして認識する（ID は `Requirement-1` に正規化）

Independent Test: `tests/fixtures/specs/kiro-style.md` を scan し、`Requirement-1` 等が req ノードとしてグラフに登録されることを確認

### Tests for User Story 2

- [ ] T026 [US2] `tests/markdown.test.ts` に Kiro 見出しパターンのテストケースを追加する: `### Requirement 1: ...` → `{ id: "Requirement-1", kind: "req" }` ノードが返ること
- [ ] T027 [P] [US2] `tests/markdown.test.ts` に Kiro 見出しの content-hash テストを追加する: セクションコンテンツ全体がハッシュ対象であること
- [ ] T028 [P] [US2] `tests/typescript.test.ts` に `// @impl Requirement-1` のテストを追加する: 正規化形式の ID がエッジの target になること

### Implementation for User Story 2

- [ ] T029 [US2] `src/parsers/markdown.ts` の見出し走査に Kiro パターンを追加する: `Requirement N` マッチ時に `Requirement-N` に正規化して `req` ノードを生成する
- [ ] T030 [US2] `src/parsers/typescript.ts` の @impl パターンに `Requirement-\d+` を追加する
- [ ] T031 [US2] `src/parsers/typescript.ts` のテストタグパターンに `Requirement-\d+` を追加する

Checkpoint: `pnpm test` が通り、Kiro 形式の見出しが req ノードとして認識される

---

## Phase 5: User Story 3 — 名前空間による ID 衝突の解決 (Priority: P3)

Goal: 複数 spec に同一 ID が存在する場合、spec ディレクトリ名で修飾して衝突を防ぐ

Independent Test: 同じ FR-001 を持つ2つの spec.md を scan し、別のノードとして登録されること、曖昧な @impl に警告が出ることを確認

### Tests for User Story 3

- [ ] T032 [US3] `tests/fixtures/specs/` に名前空間衝突テスト用のサブディレクトリとフィクスチャを作成する: `ns-a/spec.md`（FR-001 含む）と `ns-b/spec.md`（FR-001 含む）
- [ ] T033 [US3] `tests/markdown.test.ts`（または新規 `tests/builder.test.ts`）に衝突検出テストを追加する: 同一 ID が異なる spec にある場合に修飾形式（`ns-a/FR-001`, `ns-b/FR-001`）で登録されること
- [ ] T034 [P] [US3] `tests/builder.test.ts` に @impl の曖昧解決テストを追加する: 修飾なし `FR-001` が複数マッチ時に警告を含むこと

### Implementation for User Story 3

- [ ] T035 [US3] `src/graph/builder.ts` を2パスビルドに再構成する: パス1 で全 spec をパースして `CollectedReq` リストを収集し、ID ごとに衝突を検出する
- [ ] T036 [US3] `src/graph/builder.ts` のパス2 を実装する: 衝突する ID を `specDirName/ID` 形式に修飾して Map に登録し、エッジの target も修飾する
- [ ] T037 [US3] `src/graph/builder.ts` に @impl タグの ID 解決ロジックを追加する: 修飾なし ID → 一意なら解決、複数マッチなら警告

Checkpoint: `pnpm test` が通り、名前空間の衝突が正しく解決される

---

## Phase 6: Polish & Cross-Cutting Concerns

Purpose: 設定の拡張と全体の品質確認

- [ ] T038 [P] `src/config.ts` のデフォルト `reqPatterns` が正しく適用されることをテストする（`tests/config.test.ts` 追加または既存テストに追加）
- [ ] T039 [P] `.spectrace.json` のカスタム `reqPatterns` で ID パターンを変更できることをテストする
- [ ] T040 [P] `quickstart.md` の4つの検証シナリオを手動で実行し、全て通ることを確認する
- [ ] T041 全テスト（`pnpm test`）がパスし、ビルド（`pnpm build`）が成功することを確認する

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup): No dependencies — can start immediately
- Phase 2 (Foundational): Depends on Phase 1 (types must be updated first) — BLOCKS all user stories
- Phase 3 (US1 - リスト項目): Depends on Phase 2 completion
- Phase 4 (US2 - 見出し): Depends on Phase 2 completion. Can run in parallel with Phase 3
- Phase 5 (US3 - 名前空間): Depends on Phase 3 and Phase 4 completion (needs both ID patterns working)
- Phase 6 (Polish): Depends on all user stories being complete

### User Story Dependencies

- US1 (P1): Can start after Phase 2 — No dependencies on other stories
- US2 (P2): Can start after Phase 2 — Can run in parallel with US1
- US3 (P3): Depends on US1 and US2 (needs both ID patterns registered before testing collision)

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Parser changes before @impl/test tag changes
- Core implementation before integration

### Parallel Opportunities

- T006, T007, T008 can run in parallel (independent fixture files)
- T009, T010, T011, T012 can run in parallel (slug deletion in independent files)
- T016-T020 can run in parallel (independent test files)
- US1 and US2 can run in parallel after Phase 2

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (型定義・フィクスチャ)
2. Complete Phase 2: Foundational (slug 削除)
3. Complete Phase 3: User Story 1 (リスト項目認識)
4. STOP and VALIDATE: Spec Kit 形式の spec.md を scan して req ノードが検出されることを確認
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (リスト項目) → Test independently → Spec Kit 互換 (MVP!)
3. Add US2 (見出し) → Test independently → Kiro 互換
4. Add US3 (名前空間) → Test independently → 複数 spec 対応
5. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1 と US2 は独立して実装・テスト可能
- US3 は US1 + US2 の両方が動作している前提
- 全フェーズで TDD: テストを先に書き、失敗を確認してから実装
