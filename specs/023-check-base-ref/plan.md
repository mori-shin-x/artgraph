# Implementation Plan: check --base <ref> — CI PR gating

**Branch**: `feat/check-base-ref` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/023-check-base-ref/spec.md`

## Summary

`artgraph check` に `--base <ref>` を追加し、CI の PR checkout (作業ツリー clean) でも「PR が新規に導入した issue」でゲート判定できるようにする (spec 017 Phase 2 / issue #185)。

技術アプローチ: `<ref>` を `classifyBaseRef` で検証し、`git merge-base <ref> HEAD` を **1 回だけ** 解決した merge-base SHA を単一の基準点として、(a) 変更ファイル集合 = 現行 three-way union ∪ `<mergeBase>..HEAD` コミット間差分、(b) rename 検出 = `git diff -M <mergeBase>`、(c) tracked-path probe = HEAD tree ∪ merge-base tree、(d) baseline worktree = `computeBaselineIssues(rootDir, <mergeBaseSHA>, ...)` のすべてに共有する (D1: merge-base 統一)。`--base` の全異常系は 017 の `baselineStatus:"unavailable"` に集約し (`--gate` で exit 1 + `fetch-depth: 0` ヒント)、`--diff` なしの `--base` は usage error (exit 1) で fail-closed。`--base` 未指定の挙動は byte-identical に維持する。

## Technical Context

**Language/Version**: TypeScript (ESM, `"type": "module"`) / Node.js >= 22

**Primary Dependencies**: commander (CLI)、既存の内部モジュール (`scan` / `check` / `computeBaselineIssues` / `impact` / `resolveStartIds`)。新規外部依存は追加しない (`git` CLI は既存の `diff.ts` / `baseline.ts` が `execFileSync` 経由で使用済み。`git merge-base` の呼び出しを 1 つ追加するのみ)。

**Storage**: ファイルベース。`.trace.lock` (gitignore 済み — baseline drift は 017/FR-011 どおり現在の lock 基準のまま)。

**Testing**: vitest (unit / e2e / perf)。CLI 振る舞いは in-process 実行 (`tests/helpers.ts` の `runAt`) + 一時 git repo。本 feature は **複数コミット / base ブランチ** を持つ fixture が必要になるため、`tests/helpers.ts` にブランチ分岐ヘルパーを追加する。

**Target Platform**: (新規) CI — GitHub Actions 等の PR checkout (`fetch-depth: 0` 前提、shallow は fail-closed)。(既存) 開発者ローカル — push 前の `--base origin/main` 実行。Stop hook は `--base` を使わない (FR-003)。

**Project Type**: single project CLI (`src/` 単一パッケージ)

**Performance Goals**: `--base` 追加分の git 呼び出しは merge-base 解決 1 回 + コミット間差分 name-only 1 回 + ls-tree probe 1 tree 分のみ (いずれも軽量 plumbing)。主コストは 017 と同じ baseline worktree scan 1 回で、CI 用途 (数百 ms〜秒オーダー) として許容。`--base` 未指定パスにコスト追加ゼロ。

**Constraints**: `--base` 未指定の挙動 byte-identical (SC-005)。baseline 算出の副作用ゼロ (017/FR-004) は不変。diff range と baseline の基準コミット一致 (FR-007) を構造的に保証。

**Scale/Scope**: dogfood 時点で node 約 1,000 / edge 約 1,300。PR の base range は通常数コミット〜数十コミット、変更ファイル数十個。

### 解決した設計判断 (詳細は research.md)

- **merge-base 統一 (R1, D1)**: `git merge-base <ref> HEAD` を 1 回解決し、diff range・rename map・tracked probe・baseline worktree の全員が同一 SHA を共有。ref tip 直接比較は moved-ahead base で双方向 (false exit 2 / fail-open) に壊れるため禁止。
- **`--base` without `--diff` はハードエラー (R2, D2)**: exit 1。`--ignore` 型の警告続行は CI の silent 誤構成を許すため不採用。
- **変更ファイル集合は和集合 (R3)**: three-way union ∪ base range。既存 3 呼び出しも `-z` + `core.quotePath=false` 化し path 表記を統一。
- **削除ファイルの fail-open 防止 (R4)**: `getHeadTrackedPaths` を merge-base tree も probe する形に一般化 (#229 failure mode の base-range 再発 = 本 feature #1 リスク)。
- **rename map のパラメータ化 (R5)**: `git diff -M <mergeBase>` で committed rename を inverse-rename startId 解決 (commands/check.ts:136) と orphan-key 正規化 (baseline.ts:229) の両方に届かせる。
- **異常系は `unavailable` に集約 (R6)**: ref 解決不能 / merge-base 失敗 → `baselineStatus:"unavailable"` + fetch-depth ヒント。新 exit code / 新フィールドなし。`--ignore` pass 再計算の安全性条件。
- **CI 警告の抑制 (R7)**: `--base` あり + 空 merged diff = 正常の「No changes」exit 0。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ merge-base 解決・コミット間差分・baseline scan はすべて git plumbing + content-hash で決定的。同一 `(repo 状態, <ref>)` に対し同一の merge-base SHA → 同一の判定。判定不能 (shallow / 解決不能 ref) は黙殺せず専用 exit 1 (017/FR-010 の踏襲)。LLM 推定は一切入らない。
- **II. 単一型付き4層グラフ**: ✅ 新ノード / エッジ型を追加しない。既存の baseline 差分機構の base ref を一般化するだけで、グラフモデル・`CheckResult` のフィールドは不変 (FR-012)。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ✅ 「ゲートは『この変更で claim した ID が drift / orphan / uncovered のまま残っていないこと』」の定義を、変更単位を「作業ツリー diff」から「PR (base range + 作業ツリー) diff」へ拡張して CI に届ける。グローバル全 ID カバレッジをゲート化するものではない。
- **IV. SDD ツール ID 直接利用**: ✅ 影響なし。ID 発行・修飾ロジックは変更しない。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ base range 差分も構造判定 (issue 集合差) のみ。意味的正しさは判定しない。

**違反なし。Complexity Tracking への記載不要。**

### Engineering Hygiene Gates

- [x] **前提検証 (Cat6)**: 017 の内部 API が base ref パラメータ化済みであること (`computeBaselineIssues(rootDir, baseRef, ...)`) を実コードで確認。一方で HEAD 固定の残骸 3 箇所 — `getGitDiffFiles` (作業ツリー diff のみ)、`getGitRenameMap` (`git diff -M HEAD`, src/diff.ts:153)、`getHeadTrackedPaths` (`git ls-tree -r HEAD`, src/diff.ts:119) — が `--base` で壊れることを特定し FR-006/008/009 に落とした。`isUnbornHead` の非 HEAD early return (src/baseline.ts:381) が named ref の unborn 誤分類を既に防いでいることを確認 (FR-004 で pin)。`--ignore` pass 再計算 (check.ts:300-310) が `unavailable` 集約に依存することを確認 (FR-012)。
- [x] **ID 衝突 (Cat6)**: 新規 spec 番号 023 は既存 (003〜022) と衝突なし。本 feature の FR-001〜012 は `023-check-base-ref/FR-NNN` に qualified 化され既存 spec と衝突しない。コード側 `@impl` タグ付けは tasks で扱う。
- [x] **SSOT ペア (Cat2)**: (a) merge-base SHA — `resolveMergeBase` の戻り値を唯一の基準点とし、diff/rename/probe/baseline へ引数で配布 (再解決禁止)。(b) fetch-depth ヒント文言 — 単一定数に集約し、ref 解決失敗と merge-base 失敗が同じ文言を共有。(c) exit code (0/1/2) と `baselineStatus` の意味は 017 の SSOT (src/commands/check.ts / src/baseline.ts) を変更せず再利用。詳細は data-model.md §5。
- [x] **CLI 規約 (Cat5)**: 新フラグ `--base <ref>` は値必須の option。`--diff` なし指定は対称なエラー挙動 (text/json 双方で stderr + exit 1)。`--format json|text` 維持。json はフィールド追加ゼロ (完全後方互換)。exit code は 017 契約 (0/1/2) を不変に維持し、usage error を exit 1 ファミリーに位置づける (contracts/cli-check-base.md §3)。
- [x] **走査仕様 (Cat7)**: 変更ファイル集合の union 定義 (three-way ∪ base range、dedup は path 文字列一致 — だからこそ `-z`/quotePath 統一が必須, R3)。scope 拡張は既存の current/baseline 両側 BFS union (017 US2-AS3) を不変で流用し、startId 解決だけが base-range の削除/rename を追加で拾う。tracked probe の方向 = 「HEAD ∪ merge-base のどちらかで tracked なら resolvable」。plan / data-model に明記。

## Project Structure

### Documentation (this feature)

```text
specs/023-check-base-ref/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output (R1–R8 decision records)
├── data-model.md        # Phase 1 output (シグネチャ変更 / merge-base 解決の配置)
├── quickstart.md        # Phase 1 output (GitHub Actions レシピ / troubleshooting)
├── contracts/
│   └── cli-check-base.md   # --base の CLI 契約 (検証順 / exit code / JSON 不変条件 / フラグ相互作用)
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
src/
├── diff.ts                      # [変更] getGitDiffFiles(rootDir, baseSha?) — base range を union に追加、
│                                #        既存 3 呼び出しの -z + core.quotePath=false 化 (FR-006)
│                                #        getGitRenameMap(rootDir, baseSha?) — 比較基準のパラメータ化 (FR-008)
│                                #        getHeadTrackedPaths(rootDir, paths, baseSha?) — merge-base tree も probe (FR-009)
├── baseline.ts                  # [変更] resolveMergeBase(rootDir, ref) 新設 (classifyBaseRef の隣、FR-005)。
│                                #        :174 submodule メッセージの "see #185" 文言更新 (FR-011)
└── commands/
    └── check.ts                 # [変更] --base <ref> option 追加 / --diff 必須検証 (FR-001/002)、
                                 #        merge-base 解決 → diff/rename/probe/baseline への配布 (FR-005/007)、
                                 #        CI 警告の抑制と文言更新 (FR-010/011)、コメント更新 (:82-89, :157)

