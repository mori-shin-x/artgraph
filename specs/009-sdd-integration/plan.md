# Implementation Plan: SDD ツールワークフロー統合

**Branch**: `feat/sdd-workflow` | **Date**: 2026-06-23 | **Spec**: [./spec.md](./spec.md)

**Input**: Feature specification from `specs/009-sdd-integration/spec.md`

## Summary

`artgraph integrate <tool>` サブコマンドを新設し、`.specify/` を検出した場合は Spec Kit Extension 一式（`.specify/extensions/spectrace/` と `.specify/extensions.yml` の hook 登録）を、`.kiro/` を検出した場合は Steering file（`.kiro/steering/spectrace.md`）を、それぞれ冪等に生成・更新する。Clarifications で確定した 5 設計判断（プロバイダ抽象 / 共通 agent-guidance generator / Spec Kit Extension スキーマのコード固定 / `--gate` 宣言型セマンティクス / `init --integrate=<tools>` の one-shot）を 3 レイヤアーキテクチャに落とし込み、TDD（vitest）で全レイヤを駆動する。`integrate list` で利用可能プロバイダ＋検出/導入状況も表示可能にする（ユーザー要望）。

> **CLI 名の整合**: spec 本文は `spectrace` を多用するが、本リポジトリの実 CLI は `artgraph`（constitution §技術基盤と制約、`packages/artgraph/package.json#bin`）。plan/実装は **`artgraph`** を正とし、Extension 内部の slash command も `artgraph.*` 名前空間で生成する。"spectrace" は Extension ディレクトリ名（`.specify/extensions/spectrace/`）と Steering file 名（`spectrace.md`）に残し、製品コードネームとして可視性を維持する（FR-001/008 の文言に整合）。

## Technical Context

**Language/Version**: TypeScript 5.8 / Node.js >= 20（ESM）

**Primary Dependencies**: commander 13（CLI）、`yaml`（新規追加、4.x）、glob 11、`node:fs`/`node:path`/`node:crypto` 標準ライブラリ

**Storage**: ファイルシステムのみ（`.specify/extensions.yml`、`.specify/extensions/spectrace/`、`.kiro/steering/spectrace.md`、`packages/artgraph/templates/integrate/`）

**Testing**: vitest 4.1（unit + CLI integration、tmpdir フィクスチャ）

**Target Platform**: Linux / macOS / Windows（POSIX path 前提の処理は `node:path` で抽象化）

**Project Type**: CLI（既存 monorepo `packages/artgraph` 内に統合）

**Performance Goals**: `integrate <tool>` 実行は 1 秒以内に完了（SC-004）、検出失敗は即時 exit

**Constraints**:
- すべての書き込みは atomic（temp ファイル → rename）— FR-007
- 冪等性保証 — FR-004
- 部分適用ゼロ（途中失敗時は元の状態に戻す）— edge case
- LLM 推論なし（constitution I.）

**Scale/Scope**: 本機能のみで TypeScript 約 1,200〜1,800 行、テスト約 800〜1,200 行を想定。テンプレート（YAML + Markdown）4〜6 ファイル

## Constitution Check

*GATE: Phase 0 前に必須通過。Phase 1 設計後に再評価。*

| 原則 | 評価 | 根拠 |
|---|---|---|
| I. 決定的グラフ第一 — NON-NEGOTIABLE | ✅ Pass | `integrate` は固定テンプレート + 凍結スキーマ + 固定 slug のみで生成。LLM 不使用。CLI 判定出力も決定的 |
| II. 単一型付き4層グラフ | ✅ Pass | 本機能はグラフへ新ノード/エッジ型を追加しない。設定ファイル書き込みのみで、`req`/`doc`/`symbol`/`test` モデルに変更なし |
| III. Spec が ID 所有 — NON-NEGOTIABLE | ✅ Pass | 本機能は要求 ID を発行・claim しない。既存の `@impl FR-NNN` モデルに干渉しない |
| IV. SDD ツール ID 直接利用 | ✅ Pass | Spec Kit / Kiro の既存 ID を utilize するための統合機能。独自 ID 層を持ち込まない |
| V. 構造整合のみ保証 — NON-NEGOTIABLE | ✅ Pass | 生成された Extension / Steering の「意味的妥当性」（Hook が期待動作をするか）は本機能のスコープ外。生成された YAML/Markdown が構造的にスキーマ準拠であることのみ保証 |

