# artgraph Claude Code Skills ガイド

## 概要

artgraph は仕様・実装・テストの整合性を追跡するツールで、7 つの Claude Code Skills を通じてエージェントのワークフローへネイティブ統合されます。SKILL.md 本体は cross-agent 対応と Claude Skills ベストプラクティスに従い英語で記述されていますが、本ドキュメントは人間の読者向けに日本語で維持しています。

各 Skill は in-flight (会話中) での早期検出を担い、Stop hook (コミット時) と補完しあって整合性を担保します。

## クイックスタート

### Claude Code エージェント経由 (推奨)

artgraph 未導入のプロジェクトで「artgraph をセットアップしてほしい」と依頼すると、`artgraph-setup` Skill が起動し、以下を 1 ターンで完結させます:

1. パッケージマネージャ自動検出 (npm / pnpm / Bun / Deno; Yarn は npm 経由で警告付きフォールバック)
2. devDependency として install
3. `artgraph init` (full agent-native setup)
4. `artgraph check` でセルフチェック

### CLI 経由 (任意の package manager)

```bash
# npm
npm install -D artgraph
npx artgraph init                       # full agent-native setup
npx artgraph init --minimal             # bare config のみ

# pnpm
pnpm add -D artgraph
pnpm exec artgraph init

# Bun
bun add -d artgraph
bunx artgraph init

# Deno
deno add npm:artgraph
deno run -A npm:artgraph/cli init
```

## `init` のデフォルト挙動

`artgraph init` はデフォルトで full agent-native setup を実行し、以下の stage をまとめて適用します:

- config (`.artgraph.json` 生成)
- scan (初回 spec/impl/test 索引化)
- Skills install (`.claude/skills/<name>/SKILL.md` 配置)
- integrate-auto (検出された SDD ツール: Spec Kit / Kiro)
- Stop hook (P1)
- agent context snippet 注入 (P1)

| フラグ | 挙動 |
| --- | --- |
| (なし) | full setup |
| `--minimal` | bare config のみ。他 stage はすべて off |
| `--no-skills` / `--no-integrate` / `--no-hooks` / `--no-agent-context` | full setup から個別 stage を opt-out |
| `--minimal --with-skills` 等 | minimal を起点に個別 stage を opt-in |
| `--integrations <csv>` | 一回限りの SDD ツール統合指定 (旧 `--integrate` から rename。`--no-integrate` との commander 衝突回避) |

詳細は `artgraph init --help` を参照してください。

## Skills 一覧 (全 7 種)

### artgraph-setup

- トリガー: artgraph 未導入のプロジェクトで「artgraph を入れて」「セットアップして」と依頼された時
- 動作: package manager 検出 (npm / pnpm / Bun / Deno、Yarn は npm fallback + 警告) → install → `artgraph init` (full setup) → `artgraph check`
- 参照: `templates/skills/artgraph-setup/SKILL.md`

### artgraph-integrate

- トリガー: artgraph 導入済みプロジェクトで SDD ツール統合を頼まれた時
- 動作: `artgraph integrate list` で Spec Kit / Kiro を detect → ユーザー同意を取得 → `artgraph integrate <tool>` を実行
- 参照: `templates/skills/artgraph-integrate/SKILL.md`

### artgraph-detect

- トリガー: 「artgraph 入ってる？」「何が available？」と聞かれた時
- 動作: 読み取り専用。CLI 有無 / `.artgraph.json` 有無 / SDD ツール統合状態 / Skills 設置状況を一覧
- 参照: `templates/skills/artgraph-detect/SKILL.md`

### artgraph-impact (旧 artgraph-plan)

- トリガー: plan 策定・設計検討・変更スコープ確認の依頼時
- 動作: 3 モードで分岐
  - (a) git に変更あり → `artgraph impact --diff`
  - (b) ユーザーが REQ-ID または file path を明示 → `artgraph impact <targets>`
  - (c) どちらもなし → 「どの requirement / file を分析しますか？」とユーザーに確認
- リネーム理由: 旧名「plan」は "変更前の設計" を連想させたが `--diff` は変更後を見るため矛盾していた。3 モード化で diff の有無を問わず利用可能になったため、機能を素直に表す `impact` に変更
- 参照: `templates/skills/artgraph-impact/SKILL.md`

### artgraph-verify

- トリガー: 実装完了報告 / コードレビュー直前
- 動作: `artgraph check --diff` を実行し drift / orphan / uncovered / coverage 不足をセルフチェック。Stop hook (`artgraph check --gate`) でブロックされる前の手戻り削減を目的とする
- 参照: `templates/skills/artgraph-verify/SKILL.md`

### artgraph-coverage

- トリガー: 進捗・残作業確認の依頼時
- 動作: `artgraph coverage` を実行し per-requirement の verified / impl-only / untagged 状態を集計
- 参照: `templates/skills/artgraph-coverage/SKILL.md`

### artgraph-rename

- トリガー: 仕様 ID のリネーム / split / merge 依頼時
- 動作: `artgraph rename` 系で spec 本文・`@impl` タグ・テストの `[ID]` / `req:` タグ・frontmatter (`depends_on` / `derives_from`) ・`.trace.lock` を一括書き換え。破壊的操作のため `--dry-run` で必ず影響範囲を確認
- 参照: `templates/skills/artgraph-rename/SKILL.md`

## Skills と Stop Hook の関係

Skills と Stop hook は同じ `artgraph` CLI を共有しつつ、異なるタイミングで動作する補完関係にあります:

1. plan / 設計時: `artgraph-impact` が影響分析を注入
2. 実装中: 開発者がコードを書く
3. 実装完了時: `artgraph-verify` がセルフチェックを実行
4. コミット時: Stop hook (`artgraph check --gate`) がゲーティング

Skills が in-flight の早期検出、Stop hook がコミット時の最終ゲートを担います。両方導入することで効果が最大化しますが、それぞれ独立して使用することも可能です。

## Skills 配置場所

| パス | 用途 |
| --- | --- |
| `templates/skills/<name>/SKILL.md` | source of truth (本リポジトリに同梱) |
| `.claude/skills/<name>/SKILL.md` | `artgraph init` (default) の配備先、per-project |
| `~/.claude/plugins/cache/.../skills/<name>/SKILL.md` | Plugin install の配備先、user-global (P2 で追加予定) |

共有断片は `templates/skills/_shared/` 配下に集約されています:

- `_shared/install-check.md` — CLI 存在チェック手順
- `_shared/output-schema.md` — 共通出力フォーマット
- `_shared/package-manager.md` — npm/pnpm/Bun/Deno 検出ロジック

## カスタマイズ

- SKILL.md は cross-agent 対応のため英語前提ですが、自プロジェクト内で上書きする場合は任意の言語に書き換えて構いません
- `--minimal --with-skills` 等を組み合わせれば必要な stage のみ導入する構成も可能
- トリガー条件は SKILL.md frontmatter の `description` を編集して調整できます
- 実行コマンドのオプション (`--diff` の有無など) もプロジェクトの要件に応じて変更可能です
