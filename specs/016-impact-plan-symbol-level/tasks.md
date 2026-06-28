---

description: "Tasks for spec 016 — impact / plan-coverage の symbol-level 入力対応 (file:symbol syntax)"
---

# Tasks: impact / plan-coverage の symbol-level 入力対応 (file:symbol syntax)

**Input**: Design documents from `/specs/016-impact-plan-symbol-level/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/sdd-files-parser.md, contracts/cli-flags.md, contracts/plan-coverage-json.md, quickstart.md

**Premise**: artgraph は **未リリース**。本 spec は spec 014 の型 / 関数 / JSON schema を **後方互換を考慮せず clean に置き換える**。「旧 field との併走」「移行用 alias」「v1/v2 並走」は採用しない。テスト・fixture も本 spec の最終形に対して書き直す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可 (異なる file、未完了タスクへの依存なし)
- **[Story]**: US1 / US2 / US3 / US4 に対応 (Foundational / Polish にはラベルなし)
- 各タスクの `Files:` セクションは **本 spec で実際に編集・追加する path**。dogfood 用に `path:symbol` syntax を併用する。

## 二軸出力 (本 spec の中核価値)

- **`impactReqs`** = startId からの forward BFS で到達した REQ 集合 (spec 014 の `reqs` を rename + 意味確定)
- **`originReqs`** = startId ノード (file or symbol) の `@impl` claim を `implements` edge で **1-hop** 辿った REQ 集合
- JSON consumer は `impactReqs \ originReqs` をクライアント側で計算し、ドリフト候補を検知する (SC-003 / SC-006)

---

## Phase 1: Setup

**Purpose**: 既存ブランチ上の clean redesign — 新 dep 追加なし、新ディレクトリ作成なし。準備のみ。

- [ ] T001 ブランチ `feat/impact-plan-symbol-level` 上で `pnpm install` / `pnpm build` を実行し、現状 green を確認
  Files: package.json, pnpm-lock.yaml

- [ ] T002 spec 014 由来の既存実装を clean redesign 対象として確認 (`extractFiles` / `resolveFileStartIds` / `ImpactGroup` 旧 shape の所在を `git grep` で押さえる)
  Files: src/parsers/sdd-files.ts:extractFiles, src/graph/traverse.ts:resolveFileStartIds, src/plan-coverage/index.ts:ImpactGroup

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全 user story が共有する型・関数・fixture の clean 再宣言。本 phase 完了まで US1 / US2 / US3 の実装に着手しない。

**CRITICAL**: 本 phase は data-model.md §1〜§2 と research R-001 / R-002 / R-003 / R-004 / R-006 の決定を実装に落とす段。

### 型再宣言 (data-model.md §1, §3.1, §3.5)

- [ ] T003 [P] `SymbolEntry { path: string; symbol?: string; line: number }` を export として宣言 (FR-001)
  Files: src/parsers/sdd-files.ts:SymbolEntry

- [ ] T004 [P] `Diagnostic` union に `{ kind: "unresolvedSymbol"; sourceFile; symbol; line }` を追加 (FR-004, INV-S1)
  Files: src/parsers/sdd-files.ts:Diagnostic

- [ ] T005 `ExtractResult` を `{ entries: SymbolEntry[]; stage; diagnostics; taskBlocks? }` に再宣言し、`files: string[]` フィールドを削除 (FR-007, R-001)
  Files: src/parsers/sdd-files.ts:ExtractResult

- [ ] T006 [P] `ImpactResult` に `originReqs: string[]` を追加 (INV-S6, INV-S7)
  Files: src/types.ts:ImpactResult

- [ ] T007 [P] `ReqEntry { reqId: string; kind: "req" }` を plan-coverage 公開型として宣言 (data-model.md §3.1)
  Files: src/plan-coverage/index.ts:ReqEntry

### parser Stage A 実装 (contracts/sdd-files-parser.md §1, §2)

- [ ] T008 `PATH_SYMBOL_RE = /^([^:\s]+\.[\w]+):([^\s,()]+)$/` を Stage A entry 抽出ループに組み込み、annotation 剥がし後に評価して `SymbolEntry` を生成 (FR-001, FR-002, FR-003, FR-005, R-003)
  Files: src/parsers/sdd-files.ts:extractFiles

- [ ] T009 Stage A 抽出後に `path` 存在検証 → OK のとき `symbol:<path>#<name>` graph node lookup を実施し、`unresolvedFilePath` / `unresolvedSymbol` を per-entry 排他で発出 (FR-004, INV-S1, contracts/sdd-files-parser.md §2.1)
  Files: src/parsers/sdd-files.ts:extractFiles

