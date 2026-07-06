# Tasks: check --gate baseline 差分化

**Feature**: `specs/017-check-gate-baseline-diff/` | **Branch**: `feat/check-gate-baseline-diff`

**Input**: plan.md / spec.md / research.md / data-model.md / contracts/ / quickstart.md

## 進め方 (TDD: List ⇒ Red ⇒ Green ⇒ Refactor)

各実装ユニットは **Red (失敗するテストを先に書く) → Green (最小実装で通す) → Refactor** の順。`[P]` は別ファイルで依存なく並列実行可。ユーザー指定の 7 観点 (境界条件 / 条件分岐の組み合わせ / 不正な状態遷移 / 例外系・失敗時 / 実運用事故 / エッジケース / 変更外ファイルへの影響) を各テストタスクに割り当てた。観点は各タスク末尾に `〔観点: …〕` で明示。

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

単一パッケージ CLI。実装は `src/`、テストは `tests/`。

---

## Phase 1: Setup & 前提検証

- [X] T001 `git worktree add --detach <tmp> HEAD` が **linked worktree である本 repo から** 動作することを実測し、tmpdir 命名 (`artgraph-baseline-` prefix + `mkdtemp`) と撤去 (`remove --force` / `prune`) の手順を `research.md` R2 の想定どおりか確認する (実測メモを PR 説明に残す)。〔観点: 前提検証・実運用事故〕
- [X] T002 [P] `tests/helpers.ts` に、一時 git repo に「pre-existing 債務 + 追加変更」を仕込むテストフィクスチャ生成ヘルパー (`makeRepoWithDebt` 等) を追加する。既存 `makeCleanGitRepo` (`tests/cli.test.ts`) を再利用・拡張。

---

## Phase 2: Foundational (全 User Story のブロッキング前提)

**⚠️ Phase 3 以降の全 US はここに依存。型・共通関数・baseline モジュールの土台を作る。**

### 2A. 型拡張 (data-model §1)

- [X] T003 `src/types.ts` に `NewIssues` / `BaselineStatus` を追加し、`CheckResult` に `newIssues` / `suppressedCount` / `baselineStatus` を追加する (既存フィールドは維持)。〔観点: 変更外影響 — 型を import する全箇所のコンパイルを壊さない〕

### 2B. findOrphans 構造化 (data-model §2, FR-006) — 変更外影響が大きい

- [X] T004 [P] Red: `tests/traverse.test.ts` の既存 `findOrphans` テスト (`:81`, `:336`) を、戻り値 `OrphanEdge[]` (`{source,target,kind}`) 前提に更新し、`formatOrphan` が従来文字列 `"src -> tgt (kind)"` を返すテストを追加する (この時点で失敗)。〔観点: 変更外影響〕
- [X] T005 Green: `src/graph/traverse.ts` の `findOrphans` を `OrphanEdge[]` 返しに変更し、`formatOrphan(o)` を追加する (task-source 除外の既存ロジックは維持)。
- [X] T006 Refactor: `findOrphans` の全呼び出し元を更新する — `src/check.ts:27` (source 厳密照合に使う)、`src/commands/presenters/check.ts` (表示は `formatOrphan` 経由)。`tests/builder.test.ts:804` のコメント参照も含め、`string[]` を仮定した箇所が残っていないか grep で確認。〔観点: 変更外影響〕

### 2C. baseline モジュール (data-model §3, contracts/baseline-diff.md)

