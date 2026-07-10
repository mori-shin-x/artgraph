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