- [ ] T010 Stage B (regex fallback) では symbol 検出を行わず `symbol: undefined` で `SymbolEntry` を返す (FR-006)
  Files: src/parsers/sdd-files.ts:extractFiles

### graph 解決 (data-model.md §2)

- [ ] T011 `resolveFileStartIds` を **削除** し、`resolveStartIds(graph, entries: SymbolEntry[]): { startIds: string[]; unresolvedSymbols: SymbolEntry[] }` を新規実装 (R-004, INV-S2)
  Files: src/graph/traverse.ts:resolveStartIds, src/graph/traverse.ts:resolveFileStartIds

- [ ] T012 [P] `resolveOriginReqs(graph, startIds: string[]): string[]` (= 各 startId から `implements` edge を 1-hop、target が REQ ノードのものを dedup + reqId 昇順 sort) を追加 (FR-014, FR-017, INV-S5, INV-S6, R-006)
  Files: src/graph/traverse.ts:resolveOriginReqs

- [ ] T013 `impact()` 本体 (forward BFS) は変更しないことをコメントで明示 (data-model.md §2.3, plan.md "Constraints")
  Files: src/graph/traverse.ts:impact

### fixture セットアップ (quickstart.md Scenario A 前提)

- [ ] T014 [P] `tests/fixtures/symbol-mode/` を新規作成: `src/auth.ts` に 3 export (`validateToken @impl REQ-001`, `issueToken @impl REQ-005`, `revokeToken @impl REQ-009`)、`specs/001-symbol-demo/spec.md` / `tasks.md`、`.artgraph.json (mode: symbol)` を含める (SC-001, SC-006 のベース)
  Files: tests/fixtures/symbol-mode/src/auth.ts, tests/fixtures/symbol-mode/specs/001-symbol-demo/spec.md, tests/fixtures/symbol-mode/specs/001-symbol-demo/tasks.md, tests/fixtures/symbol-mode/.artgraph.json

### parser / traverse unit テスト

- [ ] T015 [P] `tests/sdd-files-parser.test.ts` を `entries[]` ベースに書き直し、contracts/sdd-files-parser.md §3 のケース 1〜8 を追加 (FR-001..FR-007, INV-S1)
  Files: tests/sdd-files-parser.test.ts

- [ ] T016 [P] `tests/traverse.test.ts` に `resolveStartIds` の単体テスト (file + symbol 混在、unresolved 累積、入力順保持) と `resolveOriginReqs` の単体テスト (`@impl` 1-hop、空配列ケース、dedup + sort) を追加 (INV-S2, INV-S5, INV-S6)
  Files: tests/traverse.test.ts

**Checkpoint**: Foundational 完了 — US1 / US2 / US3 の実装を並列で着手可能。

---

## Phase 3: User Story 1 — symbol 単位の過剰検知抑制 + 由来 FR の併走表示 (Priority: P1) 🎯 MVP

**Goal**: tasks.md に `Files: src/auth.ts:validateToken` と書くと、`plan-coverage` の implicit REQ が `validateToken` 起点の forward 波及のみに絞られ、同 file の他 symbol (`issueToken` / `revokeToken`) 経由の REQ-005 / REQ-009 が排除される。各 ImpactGroup には `impactReqs` と `originReqs` の二軸が populate され、consumer が `impactReqs \ originReqs` でドリフトを検知できる。

