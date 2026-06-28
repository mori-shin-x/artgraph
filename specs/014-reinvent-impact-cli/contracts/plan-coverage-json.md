# Contract: `artgraph plan-coverage --format json` Output Schema

**Feature**: impact CLI 再設計 + plan-coverage 新設 | **Date**: 2026-06-28

`artgraph plan-coverage --format json` が stdout に返す JSON の field shape を定義する。

---

## Top-level shape

```json
{
  "implicitImpacts": [
    {
      "sourceFile": "src/auth.ts",
      "reqs": [
        { "reqId": "REQ-001", "kind": "req" },
        { "reqId": "REQ-003", "kind": "req" }
      ]
    }
  ],
  "summary": {
    "totalAffected": 5,
    "mentioned": 1,
    "implicit": 3,
    "ignored": 1
  },
  "diagnostics": [
    {
      "kind": "missingFilesSection",
      "taskId": "T013",
      "line": 42
    }
  ],
  "ignored": ["REQ-007"]
}
```

### Top-level fields

| field | type | 説明 |
|---|---|---|
| `implicitImpacts` | `ImpactGroup[]` | sourceFile ごとにグルーピングされた、tasks/plan/spec で言及されていない affected REQ 群 |
| `summary` | `Summary` | 集計値(後述) |
| `diagnostics` | `Diagnostic[]` | 検証側のメタ情報(missing Files: section 等)。常に出力(空配列もあり) |
| `ignored` | `string[]` | `--ignore` で渡された REQ-ID 列をそのまま返す(透明性のため) |

---

## `ImpactGroup`

```json
{
  "sourceFile": "src/auth.ts",
  "reqs": [
    { "reqId": "REQ-001", "kind": "req" },
    { "reqId": "REQ-003", "kind": "req" }
  ]
}
```

| field | type | 説明 |
|---|---|---|
| `sourceFile` | string | tasks.md / plan.md から抽出された個別 file path(相対 path、repo root 基準)。`impact()` の startIds として渡された file の 1 つ |
| `reqs` | `AffectedReq[]` | この sourceFile から `impact()` BFS で到達した REQ のうち **言及されていないもの** だけ |

複数 sourceFile が同じ REQ に到達した場合は、各 group の `reqs` にそれぞれ含まれる(重複表示で「どの file から波及したか」を保つ)。

### `AffectedReq`

| field | type | 説明 |
|---|---|---|
| `reqId` | string | REQ-ID(graph 上の node ID と一致) |
| `kind` | `"req"` | 固定値(将来 `"doc"` を含める場合に備えて enum 型で残す) |

---

## `Summary`

```json
{
  "totalAffected": 5,
  "mentioned": 1,
  "implicit": 3,
  "ignored": 1
}
```

| field | type | 説明 |
|---|---|---|
| `totalAffected` | int | 全 sourceFile を union した affected REQ の **unique count** |
| `mentioned` | int | そのうち tasks/plan/spec で言及されているもの(出力には含めない) |
| `implicit` | int | 暗黙波及 REQ の unique count(= `implicitImpacts[].reqs` の unique 集合) |
| `ignored` | int | `--ignore` で除外された REQ の unique count |

不変条件: `totalAffected == mentioned + implicit + ignored`(集合論的に保証)。

---

## `Diagnostic`

```json
{
  "kind": "missingFilesSection",
  "taskId": "T013",
  "line": 42
}
```

| field | type | 説明 |
|---|---|---|
| `kind` | enum | 診断種別(下記) |
| 他 | (kind 依存) | kind ごとに付加情報 |

### `Diagnostic.kind` enum

| kind | 出力条件 | 付加 field |
|---|---|---|
| `"missingFilesSection"` | `--require-files-section` ON で tasks.md の task block に `Files:` セクション無し | `taskId: string` / `line: int` |
| `"unresolvedFilePath"` | `Files:` セクションに書かれた path が graph にも fs にも存在しない(typo 警告) | `sourceFile: string` / `line: int` |
| `"emptyExtraction"` | tasks.md / plan.md の両方から file 抽出ゼロ(`unresolvedFilePath` の summary 版) | (なし) |

未知 kind が将来追加されるので、consumer は **未知 kind を無視せず warning として表示** することが推奨される。

---

## 出力例

### Case 1: 暗黙波及あり

```json
{
  "implicitImpacts": [
    {
      "sourceFile": "src/auth.ts",
      "reqs": [
        { "reqId": "REQ-001", "kind": "req" },
        { "reqId": "REQ-003", "kind": "req" }
      ]
    },
    {
      "sourceFile": "src/parsers/markdown.ts",
      "reqs": [
        { "reqId": "REQ-012", "kind": "req" }
      ]
    }
  ],
  "summary": { "totalAffected": 4, "mentioned": 1, "implicit": 3, "ignored": 0 },
  "diagnostics": [],
  "ignored": []
}
```

### Case 2: クリーン (暗黙波及ゼロ)

```json
{
  "implicitImpacts": [],
  "summary": { "totalAffected": 3, "mentioned": 3, "implicit": 0, "ignored": 0 },
  "diagnostics": [],
  "ignored": []
}
```

### Case 3: `--ignore` 適用後 + `--require-files-section` 診断

```json
{
  "implicitImpacts": [
    {
      "sourceFile": "src/auth.ts",
      "reqs": [{ "reqId": "REQ-001", "kind": "req" }]
    }
  ],
  "summary": { "totalAffected": 3, "mentioned": 0, "implicit": 1, "ignored": 2 },
  "diagnostics": [
    { "kind": "missingFilesSection", "taskId": "T013", "line": 42 },
    { "kind": "missingFilesSection", "taskId": "T015", "line": 58 }
  ],
  "ignored": ["REQ-003", "REQ-007"]
}
```

### Case 4: 抽出ゼロ (`--from-tasks` の fixture が空)

```json
{
  "implicitImpacts": [],
  "summary": { "totalAffected": 0, "mentioned": 0, "implicit": 0, "ignored": 0 },
  "diagnostics": [{ "kind": "emptyExtraction" }],
  "ignored": []
}
```

---

## Stability guarantee

- 既存 field の rename / type 変更は **しない**(major version まで)
- 新 field の追加は可(consumer は未知 field を無視するか warning にすること)
- `Diagnostic.kind` enum は追加のみ。既存 kind の意味変更はしない
- `implicitImpacts` の順序: `sourceFile` の lexicographic ascending、各 `reqs[]` 内は `reqId` ascending(test の安定性確保)

---

## Text format との対応

`--format text`(default)は同じデータを人間可読に整形する。主要 field のマッピング:

```
Implicit impacts (3 REQ(s) impacted but not mentioned):

  src/auth.ts
    REQ-001  (req)
    REQ-003  (req)

  src/parsers/markdown.ts
    REQ-012  (req)

Diagnostics: 2
  [missingFilesSection] T013 (line 42)
  [missingFilesSection] T015 (line 58)

Ignored (one-shot): REQ-003, REQ-007

Summary: 4 affected | 1 mentioned | 3 implicit | 0 ignored
```

末尾に必要なら **what to do next** の hint を追加:

```
To resolve:
  • Touch the REQ in tasks.md, or
  • Add a Considered/Affected line referencing the REQ-ID, or
  • Pass --ignore REQ-001,REQ-003,REQ-012 for one-shot suppression.
```
