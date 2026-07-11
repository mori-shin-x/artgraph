# Implementation Plan: trace capture engine v2 — 静的計装による per-test 採取固定費のモジュール数独立化

**Branch**: `claude/artgraph-test-perf-q48v46` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: spec 022 / issue #241 / 設計文書 [docs/design/241-trace-engine-v2.md](../../docs/design/241-trace-engine-v2.md)(プローブ実測済み)

## Summary

spec 020 の trace 採取層のみを置き換える。現行の per-test CDP 採取(`takePreciseCoverage` ×2/テスト)は、1 回のコストが isolate のロード済みスクリプト数に比例することが実測で判明しており(25→1,600 モジュールで 0.35→1.55ms)、テスト数×モジュール数の二重比例で大規模スイートほど悪化する。v2 は `withTrace()` が注入する Vite plugin で**プロジェクト内ソースの関数入口に実行印(typed-array store)を静的に計装**し、runner はテスト境界でワーカー内 registry を回収するだけにする(実測 0.013〜0.13ms/テスト)。contentHash は変換時に原ソースから計算、shard 書き込みはテストファイル境界のバッチにする。shard 契約は schemaVersion 1 のまま**不変**で、ingest 以降は無変更。CDP エンジンは fallback として残置し(hash メモ化 + バッチ書き込みの安価な 2 改善のみ適用)、differential テストで両エンジンの正規化エッジ集合一致を CI 強制する。実装は Phase A(計測基盤 — import 重 fixture で悪化体質を先に固定)→ B(plugin + runtime + runner v2)→ C(パリティ + バージョンマトリクス)→ D(バジェット 1.5→1.2・既定切替・契約注記)の 4 段。

## Technical Context

- **Language/Runtime**: TypeScript strict / Node.js >= 22(既存)。pnpm。vitest(unit / e2e / perf)。oxlint / oxfmt / knip。
- **変換(新規)**: Vite plugin(`enforce: 'pre'`)。パースは **oxc-parser**(既存 dependency、scan で実績)、挿入は **magic-string**(新規 dependency — 軽量・依存ゼロ・hires sourcemap 生成)。vitest では forks / threads 両プールとも変換は main process の vite-node サーバで実行されワーカー間でキャッシュ共有されるため、変換コストは O(モジュール数) の一回性([research.md](./research.md) V2)。
- **worker 内 runtime(新規)**: plugin が各モジュールに注入する自己完結 preamble が `globalThis` の registry に(相対パス・contentHash・関数名表・`Uint8Array` 実行印)を登録する。**import 文を注入しない**(モジュール解決非依存・worker 側依存ゼロを構文的に保証)。registry 形状は [contracts/instrumentation-runtime.md](./contracts/instrumentation-runtime.md) が唯一の契約。
- **runner(変更)**: エンジン分岐(`instrument` 既定 / `cdp` fallback)。instrument 経路は inspector を張らず、`onAfterRunTask` で registry を走査 → hits 化 → メモリバッファ、テストファイル境界 + `onAfterRunFiles` で flush。cdp 経路は現行コードに hash メモ化とバッチ書き込みのみ追加。
- **エンジン選択**: `withTrace({ engine })`(既定 `'instrument'`)+ 環境変数 `ARTGRAPH_TRACE_ENGINE`(優先)。withTrace は instrument 時のみ plugin を注入し、`test.env` マーカーで worker 側 runner に伝搬([contracts/config-surface.md](./contracts/config-surface.md))。
- **shard 契約**: spec 020 の [trace-artifact.md](../020-coverage-derived-edges/contracts/trace-artifact.md) を schemaVersion 1 のまま維持。`fn` の由来注記のみ修正(FR-010)。
- **SSOT 移設**: contentHash 規則(現在 `src/parsers/typescript.ts` と `src/vitest/runner.ts` に複製)と除外規則(runner の `isExcludedRelPath` — plugin も同一判定が必要)を、双方が import 可能な依存フリー共有点 `src/trace/schema.ts` へ hoist する(等価性ピンは維持)。
- **perf 計測**: 既存 `tests/perf/trace-overhead.perf.test.ts`(純関数 500 テスト)に **import 重 fixture**(モジュール数をパラメタ化した合成プロジェクト)を追加し、両 fixture でバジェット 1.2 を強制。dogfooding(自スイート 1,800 テスト級 ≤1.15)は quickstart の手動計測手順 + PR 記録。
- **変更の中心**:
  - 新規: `src/vitest/plugin.ts`(vite plugin — main process 専用)、`tests/vitest-plugin.test.ts`、`tests/e2e/engine-parity.e2e.test.ts`
  - 変更: `src/vitest/runner.ts`(エンジン分岐・drain・バッチ flush・cdp 安価改善)、`src/vitest/setup.ts`(`withTrace` オプション + plugin 注入)、`src/trace/schema.ts`(hash / 除外規則 / registry 型の SSOT)、`tests/perf/trace-overhead.perf.test.ts`(fixture 追加 + バジェット 1.2)、`tests/e2e/vitest-runner.e2e.test.ts`(両エンジン化)
  - 文書: spec 020 `contracts/trace-artifact.md` §test 注記、spec 020 `research.md` D9 追記、`docs/configuration.md`(engine オプション)

