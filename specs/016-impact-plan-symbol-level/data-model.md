# Data Model: impact / plan-coverage の symbol-level 入力対応

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

本ドキュメントは spec 016 で定義する型 (TypeScript interface / type) を、所属モジュールと共に列挙する正準参照。

artgraph は未リリースのため、本 spec は **後方互換 / 既存ユーザー保護を一切考慮しない**。spec 014 で書いた型 / 関数 / JSON schema は本ドキュメントで宣言される形 (= 正準形) に **clean に置き換える**。「spec 014 既存」「移行用 v2」といった併走表現は採らず、各型はそれ自体が本 spec 出荷時点の正準形である。

---

## 1. `src/parsers/sdd-files.ts` の型

### 1.1 SymbolEntry

```ts
/**
 * Stage A parser が抽出する file/symbol 単位エントリ。
 *
 *  - `symbol === undefined` のときは file unit 起点 (`Files: src/a.ts`)。
 *  - `symbol !== undefined` のときは symbol unit 起点 (`Files: src/a.ts:fn1`)。
 *
 * `line` は 1-based 行番号 (Stage A の宣言行を指す)。
 */
export interface SymbolEntry {
  path: string;
  symbol?: string;
  line: number;
}
```

### 1.2 ExtractResult

```ts
export type ExtractResult = {
  /**
   * Stage A が抽出した file/symbol エントリの正準配列。
   * 入力順を保持し、`(path, symbol ?? null)` で dedup 済。Stage B (regex
   * fallback) が走った場合は file unit のみが含まれる (`symbol` は常に undefined)。
   * Stage A も Stage B もマッチしない場合は空配列 + `stage: "empty"`。
   */
  entries: SymbolEntry[];
  stage: "files-section" | "regex-fallback" | "empty";
  diagnostics: Diagnostic[];
  /**
   * heading-delimited task blocks と `Files:` 宣言有無。`### T<NNN>` 形式の
   * 見出しが無い入力では空配列 / undefined。
   */
  taskBlocks?: TaskBlock[];
};
```

`files: string[]` フィールドは **存在しない**。caller が file-only な集合を必要とするときは `entries.map(e => e.path)` を呼び出し側で dedup する。

### 1.3 Diagnostic

```ts
export type Diagnostic =
  | { kind: "unresolvedFilePath"; path: string; line: number }
  | {
      /**
       * Stage A の `path:symbol` 構文で path は graph or fs に存在するが
       * symbol が graph 未登録のケース。`unresolvedFilePath` と排他
       * (per entry、INV-S1)。
       */
      kind: "unresolvedSymbol";
      sourceFile: string;
      symbol: string;
      line: number;
    };
```

`unresolvedSymbol` の発出責務は parser 側 (Stage A) — parser は `ExtractOptions.graph` を参照可能なので、path 存在検証と同じ場所で symbol 解決検証を行える。

### 1.4 TaskBlock / ExtractOptions

spec 014 から継承 (本 spec で形状変更なし)。`TaskBlock` は `{ taskId: string; line: number; hasFilesSection: boolean }`、`ExtractOptions` は `{ graph: ArtifactGraph; repoRoot: string }`。

---

## 2. `src/graph/traverse.ts` の API

### 2.1 resolveStartIds (唯一のエクスポート)

```ts
/**
 * SymbolEntry の配列から impact() 用 startIds を解決する。
 *
 *  - `entry.symbol === undefined` → file unit 経路。`file:<path>` ノードに
 *    加え、同 file 上の `symbol:<path>#*` ノード群も startIds に含める。
 *  - `entry.symbol !== undefined` → `symbol:<path>#<name>` を直接 lookup。
 *    解決成功なら startIds に追加、失敗なら `unresolvedSymbols[]` に積む。
 *
 * `startIds` は重複なし、`entries` の入力順を保持 (INV-S2)。
 * `unresolvedSymbols[]` は CLI / plan-coverage 側で diagnostic 生成に用いる。
 */
export function resolveStartIds(
  graph: ArtifactGraph,
  entries: SymbolEntry[],
): {
  startIds: string[];
  unresolvedSymbols: SymbolEntry[];
};
```

### 2.2 resolveFileStartIds は廃止

spec 014 で導入された `resolveFileStartIds(graph, inputs: string[]): string[]` は本 spec で **完全削除** する。caller (CLI / plan-coverage) は文字列入力を一度 `SymbolEntry[]` (symbol 省略) に lift してから `resolveStartIds` を呼ぶ。レガシー alias は再エクスポートしない。

### 2.3 impact

`impact(graph, startIds, lock, maxDepth)` の BFS ロジックそれ自体は spec 014 から変更なし — startIds に symbol id (`symbol:src/a.ts#fn1`) が渡れば既存 BFS が自然に symbol 起点 forward 波及を辿る。戻り値 `ImpactResult` のスキーマ拡張は §3.5 で扱う (caller 側の追加 field 計算が必要なため、CLI / plan-coverage 層で組み立てる)。

