# Contract: CLI / 設定 / JSON 出力(spec 020)

既存 CLI 規約(`--format json|text`、`.choices()`、対称なエラー挙動、共有 ID regex — plan.md Cat5)に従う。ここに列挙しないコマンド・フィールドの挙動は不変(FR-010 / SC-007)。

## 1. vitest 統合(Phase A)

```ts
// vitest.config.ts — 最小(runner のみ。世代管理は手動 or CI の清掃に委ねる)
export default defineConfig({ test: { runner: 'artgraph/vitest' } });

// 推奨(runner + globalSetup(旧シャード削除)を一括設定)
import { withTrace } from 'artgraph/vitest/config';
export default defineConfig(withTrace({ test: { /* 既存設定 */ } }));
```

- `package.json#exports` 追加: `./vitest`(runner)、`./vitest/config`(ラッパー)
- vitest は `peerDependencies`(`>=3 <5`)+ `peerDependenciesMeta: { vitest: { optional: true } }`。CLI 単体利用時に vitest 不在でもインストール可能であること

## 2. `artgraph trace <subcommand>`(Phase A)

| サブコマンド | 目的 | 出力 |
| --- | --- | --- |
| `trace status` | shard の存在・件数・世代・診断(dangling / skipped / unknownSchema)・stale 率 | `--format json\|text` |
| `trace report` | **Phase A の主産物**: `@impl` 宣言 × 実行証拠の突き合わせレポート(グラフ/lock 非改変) | 同上 |

`trace report --format json`(抜粋):

```json
{
  "corroborated":   [{"reqId": "REQ-001", "node": "symbol:src/auth.ts#signIn"}],
  "unexercisedClaims": [{"reqId": "REQ-001", "node": "symbol:src/legacy.ts#oldSignIn"}],
  "suggestedImpls": [{"reqId": "REQ-002", "node": "symbol:src/auth.ts#resetPassword"}],
  "infrastructure": [{"node": "symbol:src/util.ts#validateEmail", "reqCount": 3}],
  "diagnostics": {"dangling": 0, "skipped": 1, "unknownSchema": 0, "stale": 0}
}
```

エラー挙動: trace shard が 1 つも見つからない → exit 1 + runner 導入ガイダンス(FR-018 と同文言・対称)。

## 3. `artgraph scan`(Phase B)

- `trace.artifacts` glob に一致する shard を読み、`exercises` エッジを合流(FR-006〜008)
- `--format json` のグラフ出力: edges に `{"kind": "exercises", "provenances": ["coverage"]}` が出現。宣言一致対は `implements` の `provenances` に `"coverage"` が追加
- `scan --serve`: exercises エッジは破線描画(宣言エッジと視覚区別)。凡例に追加
- trace 不在時: 出力 byte-identical(FR-010、回帰ガード SC-007)

## 4. `artgraph check`(Phase C)

- 新所見フィールド(trace 存在時のみ): `unexercisedClaims` / `suggestedImpls` / `staleEvidence`(スキーマは [data-model.md](../data-model.md) §7)
- text 出力の見出し: `UNEXERCISED CLAIM:` / `SUGGESTED IMPL:` / `STALE EVIDENCE:`(既存 `DRIFT:` / `COVERAGE:` と同スタイル)
- カバレッジステータス: `acceptExercises: true` 時のみ `exercised` が出現
- exit code: 既存規約に従う。`staleness: "gate"` ∧ `--gate` ∧ stale あり → exit 2(FR-015)。`warn`(既定)は exit code 不変

## 5. `artgraph impact`(Phase C)

- `exercises` エッジ経由の到達を含める。JSON 出力の到達要素に由来区分(静的 / 証拠)が判別できる provenance 情報を付す(FR-017)
- 新フラグ `--tests`: `--diff` と併用し、変更ノードを exercises している REQ のタグ付きテストを列挙

```json
{ "testsToRun": [{"testFile": "tests/billing.test.ts", "testName": "[REQ-003] charge bills a positive amount", "reqId": "REQ-003"}] }
```

- trace 不在で `--tests` 指定 → exit 1 + 導入ガイダンス(FR-018。`trace report` と同文言)

## 6. `artgraph rename`(Phase B)

- `--from/--to`・`--split`・`--merge` は trace shard 内の REQ ID も書き換える(FR-016)。書換え対象に trace が含まれたことを既存の書換えサマリに表示

## 7. 設定スキーマ(`.artgraph.json`)

```jsonc
{
  "trace": {
    "artifacts": [".artgraph/trace/*.jsonl"],   // string[](glob)。既定値あり
    "acceptExercises": false,                    // boolean。既定 false
    "staleness": "warn",                         // "warn" | "exclude" | "gate"(.choices() 相当の検証)
    "sharedThreshold": 3                         // 正整数。数値検証(Cat5)
  }
}
```

- `trace` キー自体が省略可(全既定値)。不正値は既存 config 検証と同スタイルの canonical エラー
- `artgraph init`: `.gitignore` への `.artgraph/trace/` 追記を提案(強制しない)
