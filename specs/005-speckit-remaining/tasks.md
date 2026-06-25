---
description: "Task list for Issue #28 (FR-009 / FR-010 / FR-012) — plan.md / tasks.md task ノード化 + タグエッジ抽出"
---

# Tasks: plan.md / tasks.md タスクノード化 + タグエッジ抽出 (Issue #28 / FR-009 / FR-010 / FR-012)

**Input**: Design documents under `specs/005-speckit-remaining/`

**Prerequisites**: [spec.md](./spec.md) (required, Clarifications Session 2026-06-24 反映済), [plan.md](./plan.md) (required), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: TDD（プロジェクト規約に従う） — 各 impl タスクの**前に** Red テストを置き、green を確認してから次へ進む。spec.md の Acceptance Scenarios はそのまま vitest シナリオに変換可能。

**Organization**: 本 PR で実装する outstanding なユーザストーリーは spec.md の **User Story 3 (FR-009 / FR-010)** のみ（US1=FR-007, US2=FR-008, US4=FR-011 は既に PR #27 で merged）。FR-012 は US3 を成立させる ための **規約プリセット** インフラで、独立したストーリーは作らず US3 内で扱う。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 別ファイルで先行依存なし、並列実行可
- **[Story]**: 該当する spec.md のユーザストーリー番号（US3=plan.md/tasks.md とコードの紐付き）
- 各タスクは絶対パス・相対パスを含む

## Path Conventions

- **CLI source**: `packages/artgraph/src/`
- **Tests**: `packages/artgraph/tests/`
- **Fixtures**: `packages/artgraph/tests/fixtures/tasks/`（本 Issue で新規作成）

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 新規 fixture ディレクトリの骨格作成。既存 monorepo 構造への追加変更なし。

- [ ] T001 [P] Create directory skeleton `packages/artgraph/tests/fixtures/tasks/` with `.gitkeep` — 本 Issue で追加する各規約別フィクスチャの親ディレクトリ。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: US3 のタスク実装が依存する **型定義 / config ロード / built-in プリセット** を先に整える。Phase 2 完了までは US3 の実装タスクを開始できない。

**⚠️ CRITICAL**: T002 は他全タスクの先行依存。T003 / T004 は T002 後に並列可。

- [ ] T002 Extend `packages/artgraph/src/types.ts`: (a) `NodeKind` union に `"task"` を追加（現行 5 NodeKind → 6 NodeKind、Constitution Principle II の 4 抽象層は不変 — [data-model.md §1](./data-model.md) 参照）、(b) `TaskConventionPreset` interface を新規追加（`name: string; fileStems: string[]; taskIdRe: string`）、(c) `ArtgraphConfig` に optional `taskConventions?: TaskConventionPreset[]` フィールドを追加。仕様: [data-model.md §1–§3](./data-model.md)

- [ ] T003 [P] Add `validateTaskConventions()` to `packages/artgraph/src/config.ts` and call it from `loadConfig`: 既存 `validateReqPatterns` (`config.ts:28`) と同じバリデーション規則（200 文字上限 / nested quantifier 拒否 / capture group 必須 / 重複 name 検出）を `TaskConventionPreset[]` に適用。エラーメッセージは [contracts/config-schema.md §検証ルール](./contracts/config-schema.md) のテーブルに準拠。

- [ ] T004 [P] Define `BUILTIN_TASK_PRESETS: TaskConventionPreset[]` constant at the top of `packages/artgraph/src/parsers/markdown.ts`: 2 件の builtin 定義（spec-kit: `["plan", "tasks"]` / `T\d+` 系、kiro: `["tasks"]` / 階層数字）。正規表現は [research.md §R1](./research.md) と [contracts/config-schema.md §既定値](./contracts/config-schema.md) の通り。

**Checkpoint**: types / config validation / builtin presets が揃い、Phase 3 で参照可能。

---

## Phase 3: User Story 3 — plan.md / tasks.md とコードの紐付き (Priority: P3) 🎯 本 PR の MVP

**Goal**: Spec Kit の plan.md / tasks.md および Kiro の tasks.md から task ノードを抽出し、`@impl(target)` から `implements` エッジ、`[REQ-xxx]` から `verifies` エッジを生成する。`.artgraph.json` の `taskConventions` で OpenSpec 等のカスタム規約を追加可能にする。

