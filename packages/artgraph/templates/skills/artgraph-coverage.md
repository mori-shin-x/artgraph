---
name: "artgraph-coverage"
description: "進捗確認や残作業確認の依頼時にトリガー。artgraph coverage を実行し、各仕様の coverage 状態（verified / impl-only / untagged）を一覧表示して残作業を可視化する。"
user-invocable: true
disable-model-invocation: false
---

## 目的

進捗確認時に `artgraph coverage` を実行し、各仕様の coverage 状態を一覧表示する。
残作業の把握と優先順位付けに活用する。

## 実行手順

### 1. artgraph の存在確認

```bash
command -v artgraph || npx artgraph --version
```

コマンドが見つからない場合は以下を案内して終了:

```
artgraph がインストールされていません。
セットアップ手順:
  npm install -D artgraph
  npx artgraph init
```

### 2. カバレッジ状況の取得

```bash
artgraph coverage --format json
```

### 3. 結果の表示

実行結果の JSON を解析し、以下の情報を報告する:

items: 各仕様のカバレッジ状態
- reqId: 仕様 ID
- status: verified（実装+テストあり）/ impl-only（実装のみ）/ untagged（未実装）

summary: 集計情報
- total: 仕様の総数
- verified: verified の数
- implOnly: impl-only の数
- untagged: untagged の数

### 4. 進捗サマリの提示

カバレッジ状態に基づいて進捗を報告する:

- 全仕様が verified の場合: 「全仕様が verified 状態です」と報告
- untagged が存在する場合: 未実装の仕様一覧を表示し、優先的に着手すべき項目を提案する
- impl-only が存在する場合: テストが不足している仕様の一覧を表示する
