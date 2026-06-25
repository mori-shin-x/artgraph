---
description: "Task list for req→req dependency annotation feature"
---

# Tasks: 要求 ⇔ 要求 (req→req) の依存をインライン注釈で表現する

**Input**: Design documents from `specs/010-req-req-dependency/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含む（spec FR-014 で 10 件以上のテストケース必須）

**Organization**: User Story ごとにタスクを束ね、各 story を独立に実装・検証可能にする。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 異なるファイル・依存なしで並行実行可能
- **[Story]**: US1/US2/US3/US4 のいずれか（Foundational / Polish には付かない）
- すべてのファイルパスは monorepo 構造 `packages/artgraph/...` で示す

## Path Conventions

- ソース: `packages/artgraph/src/`
- テスト: `packages/artgraph/tests/`
- フィクスチャ: `packages/artgraph/tests/fixtures/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 既存の pnpm monorepo を継続使用。本 feature 用の新規依存追加は無し。

- [X] T001 Confirm working tree is on branch `feat/req-req-dependency-issue13`, `pnpm install` 完了、`pnpm -F artgraph build` がグリーンであることを確認する

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: すべての user story が依存する型・純粋関数・警告 type の整備。これらを先に通すことで US1/US2/US3/US4 が並行で進められる。

**⚠️ CRITICAL**: User story 着手前にこの phase を完了させること

- [X] T002 [P] `packages/artgraph/src/types.ts` に `EdgeProvenance = "annotation" | "frontmatter" | "convention" | "tag"` を追加し、`GraphEdge` に optional `provenance?: EdgeProvenance` を追加する（参照: [contracts/provenance-field.md](./contracts/provenance-field.md)）
- [X] T003 [P] `packages/artgraph/src/types.ts` の `ParseWarning` / `BuildWarning` 関連 type に `invalid-annotation-id` / `empty-annotation` / `self-reference-annotation` を追加する
- [X] T004 [P] `packages/artgraph/src/parsers/markdown.ts` に純粋関数 `stripAnnotations(text: string): string` を追加（R3 の strip ロジック、注釈括弧群の繰り返し除去）
- [X] T005 [P] `packages/artgraph/src/parsers/markdown.ts` に純粋関数 `extractAnnotations(text: string, reqId: string, sourceLine: number, opts): { extracts: AnnotationExtract[]; warnings: ParseWarning[] }` を追加（R1 正規表現、ID 分解、`reqPatterns.codeId` 検証、空注釈警告）。返り値型 `AnnotationExtract` も同ファイルで定義する
- [X] T006 [P] `packages/artgraph/tests/markdown.test.ts` に `stripAnnotations` 単体テストを追加（注釈あり/なし両入力、複数注釈、空白バリエーション）
- [X] T007 [P] `packages/artgraph/tests/markdown.test.ts` に `extractAnnotations` 単体テストを追加（[contracts/annotation-grammar.md](./contracts/annotation-grammar.md) の「期待される単体テストケース」リスト **ケース 1-18 全件**。受理 / dedup / 非受理（silent skip）/ 警告系を含む。case 19-20 は builder 段階のため T011 で扱う）
- [X] T008 [P] `packages/artgraph/tests/fixtures/req-req-annotations/` ディレクトリと collision 用 fixture を作成する: `collision/010-a/spec.md`（`- AUTH-001: Aの認証`、`- AUTH-002: A固有 (depends_on: AUTH-001)` を含む）と `collision/010-b/spec.md`（`- AUTH-001: Bの認証`、`- AUTH-003: B固有 (depends_on: AUTH-001)` を含む）。同名 ID `AUTH-001` が 2 specDir に存在する状態を再現し、remap で `010-a/AUTH-001` `010-b/AUTH-001` に解決されることを期待する

**Checkpoint**: 型と純粋関数が揃い、US1〜US4 を並行で進められる状態

---

## Phase 3: User Story 1 - list-item 形式の要求に注釈で依存関係を書く (Priority: P1) 🎯 MVP

**Goal**: `- AUTH-002: ... (depends_on: AUTH-001)` のような list-item 形式 req の注釈から req→req `depends_on` / `derives_from` エッジを生成し、グラフ／impact 出力に反映する。

**Independent Test**: 同一 spec.md に `- AUTH-001` と `- AUTH-002 ... (depends_on: AUTH-001)` を配置 → `artgraph scan` を実行（lock/graph 生成）→ `artgraph graph --format json` で出力を検査 → `AUTH-002 --depends_on--> AUTH-001` エッジが含まれることを確認。