**Independent Test**: [quickstart.md](./quickstart.md) Scenario 1–6 を `pnpm exec artgraph scan --output json` で実行し、想定 nodes / edges が含まれていることを確認する。spec.md の Acceptance Scenarios（FR-009 #1–2, FR-010 #1）も vitest 統合テスト（後述 T012）でカバー。

### Tests for User Story 3 (TDD — RED phase)

**Fixtures**（並列可、全て新規ファイル）:

- [ ] T005 [P] [US3] Create `packages/artgraph/tests/fixtures/tasks/speckit-plan/specs/auth/plan.md` — Spec Kit `plan.md` フォーマット。`- [X] T001 implement login @impl(auth-login)` と `- [ ] T002 add session middleware @impl(auth-session)` を含む（FR-009 用）。

- [ ] T006 [P] [US3] Create `packages/artgraph/tests/fixtures/tasks/speckit-tasks/specs/auth/{spec.md,tasks.md}` — `tasks.md` 側に `- [X] T010 verify login [REQ-FR-001]` と `- [ ] T011 verify session [REQ-FR-002] [REQ-FR-003]`、`spec.md` 側に `- FR-001:` と `- FR-002:` の req 項目を含む（FR-010 用、target 解決ありとなしの両ケース）。

- [ ] T007 [P] [US3] Create `packages/artgraph/tests/fixtures/tasks/kiro-tasks/specs/billing/tasks.md` — Kiro 階層数字フォーマット。`- [X] 1 setup @impl(billing-init)`、`  - [X] 1.1 stripe @impl(stripe-client)`、`  - [ ] 1.2 webhook [REQ-BIL-001]`、`- [ ] 2 invoice [REQ-BIL-002]` を含む（FR-012 Kiro 検証）。

- [ ] T008 [P] [US3] Create `packages/artgraph/tests/fixtures/tasks/openspec-custom/{.artgraph.json,specs/demo/tasks.md}` — `.artgraph.json` にカスタムプリセット `{name: "openspec", fileStems: ["tasks"], taskIdRe: "^(?:\\[[xX ]\\]\\s+)?(OS-\\d+)"}` を定義し、`tasks.md` に `- [X] OS-100 OpenSpec task @impl(openspec-target)` を含む（FR-012 拡張性検証）。

- [ ] T009 [P] [US3] Create `packages/artgraph/tests/fixtures/tasks/namespace-collision/specs/{auth,export}/plan.md` — 両 specDir に `- [X] T001 @impl(...)` を配置（衝突解決検証、`builder.ts` の既存 ID 修飾ロジックが task にも作用することを確認）。

**Test files**（同一ファイルへの追加は順次、別ファイルは並列可。T010 / T011 / T012 は同じ `markdown.test.ts` に書くため順次。T013 / T014 は別ファイルで並列可）:

- [ ] T010 [US3] Add **spec-kit task extraction** tests in `packages/artgraph/tests/parsers/markdown.test.ts`: T005 / T006 fixture を読み込み、(a) `T001`/`T002` 等の task ノードが `kind: "task"` で生成される、(b) plan.md の `@impl(auth-login)` から `task → implements → auth-login` エッジが生成される（target は trim のみ）、(c) tasks.md の `[REQ-FR-001]` から `task → verifies → REQ-FR-001` エッジが生成される（prefix 維持） — 3 ケース。

- [ ] T011 [US3] Add **kiro hierarchical task extraction** tests in `packages/artgraph/tests/parsers/markdown.test.ts`: T007 fixture を読み込み、(a) 階層数字 `1` / `1.1` / `1.2` / `2` がそれぞれ独立した `task` ノードとして抽出される（id にドットを含むことを許容）、(b) ネスト下のタスクからも `@impl(...)` / `[REQ-...]` エッジが生成される — 2 ケース。同一ファイル更新のため T010 完了後に順次着手。

- [ ] T012 [US3] Add **cross-cutting tag behavior** tests in `packages/artgraph/tests/parsers/markdown.test.ts`: fixture を 1〜2 件選んで（または専用 inline fixture で）、(a) チェックボックス `[X]` / `[x]` / `[ ]` の 3 バリアントすべてを許容する、(b) 1 タスクに `[REQ-FR-002] [REQ-FR-003]` の複数 `[REQ-]` がある場合に複数 `verifies` エッジが生成される、(c) `@impl()` 空内容は edge 生成スキップ（warning なし）、(d) FR-009 / FR-010 の対称認識: plan.md 内の `[REQ-]` および tasks.md 内の `@impl(...)` も両方とも対応エッジを生成する（U1 clarification） — 4 ケース。

