# Implementation Plan: impact CLI 再設計 (file-only / --from-tasks) + plan-coverage 新設

**Branch**: `feat/reinvent-impact-cli` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/014-reinvent-impact-cli/spec.md`

## Summary

artgraph のコア価値「変更漏れを起こさない」の中で空いている方向 ── **「人間が tasks.md を書いたとき、その変更が既存仕様 (REQ / doc / file) に与える暗黙の波及を見落としていないか」** を埋める。具体には:

1. `artgraph impact` CLI を **file-only に絞り直し**、`--from-tasks` / `--from-plan` を追加して入力契約を Skill description と整合させる(US2)
2. 新 CLI `artgraph plan-coverage` を **「`impact --from-tasks` の affectedReqs − tasks.md / plan.md / spec.md の REQ-ID mention = 暗黙波及」のシンプルなセマンティクス** で追加(US1)
3. `artgraph-impact` Skill description を正直化し、`artgraph-plan-coverage` Skill を新設(US3, US4)
4. SDD 統合テンプレ (Spec Kit / Kiro) に `Files:` 規約と REQ-ID mention 規約の **推奨** を追記(US5)。enforcement は spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) に分離
5. docs / README の Skills 表を 8 種に更新(US6)

**アプローチの核**: グラフ生成・traverse 本体 (`src/graph/traverse.ts:impact()`) には**触れない**。`plan-coverage` は `impact()` を file 起点で呼び出し、その出力 `affectedReqs` に対してテキスト境界マッチで mention 検査するだけ。新規ロジックは「SDD ファイル(tasks/plan)からの file 抽出」「REQ-ID mention 検出」の 2 つのデterministic な変換層のみ。

**PR 構成**: spec.md の Assumptions に明記の通り、本 spec は **単一 PR でロックステップ merge** する。US2 (CLI の REQ-ID 撤去) と US3 (Skill 改訂) を分割すると merge 順序によって Skill と CLI が中間状態で整合しない時間が発生するため。

## Technical Context

**Language/Version**: Node.js >= 22, TypeScript with `"type": "module"` ESM(既存)

**Primary Dependencies**: `commander` / `vitest` / 既存 `src/parsers/markdown.ts` の再利用 ── **新規依存なし**。`unified` + `remark-parse` で tasks.md / plan.md / spec.md を AST 化する選択肢もあるが、`Files:` 抽出と REQ-ID 境界マッチはどちらも単純な行・正規表現処理で十分なので、依存を増やさずに `src/parsers/sdd-files.ts` と `src/plan-coverage/mention.ts` で完結させる。

**Storage**: ファイルベース(既存 `.artgraph.json` / `.trace.lock` / `templates/`)。新規ストアなし。`.artgraph.json` に `planCoverage` セクションを追加する(`requireFilesSection: boolean`, デフォルト `false`)。

**Testing**: vitest(ユニット / 統合 / E2E)。既存 `tests/impact-cli.test.ts` / `tests/check.test.ts` パターンを継承して新規テストを追加。

**Target Platform**: Linux / macOS / Windows(Node 22 が動く全プラットフォーム)。CI は GitHub Actions Ubuntu。

**Project Type**: CLI ツール(単一 Node パッケージ + Skills/Templates 配布物)。

**Performance Goals**: `plan-coverage` 単独実行は 1 秒以内(中規模 repo: REQ 100 件、tasks.md 50 task block、graph node ~3000 件を想定)。`impact()` の呼び出しは file 数に比例する forward BFS なので、起点 file が少数(典型 5–20 件)であればコスト低。mention 検出は全 REQ-ID × 3 ファイル(tasks/plan/spec)の linear regex で計算量 O(REQ 数 × 入力文字数)。

**Constraints**:
- ユーザー作成・編集ファイル(`tasks.md` / `plan.md` / `spec.md`)を**破壊しない**。`plan-coverage` は **読み取り専用**で graph / lock / SDD ファイルを書き換えない
- `impact()` 関数本体は変更しない(`src/graph/traverse.ts:11`)。`resolveStartIds` は `resolveFileStartIds` にリネームし REQ-ID / `doc:` prefix 解決ロジックを削除
- Constitution v1.1.0 準拠(後述 Constitution Check)
- 既存 4 入力経路の `impact` から REQ-ID を撤去するが、未リリースのため移行ガイド不要 ── 撤去は専用エラー + 4 経路案内で済ます

**Scale/Scope**:
- 新規 `src/` ファイル 4 件(`parsers/sdd-files.ts`, `plan-coverage/index.ts`, `plan-coverage/mention.ts`, `plan-coverage/spec-resolver.ts`)
- 改修 `src/` ファイル 3 件(`cli.ts`, `graph/traverse.ts`, `config.ts`)
- 新規 / 改修テスト ~6 件
- LOC 合計 ~600–900(うち tests 半分)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本 feature への該当 | 判定 | 根拠 |
|---|---|---|---|
| **I. 決定的グラフ第一 (NON-NEGOTIABLE)** | `plan-coverage` は graph traversal(`impact()`)+ 正規表現境界マッチの組合せで、LLM 推定や統計ヒューリスティックを使わない | ✅ PASS | `impact()` 本体は既存決定的ロジック。mention 検出は `\bREQ-\d+\b` 相当の境界マッチで決定的 |
| **II. 単一型付き4層グラフ** | 新規ノード型 / エッジ型の追加なし | ✅ PASS | `plan-coverage` は既存 4 ノード型(`req` / `doc` / `file` `symbol` / `test`)と既存エッジを参照するだけ |
| **III. Spec が ID を所有 (NON-NEGOTIABLE)** | `plan-coverage` は読み取り専用、`@impl` 自動生成・lock 書き換え・REQ-ID 派生なし | ✅ PASS | CLI 出力のみ、graph / lock / SDD ファイル全てに書き込まない |
| **IV. SDD ツール ID 直接利用** | tasks.md / plan.md / spec.md 内の REQ-ID を**そのまま**比較対象として使う | ✅ PASS | 独自 ID 派生レイヤを設けない。Spec Kit / Kiro が定めた ID 表記をそのまま境界マッチで比較 |
| **V. 構造整合のみ保証 (NON-NEGOTIABLE)** | `plan-coverage` は「REQ-X が affected だが mention されていない」という構造的事実だけを報告し、「実際に対応が必要か」の意味判定は人間に委ねる | ✅ PASS | 検知後 3 経路 (mention / `--ignore` / 将来 strict) はすべて人間の判断を介す設計。Skill も結果提示のみで自動判定しない |

**Gate**: ✅ All NON-NEGOTIABLE principles pass without justified deviations.

**Complexity Tracking**: 空(justify する逸脱なし)。

## Project Structure

### Documentation (this feature)

```text
specs/014-reinvent-impact-cli/
├── spec.md              # 完了 (この PR で先行作成済)
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0: 設計判断の根拠 (forward vs reverse, mention semantics, Spec Kit canonical lookup, Kiro 不可能性)
├── data-model.md        # Phase 1: ImplicitImpact / FileExtractionStrategy / MentionDetector / PlanCoverageConfig のエンティティ定義
├── quickstart.md        # Phase 1: 各 US の手動 E2E 検証手順
├── contracts/           # Phase 1: CLI フラグ / JSON 出力スキーマ / SDD パース戦略
│   ├── cli-flags.md
│   ├── plan-coverage-json.md
│   ├── sdd-files-parser.md
│   └── mention-semantics.md
└── tasks.md             # Phase 2 output (/speckit-tasks 出力 — このコマンドでは作成しない)
```

### Source Code (repository root)

```text
# 既存 (改修対象)
src/
├── cli.ts                              # impact subcommand: 引数仕様を file-only に。REQ-ID 入力時の専用エラー。--from-tasks / --from-plan 追加。新規 plan-coverage subcommand 追加
├── config.ts                           # planCoverage セクション追加 ({ requireFilesSection: boolean })
└── graph/
    └── traverse.ts                     # resolveStartIds → resolveFileStartIds rename + REQ-ID/doc: 解決パス削除 (impact() 本体は無変更)