### Tests for User Story 1

- [X] T009 [P] [US1] `packages/artgraph/tests/fixtures/req-req-annotations/list-item.md` を作成。最低限以下の行を含む: (a) 受理 7 種（単一/複数/derives_from/BOLD/空白/同 keyword 並列/別 keyword 並列）、(b) **誤検出ゼロ確認** 3 種（散文中 `(depends on AUTH-001)` underscore-less、大文字 `(DEPENDS_ON: AUTH-001)`、引用ブロック `> (depends_on: AUTH-001)`）、(c) fenced code block 内 ``` ```md\n(depends_on: AUTH-001)\n``` ``` 1 種
- [X] T010 [P] [US1] `packages/artgraph/tests/markdown.test.ts` に list-item 注釈統合テストを追加（T009 fixture を読み込み、生成された edges と warnings を assert）
- [X] T011 [P] [US1] `packages/artgraph/tests/builder.test.ts` に req→req エッジに関する 3 種のテストを追加: (a) 既存 `remapId` ループ通過で衝突 ID が `specDir/REQ` に解決される（T008 collision fixture を使用）、(b) **orphan-edge**: 注釈で参照された ID がグラフに存在しない場合 `orphan-edge` 警告が emit され edge は target をそのまま記録（contracts ケース 19）、(c) **dedup**: 同一 source/target/kind の req→req edge が複数経路から生成されてもグラフ上は 1 本に統合（contracts ケース 11）

### Implementation for User Story 1

- [X] T012 [US1] `packages/artgraph/src/parsers/markdown.ts` の `visit(tree, "listItem", ...)` ブロック内で `extractAnnotations` を呼び出し、生成された edges を `provenance: "annotation"` 付きで `edges` 配列に push する（T005 完了後）
- [X] T013 [US1] `packages/artgraph/src/parsers/markdown.ts` の list-item req `reqHash` 計算で `stripAnnotations(toString(node))` を入力に使うように変更する（T004 完了後）
- [X] T014 [US1] `packages/artgraph/src/graph/builder.ts` に req→req エッジに対する `self-reference-annotation` 警告検出を追加（source === target の `provenance: "annotation"` エッジを drop して warning を emit）

**Checkpoint**: list-item 形式の注釈で req→req エッジが生成され、衝突 ID は specDir 修飾で解決される。MVP として単独デプロイ可能

---

## Phase 4: User Story 2 - heading 形式の要求でも同じ依存表現を使える (Priority: P1)

**Goal**: Kiro `## Requirement N: ...` のような heading 形式 req に対し、heading 直下の最初の段落ブロックの **先頭行** または **末尾行**（単一行段落の場合はその 1 行）に書かれた注釈で同様のエッジを生成する。

**Independent Test**: `## Requirement 2: セッション管理` の直下行に `(depends_on: Requirement-1)` を書いた spec.md → `artgraph scan` → `artgraph graph --format json` でエッジ生成を確認。

### Tests for User Story 2

- [X] T015 [P] [US2] `packages/artgraph/tests/fixtures/req-req-annotations/heading-kiro.md` を作成（contracts ケース 8/9/10/12/13 に対応する 5 種: 段落先頭行配置、段落末尾行配置、段落単一行配置、heading 行内括弧式、段落中間行括弧式）
- [X] T016 [P] [US2] `packages/artgraph/tests/markdown.test.ts` に heading 注釈統合テストを追加（contracts ケース 8/9/10 で edges 生成、ケース 12/13 で edge 生成しない & 警告も出ない silent skip を assert）

### Implementation for User Story 2

- [X] T017 [US2] `packages/artgraph/src/parsers/markdown.ts` の heading 処理ブロックで「heading 直下にある最初の段落ブロック」（heading 行の次から空行 or 次の heading までの連続非空行）の範囲を特定するヘルパ（`extractFirstParagraphAfterHeading(content, headingLine)`）を追加し、その段落の **先頭行** と **末尾行**（単一行段落の場合は同一行）に対して `extractAnnotations` を呼ぶ。FR-002 / [contracts/annotation-grammar.md](./contracts/annotation-grammar.md) §「最初の段落ブロックの定義」と整合させる
- [X] T018 [US2] `packages/artgraph/src/parsers/markdown.ts` の heading req `headingContent` 計算で、`stripAnnotations` を最初の段落ブロックの **先頭行** と **末尾行** に対して適用してから hash に渡すように変更する

