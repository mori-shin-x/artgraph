# Phase 1: Data Model — req→req dependency annotation

Date: 2026-06-24
Plan: [plan.md](./plan.md) | Research: [research.md](./research.md)

## 概要

本 feature は既存の `ArtifactGraph` 型に対し、新規ノード型は追加せず、
`GraphEdge` への optional フィールド 1 つ（`provenance`）追加と、新規エンティティ
`AnnotationExtract` を parser の中間表現として導入する。

## 既存型の拡張

### `GraphEdge` (in `packages/artgraph/src/types.ts`)

```ts
export type EdgeProvenance = "annotation" | "frontmatter" | "convention" | "tag";

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  provenance?: EdgeProvenance;  // ← 追加
}
```

- フィールドは optional。既存エッジは undefined のまま運用（Issue #35 解決時に
  全エッジへ後追い付与する）。
- 本 issue で生成する req→req エッジには必ず `"annotation"` を付与する。
- dedup（`buildGraph` 内）で同一 (source, target, kind) が複数経路から生成された
  場合、provenance は「最初に到達した値」を保持する（本 issue では req→req は
  注釈経路のみのため衝突は発生しない。複数 provenance のマージは #35 で扱う）。

### `EdgeKind`

変更なし。既存の `depends_on` / `derives_from` を再利用する。

### `ParseWarning`（既存）

新規 type を 2 つ追加:

```ts
type WarningType =
  | "orphan-edge"           // 既存
  | "invalid-relation"      // 既存
  | "ambiguous-target"      // 既存
  // ↓ 追加
  | "invalid-annotation-id"
  | "empty-annotation"
  | "self-reference-annotation";
```

各 warning は既存 `ParseWarning` / `BuildWarning` のいずれかに分類して emit する
（`invalid-annotation-id` と `empty-annotation` は parser、
`self-reference-annotation` は builder）。

## 新規エンティティ（parser 内部）

### `AnnotationExtract`

`parseMarkdown` 内で注釈抽出関数が返す中間表現。グラフには直接格納しない。

```ts
interface AnnotationExtract {
  reqId: string;              // 注釈が紐づく req の ID（source 側）
  kind: "depends_on" | "derives_from";
  targets: string[];          // カンマ区切り展開・**BOLD** 剥がし・空白 trim 済み
  sourceLine: number;         // 1-based, デバッグ用（warning メッセージで活用）
}
```

- builder へは `GraphEdge` 形式に展開して渡される（1 つの `AnnotationExtract` が
  `targets.length` 本の edge になる）。
- 同一行に注釈が複数ある場合（`(depends_on: A)(derives_from: B)` 等）は別々の
  `AnnotationExtract` として返す。
- 警告（`invalid-annotation-id`、`empty-annotation`）は抽出時に emit され、
  `AnnotationExtract` には残らない（valid な ID のみ `targets` に含む）。

### `StrippedReqText`

req の content-hash 計算で使う中間表現。

```ts
interface StrippedReqText {
  reqId: string;
  text: string;     // 注釈除去後の本文（hash の入力になる）
}
```

- list-item req: `toString(node)` から注釈括弧群を除去
- heading req: `extractSectionContent(content, startLine)` の出力から、最初の
  段落範囲の冒頭・末尾の注釈括弧を除去
- 純粋関数 `stripAnnotations(text: string): string` を 1 つ用意し、共通利用する

## エンティティ関係図

```text
parseMarkdown(file)
  ├─ visit listItem
  │    ├─ extractAnnotations(line)       → AnnotationExtract[]
  │    └─ stripAnnotations(toString(node)) → hash 入力
  ├─ visit heading (KIRO_HEADING_RE)
  │    ├─ extractAnnotations(段落冒頭/末尾) → AnnotationExtract[]
  │    └─ stripAnnotations(extractSectionContent(...)) → hash 入力
  └─ → ParseResult { nodes, edges (req→req含む), warnings }

buildGraph(parseResults)
  ├─ collisionDetection (specDir/REQ)
  ├─ remapId() を req→req edge にも適用
  └─ self-reference / orphan-edge 検出 → BuildWarning
```

## 不変条件（invariants）

1. `GraphEdge.provenance === "annotation"` ⟺ 注釈経路で生成された edge である
   （本 issue 内のみ。#35 解決後は他経路でも付与される）
2. 注釈で生成された edge の `source` は必ず本ファイル内の req ID と一致する
   （`AnnotationExtract.reqId` から派生）
3. 注釈除去後の本文文字列は注釈の有無・追加・削除・依存先 ID 変更に対して不変である
   （SC-003 の根拠）
4. `(depends_on: X, Y, Z)` から生成される 3 本の edge は `source, kind, provenance`
   が同一で `target` のみ異なる（複数 ID 注釈の意味論）

## 永続化への影響

- `.trace.lock` は `dependsOn: string[]` 形式を維持。注釈由来エッジも他のエッジと
  同様に「依存先 ID の重複なし配列」として書き出される。lock スキーマ自体への
  変更はなし。
- `provenance` フィールドは lock には書き出さない（in-memory のグラフ表現のみ）。
  Issue #35 の解決時に lock シリアライゼーションを再設計する想定。
