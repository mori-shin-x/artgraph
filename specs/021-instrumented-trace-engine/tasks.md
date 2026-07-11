# Tasks: trace capture engine v2 — 静的計装による per-test 採取固定費のモジュール数独立化

**Input**: Design documents from `/specs/021-instrumented-trace-engine/`

**Prerequisites**: plan.md, spec.md, research.md (V1〜V9), data-model.md, contracts/instrumentation-runtime.md, contracts/config-surface.md

**Tests**: TDD 指定あり — 各ストーリーで **RED(テスト先行)→ GREEN(実装)** の順に並べる。テストタスクには 7 観点(下表)の割当を明記する。

**Organization**: ユーザーストーリー単位。US1(v2 本体)→ US2(パリティ)→ US3(エンジン選択)→ US4(perf 計測)。plan.md の実装フェーズ対応: Phase A=T017 / B=US1+US3(T024 含む) / C=US2 / D=T018〜T023。

## TDD 観点マップ(ユーザー指定 7 条件)

| # | 観点 | 主な割当タスク |
| --- | --- | --- |
| 1 | 境界条件 | T003(相対化 `..`・絶対パス・`node_modules/` 中間一致・`.test/.spec` × `[cm]?[jt]sx?` 全組合せ)、T006(関数ゼロモジュール・空ファイル・BOM・CRLF・巨大関数名表)、T008(バッファ 0 件 flush・最終テストファイル境界) |
| 2 | 条件分岐の組み合わせ | T014(engine オプション × 環境変数 × 既存 plugins × 既存 globalSetup × ユーザー test.env の直積)、T006(命名規則の全種別 × export 有無 × 計算プロパティ) |
| 3 | 不正な状態遷移 | T008(registry version 不一致 → 採取放棄 + 警告 1 回・以後のテスト進行は正常)、T014(不正 engine 値 → withTrace 即 throw / worker 初期化 throw — silent fallback 禁止)、T010(drain 前の onAfterRunFiles = メタのみ shard) |
| 4 | 例外系・失敗時の挙動 | T006(parse 不能ソース → 無変換素通し + 警告 1 回/モジュール、テストは green のまま)、T011(関数が throw しても入口印は記録される = V8 の entered セマンティクスと同じ)、T009(flush 中の書込エラーでワーカーを殺さない) |
| 5 | 実運用で起きやすい事故パターン | T010(ワーカー途中 kill → 部分 shard が常に完全な JSONL 行列)、T013(trace 記録後のソース編集 → staleness 検出が v2 hash でも機能)、T014(withTrace 二重適用の冪等性・`test.runner` 直指定 + plugin 無し → 警告と誘導)、T016(isolate オン/オフ両方でのモジュール再評価 → registry 置換) |
| 6 | エッジケース | T011(無名関数のみが hit するモジュール・named default / 無名 default・constructor・getter/setter・ネスト named 関数・async / generator・同名関数の同一ファイル内複数)、T006(オブジェクトリテラルメソッド・computed key は計装しない) |
| 7 | 考慮漏れ(変更外ファイルへの影響) | T022(knip: plugin.ts の到達性 / package.json exports 不変 / tsconfig 出力に plugin 含有 / oxlint・oxfmt / templates 内 Skills 文書の runner 記述 / vendor copy スクリプト非干渉)、T013(trace 不在時の全コマンド出力が導入前と一致 — 既存回帰の再実行)、T002(着手前ベースライン記録) |

## Phase 1: Setup

**Purpose**: 依存追加と着手前ベースラインの固定

- [x] T001 `pnpm install` 後、`pnpm add magic-string` で依存を追加し(main-process 変換専用 — research.md V2)、`knip.json` の追加不要性を確認する(plugin.ts から import されるため到達可能)。対象: `package.json`
- [x] T002 着手前ベースラインを固定する: `pnpm build && pnpm test:unit && pnpm test:e2e` が green であることを確認し、`pnpm test:perf` の現行実測比(純関数 fixture)をログから記録する(観点 7 — 変更外影響の検出基準)。対象: 記録のみ(ファイル変更なし)

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: hash 規則・除外規則・registry 型の SSOT 化 — plugin と runner の両方が依存する共有点。**全ストーリーの前提**