---

## 3. `src/plan-coverage/index.ts` の型

### 3.1 ReqEntry

```ts
/**
 * impactReqs / originReqs の要素型。spec 014 で `AffectedReqEntry` と
 * 呼ばれていたものを本 spec で `ReqEntry` に rename し、用途を「波及先 REQ」
 * 「由来 REQ」共通の要素型として広げる。
 */
export interface ReqEntry {
  reqId: string;
  kind: "req";
}
```

### 3.2 ImpactGroup

```ts
export interface ImpactGroup {
  sourceFile: string;
  /** symbol 起点のとき symbol 名、file 起点のとき undefined。 */
  sourceSymbol?: string;
  /**
   * startId からの forward BFS で到達した REQ 集合 (reqId で sort 済)。
   * `--ignore` および mention 済 REQ は除外済。
   */
  impactReqs: ReqEntry[];
  /**
   * startId ノード (file or symbol) の `@impl` claim を `implements` edge 1
   * hop 逆向きに辿って到達した REQ 集合 (reqId で sort 済、INV-S5)。
   * symbol 起点で symbol が `@impl` claim を持たない、もしくは file 入力で
   * file-top `@impl` タグが無いケースは `[]`。
   *
   * Barrel 例外 (issue #191): symbol 起点の場合、primary node に加えて
   * `imports` エッジ (symbol → symbol) を transitively 辿った全 symbol
   * ノードの `implements` エッジも union に含める。`export { x } from` 経由
   * の barrel は自身に `implements` を持たず origin symbol にしか REQ
   * 主張が無いため、この拡張がないと `impactReqs \ originReqs` が
   * false-positive drift として出る。多段 barrel (index → sub → origin)
   * も visited セット付き BFS で origin まで到達する。
   */
  originReqs: ReqEntry[];
}
```

`reqs` フィールドは存在しない。dedup キー: `(sourceFile, sourceSymbol ?? null)` (INV-S3)。同 file の複数 symbol entry は別 group になる。

### 3.3 ImplicitImpactByReq

```ts
export interface ImplicitImpactByReq {
  reqId: string;
  /**
   * symbol 情報込みの起点ロケーション (file 昇順 → symbol 昇順、`symbol
   * === undefined` は同 file 内で先頭、INV-S4)。
   * Caller は `sourceLocations.map(l => l.file)` で file-only ビューを得る。
   */
  sourceLocations: Array<{ file: string; symbol?: string }>;
}
```

`sourceFiles: string[]` フィールドは存在しない。file-only ビューが必要な caller は `sourceLocations` から導出する。

### 3.4 PlanCoverageDiagnostic

```ts
export type PlanCoverageDiagnostic =
  | { kind: "missingFilesSection"; taskId: string; line: number }
  | { kind: "unresolvedFilePath"; sourceFile: string; line: number }
  | {
      kind: "unresolvedSymbol";
      sourceFile: string;
      symbol: string;
      line: number;
    }
  | { kind: "emptyExtraction" };
```

parser の `Diagnostic.unresolvedSymbol` を平坦化して流し込む。

### 3.5 ImpactResult (impact CLI 出力拡張)

spec 014 の `ImpactResult` を spec 016 で **`originReqs` 1 フィールドのみ追加** した形に再宣言する (それ以外の field は変更なし、INV-S7)。型は `src/types.ts` に置く:

```ts
export interface ImpactResult {
  affectedFiles: string[];
  affectedDocs: string[];
  impactReqs: string[];
  affectedTasks: string[];
  drifted: DriftEntry[];
  /**
   * 本 spec で追加。startIds 全ノードの `@impl` claim を `implements` edge
   * 1 hop 逆向きに辿って得た REQ 集合の union (dedup + reqId 昇順 sort、
   * INV-S6)。`@impl` claim を持つ startId が無い場合は `[]`。
   */
  originReqs: string[];
  summary?: ImpactSummary;
}
```

`originReqs` の populate は CLI / plan-coverage 層で `impact()` の戻り値に追加する。`impact()` 内部 BFS ロジックの変更は不要 (research R-006 に基づく)。

### 3.6 PlanCoverageOptions / PlanCoverageSummary / PlanCoverageResult / PlanCoverageRunResult

シグネチャ変更なし。`PlanCoverageResult` の `implicitImpacts` / `implicitImpactsByReq` / `diagnostics` の **要素型** が上述の通り再定義される。

