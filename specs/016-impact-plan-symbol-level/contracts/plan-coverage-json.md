# Contract: plan-coverage JSON output

**Spec**: [spec.md](../spec.md)

`artgraph plan-coverage --format json` の出力スキーマを宣言する。ImpactGroup は `impactReqs` / `originReqs` の二軸を持ち、by-Req axis は `sourceLocations` で symbol 情報を保持する。

---

## 1. Top-level

```json
{
  "implicitImpacts": [ /* ImpactGroup[] */ ],
  "implicitImpactsByReq": [ /* ImplicitImpactByReq[] */ ],
  "summary": { /* PlanCoverageSummary */ },
  "diagnostics": [ /* PlanCoverageDiagnostic[] */ ],
  "ignored": [ /* string[] */ ]
}
```

---

## 2. ImpactGroup

```json
{
  "sourceFile": "src/auth.ts",
  "sourceSymbol": "validateToken",
  "impactReqs": [
    { "reqId": "REQ-001", "kind": "req" }
  ],
  "originReqs": [
    { "reqId": "REQ-001", "kind": "req" }
  ]
}
```

| field | type | 説明 |
|---|---|---|
| `sourceFile` | string (必須) | 起点 path (repo-relative, normalize 済) |
| `sourceSymbol` | string \| absent | symbol 起点なら export 名、file 起点では **field 自体を省略** |
| `impactReqs` | ReqEntry[] (必須) | startId からの forward BFS で到達した REQ 集合 |
| `originReqs` | ReqEntry[] (必須) | startId ノード (file node or symbol node) の `@impl` claim を `implements` edge で 1-hop 辿った REQ 集合 |

`ReqEntry = { reqId: string; kind: "req" }`。

### 2.1 file 起点 (file unit) のとき

```json
{
  "sourceFile": "src/auth.ts",
  "impactReqs": [ /* ... */ ],
  "originReqs": [ /* ... */ ]
}
```

`sourceSymbol` は **存在しない** (undefined ではなく JSON key そのものが省略)。`originReqs` は file-top `@impl` タグの集合。file-top タグが無ければ `originReqs: []` (空配列を必ず populate、key 省略はしない)。

### 2.2 dedup ルール

`(sourceFile, sourceSymbol ?? null)` の複合キーで unique。同 file の異なる symbol entry は別 group として並ぶ。file 起点 + symbol 起点が同 file で共存することも可能 (混在 tasks.md)。

### 2.3 sort 順

1. `sourceFile` ascending
2. 同 file 内では `sourceSymbol` ascending (undefined を最初)

### 2.4 `impactReqs` / `originReqs` の関係

両配列は独立して populate される。consumer は集合差分 `impactReqs \ originReqs` を計算してドリフト候補を導出できる (SC-003)。両配列とも内部で REQ-ID ascending sort 済。`impactReqs` が空かつ `originReqs` 非空のケース、`impactReqs` 非空かつ `originReqs` 空のケースのいずれも valid。

---

## 3. ImplicitImpactByReq

```json
{
  "reqId": "REQ-001",
  "sourceLocations": [
    { "file": "src/auth.ts", "symbol": "validateToken" }
  ]
}
```

| field | type | 説明 |
|---|---|---|
| `reqId` | string (必須) | REQ-ID |
| `sourceLocations` | Array<{file, symbol?}> (必須) | この REQ に到達した起点ロケーション集合 |

`sourceLocations[i].file` は必須。`sourceLocations[i].symbol` は symbol 起点なら export 名、file 起点では key 省略。

### 3.1 sort 順

1. `file` ascending
2. 同 file 内では `symbol` ascending (undefined を最初)

`reqId` 配列全体は ascending sort 済。

---

## 4. PlanCoverageDiagnostic

`kind` discriminator: `"missingFilesSection"` / `"unresolvedFilePath"` / `"emptyExtraction"` / `"unresolvedSymbol"`。

`unresolvedSymbol` の形:

```json
{
  "kind": "unresolvedSymbol",
  "sourceFile": "src/auth.ts",
  "symbol": "doesNotExist",
  "line": 17
}
```