- [x] T003 [RED] `tests/hash-equivalence.test.ts` を「`src/trace/schema.ts` の hash 関数 ↔ `src/parsers/typescript.ts`」の SSOT 直撃ピンに書き換え、`tests/trace-schema.test.ts` に除外規則の境界テストを追加する: 相対化で `..` に出るパス・絶対パス・`node_modules/` を中間に含むパス・`.test.`/`.spec.` × `js|jsx|ts|tsx|cjs|mjs|cts|mts` の全組合せ・`node_modules` を**含まない**類似名(`my_node_modules/`)は除外されないこと(観点 1)。この時点では schema.ts に関数が無く red
- [x] T004 `src/trace/schema.ts` に hoist を実装して T003 を green にする: `stripBom` / `hashContent`(BOM 除去 → sha256 → 16 桁、`runner.ts` の実装を移設)・除外規則(`isExcludedRelPath` / `TEST_FILE_RE`)・registry 契約の型と定数(`TraceRegistry` / `ModuleRegistration` 型、`REGISTRY_KEY = "__ARTGRAPH_TRACE_REGISTRY__"`、`REGISTRY_VERSION = 1` — contracts/instrumentation-runtime.md)。`src/vitest/runner.ts` の複製を import に置換(挙動不変)。schema.ts は node builtins のみ依存を維持
- [x] T005 [P] `tests/trace-schema.test.ts` に registry 契約の形状検証テストを追加する: `REGISTRY_KEY` / `REGISTRY_VERSION` / `ModuleRegistration` 形状(`fns.length === hits.length` 不変条件)が contracts/instrumentation-runtime.md の記載と一致すること(SSOT ペア c の等価性メタテスト)

**Checkpoint**: `pnpm test:unit` green(既存挙動不変のリファクタ + 新規契約テスト)。ここまで完了で全ストーリー着手可能

## Phase 3: User Story 1 — 大規模スイートでの体感オーバーヘッド解消 (P1)

**Goal**: 計装 plugin + worker runtime + runner v2 経路。per-test 固定費をロード済みモジュール数から独立させる

**Independent Test**: fixture プロジェクトで instrument エンジンの `vitest run` → schemaVersion 1 の shard が正しく生成される(quickstart §1・§3 の instrument 側)

- [x] T006 [US1] [RED] `tests/vitest-plugin.test.ts` を新規作成する(plugin の transform を直接呼ぶユニット)。網羅対象:
  - **命名表(観点 2・6)**: FunctionDeclaration / `export default function named` / 無名 default(関数・arrow)→ `"default"` / const・let への関数式・arrow 代入 → 変数名 / クラス `MethodDefinition` → メソッド名・`constructor` → クラス名(V8 互換)/ getter・setter → アクセサ名 / `PropertyDefinition` の関数値 → プロパティ名 / オブジェクトリテラルメソッド → キー名 / ネスト named 関数 → 自名 / 無名コールバック・computed key → **計装しない**
  - **挿入の構造(観点 1)**: 変換前後で行数一致・各行の既存内容保持・sourcemap が返る・preamble に `import`/`require` が含まれない(正規表現 assert — contracts 書き手義務 1)
  - **hash(観点 1)**: BOM 付き・CRLF・空ファイル。`code` 引数ではなくディスク内容から計算されること(pre plugin が改変した `code` を渡しても hash は原ソース)
  - **除外(観点 1)**: テストファイル・node_modules・ルート外 id は無変換
  - **fail-soft(観点 4)**: parse 不能ソースは無変換素通し + 警告 1 回/モジュール、2 回目の transform で警告が重複しない
  - **境界(観点 1・6)**: 関数ゼロのモジュールは無変換・未登録
  - **契約の書き手義務 3〜5(観点 2・7 — contracts/instrumentation-runtime.md)**: 実行印が分岐なしの 1 文 store であること(生成断片に `if`/`&&`/`?` を含まない)・生成コードに `await` / `import.meta` が現れないこと(ESM/CJS 双方で評価可能 — 義務 4)・巻き上げられた FunctionDeclaration(モジュール末尾宣言)の実行印参照が preamble 定義の変数を指すこと(hoisting 整合 — 義務 5)
