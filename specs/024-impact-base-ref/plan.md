# Implementation Plan: impact --diff --base <ref> — CI テスト選択

**Branch**: `feat/impact-base-ref` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/024-impact-base-ref/spec.md`

## Summary

`artgraph impact` に `--base <ref>` を追加し、CI の PR checkout (作業ツリー clean) でも `impact --diff --tests` によるテスト選択が PR のコミット範囲で機能するようにする (issue #305 / spec 023 D3 follow-up)。

技術アプローチ: spec 023 が再利用可能な形で実装した配管をそのまま使う — `classifyBaseRef` で `<ref>` を検証し、`resolveMergeBase` で merge-base SHA を **1 回だけ** 解決 (どちらも scan より前、D-6 fast fail)、得た baseSha を `getGitDiffFiles(rootDir, baseSha)` に渡して merged diff (three-way union ∪ base range) を得る。**baseline worktree は導入しない** (D-1): startId 解決は現在グラフのみで、削除された / グラフ未追跡の変更ファイルは無言で寄与しない — これを「選択の限界 + full-suite fallback の consumer rule」(D-5) として契約に含める。環境失敗 (ref 解決不能 / merge-base 失敗) は stderr + exit 1 の fail-closed (JSON なし、D-2)。あわせて `--format` を `.choices()` 化する (D-7、#306 F7 の残余)。`--base` 未指定の挙動は byte-identical (この `--format` 変更のみ独立の例外)。

## Technical Context

**Language/Version**: TypeScript (ESM, `"type": "module"`) / Node.js >= 22

**Primary Dependencies**: commander (CLI)、既存の内部モジュール (`scan` / `resolveStartIds` / `impact` / `ingestTrace` / spec 023 の `resolveMergeBase` / `getGitDiffFiles(rootDir, baseSha?)`)。新規外部依存なし。**新規 git 呼び出しの実装もなし** — merge-base 解決とコミット間差分はすべて 023 実装の再利用。

**Storage**: ファイルベース。lock は読み取りのみ (impact は従来どおり write しない)。baseline worktree なし → 副作用ゼロは自明に維持。

**Testing**: vitest (unit / e2e / perf)。CLI 振る舞いは in-process 実行 (`tests/helpers.ts` の `runAt`) + 一時 git repo。base ブランチ fixture は spec 023 の `makeRepoWithBaseBranch` / `gitCheckoutBranch` / `withBaseAndFeatureBranches` を再利用し、`--tests` 用に trace shard を持つ branch fixture を追加する。

**Target Platform**: (新規) CI — GitHub Actions 等の PR checkout (`fetch-depth: 0` 前提、shallow は fail-closed) でのテスト選択。(既存) 開発者ローカル — push 前の `--base origin/main` によるブランチ全体のテスト選択。

**Project Type**: single project CLI (`src/` 単一パッケージ)

**Performance Goals**: `--base` 追加分の git 呼び出しは merge-base 解決 1 回 + コミット間差分 name-only 1 回のみ (いずれも軽量 plumbing、023 実測済み)。check と異なり baseline worktree scan (数百 ms〜秒) を **払わない** — impact `--base` の追加コストはミリ秒オーダー。`--base` 未指定パスにコスト追加ゼロ。環境失敗は scan 前に fast fail (D-6) するため、誤構成の CI が scan コストを払うこともない。

**Constraints**: `--base` 未指定の挙動 byte-identical (SC-005、例外は FR-010 のみ)。`src/diff.ts` / `src/baseline.ts` / `src/graph/traverse.ts` / `src/commands/check.ts` は無変更 (spec.md Out of Scope)。変更対象は `src/commands/impact.ts` 1 ファイル。

**Scale/Scope**: dogfood 時点で node 約 1,000 / edge 約 1,300。PR の base range は通常数コミット〜数十コミット、変更ファイル数十個。testsToRun は数件〜数十件。

### 解決した設計判断 (詳細は research.md)

- **current-graph-only、baseline なし (R1, D-1)**: impact は現在グラフに対する forward query のまま。削除ファイルは無言で寄与ゼロ = 宣言された選択限界 (bounded fail-open — 静的 import の削除は importer 側の編集経由で選択に届く)。trace-join 回復は follow-up 候補として記録、out of scope。
- **fail-closed、JSON なし、縮退なし (R2, D-2)**: ref 解決不能 / merge-base 失敗 → stderr + exit 1。`--format json` でも JSON を出さない (環境失敗は verdict ではない)。impact には gate/no-gate の区別がないため display-only 縮退も持たない — CI は exit 1 で full suite に fallback する。
- **`--base` requires `--diff`、検証順 pin (R3, D-3/D-6)**: usage error exit 1。requires-diff は REQ-ID/doc: rejection の後・排他/no-source の前。base 検証 + merge-base 解決は scan より前 (fast fail — check と意図的に異なる配置)。
- **全 path 未解決は現行 exit 1 のまま (R4, D-4/D-5)**: 「No matching nodes found」を byte-identical に維持し、consumer rule (最適化 / fallback / check がゲート) を FR + docs 化。
- **`--format` `.choices()` 化 (R6, D-7)**: #306 F7 の残余を消化。bogus 値 exit 1 の挙動変更を独立に pin。
- **rename map なし (R7, D-8)**: `-M` の new-path 畳み込みは current-graph query に正しい。意図的非目標として明記。
- **staleness "exclude" 相互作用 (R8, D-9)**: 3 条件共起で非致命 stderr 警告 + docs 明記。
- **agreement property (R5)**: merged diff は check と同一関数の共有で (i) を構造保証、(ii) check ⊇ impact は US4 テスト拡張で pin。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ merge-base 解決・コミット間差分は 023 と同じ git plumbing で決定的。同一 `(repo 状態, <ref>, trace shards)` に対し同一の選択結果。環境失敗 (shallow / 解決不能 ref) は黙殺せず exit 1 (D-2)。D-1 の選択限界は「判定の黙殺」ではなく「最適化レイヤーの宣言された境界」であり、FR-009 の consumer rule と check 側ゲート (spec 023 SC-003) が正しさの判定を fail-closed に保つ。LLM 推定は一切入らない。
- **II. 単一型付き4層グラフ**: ✅ 新ノード / エッジ型を追加しない。`ImpactResult` のフィールドも不変 (`testsToRun` は spec 020 既存)。グラフモデル・traversal (`src/graph/traverse.ts`) は無変更。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ✅ impact は読み取り専用の可視化・選択コマンドであり、ID の発行・claim の変更を行わない。テスト選択は claim の実行証拠 (`exercises` edges, spec 020) に基づく既存機構の入力集合を広げるだけ。
- **IV. SDD ツール ID 直接利用**: ✅ 影響なし。ID 発行・修飾ロジックは変更しない。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ 選択は構造 (merged diff → startId → BFS) + evidence join のみ。テストの意味的十分性は判定しない。D-1/D-5 はこの境界を利用者向けに明文化するもの。

**違反なし。Complexity Tracking への記載不要。**

### Engineering Hygiene Gates

- [x] **前提検証 (Cat6)**: 023 の配管が再利用可能な形で実在することを実コードで確認 — `resolveMergeBase` / `FETCH_DEPTH_HINT` (src/baseline.ts:142-183, export 済み)、`classifyBaseRef` (src/baseline.ts:427)、`getGitDiffFiles(rootDir, baseSha?)` (src/diff.ts:48、optional 引数)。`src/commands/impact.ts:65` が #306 F7 後唯一の raw `--format` であること、`--diff` エントリが `line: 1` で生成されること (impact.ts:193 — 016 契約の `line: 0` は drift)、`TRACE_NO_SHARDS_GUIDANCE` ガードが scan より前 (impact.ts:119-122) にあることを確認。`nonOptionValue` (src/commands/shared.ts:24) が `--base` 値ガードにそのまま使えることを確認。
- [x] **ID 衝突 (Cat6)**: 新規 spec 番号 024 は既存 (003〜023) と衝突なし。本 feature の FR-001〜013 は `024-impact-base-ref/FR-NNN` に qualified 化され既存 spec と衝突しない。コード側 `@impl` タグ付けは tasks で扱う。
- [x] **SSOT ペア (Cat2)**: (a) merged diff の定義 — `getGitDiffFiles(rootDir, baseSha?)` 単一関数を check と共有 (agreement (i) の構造的保証。impact 独自の diff 取得を実装しない)。(b) fetch-depth ヒント — `FETCH_DEPTH_HINT` 定数 (src/baseline.ts) を import して共有。「does not resolve」見出しの組み立ては impact 側にも現れるが、check の見出しは stage-label 付き (PR #304 F3) で意図的に別文であるため、共有するのはヒント定数のみ (data-model.md §4)。(c) `TRACE_NO_SHARDS_GUIDANCE` / rejection 定数は既存 SSOT を不変で再利用。
- [x] **CLI 規約 (Cat5)**: 新フラグ `--base <ref>` は値必須 option + parse 時値ガード (`nonOptionValue`)。エラーは text/json 対称 (どちらも stderr のみ、JSON なし)。`--format` は `.choices()` で兄弟コマンドの規約に合流 (D-7)。exit code は impact の既存契約 (0 / 1 — impact に exit 2 はない) を不変に維持し、`--base` の全異常系を exit 1 ファミリーに位置づける (contracts/cli-impact-base.md §3)。
- [x] **走査仕様 (Cat7)**: startId 解決 (`resolveStartIds`)・BFS (`impact()`)・`--tests` の evidence join は一切変更しない — 変わるのは入力の merged diff 集合のみ。dedup は path 文字列一致 (023 の `-z`/quotePath 統一を継承)。削除ファイルの「解決しない → 寄与しない」は resolveStartIds の既存挙動そのもので、新しい分岐を足さない (D-1)。

## Project Structure

### Documentation (this feature)

```text
specs/024-impact-base-ref/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output (R1–R9 decision records)
├── data-model.md        # Phase 1 output (再利用台帳 / コマンドフロー / SSOT)
├── quickstart.md        # Phase 1 output (CI テスト選択レシピ / fallback パターン / troubleshooting)
├── contracts/
│   └── cli-impact-base.md  # --base の CLI 契約 (016 §1.3/§2 の拡張 / 検証順 / exit code / JSON 不変条件 / 相互作用表)
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
src/
└── commands/
    └── impact.ts                # [変更 — 本 feature の唯一の実装対象ファイル]
                                 #   --base <ref> option (nonOptionValue 値ガード, FR-001)
                                 #   --base requires --diff 検証 (rejection 後・排他前, FR-002)
                                 #   classifyBaseRef + resolveMergeBase (scan 前 fast fail, FR-004/005)
                                 #   getGitDiffFiles(rootDir, baseSha) 配線 (FR-006)
                                 #   --format .choices() 化 (FR-010)
                                 #   D-9 staleness 警告 (FR-012)

