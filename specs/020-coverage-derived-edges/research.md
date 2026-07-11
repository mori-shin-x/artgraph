# Research: per-test カバレッジからの REQ↔code エッジ導出 — 実現可能性調査 (2026-07-10)

設計セッションでの事前調査の記録。spec.md の技術的前提の一次資料。

## R1. PoC — Vitest で per-test カバレッジ分離取得は可能(検証済み)

Vitest カスタムランナー(`VitestTestRunner` 拡張、約 50 行)+ ワーカー内 `node:inspector` セッションで、各テスト前後に `Profiler.takePreciseCoverage` を呼ぶ方式を実際に動かして確認した。

**検証結果**:

| 項目 | 結果 |
| --- | --- |
| per-test 分離 | `[REQ-001]`→`signIn` のみ / `[REQ-002]`→`resetPassword` のみ / `[REQ-003]`→`charge` のみ、と正確に分離。`takePreciseCoverage` は CDP 仕様どおり呼ぶたびにカウンタをリセットするため、テスト間差分がそのまま取れる |
| プール互換 | `pool: 'forks'` / `'threads'` 両方で動作(worker_threads でもワーカーごとに inspector セッションを張れる) |
| V8 関数名の忠実度 | arrow 関数 (`export const area = ...` → `"area"`)、クラスメソッド (`add` / `total` — **メソッド粒度**)、named default export (`describeShape`) すべて正しい名前で報告。推移的呼び出し (`describeShape`→`area`) も正しく帰属 |
| TS トランスフォーム | script URL と関数名は原ソースに正確。**バイトオフセットのみ**トランスフォーム後の値 → 「相対パス × 関数名」join で source-map 復元を回避可能(FR-007 の根拠) |
| ノイズの観測 | 共有ヘルパ (`validateEmail`) が全 REQ から実行される・module-init が最初の import テストに誤帰属する、の両方を確認。排他性分析(単一 REQ からのみ実行 = EXCLUSIVE)で機械的に識別できることも確認 |
| オーバーヘッド | 507 テストで 2.25s → 2.99s(**約 33% 増**、1 テストあたり約 3.6ms、未最適化)。SC-005 の 50% バジェットの根拠 |

PoC の核(カスタムランナー、再現用):

```js
// pertest-runner.js — Vitest custom runner (PoC)
import { VitestTestRunner } from 'vitest/runners';
import inspector from 'node:inspector';

const session = new inspector.Session();
session.connect();
const post = (m, p) => new Promise((res, rej) =>
  session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
await post('Profiler.enable');
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

export default class PerTestCoverageRunner extends VitestTestRunner {
  async onBeforeRunTask(test) {
    await post('Profiler.takePreciseCoverage'); // drain counters
    return super.onBeforeRunTask(test);
  }
  async onAfterRunTask(test) {
    await super.onAfterRunTask(test);
    const { result } = await post('Profiler.takePreciseCoverage'); // per-test delta
    // result[].url + functions[].functionName + ranges[0].count>0 → per-test record
  }
}
```

`@vitest/coverage-v8` 自体がワーカー内 inspector セッション + `Profiler.startPreciseCoverage` で実装されており、同一機構の per-task 版という位置づけ。Runner API (`onBeforeRunTask` / `onAfterRunTask`) は experimental 扱いである点に注意。

## R2. 先行事例 — メカニズムは業界実証済み、「要求」への適用が空白

- **Stryker Mutator** `coverageAnalysis: "perTest"`(既定値): テストフレームワークの `beforeEach` をフックし activeTest を切り替えて per-test 帰属を記録。Jest/Vitest/Mocha 横断で本番運用されており、per-test 帰属アーキテクチャの実在証明。順序独立テストを前提とする制約も同じ。<https://stryker-mutator.io/docs/stryker-js/configuration/>
- **商用 TIA**: Datadog Test Impact Analysis / Microsoft TIA / Sealights / Wallaby.js — いずれも per-test(または per-suite)カバレッジで「テスト→コード」対応を構築。全てクローズド商用、マップ先は「変更ファイル」であり「要求」ではない。**Datadog は JS/TS では per-suite 粒度に後退**しており(透過 tracer の制約下)、file 粒度フォールバックを一級市民にすべき根拠。<https://docs.datadoghq.com/tests/test_impact_analysis/setup/javascript/>
- **DO-178C(航空)**: 「要求ベーステスト + 構造カバレッジ分析」はまさにこのワークフローで、VectorCAST / LDRA / Rapita という高額商用ツール群が存在 = 最高信頼性産業で検証済みの需要。OSS 実装は不在。<https://ldra.com/ldra-blog/do-178c-structural-coverage-analysis/>
- **競合空白**: StrictDoc(手動 `@relation`)/ OpenFastTrace(手動タグ)/ rtmx(test↔REQ は CSV 宣言・コード対応なし)/ pytctracer(研究成果物、test→code のみで requirement 層なし)。「REQ タグ付きテスト + per-test カバレッジ → REQ↔code 自動エッジ」の OSS は複数角度の調査で発見できず。