- [x] T007 [US1] `src/vitest/plugin.ts` を新規実装して T006 を green にする: oxc-parser で関数列挙 + V4 命名、magic-string で関数本体先頭に `<hits>[k]=1` 挿入 + 自己完結 preamble(globalThis registry 登録・`modules.set(file, …)` 置換方式)、`enforce: 'pre'`、除外規則と hash は schema.ts から import、`configResolved` で root 取得。main-process 層の依存規則(oxc-parser / magic-string 可、`vitest/runners` 不可)を冒頭コメントに明記
- [x] T008 [US1] [RED] `tests/vitest-runner-unit.test.ts` を新規作成する(runner の drain / バッファを純関数として検証)。網羅対象:
  - **drain(観点 1・5)**: 立っているスロットのみ hits 化・読み取り後ゼロクリア・空 registry で空 hits・同 relPath 再登録(isolate 再評価)は置換され旧配列を読まない・`hashes` は registration の hash 転記(fs 非アクセス)
  - **不正遷移(観点 3)**: `REGISTRY_VERSION` 不一致 → 採取放棄 + stderr 警告 1 回のみ(テスト進行は正常)・registry 不在 → hits 空で正常進行
  - **バッファ(観点 1・4)**: テストファイル境界検知で flush・`onAfterRunFiles` 相当で最終 flush・0 レコード時は flush しない・flush 出力が常に完全な JSONL 行の列
- [x] T009 [US1] `src/vitest/runner.ts` に v2 経路を実装して T008 を green にする: エンジン分岐(`process.env.ARTGRAPH_TRACE_ENGINE` 読み取り・不正値 throw)、instrument 経路(inspector 非使用・onBeforeRunTask は no-op・onAfterRunTask で drain → バッファ・concurrent は従来どおり skipped 記録 + drain だけ実施)、バッチ flush(書込エラーはテストを殺さず警告 — 観点 4)、ワーカー終了までに登録ゼロなら警告 1 回 + `withTrace` / `ARTGRAPH_TRACE_ENGINE=cdp` への誘導文言(FR-008)
- [x] T010 [US1] `tests/e2e/vitest-runner.e2e.test.ts` に instrument エンジンの E2E シナリオを追加する: 実 vitest spawn で shard 正当性(meta 先頭・test レコード形状・hits/hashes 整合)・**ワーカー途中 kill → 部分 shard が完全な JSONL 行列**(観点 5 — v2 のバッチ flush 下で既存の耐性シナリオを更新)・世代管理(globalSetup の旧 shard 削除)が green

**Checkpoint**: instrument エンジン単体で end-to-end 動作。US1 のみで MVP デリバリ可能

## Phase 4: User Story 2 — 既存利用者の無破壊移行(出力等価性) (P1)

**Goal**: 両エンジンの ingest 後エッジ集合一致を CI 強制。下流(scan/check/impact/staleness)の不変性を実証

**Independent Test**: quickstart §2・§6(differential E2E + 下流不変性)

- [x] T011 [US2] [RED] `tests/e2e/engine-parity.e2e.test.ts` を新規作成する(FR-011 / SC-004)。命名種別網羅 fixture(export 関数 / arrow 代入 / クラスメソッド + constructor / getter / named・無名 default / 非 export 関数 / ネスト named / **無名関数のみが hit するモジュール** / throw する関数 / async 関数 / generator — 観点 4・6)を `instrument` / `cdp` 両エンジンで実行し、shard → ingest 通過後の正規化エッジ集合が一致することを assert。同一エンジン 2 回実行の byte-identical(決定性)も assert
- [x] T012 [US2] T011 で観測された乖離を修正する(想定: 命名表の細部 — generator の entered タイミング・推論名のずれ等)。修正先は `src/vitest/plugin.ts` の命名規則を優先し、縁のケースで「v2 が記録しない」側に倒す場合は research.md V4/V7 に観測結果を追記して挙動を固定する
- [x] T013 [US2] 下流不変性 + staleness の E2E を `tests/e2e/engine-parity.e2e.test.ts`(または既存 `tag-zero.e2e.test.ts` 拡張)に追加する: v2 shard に対し `artgraph trace report` / `scan --format json`(2 回実行 byte-identical)/ `check` が無変更で動作・**trace 記録後にソース編集 → staleness 警告が v2 hash でも機能**(観点 5)・trace 不在時の出力が導入前と一致(spec 020 SC-007 系の既存回帰を v2 既定下で再実行 — 観点 7)

