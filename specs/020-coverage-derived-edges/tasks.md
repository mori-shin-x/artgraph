# Tasks: カバレッジ由来トレーサビリティ (`exercises` エッジ)

**Input**: [spec.md](./spec.md) / [plan.md](./plan.md) / [data-model.md](./data-model.md) / [contracts/](./contracts/)

## 進め方 (TDD: Red ⇒ Green、Phase A → Gate → B → C)

各コンポーネントは失敗テスト(Red)を先に書き、実装で Green にする。**7 観点**(①境界条件 ②条件分岐の組み合わせ ③不正な状態遷移 ④例外系・失敗時挙動 ⑤実運用の事故パターン ⑥エッジケース ⑦変更外ファイルへの影響=回帰)を各 Red タスクに明示的に割り当てる(末尾のカバレッジ行列で網羅を検証)。**Constitution Gate**: T014 以降(Phase B/C)は憲法 v1.2.0 改訂 PR のマージが着手条件(plan.md Gate 裁定)。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行実行可能(異なるファイル・未完了依存なし)
- **[USn]**: spec.md の User Story

## Path Conventions

単一パッケージ。ソース `src/`、単体テスト `tests/*.test.ts`、E2E `tests/e2e/`、perf `tests/perf/`。

---

## Phase 1: Setup

- [X] T001 `package.json` に exports `./vitest` / `./vitest/config` と `peerDependencies: { vitest: ">=3 <5" }` + `peerDependenciesMeta: { vitest: { optional: true } }` を追加し、`knip.json` / `tsconfig.json` を新 entry(`src/vitest/`, `src/trace/`)に対応させる。CLI 本体から `vitest/runners` への import が漏れない knip 構成にする(plan.md Structure Decision)
- [X] T002 [P] `.artgraph.json` の `trace.*` 設定(`artifacts` / `acceptExercises` / `staleness` / `sharedThreshold`)のパース・検証を `src/config.ts` + `src/types.ts` に追加。**Red→Green 同タスク内**: `tests/config.test.ts` に ①境界: `sharedThreshold` = 0 / 1 / 負値 / 非整数を canonical エラーで拒否(1 は合法)、④例外: `staleness` に不正値 → 既存 config 検証と同スタイルのエラー、`trace` キー省略 → 全既定値、を先に書く

## Phase 2: Foundational — shard スキーマ (runner ↔ ingest の SSOT)

- [X] T003 **Red**: `tests/trace-schema.test.ts` — [contracts/trace-artifact.md](./contracts/trace-artifact.md) の正規化仕様を固定: ①境界: 空 shard / meta 行のみ / hits 空配列のテストレコード。⑥エッジ: 同一テスト名が複数ファイルに存在・同一レコード重複 → dedup。④例外: `schemaVersion` 未知 → `unknownSchema` 診断カウント(silent skip 禁止)、JSONL 破損行(途中 kill された run)→ 該当行のみ診断+残りは処理。決定性: shard 読込み順・行順をシャッフルしても正規化出力が同一
- [X] T004 `src/trace/schema.ts` を実装して T003 を **Green** に: スキーマ定数・型・正規化(boolean 化・辞書順ソート・和集合)・診断カウンタ。runner / ingest 双方がここだけを import する(SSOT、plan.md Cat2-(b))

## Phase A-1: runner (US1 採取側)

- [ ] T005 [US1] **Red**: `tests/e2e/vitest-runner.e2e.ts` — 実 vitest を temp プロジェクトで起動する E2E: (a) per-test 分離(REQ-001 テストの hits に `signIn` のみ、US1-1 の採取側)、(b) ②分岐組合せ: pool {forks, threads} × テスト {pass, fail} × タグ {あり, なし} の行列で shard レコードが契約どおり、(c) ③不正遷移: `it.concurrent` → `kind: "skipped", reason: "concurrent"` が記録されカバレッジレコードが**出ない**(FR-003)、(d) ⑥エッジ: module-init のみ実行するテスト → hits 空(FR-007 前段)、テストファイル自身・node_modules が hits に現れない、(e) ④失敗時: テストが throw してもランナーが shard を壊さない(部分 shard が読める)
- [ ] T006 [US1] `src/vitest/runner.ts` を実装して T005 を **Green** に: `VitestTestRunner` 拡張 + ワーカー内 inspector セッション(`detailed: false`、research.md D1/D2)、リポジトリ相対パス正規化、module-init 除外、`hashes` 記録(FR-005)、ワーカー別 shard 追記(FR-002)
- [ ] T007 [P] [US1] `src/vitest/setup.ts`(`withTrace()` config ラッパー + globalSetup)を **Red→Green** で実装: ⑤事故パターン: 前回 run の旧 shard が残ったまま再実行 → globalSetup が削除し世代混入しない(古い世代の亡霊エッジ防止)、ラッパーがユーザーの既存 `test` 設定(reporters / setupFiles)を破壊しない(②組合せ)、既存スナップショットテストの作成・照合・更新挙動が runner 有効時も不変(FR-001 / G2)— `tests/vitest-setup.test.ts` + T005 の E2E fixture にスナップショットケースを追加

