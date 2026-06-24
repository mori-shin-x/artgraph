# Contract: GraphEdge provenance フィールド

Plan: [../plan.md](../plan.md) | Related Issue: [#35](https://github.com/ShintaroMorimoto/artgraph/issues/35)

## 型定義（追加）

`packages/artgraph/src/types.ts`:

```ts
export type EdgeProvenance = "annotation" | "frontmatter" | "convention" | "tag";

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  provenance?: EdgeProvenance;  // ← 追加（optional）
}
```

## 値の語彙

| 値 | 意味 | 本 issue で生成するか |
|---|---|---|
| `"annotation"` | list-item / heading req のインライン注釈由来 | ✅ 必ず付与 |
| `"frontmatter"` | doc の frontmatter `artgraph.depends_on` 等由来 | ❌（#35 で既存エッジに後追い） |
| `"convention"` | フォルダ規約推論由来（issue #12 で実装済） | ❌（#35 で既存エッジに後追い） |
| `"tag"` | `// @impl` などコード側タグ由来 | ❌（#35 で既存エッジに後追い） |

## 本 issue でのスコープ

- **生成**: req→req エッジに `provenance: "annotation"` を付与
- **保持**: in-memory の `ArtifactGraph` でのみ保持
- **CLI 出力**: 本 issue では未対応（`artgraph graph` 出力の表示は #35 で扱う）
- **lock**: 書き出さない（#35 で lock スキーマ再設計予定）
- **dedup**: 本 issue では req→req エッジは注釈経路のみのため衝突発生なし。
  複数 provenance のマージ規則は #35 で確定

## #35 解決時の想定変更

1. 他経路でエッジを生成する箇所（parser frontmatter、convention inference、
   builder の @impl タグ等）に provenance 付与
2. dedup ロジックに provenance 集合化を追加（`provenance: EdgeProvenance` →
   `provenances: EdgeProvenance[]` への型変更 or 集約用 helper 追加）
3. lock シリアライゼーション拡張（オプションで provenance を書き出す）
4. CLI 出力（`artgraph graph --provenance`）でフィルタ・表示

本 issue では (1) のみ部分的に着手（注釈経路のみ）。(2)〜(4) は #35 のスコープに残す。

## 後方互換性

- 既存テスト・既存 fixture は `provenance` を持たない GraphEdge を作る。
  optional フィールドなので型エラーにならない。
- 既存 CLI 出力（`artgraph graph` 等）は provenance フィールドを無視する。
  JSON 出力に余計なフィールドが現れない（undefined は JSON.stringify で省略）。
- lock スキーマは変更なし（provenance を書き出さないため）。