## R3. ノイズ問題 — 既知・既研究(緩和策は文献に既にある)

- feature location 研究 30 年分の知見: 実行トレースは utility/framework/module-init に汚染される。Dit et al. 2013 survey. <https://www.cs.wm.edu/~denys/pubs/JSME-FL-SurveyCRCV1.pdf>
- **TCTracer** (White & Krinke, EMSE 2021): per-test 動的トレース + **TF-IDF 重み付け**(多くのテストから呼ばれる関数を減点)+ 複数手法合成で MAP ~85%(関数粒度)/ ~92%(クラス粒度)。Phase C の信頼ランクの理論上限目安。<https://link.springer.com/article/10.1007/s10664-021-10079-1>
- spec.md の一次的緩和策(排他性格付け / `sharedThreshold` / module-init 除外)は上記の最も単純で決定的なサブセットを採用したもの。TF-IDF 連続スコアは非決定性を持ち込まない範囲(固定入力→固定スコア)で Phase C にて検討。

## R4. artgraph 内の接合点(実装コスト見積りの根拠)

- **REQ↔テスト join は実装済み**: `src/test-results.ts`(spec 006)が Vitest JSON / JUnit XML から `[REQ-xxx]` を抽出し `TestResultMap` を構築。describe 祖先継承・dedupe も既存規則あり。本 feature は「pass/fail」に「実行シンボル集合」を加える位置。
- **provenance 拡張点**: `src/types.ts` の union + runtime `EDGE_PROVENANCE_VALUES` の 2 箇所(spec 011 SC-008 の同期テストが両者の一致を強制)。
- **lock の byte-stable パターン**: `impl`/`tests` の `[...new Set()].sort()`(`src/lock.ts`)をそのまま流用可能。
- **ギャップ**: (a) シンボルのバイトスパンは lock に永続化されていない → 関数名 join(R1)で不要化。(b) テストノードは file 粒度のみ → per-it 帰属は reqId join で処理しノードモデルは変更しない。

## R5. Constitution 影響(spec.md Related の根拠)

- 原則 I: エッジ導出元の列挙「frontmatter 宣言、ID タグ、TS AST のいずれか」に「テスト実行トレース成果物」が含まれない → MINOR 改訂が必要。決定性の実体(同一入力 → 同一出力)は `graph = f(files, trace)` の形式化で維持。
- 原則 III: カバレッジ三段階 `untagged / impl-only / verified` に `exercised`(オプトイン時のみ)を追加 → MINOR 改訂が必要。「タグだけで安心する」を防ぐ非対称信頼境界という原則の意図は、証拠が宣言を**監査する**方向なのでむしろ強化される。
- 原則 V: 「実行された」は観測可能な構造的事実であり意味判定ではない → 抵触なし。

## Phase 0 設計判断 (Decision / Rationale / Alternatives)

### D1. 採取方式 = Vitest カスタムランナー + ワーカー内 inspector セッション

- **Decision**: `VitestTestRunner` 拡張の `onBeforeRunTask`/`onAfterRunTask` で `Profiler.takePreciseCoverage` を挟む(PoC 実証方式)。
- **Rationale**: `@vitest/coverage-v8` と同一機構の per-task 版であり、ビルドステップ・コード書換えが不要。既存のテスト挙動(スナップショット・レポーター)を変えない。
- **Alternatives**: (a) istanbul 計装(Stryker 方式) — build 変換の注入が必要で「config 1 行」の UX が壊れる。(b) `NODE_V8_COVERAGE` — プロセス単位でしか取れず per-test 分離不能。(c) reporter のみ — テスト境界フックがなく分離不能。

### D2. カバレッジ粒度 = `detailed: false`(関数粒度)

- **Decision**: `startPreciseCoverage({callCount: true, detailed: false})`。
- **Rationale**: 必要なのは「関数が実行されたか」の boolean のみ。block 粒度を落とすことで overhead(PoC 33%)をさらに削れる。
- **Alternatives**: `detailed: true` — block 粒度は将来の行レベル可視化まで不要。データ量と正規化コストが増える。

### D3. シンボル join = 「相対パス × 関数名」(source-map 不採用)

- **Decision**: V8 の `functionName` と scan 時再構築の名前表(export 名 → symbol id、クラス member 名 → クラス symbol id)で join。曖昧・不一致は file 粒度フォールバック。
- **Rationale**: PoC で arrow / メソッド / named default の名前忠実度を確認済み。バイトオフセットはトランスフォーム後の値でそのままでは使えず、source-map 復元は vitest 内部(`ast-v8-to-istanbul` 相当)への依存を持ち込む。fail-safe フォールバックがあれば名前 join の失敗は精度低下に留まり、REQ 到達は失われない(spec 018 規範)。
- **Alternatives**: (a) source-map 復元 — 精度は上がるが複雑性・依存・vitest バージョン結合が重い。将来の精度改善として保留。(b) バイトオフセット直接使用 — トランスフォームで無効。

