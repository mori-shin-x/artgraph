# Contract: TraceShard JSONL(runner ↔ ingest)

runner(`artgraph/vitest`)が書き、ingest(`src/trace/ingest.ts`)が読む唯一の境界。SSOT ペア(plan.md Cat2-(b))として、この契約のスキーマ定数は `src/trace/schema.ts` に一元定義し、runner / ingest 双方が import する(bash↔TS 型の二重定義を作らない)。

## ファイル配置

- パス: `.artgraph/trace/<workerId>-<runToken>.jsonl`(ワーカーごとに独立 — 同時書込みなし)
- エンコーディング: UTF-8、1 行 1 JSON レコード、追記のみ
- 世代: run 開始時に globalSetup が既存 `*.jsonl` を削除(世代置き換え)。CI シャードは複数ディレクトリの shard をそのまま `trace.artifacts` glob に含めてよい(ingest が和集合)

## レコード種別

### meta(各 shard の先頭に 1 行)

```json
{"schemaVersion": 1, "kind": "meta", "runToken": "…", "pool": "forks", "vitest": "4.1.10", "startedAt": "2026-07-10T14:00:00Z"}
```

- `schemaVersion` が ingest の対応範囲外 → shard 全体を `unknownSchema` として診断カウントし、エッジ導出には使わない(silent skip 禁止)
- `startedAt` 等の非決定情報は meta にのみ置く(FR-004 — 正規化出力に混入させない)

### test(テスト 1 件ごと)

```json
{
  "kind": "test",
  "testName": "[REQ-001] signIn accepts valid credentials",
  "suitePath": ["auth"],
  "testFile": "tests/auth.test.ts",
  "passed": true,
  "hits": [
    {"file": "src/auth.ts", "fn": "signIn"},
    {"file": "src/util.ts", "fn": "validateEmail"}
  ],
  "hashes": {"src/auth.ts": "sha256:…", "src/util.ts": "sha256:…"}
}
```

制約:

- `file` はリポジトリルート相対(runner が正規化。`file://` プレフィクス・絶対パス・トランスフォーム query を除去)
- `fn` は V8 `functionName` をそのまま(合成名 `<instance_members_initializer>` 等も含めて記録し、解釈は ingest 側)
- module-init(空 `functionName` のトップレベル実行)は runner 側で除外(FR-007 の前段)
- `hits` は scan `include` 境界より広くてよい(テストファイル・node_modules は runner 側除外、それ以外の絞り込みは ingest 側の責務)
- `hashes` は `hits` に現れる file の網羅(staleness の基準値、D7)

### skipped(帰属破棄の記録)

```json
{"kind": "skipped", "testName": "[REQ-009] …", "testFile": "tests/x.test.ts", "reason": "concurrent"}
```

- `it.concurrent` 等、per-test 分離が保証できないケース(FR-003)。ingest は診断カウントに計上する

## ingest 側の義務

1. REQ タグ抽出は spec 006 の `extractReqTags` 規則(describe 祖先継承・dedup)を再利用する
2. `passed: false` のレコードはエッジ・充足・提案に使わない(D6)。診断には数える
3. 正規化(boolean 化・辞書順ソート・和集合)は shard の読込み順・ワーカー割当に依存しない(FR-004)
4. 解決不能エントリ(消滅ファイル・名前 join 不一致)は file 粒度フォールバック or dangling 診断(FR-007、silent skip 禁止)

## 互換性ポリシー

- スキーマ変更は `schemaVersion` インクリメント + ingest の複数世代対応(直前世代まで)で行う
- ランナー非依存: Jest 等の将来ランナーも同一 shard スキーマを書けば ingest は無変更(Follow-up の前提)
