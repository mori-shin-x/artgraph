# artgraph Claude Code Skills ガイド

## 概要

artgraph は仕様・実装・テストの整合性を追跡するツールです。
Claude Code Skills を使うことで、エージェントのワークフローに artgraph を自然に組み込み、
Plan 策定時の影響分析、実装完了時の整合性チェック、進捗確認時のカバレッジ表示を自動化できます。

## セットアップ

### 1. artgraph のインストール

```bash
npm install -D artgraph
```

### 2. 初期化

```bash
npx artgraph init
```

これにより `.artgraph.json` 設定ファイルが作成されます。

### 3. Skills ファイルの配置

`.claude/skills/` ディレクトリに以下の 4 つのスキルファイルを配置します:

```
.claude/skills/
  artgraph-plan.md
  artgraph-verify.md
  artgraph-coverage.md
  artgraph-rename.md
```

これらのファイルはこのリポジトリの `.claude/skills/` にあります（npm パッケージには同梱されません）。利用するプロジェクトの `.claude/skills/` にコピーしてください。
Claude Code が `.claude/skills/` 内の `.md` ファイルを自動的にスキルとして認識します。

## Skills 一覧

### artgraph-plan

トリガー: Plan 策定や設計検討の依頼時

`artgraph impact --diff --format json` を実行し、git diff から変更の影響範囲を分析します。
影響を受ける仕様・ドキュメント・実装ファイルの情報がエージェントのコンテキストに注入され、
既存仕様との矛盾や影響漏れを考慮した Plan 策定を支援します。

使用する CLI コマンド:
```bash
artgraph impact --diff --format json
```

### artgraph-verify

トリガー: 実装完了報告やコードレビュー前

`artgraph check --diff --format text` を実行し、仕様と実装の整合性を検証します。
以下の問題を検出します:

- drift: 仕様が変更されたが実装が未更新
- orphan: `@impl` タグが存在するが対応する仕様がない
- uncovered: 仕様に対する実装が紐づいていない

Stop hook（`artgraph check --gate`）でブロックされる前にセルフチェックでき、手戻りを削減します。

使用する CLI コマンド:
```bash
artgraph check --diff --format text
```

### artgraph-coverage

トリガー: 進捗確認や残作業確認の依頼時

`artgraph coverage --format json` を実行し、各仕様のカバレッジ状態を一覧表示します。

各仕様は以下のいずれかの状態で表示されます:
- verified: 実装とテストの両方が紐づいている
- impl-only: 実装はあるがテストが不足している
- untagged: 実装が紐づいていない

使用する CLI コマンド:
```bash
artgraph coverage --format json
```

### artgraph-rename

トリガー: 仕様 ID のリネーム・分割・統合の依頼時

`artgraph rename` を使い、spec のリスト項目／見出し、`@impl` タグ、テストの `[ID]` / `req:` タグ、
frontmatter の `depends_on` / `derives_from`、`.trace.lock` のキーを横断的に書き換えます。
破壊的操作のため、必ず `--dry-run` で影響範囲を確認してから本適用します。

使用する CLI コマンド:
```bash
artgraph rename --from REQ-001 --to REQ-100 --dry-run     # リネーム
artgraph rename --split REQ-001 --into REQ-101 REQ-102    # 分割
artgraph rename --merge REQ-001 REQ-002 --into REQ-100    # 統合
```

## Skills と Stop Hook の関係

Skills はエージェントのワークフロー内で自動実行され、問題を早期に検出します。
Stop hook は Git の pre-commit/pre-push で `artgraph check --gate` を実行し、
問題がある場合にコミットをブロックします。

両者は補完関係にあり、同じ `artgraph` CLI を共有しています:

1. Plan 策定時: artgraph-plan スキルが影響分析を実行
2. 実装中: 開発者がコードを書く
3. 実装完了時: artgraph-verify スキルがセルフチェックを実行
4. コミット時: Stop hook がゲーティングを実行

Skills と Stop hook の両方を導入することで最大の効果が得られますが、
それぞれ独立して使用することも可能です。

## カスタマイズ

各スキルファイルは Markdown で記述されており、プロジェクトの要件に合わせて自由に編集できます。
例えば:

- トリガー条件の調整: frontmatter の `description` を変更して発火タイミングを調整
- 実行コマンドのオプション変更: `--diff` を外して全体チェックに切り替え
- 追加の指示: 結果に対するエージェントのアクションをカスタマイズ