## Phase A-2: ingest + 名前表 + trace CLI (US2 レポート先行)

- [X] T008 [US1] **Red**: `tests/trace-ingest.test.ts` — REQ join と名前 join を固定: (a) describe 祖先継承・dedup が spec 006 の `extractReqTags` 規則と一致(⑦: `src/test-results.ts` の既存挙動を流用し二重実装しない)、(b) ②分岐組合せ: {passed, failed} × {タグあり, なし} × {シンボル解決可, 不可} の 8 通りで「green かつタグありかつ解決可」のみ symbol エッジ化(D6 / FR-006-007)、(c) ①境界: 排他 = **正確に 1 REQ**(FR-013)。REQ 数 = 1 → suggested、= 2 → silent(suggested にも infrastructure にも現れず、エッジは impact 到達に残る)、= `sharedThreshold`(既定 3)→ infrastructure 降格、(d) ⑥エッジ: 同名 export が同一ファイルに複数 / V8 合成名 (`<instance_members_initializer>`) / 無名 default → file 粒度フォールバックで REQ 到達は維持(fail-safe、SC-006)、クラス member 名 → クラス symbol へ集約、(e) ④例外: hits が消滅ファイルを指す(⑤: trace 取得後に `git rm`)→ dangling 診断、`include` 境界外ファイル → エッジ化しない、(f) N:M: 同一 REQ の複数テストの和集合(US1-4)
- [X] T009 [US1] `src/trace/ingest.ts` + 名前表ビルダを実装して T008 を **Green** に(`extractSymbols` 再利用、data-model.md §2-3)
- [ ] T010 [US2] **Red**: `tests/trace-cli.test.ts` — `artgraph trace status` / `trace report`: (a) 偽 `@impl REQ-003` を植えた fixture → `unexercisedClaims` に検出(SC-003 の Phase A 版)、排他実行+タグなし → `suggestedImpls`、共有ヘルパ → `infrastructure`(quickstart Phase A と同シナリオ)、(b) ④例外: shard ゼロ → exit 1 + runner 導入ガイダンス(FR-018 と同文言・対称)、(c) `--format json|text` 両出力(CLI 規約 Cat5)、(d) ⑤事故: stale shard(hashes 不一致)混在時に report が stale 件数を診断表示
- [ ] T011 [US2] `src/commands/trace.ts` を実装し CLI に配線して T010 を **Green** に(グラフ / lock は**読み取りのみ・非改変**が Phase A の契約)
- [ ] T012 ⑦回帰: 既存 full suite(`pnpm typecheck && pnpm test:unit && pnpm test:e2e && pnpm knip`)が **無変更で green** であることを確認 — Phase A は `scan`/`check`/`impact`/lock の出力に 1 byte も影響しないこと(SC-007 の Phase A 版)。knip で `src/vitest/` の隔離(CLI 本体からの import なし)を確認

---

## 🚧 Constitution Gate — 憲法 v1.2.0 改訂 PR のマージ確認(T013 以降の着手条件)

- [X] T013 改訂 PR(docs/constitution-v1-2-0)がマージ済みであることを確認し、`.specify/memory/constitution.md` が v1.2.0 であることを main から取り込む(rebase)。未マージなら Phase B に着手しない(plan.md Gate 裁定)— **PR #236 を 2026-07-10 に squash マージ、rebase 取り込み済み**

## Phase B: scan / lock / rename 統合 (US1 完成)