## Constitution Check

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ 抵触なし。トレース由来エッジの導出元「正規化済みテスト実行トレース成果物」は v1.2.0 で既に列挙済みであり、本 feature はその成果物を**より安く作る**だけ。`graph = f(files, trace)` の等式・byte-identical 再導出・content-hash 照合による staleness はすべて不変(spec 022 SC-005 が回帰ガード)。計装は決定的な構文変換であり、LLM・統計は関与しない。
- **II. 単一型付き4層グラフ**: ✅ ノード型・エッジ型・グラフモデルへの変更ゼロ(shard より上流の採取機構のみ)。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ✅ 抵触なし。カバレッジ状態・claim 意味論に変更なし。
- **IV. SDD ツール ID 直接利用**: ✅ ID の扱いに変更なし。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ 抵触なし。観測事実の採取方法の変更であり、判定意味論は不変。
- **技術基盤と制約**: ✅ 単一パッケージ維持。新規 dependency は magic-string のみ(main process の変換専用・依存ゼロの定番)。配布物の public API 追加は `withTrace` のオプション 1 つで、「これら以外を public API として公開しない」の範囲内(既存 `./vitest` 面の拡張)。なお憲法の同節には既存ドリフトが 2 点ある(「ts-morph 一次解析」↔ 実態は oxc-parser、「Node >= 20」↔ 実態は >= 22 — issue #252)。本 spec はこのドリフトの原因ではなく、既存の oxc-parser 利用を継続するのみ。憲法改訂は issue #252 の別 PR で行う。

**Gate 裁定**: 違反なし。Complexity Tracking は空。憲法改訂不要(spec Assumptions どおり)。

### Engineering Hygiene Gates

- [x] **前提検証 (Cat6)**: 現行 runner(`src/vitest/runner.ts`)・`withTrace`(`setup.ts`)・shard 契約・`symbol-table.ts` の名前解決 2 系統・perf テストの fixture 形状を実コードで裏取り済み。支配項仮説(take コスト ∝ ロード済みスクリプト数)と代替方式のコスト(registry 走査 0.013〜0.13ms)は本セッションのプローブで実測済み([docs/design/241-trace-engine-v2.md](../../docs/design/241-trace-engine-v2.md) 付録)。spec 020 research.md D1 の計装棄却理由が `withTrace()` の存在で失効していることも確認済み。
- [x] **ID 衝突 (Cat6)**: spec 022 の FR/SC 番号は spec 020 と重複するが、既存のディレクトリ修飾機構(`022-instrumented-trace-engine/FR-001`)で扱われる既知パターン。新形式の ID は発行しない。
- [x] **SSOT ペア (Cat2)**: 4 対を特定しタスク化する — (a) contentHash 規則: `parsers/typescript.ts` ↔ `vitest/runner.ts`(既存複製)↔ plugin。`trace/schema.ts` へ hoist し既存の等価性ピン(`tests/hash-equivalence.test.ts`)を SSOT 直撃に更新。(b) 除外規則(node_modules / テストファイル / ルート外): runner ↔ plugin。同じく schema.ts へ hoist。(c) registry 形状: preamble(文字列生成)↔ runner(読む側)。契約文書 + schema.ts の型 + 形状検証テスト。(d) `resolveTraceDir` の runner ↔ setup 複製(既存・変更なしだが契約に記載済みであることを確認)。
- [x] **CLI 規約 (Cat5)**: CLI コマンド・フラグの変更なし。新設定面は `withTrace({ engine })` と `ARTGRAPH_TRACE_ENGINE` のみ — 不正値は即時エラー(silent fallback 禁止)で対称性を保つ([contracts/config-surface.md](./contracts/config-surface.md))。
- [x] **走査仕様 (Cat7)**: グラフ操作・トラバーサルへの変更なし(該当なし)。

## Project Structure

### Documentation (this feature)

```text
specs/022-instrumented-trace-engine/
├── spec.md                          # 要求の SSOT
├── plan.md                          # 本ファイル
├── research.md                      # Phase 0: 設計判断 V1〜V9(プローブ実測の参照込み)
├── data-model.md                    # Phase 1: registry / engine / fixture のデータモデル
├── contracts/
│   ├── instrumentation-runtime.md   # preamble ↔ runner の registry 契約(新設の唯一の内部境界)
│   └── config-surface.md            # withTrace オプション / 環境変数 / plugin 除外規則
├── quickstart.md                    # E2E 検証手順(differential / perf / dogfooding)
├── checklists/requirements.md
└── tasks.md                         # /speckit-tasks(未生成)
```

### Source Code (repository root)

```text
src/vitest/plugin.ts                 # Phase B: vite plugin(oxc-parser + magic-string。main process 専用)
src/vitest/runner.ts                 # Phase B: エンジン分岐 / registry drain / バッチ flush / cdp 安価改善
src/vitest/setup.ts                  # Phase B: withTrace({engine}) — plugin 注入 + test.env マーカー
src/trace/schema.ts                  # Phase B: hash 規則・除外規則・registry 型の SSOT hoist
tests/perf/trace-overhead.perf.test.ts  # Phase A: import 重 fixture 追加 / Phase D: バジェット 1.2
tests/vitest-plugin.test.ts          # Phase B: 変換 unit(命名・挿入・hash・除外・parse 不能 fail-soft)
tests/hash-equivalence.test.ts       # Phase B: SSOT 移設後の等価性ピン更新
tests/e2e/vitest-runner.e2e.test.ts  # Phase C: 既存 E2E の両エンジン化(3.x/4.x マトリクス)
tests/e2e/engine-parity.e2e.test.ts  # Phase C: differential パリティ(FR-011 / SC-004)
specs/020-coverage-derived-edges/contracts/trace-artifact.md  # Phase D: §test fn 注記(FR-010)
specs/020-coverage-derived-edges/research.md                  # Phase D: D9 追記(FR-010)
docs/configuration.md                # Phase D: engine オプションの利用者向け説明
```

**Structure Decision**: 単一パッケージを維持。`src/vitest/` の依存境界規則を 2 層に明文化して引き継ぐ — **worker 層**(`runner.ts`: `vitest/runners` + node builtins + `src/trace/schema.ts` のみ。加えて計装コード自体は import ゼロ)と **main-process 層**(`setup.ts` / `plugin.ts`: 上記に加え oxc-parser / magic-string 可。`vitest/runners` は不可)。CLI 本体から `src/vitest/` への import 禁止は knip で継続検証。

## 実装フェーズ(レビュー単位)

- **Phase A — 計測基盤(改善前に悪化体質を固定)**: import 重 fixture を perf スイートに追加し、現行エンジンでの実測比を記録ログとして残す(バジェットは現行 1.5 のまま — A 単体で red にしない)。→ US4 の前半、SC-003 の土台。
- **Phase B — engine v2 本体**: schema.ts への SSOT hoist → plugin(変換・命名・hash 埋め込み・除外・fail-soft 警告)→ runner のエンジン分岐 + drain + バッチ flush + cdp 安価改善 → withTrace のオプションと注入 → vitest 3.x/4.x の CI バージョンマトリクス新設(既存 CI に該当マトリクスは無い — 分析所見 C2)。→ US1 / US3、FR-001〜008 / 012〜014。
- **Phase C — パリティ保証**: differential E2E(命名種別網羅 fixture)、既存 runner E2E の両エンジン化、部分 shard 耐性の再確認。→ US2、FR-011、SC-004〜005。
- **Phase D — 受け入れと切替**: dogfooding 計測(quickstart 手順)→ perf バジェット 1.5→1.2 → 契約注記 + spec 020 research.md D9 追記 + docs 更新。既定エンジンは Phase B から `instrument`(spec Assumptions: 段階リリースなし)だが、切替の最終確認(全 SC green)を D の完了条件とする。→ US4 の後半、FR-009〜010 / 015〜016、SC-001〜002 / 006。

## Complexity Tracking

違反なし(Constitution Check 全項目 ✅)。
