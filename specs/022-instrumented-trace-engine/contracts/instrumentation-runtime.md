# Contract: instrumentation runtime(plugin preamble ↔ runner)

v2 エンジンで新設される**唯一の内部境界**。書き手は plugin(`src/vitest/plugin.ts`)が各モジュールに注入する preamble、読み手は runner(`src/vitest/runner.ts`)の instrument 経路。両者はビルド成果物として別モジュールであり、共有できるのは `globalThis` 上の形状だけ — この文書と `src/trace/schema.ts` の型定義(SSOT ペア)で固定し、形状検証テストで等価性を強制する。

## globalThis キー

- キー名: `__ARTGRAPH_TRACE_REGISTRY__`(衝突回避のための固有名。ユーザーコードとの偶然衝突は事実上想定しない)
- 値: `{ version: 1, modules: Map<string, ModuleRegistration> }`
- 生成: 最初にアクセスした側が lazily 生成する(`??=`)。preamble が先でも runner が先でもよい。
- `version` 不一致(将来の互換切り): runner は採取を放棄し、stderr に 1 回だけ警告を出す(silent 破損禁止)。

## ModuleRegistration の形状

```
{ file: string, hash: string, fns: string[], hits: Uint8Array }
```

- `file`: プロジェクトルート相対・`/` 区切り(shard の `hits[].file` / `hashes` キーと同一表記)。
- `hash`: contentHash 16 桁(`src/trace/schema.ts` の hash 規則 — ディスク上の原ソースから変換時に計算)。
- `fns`: スロット順の関数名表。`fns.length === hits.length`。
- 登録は `modules.set(file, registration)` — **同 relPath の再登録は置換**(vitest isolate のモジュール再評価対応)。

## preamble の義務(書き手)

1. **import 文を注入しない**。preamble はモジュール解決を伴わない自己完結の式のみで構成する(worker 側依存ゼロの構文的保証)。
2. 注入は既存の行構造を変えない(既存行内への挿入・改行の追加削除なし)。ソースマップは変換結果として正しく連鎖させる。
3. 関数入口の実行印は分岐なしの store(`<hitsRef>[k] = 1` 相当)1 文のみ。関数の引数・戻り値・this・実行順に影響を与えない。
4. ESM / CJS 双方で評価可能な構文に限る(トップレベル await・import.meta を使わない)。
5. hoisting との整合: 実行印スロット参照は preamble 評価より後にしか実行されない位置にのみ挿入する(FunctionDeclaration の巻き上げ自体は妨げない — 呼び出しが起きるのは評価後)。

## runner の義務(読み手)

1. **drain セマンティクス**: テスト境界で全 ModuleRegistration の `hits` を走査し、立っているスロットを `{file, fn}` に変換したうえで**ゼロクリア**する。クリアが次テストの採取窓の開始を兼ねる(before フックでの作業なし)。
2. 走査は同期・単発(テスト実行と並行しない)。`it.concurrent` は従来どおり帰属破棄(`skipped` レコード)し、その場合も drain(クリア)は行う(次テストへの漏れ防止)。
3. `hashes` は hits に現れた `file` の `ModuleRegistration.hash` を転記する(fs アクセスなし)。
4. registry が存在しない・空のままの場合(plugin 非適用の構成で instrument を選んだ等)、テストは正常に進行させ、shard には hits 空のレコードを書く。ワーカー終了までに 1 モジュールも登録がなければ stderr に 1 回警告(導入ミスの可視化 — FR-008)。

## 変換のスキップ(fail-soft)

- パース不能・変換不能なモジュールは**無変換で素通し**する(テストを壊さない)。スキップしたモジュールは registry に現れず、証拠も生成されない。plugin は stderr に 1 モジュール 1 回の警告を出す(silent skip 禁止 — FR-008)。
- 除外規則(node_modules / テストファイル / プロジェクトルート外)に該当するモジュールは対象外(警告なし — 正常系)。判定規則は `src/trace/schema.ts` に SSOT 化した関数を runner(cdp 経路)と共用する。

## 互換性

- 本契約は artgraph 内部(同一パッケージの plugin ↔ runner)の契約であり、公開 API ではない。変更時は `version` をインクリメントし、runner 側は自分の知らない version を採取放棄 + 警告で扱う。
- shard 契約(spec 020 trace-artifact.md)には一切影響しない — registry は shard に現れない。