**Initial Constitution Check**: ✅ All gates pass（Phase 0 へ進む）

## Project Structure

### Documentation (this feature)

```text
specs/009-sdd-integration/
├── plan.md              # This file
├── research.md          # Phase 0: 設計上の未確定事項解決
├── data-model.md        # Phase 1: 中核データ構造
├── quickstart.md        # Phase 1: 検証ガイド
├── contracts/           # Phase 1: 各レイヤのコントラクト
│   ├── integrate-cli.md
│   ├── integration-provider.md
│   ├── speckit-extension-schema.md
│   └── agent-guidance.md
├── checklists/
│   └── requirements.md  # /speckit-specify で生成済み
├── spec.md              # /speckit-specify で生成済み
└── tasks.md             # /speckit-tasks で生成（本コマンドの出力ではない）
```

### Source Code (repository root, monorepo `packages/artgraph/`)

```text
packages/artgraph/src/
├── cli.ts                            # 既存。`integrate` コマンド & `init --integrate` フラグを追記
├── init.ts                           # 既存。`detectProject` を providers から呼び直し
├── integrate/
│   ├── index.ts                      # `runIntegrate(rootDir, tool, opts)` 公開エントリ
│   ├── registry.ts                   # 利用可能 provider の登録テーブル
│   ├── runner.ts                     # provider 経由の install/uninstall/list ディスパッチ
│   ├── guidance.ts                   # 共通 agent-guidance generator（Kiro / 将来の OpenSpec）
│   ├── speckit-yaml.ts               # `.specify/extensions.yml` の atomic 編集
│   ├── atomic-write.ts               # temp → rename 書き込み util
│   ├── schemas/
│   │   └── speckit-1.0.ts            # 凍結済み Spec Kit Extension スキーマ（FR-001）
│   ├── providers/
│   │   ├── types.ts                  # IntegrationProvider インターフェース
│   │   ├── speckit.ts                # SpecKitProvider 実装
│   │   └── kiro.ts                   # KiroProvider 実装
│   └── templates.ts                  # テンプレートファイル loader
└── types.ts                          # 既存。IntegrationProvider 関連型を追記

packages/artgraph/templates/integrate/
├── speckit/
│   ├── extension.yml                 # Spec Kit Extension マニフェスト雛形
│   ├── README.md                     # Extension の人間向け説明
│   └── commands/
│       ├── artgraph.scan-reconcile.md  # after_tasks 用 slash command
│       ├── artgraph.check-diff.md      # after_implement 用 slash command
│       └── artgraph.check-gate.md      # before_implement 用 slash command (--gate モード)
└── kiro/
    └── spectrace.md                  # Steering file 雛形

packages/artgraph/tests/
├── integrate/
│   ├── registry.test.ts
│   ├── guidance.test.ts
│   ├── speckit-yaml.test.ts
│   ├── atomic-write.test.ts
│   ├── providers/
│   │   ├── speckit.test.ts           # SpecKitProvider unit
│   │   └── kiro.test.ts              # KiroProvider unit
│   └── runner.test.ts                # 統合（複数 provider まとめ）
├── integrate-cli.test.ts             # E2E: `artgraph integrate <tool> [--gate] [--no-gate] [--force]`、`list`、`init --integrate=…`
└── fixtures/integrate/
    ├── specify-empty/                # `.specify/extensions.yml` 既存・空 hooks
    ├── specify-with-other/           # 他 Extension が既に hook 登録済み
    ├── specify-already-installed/    # spectrace Extension 導入済み
    ├── kiro-empty/                   # `.kiro/steering/` のみ
    ├── kiro-installed/               # spectrace.md 既存
    └── neither/                      # 検出失敗ケース
```

