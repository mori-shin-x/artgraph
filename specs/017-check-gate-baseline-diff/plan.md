# Implementation Plan: check --gate baseline 差分化

**Branch**: `feat/check-gate-baseline-diff` | **Date**: 2026-07-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-check-gate-baseline-diff/spec.md`

## Summary

`check --diff --gate` のゲート合否を、「変更の影響範囲 (blast radius) 内の全 issue」から「変更が **新規に導入した** issue だけ」に変える。影響範囲の可視化 (blast radius) は温存し、ゲートの **合否判定** のみを絞る。

技術アプローチ: base ref (Phase 1 では HEAD 固定) の状態を `git worktree` で副作用ゼロに展開して `scan` し、その **global** な issue 集合を baseline とする。現在の scoped issue から baseline に既存のもの (pre-existing) を差し引き、残った new issue でゲート判定する。あわせて orphan のスコープ照合を部分文字列マッチから厳密 ID 一致に修正し、出力を「新規サマリ + 新規詳細 + pre-existing 抑制」に刷新する。baseline は遅延評価 (current issue が非空のときのみ算出) し、構築不能な異常系は専用 exit code (1) でエラー終了する。

## Technical Context

**Language/Version**: TypeScript (ESM, `"type": "module"`) / Node.js >= 20

**Primary Dependencies**: commander (CLI)、oxc-parser (TS 抽出)、unified + remark-parse (Markdown)、既存の内部モジュール (`scan` / `buildGraph` / `readLock` / `traverse`)。新規外部依存は追加しない (`git` CLI は既存の `diff.ts` が既に `execFileSync` 経由で使用)。

**Storage**: ファイルベース。`.trace.lock` (**gitignore 済み** — コミットされない)、parse-cache は `<root>/node_modules/.cache/artgraph/` (worktree には存在しないため baseline scan は自動的に cold path)。

**Testing**: vitest (unit / e2e / perf)。CLI 振る舞いは in-process 実行 (`tests/helpers.ts` の `runAt`) + 一時 git repo (`makeCleanGitRepo`) で担保。

**Target Platform**: 開発者ローカル (Stop hook / `artgraph-verify` Skill)。git リポジトリを前提。

> **注 (issue #182 レビュー E1)**: CI での実行はスコープ外 — CI の checkout は通常コミット済み状態と作業ツリーが完全一致するため `--diff` (git diff staged+unstaged+untracked) は恒常的に空になり、ゲートが無言で no-op になる (Follow-up 参照)。本 feature は開発者ローカル向けの `--diff` 挙動のみを対象とする。

**Project Type**: single project CLI (`src/` 単一パッケージ)

**Performance Goals**: baseline 算出は遅延評価で「新規候補問題ありのとき 1 回だけ」。worktree scan は cold path 1 回分のコスト (現行 dogfood grade で数百 ms〜秒オーダー、ゲート用途として許容)。問題なしケースでは追加コストゼロ (SC-005)。

**Constraints**: baseline 算出はユーザーの作業ツリー・index・lock を一切変更しない (副作用ゼロ、SC-003)。blast radius は縮小しない (SC-006)。

**Scale/Scope**: dogfood 時点で node 約 1,000 / edge 約 1,300。変更ファイルは通常数個〜数十個。

### 解決した設計判断 (詳細は research.md)

- **baseline は global に計算する**: current issue は scoped (blast radius)。baseline は base graph 全体の orphan / uncovered / drift をキー集合化。`new = current issue のうち baseline キー集合に無いもの`。base ref 側で scope を再計算しないので単純かつ漏れがない。
- **drift の baseline は現在の lock を基準**: `.trace.lock` は gitignore で worktree に来ないため (FR-011)。base graph を現在の lock と比較して得た drift を baseline drift とする。
- **worktree は `git worktree add --detach <tmp> <ref>` → scan → `git worktree remove --force`**: `git stash` は使わない (FR-004)。
- **issue 同一性キー**: `drift:<nodeId>` / `orphan:<source -> target (kind)>` / `uncovered:<reqId>` / `testfail:<reqId>`。
- **orphan 厳密化**: orphan 文字列の source を厳密に scoped node 集合と照合 (部分文字列 `includes` を廃止)。
- **exit code**: 0 = gate pass (new ゼロ) / 2 = gate fail (new あり, `--gate` 時) / 1 = baseline 構築不能の異常系 (`--gate` 時)。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ baseline 差分は content-hash + lock + グラフ構造だけで決まる。worktree scan は同一 ref に対し決定的。LLM 推定は一切入らない。exit code は決定的に分岐。
- **II. 単一型付き4層グラフ**: ✅ 新ノード / エッジ型を追加しない。既存の `findOrphans` / `findUncovered` / `computeCoverage` / drift 判定を base graph に再適用するだけ。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ✅ **本 feature の核心**。Constitution は「ゲートは『この変更で claim した ID が drift / orphan / uncovered のまま残っていないこと』。グローバルな全 ID カバレッジはゲートではない」と定義している。現状実装はこの定義から逸脱 (pre-existing 全 ID を巻き込む) しており、本 feature はゲートを憲法定義に一致させる回帰修正である。
- **IV. SDD ツール ID 直接利用**: ✅ 影響なし。ID 発行・修飾ロジックは変更しない。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ baseline 差分も構造判定 (issue 集合差) のみ。意味的正しさは判定しない。

**違反なし。Complexity Tracking への記載不要。**

### Engineering Hygiene Gates

- [x] **前提検証 (Cat6)**: issue #174 の再現 (exit 2, 279 行) と原因 (`impact()` の双方向・深さ無制限 BFS を gate に流用) を実コードで裏取り済み。`.trace.lock` の gitignore を確認し、当初前提「worktree で base 版 lock」を「現在の lock 基準」に修正済み (FR-011)。impact() の blast radius (121/341 REQ) と 50 ファイル差分の出力量を実測済み。
- [x] **ID 衝突 (Cat6)**: 新規 spec 番号 017 は既存と衝突なし。本 feature の FR-001〜014 は `017-check-gate-baseline-diff/FR-NNN` に qualified 化され既存 spec と衝突しない。コード側 `@impl` タグ付けは tasks で扱う。
- [x] **SSOT ペア (Cat2)**: exit code の意味 (0/1/2) と issue 同一性キー生成が複数箇所に出る。真実源を単一関数 (`src/baseline.ts` の key 生成 / exit code 定数) に集約し、doc (`docs/architecture.md` / `templates/skills/artgraph-verify`) との等価性はテストで担保。詳細は data-model.md の SSOT 節。
- [x] **CLI 規約 (Cat5)**: 本 feature は既存 `check` コマンドの挙動変更で、Phase 1 では新フラグを追加しない (`--base` は Phase 2)。`--format json|text` は維持。exit code の対称性 (成功 0 / gate fail 2 / エラー 1) を contract に明記。json は既存フィールドを壊さず追加のみ (後方互換)。
- [x] **走査仕様 (Cat7)**: baseline の走査方向は既存 `findOrphans` (forward: implements/verifies edge) / `findUncovered` (req ノード全走査) / drift (lock 比較) を **base graph 全体 (global)** に適用。dedup key = issue 同一性キー。current 側の scope 境界は既存 `impact()` BFS を不変で流用 (blast radius 温存)。orphan の source 照合は厳密一致に変更。plan / data-model に明記。

## Project Structure

### Documentation (this feature)

```text
specs/017-check-gate-baseline-diff/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── cli-check-gate.md   # exit code / json schema / text format 契約
│   └── baseline-diff.md    # baseline 算出の内部契約 (base ref パラメータ化)
├── checklists/
│   └── requirements.md  # spec quality (済)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── diff.ts                      # [変更] getGitDiffFiles を base ref パラメータ対応に (内部)
├── baseline.ts                  # [新規] worktree 展開 → scan → global issue 集合 → 破棄
│                                #        computeBaselineIssues(rootDir, baseRef, currentLock, config)
├── check.ts                     # [変更] new issue 差分計算 + orphan 厳密化。check() の scope 照合修正
├── commands/
│   ├── check.ts                 # [変更] current → 遅延 baseline → 差分 → exit code (0/1/2) フロー
│   └── presenters/
│       └── check.ts             # [変更] 新規サマリ + 新規詳細 + pre-existing 抑制 + impact 誘導
├── graph/
│   └── traverse.ts              # [変更] findOrphans を構造化 (source/target/kind) or check 側で source 抽出
└── types.ts                     # [変更] CheckResult 拡張 (newIssues / suppressedCount / baselineStatus)