- [ ] T014 [US1] **Red**: `tests/trace-graph.test.ts` — グラフ合流を固定: (a) US1-1/2/4/5/6 の受け入れシナリオ(exercises エッジ・provenance `coverage`・交差なし・和集合・fail-safe・module-init 非エッジ化)、(b) ②分岐: 宣言一致対 → `implements.provenances` に `coverage` 追記+独立 `exercises` エッジなし / 証拠のみ対 → `exercises` エッジ(FR-008 の排他)、(c) ⑦回帰: trace 不在 → グラフ JSON が導入前と **byte-identical**(US1-3 / FR-010)、(d) 決定性: 同一入力 2 回 scan → byte-identical(US1-2 / SC-002)
- [ ] T015 [US1] `src/types.ts`(kind `exercises` + provenance `coverage` + `EDGE_PROVENANCE_VALUES`)と `src/graph/builder.ts`(trace 合流)を実装して T014 を **Green** に。⑦: spec 011 SC-008 の union↔Set 同期テストを `coverage` 込みで更新
- [ ] T016 [US1] **Red→Green**: `tests/lock.test.ts` 拡張 + `src/lock.ts` — `exercises?: string[]`(`impl` と同じ dedupe+sort 規約)、`entriesStructurallyEqual` への配列比較追加、reconcile 冪等性(2 回目で `lastReconciled` 不変)。①境界: exercises 空配列はフィールド省略。⑦回帰: exercises なし lock の round-trip が既存と byte-identical
- [ ] T017 [P] **Red→Green**: `tests/rename*.test.ts` 拡張 + rename 系 — trace shard 内 REQ ID の `--from/--to` / `--split` / `--merge` 書換え(FR-016)。③不正遷移: 未知 `schemaVersion` shard は書換え対象外として警告(旧世代 trace の扱い、Edge Case)。書換えサマリに trace が表示される
- [ ] T018 [P] [US1] `scan --serve` / `--output` の exercises エッジ視覚区別+凡例追加(FR-021、`src/serve/` 相当箇所。具体形は実装定義 — 破線を推奨)。E2E は HTML 内に凡例文字列が出ることの確認に留める(`tests/e2e/graph-serve.e2e.ts` 拡張)

## Phase C: check / impact / Skills (US2〜US6)

- [ ] T019 [US2][US4][US5] **Red**: `tests/check-evidence.test.ts` — 所見と充足の行列を固定: (a) ②分岐組合せ: {trace あり/なし} × {acceptExercises on/off} × {staleness warn/exclude/gate} × {--gate あり/なし} の判定行列(US2-1〜6 / US4-1〜3 / US5-1〜3 を包含)、(b) ③不正遷移: trace 生成 → シンボル編集 → stale 検出 → テスト再実行(世代置換)→ stale 解消(US5-4 のライフサイクル、data-model.md §9)、(c) ①境界: 排他(= 1 REQ)/ silent(2 〜 閾値−1)/ infrastructure(≥ `sharedThreshold`)の 3 区分で `suggestedImpls` / `exercised` 充足の出入り(SC-004 / FR-013 裁定)、(d) ④例外: trace なし時に所見 3 種が一切出ず、`check` 出力が導入前と **byte-identical**(US2-5 / FR-010 / G1 — 証拠の不在は反証ではない)、(e) ⑤事故: 全テスト fail の trace(CI 落ちのまま scan)→ エッジ・充足ゼロで uncovered が既定どおり残る
- [ ] T020 [US2][US4][US5] `src/coverage.ts` / `src/check.ts` を実装して T019 を **Green** に: 所見 3 種(data-model.md §7 の集合定義)、ステータス `exercised`(FR-014)、staleness 3 値(FR-015)、text 出力見出し(`UNEXERCISED CLAIM:` 等 — contracts/cli-surface.md §4)
- [ ] T021 [US3] **Red**: `tests/impact-evidence.test.ts` — (a) US3-1/2/3(--tests 列挙・静的/証拠の由来区別・trace なし exit 1)、(b) ⑥エッジ: stale エッジは `staleness: exclude` で不走査(FR-017)、(c) ⑦回帰: spec 019 の contains 方向制約テストが exercises 辺追加後も green(干渉なし — plan.md Cat7)、既存 `impact` の JSON スキーマが trace 不在時に不変
- [ ] T022 [US3] `src/graph/traverse.ts` + `src/commands/impact.ts`(`--tests`)を実装して T021 を **Green** に
- [ ] T023 [P] [US6] Skills 更新(FR-019/020): `templates/**` の bootstrap(テスト側タグ提案への転換+テスト不在領域の `@impl` フォールバック)/ verify / impact(所見 3 種の扱い分岐)。⑦: 5 agent path byte-identical 同期テスト(dogfood)green を維持。US6-1/2 は Skill 文書の記述レビューで確認(LLM 実行はテスト対象外 — 原則 V)
- [ ] T024 [P] ドキュメント追随: README(エッジ導出元の列挙に trace 追記 — 憲法 v1.2.0 と同期)/ docs/architecture.md §3(エッジ型に `exercises`)/ docs/commands.md(`trace` / `--tests`)/ docs/configuration.md(`trace.*`)/ docs/skills-guide.md