**Structure Decision**: 既存 `packages/artgraph/` モノパッケージに `src/integrate/` サブモジュールを増設する単一プロジェクト構成を採用。テンプレート資材は既存 `templates/skills/` と同階層の `templates/integrate/` に置き、`package.json#files` のホワイトリスト（`["dist", "templates"]`）でそのまま配布物に含まれる。テスト fixture は既存 `tests/fixtures/` パターンに揃え、`tests/integrate/` に layer 別 unit、ルートに `integrate-cli.test.ts` で E2E を集約する。

## Phase 0: Research（→ research.md）

以下 6 件の未確定事項を Phase 0 で解決済み。詳細は [research.md](./research.md)。

- **R0**: CLI 名前統一（spec の `spectrace` vs 実バイナリ `artgraph`）の扱い → `artgraph` を実装で採用、`spectrace` は Extension 名とディレクトリ名のみ残す
- **R1**: Spec Kit Extension `extensions.yml` の確定スキーマ（既存 `agent-context` 観察ベース） → schema_version "1.0"
- **R2**: Spec Kit Extension `commands/*.md` の確定フォーマット → frontmatter `description` + 本文（Behavior / Execution セクション）
- **R3**: YAML ライブラリ選定 → `yaml` (4.x) を新規依存に追加（comment 保持・最小 surface）
- **R4**: Kiro Steering file の慣習フォーマット → frontmatter `inclusion` + Markdown 本文
- **R5**: Atomic 書き込み戦略 → `node:fs.writeFileSync` を `temp` → `rename` パターンに包む util を内製

## Phase 1: Design & Contracts

詳細は次の成果物に分割。

- **[data-model.md](./data-model.md)** — 中核データ構造（`IntegrationProvider` インターフェース、`DetectionResult` 拡張、`IntegrateResult`、`HookEntry`、`GuidanceWriteRequest`）
- **[contracts/integration-provider.md](./contracts/integration-provider.md)** — `IntegrationProvider` インターフェース、ライフサイクル契約
- **[contracts/speckit-extension-schema.md](./contracts/speckit-extension-schema.md)** — 凍結 Spec Kit Extension スキーマ v1.0（`extension.yml`、hook entry、commands/）
- **[contracts/agent-guidance.md](./contracts/agent-guidance.md)** — 共通 agent-guidance generator のシグネチャ・冪等条件
- **[contracts/integrate-cli.md](./contracts/integrate-cli.md)** — CLI コマンド表面（`integrate <tool>` / `integrate list` / `init --integrate`）
- **[quickstart.md](./quickstart.md)** — エンドツーエンド検証手順（empty repo → integrate speckit → re-run no-op → integrate kiro → init --integrate=all）

### Phase 1 完了後の Constitution 再評価

| 原則 | 再評価 | 根拠 |
|---|---|---|
| I. 決定的グラフ第一 | ✅ Pass | provider/generator/yaml-editor すべてが入力 → 出力の純粋関数として実装される（fs 副作用は最終ステップのみ） |
| II. 単一型付き4層グラフ | ✅ Pass | data-model.md に追加された型はすべて Integration 関連でグラフ型とは独立 |
| III. Spec が ID 所有 | ✅ Pass | 本機能内で要求 ID を生成・claim しない |
| IV. SDD ツール ID 直接利用 | ✅ Pass | 既存 SDD ツールの ID 体系を変更しない |
| V. 構造整合のみ保証 | ✅ Pass | 生成物の構造（schema 準拠、ファイル存在、YAML 妥当性）のみ保証。「Hook 発火時に意図通り動くか」は別レイヤ |

**Post-design Constitution Check**: ✅ All gates pass

### Phase 1: Agent context update

