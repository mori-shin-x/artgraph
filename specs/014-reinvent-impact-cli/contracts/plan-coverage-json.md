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
  "implicitImpactsByReq": [
    {
      "reqId": "REQ-001",
      "sourceFiles": ["src/auth.ts"]
    },
    {
      "reqId": "REQ-003",
      "sourceFiles": ["src/auth.ts", "src/session.ts"]
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
| `implicitImpacts` | `ImpactGroup[]` | **by-sourceFile 軸**: sourceFile ごとにグルーピングされた、tasks/plan/spec で言及されていない affected REQ 群 |
| `implicitImpactsByReq` | `ImplicitImpactByReq[]` | **by-FR 軸**: 同じ implicit データを REQ 軸で reorganize したビュー。「FR-003 はどの file 経由で来ているか」を直接知るためのもの。`implicitImpacts` の inversion で、データ重複は意図的 |
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

## `ImplicitImpactByReq` (by-FR 軸)

```json
{
  "reqId": "REQ-003",
  "sourceFiles": ["src/auth.ts", "src/session.ts"]
}
```

| field | type | 説明 |
|---|---|---|
| `reqId` | string | REQ-ID(graph 上の node ID と一致) |
| `sourceFiles` | `string[]` | この REQ に波及した源の sourceFile 群(`implicitImpacts` 内で当該 reqId を含む group 全部の sourceFile を集めて dedup) |

ソート順: `reqId` の lexicographic ascending、`sourceFiles[]` も lexicographic ascending(test の安定性のため `implicitImpacts` と同規約)。

### `implicitImpactsByReq` 算出の不変条件

- `implicitImpactsByReq` の REQ 集合 = `implicitImpacts[].reqs[].reqId` の union(同じ implicit データの inversion なので必ず一致)
- `summary.implicit == implicitImpactsByReq.length`(unique REQ count)
- 各 `implicitImpactsByReq[i].sourceFiles` は `implicitImpacts` の中で当該 reqId を含む group すべての sourceFile を網羅

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
| `"missingFilesSection"` | `--require-files-section` ON で tasks.md の task block(`### T013` 形式の heading、または `- [ ] T013 ...` 形式の flat checklist item — issue #220)に `Files:` セクション無し | `taskId: string` / `line: int` |
| `"unresolvedFilePath"` | `Files:` セクションに書かれた path が graph にも fs にも存在しない(typo 警告) | `sourceFile: string` / `line: int` |
| `"emptyExtraction"` | 分析対象ゼロ: (a) tasks.md / plan.md の両方から file 抽出ゼロ、または (b) 抽出 entry が 1 件も graph 上の分析起点に解決できなかった(例: Stage B fallback が fs に実在するだけの非グラフファイル `package.json` 等を拾ったのみ — issue #220 の silent green 対策) | (なし) |

未知 kind が将来追加されるので、consumer は **未知 kind を無視せず warning として表示** することが推奨される。

text format では、暗黙波及ゼロかつ `emptyExtraction` 発出時のメイン行は「No implicit impacts.」ではなく「Nothing to analyze: ...」で始まる(task block が 1 件以上あり `Files:` セクションが 0 件なら `Nothing to analyze: no Files: sections found across N task(s).`)。「No implicit impacts.」は実際に分析が走った上で暗黙波及ゼロだった場合のみ出力する(issue #220)。

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
  "implicitImpactsByReq": [
    { "reqId": "REQ-001", "sourceFiles": ["src/auth.ts"] },
    { "reqId": "REQ-003", "sourceFiles": ["src/auth.ts"] },
    { "reqId": "REQ-012", "sourceFiles": ["src/parsers/markdown.ts"] }
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
  "implicitImpactsByReq": [],
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
  "implicitImpactsByReq": [
    { "reqId": "REQ-001", "sourceFiles": ["src/auth.ts"] }
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
  "implicitImpactsByReq": [],
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

`--format text`(default)は同じデータを人間可読に整形する。**両軸を併記**する(by-file + by-FR):

```
Implicit impacts (3 REQ(s) impacted but not mentioned):

  By source file:
    src/auth.ts
      REQ-001  (req)
      REQ-003  (req)
    src/parsers/markdown.ts
      REQ-012  (req)

  By requirement:
    REQ-001  ← src/auth.ts
    REQ-003  ← src/auth.ts
    REQ-012  ← src/parsers/markdown.ts

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