# 新規追加
src/
├── parsers/
│   └── sdd-files.ts                    # tasks.md / plan.md から file 群を抽出する二段戦略 (Files: セクション優先 → regex フォールバック)。--from-tasks / --from-plan / plan-coverage の 3 経路で共有
└── plan-coverage/
    ├── index.ts                        # plan-coverage 主処理 (file抽出 → impact() → affectedReqs → mention 引算 → ImplicitImpact[])
    ├── mention.ts                      # tasks/plan/spec のテキスト union から REQ-ID 境界マッチ検出 (ラベル無依存)
    └── spec-resolver.ts                # --spec 省略時の SPECIFY_FEATURE_DIRECTORY env → .specify/feature.json#feature_directory 探索

# 配布物 (改修 + 新規)
templates/
├── skills/
│   ├── artgraph-impact/SKILL.md        # description 正直化 (planning/designing/scoping 削除) + Mode (b) REQ-ID 抽出指示削除 + --from-tasks 例追加
│   └── artgraph-plan-coverage/         # 新規 Skill ディレクトリ
│       └── SKILL.md                    # description: 暗黙波及検知のみ約束。100 行以下、_shared/install-check.md 参照
└── integrate/
    ├── speckit/
    │   ├── extension.yml               # (変更なし — hook 追加は spec 015 候補で扱う)
    │   └── README.md                   # Files: 規約と REQ-ID mention 規約の推奨を追記
    └── kiro/
        └── artgraph.md                 # 同等のガイダンス追記

