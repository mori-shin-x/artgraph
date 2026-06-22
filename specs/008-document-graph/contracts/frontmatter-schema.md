# Contract: frontmatter スキーマ

## 概要

Markdown ファイルの YAML frontmatter 内の `artgraph` ブロックでドキュメントの ID と依存関係を宣言する。

## スキーマ定義

```yaml
---
artgraph:
  node_id: <string>              # オプション。doc ノードのカスタム ID
  derives_from:                  # オプション。派生元ドキュメントの ID リスト
    - <string>
  depends_on:                    # オプション。依存先ドキュメントの ID リスト
    - <string>
---
```

## フィールド詳細

### artgraph.node_id

- 型: `string`
- 必須: いいえ
- 説明: doc ノードに割り当てるカスタム ID。省略時は `doc:<specDir からの相対パス>` で自動採番
- 例: `"design-doc"`, `"api-requirements"`
- 制約: プロジェクト内で一意であること。重複時は `duplicate-id` 警告

### artgraph.derives_from

- 型: `string[]`
- 必須: いいえ
- 説明: このドキュメントの派生元ドキュメントの ID リスト。`derives_from` エッジを生成する
- 例: `["doc:requirements.md"]`, `["api-requirements"]`
- エッジの方向: `source = このドキュメントの doc ID`, `target = derives_from の値`

### artgraph.depends_on

- 型: `string[]`
- 必須: いいえ
- 説明: このドキュメントが依存するドキュメントの ID リスト。`depends_on` エッジを生成する
- 例: `["doc:shared-types.md"]`
- エッジの方向: `source = このドキュメントの doc ID`, `target = depends_on の値`

## バリデーション

### 有効なキー

`artgraph` ブロック内で有効なキーは以下の 3 つのみ:
- `node_id`
- `derives_from`
- `depends_on`

### invalid-relation 警告

`artgraph` ブロック内に上記 3 キー以外のキーがある場合、`invalid-relation` 警告を出力する。エッジは生成しない。

警告メッセージ例:
```
WARNING: invalid relation "extends" in specs/design.md. Use "derives_from" or "depends_on"
```

### orphan-doc 警告

`derives_from` / `depends_on` の値に対応するノードがグラフに存在しない場合、`orphan-doc` 警告を出力する。エッジは生成するが、ターゲットノードが存在しないため BFS では到達しない。

警告メッセージ例:
```
WARNING: orphan-doc "doc:missing.md" referenced from specs/design.md
```

## 入力例

### 最小構成（frontmatter なし）

```markdown
# Requirements

プロジェクトの要件を記述する散文ドキュメント。
```

→ doc ノードが自動生成される（`doc:<相対パス>`）。エッジなし。

### node_id のみ

```yaml
---
artgraph:
  node_id: "requirements"
---
# Requirements
```

→ doc ノード ID が `"requirements"` になる。

### 依存チェーン

requirements.md:
```yaml
---
artgraph:
  node_id: "requirements"
---
```

design.md:
```yaml
---
artgraph:
  node_id: "design"
  derives_from:
    - requirements
---
```

tasks.md:
```yaml
---
artgraph:
  derives_from:
    - design
---
```

→ `tasks.md --derives_from--> design --derives_from--> requirements` のチェーン

## 現行スキーマからの移行

現行の `depends_on: [{ id, relation }]` 形式:
```yaml
artgraph:
  node_id: "design-doc"
  depends_on:
    - id: "requirements.md"
      relation: "derives_from"
```

新しいフラット形式:
```yaml
artgraph:
  node_id: "design-doc"
  derives_from:
    - requirements.md
```

現行形式を使用しているファイルは、本機能の実装時に新形式に移行する。未リリースのため後方互換は考慮しない（spec Assumption）。
