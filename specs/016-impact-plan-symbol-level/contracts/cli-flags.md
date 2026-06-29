# Contract: artgraph impact CLI flags

**Spec**: [spec.md](../spec.md)

`artgraph impact` は 4 channel (file 直接 / `--from-tasks` / `--from-plan` / `--diff`) で起動し、symbol syntax (`path:symbol`) を受理する。本契約は CLI の引数解釈、エラー、出力フォーマットの最終形を宣言する。

---

## 1. 起動形式

### 1.1 直接入力

```bash
artgraph impact src/auth.ts:validateToken
artgraph impact src/auth.ts:validateToken src/session.ts:createSession
artgraph impact src/auth.ts:validateToken src/legacy.ts            # symbol と file 混在
```

- 各 target string について `^([^:\s]+\.[\w]+):([^\s,()]+)$` でマッチ判定 (parser と同じ regex)。
- マッチ → `SymbolEntry { path, symbol, line: 0 }` として `resolveStartIds()` に渡す。
- 非マッチ → `SymbolEntry { path, line: 0 }` (`symbol === undefined`) として渡す。

### 1.2 `--from-tasks` / `--from-plan` 経由

parser (`extractFiles`) が `ExtractResult.entries: SymbolEntry[]` を返すので、CLI はそれをそのまま `resolveStartIds()` に渡す。

### 1.3 `--diff` 経由

`--diff` は git diff から file 単位の path しか取れないため、symbol 単位の起動はできない (本 spec のスコープ外)。各 path は `SymbolEntry { path, line: 0 }` として渡す。

---

## 2. 引数検証順序

REQ-ID rejection と `doc:` prefix rejection は **symbol 検出より先に評価** (FR-012):

```
1. REQ-ID rejection (REQ_ID_INPUT_RE)
2. doc: prefix rejection
3. Mutually exclusive source check (targets / --from-tasks / --from-plan / --diff)
4. symbol syntax detection (各 target に対し path:symbol regex)
5. graph scan + resolve start ids
6. scan-mode mismatch check (R-010)
7. impact BFS 実行
```

REQ-ID と symbol input を同時指定 (`artgraph impact REQ-001 src/auth.ts:fn`) → 1 で先に reject、symbol 検出はスキップ。

---

## 3. `--mode` フラグの自動推論

| ユーザ指定 `--mode` | 入力タイプ | 内部 mode | 備考 |
|---|---|---|---|
| 未指定 | file path のみ | config の mode を継承 (file or symbol) | デフォルト挙動 |
| 未指定 | 1 つ以上の symbol entry あり | 内部で symbol 扱い | 自動推論 (FR-009) |
| `--mode file` | 任意 | file | symbol entry は parser で `symbol:..#..` lookup を試みるが、symbol node が graph に無ければ後段で miss |
| `--mode symbol` | 任意 | symbol | symbol-mode 解決 |

注: `--mode` は **scan の挙動を変えるフラグ** ではなく、**graph 解釈の指示** に近い。

---

## 4. エラーメッセージ仕様

### 4.1 symbol が解決できないケース (per entry)

graph に symbol node が **存在する** が、入力した `path:symbol` が graph に miss:

```
ERROR: No matching symbol found for: src/auth.ts:validateToken
  hint: check the export name with `grep "export.*validateToken" src/auth.ts`
        or verify that `mode: "symbol"` is set in `.artgraph.json` and re-scan.
```

exit code: 1。symbol miss が 1 件でもあればこのメッセージで exit (US2 Acceptance Scenario 2)。

### 4.2 graph に symbol node が 1 つもないケース (グローバル)

`graph.nodes` をスキャンしても `kind === "symbol"` のノードが 0 件 (R-010 / R-011):

```
ERROR: symbol-level input requires `artgraph scan --mode symbol`.
       Set `mode: "symbol"` in `.artgraph.json` and re-run scan to enable
       symbol-mode lookup.
```

exit code: 1。`--from-tasks` 経由でも同じ。