- [ ] T013 [P] [US3] Add `taskConventions` validation tests in `packages/artgraph/tests/config.test.ts`: 不正 regex / nested quantifier / 200 文字超過 / capture group ゼロ / 空 `fileStems` / builtin 重複 name の各ケースで `loadConfig` が明示エラーを throw することを assert（[contracts/config-schema.md §検証ルール](./contracts/config-schema.md) の表に 1:1 対応）。

- [ ] T014 [P] [US3] Add builder integration tests in `packages/artgraph/tests/builder.test.ts`: T008/T009 fixture を読み込み、(a) `doc → task` の `contains` エッジが `autoContains` 有効時に生成される、(b) `T001` が両 specDir に存在する場合 `auth/T001` と `export/T001` に修飾される、(c) ユーザ定義プリセット `openspec` で `OS-100` 抽出が成功する、(d) mixed-tool ディレクトリ (`spec-kit` と `kiro` の preset が両方適用される) で edge dedup が正しく機能する — 全 4 ケース。

- [ ] T014.5 [P] [US3] **NFR-004 fixture inventory check**: Run `grep -RnE '^(\s*-\s*\[[xX ]\]\s+)?(T\d+|\d+\.\d+)' packages/artgraph/tests/fixtures/conventions/specs/ packages/artgraph/tests/fixtures/specs/` on the current branch and **assert zero matches**. If any match is found, that fixture would generate unintended `task` nodes once builtin presets活性化 → NFR-004 違反。マッチした場合は (a) 当該 fixture を別 specDir に隔離する、(b) または builtin プリセットの `fileStems` を見直す。結果（一致件数 / 該当ファイル）を PR T030 本文に貼付。[research.md §R2 Inventory](./research.md) と整合。

- [ ] T015 [US3] Run `pnpm --filter artgraph test` and verify ALL Phase 3 tests (T010–T014) **FAIL** with expected error messages（type 未追加・builder 未拡張のため）。RED state を確認してから T016 以降に進む。

### Implementation for User Story 3 (TDD — GREEN phase)

**Parser changes** (`packages/artgraph/src/parsers/markdown.ts` — 同一ファイル、順次):

- [ ] T016 [US3] Implement task extraction in `parseMarkdown` (`packages/artgraph/src/parsers/markdown.ts`): (a) `basename(filePath)` から file-stem を取得（拡張子・大文字小文字除去）、(b) `BUILTIN_TASK_PRESETS` と `options?.taskConventions` を結合した配列を回し、`fileStems.includes(stem)` を満たす preset の `taskIdRe` を `listItem` 内 paragraph の `toString()` 結果に対して試行、(c) 最初にマッチした preset の capture group 1 を task ID として `nodes.push({ id, kind: "task", filePath, label, contentHash })`。contentHash は task 行 1 行の hash（[research.md §R6](./research.md)）。

- [ ] T017 [US3] Implement tag extraction in same `listItem` loop of `parseMarkdown` (`packages/artgraph/src/parsers/markdown.ts`): task ノードが生成されたタスク項目に対し、(a) `/@impl\(([^)]+)\)/g` で全マッチを取り `target = match[1].trim()` で空でなければ `edges.push({source: taskId, target, kind: "implements"})`、(b) 既存 `testReqRe`（`typescript.ts:33` の `NAMESPACED_ID_TOKEN` bracket）と同じ regex で全マッチを取り `target = match[0].slice(1, -1)` で `edges.push({source: taskId, target, kind: "verifies"})`。複数タグ可。U1 clarification により plan.md / tasks.md など preset 適用ファイル全てで両タグを認識する。

**Builder changes** (`packages/artgraph/src/graph/builder.ts` — 同一ファイル、順次):