- [X] T007 [P] Red: `tests/baseline.test.ts` を新規作成。`computeBaselineIssues` について (a) 副作用ゼロ (呼び出し前後で作業ツリー・index・`.trace.lock` が byte 一致、worktree 残骸なし)、(b) HEAD 無し → `status:"empty"` / keys 空、(c) worktree 生成失敗 (不正 baseRef 等) → `status:"unavailable"`、(d) 正常 → `status:"computed"` + global issue キー集合、を検証 (失敗する)。〔観点: 副作用ゼロ・例外系・境界条件 (empty)〕
- [X] T008 Green: `src/baseline.ts` を新規実装。`git rev-parse --verify` で HEAD 有無を判定 → `git worktree add --detach <mkdtemp:artgraph-baseline-> <baseRef>` → `scan(<tmp>, config)` → global に `findOrphans`/`findUncovered`/drift (base graph × **現在の** lock, FR-011) を算出 → `issueKey` 群 (`driftKey`/`orphanKey`/`uncoveredKey`/`testfailKey`) で `keys` 集約。`try/finally` で `worktree remove --force`、失敗時 `prune`。test failure は baseline に含めない (baseline-diff.md §1.3 注記)。
- [X] T009 Refactor: `computeBaselineIssues` 冒頭に `artgraph-baseline-` prefix の古い worktree 残骸を best-effort 掃除するロジックを追加。`issueKey` 群を単一の真実源 (SSOT, data-model §6) として export し、Phase 3 の current 差分計算から import できるようにする。〔観点: 実運用事故 (残骸蓄積)〕
- [X] T010 [P] Red→Green: `tests/baseline.test.ts` に (e) worktree remove 失敗時に prune で回収し処理継続、(f) 残骸 prefix 掃除、(g) 並行呼び出しで tmpdir が衝突しない、を追加し実装で通す。〔観点: 不正な状態遷移・実運用事故 (並行・中断)〕

**Checkpoint**: 型・findOrphans・baseline の土台が揃い、全 US に着手可能。

---

## Phase 3: User Story 1 — pre-existing 債務でゲートが赤くならない (P1) 🎯 MVP