### D4. trace 成果物 = per-worker JSONL シャード、読込み時正規化

- **Decision**: runner はワーカーごとに `.artgraph/trace/*.jsonl` へ追記のみ行い、正規化(boolean 化・ソート・和集合・dedup)は ingest/scan の読込み時に決定的に行う。世代管理(旧シャード削除)は config ラッパーが仕込む globalSetup。
- **Rationale**: 書込み競合を設計で排除(Edge Case 対応)。「正規化はすべて読む側」に寄せることで runner を最小・最速に保ち、CI シャードのマージ(和集合)も自然に扱える。
- **Alternatives**: (a) run 終了時に単一 canonical ファイルへ集約 — グローバルフックが必要で構成が増える。(b) 各テスト後に共有ファイルへ書込み — ロック必須で遅い。

### D5. エッジモデル = 新 kind `exercises` + 一致時の `implements` provenance 追記

- **Decision**: 証拠のみの対は `exercises` エッジ、宣言と一致する対は既存 `implements` の provenances へ `coverage` 追記。
- **Rationale**: 「実行された」と「実装している」は真理条件が異なる。別エッジであることで UNEXERCISED CLAIM(主張 − 証拠)と SUGGESTED IMPL(証拠 − 主張)が集合差として素直に定義でき、`acceptExercises` のオプトインも表現できる。
- **Alternatives**: provenance のみで `implements` に統一 — 証拠が黙って uncovered を充足し原則 III の信頼境界を破る(plan.md Complexity Tracking 参照)。

### D6. green テストのみを証拠に数える

- **Decision**: 失敗テストのカバレッジは trace に保持するが、エッジ・充足・提案には使わない。
- **Rationale**: 既存 `verified` の `every(passed)` セマンティクスと整合。red テストの実行経路は「実装が主張どおりか」の証拠として弱い。
- **Alternatives**: 全実行を数える — ドリフト中・実装途中のコードへ証拠エッジが張られ、監査所見の信頼を毀損する。

### D7. staleness = trace 記録時 contentHash vs 現在ハッシュ

- **Decision**: shard に実行シンボルの contentHash を記録し、scan/check 時に現在値と照合。
- **Rationale**: 既存 drift 機構(hash 照合)の転用で、新しい時刻・git 依存を持ち込まない。git 非依存(core scan は git 不要という既存性質を維持)。
- **Alternatives**: (a) mtime / git commit 比較 — 非決定的・環境依存。(b) 鮮度無視 — 決定性ブランドを毀損(spec US5 の根拠)。

### D8. vitest は optional peerDependency `>=3 <5`

- **Decision**: runner モジュール(`artgraph/vitest`)のみが `vitest/runners` を import し、CLI 本体は vitest 非依存。CI で 3.x / 4.x マトリクス E2E。
- **Rationale**: CLI 利用者に vitest を強制しない。Runner API は experimental のためバージョン結合はマトリクステストで監視する。
- **Alternatives**: (a) hard dependency — CLI だけ使うユーザーに不要な重み。(b) バンドル同梱 — vitest はユーザープロジェクト側の実行環境なので原理的に不可。

### D9. 採取方式の転換(capture engine v2、spec 021)

- **Decision**: 既定の採取方式を D1 のワーカー内 inspector セッション(CDP `takePreciseCoverage`)から、build-time の関数入口静的計装(`withTrace()` が注入する Vite plugin)へ転換する(spec 021)。CDP 経路は `engine: 'cdp'` / `ARTGRAPH_TRACE_ENGINE=cdp` で明示選択可能な fallback として残置する。
- **Rationale**: D1 が計装方式を退けた理由「build 変換の注入が必要で『config 1 行』の UX が壊れる」は、D1 自身の成果物である `withTrace()` ラッパーの存在により失効している — plugin の注入も同じ 1 行の中で完結する。加えて `takePreciseCoverage` 1 回のコストが isolate にロード済みのスクリプト総数に比例することが実測で判明し(25 モジュール 0.345ms → 1,600 モジュール 1.545ms、`docs/design/241-trace-engine-v2.md`)、テスト数 × モジュール数に比例する構造的な性能限界が D1 方式に内在することが分かった。詳細な設計判断(V1〜V9)は `specs/021-instrumented-trace-engine/` を参照。
- **Alternatives**: D1 の Alternatives (a)〜(c) は spec 021 でも再検討したが結論は変わらない — `NODE_V8_COVERAGE`(プロセス単位で per-test 分離不能)、reporter のみ(境界フックなし)は不採用のまま。CDP 継続 + issue #241 の対策候補(バッチ化・hash キャッシュ・フィルタ前倒し)は支配項に触れず改善上限 1.3〜1.4x に留まるため、fallback エンジンの安価改善としてのみ採用した(spec 021 V8)。