| field | type | 説明 |
|---|---|---|
| `kind` | `"unresolvedSymbol"` | discriminator |
| `sourceFile` | string | path 部分 (graph or fs に存在) |
| `symbol` | string | `:` 後ろの生文字列 |
| `line` | number | 1-based 行番号 |

### 4.1 排他ルール

1 entry に対して `unresolvedFilePath` と `unresolvedSymbol` は **同時発出しない** (`unresolvedFilePath` 優先)。

### 4.2 diagnostic から `implicitImpacts` への影響

`unresolvedSymbol` を持つ entry は `implicitImpacts` から除外 (startId が解決できなかったため)。

---

## 5. summary

```json
{
  "totalAffected": 3,
  "mentioned": 1,
  "implicit": 2,
  "ignored": 0
}
```

symbol 起点で集計される REQ も `totalAffected` / `implicit` に含まれる。

---

## 6. Exit code

- `--gate` 無し → 常に 0
- `--gate` 有り + `implicitImpacts.length > 0` または `diagnostics.length > 0` → 1
- `--gate` 有り + 上記すべて 0 → 0

`unresolvedSymbol` diagnostic は `diagnostics[]` に積まれるので、`--gate` 付きでは exit 1 に寄与する。

---

## 7. text フォーマット

`formatText` の出力で symbol 起点は `src/auth.ts#validateToken` の形で表示。各 ImpactGroup について `impactReqs:` と `originReqs:` を別セクションで併記する:

```
Implicit impacts (2 REQ(s) impacted but not mentioned):

  By source file:
    src/auth.ts#validateToken
      impactReqs:
        REQ-001  (req)
        REQ-007  (req)
      originReqs:
        REQ-001  (req)
    src/session.ts
      impactReqs:
        REQ-009  (req)
      originReqs:
        REQ-009  (req)

  By requirement:
    REQ-001  <- src/auth.ts#validateToken
    REQ-007  <- src/auth.ts#validateToken
    REQ-009  <- src/session.ts
```

diagnostic 表示:

```
Diagnostics: 1
  [unresolvedSymbol] src/auth.ts#doesNotExist (line 17)
```

`impactReqs` / `originReqs` が空のセクションは "(none)" を 1 行表示する (空 vs 計算未実行を見分けるため)。

---

## 8. テスト合意 (plan-coverage integration)

`tests/plan-coverage.test.ts` で必要なケース:

1. tasks.md `Files: src/auth.ts:validateToken` → `implicitImpacts[0]` に `sourceSymbol: "validateToken"`, `impactReqs` / `originReqs` の両方が populate される。`implicitImpactsByReq[0].sourceLocations[0] = { file: "src/auth.ts", symbol: "validateToken" }`。
2. file unit `Files: src/auth.ts` で file-top に `@impl REQ-X` タグ有り → `implicitImpacts[0]` の `sourceSymbol` は **存在しない** (JSON key 省略)、`originReqs` は file-top タグの集合。
3. file unit `Files: src/auth.ts` で file-top に `@impl` タグ無し → `implicitImpacts[0].originReqs === []` (空配列、key 省略はしない)。
4. 1 file 多 symbol (`Files: src/auth.ts:fn1, src/auth.ts:fn2`) → `implicitImpacts` に 2 entry、`sourceFile` 同じ `sourceSymbol` 異なる、各 entry の `originReqs` はそれぞれの `@impl` claim と一致。
5. symbol 未登録 (`Files: src/auth.ts:doesNotExist`) → `diagnostics` に `unresolvedSymbol`、`implicitImpacts` から除外。
6. file unit + symbol 混在 → `implicitImpacts` に file entry (sourceSymbol なし) と symbol entry (sourceSymbol あり) が並ぶ。
7. `--gate` + `unresolvedSymbol` のみ (implicit ゼロ) → exit 1 (diagnostic が non-empty)。
8. `implicitImpactsByReq[].sourceLocations` の sort 順検証: `file` ascending、同 file 内 `symbol` undefined を先頭。
9. spec で `REQ-001 depends_on REQ-007` を追加した fixture で symbol 起点 → `impactReqs = [REQ-001, REQ-007]`, `originReqs = [REQ-001]` となり、consumer 側で `impactReqs \ originReqs = [REQ-007]` が計算可能 (SC-006)。