tests/
├── check-base-ref.test.ts       # [新規] US1/US2/US3 — base ブランチ fixture での gate 判定、
│                                #        moved-ahead base、削除 (A1)、rename (A2)、unavailable (A10)、
│                                #        非 ASCII (A4)、untracked 包含、空 merged diff
├── check-baseline-diff.test.ts  # [変更] E1 suite (:175-224) を「--base あり → CI 警告なし」で拡張
├── diff.test.ts                 # [変更/新規] getGitDiffFiles / getGitRenameMap / getHeadTrackedPaths の
│                                #        base 引数対応 + -z 化の回帰 (既存テストの期待値追随)
├── baseline.test.ts             # [変更] resolveMergeBase 単体 (成功 / shallow / unrelated histories)、
│                                #        isUnbornHead 非 HEAD early-return の pin
└── helpers.ts                   # [変更] 複数コミット / base ブランチ / moved-ahead base の fixture ヘルパー

docs / templates (実装タスクとして更新 — tasks.md Phase 7):
├── README.md / README.ja.md                     # [変更] CI gate 節に GitHub Actions レシピ追加
├── docs/commands.md                             # [変更] check 節に --base を追記
├── docs/architecture.md                         # [変更] :216-222 CLI 表の check 行、:274 周辺の hook/CI 記述
├── templates/skills/artgraph-verify/SKILL.md    # [変更] --base の案内 (+ per-agent 配布複製ミラー)
├── templates/skills/_shared/output-schema.md    # [変更] baselineStatus/exit code 表に CI (--base) 行、
│                                                #        staleness "gate" scope 拡大の注記
├── templates/integrate/speckit/ / kiro/         # [変更] CI 向け文言 (該当箇所のみ)
├── templates/agent-context/agents-md-snippet.md # [変更] CI ワークフロー 1 行追記
└── AGENTS.md (repo root)                        # [変更] Common workflows に CI gate 追記
```

**Structure Decision**: 新規モジュールは作らない。merge-base 解決 (`resolveMergeBase`) は ref 分類 (`classifyBaseRef`) と診断ヘルパー (`extractErrorMessage`/`debugLog`) が既にある `src/baseline.ts` に置き、git diff 系のパラメータ化は `src/diff.ts` の既存関数のシグネチャ拡張 (optional 引数、既定値 = 現行挙動) に留める。コマンド層 (`src/commands/check.ts`) が merge-base を 1 回解決して各関数へ配布する司令塔になる (data-model.md §4)。`check()` 純粋関数と `CheckResult` は無変更。

## Phase Breakdown

- **Phase 0 (research)**: 完了 — research.md R1–R8。承認済み決定 D1–D3 を decision record 化。
- **Phase 1 (design)**: 完了 — data-model.md (シグネチャ / 配置 / SSOT)、contracts/cli-check-base.md (外部契約)、quickstart.md (CI レシピ / 検証手順)。
- **Phase 2 (tasks)**: tasks.md — TDD (Red → Green → Refactor) 順の実装タスク。fixture ヘルパー → diff.ts 配管 → コマンドフロー → 異常系 → 回帰固定 → docs/skills/templates 追随 → dogfood。

## Complexity Tracking

> Constitution Check に違反なし。記載不要。

## Follow-up

- **`impact --base` (別 issue 起票)**: CI テスト選択 (`impact --diff --tests` の base-range 化)。spec 016 `contracts/cli-flags.md` §1.3 の改訂を伴うため本 feature から除外 (spec.md Out of Scope / D3)。本 feature の `resolveMergeBase` / `getGitDiffFiles(rootDir, baseSha?)` はそのまま再利用できる形で実装する。
- **Submodule 対応**: 引き続き未対応 (fail-closed)。`src/baseline.ts:174` の参照文言は本 feature で更新 (FR-011)。
