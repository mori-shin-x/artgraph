# Data Model: trace capture engine v2

shard 契約(spec 020 [trace-artifact.md](../020-coverage-derived-edges/contracts/trace-artifact.md))より**上流**にのみ新しいデータが現れる。shard 以降(ingest / graph / lock)のモデルは一切変更しない。

## 1. TraceRegistry(worker 内・揮発)

worker(プロセス/スレッド)ごとに 1 つ。plugin が注入した preamble(書き手)と runner(読み手)の共有点。`globalThis` の合意キーに置く(正確な形状・キー名は [contracts/instrumentation-runtime.md](./contracts/instrumentation-runtime.md) が SSOT)。

| フィールド | 型 | 意味 |
| --- | --- | --- |
| `version` | number | registry プロトコル版。runner は不一致時に採取を放棄し警告(silent 破損防止) |
| `modules` | Map\<relPath, ModuleRegistration\> | 登録済みモジュール。**相対パスキーで置換** — vitest の isolate によるモジュール再評価では同 relPath の再登録が旧エントリを置き換える(旧 Uint8Array はそのまま捨てられる) |

状態遷移: 生成(最初の preamble 実行時に lazily)→ 登録/置換(モジュール評価ごと)→ drain(テスト境界で runner が走査 + ゼロクリア)。ワーカー終了とともに消滅。永続化しない。

## 2. ModuleRegistration(モジュールごと・揮発)

preamble が評価時に生成。変換時に静的決定された情報のみを運ぶ(実行時計算なし)。

| フィールド | 型 | 意味 | 由来 |
| --- | --- | --- | --- |
| `file` | string | プロジェクトルート相対パス(shard の `hits[].file` / `hashes` キーと同一表記) | 変換時に確定(除外規則適用済み) |
| `hash` | string(16) | contentHash(BOM 除去 → sha256 → 16 桁)。shard の `hashes[file]` にそのまま入る | 変換時にディスクの原ソースから計算(V5) |
| `fns` | string[] | スロット順の関数名表(V4 の静的命名規則)。同名関数はそれぞれ独立スロット(名前は重複してよい — 解釈は ingest の責務) | 変換時に確定 |
| `hits` | Uint8Array(fns.length) | 実行印。関数入口の store が立て、drain がゼロクリア | 実行時 |

不変条件: `fns.length === hits.length`。`file` は除外規則(node_modules / テストファイル / ルート外)を通過済み — 除外対象のモジュールは**登録自体が存在しない**。

## 3. Engine(採取エンジン選択)

| 値 | 意味 |
| --- | --- |
| `instrument` | v2(既定)。plugin 注入 + registry drain。inspector 不使用 |
| `cdp` | 現行方式。plugin 非注入。hash メモ化 + バッチ書き込みのみ改善 |

決定優先順位(高→低): 環境変数 `ARTGRAPH_TRACE_ENGINE` > `withTrace({ engine })` > 既定 `instrument`。不正値は設定読み取り時に即エラー(fail-fast、silent fallback 禁止)。worker への伝搬は `test.env` 経由([contracts/config-surface.md](./contracts/config-surface.md))。

## 4. Shard レコード(不変 — 参照のみ)

schemaVersion 1 のまま。v2 でも `meta` / `test` / `skipped` の形状・値域は同一。エンジンの区別は shard に**現れない**(下流はエンジルを識別できない/しなくてよい)。`meta` の `pool` 等の診断フィールドも従来どおり。

v2 における各フィールドの充足方法(形は不変・作り方だけ変わる):

| shard フィールド | 現行(cdp) | v2(instrument) |
| --- | --- | --- |
| `hits[].file` | V8 URL → relPath 変換(memo) | ModuleRegistration.file(変換時確定) |
| `hits[].fn` | V8 `functionName` | fns[k](静的命名、V8 互換規則) |
| `hashes[file]` | per-test に fs 読み + hash(→メモ化) | ModuleRegistration.hash(変換時確定) |
| module-init 除外 | 空 `functionName` を drop | 関数入口のみ計装(トップレベルは印なし)— 構造的に除外 |
| テストファイル / node_modules 除外 | 採取後に relPath 判定で drop | 変換対象外 — 構造的に除外 |

## 5. RunnerBuffer(worker 内・揮発)

v2 経路の書き込みバッファ。`test` / `skipped` レコードの JSONL 行を蓄積し、テストファイル境界と `onAfterRunFiles` で flush(V6)。`meta` 行は従来どおり shard 先頭(最初の flush の先頭)。flush は同期追記で、部分 shard は常に完全な JSONL 行の列。

## 6. ImportHeavyFixture(perf 計測用・合成)

perf テストが tmpdir に生成する合成プロジェクトのパラメタ(V9)。

| パラメタ | 目安 | 役割 |
| --- | --- | --- |
| `moduleCount` | 300 | ワーカーにロードされるモジュール数(per-test 固定費のモジュール数依存を露出させる) |
| `chainDepth` | 数段の import チェーン | 1 テストファイルから多数モジュールが推移的にロードされる構造 |
| `testCount` | 300 | オーバーヘッド比の分母を安定させるテスト数 |

既存の純関数 fixture(25 モジュール / 500 テスト)と対になり、「テスト数比例」と「モジュール数比例」を別々に監視する。
