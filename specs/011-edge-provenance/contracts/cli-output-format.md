# Contract: `artgraph graph` 出力フォーマット v2

Plan: [../plan.md](../plan.md) | Data Model: [../data-model.md](../data-model.md) | Related Issue: [#35](https://github.com/ShintaroMorimoto/artgraph/issues/35)

## 対象コマンド

- `artgraph graph`（text 出力、既定）
- `artgraph graph --format json`（JSON 出力）

実装は `packages/artgraph/src/graph/format.ts` の `formatGraphText` / `formatGraphJSON`。

## text 出力

### 形式

旧:
```
└─[derives_from]─ doc:requirements.md
```

新:
```
└─[derives_from {convention}]─ doc:requirements.md
└─[derives_from {convention,frontmatter}]─ doc:requirements.md
```

- `└─[<kind> {<prov1>,<prov2>,...}]─` の形式で provenance を併記。
- 複数 provenance はカンマ区切り（空白なし）で `provenances.sort()` 順に列挙。
- provenance 1 つでも必ず `{...}` を付ける（NonEmpty invariant の可視化）。

### 例

```
doc:specs/011-edge-provenance/spec.md
  └─[derives_from {frontmatter}]─ doc:specs/010-req-req-dependency/spec.md
  └─[contains {structural}]─ FR-001
    └─[depends_on {annotation}]─ AUTH-001
```

## JSON 出力

### 形式

旧（1 経路 1 値 / 値なし）:
```json
{
  "source": "AUTH-002",
  "target": "AUTH-001",
  "kind": "depends_on",
  "provenance": "annotation"
}
```

新（必ず配列、NonEmpty）:
```json
{
  "source": "AUTH-002",
  "target": "AUTH-001",
  "kind": "depends_on",
  "provenances": ["annotation"]
}
```

```json
{
  "source": "doc:design.md",
  "target": "doc:requirements.md",
  "kind": "derives_from",
  "provenances": ["convention", "frontmatter"]
}
```

### スキーマ

```ts
interface GraphJSON {
  nodes: Array<{
    id: string;
    kind: NodeKind;
    filePath: string;
    label: string;
    contentHash: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: EdgeKind;
    provenances: EdgeProvenance[];  // length >= 1
  }>;
}
```

## ランタイムバリデーション（formatGraphJSON）

```ts
const edges = filteredEdges.flatMap((e) => {
  const provenances = e.provenances.filter((p) => EDGE_PROVENANCE_VALUES.has(p));
  if (provenances.length === 0) return [];  // ← edge ごと除外（NonEmpty 維持）
  return [{
    source: e.source,
    target: e.target,
    kind: e.kind,
    provenances: [...provenances].sort(),
  }];
});
```

- 値域フィルタは要素単位（旧仕様: edge 単位）。
- フィルタ後 `provenances.length === 0` となった edge は **edge ごと出力配列から除外** する（NonEmpty invariant を JSON 出力でも守る）。
- 警告は emit しない（不正値は静かに drop）。

## 不変条件

- **INV-O1**: text / JSON いずれも `provenances` 配列は同じ順序（昇順 sort 済み）で出力する。
- **INV-O2**: text 出力で `{...}` 内に値が並ばない（空 `{}`）edge は存在しない。
- **INV-O3**: JSON 出力で `provenances` フィールドが欠落した edge は存在しない。
- **INV-O4**: 旧フィールド名 `provenance`（単数）は新出力に登場しない。

## 廃止される表示

- 旧 text 出力 `└─[derives_from]─` 形式（provenance なし）→ 新形式に置換
- 旧 JSON 出力 `provenance: string | undefined`（単数）→ `provenances: string[]` に置換

## CLI 引数の変更なし

`--format json` / `--kind <NodeKind>` などの既存フラグは挙動・意味とも変更なし。`--provenance` フィルタフラグの追加は本 feature のスコープ外（[../spec.md](../spec.md) §Assumptions 参照）。

## テスト要件

- `tests/graph-format.test.ts` に text 出力の `{...}` 表記テスト。
- 同テストに JSON 出力 `provenances` 配列出力テスト（1 値 / 2 値）。
- `tests/req-req-invariants.test.ts:235-291` の旧「不正な provenance 値は JSON 出力で省略される」テストを「不正値は配列要素レベルで除外、edge ごと除外も発生する」テストに書換。
- INV-O1..O4 を網羅。

## 関連

- 値の語彙は [./edge-provenance-type.md](./edge-provenance-type.md)。
- text/json 双方の sort 規約は [./lock-schema-v2.md](./lock-schema-v2.md) §決定性 と同じ方針。