**Checkpoint**: 両エンジンのパリティが CI で強制される。既存ユーザーへの無破壊性が実証済み

## Phase 5: User Story 3 — エンジン選択と fallback (P2)

**Goal**: `withTrace({ engine })` + `ARTGRAPH_TRACE_ENGINE`。cdp 経路の安価改善と両エンジンマトリクス

**Independent Test**: quickstart §7(不正値 fail-fast・エンジン切替)

- [x] T014 [US3] [RED] `tests/vitest-setup.test.ts` に engine オプションのテストを**追加**する(ファイルは spec 020 実装で既存 — reporters / setupFiles / pool 保持・globalSetup 冪等追記などの既存回帰アサーションは削除せず保持したまま拡張する)。網羅対象(観点 2・3・5):
  - **分岐の直積**: engine 指定(なし / `instrument` / `cdp` / 不正値)× 既存 `plugins` の有無 × 既存 `globalSetup`(string / array / なし)× ユーザー設定済み `test.env.ARTGRAPH_TRACE_ENGINE` の有無
  - 不正 engine 値 → `withTrace` 呼び出し時に throw(fail-fast、観点 3)
  - `instrument` → plugin が `plugins` に追記され、既存 plugins が保持される・**二重 withTrace は plugin 名で冪等**(観点 5)
  - `cdp` → plugin 非注入 + `test.env` マーカー設定
  - ユーザーが `test.env.ARTGRAPH_TRACE_ENGINE` を設定済み → ユーザー値優先(contracts/config-surface.md)
  - 従来義務の回帰: `test.runner` 設定・globalSetup 冪等追記・その他キーのパススルー
- [x] T015 [US3] `src/vitest/setup.ts` に `withTrace(config, options?)` を実装して T014 を green にする(plugin.ts を import — main-process 層)
- [x] T016 [US3] cdp 経路の安価改善を `src/vitest/runner.ts` に実装する(FR-013 — これ以上の最適化はしない): ワーカー内 `path → contentHash` メモ化・shard 書き込みを v2 と同じバッチ機構に載せる。`tests/e2e/vitest-runner.e2e.test.ts` を **両エンジン × forks / threads** のマトリクスに拡張し、isolate オン/オフ両方で registry 置換が正しく働くこと(観点 5)を含めて green にする
- [x] T024 [US3] vitest バージョンマトリクス CI を追加する(FR-014 — 分析所見 C2: 3.x/4.x を実際に回すマトリクスは現状存在しない): `.github/workflows/ci.yml` に vitest 3.x ジョブ軸を追加する(`pnpm add -D vitest@^3 --no-save` 等で差し替えてから `pnpm build && pnpm test:e2e` を実行 — runner E2E が両エンジンをカバーするため e2e スイートで足りる)。実行順は T016 の後

**Checkpoint**: エンジン切替が完全動作。逃げ道と比較対象が揃う

## Phase 6: User Story 4 — perf 回帰の継続監視 (P2)

**Goal**: import 重 fixture の追加(plan Phase A — **US1 より先に着手可・推奨**)とバジェット引き下げ(plan Phase D — US1〜3 完了後)

**Independent Test**: quickstart §4・§5

- [x] T017 [US4] [P] `tests/perf/trace-overhead-import-heavy.perf.test.ts` を新規作成する(plan Phase A — 他ストーリーに依存しない): 既存 perf テストの spawn 技法(node_modules symlink・plain-object config・interleaved rounds・median 比較)を踏襲し、モジュール数をパラメタ化した import 重 fixture(目安 300 モジュール・import チェーン・300 テスト — data-model.md §6)を生成。**この時点では現行エンジンの実測比を記録ログに残すだけ**(assert は現行バジェット 1.5 — 悪化体質の再現を先に固定する)
- [x] T018 [US4] 両 perf テスト(`tests/perf/trace-overhead.perf.test.ts` / `trace-overhead-import-heavy.perf.test.ts`)のバジェットを 1.5 → **1.2** に引き下げ、withRunner 側を v2 既定(instrument)で計測するよう更新する(SC-002 / SC-003)。ログ出力(実測比の毎回記録)は維持
- [x] T019 [US4] dogfooding 計測を実施し記録する(SC-001): quickstart §5 の手順で自スイートの baseline / instrument / cdp を各 3 回計測し中央値比較。instrument ≤ **1.15** を確認し、結果を PR の Testing 節に記録する(CI assert にはしない — research.md V9)

