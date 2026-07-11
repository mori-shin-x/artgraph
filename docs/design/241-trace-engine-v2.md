# 設計提案: trace capture engine v2 — CDP 採取から静的計装への転換 (issue #241)

Status: proposal(spec 化前の設計文書。採用時は speckit フローで spec 022 に起こす)
Issue: <https://github.com/mori-shin-x/artgraph/issues/241>
Date: 2026-07-11

## TL;DR

issue #241 の対策候補(バッチ化・hash キャッシュ・フィルタ前倒し)は、per-test 固定費の
**支配項ではない部分**の最適化であり、適用しても改善上限は 1.4x 前後に留まる。

支配項は `Profiler.takePreciseCoverage` そのもの — 実測により、**1 回のコストはテストが
何を実行したかに関係なく、isolate にロード済みのスクリプト総数に比例する**ことを確認した
(下表)。runner はテストごとに 2 回呼ぶため、import 重のスイートほど per-test 固定費が
線形に膨らむ。これは呼び出し頻度やペイロードの工夫では消せない、採取方式そのものの構造的限界。

よって抜本策として、**V8 precise coverage(CDP)採取を、`withTrace()` が注入する
Vite plugin による関数入口の静的計装(build-time instrumentation)に置き換える**
「capture engine v2」を提案する。per-test 固定費は実測ベースで **3–4ms → 0.01–0.13ms**
(20〜100 分の 1)になり、テスト数・ロード済みモジュール数の双方から独立する。
shard 契約(`trace-artifact.md`)は schemaVersion 1 のまま不変で、ingest / graph 層は無変更。

## 1. 現行方式の構造的限界(計測による裏付け)

### 1.1 `takePreciseCoverage` のコストはロード済みスクリプト数に比例する

検証スクリプト: N 個の小モジュールを import した後、`takePreciseCoverage` を 200 回
呼んで 1 回あたりの時間を計測(Node v22.22.2、`callCount: true, detailed: false`、
各 take の間に関数を 1 つだけ実行 — つまり**返却ペイロードは常に約 5 スクリプト分で一定**)。

| ロード済みモジュール数 | 返却ペイロード(scripts) | take 1 回あたり |
| ---: | ---: | ---: |
| 25 | 5 | 0.345 ms |
| 100 | 5 | 0.412 ms |
| 400 | 5 | 0.663 ms |
| 1,600 | 5 | 1.545 ms |

ペイロードが一定でもコストが伸びる = 支配項は**シリアライズではなく、V8 が take のたびに
isolate 内の全スクリプト(node_modules・vitest 本体含む)の関数カウンタをスイープする
内部コスト**。runner は before(drain)+ after で 2 回/テスト呼ぶため、1,600 モジュール級の
ワーカーでは take だけで約 3ms/テスト — issue の実測(3〜4ms/テスト)と整合する。

さらに `startPreciseCoverage({callCount: true})` は有効化中、ワーカー内で実行される
**全コード**に呼び出しカウンティングの税を課す(最適化抑制を含む)。artgraph 自身の
スイート(実行量が多い)が公式 perf fixture(純関数)より悪い 1.7x を示すのはこのため。

### 1.2 issue 記載の対策候補の改善上限

| 対策候補 | 削れる項 | 支配項 1.1 への効果 |
| --- | --- | --- |
| ワーカー内バッチ書き込み | 同期 I/O(≈0.1ms/テスト級) | なし |
| hash キャッシュ | hash 再計算(hit ファイル数依存) | なし |
| スクリプトフィルタ前倒し | JS 側の後処理ループ | なし(V8 内部スイープは残る) |
| `allowTriggeredUpdates` 等 | — | per-test 境界が必要な以上 take 回数は 2/テストから減らせない(before-take の省略で 1 にはできるが、帰属ノイズと引き換え) |

→ 全部入れても take 2 回 × スクリプト数比例コスト + 全コード課税が残り、
1,800 テスト級での比率はせいぜい 1.3〜1.4x。**「数千〜万テスト級で実用」には届かない。**

## 2. 提案: capture engine v2(静的計装)

### 2.1 アーキテクチャ

