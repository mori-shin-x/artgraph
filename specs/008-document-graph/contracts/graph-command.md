# Contract: artgraph graph コマンド

## コマンドスキーマ

```
artgraph graph [options]
```

## オプション

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--format <format>` | `"text" \| "json"` | `"text"` | 出力フォーマット |
| `--kind <kind>` | `"doc" \| "req" \| "file" \| "test"` | (全種別) | ノード種別フィルタ |

## text 形式の出力

ルートノード（他のノードの target になっていないノード）を起点に、深さ優先でツリーを出力する。

出力例:
```
doc:requirements.md
  └─[derives_from]─ doc:design.md
    └─[derives_from]─ doc:tasks.md
  └─[contains]─ FR-001
    └─[implements]─ file:src/auth/login.ts
      └─[verifies]─ file:tests/login.test.ts
  └─[contains]─ FR-002

doc:shared-types.md
  └─[depends_on]─ doc:design.md
```

ルールー:
- インデントは 2 スペース x depth
- エッジラベルは `[edge_kind]` 形式
- 複数のルートがある場合は空行で区切る
- `--kind` フィルタ適用時は、指定された kind のノードとそれらの間のエッジのみ表示

## JSON 形式の出力

```json
{
  "nodes": [
    {
      "id": "doc:requirements.md",
      "kind": "doc",
      "filePath": "specs/requirements.md",
      "label": "doc:requirements.md",
      "contentHash": "a1b2c3d4e5f6g7h8"
    }
  ],
  "edges": [
    {
      "source": "doc:design.md",
      "target": "doc:requirements.md",
      "kind": "derives_from"
    }
  ]
}
```

ルール:
- `nodes` は `GraphNode` の配列。Map ではなく配列にシリアライズする
- `edges` は `GraphEdge` の配列
- `--kind` フィルタ適用時は、指定された kind のノードのみ含み、エッジは source と target の両方がフィルタを通過した場合のみ含む

## 終了コード

- `0`: 正常終了
- `1`: エラー（設定ファイル不正等）

## 実装場所

- CLI 定義: `src/cli.ts` に `program.command("graph")` を追加
- フォーマッタ: `src/graph/format.ts` を新規作成
  - `formatGraphText(graph: ArtifactGraph, kindFilter?: NodeKind): string`
  - `formatGraphJSON(graph: ArtifactGraph, kindFilter?: NodeKind): string`