**Independent Test**: `tests/fixtures/symbol-mode/` 上で `Files: src/auth.ts:validateToken` のみを書いた tasks.md に対し `artgraph plan-coverage --format json` を実行 →
- `implicitImpactsByReq[].reqId` に `REQ-001` のみが含まれる (REQ-005 / REQ-009 は含まれない)
- `implicitImpacts[0] = { sourceFile: "src/auth.ts", sourceSymbol: "validateToken", impactReqs: [{reqId:"REQ-001",kind:"req"}], originReqs: [{reqId:"REQ-001",kind:"req"}] }`

### Implementation for User Story 1

- [ ] T017 [US1] `extractFiles` の戻り値 `ExtractResult.entries` を `resolveStartIds()` に直接渡す経路に変更 (file unit / symbol unit の混在を 1 配列で扱う)
  Files: src/plan-coverage/index.ts:runPlanCoverage

- [ ] T018 [US1] ImpactGroup populate を `(sourceFile, sourceSymbol ?? null)` の複合 dedup キーに変更し、各 group の `originReqs` を `resolveOriginReqs([startId])` から populate (FR-016, FR-017, FR-018, FR-019, INV-S3, INV-S5)
  Files: src/plan-coverage/index.ts:ImpactGroup, src/plan-coverage/index.ts:runPlanCoverage

- [ ] T019 [US1] `implicitImpactsByReq[]` aggregator を `sourceLocations: Array<{file, symbol?}>` 形に置き換え、INV-S4 の sort 順 (file ascending → 同 file 内で symbol ascending、undefined を先頭) を実装 (FR-020, INV-S4)
  Files: src/plan-coverage/index.ts:ImplicitImpactByReq, src/plan-coverage/index.ts:aggregateByReq

- [ ] T020 [US1] `unresolvedSymbol` を `PlanCoverageDiagnostic` 経由で `diagnostics[]` に流し込み、当該 entry を `implicitImpacts` から除外 (FR-021, contracts/plan-coverage-json.md §4.2)
  Files: src/plan-coverage/index.ts:PlanCoverageDiagnostic, src/plan-coverage/index.ts:runPlanCoverage

- [ ] T021 [US1] `--ignore REQ-XXX` の filter を `impactReqs` / `originReqs` の両方に適用 (FR-022)
  Files: src/plan-coverage/index.ts:applyIgnore

- [ ] T022 [US1] text formatter で symbol 起点を `src/auth.ts#validateToken` 表記、`impactReqs:` / `originReqs:` を別セクションで併記、空セクションは `(none)` 表示 (FR-023, contracts/plan-coverage-json.md §7)
  Files: src/plan-coverage/index.ts:formatText

### Tests for User Story 1

- [ ] T023 [P] [US1] `tests/plan-coverage.test.ts` に contracts/plan-coverage-json.md §8 のケース 1〜9 を追加 (symbol 単独 / file unit / 1 file 多 symbol / unresolvedSymbol / file+symbol 混在 / `--gate` + diagnostic / sort 順検証 / SC-006 ドリフト検知)
  Files: tests/plan-coverage.test.ts
  Additional Acceptance Cases:
  - US1 AS#3: `Files: src/auth.ts:validateToken, src/session.ts:createSession` で 2 つの ImpactGroup が並び、それぞれ独立した `impactReqs` / `originReqs` を保持(cross-file symbol 混在)。

- [ ] T024 [P] [US1] `tests/plan-coverage-integration.test.ts` で fixture `tests/fixtures/symbol-mode/` を使った E2E: `Files: src/auth.ts:validateToken` vs `Files: src/auth.ts` の implicit REQ 数比較 (3 → 1 の 50% 以上削減、SC-001)
  Files: tests/plan-coverage-integration.test.ts