**Goal**: 変更と無関係な pre-existing 債務でゲートが exit 2 にならない (issue #174 本体)。
**Independent Test**: pre-existing 未タグ付け REQ につながるファイルに意味を変えない編集 → `check --diff --gate` が exit 0。

- [X] T011 [P] [US1] Red: `tests/check-baseline-diff.test.ts` を新規作成。`makeRepoWithDebt` で pre-existing 債務を持つ repo を作り、(a) clean → exit 0、(b) 債務につながるファイルへ無害な編集 → exit 0 かつ pre-existing が `newIssues` に入らない、(c) 無関係ファイル (README) 編集 → exit 0、を検証 (失敗する)。〔観点: 境界条件 (clean / 無関係)・エッジケース〕
- [X] T012 [US1] Green: `src/check.ts` の `check()` に `baseline?: BaselineIssues` 引数を追加し、`newIssues = scoped issue のうち baseline.keys に無いもの` を算出、`pass = newIssues 全空` に変更。orphan の scope 照合を `orphan.source ∈ scope` の厳密一致に修正 (FR-006、`o.includes(s)` 廃止)。〔観点: 変更外影響 (pass 意味変更)〕
- [X] T013 [US1] Green: `src/commands/check.ts` のフローを data-model §5 のとおり実装 — current `check` → **遅延評価** (current issue 非空のときだけ `computeBaselineIssues(rootDir,"HEAD",現在lock,config)`) → baseline 適用で `newIssues` 再算出 → `opts.gate && newIssues 非空` で exit 2。〔観点: 条件分岐の組み合わせ〕
- [X] T014 [P] [US1] Red→Green: `tests/check-baseline-diff.test.ts` に境界条件 — (d) current **完全にゼロ** → baseline 未算出 (`baselineStatus:"skipped"`, worktree 生成なし)、(e) current が **pre-existing のみ非空** → baseline 算出して全部引き exit 0、の区別を検証。〔観点: 境界条件 (遅延評価の分岐)〕
- [X] T015 [US1] Refactor: 差分計算を `issueKey` (T009 の SSOT) 経由に統一。`check.ts` の可読性を整える。

**Checkpoint**: issue #174 の核心 (誤爆解消) が単独で動作・テスト可能。

---

## Phase 4: User Story 2 — 新規に導入した問題は確実に捕まえる (P1)

**Goal**: 変更が実際に導入した drift/orphan/uncovered を exit 2 で捕まえる (fail-open 防止)。
**Independent Test**: 新規 orphan/uncovered/drift をそれぞれ 1 件導入 → exit 2 + `newIssues` に該当。

- [ ] T016 [P] [US2] Red: `tests/check-baseline-diff.test.ts` に、(a) 存在しない REQ を指す `@impl` 追加 → 新規 orphan で exit 2、(b) 新 REQ 追加で未実装 → 新規 uncovered で exit 2、(c) spec 編集で lock 未更新 → 新規 drift で exit 2、(d) pre-existing のみ → exit 0、を検証 (一部失敗)。〔観点: 条件分岐の組み合わせ〕
- [ ] T017 [US2] Green: drift の baseline を **現在の lock** 基準で算出する差分を確定 (FR-011)。3 種の issue すべてが `current \ baseline` で正しく new 判定されることを通す。
- [ ] T018 [P] [US2] Red: `tests/check-orphan-scope.test.ts` を新規作成。FR-006 の回帰 — 変更ファイルと **部分文字列は一致するが無関係** な fixture の orphan 行 (issue #174 の 48 誤マッチ相当) が `newIssues` にも scoped 判定にも入らないことを検証 (失敗する)。〔観点: 実運用事故 (誤爆の再発防止)・変更外影響〕
- [ ] T019 [US2] Green: T012 の orphan 厳密化で T018 を通す (source の厳密一致)。
- [ ] T020 [P] [US2] Red→Green: 例外系 — `tests/baseline.test.ts` / `check-baseline-diff.test.ts` に、`--gate` かつ baseline `unavailable` → **exit 1** + 明示メッセージ (contracts §4.4)、`--gate` なし かつ `unavailable` → 警告 + 全表示 exit 0 (contracts §4.5) を検証・実装。`src/commands/check.ts` の exit code 分岐 (0/1/2) を確定。〔観点: 例外系・条件分岐の組み合わせ〕
- [ ] T021 [P] [US2] Red→Green: 不正な状態遷移 — `baselineStatus` の不変条件 (data-model §1.1: `skipped`⇒全空、`empty`⇒newIssues==既存配列、`pass==newIssues全空`) を assert するテストを追加し満たす。〔観点: 不正な状態遷移〕
- [ ] T022 [P] [US2] Red→Green: エッジケース — (a) spec.md 自身を編集 → その doc/req の new drift/uncovered が正しく検出、(b) HEAD 無し初回コミット前 → `baselineStatus:"empty"` で全 current が new、(c) 変更がグラフ外ファイルのみ (startIds 空) → 現状挙動維持 (FR-013)、を検証・実装。〔観点: エッジケース・境界条件〕

**Checkpoint**: US1 (誤爆解消) と US2 (見逃し防止) が両立。ゲートの意味論が正しい。

---

## Phase 5: User Story 3 — 大きな差分でも出力が読める (P2)

**Goal**: 出力量が blast radius の広さでなく new issue の実数に比例。サマリ + 新規詳細 + pre-existing 抑制。
**Independent Test**: 50 ファイル純粋リファクタ → 新規ゼロの簡潔出力、pre-existing 全件を吐かない。

- [ ] T023 [P] [US3] Red: `tests/check-gate-output.test.ts` を新規作成。text 出力の (a) new あり → 先頭サマリ + 新規詳細 + 抑制件数 + `impact --diff` 誘導 (contracts §4.1)、(b) new なし pre-existing あり → 簡潔 + 全件非列挙 (§4.2, SC-004)、(c) skipped → 簡潔 (§4.3)、を検証 (失敗する)。〔観点: 境界条件 (0件/N件)〕
- [ ] T024 [US3] Green: `src/commands/presenters/check.ts` を刷新。`newIssues` ベースのサマリ + 詳細、`suppressedCount` の抑制表示、誘導行。pre-existing の全件列挙を廃止。
- [ ] T025 [P] [US3] Red→Green: json 出力 — 既存フィールド維持 + `newIssues`/`suppressedCount`/`baselineStatus` 追加 (R8, FR-009)、`unavailable` 時の json 形 (contracts §3 注記: `pass:false` + `baselineStatus:"unavailable"`)、no-diff ショートサーキットの新フィールド追加。`src/commands/check.ts` の json 分岐を更新。〔観点: 条件分岐の組み合わせ (format × baselineStatus マトリクス)〕
- [ ] T026 [P] [US3] Red→Green: 条件分岐マトリクス網羅 — `--gate` {あり/なし} × `--format` {json/text} × `baselineStatus` {computed/empty/skipped/unavailable} の代表組み合わせを表駆動テストで検証。〔観点: 条件分岐の組み合わせ〕

**Checkpoint**: 出力が実運用で読める。

---

## Phase 6: User Story 4 — blast radius (影響範囲) は温存される (P2)

**Goal**: `impact --diff` と `check --diff` (ゲートなし表示) の影響範囲がこの feature 前後で不変。
**Independent Test**: `impact --diff` の影響 REQ/doc/file 件数が feature 前後で同一。

- [ ] T027 [P] [US4] Red→Green: `tests/check-baseline-diff.test.ts` に、`impact --diff` の `summary` 件数が baseline 差分導入の影響を受けない (縮小しない) ことの回帰テストを追加 (SC-006, FR-007)。impact 側コードは変更しないことをテストで固定。〔観点: 変更外影響 (impact を壊さない)〕

**Checkpoint**: 「知る」機能が温存されていることを保証。

---

## Phase 7: Polish & 変更外ファイルへの影響 & 実運用

### 7A. 変更外ファイル (既存テスト・ドキュメントの追随)

- [ ] T028 `tests/check-gate-no-regression.test.ts` を更新。`check()` に `baseline` 引数を追加したことに伴い、`:92` の「purely a function of (graph, lock, scope, testResults)」の主張を「baseline は optional で未指定なら doctor 非依存の純粋関数」に更新。`r1.pass` 系アサーション (`:104`) が新 pass 意味論 (empty graph → new ゼロ → pass:true) で通ることを確認。doctor 非混入の静的 grep 検査は維持。〔観点: 変更外影響〕
- [ ] T029 [P] `tests/check.test.ts` の既存 `check(graph, lock, ...)` 呼び出し (baseline 引数なし) が後方互換で通ることを確認・必要なら pass 意味論変更に合わせて期待値更新。〔観点: 変更外影響〕
- [ ] T030 [P] `tests/cli.test.ts` の check --diff スモーク (`:217`) と no-diff json テスト (`:229`) を新フィールド (`newIssues`/`baselineStatus`) 前提に更新。〔観点: 変更外影響〕
- [ ] T031 [P] `docs/architecture.md:210` の `check [--gate] [--diff]` 説明を「新規に導入した問題で exit 2 (pre-existing はゲート対象外)」の意味論に更新。〔観点: 変更外影響 (SSOT: exit code 定義)〕
- [ ] T032 `templates/skills/artgraph-verify/SKILL.md` と `templates/skills/_shared/output-schema.md` を、`pass` の新意味論 + `newIssues`/`baselineStatus` フィールドに合わせて更新。**5 agent 複製** (`.claude/`, `.agents/`, `.cursor/`, `.github/`, `.kiro/` 配下) もミラー更新し、`tests/skills-templates.test.ts` の同期検査を通す。〔観点: 変更外影響 (dogfood parity #157)〕

### 7B. 実運用事故・パフォーマンス

- [ ] T033 [P] `tests/baseline.test.ts` に実運用事故の統合確認 — 中断相当 (finally 未実行を模したケース) の残骸が次回実行の prefix 掃除で回収されることを検証。〔観点: 実運用事故〕
- [ ] T034 baseline 算出 (worktree cold scan) のレイテンシを dogfood repo で実測し、Stop hook 用途として許容範囲か plan の Performance Goals と突き合わせる。過大なら将来最適化を follow-up issue 化 (本 feature スコープ外)。〔観点: 実運用事故 (レイテンシ)〕

### 7C. dogfood 最終確認

- [ ] T035 `quickstart.md` の S1〜S7 を手動実行し全期待値を確認。特に S1 (doctor.ts touch → exit 0) と S3 (副作用ゼロ + worktree 撤去)。
- [ ] T036 この spec の FR にコード側 `@impl 017-check-gate-baseline-diff/FR-NNN` タグを付与 (dogfood、原則 III)。`src/baseline.ts` / `src/check.ts` / `src/commands/check.ts` の該当関数に claim。新規 REQ-ID の既存衝突なしを再確認 (Cat6)。〔観点: 変更外影響〕
- [ ] T037 `pnpm build && pnpm test` (unit+e2e+perf) 全通過、`pnpm knip` / `pnpm typecheck` クリーン、本 repo で `node dist/cli.js check --diff --gate` が exit 0 (pre-existing 債務で赤くならない) を確認。

---

## Dependencies (完了順)

```
Phase 1 (Setup)
   └─► Phase 2 (Foundational: T003 型 → T004-T006 findOrphans → T007-T010 baseline)  ← 全 US の前提
          ├─► Phase 3 (US1) ─┐
          ├─► Phase 4 (US2) ─┤ US1/US2 は同じ baseline コアに依存 (US1 先行推奨、US2 が上乗せ)
          ├─► Phase 5 (US3) ─┤ presenter は US1/US2 のロジック後
          └─► Phase 6 (US4) ─┘ 回帰テストのみ (impact 不変)
                 └─► Phase 7 (Polish: 変更外追随 → 実運用 → dogfood)
```

- **Foundational (Phase 2) は全 US をブロック**。特に T005 (findOrphans 構造化) と T008 (baseline) は必須前提。
- US1 と US2 は同一コア (`check()` の baseline 差分) を共有。US1 で骨格、US2 でエラー系・厳密化・エッジを上乗せ。
- Phase 7 の 7A (変更外追随) は US1〜US3 実装完了後にまとめて実施。

## Parallel Opportunities

- Phase 2: T004 (findOrphans Red) と T007 (baseline Red) は別ファイルで `[P]` 並列可。
- 各 US の Red テスト作成 (`[P]`) は実装前に並列で書ける。
- Phase 7A の T029/T030/T031 と、7B の T033 は別ファイルで並列可。

## Implementation Strategy

- **MVP = Phase 1 + 2 + 3 (US1)**: issue #174 の誤爆解消が単独で価値を出す。ここで一度 dogfood 確認。
- 続けて US2 (見逃し防止) を上乗せしてゲートの正しさを完成、US3 (出力) → US4 (回帰) → Polish。
- **Phase 2 (`--base` CLI 露出) は本 feature 対象外** — 内部は base ref パラメータ化済み (T008)、CLI フラグ追加は follow-up PR。

## Definition of Done (実装時 Engineering Hygiene)

- [ ] 全テスト green (TDD: 各ユニットで Red を先に確認してから Green)。
- [ ] `check --diff --gate` の exit code (0/2/1) が対称・決定的 (Cat5)。
- [ ] issue 同一性キー / orphan 文字列 / exit code / `pass` 意味の SSOT が単一箇所 + 従属の等価性テスト (Cat2, data-model §6)。
- [ ] baseline の走査方向 (global forward) と dedup key、current の scope 境界 (blast radius 不変) が実装と一致 (Cat7)。
- [ ] 副作用ゼロ (作業ツリー・index・lock・parse-cache 不変) をテストで固定 (SC-003)。
- [ ] 変更外ファイル (findOrphans 呼び出し元 / pass 消費者 / docs / skills 5 複製) の追随完了。
