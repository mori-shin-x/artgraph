---
name: "artgraph-verify"
description: "実装完了報告やコードレビュー前にトリガー。artgraph check を実行し、drift/orphan/uncovered を検出して仕様と実装の整合性をセルフチェックする。"
user-invocable: true
disable-model-invocation: false
---

## 目的

実装完了時に `artgraph check` を実行し、仕様と実装の整合性を検証する。
Stop hook（`artgraph check --gate`）でブロックされる前にセルフチェックすることで、手戻りコストを削減する。

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

### 2. 整合性チェックの実行

```bash
artgraph check --diff --format text
```

- `--diff` で git diff にスコープを絞り、変更に関連する部分のみチェックする
- `--gate` は付けない（ゲーティングはせず結果表示のみ）

### 3. 結果の表示と対応

出力結果を解析し、以下の項目を報告する:

DRIFT (仕様変更の未反映):
- 検出された場合: 各 drift 項目のノード ID と種別を表示し、実装の更新が必要であることを報告する

ORPHANS (実装タグの宙ぶらりん):
- 検出された場合: 対応する仕様が存在しない `@impl` / `@verify` タグの一覧を表示する

UNCOVERED (未実装の仕様):
- 検出された場合: 実装が紐づいていない仕様 ID の一覧を表示する

COVERAGE (各仕様のカバレッジ状態):
- 各仕様の状態（verified / impl-only / untagged）を一覧表示する

全ての仕様が整合している場合:
- 「全てのチェックが通過しました」と報告する

### 4. 問題がある場合の対応提案

問題が検出された場合は、具体的な修正アクションを提案する:
- drift: 実装を仕様に合わせて更新し、`artgraph reconcile` を実行する
- orphan: 不要なタグを削除するか、対応する仕様を追加する
- uncovered: `@impl` タグを追加して仕様と実装を紐づける