- [ ] T025 [US1] spec.md 後追いで `REQ-001 depends_on REQ-007` を追加した fixture state を作り、`impactReqs = [REQ-001, REQ-007]` / `originReqs = [REQ-001]` / `impactReqs \ originReqs = [REQ-007]` が JSON consumer で計算可能なことを test (SC-006)
  Files: tests/fixtures/symbol-mode/specs/001-symbol-demo/spec.md, tests/plan-coverage-integration.test.ts

**Checkpoint**: User Story 1 が独立に動作し、symbol 過剰検知が抑制され、二軸 JSON でドリフトが検知できる。MVP として release 可能。

---

## Phase 4: User Story 2 — `artgraph impact` の symbol 直接入力 + 二軸出力 (Priority: P1)

**Goal**: `artgraph impact src/auth.ts:validateToken` を CLI 直接入力として受理し、`impactReqs` (forward BFS) と `originReqs` (start ids の `@impl` claim 集合の union) の二軸を JSON / text の両方で返す。text では `impactReqs \ originReqs` を `Drift candidates:` セクションで表示。

**Independent Test**: fixture `tests/fixtures/symbol-mode/` で `artgraph impact src/auth.ts:validateToken --format json` → exit 0、JSON に `impactReqs` と `originReqs` が両方含まれる。`artgraph impact src/auth.ts:doesNotExist` → exit 1、stderr に "No matching symbol found"。

### Implementation for User Story 2

- [ ] T026 [US2] 引数バリデーション順を contracts/cli-flags.md §2 に準拠: REQ-ID rejection → doc: prefix rejection → mutually exclusive source → symbol syntax detection (FR-012)
  Files: src/cli.ts:impactCommand

- [ ] T027 [US2] direct 入力 (`targets[]`) を `PATH_SYMBOL_RE` で評価し、マッチを `SymbolEntry { path, symbol, line: 0 }` に、非マッチを `{ path, line: 0 }` に lift して `resolveStartIds()` に渡す (FR-008)
  Files: src/cli.ts:impactCommand

- [ ] T028 [US2] `--from-tasks` / `--from-plan` から得た `ExtractResult.entries` をそのまま `resolveStartIds()` に渡す経路を整備 (FR-010)
  Files: src/cli.ts:impactCommand

- [ ] T029 [US2] graph に `kind: "symbol"` ノードが 1 つも無い場合のグローバル error ("symbol-level input requires `artgraph scan --mode symbol`") を symbol 入力検出時のみ発出 (FR-009, FR-013, contracts/cli-flags.md §4.2)
  Files: src/cli.ts:impactCommand

- [ ] T030 [US2] per-entry "No matching symbol found for: <path>:<symbol>" を `unresolvedSymbols[]` ベースで stderr に発出して exit 1 (FR-011, contracts/cli-flags.md §4.1)
  Files: src/cli.ts:impactCommand

- [ ] T031 [US2] `impact()` 戻り値に `resolveOriginReqs(graph, startIds)` を結合して `ImpactResult.originReqs` を populate (FR-014, INV-S6)
  Files: src/cli.ts:impactCommand

- [ ] T032 [US2] text formatter に `Origin REQs:` セクションと `Drift candidates:` セクション (`impactReqs \ originReqs`、空集合ならセクション省略) を追加 (FR-015, FR-023, contracts/cli-flags.md §5.2)
  Files: src/cli.ts:formatImpactText

### Tests for User Story 2

- [ ] T033 [P] [US2] `tests/impact-cli.test.ts` に contracts/cli-flags.md §6 のケース 1〜8 を追加 (symbol 単独 / unresolved symbol / scan-mode mismatch / REQ-ID + symbol 併用 / `--from-tasks` 経由 / file+symbol 混在 / depends_on でドリフト出現 / `Drift candidates` セクション省略)
  Files: tests/impact-cli.test.ts
  Additional Acceptance Cases:
  - US2 AS#7: `artgraph impact src/auth.ts:validateToken src/session.ts:createSession` 複数 symbol 同時入力で、`impactReqs` が 2 symbol BFS の union、`originReqs` が 2 symbol の `@impl` claim の union を返すこと。

