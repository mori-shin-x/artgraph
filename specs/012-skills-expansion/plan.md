# Implementation Plan: Agent-Native Toolkit (Skills / Hooks / Plugin / SDD Integrations)

**Branch**: `docs/skills-expansion` | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-skills-expansion/spec.md`

## Summary

artgraph を Claude Code および周辺 AI エージェントに対して「セットアップ・開発中・検証ゲート」全フェーズでネイティブに動くツール群へ拡張する。

**アプローチの核**: CLI コア (グラフ構築 / `check` / `lock` / `rename` 等の決定的ロジック) には触れず、**配布物 (`templates/skills/`, `templates/hooks/`, `templates/agent-context/`, `templates/integrate/openspec/`, `.claude-plugin/*`) を増やし、`init` / `integrate` のフラグを束ねる**だけで、28 個の Functional Requirement と 9 個の Success Criteria を達成する。これにより Constitution の NON-NEGOTIABLE 原則 (I 決定性 / III ID 所有 / V 構造整合のみ保証) と自然に整合する。

実装は 4 PR (P0/P1/P2/P3) に分割し、それぞれを独立にマージ可能とする。親 issue #98 で束ねる。

## Technical Context

**Language/Version**: Node.js >= 22, TypeScript with `"type": "module"` ESM (既存)

**Primary Dependencies**: `ts-morph` / `unified` + `remark-parse` / `yaml` (eemeli) / `commander` / `vitest` — **新規追加なし**。`.claude/settings.json` の merge は標準 JSON で完結、Plugin manifest 生成はテンプレファイル配置のみ。

**Storage**: ファイルベース (既存 `.artgraph.json`, `.trace.lock`, `templates/`)。新規ストアなし。

**Testing**: vitest (ユニット / 統合 / E2E)。既存 `tests/integrate-cli.test.ts` パターンを継承して新規テストを追加。

**Target Platform**: Linux / macOS / Windows (Node 22 が動く全プラットフォーム)。CI は GitHub Actions Ubuntu。

**Project Type**: CLI ツール (単一 Node パッケージ + Skills/Templates 配布物)。

**Performance Goals**: `artgraph-setup` Skill の全フロー (npm install + init + integrate + skills) は数十秒〜1 分以内。Stop hook (`artgraph check --gate --diff`) のレイテンシは < 2 秒。

**Constraints**:
- 既存ユーザー設定 (`.claude/settings.json`, CLAUDE.md, AGENTS.md, `.specify/extensions.yml`) を破壊しない (HTML コメント境界 or 専用セクションのみ更新)
- 配布物 single source of truth: `templates/skills/` を npm 配布と Plugin 配布で共有 (symlink 不可)
- 後方互換: `init` 既存挙動を変えない (新オプション追加のみ)
- 既存 4 Skill ファイルパス (`templates/skills/artgraph-{plan,verify,coverage,rename}.md`) は維持または移行ガイド付き

**Scale/Scope**:
- 既存 ~50 個の `src/` ファイルに対し、新規追加は数 10 ファイル
- 新規 + 改修で ~2000–3000 LOC 程度
- テスト 5–10 ケース追加

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本 feature への該当 | 判定 | 根拠 |
|------|---------------------|------|------|
| **I. 決定的グラフ第一 (NON-NEGOTIABLE)** | グラフ生成・edge 派生・drift 判定ロジックは無変更 | ✅ PASS | 本 feature は配布物・integration 層のみ。CLI コア (`src/scanner.ts`, `src/check.ts`, `src/lock.ts` 等) には触れない。Skill が LLM 推論で得た結論を CLI 出力に混入させる経路は設けない (Skill は CLI を呼ぶラッパー) |
| **II. 単一型付き4層グラフ** | 新規 ノード型 / エッジ型の追加なし | ✅ PASS | OpenSpec integration で扱う ID も既存 `req` ノード型にマップ (`docs/architecture.md` §11 OpenSpec 項に従い slug 派生) |
| **III. Spec が ID を所有 (NON-NEGOTIABLE)** | Skill / Hook / Plugin が `@impl` を自動生成しない | ✅ PASS | `artgraph-setup` Skill は `init` を呼ぶだけ。lock 書込は `artgraph reconcile` (既存) を経由するのみ |
| **IV. SDD ツール ID 直接利用** | Spec Kit / Kiro / OpenSpec の ID をそのまま使う前提 | ✅ PASS | OpenSpec の見出し駆動 (ID 文字列無し) には slug 派生で対応 (既存 Issue #25 設計を踏襲)。独自 ID 層は追加しない |
| **V. 構造整合のみ保証 (NON-NEGOTIABLE)** | Skill / Hook は意味判定を行わず、CLI 出力をそのまま提示 | ✅ PASS | 各 Skill 本体は `artgraph impact` / `check` / `coverage` / `rename` 等の決定的コマンド結果を表示するだけ。意味判定 (要求の妥当性等) はユーザーに委ねる |

**Gate**: ✅ All NON-NEGOTIABLE principles pass without justified deviations.

**Complexity Tracking**: 空 (justify する逸脱なし)。

## Project Structure

### Documentation (this feature)

```text
specs/012-skills-expansion/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0: 設計判断の根拠 (Skills vs MCP, Plugin 配布, Spec Kit #2730 等)
├── data-model.md        # Phase 1: Skill / Provider / Hook Template / Plugin Manifest のエンティティ定義
├── quickstart.md        # Phase 1: 各 US の手動 E2E 検証手順
├── contracts/           # Phase 1: CLI フラグ / SKILL.md frontmatter / Plugin manifest schema
│   ├── cli-flags.md
│   ├── skill-frontmatter.md
│   ├── plugin-manifest.md
│   ├── speckit-extension-command.md
│   └── settings-merge.md
├── checklists/
│   └── requirements.md  # 既存 (spec quality validation)
└── tasks.md             # Phase 2 output (/speckit-tasks 出力 — このコマンドでは作成しない)
```

### Source Code (repository root)

```text
# 既存 (改修対象)
src/
├── cli.ts                              # P0: init に --integrate auto 追加。P1: --with-hooks, --with-agent-context 追加
├── init.ts                             # P0: installSkills() を 新 Skill ディレクトリに対応。P1: installHooks() / installAgentContext() 追加
├── integrate/
│   ├── index.ts                        # P3: openspec provider 登録
│   └── providers/
│       ├── speckit.ts                  # P3: scan-reconcile 出力消費型化への対応 (provider 側に影響あれば)
│       ├── kiro.ts                     # P1: inclusion: auto 化テンプレを参照。P3: --with-hooks サポート
│       └── openspec.ts                 # P3: 新規 provider
└── (グラフ・check・lock の各モジュールには触れない)

# 既存 (拡張対象)
templates/
├── skills/
│   ├── _shared/
│   │   ├── install-check.md            # P0: 共通 install 確認手順 (新規)
│   │   └── output-schema.md            # P0: JSON 出力スキーマ参照 (新規)
│   ├── artgraph-setup/                 # P0: 新規 Skill ディレクトリ
│   │   └── SKILL.md
│   ├── artgraph-integrate/             # P0: 新規
│   │   └── SKILL.md
│   ├── artgraph-detect/                # P0: 新規
│   │   └── SKILL.md
│   ├── artgraph-plan/                  # P0: 既存単一ファイルからディレクトリ化 + 短縮
│   │   └── SKILL.md
│   ├── artgraph-verify/                # P0: 同上
│   │   └── SKILL.md
│   ├── artgraph-coverage/              # P0: 同上
│   │   └── SKILL.md
│   └── artgraph-rename/                # P0: 同上 (rename は 100 行超えるため references/ も置く可能性あり)
│       ├── SKILL.md
│       └── references/
│           └── lifecycle-flows.md      # split / merge 詳細手順
├── hooks/                              # P1: 新規ディレクトリ
│   ├── settings.json.template          # Claude Code Stop / PostToolUse hook (merge 用部分)
│   └── pre-commit.sh.template          # husky/lefthook 利用者向け (任意)
├── agent-context/                      # P1: 新規ディレクトリ
│   ├── claude-md-snippet.md            # CLAUDE.md 用 30 行スニペット
│   └── agents-md-snippet.md            # AGENTS.md 用 (OpenSpec / Kiro 共通プロトコル)
└── integrate/
    ├── speckit/
    │   ├── extension.yml               # P3: requires.speckit_version を確認
    │   ├── README.md                   # P3: #2730 フォールバック明記
    │   └── commands/
    │       ├── artgraph.scan-reconcile.md   # P3: 出力消費型に改訂 (1 行 JSON サマリ命令)
    │       ├── artgraph.check-diff.md       # (既存維持)
    │       └── artgraph.check-gate.md       # (既存維持)
    ├── kiro/
    │   ├── artgraph.md                 # P1: inclusion: auto + description 追加
    │   └── hooks/                      # P3: 新規
    │       └── artgraph-verify.json    # Smart Hook テンプレ
    └── openspec/                       # P3: 新規ディレクトリ全体
        ├── README.md
        └── schemas/
            └── artgraph/
                ├── schema.yaml
                └── templates/
                    └── apply-verify.md

# 新規 (Plugin 配布)
.claude-plugin/                         # P2: 新規ディレクトリ
├── marketplace.json
└── plugin.json                         # skills: ./templates/skills/ を指す
hooks/                                  # P2: 新規 (Plugin 経由 install 時の Stop hook)
└── hooks.json

# テスト (既存パターンに追加)
tests/
├── init.test.ts                        # P1: --with-hooks / --with-agent-context カバー追加
├── integrate-cli.test.ts               # P3: openspec カバー追加
├── skills-templates.test.ts            # P0: 新規 — SKILL.md frontmatter 形式 / 100 行制約 / install-check 参照のメタテスト
├── hooks-merge.test.ts                 # P1: 新規 — settings.json merge 戦略 (新規/既存/衝突)
├── agent-context-injection.test.ts     # P1: 新規 — CLAUDE.md/AGENTS.md スニペット注入のべき等性
├── plugin-manifest.test.ts             # P2: 新規 — .claude-plugin/{marketplace,plugin}.json schema 検証
└── speckit-extension-command.test.ts   # P3: 新規 — scan-reconcile の 1 行 JSON サマリ契約検証
```

**Structure Decision**: 単一プロジェクト (`src/` + `tests/` + `templates/` + `.claude-plugin/`)。Constitution 「Package layout: 単一パッケージ」を厳守し、workspace 化はしない。新規ファイルは既存層 (`src/integrate/providers/`, `templates/integrate/`) のパターンを継承する。

## Complexity Tracking

> 空 — Constitution 原則の逸脱なし。

(該当なし)