```
withTrace(config)
  ├─ test.runner = artgraph/vitest (現行どおり・中身は軽量化)
  ├─ test.globalSetup = shard 世代管理 (現行どおり)
  └─ plugins += artgraphTracePlugin()          ← 新規
        │  enforce: 'pre'(esbuild TS 変換より前 = ディスク上の原ソースを見る)
        │  対象: プロジェクト内ソースのみ(node_modules / テストファイルは transform 対象外
        │        — 現行 runner の除外規則と同一判定を transform 時に前倒し)
        ▼
   oxc-parser で関数を列挙し、magic-string で各関数本体先頭に 1 store を挿入:
        function signIn(u, p) { __ag[17] = 1; ... }
   モジュール preamble で worker グローバル registry に登録:
        const __ag = __agRegister("src/auth.ts", "a1b2c3…", ["signIn", "validateEmail", …]);
        // relPath・contentHash(原ソースから transform 時に計算)・関数名表・Uint8Array
```

runner 側(`onAfterRunTask`)は inspector を一切張らず:

1. registry の全 Uint8Array を走査 → 立っているスロットを `{file, fn}` hits に変換してクリア
   (クリアが次テストの drain を兼ねる — before フックでの作業はゼロ)
2. `hashes` は registry 登録済みの transform 時ハッシュを引くだけ(fs 読み取りなし)
3. レコードはメモリバッファに蓄積し、**テストファイル境界で flush**(`onAfterRunFiles`)+
   ワーカー terminate 時に最終 flush。I/O 回数はテスト数から独立し、途中 kill 時も
   直前のファイル境界までの shard は完全(部分 shard 耐性は既存テストの対象のまま)

### 2.2 per-test 固定費の見積り(実測)

計装方式の per-test 作業 = Uint8Array 走査 + hits 構築。プローブ実測(1,000 テスト平均):

| ロード済み計装関数数 | per-test コスト |
| ---: | ---: |
| 5,000 | 0.013 ms |
| 20,000 | 0.028 ms |
| 100,000 | 0.129 ms |

関数入口の `__ag[k] = 1` は分岐なしの typed-array store(≈1ns/呼び出し)で、
**計装されるのはプロジェクト内ソースの関数のみ**。node_modules・vitest 本体・テストコードは
一切課税されない(現行方式の「全コード課税」が消える)。

残る一回性コストは plugin の transform(oxc parse + 挿入)で、これは O(モジュール数)・
main process 側・vite の transform キャッシュに乗る(forks/threads どちらでもワーカー間で共有)。
oxc-parser は scan で実績のある既存依存。

### 2.3 D1(research.md)の棄却理由は失効している

D1 が計装方式(Stryker 型)を退けた理由は「build 変換の注入が必要で『config 1 行』の UX が
壊れる」だった。しかし spec 020 の実装で `withTrace()` ラッパーが既に存在し、runner と
globalSetup を注入している。**plugin を 1 つ足すのも同じ 1 行の中**であり、ユーザー UX は
変わらない。D2(`detailed: false`)も「関数粒度 boolean で十分」という判断であり、
計装方式はまさにその粒度をネイティブに実装する。採用時は D9 として追記する。

### 2.4 契約・互換性

- **shard 契約は schemaVersion 1 のまま不変**。レコード形状(`meta`/`test`/`skipped`、
  `hits`/`hashes`)・ファイル配置・世代管理すべて現行どおり。ingest / symbol-table /
  graph / CLI は無変更。
- `fn` の意味論のみ、「V8 `functionName` をそのまま」→「V8 functionName 互換の命名規則で
  静的に決定した関数名」に文言修正(契約 §test の注記 1 行)。symbol-table が解決するのは
  (a) export 名(extractSymbols 由来)と (b) クラスメンバ名の 2 種のみで、どちらも静的に
  同一の名前を生成できる(V8 の推論名 — `export const area = () => …` → `"area"`、
  クラスメソッド → メソッド名自体 — は AST から機械的に再現可能)。解決不能な無名関数は
  現行でも file-fallback 行きなので、v1 では計装対象外としても精度は落ちない。
- `hashes` は transform 時に**ディスク上の原ソース**(enforce: 'pre' 段階の入力)から
  現行と同一の規則(BOM 除去 → sha256 → 16 桁)で計算。`tests/hash-equivalence.test.ts` の
  SSOT ピンはそのまま効かせる。
- **CDP エンジンは fallback として残す**: `withTrace({ engine: 'cdp' })` /
  `ARTGRAPH_TRACE_ENGINE=cdp`。plugin transform が効かない特殊構成(カスタム transformer 等)
  の逃げ道、および differential テストの比較対象。fallback 側には issue の安価な 2 項
  (hash メモ化・バッチ書き込み)だけ適用しておく(数行)。