- [ ] T034 [P] [US2] `artgraph impact src/auth.ts:validateToken` を fixture 上で実行し 2 秒以内に exit 0 を確認 (SC-002)
  Files: tests/impact-cli.test.ts

**Checkpoint**: User Story 1 と 2 がそれぞれ独立に動作。CLI が direct symbol 入力 + 二軸出力を返せる。

---

## Phase 5: User Story 3 — `plan-coverage` 出力スキーマの二軸 + symbol 情報 (Priority: P1)

**Goal**: `plan-coverage --format json` の出力 JSON schema を clean に再設計し、(a) `implicitImpacts[].impactReqs` / `originReqs` 二軸、(b) `implicitImpacts[].sourceSymbol?`、(c) `implicitImpactsByReq[].sourceLocations` を機械可読に保持する。spec 014 の `reqs` / `sourceFiles` フィールドは出力に **存在しない**。

**Independent Test**: 1 file 多 symbol fixture (`Files: src/auth.ts:validateToken, src/auth.ts:issueToken`) で JSON 出力 → `implicitImpacts` に 2 entry (sourceFile 同じ、sourceSymbol 異なる)、各 entry の `originReqs` がそれぞれの `@impl` claim と一致。file unit `Files: src/auth.ts` では `sourceSymbol` キー自体が JSON 出力に **存在しない**。

### Schema 強制テスト (Phase 2 + Phase 3 の型実装を contract レベルで pin する)

- [ ] T035 [P] [US3] JSON schema contract test: `reqs` key の **不在**、`impactReqs` / `originReqs` の **両必須** を pin (contracts/plan-coverage-json.md §2)
  Files: tests/plan-coverage.test.ts

- [ ] T036 [P] [US3] JSON schema contract test: `sourceFiles` key の **不在**、`sourceLocations` の必須形 (`Array<{file: string; symbol?: string}>`) と sort 順 (INV-S4) を pin (FR-020, contracts/plan-coverage-json.md §3)
  Files: tests/plan-coverage.test.ts

- [ ] T037 [P] [US3] JSON schema contract test: file unit entry で `sourceSymbol` JSON key が **省略** されること、file-top `@impl` タグ無しで `originReqs: []` (空配列) が populate されること (contracts/plan-coverage-json.md §2.1)
  Files: tests/plan-coverage.test.ts

- [ ] T038 [P] [US3] JSON schema contract test: `diagnostics[].kind === "unresolvedSymbol"` の field 形 (`sourceFile` / `symbol` / `line`) と、`unresolvedFilePath` との per-entry 排他を pin (FR-021, contracts/plan-coverage-json.md §4.1)
  Files: tests/plan-coverage.test.ts

- [ ] T039 [P] [US3] 1 file 多 symbol (`Files: src/auth.ts:validateToken, src/auth.ts:issueToken`) で `implicitImpacts` が 2 entry になり、各 entry の `originReqs` がそれぞれの `@impl` claim と一致することを test
  Files: tests/plan-coverage-integration.test.ts

**Checkpoint**: User Story 1 / 2 / 3 が lockstep で完成。出力 JSON は機械可読な二軸 + symbol 情報を持ち、Skill / エージェントが drift 検知のロジックを組める。

---

## Phase 6: User Story 4 — Skill / ドキュメントでの symbol mode + 二軸ガイダンス (Priority: P2)

**Goal**: `artgraph-impact` / `artgraph-plan-coverage` Skill 本文、`docs/skills-guide.md`、`README.md` で symbol mode の使い分けと二軸出力の解釈を案内する。Skill 本文は各 100 行以下を維持。

**Independent Test**: SKILL.md / docs / README を grep して "symbol-level" / "originReqs" / "impactReqs" / "drift" / "scan --mode symbol" 等の必須キーワードが含まれ、Skill 本文行数が 100 行以下。

