# Contract: config surface(withTrace オプション / 環境変数 / plugin 適用範囲)

v2 で追加・変更されるユーザー可視の設定面。CLI コマンド・フラグ・`.artgraph.json` に変更はない。

## `withTrace(config, options?)`(`artgraph/vitest/config`)

```ts
import { withTrace } from 'artgraph/vitest/config';
export default defineConfig(withTrace({ test: { ... } }, { engine: 'instrument' }));
```

- 第 2 引数 `options`(新設・省略可):
  - `engine?: 'instrument' | 'cdp'` — 採取エンジン。既定 `'instrument'`。不正値は `withTrace` 呼び出し時に throw(fail-fast、silent fallback 禁止)。
- `withTrace` の従来義務(`test.runner` 設定・globalSetup 追記・その他キーのパススルー・冪等性)は不変。加えて:
  - `engine === 'instrument'` のとき: 計装 plugin をトップレベル `plugins` に**追記**する(既存 plugins は保持。二重適用は plugin 名で検知して冪等)。worker への engine 伝搬のため `test.env.ARTGRAPH_TRACE_ENGINE` を設定する(ユーザーが既に同キーを設定していれば**ユーザー値を優先** — 環境変数優先の原則と同じ向き)。
  - `engine === 'cdp'` のとき: plugin を注入しない。`test.env.ARTGRAPH_TRACE_ENGINE = 'cdp'` を設定する。

## 環境変数

| 変数 | 値 | 意味 |
| --- | --- | --- |
| `ARTGRAPH_TRACE_ENGINE` | `instrument` \| `cdp` | エンジンの明示上書き。`withTrace` オプションより**優先**。runner は worker 内でこの値(test.env 経由で伝搬済み)を読んで分岐する。不正値は runner 初期化時に throw |
| `ARTGRAPH_TRACE_DIR` | パス | 既存(shard 出力先の上書き)。変更なし |

優先順位(高→低): プロセス環境変数 `ARTGRAPH_TRACE_ENGINE` > `withTrace({ engine })` > 既定 `instrument`。

## plugin の適用範囲(変換対象の契約)

- 対象: プロジェクトルート配下のソースモジュールのうち、除外規則に該当しないもの。
- 除外規則(shard 契約 §hits の「テストファイル自身・node_modules が hits に現れない」を変換時に前倒し適用したもの。判定は `src/trace/schema.ts` の共有関数 — runner cdp 経路と同一):
  - プロジェクトルート外(相対化で `..` に出る・絶対のまま)
  - `node_modules/` を含むパス
  - テストファイル(`.test.` / `.spec.` 拡張子規則 — 現行 runner と同一の正規表現)
- 対象内でもパース不能・変換不能なモジュールは fail-soft でスキップ + 警告([instrumentation-runtime.md](./instrumentation-runtime.md))。
- 変換は `enforce: 'pre'`(TS 変換前・ディスク原ソースが入力)。contentHash はモジュール id のディスク内容から計算する。

## `test.runner` を直接指定している構成(withTrace 非使用)

- 従来どおり動作する。plugin が注入されていないため registry は空になり、instrument 既定では「hits 空 + ワーカー終了時警告」となる(FR-008 / instrumentation-runtime.md 読み手義務 4)。
- 移行案内: 警告文言で `withTrace` の利用または `ARTGRAPH_TRACE_ENGINE=cdp` を提示する(従来挙動が必要なユーザーの逃げ道)。

## 互換性

- shard 契約(schemaVersion 1)・`.artgraph.json`(`trace.*`)・CLI 出力は不変。
- `withTrace` の第 2 引数追加は後方互換(省略時は従来 + 既定エンジン)。ただし既定エンジンが v2 になるため、**採取の内部機構は更新後の初回実行から変わる** — 出力等価性は differential テスト(SC-004)が保証する。旧挙動が必要な場合は `engine: 'cdp'`。