### 2.5 副次効果(戦略的アンロック)

1. **vitest browser mode / jsdom で動く**: `node:inspector` 依存が消えるため。CDP 方式では
   原理的に不可能だった領域。
2. **Jest 等への横展開が transform の差し替えだけになる**: 契約は既に「ランナー非依存」を
   謳っており(§互換性ポリシー)、計装 runtime + babel/ts transform で同一 shard を書ける。
3. **`it.concurrent` 帰属復活の道**: 現在は `skipped`(FR-003/D5)。registry を
   ビットマスク化(`__ag[k] |= mask`)すれば同時実行 8〜32 テストまで帰属可能(将来 option)。
4. `@vitest/coverage-v8` との Profiler 機構の取り合いが消える(併用時の干渉リスク低下)。

### 2.6 リスクと緩和

| リスク | 緩和 |
| --- | --- |
| 命名パリティ(V8 名 ↔ 静的名の乖離) | **differential テスト**: 同一 fixture を両エンジンで実行し、正規化後 shard の一致を CI で強制。乖離は file-fallback 側に倒れる(fail-safe、spec 018 規範) |
| transform コストの回帰 | perf suite に **import 重 fixture を追加**(現行の 500 純関数 fixture は 1.7x 体質を再現できていない — 受け入れ計測の土台として必須) |
| スタックトレース / ソースマップ | 挿入は既存行内(改行なし)+ magic-string の hires map を返し vite が連鎖。行番号は不変 |
| Runner API (experimental) 依存 | 現行と同じ。D8 の vitest 3.x/4.x マトリクス E2E を両エンジンで実施 |
| oxc で parse できないソース | 計装スキップ(そのモジュールは証拠なし = 現行の除外系と同じ fail-soft)+ 診断カウント |

## 3. 受け入れ基準(issue の基準を上回る設定)

- artgraph 自身の unit スイート(1,800 テスト級)で **≤ 1.15 倍**(issue 基準は ≤1.3)
- SC-005 perf テストのバジェットを **1.5 → 1.2** に引き下げても green(issue 案は 1.3)
- 新設の import 重 perf fixture でも同バジェット
- differential テスト(CDP ↔ 計装の正規化 shard 一致)が green
- shard 契約 schemaVersion 1 据え置き・ingest 無変更(`pnpm exec artgraph check --diff` green)

## 4. 実施フェーズ(spec 022 の骨子)

- **Phase 0 — 計測基盤**: import 重 perf fixture 追加、per-test 固定費の内訳
  (take / write / hash)を計測ログ化。改善を主張する土台を先に作る。
- **Phase 1 — engine v2 本体**: vite plugin(oxc + magic-string)、worker runtime registry
  (依存ゼロ・`src/vitest/` の境界規則は「plugin モジュールは main process 専用のため
  oxc-parser 可、worker で走る runtime は node builtins のみ」に明文化して維持)、
  runner のエンジン切替とバッチ flush。
- **Phase 2 — パリティ保証**: differential shard テスト、hash-equivalence pin 継続、
  vitest 3/4 マトリクス E2E(両エンジン)、部分 shard 耐性の再確認。
- **Phase 3 — 受け入れ**: dogfooding 計測、SC-005 バジェット引き下げ、契約文言の注記修正、
  research.md へ D9 追記。デフォルトエンジンを v2 に切替(CDP は fallback として残置)。
- **(option) Phase 4**: concurrent 帰属(ビットマスク)、browser mode 対応、
  無名/ネスト関数の「囲む export シンボルへの帰属」による精度向上。

## 付録: 検証プローブ

計測に使ったスクリプト(§1.1 / §2.2)は使い捨てだが、再現手順として要点を記す:

- CDP 側: N 個の 8 関数モジュールを動的 import 後、`Profiler.startPreciseCoverage({callCount: true, detailed: false})` 下で `takePreciseCoverage` を 200 回(warmup 20 回別)呼び平均。各 take 間に関数を 1 つだけ実行し、ペイロードを一定(≈5 scripts)に保った状態でロード数だけを変える。
- 計装側: F スロットの `Uint8Array` に 30 hit/テストを立て、全走査 + hits 構築 + クリアを 1,000 回繰り返し平均。

環境: Node v22.22.2 / Linux(本リポジトリの CI 相当環境)。