- [ ] T018 [US3] Extend collision resolution + propagation in `packages/artgraph/src/graph/builder.ts`: (a) Pass 1 の `if (node.kind === "req")` 分岐を `if (node.kind === "req" || node.kind === "task")` に拡張し、`collected` に task ノードも積む（builder.ts:97-109 周辺）、(b) Pass 2 の qualified ID 生成と `nodes.set(finalId, ...)` ロジックは既存ループに乗る、(c) `parseMarkdown(file, { rootDir, specDirPrefix: specDirName, reqPatterns: config.reqPatterns, taskConventions: config.taskConventions })` に `taskConventions` を追加（builder.ts:82）。

- [ ] T019 [US3] Extend `contains` edge generation in `packages/artgraph/src/graph/builder.ts:246-258`: `reqNode.kind === "req"` を `reqNode.kind === "req" || reqNode.kind === "task"` に拡張し、doc から同ファイル内の task ノードへも `contains` エッジが張られるようにする（[research.md §R5](./research.md) / [data-model.md §6](./data-model.md)）。

**Peripheral updates** (異なるファイル、並列可):

- [ ] T020 [P] [US3] Update `packages/artgraph/src/scan.ts`: `ScanSummary` interface に `taskCount: number` を追加し、`switch (node.kind)` に `case "task": taskCount++; break;` を追加。集計と return value 両方更新（scan.ts:11, scan.ts:29, scan.ts:53）。

- [ ] T021 [P] [US3] Verify `packages/artgraph/src/graph/format.ts` against NodeKind="task": (a) `pnpm --filter artgraph build` を実行し、`NodeKind` union 拡張で `format.ts` の switch/exhaustive 判定が **コンパイルエラーを出さない** ことを確認、(b) コンパイル通過なら no-op、(c) 通過しなければ `task` ケースを既存ルール（`node.kind` 直接出力）に合わせて追加。Acceptance criterion: `pnpm build` exit 0 + `formatGraphJSON` で task ノードが `"kind": "task"` でシリアライズされる ad-hoc smoke を 1 件追加（[data-model.md §7](./data-model.md) `~5 行` 想定）。