### Implementation for User Story 4

- [ ] T040 [P] [US4] `artgraph-impact` Skill 本文に symbol 入力例 (`artgraph impact src/auth.ts:validateToken`)、`scan --mode symbol` 前提、二軸出力 (`impactReqs` / `originReqs` / `Drift candidates`) の解釈を追記 (FR-026)
  Files: templates/skills/artgraph-impact/SKILL.md

- [ ] T041 [P] [US4] `artgraph-plan-coverage` Skill 本文に `impactReqs` / `originReqs` の意味、`unresolvedSymbol` 診断の解釈、ドリフト検知の典型ワークフローを追記 (FR-027)
  Files: templates/skills/artgraph-plan-coverage/SKILL.md

- [ ] T042 [P] [US4] `docs/skills-guide.md` に (a) file vs symbol trade-off 表、(b) `Files:` syntax 例 (symbol 含む)、(c) `.artgraph.json` の `mode` 設定例、(d) 二軸出力によるドリフト追跡ガイドを追加 (FR-028, SC-005)
  Files: docs/skills-guide.md

- [ ] T043 [P] [US4] `README.md` の Skills 表に対応 mode 列 (file / symbol / both) を追加 (FR-029)
  Files: README.md

### Tests for User Story 4

- [ ] T044 [P] [US4] `tests/skills-templates.test.ts` で Skill 本文の行数 ≤ 100 を assert (FR-030, SC-004)
  Files: tests/skills-templates.test.ts

- [ ] T045 [P] [US4] `tests/skills-templates.test.ts` で SKILL.md / docs/skills-guide.md の必須キーワード ("symbol-level", "originReqs", "impactReqs", "drift", "scan --mode symbol") の存在を grep ベースで assert
  Files: tests/skills-templates.test.ts

**Checkpoint**: 全 user story 完了。エージェント経由でも symbol mode + 二軸の正しい解釈が伝わる。

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T046 [P] `quickstart.md` Scenario A〜F を fixture 上で順番に実行し、SC-001..SC-006 がすべて満たされることを目視確認
  Files: specs/016-impact-plan-symbol-level/quickstart.md, tests/fixtures/symbol-mode/

- [ ] T047 [P] 自己 dogfood: 本 spec の tasks.md (この file) に対して `artgraph plan-coverage --gate` を実行し、`Files:` セクションの `path:symbol` syntax が正しく resolve され、`implicitImpactsByReq` が spec 016 の REQ にのみ向くことを確認
  Files: specs/016-impact-plan-symbol-level/tasks.md

- [ ] T048 [P] `pnpm test` を実行し全 suite green を確認 (新規追加した sdd-files-parser / traverse / plan-coverage / plan-coverage-integration / impact-cli / skills-templates のテストを含む)
  Files: package.json

- [ ] T049 [P] `artgraph check --diff` で本 PR 範囲の spec / code / test 整合性を確認
  Files: src/parsers/sdd-files.ts, src/graph/traverse.ts, src/plan-coverage/index.ts, src/cli.ts, src/types.ts

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 即時開始可
- **Phase 2 (Foundational)**: Phase 1 完了後。**全 user story (US1/US2/US3/US4) をブロックする**
- **Phase 3 (US1)**: Phase 2 完了後。US2 / US3 と並列実行可
- **Phase 4 (US2)**: Phase 2 完了後。US1 / US3 と並列実行可
- **Phase 5 (US3)**: Phase 2 完了後。**T035〜T039 は US1 (Phase 3) の T017〜T022 が wire up された後でないと意味を持たない** (schema contract test は実装後 pin) — Phase 3 の implementation tasks に soft 依存
- **Phase 6 (US4)**: Phase 5 完了後 (Skill 本文で symbol mode + 二軸出力を案内するため、CLI / schema が確定している必要がある)
- **Phase 7 (Polish)**: Phase 3〜6 の対応 task が完了後

### User Story Dependencies (within phase)