# ドキュメント
docs/
└── skills-guide.md                     # artgraph-impact 節改訂 + artgraph-plan-coverage 節新規追加 + 検知後 3 経路の説明

README.md                               # Skills 表を 8 種に更新

# テスト (既存パターンに追加)
tests/
├── impact-cli.test.ts                  # 改修: REQ-ID 入力時の専用エラー、--from-tasks / --from-plan の E2E、resolveFileStartIds の単体
├── plan-coverage.test.ts               # 新規: implicitImpacts 計算、mention 引算、--gate exit code、--ignore one-shot
├── sdd-files-parser.test.ts            # 新規: Files: セクション抽出と regex フォールバックの正解率
├── mention-detector.test.ts            # 新規: \b 境界マッチ (REQ-3 vs REQ-30 誤判定防止) + markdown link 形 + ラベル形 (Considered:/Affected:/[REQ-X])
├── skills-templates.test.ts            # 改修: artgraph-plan-coverage の SKILL.md 制約 (100 行以下、_shared 参照、allowed-tools)
└── plan-coverage-integration.test.ts   # 新規: 実際の Spec Kit 風 spec dir fixture で E2E (auto-detect / --spec 明示 / Kiro エラー)
```

**Structure Decision**: 単一プロジェクト(`src/` + `tests/` + `templates/` + `docs/`)。Constitution「Package layout: 単一パッケージ」を厳守。新規ファイルは既存層のパターンを継承する:

- `src/parsers/sdd-files.ts` は既存 `src/parsers/markdown.ts` と同列に配置(parsing は `parsers/` に集約)
- `src/plan-coverage/` ディレクトリは既存 `src/integrate/` パターンを踏襲(機能群を 1 サブディレクトリにまとめる)
- 新 Skill は既存 `templates/skills/<name>/SKILL.md` 形式に従う
- 新規テストは既存 `tests/<feature>.test.ts` 命名規則を踏襲

**Skills 言語ポリシー**(spec 012 FR-029 継承): `templates/skills/artgraph-plan-coverage/SKILL.md` は **英語** で記述する。`docs/skills-guide.md` / `README.md` への追記は **日本語可**(現行 docs の言語を維持)。

## Phasing

本 spec の作業は単一 PR でロックステップ merge するが、PR 内部での作業順序は以下を推奨する(レビュー時の理解容易さのため):

| Phase | 内容 | 対象 FR |
|---|---|---|
| 0. 共通基盤 | `src/parsers/sdd-files.ts`(file 抽出二段戦略)新規追加 + 単体テスト | FR-005, US2 acceptance 3–4 |
| 1. impact 改修 | `src/cli.ts` impact + `src/graph/traverse.ts` resolveStartIds 改修 + テスト更新 | FR-001 〜 FR-008 |
| 2. plan-coverage 本体 | `src/plan-coverage/` 一式 + `src/config.ts` 追加 + テスト | FR-013 〜 FR-020 |
| 3. Skills 更新 | `templates/skills/artgraph-impact/SKILL.md` 改訂 + `artgraph-plan-coverage/SKILL.md` 新規 + skills-templates test 更新 | FR-009 〜 FR-012, FR-021 〜 FR-024 |
| 4. SDD 統合テンプレ | `templates/integrate/speckit/README.md` + `templates/integrate/kiro/artgraph.md` 更新 | FR-025 〜 FR-027 |
| 5. ドキュメント | `docs/skills-guide.md` + `README.md` 更新 | FR-028 〜 FR-030 |
| 6. E2E 統合 | `tests/plan-coverage-integration.test.ts` で Spec Kit 風 fixture E2E | SC-001 〜 SC-010 確認 |

各 phase は前 phase に依存するが、commit を分けて履歴追跡しやすくする(squash merge 時は 1 commit に潰す)。

## Complexity Tracking

> 空 — Constitution 原則の逸脱なし。

(該当なし)