`CLAUDE.md` の `<!-- SPECKIT START -->` / `<!-- SPECKIT END -->` ブロック内の plan 参照を `specs/009-sdd-integration/plan.md` に更新する（`/speckit-agent-context-update` が後続フックで実行可能）。

## TDD 計画（ユーザー指定）

constitution「品質ゲート」と整合させ、各 task は以下の Red → Green → Refactor サイクルを順守する。`tasks.md` の各タスクは独立に PR 化可能で、テスト先行を絶対条件とする。

| Layer | 先に書くテスト | 通すコード |
|---|---|---|
| atomic-write util | temp → rename / 途中失敗時に元ファイル不変 / 権限エラー | `atomicWriteFile(path, content)` |
| speckit-yaml editor | 空 yaml に追記 / 他 Extension 共存 / 冪等再実行 / `--no-gate` 削除 | `addHookEntry`, `removeHookEntry`, `addInstalled`, `parseExtensionsYaml`, `serializeExtensionsYaml` |
| schemas/speckit-1.0 | 既知の妥当 entry が validate を通る / 未知フィールドで fail | `validateExtensionYaml`, `validateHookEntry` |
| guidance generator | 新規書き込み / 既存ファイル検出（no-op） / `--force` 上書き / 親 dir 自動作成 / 書き込み権限なしで失敗 | `writeGuidanceFile(req)` |
| KiroProvider | detect: `.kiro/` 存在で true / 不在で false / generate: テンプレートから期待 content / install: guidance generator 経由 / uninstall: ファイル削除 | `KiroProvider` |
| SpecKitProvider | detect: `.specify/` で true / generate: extension.yml + commands/ 期待 content / install: yaml 追記 + ディレクトリ生成 / `--gate` 付きで before_implement 追加 / `--no-gate` 再実行で削除 / uninstall: installed entry 削除 + hook 削除 + dir 削除 | `SpecKitProvider` |
| registry / runner | provider 登録 / 未知 tool で fail / `list` 出力 / detect ↔ install 状態の整合 | `getProvider`, `listProviders`, `runIntegrate` |
| CLI `integrate <tool>` | dry-run なし即時実行 / 非ゼロ exit on detect 失敗 / 出力に「生成」「変更」「次の推奨」が含まれる | commander サブコマンド配線 |
| CLI `integrate list` | 検出済み + 導入済み + 未導入のプロバイダ表 / JSON 出力 | commander サブコマンド配線 |
| CLI `init --integrate=...` | one-shot 統合 / `--integrate-gate` の透過 / 未検出 tool で警告のみ（init 全体は成功） / 出力にツール別セクション | `runInit` の `integrations` オプション拡張 |
| init 案内表示 | `.specify/` 検出 & 未導入で案内表示 / 導入済みで非表示 / 両ツール検出で 2 件案内 | `runInit` の text formatter 修正 |
| E2E（integrate-cli） | quickstart シナリオを e2e で再現（空 repo → speckit 統合 → 再実行 no-op → kiro 統合 → uninstall → list） | 全部品の組み合わせ |

各 task は必ず「失敗するテストを先にコミット → 通す実装 → コミット」の順を取る。`/speckit-tasks` で `tasks.md` に展開する際は、本表の順序（依存関係: atomic-write → speckit-yaml → schemas → guidance → providers → registry/runner → CLI → init → e2e）をそのまま反映させる。

## Complexity Tracking

Constitution Check で violation なし。本機能はグラフ・ID・lock いずれにも触れず、constitution の Non-Negotiable 原則 (I, III, V) すべてに対して干渉点ゼロ。`yaml` 依存の新規追加は唯一のスコープ拡大だが、`extensions.yml` の正確な操作を `JSON.parse` + 手書きで行うとコメント保持と order 保証が困難なため、ライブラリ採用が決定的整合性（原則 I）と冪等性（FR-004）の両方を担保する最小コストの選択肢である。