- **US1**: T017 → T018 → T019 / T020 / T021 / T022 (T018 完了後は並列可) → T023 / T024 / T025
- **US2**: T026 → T027 → T028 → T029 → T030 → T031 → T032 (CLI 1 ファイル内なので順次) → T033 / T034 (並列)
- **US3**: T035 / T036 / T037 / T038 / T039 はすべて並列実行可 (異なる test ケース、Phase 3 実装後に pin)
- **US4**: T040 / T041 / T042 / T043 が並列 → T044 / T045

### Within Foundational (Phase 2)

- 型宣言 (T003 / T004 / T006 / T007) は並列実行可
- T005 (`ExtractResult` 再宣言) は T003 / T004 に依存
- T008 / T009 / T010 (parser 実装) は T003 / T004 / T005 完了後、順次
- T011 / T012 (traverse) は T003 完了後、並列実行可
- T013 はコメント追加のみで T011 / T012 と独立
- T014 (fixture) は完全並列
- T015 / T016 (unit test) はそれぞれ parser / traverse の実装完了後

### Parallel Opportunities

- Phase 2: T003 / T004 / T006 / T007 / T014 (5 タスクが完全並列)
- Phase 3: T020 / T021 / T022 (T018 完了後に並列)、T023 / T024 (test 並列)
- Phase 4: T033 / T034 (test 並列)
- Phase 5: T035 / T036 / T037 / T038 / T039 (5 test が完全並列)
- Phase 6: T040 / T041 / T042 / T043 (4 ドキュメント編集が完全並列)
- Phase 7: T046 / T047 / T048 / T049 (検証タスクが完全並列)

---

## Parallel Example: Phase 2 Foundational

```bash
# 型宣言を並列で:
Task T003: SymbolEntry を src/parsers/sdd-files.ts に追加
Task T004: Diagnostic union に unresolvedSymbol を追加
Task T006: ImpactResult に originReqs を追加
Task T007: ReqEntry を src/plan-coverage/index.ts に追加
Task T014: tests/fixtures/symbol-mode/ を構築

# 完了後、parser 実装と traverse 実装を並列で:
Task T008-T010: parser Stage A 実装 (src/parsers/sdd-files.ts)
Task T011-T012: traverse 実装 (src/graph/traverse.ts)
```

## Parallel Example: Phase 5 US3 schema contracts

```bash
# 5 つの contract test を完全並列で:
Task T035: reqs key absence + impactReqs/originReqs presence
Task T036: sourceFiles absence + sourceLocations shape + sort
Task T037: sourceSymbol key omission for file unit + originReqs: [] populate
Task T038: unresolvedSymbol diagnostic shape + 排他
Task T039: 1 file 多 symbol で 2 entry + originReqs 個別一致
```

---

## Implementation Strategy

### MVP First (Setup + Foundational + US1)

1. Phase 1 (Setup)
2. Phase 2 (Foundational) — 全 user story をブロック
3. Phase 3 (US1) — symbol-level plan-coverage が動作する最小単位
4. **STOP & VALIDATE**: `Files: src/auth.ts:validateToken` で 3 REQ → 1 REQ の implicit 削減 (SC-001) を確認
5. ここまでで「過剰検知抑制」のコア価値が dogfood 可能

### Incremental Delivery

1. MVP (US1) → 内部 dogfood で SC-001 / SC-006 を確認
2. US2 追加 → CLI 直接入力経路 + drift text 出力 → SC-002 / SC-003 確認
3. US3 追加 (実態は test pinning) → schema を contract で固める
4. US4 追加 → Skill / docs で agent 経由の解釈ガイダンス → SC-004 / SC-005 確認
5. Phase 7 で全 SC + quickstart + dogfood + check --diff を通す

### Parallel Team Strategy

- Phase 2 完了後、Developer A: US1、Developer B: US2、Developer C (US3 は US1 に soft 依存のため US1 完了後に着手 / Skill 経験のあるメンバが US4 を Phase 5 完了後に着手)

