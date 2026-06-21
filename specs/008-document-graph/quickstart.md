# Quickstart: ドキュメント間グラフ構造の検証

## Prerequisites

- Node.js 20+
- pnpm
- spectrace がビルド可能な状態（`pnpm build` が通る）

## Setup

```bash
pnpm install
pnpm build
```

## 検証シナリオ 1: 散文 Markdown のグラフ自動登録（US1）

frontmatter を含まない散文のみの md ファイルを配置して doc ノードの自動生成を確認する。

1. テストフィクスチャ `tests/fixtures/specs/prose-only.md` を用意（frontmatter なし、要求 ID なし）
2. scan を実行:

```bash
node dist/cli.js scan --format json
```

確認ポイント:
- `docCount` が 1 以上（prose-only.md が doc ノードとして認識される）
- JSON 出力のノードに `{ "id": "doc:prose-only.md", "kind": "doc" }` が含まれる
- frontmatter がなくてもエラーにならない

## 検証シナリオ 2: ドキュメント間の依存チェーン（US2）

frontmatter で derives_from チェーンを定義し、doc→doc エッジの生成を確認する。

1. テストフィクスチャを 3 ファイル用意:

tests/fixtures/specs/doc-chain/requirements.md:
```yaml
---
spectrace:
  node_id: "requirements"
---
# Requirements
```

tests/fixtures/specs/doc-chain/design.md:
```yaml
---
spectrace:
  node_id: "design"
  derives_from:
    - requirements
---
# Design
```

tests/fixtures/specs/doc-chain/tasks.md:
```yaml
---
spectrace:
  derives_from:
    - design
---
# Tasks
```

2. scan と impact を実行:

```bash
# scan でエッジ確認
node dist/cli.js scan --format json

# tasks.md 起点の impact
node dist/cli.js impact "doc-chain/tasks.md"
```

確認ポイント:
- `edgeCount` に derives_from エッジが 2 本含まれる
- impact が design と requirements の両方に到達する

## 検証シナリオ 3: 一気通貫トレース（US3）

doc→contains→req→implements→file の一気通貫トレースを確認する。

1. 要求 ID を含む spec.md とその実装コードを配置:

tests/fixtures/specs/doc-with-reqs.md:
```markdown
---
spectrace:
  node_id: "auth-spec"
---
# Auth Spec

- FR-001: ユーザーはメールでログインできる
```

tests/fixtures/src/auth.ts:
```ts
// @impl FR-001
export function login() {}
```

2. impact を spec.md 起点で実行:

```bash
node dist/cli.js impact "auth-spec"
```

確認ポイント:
- `auth-spec` から contains 経由で FR-001 に到達
- FR-001 から implements 経由で `src/auth.ts` に到達
- `affectedFiles` に `src/auth.ts` が含まれる
- `affectedReqs` に `FR-001` が含まれる

## 検証シナリオ 4: graph コマンド（US4）

`spectrace graph` コマンドの出力を確認する。

```bash
# text 形式（デフォルト）
node dist/cli.js graph

# JSON 形式
node dist/cli.js graph --format json

# doc ノードのみ
node dist/cli.js graph --kind doc
```

確認ポイント:
- text 形式: ツリー構造がインデント付きで表示される
- JSON 形式: `{ nodes: [...], edges: [...] }` が出力される
- `--kind doc`: doc ノード間のエッジのみ表示される

## 検証シナリオ 5: 警告出力

```bash
# orphan-doc: 存在しない依存先を frontmatter に記述
# invalid-relation: spectrace ブロックに不正なキーを記述
node dist/cli.js scan
```

確認ポイント:
- `orphan-doc` 警告が stderr に出力される
- `invalid-relation` 警告が stderr に出力される
- エラーにならず正常終了する（exit code 0）

## テスト実行

```bash
# 全テスト実行
pnpm test

# 関連テストのみ
pnpm test tests/markdown.test.ts tests/builder.test.ts tests/traverse.test.ts

# graph フォーマッタテスト
pnpm test tests/graph-format.test.ts

# カバレッジ付き
pnpm test -- --coverage
```
