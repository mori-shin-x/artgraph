# Data Model: カバレッジ由来トレーサビリティ (spec 020)

## 1. TraceShard(runner 出力・raw)

ワーカーごとの JSONL。1 行 = 1 レコード。詳細スキーマは [contracts/trace-artifact.md](./contracts/trace-artifact.md)。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `schemaVersion` | number | shard スキーマ世代。ingest は未知世代を stale 扱い(Edge Case: rename 不能 trace) |
| `kind` | `"test"` \| `"skipped"` \| `"meta"` | レコード種別 |
| `testName` / `suitePath` | string / string[] | タグ抽出対象(describe 祖先継承は ingest 側で spec 006 の `extractReqTags` 規則を適用) |
| `testFile` | string | リポジトリ相対パス |
| `passed` | boolean | green のみ証拠採用(D6) |
| `hits` | Array<{file, fn}> | 実行された関数。file はリポジトリ相対、fn は V8 `functionName`。module-init は runner 側で除外済み(FR-007) |
| `hashes` | Record<file, contentHash> | 実行ファイルの取得時ハッシュ(staleness 基準、D7) |
| `skippedReason` | `"concurrent"` 等 | kind=skipped 時のみ(FR-003) |

**不変条件**: runner は追記のみ・正規化しない。ソート・dedup・boolean 化・和集合はすべて ingest 側(D4)。

## 2. NormalizedTrace(ingest 出力・in-memory)

`graph = f(files, trace)` の trace 側入力。決定的正規化の結果。

```
NormalizedTrace {
  perReq: Map<reqId, {
    symbols: SortedSet<nodeId>       // green テストのカバレッジ和集合 (FR-006)
    files:   SortedSet<nodeId>       // 名前 join 失敗分の file 粒度フォールバック (FR-007)
    tests:   SortedSet<testRef>      // testFile + testName (impact --tests の材料)
  }>
  hashesAtTrace: Map<nodeId, contentHash>   // staleness 判定 (FR-015)
  diagnostics: { dangling: number, skipped: number, unknownSchema: number }  // silent skip 禁止
}
```

**正規化規則**(FR-004): 実行回数 → boolean、エントリは辞書順ソート、シャード間は和集合。実行順・ワーカー割当に依存しない。

## 3. 名前表(SymbolNameTable、scan 時に構築・transient)

`extractSymbols` の出力から導出。lock には保存しない(バイトスパン非永続の既存方針を維持)。

| キー | 値 | 備考 |
| --- | --- | --- |
| `(relPath, exportName)` | `symbol:<relPath>#<name>` | 一意時のみ |
| `(relPath, classMemberName)` | 所属クラスの symbol id | メソッド → クラス symbol へ集約(#218 との接続点) |
| 曖昧(同名複数)/ 不一致 | `file:<relPath>` | fail-safe フォールバック(FR-007) |

## 4. グラフ拡張

- **エッジ kind**: `exercises`(req → symbol|file、順方向のみ生成)。provenances は常に `["coverage"]`。
- **provenance**: `coverage` を union + `EDGE_PROVENANCE_VALUES` に追加(spec 011 SC-008 の同期対象)。
- **宣言との合流**(FR-008): (req, node) 対が `implements` と一致 → `implements.provenances` に `coverage` を追記し、独立 `exercises` エッジは生成しない。一致しない対のみ `exercises` エッジ。

## 5. Lock 拡張

`LockEntry`(req エントリ)に追加:

```
exercises?: string[]   // exercises エッジの target nodeId、[...new Set()].sort()(impl と同規約)
```

- `entriesStructurallyEqual` に `exercises` の配列比較を追加(idempotency / `lastReconciled` 保存)。
- trace 由来ハッシュ(`hashesAtTrace`)は lock に**保存しない** — staleness は毎回 trace(入力)と graph(現在)の照合で決まる。lock は導出エッジ集合のみ持つ。

## 6. カバレッジステータス

```
untagged | exercised | impl-only | verified
```

- `exercised` は `trace.acceptExercises: true` 時のみ出現(FR-014)。定義: 「`implements` エッジなし ∧ 排他的 `exercises` エッジあり ∧ stale でない」。
- 宣言済み REQ(impl-only / verified)の評価軸は不変。タグ有無と証拠有無は独立軸。

## 7. check 所見(新規 3 種)

| 所見 | 定義(集合演算) | 前提 |
| --- | --- | --- |
| `unexercisedClaims` | { (req, symbol) : `implements` あり ∧ 当該 req の non-stale exercises に symbol が含まれない } | trace 存在時のみ(FR-012) |
| `suggestedImpls` | { (req, symbol) : `implements` なし ∧ symbol の被 exercises req 数 < `sharedThreshold` ∧ 単一 req に排他的 } | 同上(FR-013) |
| `staleEvidence` | { (req, symbols[]) : hashesAtTrace[symbol] ≠ graph.contentHash } | `staleness` 設定で扱い分岐(FR-015) |

## 8. 設定(`.artgraph.json`)

```jsonc
{
  "trace": {
    "artifacts": [".artgraph/trace/*.jsonl"],  // 既定。spec 006 testResultPaths と同型
    "acceptExercises": false,                   // FR-014
    "staleness": "warn",                        // "warn" | "exclude" | "gate" (FR-015)
    "sharedThreshold": 3                        // FR-013
  }
}
```

## 9. 状態遷移(exercises エッジのライフサイクル)

```
(なし) --[vitest run + scan]--> fresh
fresh --[対象シンボル編集]--> stale --[テスト再実行(世代置換)]--> fresh | (なし)
fresh|stale --[テスト削除 / タグ除去 / REQ 削除]--> (なし)
REQ rename --[artgraph rename]--> ID 書換え(fresh/stale 維持)(FR-016)
```