---

## REQ Coverage Map (FR → Task)

| FR | 対応 Task |
|---|---|
| FR-001 (`SymbolEntry` 抽出) | T003, T008, T015 |
| FR-002 (file / symbol 混在) | T008, T015 |
| FR-003 (trailing annotation 剥がし) | T008, T015 |
| FR-004 (`unresolvedSymbol` 発出) | T004, T009, T015 |
| FR-005 (最初の `:` で split) | T008, T015 |
| FR-006 (Stage B 対象外) | T010, T015 |
| FR-007 (`entries: SymbolEntry[]` 一意) | T005, T015 |
| FR-008 (CLI direct symbol 入力) | T027, T033 |
| FR-009 (`--mode` 省略時の symbol 推論) | T029, T033 |
| FR-010 (`--from-tasks` / `--from-plan` 継承) | T028, T033 |
| FR-011 (symbol 不一致 exit 1) | T030, T033 |
| FR-012 (REQ-ID rejection 先行) | T026, T033 |
| FR-013 (scan-mode mismatch error) | T029, T033 |
| FR-014 (impact CLI `originReqs` 出力) | T012, T031, T033 |
| FR-015 (Drift candidates 表示) | T032, T033 |
| FR-016 (`impactReqs` / `originReqs` 二軸) | T018, T035 |
| FR-017 (`originReqs` 1-hop 規則) | T012, T018, T039 |
| FR-018 (`sourceSymbol?` 追加) | T018, T037 |
| FR-019 (symbol 数分の ImpactGroup) | T018, T039 |
| FR-020 (`sourceLocations` 採用) | T019, T036 |
| FR-021 (`unresolvedSymbol` 除外) | T020, T038 |
| FR-022 (`--ignore` の 両軸適用) | T021, T023 |
| FR-023 (text 出力 symbol 表記 + 別セクション) | T022, T032, T023 |
| FR-024 (`init` default 維持) | T002 (現状確認のみ。本 spec で挙動変更なし) |
| FR-025 (scan symbol mode 流用) | T014 (fixture で symbol scan を実行、本体は既存実装) |
| FR-026 (`artgraph-impact` SKILL.md 追記) | T040, T045 |
| FR-027 (`artgraph-plan-coverage` SKILL.md 追記) | T041, T045 |
| FR-028 (`docs/skills-guide.md` 追加要素) | T042, T045 |
| FR-029 (`README.md` mode 列追加) | T043 |
| FR-030 (Skill 本文 ≤ 100 行) | T044 |
| FR-031 (qualified name スコープ外) | T008 (regex で `:` 1 回 split のみ実装) |

### SC Coverage Map

| SC | 対応 Task |
|---|---|
| SC-001 (50% 以上 implicit 削減) | T024 |
| SC-002 (impact 2 秒以内) | T034 |
| SC-003 (二軸 populate + drift 計算可能) | T031, T035, T039 |
| SC-004 (Skill ≤ 100 行 + 5 分理解) | T044, T046 |
| SC-005 (skills-guide 3 要素掲載) | T042, T045 |
| SC-006 (depends_on 後追いで drift JSON 検知) | T025, T046 |

---

## Notes

- `[P]` = 異なる file、未完了 task への依存なし
- `[Story]` ラベルは traceability 目的。Setup / Foundational / Polish には付与しない
- `Files:` セクションは本 spec で実際に編集 / 追加する path を `path:symbol` (新規 / 既存 symbol を編集) または `path` (file 全体を編集) で記述。dogfood のため symbol level で書ける箇所は symbol level で書く
- spec 014 fixture との後方互換 / 旧 field 併走 / migration alias は本 spec で **採用しない** (artgraph 未リリース前提)
- 各 phase の checkpoint で動作確認を行い、validation 失敗時は次 phase に進まない
- commit は task 単位もしくは論理的なまとまりで行い、phase checkpoint で必ず 1 回 commit