**Checkpoint**: list-item / heading 双方の注釈が認識される

---

## Phase 5: User Story 3 - 注釈の追加・変更で上流 req が drift 扱いにならない (Priority: P1)

**Goal**: 注釈の追記・変更・削除によって req 本体の content-hash が変動しないことを E2E で保証する（spec SC-003、Constitution 原則 I の根幹）。

**Independent Test**: 既存 req に対し `artgraph scan` で初回 lock を記録 → 注釈追記 → 再 `artgraph scan` → lock 内 `contentHash` が不変 / `artgraph check` で drift が出ないことを確認。

### Tests for User Story 3

- [X] T019 [P] [US3] `packages/artgraph/tests/markdown.test.ts` に list-item req の hash 不変性テストを追加（注釈追加・変更・削除の 3 ケース）
- [X] T020 [P] [US3] `packages/artgraph/tests/markdown.test.ts` に heading req の hash 不変性テストを追加（同 3 ケース）
- [X] T021 [US3] `packages/artgraph/tests/markdown.test.ts` に「本文変更で hash 変動する」回帰テストを追加（注釈不変・本文だけ変更 → hash が変わることを confirm し、strip が過剰除去していないことを保証）

**Checkpoint**: 注釈変更による誤 drift がゼロ。`artgraph check` の挙動に影響なし

---

## Phase 6: User Story 4 - REQ ID rename で注釈内の依存参照も追従する (Priority: P2)

**Goal**: `artgraph rename OLD NEW` 実行時に、すべての注釈括弧内の `OLD` 参照を `NEW` に書き換える。fenced code block は除外（既存 F6 規約）。

**Independent Test**: 注釈で `OLD` を参照する spec.md が複数ある状態で `artgraph rename OLD NEW` を実行 → 全ファイルの注釈が `NEW` に書き換わっていることを diff で確認 → さらに rename 後に `artgraph scan && artgraph graph --format json` でエッジ数が rename 前と一致し orphan-edge が増えないことを確認。

### Tests for User Story 4

- [X] T022 [P] [US4] `packages/artgraph/tests/fixtures/req-req-annotations/multi-id.md` を作成（複数 ID 注釈、BOLD 形式、fenced block 内サンプル含む）
- [X] T023 [P] [US4] `packages/artgraph/tests/rename.test.ts` に `rewriteAnnotationIds` 単体テストを追加（[contracts/rename-behavior.md](./contracts/rename-behavior.md) のテストケース 1-10 を全件）
- [X] T024 [P] [US4] `packages/artgraph/tests/rename.test.ts` に rename E2E ケースを追加: (a) list-item REQ ID 書換と注釈内参照書換が同一実行で発生する、(b) **SC-004 保証**: rename 前後で `buildGraph` の `edges.length` が一致する、(c) **SC-004 保証**: rename 前後で `orphan-edge` 警告の件数が増加しない

### Implementation for User Story 4

- [X] T025 [US4] `packages/artgraph/src/rename.ts` に `rewriteAnnotationIds(content, oldId, newId, opts): RewriteResult` を追加（R5 のロジック、`fencedLineSet` 流用、R1 正規表現流用）
- [X] T026 [US4] `packages/artgraph/src/rename.ts` の rename オーケストレータ（既存 `rewriteSpecListItem` / `rewriteImplTag` の呼び出し列）に `rewriteAnnotationIds` を組み込む

**Checkpoint**: 既存 rename 機能と整合した形で注釈内 ID も追従する

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: ドキュメント反映、quickstart 検証、リファクタ確認

