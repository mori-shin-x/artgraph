# Phase 1: Data Model — Edge Provenance First-Class

Date: 2026-06-26
Plan: [plan.md](./plan.md) | Research: [research.md](./research.md)

## 概要

本 feature は新規ノード型・新規エッジ kind を追加しない。`GraphEdge` の必須フィールド `provenances`、補助型 `EdgeProvenance` と `NonEmptyArray<T>`、および `LockEntry.dependsOn` の構造変更だけで構成される。

## 既存型の変更

### `EdgeProvenance` (in `packages/artgraph/src/types.ts`)

```ts
export type EdgeProvenance =
  | "annotation"
  | "frontmatter"
  | "convention"
  | "code-tag"     // ← 新規
  | "task-tag"     // ← 新規 (旧 "tag" を分割)
  | "inline-link"  // ← 新規
  | "ts-import"    // ← 新規
  | "structural";  // ← 新規

// ランタイム集合（type union と完全同期）
export const EDGE_PROVENANCE_VALUES: ReadonlySet<EdgeProvenance> = new Set([
  "annotation",
  "frontmatter",
  "convention",
  "code-tag",
  "task-tag",
  "inline-link",
  "ts-import",
  "structural",
]);
```

旧 4 値（`"annotation" | "frontmatter" | "convention" | "tag"`）から 8 値へ拡張。`"tag"` は廃止。SC-008 のため `type union` と `EDGE_PROVENANCE_VALUES` の要素数一致を型レベル assertion で確認する（[contracts/edge-provenance-type.md](./contracts/edge-provenance-type.md) §「型レベルテスト」）。

### `NonEmptyArray<T>` (新規型エイリアス)

```ts
export type NonEmptyArray<T> = readonly [T, ...T[]];
```

TS の tuple 型で「最低 1 要素」を静的保証する用途。本 feature では `GraphEdge.provenances` のみで使用するが、汎用 type alias として export する（将来の同様パターン用）。

### `GraphEdge` (in `packages/artgraph/src/types.ts`)

```ts
export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  provenances: NonEmptyArray<EdgeProvenance>;  // ← 必須・最低1要素を型保証
}
```

旧 `provenance?: EdgeProvenance` を廃止。後方互換シムは設けない（未リリース）。

### `LockEntry` (in `packages/artgraph/src/types.ts`)

```ts
export interface LockEntry {
  specFile?: string;
  contentHash: string;
  impl?: string[];                                                   // 据置
  tests?: string[];                                                  // 据置
  dependsOn?: Array<{ id: string; provenances: EdgeProvenance[] }>;  // ← 構造化
  lastReconciled: string;
}
```

`dependsOn` のみ構造化。`impl` / `tests` は事実上 `code-tag` のみで運用されるため据置。

## 不変条件（invariants）

1. **NonEmpty**: 任意の `GraphEdge` について `e.provenances.length >= 1`（TS が静的に保証）。
2. **No duplicates in array**: dedup 後の `e.provenances` は同じ値を重複して含まない（`Set` 経由）。
3. **Deterministic order**: dedup union 後の `e.provenances` は決定的順序（昇順 sort）。
4. **Lock determinism**: `LockEntry.dependsOn[]` は `id` 昇順、各要素の `provenances[]` は値昇順。同じ入力グラフから生成した lock はバイト一致する（SC-003）。
5. **JSON output filtering**: `formatGraphJSON` 出力時、`provenances` 配列の要素を `EDGE_PROVENANCE_VALUES` でフィルタする。フィルタ後 0 件となった edge は出力配列から除外する（NonEmpty invariant 維持）。
6. **Type/runtime sync**: `EdgeProvenance` 型 union の要素数と `EDGE_PROVENANCE_VALUES.size` は常に一致する（型レベル assertion）。

## エンティティ関係図

```text
parseMarkdown(file)
  ├─ frontmatter artgraph.{depends_on, derives_from}
  │    → GraphEdge with provenances: ["frontmatter"]
  ├─ list-item / heading req のインライン (depends_on:) 注釈
  │    → GraphEdge with provenances: ["annotation"]
  └─ task preset (implementsTagRe / verifiesTagRe)
       → GraphEdge with provenances: ["task-tag"]

parseTypeScript(files)
  ├─ import 文
  │    → GraphEdge with provenances: ["ts-import"]
  └─ @impl(...) / @verifies(...) / req:
       → GraphEdge with provenances: ["code-tag"]

buildGraph(parseResults)
  ├─ inferConventionEdges
  │    → GraphEdge with provenances: ["convention"]
  ├─ doc → 子 req/task の auto contains
  │    → GraphEdge with provenances: ["structural"]
  ├─ markdown インラインリンク → depends_on
  │    → GraphEdge with provenances: ["inline-link"]
  └─ dedup loop (source|target|kind 単位):
       同一キーの edge は集合 union → provenances: ["convention","frontmatter"] 等

buildLockFromGraph(graph)
  ├─ dependsOn = [{id, provenances}] (id 昇順、provenances 昇順)
  ├─ impl / tests は string[] 据置
  └─ annotation 由来も全て含める (旧フィルタ撤去)
```

## 状態遷移

本 feature は永続化スキーマの変更を伴うが、状態機械を持つエンティティは存在しない。`GraphEdge` は build 時に生成され dedup されたら以降不変、`LockEntry` も write 時点で確定。

## 永続化への影響

- `.trace.lock` の `dependsOn` フィールドは旧 `string[]` から新 `Array<{id, provenances}>` へ schema 変更。
- 既存環境にある `.trace.lock` は新 schema で再生成される（migration 不要、未リリース）。
- `impl` / `tests` フィールドは変更なし。
- `contentHash` / `lastReconciled` / `specFile` は変更なし。

## 削除されるエンティティ・フィールド

- `GraphEdge.provenance?: EdgeProvenance`（単数 optional）→ `provenances` に置換
- `EdgeProvenance` の旧値 `"tag"`（`"code-tag"` と `"task-tag"` に分割）
- `lock.ts` の `provenance !== "annotation"` フィルタロジック（削除）

## 関連 contract

- [contracts/edge-provenance-type.md](./contracts/edge-provenance-type.md): `EdgeProvenance` / `GraphEdge` / `NonEmptyArray` 型契約
- [contracts/lock-schema-v2.md](./contracts/lock-schema-v2.md): `LockEntry.dependsOn` 構造化契約
- [contracts/cli-output-format.md](./contracts/cli-output-format.md): `artgraph graph` の text/json 出力契約
