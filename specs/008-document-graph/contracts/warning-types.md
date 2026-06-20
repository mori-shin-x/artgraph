# Contract: 新しい warning type

## 概要

`BuildWarning` に追加する 3 つの新しい warning type の仕様。

## BuildWarning インターフェース

```ts
export interface BuildWarning {
  type: "duplicate-id" | "ambiguous-id" | "orphan-doc" | "invalid-relation" | "reserved-prefix";
  id: string;
  files: string[];
  message?: string;  // 新規: 人間向けの説明テキスト
}
```

## 新しい warning type

### orphan-doc

発生条件: frontmatter の `derives_from` / `depends_on` で指定された依存先 ID に対応するノードがグラフに存在しない場合

検出タイミング: `buildGraph` のエッジ生成後、全ノード登録完了後に依存先の存在チェック

フィールド値:
- `type`: `"orphan-doc"`
- `id`: 依存先の ID（例: `"doc:missing.md"`）
- `files`: ソースファイルの相対パス（例: `["specs/design.md"]`）
- `message`: `"referenced from specs/design.md but not found in graph"`

CLI 出力例:
```
WARNING: orphan-doc "doc:missing.md" referenced from specs/design.md
```

check --gate との関係: warning として報告するが gate を fail させない（FR-005）

### invalid-relation

発生条件: frontmatter の `spectrace` ブロックに `node_id` / `derives_from` / `depends_on` 以外のキーがある場合

検出タイミング: `parseMarkdown` での frontmatter パース時

フィールド値:
- `type`: `"invalid-relation"`
- `id`: 不正なキー名（例: `"extends"`）
- `files`: ソースファイルの相対パス（例: `["specs/design.md"]`）
- `message`: `"unknown relation key. Use \"derives_from\" or \"depends_on\""`

CLI 出力例:
```
WARNING: invalid relation "extends" in specs/design.md. Use "derives_from" or "depends_on"
```

エッジ生成: 不正なキーに対してはエッジを生成しない

### reserved-prefix

発生条件: req ID が `doc:` / `file:` / `test:` / `symbol:` のいずれかのプレフィクスで始まる場合

検出タイミング: `buildGraph` での req ノード登録時

フィールド値:
- `type`: `"reserved-prefix"`
- `id`: req ID（例: `"doc:FR-001"`）
- `files`: ソースファイルの相対パス（例: `["specs/spec.md"]`）
- `message`: `"req ID uses reserved prefix \"doc:\". This may conflict with auto-generated node IDs"`

CLI 出力例:
```
WARNING: reserved prefix in ID "doc:FR-001" in specs/spec.md
```

## CLI での表示

`src/cli.ts` の警告表示ロジックを拡張する。

現行（L42-49, L127-135）:
```ts
for (const w of result.warnings) {
  if (w.type === "ambiguous-id") {
    const hint = w.files.length > 0 ? ` (candidates: ${w.files.join(", ")})` : "";
    console.error(`WARNING: ambiguous ID "${w.id}"${hint}`);
  } else {
    console.error(`WARNING: duplicate ID "${w.id}" in ${w.files.join(", ")}`);
  }
}
```

変更後（新 type を追加）:
```ts
for (const w of warnings) {
  switch (w.type) {
    case "ambiguous-id": {
      const hint = w.files.length > 0 ? ` (candidates: ${w.files.join(", ")})` : "";
      console.error(`WARNING: ambiguous ID "${w.id}"${hint}`);
      break;
    }
    case "duplicate-id":
      console.error(`WARNING: duplicate ID "${w.id}" in ${w.files.join(", ")}`);
      break;
    case "orphan-doc":
      console.error(`WARNING: orphan-doc "${w.id}" referenced from ${w.files.join(", ")}`);
      break;
    case "invalid-relation":
      console.error(`WARNING: invalid relation "${w.id}" in ${w.files.join(", ")}. Use "derives_from" or "depends_on"`);
      break;
    case "reserved-prefix":
      console.error(`WARNING: reserved prefix in ID "${w.id}" in ${w.files.join(", ")}`);
      break;
  }
}
```

## JSON 出力

`--format json` の場合、warnings 配列にそのまま含める:
```json
{
  "warnings": [
    {
      "type": "orphan-doc",
      "id": "doc:missing.md",
      "files": ["specs/design.md"],
      "message": "referenced from specs/design.md but not found in graph"
    }
  ]
}
```