---

## 4. `src/cli.ts` (impact subcommand) の挙動

型レベルの新規追加なし。挙動として:

1. `targets[]` の各 string が `PATH_SYMBOL_RE` (research R-003) にマッチすれば `{ path, symbol, line: 1 }` の `SymbolEntry` に lift、そうでなければ `{ path, line: 1 }` (symbol undefined) に lift。両者をまとめて `SymbolEntry[]` として `resolveStartIds()` に渡す。
2. `--from-tasks` / `--from-plan` の結果 (`ExtractResult.entries`) を `resolveStartIds()` の入力にそのまま渡す。
3. `resolveStartIds()` の戻り値 `unresolvedSymbols[]` が空でなく、graph 内に symbol node が 1 つも存在しない場合は R-010 のグローバルエラーメッセージ (`symbol-level input requires \`artgraph scan --mode symbol\``) で exit 1。
4. `unresolvedSymbols[]` が空でなく graph に symbol node がある場合は per-entry の `No matching symbol found for: <path>:<name>` を stderr に並べて exit 1 (US2 Acceptance Scenario 3)。
5. `startIds[]` が空になる場合は `No matching nodes found for: ...` で exit 1。
6. `impact()` の戻り値に対して `originReqs` を後付けで計算: `startIds` の全 ノードについて graph 上で source = startId かつ kind = `implements` の edge を取り、target が REQ ノードのものを集めて dedup + reqId 昇順 sort (INV-S6)。これを `ImpactResult.originReqs` にセット。
7. text 出力で `impactReqs \ originReqs` が非空の場合、`Drift candidates:` セクションを追加して列挙する (空集合の場合はセクション省略、FR-015)。
8. REQ-ID rejection (`REQ_ID_INPUT_RE`) と `doc:` prefix rejection は **symbol 検出より先に評価** (FR-012)。

---

## 5. contract ファイル

本 spec の正準契約は以下に分割される (各ファイルが本 spec 出荷時点の唯一の真実):

- `contracts/sdd-files-parser.md` — Stage A の `path:symbol` 構文、`SymbolEntry` 抽出ルール、`unresolvedSymbol` / `unresolvedFilePath` 排他則。
- `contracts/cli-flags.md` — `artgraph impact` の symbol 直接入力受理、`--from-tasks` / `--from-plan` 経由の `SymbolEntry` 継承、二軸出力 (`impactReqs` / `originReqs` / `Drift candidates`)。
- `contracts/plan-coverage-json.md` — `implicitImpacts[]` (二軸 `impactReqs` / `originReqs` + `sourceSymbol?`) / `implicitImpactsByReq[]` (`sourceLocations`) / `diagnostics[]` (`unresolvedSymbol` 追加) のスキーマ。

`contracts/mention-semantics.md` (spec 014) は本 spec で mention 検出ロジックを触らないため変更なし。

---

## 6. 不変条件 (Invariants)

実装時に保つべき性質。テストは各 INV を最低 1 ケースで検証する。

- **INV-S1**: 1 entry に対して `Diagnostic.unresolvedFilePath` と `Diagnostic.unresolvedSymbol` は同時に発出しない (R-009)。`unresolvedFilePath` が立つときは symbol 解決を試行しない。
- **INV-S2**: `resolveStartIds(graph, entries).startIds[]` は重複なし (Set 化済)、order は `entries[]` の入力順を保持する。
- **INV-S3**: `ImpactGroup` の dedup キーは `(sourceFile, sourceSymbol ?? null)` の複合。同 group 内の `impactReqs[]` / `originReqs[]` はそれぞれ reqId 昇順 sort 済。
- **INV-S4**: `ImplicitImpactByReq.sourceLocations[]` は (file, symbol) で sort 済 — `file` 昇順を主キーに、同 file 内では `symbol` 昇順 (`symbol === undefined` は同 file 内で先頭)。
- **INV-S5**: `ImpactGroup.originReqs` の REQ 集合 = startId ノードから graph 上で source = startId かつ kind = `implements` の edge を 1 hop 逆向きに辿った target ノード集合のうち kind = `req` のものの dedup + reqId 昇順 sort。
- **INV-S6**: `ImpactResult.originReqs` = startIds の全ノードについて INV-S5 と同手順で取得した REQ ID 集合の union を dedup + reqId 昇順 sort したもの。
- **INV-S7**: `ImpactResult` は spec 014 既存の `{ affectedFiles, affectedDocs, impactReqs, affectedTasks, drifted, summary? }` に `originReqs: string[]` を追加した形以外の変更を持たない。新規 field 追加は `originReqs` ただ 1 つ。