(無変更 — spec.md Out of Scope で pin):
src/diff.ts, src/baseline.ts, src/graph/traverse.ts, src/commands/check.ts,
src/commands/shared.ts (nonOptionValue は import のみ)

tests/
├── impact-base-ref.test.ts      # [新規] US1/US2/US3 — merged diff でのテスト選択、union、
│                                #        削除 (D-1)、全未解決 (D-4)、fail-closed (D-2)、
│                                #        --format choices (D-7)、D-9 警告、--base HEAD 退化
├── check-baseline-diff.test.ts  # [変更] US4 agreement suite (:576-609) を --base variant で拡張 (FR-013)
└── helpers.ts                   # [変更] trace shard 付き base-branch fixture (023 ヘルパーの合成)

docs / templates (実装タスクとして更新 — tasks.md Phase 6):
├── README.md / README.ja.md                       # [変更] CI 節にテスト選択レシピ (fallback パターン込み)
├── docs/commands.md                               # [変更] impact 節に --base / consumer rule / exit・fallback 規則
├── templates/skills/artgraph-impact/SKILL.md      # [変更] --base の案内 + consumer rule (+ per-agent 配布複製 5 ミラー)
├── templates/skills/_shared/output-schema.md      # [変更] impact 節: --base 時の testsToRun 意味論 (merged set 上)、
│                                                  #        D-9 staleness "exclude" 相互作用の注記
├── templates/agent-context/agents-md-snippet.md   # [変更] CI テスト選択行 (--base variant)
└── AGENTS.md (repo root)                          # [変更] Common workflows の impact --tests 行に --base を追記
```

**Structure Decision**: 実装変更は `src/commands/impact.ts` 1 ファイルに閉じる。merge-base 解決・merged diff・値ガード・shard ガードはすべて既存 export (`src/baseline.ts` / `src/diff.ts` / `src/commands/shared.ts`) の import で賄い、共有配管には 1 行も手を入れない — agreement (i) は「同じ関数を呼ぶ」ことによる構造的保証であり、テストはそれを pin する役 (FR-013)。

## Phase Breakdown

- **Phase 0 (research)**: 完了 — research.md R1–R9。承認済み決定 D-1〜D-9 (2026-07-15/16, issue #305) を decision record 化。
- **Phase 1 (design)**: 完了 — data-model.md (再利用台帳 / コマンドフロー / SSOT)、contracts/cli-impact-base.md (外部契約 — 016 §1.3/§2 の拡張 + 023 契約参照)、quickstart.md (CI レシピ / fallback / 検証手順)。
- **Phase 2 (tasks)**: tasks.md — TDD (Red → Green → Refactor) 順の実装タスク。parse 層 (--format choices / --base ガード) → コマンド配線 (US1) → union 意味論 (US2) → fail-closed (US3) → D-9/回帰固定 → docs/skills/templates 追随 → dogfood。

## Complexity Tracking

> Constitution Check に違反なし。記載不要。

## Follow-up

- **trace-join 回復 (別 issue 起票候補)**: merged diff の未解決 path を `ownerFilePath` (src/trace/report.ts) で trace evidence の node id に直接 join し、「削除ファイルが exercise していた REQ のテスト」を選択に加える。現在グラフを経由しないため baseline なしで実装でき、D-1 の選択限界を狭められる — research.md R1 の Alternatives 参照。本 feature の出力契約 (testsToRun の形) はこの拡張と互換。
- **016 契約の全面改訂はしない**: `specs/016-impact-plan-symbol-level/contracts/cli-flags.md` の drift (`line: 0` / 撤去済み channel) は forward-pointer 注記 (§1.3) と本 feature 契約 §1.2 の明示で扱い、016 文書の書き直しは行わない。
