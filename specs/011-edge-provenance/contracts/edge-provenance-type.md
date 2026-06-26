# Contract: EdgeProvenance / GraphEdge / NonEmptyArray

Plan: [../plan.md](../plan.md) | Data Model: [../data-model.md](../data-model.md) | Related Issue: [#35](https://github.com/ShintaroMorimoto/artgraph/issues/35)

## 型定義

`packages/artgraph/src/types.ts`:

```ts
export type NonEmptyArray<T> = readonly [T, ...T[]];

export type EdgeProvenance =
  | "annotation"
  | "frontmatter"
  | "convention"
  | "code-tag"
  | "task-tag"
  | "inline-link"
  | "ts-import"
  | "structural";

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

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  provenances: NonEmptyArray<EdgeProvenance>;
}
```

## provenance 値の意味（normative マッピング）

| 値 | 生成箇所（ファイル:行 ベース） | 対応 EdgeKind |
|---|---|---|
| `"annotation"` | `parsers/markdown.ts` インライン `(depends_on:)` / `(derives_from:)` 注釈（list-item / heading 形式） | `depends_on` / `derives_from` |
| `"frontmatter"` | `parsers/markdown.ts` YAML frontmatter `artgraph.{depends_on,derives_from}` | `depends_on` / `derives_from` |
| `"convention"` | `graph/builder.ts:inferConventionEdges` フォルダ規約推論（kiro: design→requirements, tasks→design / spec-kit: plan→spec, tasks→plan, research→spec） | `derives_from` |
| `"code-tag"` | `parsers/typescript.ts` の `@impl(...)` / `@verifies(...)` / `req:` TS コード由来タグ | `implements` / `verifies` |
| `"task-tag"` | `parsers/markdown.ts` タスク preset の `implementsTagRe` / `verifiesTagRe`（kiro の `_Requirements: …`、spec-kit の `[REQ-…]`） | `implements` / `verifies` |
| `"inline-link"` | `graph/builder.ts` markdown インラインリンク `[text](path)` 由来 | `depends_on` |
| `"ts-import"` | `parsers/typescript.ts` の `import` 文（file-level / symbol-level 双方） | `imports` |
| `"structural"` | `graph/builder.ts` doc → 同 filePath 内の req/task auto 接続 | `contains` |

任意の edge 生成箇所はこの表のいずれかに分類されなければならない。新カテゴリが必要になった場合は EdgeProvenance type に値を追加し EDGE_PROVENANCE_VALUES と同期する。

## 不変条件

1. **NonEmpty (型レベル)**: `GraphEdge.provenances` は tuple `readonly [T, ...T[]]` 型なので、TS コンパイラが空配列を弾く。
2. **No duplicates**: dedup 完了後の `provenances` は同じ値を重複して含まない。
3. **Deterministic order**: dedup union 後の `provenances` は `Array.prototype.sort()` 後の決定的順序を持つ。
4. **Lifetime**: edge 生成サイトでは provenances を 1 要素で literal 指定し、後段の dedup が必要に応じて union する。生成段階で空配列を作る経路は存在してはならない。

## API 表面

### export 一覧

```ts
export type NonEmptyArray<T>;
export type EdgeProvenance;
export const EDGE_PROVENANCE_VALUES: ReadonlySet<EdgeProvenance>;
export interface GraphEdge;
```

`packages/artgraph/src/types.ts` から既存通り公開。`NonEmptyArray` を新規 export。

### 削除される API

```ts
// 旧（削除）
export interface GraphEdge {
  ...
  provenance?: EdgeProvenance;  // ← 廃止
}
```

旧値 `"tag"` も型 union から削除（`"code-tag"` / `"task-tag"` に分割）。

## 型レベルテスト

`packages/artgraph/tests/req-req-invariants.test.ts` に以下のような assertion を追加（コンパイル時のみ）:

```ts
// 型 union の要素数と runtime Set のサイズ一致
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertEq<A, B, _ extends Eq<A, B> = true> = void;

type RuntimeProvenance = typeof EDGE_PROVENANCE_VALUES extends ReadonlySet<infer U> ? U : never;
type _check = AssertEq<EdgeProvenance, RuntimeProvenance>;  // type-only

// NonEmptyArray が空 tuple を拒否
const empty: NonEmptyArray<EdgeProvenance> = [];
// ^ Type 'never[]' is not assignable to type 'readonly [EdgeProvenance, ...EdgeProvenance[]]'.
//   Source has 0 element(s) but target requires 1.
```

## 後方互換性

未リリースのため非互換変更を許容する。`provenance` 単数フィールド利用箇所は全て `provenances` 配列に書換。旧値 `"tag"` 使用箇所は分割表に従って `"code-tag"` / `"task-tag"` に置換。