- [X] T027 [P] `docs/spectrace-design.md` に req→req 注釈仕様の節を追加（§6 「具体スキーマ」配下、または新規 §6.x）。spec / plan で確定したキーワード・正規表現・hash 戦略を要約
- [X] T028 [P] `README.md` に req→req 注釈サポートの 1 段落追記（既存「対応する記法」セクション周辺）
- [X] T029 quickstart.md の Scenario 1-5 を手動実行し、出力が contract 通りであることを確認（CI 化は別 issue）— scratchpad で全 5 シナリオを実行、Scenario 1/2/4/5 を確認し quickstart の CLI 構文を実機に合わせて修正済み
- [X] T030 `pnpm -F artgraph lint && pnpm -F artgraph test` をフルで実行し、既存テストが全て pass することを確認 — 619 tests pass, lint warnings は既存範囲のみ（本 feature 由来の新規 warning なし）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし
- **Foundational (Phase 2)**: Setup 後、すべての US をブロック
- **US1 (Phase 3)**: Foundational 完了後
- **US2 (Phase 4)**: Foundational 完了後、US1 と独立に進行可
- **US3 (Phase 5)**: Foundational 完了後。`stripAnnotations` が wired-in されている必要があるため、US1 の T013 と US2 の T018 がマージされてから統合テスト（T019-T021）を実行
- **US4 (Phase 6)**: Foundational 完了後、US1/US2/US3 と独立に進行可（rename ロジックは parser と分離）
- **Polish (Phase 7)**: 全 US 完了後

### Within Each Phase

- T002-T005（Foundational 実装）は並行可。T006-T008（テスト・fixture scaffold）は実装と独立に着手可
- 各 US 内: テスト → 実装 の順を推奨。並行担当の場合はテストを先にレビューに出して実装側がモック合わせ
- 同一ファイル `parsers/markdown.ts` を触る T012/T013/T017/T018 は **シリアル**（[P] なし）

### Parallel Opportunities

- Foundational 内 T002-T008 はすべて異なるファイル／責務で [P]
- 各 US 内のテスト作成（T009/T010/T011、T015/T016、T019/T020、T022/T023/T024）は [P]
- US1/US2/US4 は並行 stream として進められる（US3 は US1 + US2 を待つ）
- Polish の T027/T028 は [P]

---

## Parallel Example: Foundational Phase

```bash
# Foundational 内の独立タスクを並行起動:
Task: "types.ts に EdgeProvenance 型と provenance フィールド追加"
Task: "types.ts に新規 warning type 追加"
Task: "markdown.ts に stripAnnotations 純粋関数を追加"
Task: "markdown.ts に extractAnnotations 純粋関数を追加"
Task: "stripAnnotations 単体テストを追加"
Task: "extractAnnotations 単体テストを追加"
Task: "tests/fixtures/req-req-annotations/ ディレクトリ scaffold"
```

## Parallel Example: User Story 1 vs User Story 4

```bash
# Developer A:
Task: "US1 fixture list-item.md 作成"
Task: "US1 markdown.test.ts に list-item 統合テスト追加"
Task: "US1 markdown.ts list-item ブロックに extractAnnotations 統合"

# Developer B (同時並行):
Task: "US4 fixture multi-id.md 作成"
Task: "US4 rename.test.ts に rewriteAnnotationIds テスト追加"
Task: "US4 rename.ts に rewriteAnnotationIds 実装"
```

---

## Implementation Strategy

### MVP First (US1 のみ)

1. Phase 1 → Phase 2 → Phase 3 (US1) を完了
2. **STOP and VALIDATE**: list-item 形式の注釈で req→req エッジが生成されることを quickstart Scenario 1 と 5 で確認
3. デプロイ可能（US1 単独で「注釈で依存を書ける」価値が成立）

### Incremental Delivery

1. Setup + Foundational → MVP 基盤
2. US1 完了 → デモ可能（list-item 形式のプロジェクトに即適用可能）
3. US2 完了 → Kiro 形式の heading req にも対応
4. US3 統合テスト完了 → drift 影響ゼロを正式保証
5. US4 完了 → 既存 rename ワークフローと統合
6. Polish 完了 → ドキュメント反映・回帰確認

### Parallel Team Strategy

- 1 名: Foundational → US1 → US3（順次）
- もう 1 名: Foundational 完了待ち → US2 を並行
- もう 1 名: Foundational 完了待ち → US4 を並行（parser と独立）
- US1 + US2 マージ後、US3 統合テストを実行
- 全マージ後、Polish

---

## Notes

- [P] = 異なるファイル、依存なしで並行可
- [Story] ラベルは traceability 用（PR 説明・コミットメッセージで参照）
- US 単位で independently testable / deployable
- T012/T013/T017/T018 は同一ファイル `parsers/markdown.ts` を触るため、競合回避のためシリアル実行
- 各タスク完了後 commit を推奨、checkpoint で `pnpm -F artgraph test` を実行
- Constitution 原則 I（決定的グラフ第一）の中核に触れるため、US3 のテストはマージブロッカー扱い