## Phase D: Polish — 性能・ドッグフーディング・最終ゲート

- [ ] T025 [P] perf テスト `tests/perf/trace-overhead.perf.test.ts`: 500 テスト級 fixture で runner 有効時のスイート実行時間増が **≤ 50%**(SC-005、PoC 実測 33% 基準)
- [ ] T026 quickstart.md の Phase A/B/C 手順を E2E で通し(SC-001: 3 手順でタグゼロ可視化)、artgraph 自身に runner を有効化して `trace report` を実行(dogfooding — 既存 `@impl` 23 ファイルの corroborated/unexercised 内訳を PR 本文に記載)。`artgraph check --diff` が green のまま(Stop hook 互換)
- [ ] T027 全 suite 最終確認: `pnpm typecheck && pnpm test:unit && pnpm test:e2e && pnpm test:perf && pnpm knip`。⑦: `git diff --stat` を精査し、plan 外ファイル(CHANGELOG / version / 無関係 spec)への変更が混入していないことを確認(release-please 管理物は不可侵)

---

## 7 観点カバレッジ行列(Red タスクへの割り当て検証)

| 観点 | 担当タスク |
| --- | --- |
| ①境界条件 | T002 (sharedThreshold 0/1/負), T003 (空 shard/hits 空), T008 (閾値ちょうど), T016 (空配列省略), T019 (閾値境界の出入り) |
| ②条件分岐の組み合わせ | T005 (pool×pass/fail×タグ), T007 (既存設定との合成), T008 (8 通り行列), T014 (宣言×証拠の排他), T019 (trace×acceptExercises×staleness×gate 行列) |
| ③不正な状態遷移 | T005 (concurrent → skipped), T017 (未知世代 shard の rename 拒否), T019 (fresh→stale→世代置換→解消) |
| ④例外系・失敗時挙動 | T002 (不正 config), T003 (未知 schemaVersion / JSONL 破損行), T005 (テスト throw), T008 (dangling), T010 (shard ゼロ exit 1), T019 (trace 不在で所見ゼロ) |
| ⑤実運用の事故パターン | T007 (旧世代 shard 残留), T008 (trace 後の git rm), T010 (stale 混在 report), T019 (全テスト fail のまま scan) |
| ⑥エッジケース | T003 (重複 dedup), T005 (module-init のみ/テストファイル自身), T008 (同名 export/合成名/無名 default/クラス member), T021 (stale exclude 不走査) |
| ⑦変更外ファイルへの影響(回帰) | T008 (spec 006 規則の流用), T012 (Phase A 完全無影響), T014 (trace 不在 byte-identical), T015 (SC-008 同期), T016 (lock round-trip), T021 (spec 019 無干渉/JSON スキーマ不変), T023 (5 path 同期), T027 (plan 外ファイル混入なし) |

## Dependencies (完了順)

```
T001, T002 (Setup, 並行可)
  └─> T003 → T004 (schema SSOT)
        ├─> T005 → T006 → T007          (A-1: runner)
        └─> T008 → T009 → T010 → T011   (A-2: ingest/CLI; T008 は T004 のみに依存し T005 系と並行可)
              └─> T012 (Phase A 回帰ゲート)
                    └─> 🚧 T013 (Constitution Gate)
                          └─> T014 → T015 → T016 → (T017, T018 並行可)   (B)
                                └─> T019 → T020 → T021 → T022 → (T023, T024 並行可)   (C)
                                      └─> (T025 並行可) → T026 → T027   (D)
```

## Parallel Execution Examples

- **Phase A**: T005-T007(runner 系)と T008-T009(ingest 系)は T004 完了後に**別エージェントで並行可能**(接点は `src/trace/schema.ts` の読み取りのみ)。T010-T011 は T009 に依存
- **Phase B**: T017(rename)と T018(serve)は T015-T016 完了後に並行可能
- **Phase C**: T023(Skills)と T024(docs)は T022 完了後に並行可能。T025(perf)は T022 以降いつでも

## Implementation Strategy

- **MVP = Phase A(T001-T012)**: グラフ・lock 非改変の「採取+突き合わせレポート」だけで `@impl` 監査価値が立ち、Constitution 改訂を待たずにリリース可能
- Red タスクは受け入れシナリオ番号(USn-m)と FR/SC 番号をテスト名 or コメントに刻み、`[REQ]` ならぬ traceability を spec 020 自身にも確保する(将来の dogfooding 対象)
- コミットは論理単位の日本語 conventional commits(Red / Green / 回帰 / docs を分ける)。CHANGELOG / version は release-please 管理につき不可侵(T027)
