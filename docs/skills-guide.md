# spectrace Claude Code Skills ガイド

## 概要

spectrace は仕様・実装・テストの整合性を追跡するツールです。
Claude Code Skills を使うことで、エージェントのワークフローに spectrace を自然に組み込み、
Plan 策定時の影響分析、実装完了時の整合性チェック、進捗確認時のカバレッジ表示を自動化できます。

## セットアップ

### 1. spectrace のインストール

```bash
npm install -D spectrace
```

### 2. 初期化

```bash
npx spectrace init
```

これにより `.spectrace.json` 設定ファイルが作成されます。

### 3. Skills ファイルの配置

`.claude/skills/` ディレクトリに以下の 3 つのスキルファイルを配置します:

```
.claude/skills/
  spectrace-plan.md
  spectrace-verify.md
  spectrace-coverage.md
```

これらのファイルは spectrace パッケージに含まれています。
Claude Code が `.claude/skills/` 内の `.md` ファイルを自動的にスキルとして認識します。

## Skills 一覧

### spectrace-plan

トリガー: Plan 策定や設計検討の依頼時

`spectrace impact --diff --format json` を実行し、git diff から変更の影響範囲を分析します。
影響を受ける仕様・ドキュメント・実装ファイルの情報がエージェントのコンテキストに注入され、
既存仕様との矛盾や影響漏れを考慮した Plan 策定を支援します。

使用する CLI コマンド:
```bash
spectrace impact --diff --format json
```

### spectrace-verify

トリガー: 実装完了報告やコードレビュー前

`spectrace check --diff --format text` を実行し、仕様と実装の整合性を検証します。
以下の問題を検出します:

- drift: 仕様が変更されたが実装が未更新
- orphan: `@impl` タグが存在するが対応する仕様がない
- uncovered: 仕様に対する実装が紐づいていない

Stop hook（`spectrace check --gate`）でブロックされる前にセルフチェックでき、手戻りを削減します。

使用する CLI コマンド:
```bash
spectrace check --diff --format text
```

### spectrace-coverage

トリガー: 進捗確認や残作業確認の依頼時

`spectrace coverage --format json` を実行し、各仕様のカバレッジ状態を一覧表示します。

各仕様は以下のいずれかの状態で表示されます:
- verified: 実装とテストの両方が紐づいている
- impl-only: 実装はあるがテストが不足している
- untagged: 実装が紐づいていない

使用する CLI コマンド:
```bash
spectrace coverage --format json
```

## Skills と Stop Hook の関係

Skills はエージェントのワークフロー内で自動実行され、問題を早期に検出します。
Stop hook は Git の pre-commit/pre-push で `spectrace check --gate` を実行し、
問題がある場合にコミットをブロックします。

両者は補完関係にあり、同じ `spectrace` CLI を共有しています:

1. Plan 策定時: spectrace-plan スキルが影響分析を実行
2. 実装中: 開発者がコードを書く
3. 実装完了時: spectrace-verify スキルがセルフチェックを実行
4. コミット時: Stop hook がゲーティングを実行

Skills と Stop hook の両方を導入することで最大の効果が得られますが、
それぞれ独立して使用することも可能です。

## カスタマイズ

各スキルファイルは Markdown で記述されており、プロジェクトの要件に合わせて自由に編集できます。
例えば:

- トリガー条件の調整: frontmatter の `description` を変更して発火タイミングを調整
- 実行コマンドのオプション変更: `--diff` を外して全体チェックに切り替え
- 追加の指示: 結果に対するエージェントのアクションをカスタマイズ