### 4.3 4-path navigational error

REQ-ID / `doc:` prefix 入力時の navigational error は file / symbol どちらの入力でも変わらない 4-channel ガイダンスを表示。symbol 案内は追記しない (symbol は path の延長として認識されるため、REQ-ID rejection と同列ではない)。

---

## 5. 出力フォーマット (JSON / text)

### 5.1 JSON `ImpactResult`

```json
{
  "affectedFiles": ["src/auth.ts"],
  "impactReqs": ["REQ-001", "REQ-007"],
  "originReqs": ["REQ-001"],
  "affectedDocs": [],
  "affectedTasks": [],
  "drifted": [],
  "summary": { "files": 1, "reqs": 2, "docs": 0, "tasks": 0 }
}
```

| field | type | 説明 |
|---|---|---|
| `affectedFiles` | string[] | forward BFS で到達した file path、dedup + sort 済 |
| `impactReqs` | string[] | forward BFS で到達した REQ-ID、dedup + sort 済 |
| `originReqs` | string[] | 全 start ids の `@impl` claim を `implements` edge で 1-hop 辿って得た REQ-ID 集合の union、dedup + sort 済 (FR-014) |
| `affectedDocs` | string[] | forward BFS で到達した doc id |
| `affectedTasks` | string[] | forward BFS で到達した task id |
| `drifted` | string[] | spec / code の整合性破れリスト (既存仕様) |
| `summary` | object | 集計値 |

`originReqs` は file 起点なら file-top `@impl` タグの集合、symbol 起点なら symbol の `@impl` タグの集合。タグ無し起点なら空配列で寄与する。

### 5.2 text フォーマット

text 出力は最低限以下の 3 セクションで構成する:

```
Affected files:
  src/auth.ts

Impact REQs:
  REQ-001
  REQ-007

Origin REQs:
  REQ-001

Drift candidates:
  REQ-007
```

- **Impact REQs** = `impactReqs` (BFS 結果) を 1 行 1 ID で列挙。
- **Origin REQs** = `originReqs` (start ids の `@impl` claim 集合) を 1 行 1 ID で列挙。
- **Drift candidates** = `impactReqs \ originReqs` の集合差分を 1 行 1 ID で列挙 (FR-015)。差分が空集合のときは **セクション自体を省略**。

---

## 6. テスト合意 (CLI integration)

`tests/impact-cli.test.ts` で必要なケース:

1. symbol mode fixture で `artgraph impact src/auth.ts:validateToken --format json` → exit 0、`impactReqs` に validateToken 経由の REQ-001 のみ、REQ-005 / REQ-009 は含まない。`originReqs === ["REQ-001"]`。
2. 同 fixture で `artgraph impact src/auth.ts:doesNotExist` → exit 1、stderr に 4.1 のメッセージ。
3. file mode fixture (scan が `mode: file`) で `artgraph impact src/auth.ts:fn` → exit 1、stderr に 4.2 のメッセージ。
4. REQ-ID と symbol input の併用 → 4-path navigational error (FR-012 確認)。
5. `--from-tasks` で symbol entry を含む tasks.md → symbol 起点で impact が走り、`originReqs` が tasks 由来 symbol の `@impl` claim と一致。
6. file + symbol 混在 (`artgraph impact src/auth.ts:fn src/legacy.ts`) → file 単位の legacy も含む forward 波及。`originReqs` は symbol の `@impl` ∪ file-top `@impl` (legacy 側) の union。
7. spec で `REQ-001 depends_on REQ-007` を追加した fixture で `artgraph impact src/auth.ts:validateToken` → `impactReqs = ["REQ-001", "REQ-007"]`, `originReqs = ["REQ-001"]`, text 出力に `Drift candidates: REQ-007` セクションが現れる。
8. `originReqs == impactReqs` のケース (ドリフトなし) → text 出力に `Drift candidates` セクションが **現れない** (空集合のためセクション省略)。
