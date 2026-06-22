---
name: "artgraph-plan"
description: "Plan 策定や設計検討の依頼時にトリガー。artgraph impact を実行し、変更の影響範囲をコンテキストに注入して、既存仕様との整合性を考慮した Plan 策定を支援する。"
user-invocable: true
disable-model-invocation: false
---

## 目的

Plan 策定前に `artgraph impact` を実行し、変更対象の仕様に波及する既存の仕様・実装・テストの影響範囲を把握する。
エージェントはこの情報を踏まえて、既存仕様との矛盾や影響漏れを考慮した Plan を立てる。

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

### 2. Impact 分析の実行

```bash
artgraph impact --diff --format json
```

- `--diff` で git diff から変更ファイルを自動検出する
- 差分がない場合（初回コミット等）は「差分なし」として正常終了し、Plan 策定を続行する

### 3. 結果のコンテキスト注入

実行結果の JSON を解析し、以下の情報を Plan のコンテキストとして活用する:

- affectedReqs: 影響を受ける仕様 ID の一覧
- affectedDocs: 影響を受けるドキュメントの一覧
- affectedFiles: 影響を受ける実装ファイルの一覧
- drifted: 仕様変更が未反映の項目（drift 検出）

### 4. Plan 策定への反映

上記の影響範囲情報を踏まえて:

- 影響を受ける仕様への言及を Plan に含める
- drift が検出された場合は Plan 内で対処方針を明記する
- 影響を受けるファイルの変更が Plan と矛盾しないか確認する