tests/
├── check-baseline-diff.test.ts  # [新規] US1/US2 差分ゲート (pre-existing 無視 / 新規検出) — 一時 git repo
├── check-orphan-scope.test.ts   # [新規] FR-006 orphan 厳密化 (部分文字列誤判定の回帰防止)
├── baseline.test.ts             # [新規] worktree 副作用ゼロ / 遅延評価 / 構築不能エラー (exit 1)
├── check-gate-output.test.ts    # [新規] US3 出力フォーマット (サマリ/抑制/json isNew)
└── cli.test.ts                  # [変更] 既存 check --diff スモークの意味論更新

docs / templates:
├── docs/architecture.md                         # [変更] check --gate の意味論 (new issue 基準) 明記
├── templates/skills/artgraph-verify/SKILL.md    # [変更] pass の意味変更を反映 (+ 5 agent 複製ミラー)
└── templates/skills/_shared/output-schema.md    # [変更] CheckResult 新フィールド追記
```

**Structure Decision**: 既存の single-project CLI レイアウトを踏襲。baseline 算出は独立責務なので `src/baseline.ts` に新設し、`commands/check.ts` から呼ぶ。差分ロジックとエラー処理は presenter / command 層に閉じ、純粋関数 `check()` は base graph にも再利用できる形を保つ (テスト容易性)。

## Complexity Tracking

> Constitution Check に違反なし。記載不要。

## Follow-up

- **Phase 2: `--base <ref>` CLI 露出 ([#185](https://github.com/ShintaroMorimoto/artgraph/issues/185))**: 内部 API (`computeBaselineIssues(rootDir, baseRef, ...)`) は本 feature で既に base ref パラメータ化済み (FR-012)。CLI フラグとしての露出は本 feature のスコープ外とし、別 PR で扱う (spec.md Assumptions 参照)。issue #182 レビューで判明した E1 (CI での `--diff` 恒常無変化 → ゲート無言 no-op) はこの Phase 2 で解消する想定 — `--base <ref>` を渡せば CI は「PR のマージ先ブランチ」を base ref にでき、作業ツリー diff ではなくコミット間 diff でゲート判定できるようになる。