**Checkpoint**: 全 SC の数値目標が実測で裏付けられ、回帰ガードが CI に載る

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T020 [P] spec 020 の契約とリサーチを更新する(FR-010): `specs/020-coverage-derived-edges/contracts/trace-artifact.md` §test の `fn` 記述に「V8 functionName 互換の命名規則で決定した関数名(capture engine v2)」の注記(schemaVersion 据え置き)・`specs/020-coverage-derived-edges/research.md` に D9(採取方式転換と D1 棄却理由の失効)を追記
- [x] T021 [P] `docs/configuration.md` に `withTrace` の `engine` オプションと `ARTGRAPH_TRACE_ENGINE` の説明を追加する(contracts/config-surface.md の利用者向け要約)
- [x] T022 変更外ファイルへの影響を横断確認する(観点 7): `pnpm knip`(plugin.ts の到達性・magic-string の使用検出)・`pnpm typecheck`・oxlint / oxfmt・`package.json#exports` が不変であること・`templates/**` の Skills 文書(artgraph-verify / bootstrap 等)に runner 記述の齟齬が生じていないこと・`scripts/copy-vendor.mjs` / `tests/global-setup-vendor.ts` に非干渉であること・`vitest.config.ts`(自プロジェクト)の coverage 設定と plugin が干渉しないこと
- [x] T023 最終検証(**SC-006**): `pnpm build && pnpm test`(unit + e2e + perf 全部)を **v2 計装既定**の下で green にし、全 green の事実を SC-006 の実測結果として PR の Testing 節に記録する・`pnpm artgraph check --diff` green(after_implement フックの事前確認)・quickstart §1〜§7 の全手順を通す

## Dependencies

```text
Phase 1 (T001-T002)
  └─ Phase 2 (T003→T004, T005)          ← 全ストーリーの前提
       ├─ US1: T006→T007 → T008→T009 → T010
       │    ├─ US2: T011→T012→T013     ← US1 完了後(両エンジン比較には T009 のエンジン分岐が必要)
       │    └─ US3: T014→T015, T016→T024 ← T015 は T007(plugin 存在)後。T016 は T009 後
       ├─ US4-A: T017 [P]              ← Phase 2 にも依存しない(既存エンジンの計測)。最優先で並行着手推奨
       └─ US4-D: T018→T019             ← US1〜US3 完了後
Phase 7: T020 [P], T021 [P]            ← いつでも(文書のみ)。T022→T023 は全実装後
```

## Parallel Execution Examples

- **着手直後に並行可**: T017(import 重 fixture — 独立ファイル・既存エンジン対象)/ T020・T021(文書)/ Phase 2(T003→T004)
- **Phase 2 完了後**: T005 ∥ T006(別ファイル)
- **US1 完了後**: US2(T011〜)∥ US3(T014〜)— US2 は tests/e2e、US3 は src/vitest/setup.ts + runner cdp 経路で、T012(plugin 命名修正)と T015(setup)はファイルが重ならない。ただし T012 と T016 が `runner.ts`/`plugin.ts` に同時に触れないよう、T012 完了を確認してから T016 に入る

## Implementation Strategy

- **MVP** = Phase 1 + 2 + US1(T001〜T010)。この時点で instrument エンジンが end-to-end 動作し、shard 契約準拠を e2e が保証する。
- **推奨実行順**(plan.md Phase A→B→C→D に対応): T017 を最初に並行起動(改善前の悪化実測を固定)→ Setup/Foundational → US1 → US2 ∥ US3 → T018〜T019 → Polish。
- バジェット引き下げ(T018)は US2 パリティが green になるまで行わない — 「速いが違うものを測って green」を防ぐ。
- 各タスク完了時に該当テストがローカル green であることを確認してから次へ(RED → GREEN の証跡をコミットメッセージに残す)。
