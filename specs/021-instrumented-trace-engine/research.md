# Research: trace capture engine v2 — Phase 0 設計判断 (2026-07-11)

一次資料は [docs/design/241-trace-engine-v2.md](../../docs/design/241-trace-engine-v2.md)(issue #241 の原因分解とプローブ実測)。本ファイルは実装のための設計判断(Decision / Rationale / Alternatives)を確定する。spec 020 の D1〜D8 と区別するため、本 spec の判断は V1〜V9 と番号付けする。

## 実測サマリ(設計文書からの再掲)

- `takePreciseCoverage` 1 回のコストは、返却ペイロードを一定に保ってもロード済みモジュール数に比例する: 25 モジュール 0.345ms → 1,600 モジュール 1.545ms(V8 が isolate 内全スクリプトの関数カウンタをスイープするため)。runner は 2 回/テスト呼ぶ。
- 計装方式の per-test 作業(Uint8Array 走査 + hits 構築 + クリア)は 5,000 関数で 0.013ms、100,000 関数で 0.129ms。
- 環境: Node v22.22.2 / Linux。

## V1. 採取方式 = build-time 関数入口計装(Vite plugin)+ worker 内 registry

- **Decision**: `withTrace()` が `enforce: 'pre'` の Vite plugin を注入し、プロジェクト内ソースの各関数本体先頭に実行印 store(`__ag[k] = 1` 相当)を挿入する。runner はテスト境界で registry を回収するだけにし、inspector / CDP を一切使わない(v2 経路)。
- **Rationale**: per-test 固定費の支配項(take コスト ∝ ロード済みスクリプト数、×2/テスト)と常時課税(precise coverage 有効中の全コード計数)は採取機構に内在し、呼び方の工夫では消えない(実測)。計装は per-test コストを「計装関数スロットの走査」に置き換え(20〜100 分の 1)、常時コストをプロジェクト内ソースの関数入口 1 store(≈1ns、分岐なし)に閉じ込める。spec 020 D1 が計装を棄却した理由「config 1 行の UX が壊れる」は、D1 自身の成果物である `withTrace()` の存在により失効している。
- **Alternatives**:
  - (a) CDP 継続 + issue #241 の対策候補(バッチ化・hash メモ化・フィルタ前倒し)— 支配項に触れず改善上限 1.3〜1.4x。fallback エンジンの安価改善としてのみ採用(V8 参照)。
  - (b) `NODE_V8_COVERAGE` — プロセス単位でしか取れず per-test 分離不能(spec 020 D1 の棄却理由のまま有効)。
  - (c) before-take の省略(1 回/テスト化)— 帰属窓が「前テストの take 以降すべて」に広がり、suite フック・between-test コードの誤帰属と引き換え。半減止まりで支配項は残る。
  - (d) AsyncLocalStorage ベースの計装(並行テスト帰属付き)— 関数呼び出しごとに ALS 参照(≈100ns 級)が乗り、ホットループで顕在化。並行帰属は将来 spec に譲る(spec Assumptions)。

## V2. 変換基盤 = oxc-parser(既存依存)+ magic-string(新規依存・main process 専用)

- **Decision**: plugin のパースは oxc-parser、コード挿入とソースマップ生成は magic-string(`generateMap({ hires: 'boundary' })`)。plugin は vitest の変換パイプライン(vite-node)上で動き、forks / threads 両プールとも main process で 1 回変換されワーカー間でキャッシュ共有される。
- **Rationale**: oxc-parser は scan / symbol-table で実績のある既存 dependency で、TS/JSX を直接パースできる(`enforce: 'pre'` 段階の入力 = TS 原ソース)。magic-string は依存ゼロの定番で、既存行内挿入 + 正確なマップ連鎖により行番号を不変に保てる(FR-001 のスタックトレース非破壊)。変換コストは O(モジュール数) の一回性で、per-test 構造(本 spec の敵)に足されない。
- **Alternatives**: (a) 手書きオフセット挿入・マップなし — vite がソースマップ連鎖を警告し、テスト失敗位置の報告が劣化(FR-001 違反)。(b) babel — 重量依存の追加、oxc と解析系が二重化。(c) esbuild transform フック — 関数列挙に必要な AST が得られない。

## V3. 実行印の実装 = モジュールごとの Uint8Array + globalThis registry(import 注入なし)

- **Decision**: plugin は各モジュール先頭に**自己完結の preamble**(モジュール解決を伴わない素の式)を注入し、`globalThis` 上の合意キーに(相対パス・contentHash・関数名表・`Uint8Array`)を登録する。関数入口の実行印は `__ag[k] = 1`(分岐なし typed-array store)。runner は同じ合意キーから読む。形状は [contracts/instrumentation-runtime.md](./contracts/instrumentation-runtime.md) を SSOT とする。
- **Rationale**: (1) import を注入しないことで、worker 側の依存ゼロ(spec Assumptions の境界規則)が構文的に保証され、ユーザーの alias / resolve 設定と一切干渉しない。(2) Uint8Array store は record-once 分岐(`if (!hit)`)より速く、GC 圧もない。(3) vitest の isolate(テストファイルごとのモジュール再評価)では preamble が再実行されるが、registry を相対パスキーの Map にして**置換**すれば旧世代の配列は自然に捨てられる。
- **Alternatives**: (a) `artgraph/vitest/runtime` を import 注入 — tmpdir fixture・pnpm 厳格 hoisting・e2e の dist 直接参照で解決失敗リスク、バージョン混在時の二重 registry。(b) `Set<string>` に関数 id を push — per-call でハッシュ計算 + アロケーション。(c) モジュールごとにクロージャ変数のみ(registry なし)— runner から回収できない。

## V4. 関数命名 = V8 functionName 互換の静的命名表

- **Decision**: 計装時の関数名は次の規則で静的に決定する(= 現行 V8 が報告する名前と一致させる): FunctionDeclaration → 自名 / `export default function name` → 自名、無名 default → `"default"` / 変数・定数への関数式・arrow 代入 → 変数名 / クラス `MethodDefinition` → メソッド名、`PropertyDefinition` の値が関数 → プロパティ名 / オブジェクトリテラルのメソッド・プロパティ関数 → キー名 / getter・setter → アクセサ名。**名前を静的に決定できない関数(即時無名コールバック等)は計装しない。**
- **Rationale**: ingest の symbol 解決(`symbol-table.ts`)が扱うのは export 名とクラスメンバ名のみで、上記規則はその全種別を被覆する。名前ありだが非 export の関数も現行どおり hits に載せ(ingest 側で file-fallback)、file 粒度エッジの成立条件を変えない。無名関数は現行でも symbol 解決不能で、v2 で記録されなくなっても symbol 粒度の結果は不変 — 差が出うるのは「無名関数**のみ**が hit したファイルの file 粒度エッジ」という縁のケースで、differential fixture に含めて挙動を固定する(V7)。
- **Alternatives**: (a) source-map 復元によるオフセット対応 — spec 020 D3 で棄却済みの複雑性をそのまま持ち込む。(b) ネスト関数を囲む export シンボルに帰属 — 精度向上だが現行との差分が生じるため将来 spec(Follow-up)。

## V5. contentHash = 変換時にディスク上の原ソースから計算し preamble に埋め込む

- **Decision**: plugin は transform フックの `code` 引数ではなく、モジュール id から**ディスクの原ソースを読み直して** hash を計算し(BOM 除去 → sha256 → 16 桁)、preamble に埋め込む。hash 規則は `src/trace/schema.ts` へ hoist して SSOT 化し、`parsers/typescript.ts` と `runner.ts` の既存複製を解消する(等価性ピン `tests/hash-equivalence.test.ts` は SSOT 直撃に更新)。
- **Rationale**: staleness 判定(spec 020 D7)は「shard 記録時 hash vs 現在のグラフの hash」の照合であり、グラフ側 hash はディスク内容から計算される。他の pre plugin が先に変換していた場合、`code` 引数は原ソースと一致しない可能性がある — id からの読み直しは 1 モジュール 1 回(変換時のみ)で、確実性がコストに勝る。per-test の fs 読み + hash 計算(現行の内訳 3)は完全に消える。
- **Alternatives**: (a) `code` 引数を hash — pre plugin 構成で staleness が壊れる。(b) 現行どおり runner で hash(メモ化)— per-test 構造は消えるが worker ごとの初回 fs 読みが残り、SSOT 複製も残る。cdp fallback 側はこの方式(V8)。

## V6. shard 書き込み = テストファイル境界のバッチ flush

- **Decision**: v2 経路の runner は per-test レコードをメモリに蓄積し、(a) `onAfterRunTask` でテストファイルの変わり目を検知した時、(b) `onAfterRunFiles`(ワーカーのファイルバッチ完了)で flush する。追記のみ・1 行 1 JSON の契約は不変。
- **Rationale**: 書き込み回数がテスト数から独立し(典型 10〜100 分の 1)、ワーカー kill 時に失うのは高々 flush 後の 1 テストファイル分 — 部分 shard は常に完全な JSONL 行の列であり、既存の部分 shard 耐性テストの前提を保つ。契約(§ファイル配置「追記のみ」)は書き込みタイミングを規定していない。
- **Alternatives**: (a) N 件ごと固定バッチ — 境界がテストファイルと無関係になり、kill 時の欠損単位が説明しにくい。(b) terminate 時一括 — kill 耐性が全損。(c) 非同期書き込み — 順序保証と error handling が複雑化、同期追記で十分(バッチ化後は頻度が低い)。

## V7. パリティ保証 = differential E2E(両エンジン → ingest 後エッジ集合比較)

- **Decision**: 命名種別網羅 fixture(export 関数 / arrow 代入 / クラスメソッド / getter / named・無名 default export / 非 export 関数 / ネスト named 関数 / 無名コールバック)を両エンジンで実行し、shard → ingest 通過後の**正規化エッジ集合**の一致を E2E で assert する(SC-004)。生 shard のバイト比較はしない(runToken / 実行順で異なって当然)。
- **Rationale**: 契約が「解釈は ingest 側」と定める以上、パリティの正しい観測点は ingest の出力。V4 の縁のケース(無名のみ hit)もここで挙動を固定する。旧エンジンを fallback として残す(V8)ことで、パリティの比較対象が常に CI に存在する。
- **Alternatives**: 生 shard の正規化比較 — meta / 実行順 / worker 割当の差を吸収する専用正規化器が必要になり、ingest の正規化と二重化(Cat2 違反)。

## V8. 旧エンジン(CDP)= fallback 残置 + 安価な 2 改善のみ

- **Decision**: 現行 CDP 経路は削除せず、`engine: 'cdp'` / `ARTGRAPH_TRACE_ENGINE=cdp` で明示選択可能にする。適用する改善は issue #241 の対策候補のうち (1) ワーカー内 contentHash メモ化、(2) shard 書き込みのバッチ化(V6 と同じ機構の共用)の 2 つだけ。スクリプトフィルタ前倒し・CDP オプション調査は行わない。
- **Rationale**: 変換パイプラインを通らない構成の逃げ道と differential テストの比較対象として旧エンジンは必要。ただし支配項が消えない以上、それ以上の最適化投資は回収されない(FR-013 の「それ以上しない」は意図的な投資上限)。
- **Alternatives**: (a) 旧エンジン削除 — 特殊構成の受け皿とパリティ検証手段を同時に失う。(b) 旧エンジンをフル最適化 — 上限 1.3〜1.4x のために v2 と二重の作業、YAGNI。

## V9. perf 計測 = import 重 fixture の追加とバジェット 1.2 への引き下げ

- **Decision**: perf スイートに「ロード済みモジュール数」を独立に大きくできる合成 fixture(目安: 300 モジュール・import チェーン付き・300 テスト、fixture 生成は既存 perf テストの spawn 技法を踏襲)を追加する。Phase A では現行エンジンの実測比を記録するだけ(バジェットは 1.5 のまま)、Phase D で両 fixture ともバジェット 1.2 に引き下げる。dogfooding(自スイート ≤1.15、SC-001)は CI perf テストではなく quickstart の手動計測手順 + PR 記録とする。
- **Rationale**: 現行 fixture(純関数 500 テスト・25 モジュール)は issue #241 の悪化体質(モジュール数比例)を構造的に再現できない — 実測でも take コストはモジュール数側に比例する。改善前に「悪化を再現する計測」を固定しないと、改善の主張も将来の回帰検出もできない。自スイートの比率計測は環境負荷の影響が大きく、CI の hard assert には向かない(既存 perf テストが interleaving で苦労している知見)。
- **Alternatives**: (a) 自スイート比較を CI 化 — ビルド成果物・子プロセス spawn を含みノイズ過大で flaky 化必至。(b) バジェット 1.15 まで引き下げ — 共有 CI ボックスの負荷変動を考えると余裕が薄い。1.2 は実測見込み(≈1.05)との margin を確保した値。