- [ ] T022 [P] [US3] Verify `packages/artgraph/src/graph/traverse.ts`: [data-model.md §7](./data-model.md) と [spec.md Clarifications U2](./spec.md#clarifications) で **task は lock 連動対象外** と確定済。Acceptance criterion: `traverse.ts:69` 付近の `kind === "req" \|\| kind === "doc"` 判定を **変更しない** (task を追加しない) ことを確認し、それでも task ノードが impact/depends_on/derives_from の経路として正常に traverse されることを `tests/traverse.test.ts` (存在すれば) または手動 smoke で確認。差分 0 行が想定挙動。

- [ ] T023 [US3] Run `pnpm --filter artgraph test` and verify ALL 565 existing tests + new Phase 3 tests **PASS** (GREEN state). 1 件でも regression があれば T016-T022 のいずれかに戻る。

**Checkpoint**: User Story 3 (FR-009 / FR-010 / FR-012) が完全実装され、independently testable (T023 GREEN 確認まで)。MVP として本 PR は **このチェックポイントで demo / review に出せる**。

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: ドキュメント / 後方互換通知 / 動作確認。

- [ ] T024 [P] Run quickstart.md Scenarios 1–6 manually against the built CLI: `pnpm --filter artgraph build` 後、[quickstart.md](./quickstart.md) の手順を一通り実行し、各 Pass criteria が満たされることを確認する。スクリーンショット or 出力 log を PR コメントに添付。

- [ ] T025 [P] Update `packages/artgraph/README.md` (or root README.md) with a brief "Task graph" section noting: (a) task NodeKind の追加、(b) `@impl(...)` / `[REQ-]` タグの md ファイルでの認識（U1 clarification: plan.md / tasks.md 両方で両タグ認識）、(c) `.artgraph.json` の `taskConventions` でカスタムプリセット追加可能、(d) 既存プロジェクトでは tasks.md の T### が自動で task ノード化される旨。Existing C-3 / inline link 章と同じトーン・粒度で 10–30 行。

- [ ] T026 [P] Add CHANGELOG entry in `packages/artgraph/CHANGELOG.md`（存在しなければ新規作成、または PR description で代替）: "feat: introduce `task` NodeKind and extract `@impl(...)` / `[REQ-]` tags from plan.md / tasks.md (Spec Kit / Kiro presets, `.artgraph.json` `taskConventions` for OpenSpec etc.). Existing projects with task IDs in their `tasks.md` will see new task nodes on next `artgraph scan` — run `artgraph reconcile` to update lock baseline." — [data-model.md §8](./data-model.md) の後方互換性メモを反映。

- [ ] T027 [P] Update `specs/005-speckit-remaining/checklists/requirements.md`: 本 Issue で実装される FR-009 / FR-010 関連の項目に加え、Type Definitions（`task` NodeKind 追加）、Integration Points（`taskConventions` config 連携）等が満たされた項目を `[x]` にチェック更新（実装完了確認後）。

- [ ] T028 [P] Run NFR-002 ベンチマーク (spec.md NFR-002 計測方法に従う): `main` (`a6176c1`) と本ブランチで `packages/artgraph/tests/fixtures/specs/` 配下を `buildGraph(rootDir, DEFAULT_CONFIG)` で 10 回実行し中央値を比較、結果を PR 本文へ貼付。5% 未満であることを確認（ガイド、ブロッカーではない）。

- [ ] T029 Run `pnpm --filter artgraph knip` and `pnpm --filter artgraph build` — 未使用 export 検出ゼロ・ビルドエラーゼロを確認。Constitution 「**oxlint / knip / oxfmt が CI / pre-commit で実行可能であることを維持**」(L119-120) に準拠。

- [ ] T030 Open PR with title "feat(graph): plan.md / tasks.md タスクノード化 + タグエッジ抽出 (#28)" referencing Issue #28. PR body must explicitly include:
  - Constitution Check 結果（Principle II は plan.md Complexity Tracking で justify 済。Principle II は NON-NEGOTIABLE ではないため累積カウンタ等の追加 ceremony は不要）
  - quickstart 検証結果（T024 のログ／スクリーンショット）
  - NFR-002 ベンチ結果（T028）
  - 後方互換性メモ（既存プロジェクトの `tasks.md` の T### が auto-node 化される旨）
  - Kiro 形式の確認依頼（[research.md §R1](./research.md) Open Items）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 即時開始可（T001 は単独ファイル作成）。
- **Phase 2 (Foundational)**: Phase 1 完了後。T002 が他の T003 / T004 をブロック。
- **Phase 3 (US3)**: Phase 2 完了後。Fixtures (T005–T009) は並列、Tests T010–T012 は同一ファイル (markdown.test.ts) のため順次、T013 / T014 は別ファイルで並列。Implementation は parser → builder → peripheral の順。
- **Phase 4 (Polish)**: Phase 3 の T023 (GREEN 確認) 完了後。

### User Story 3 Internal Dependencies

```
T001 (fixture dir)
  └─> T002 (types)
        ├─> T003 (config validation)         [P with T004]
        ├─> T004 (builtin presets)           [P with T003]
        │
        ├─> T005, T006, T007, T008, T009 (fixtures, all [P])
        ├─> T010 (markdown tests: spec-kit, depends T002+T004+T005+T006)
        │     └─> T011 (markdown tests: kiro, same file)
        │           └─> T012 (markdown tests: cross-cutting, same file)
        ├─> T013 (config tests, depends T002+T003)  [P with T010-T012]
        ├─> T014 (builder tests, depends T002+T004+T008+T009)  [P with T010-T013]
        │
        └─> T015 (verify RED)
              └─> T016 (parser impl: task extraction)
                    └─> T017 (parser impl: tag extraction, same file)
                          └─> T018 (builder impl: collision + propagation)
                                └─> T019 (builder impl: contains, same file)
                                      ├─> T020 (scan.ts) [P]
                                      ├─> T021 (format.ts) [P]
                                      ├─> T022 (traverse.ts) [P]
                                      └─> T023 (verify GREEN)
                                            └─> T024–T030 (polish, mostly [P])
```

### Within Each User Story

- Fixtures は実装より先（T010–T014 のテストが fixture を読む）
- Tests は実装より先（TDD RED 状態を T015 で確認）
- 同一ファイル更新は順次（T010 → T011 → T012 は markdown.test.ts、T016 ↔ T017 は markdown.ts、T018 ↔ T019 は builder.ts）
- 異なるファイル更新は並列可（T020 / T021 / T022）

### Parallel Opportunities

- T003 + T004 並列実行可（T002 完了後）
- T005 / T006 / T007 / T008 / T009 並列実行可（T002 完了後、5 件 fixture 同時作成）
- T010-T012 (markdown.test.ts) は順次。一方 T013 (config.test.ts) と T014 (builder.test.ts) は T010-T012 と並列可（別ファイル）
- T020 / T021 / T022 並列実行可（T019 完了後、3 件の小修正並列）
- T024 / T025 / T026 / T027 / T028 並列実行可（T023 完了後）

---

## Parallel Example: User Story 3 Fixtures + Tests

```bash
# Phase 3 開始時、T002–T004 完了後に並列で fixture 作成:
Task: "T005 Create fixture packages/artgraph/tests/fixtures/tasks/speckit-plan/specs/auth/plan.md"
Task: "T006 Create fixture packages/artgraph/tests/fixtures/tasks/speckit-tasks/specs/auth/{spec.md,tasks.md}"
Task: "T007 Create fixture packages/artgraph/tests/fixtures/tasks/kiro-tasks/specs/billing/tasks.md"
Task: "T008 Create fixture packages/artgraph/tests/fixtures/tasks/openspec-custom/{.artgraph.json,specs/demo/tasks.md}"
Task: "T009 Create fixture packages/artgraph/tests/fixtures/tasks/namespace-collision/specs/{auth,export}/plan.md"

# Fixtures 完了後、テストを書く（同一ファイルは順次、別ファイルは並列）:
# markdown.test.ts は順次:
Task (sequential): "T010 → T011 → T012 in packages/artgraph/tests/parsers/markdown.test.ts"
# 別ファイルは並列:
Task (parallel):   "T013 Add taskConventions validation tests in packages/artgraph/tests/config.test.ts"
Task (parallel):   "T014 Add builder integration tests in packages/artgraph/tests/builder.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 3 のみ)

本 PR では **User Story 3 のみ** が outstanding なため、これが MVP となる。

1. Phase 1 (Setup) — T001 のみ
2. Phase 2 (Foundational) — T002 → (T003 ∥ T004)
3. Phase 3 (US3) — fixture → RED テスト → 実装 → GREEN
4. **STOP and VALIDATE**: T023 で 565 + 新規テスト全 PASS / T024 で quickstart 全 scenario PASS
5. Phase 4 (Polish) — README / CHANGELOG / ベンチマーク / PR

### Incremental within US3

T015 (RED 確認) 後の実装は、parser → builder → peripheral の順で、各段階で `pnpm test` 部分実行して回帰確認しながら進める:
- T016 完了 → markdown.test.ts の task 抽出系テスト (T010–T011) が green
- T017 完了 → markdown.test.ts の @impl / [REQ-] 系テスト (T012) が green
- T018 + T019 完了 → builder.test.ts の collision / contains テスト (T014) が green
- T020–T022 完了 → 全テスト green、knip / build 通過

### Parallel Team Strategy

1 人でも実装可能（~150 行 + テスト 250 行規模）。複数人なら:
- Dev A: Phase 2 (T002–T004) + Parser 実装 (T016, T017)
- Dev B: Fixtures (T005–T009) + Tests (T010–T014)
- Dev C: Builder 実装 (T018, T019) + Peripheral (T020–T022)
- Final: 全員で T023 / Phase 4 をレビュー

---

## Notes

- [P] tasks = 別ファイル・先行依存なし
- [US3] label は spec.md の User Story 3 にマップ（spec.md US1/2/4 は実装済のため本 PR には含まれない）
- RED → GREEN のサイクル厳守。T015 / T023 を省略しない。
- Constitution Principle II (`task` NodeKind 追加) の justify は [plan.md Complexity Tracking](./plan.md) に記載済、ガードレール方針は spec.md Clarifications CV1 で明記 — PR 説明でも引用する。
- 後方互換: 既存プロジェクトの `tasks.md` に T### が記載されていれば自動的に task ノード化される。`.trace.lock` baseline 更新は `artgraph reconcile` で行う旨を T026 の CHANGELOG に明記。
- Kiro 形式は本リポジトリに実 fixture がないため公開テンプレートからの推定。T007 fixture と T011 テストはこの推定形式（[research.md §R1](./research.md)）に基づく。PR レビューで実 Kiro ユーザに確認する。
