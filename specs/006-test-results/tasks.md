# Tasks: テスト結果取り込み

Input: Design documents from `specs/006-test-results/`

Prerequisites: plan.md (required), spec.md (required)

Tests: TDD を推奨。テストタスクを実装タスクの前に配置し、RED-GREEN-REFACTOR で進める。

Organization: テスト結果パーサー → coverage 判定拡張 → CLI 統合 → 設定ファイル対応 → 複数ファイル統合の順で段階的に実装する。

## Format: `[ID] [P?] Description`

- [P]: Can run in parallel (different files, no dependencies)
- Include exact file paths in descriptions

---

## Phase 1: 型定義とテストフィクスチャの準備

Purpose: テスト結果関連の型定義を追加し、テスト用フィクスチャを作成する

- [x] T001 `src/types.ts` に以下の型を追加する:
  - `TestResultRecord`: `{ reqId: string; testName: string; passed: boolean }`
  - `TestResultMap`: `Map<string, TestResultRecord[]>`（key は REQ ID）
  - `SpectraceConfig.testResultPaths?: string[]`
- [x] T002 [P] `tests/fixtures/test-results/vitest-pass.json` を作成する。内容: `[REQ-001]` を含むテストが passed の Vitest JSON レポーター形式
- [x] T003 [P] `tests/fixtures/test-results/vitest-fail.json` を作成する。内容: `[REQ-001]` を含むテストが failed の Vitest JSON レポーター形式
- [x] T004 [P] `tests/fixtures/test-results/vitest-describe-inherit.json` を作成する。内容: describe ブロックに `[REQ-001]` があり、内部のテストケースに REQ タグがない形式
- [x] T005 [P] `tests/fixtures/test-results/vitest-multi-req.json` を作成する。内容: テスト名に `[REQ-001][REQ-002]` の複数 REQ タグがある形式
- [x] T006 [P] `tests/fixtures/test-results/vitest-skip.json` を作成する。内容: `[REQ-001]` を含むテストが skipped の Vitest JSON レポーター形式
- [x] T007 [P] `tests/fixtures/test-results/vitest-namespaced.json` を作成する。内容: `[001-auth/FR-001]` の名前空間修飾 REQ タグを含む形式
- [x] T008 [P] `tests/fixtures/test-results/junit-pass.xml` を作成する。内容: `[REQ-001]` を含む testcase が pass の JUnit XML
- [x] T009 [P] `tests/fixtures/test-results/junit-fail.xml` を作成する。内容: `[REQ-001]` を含む testcase が failure の JUnit XML
- [x] T010 [P] `tests/fixtures/test-results/junit-suite-inherit.xml` を作成する。内容: testsuite name に `[REQ-002]` があり、内部 testcase に REQ タグがない形式
- [x] T011 [P] `tests/fixtures/test-results/invalid-format.txt` を作成する。内容: JSON でも XML でもない不正なテキスト

Checkpoint: 型定義が追加され、11 個のフィクスチャファイルが `tests/fixtures/test-results/` に存在する。

---

## Phase 2: テスト結果パーサーのユニットテスト（RED）

Purpose: `src/test-results.ts` のコア関数をテスト駆動で定義する。この時点ではテストは全て FAIL する。

- [x] T012 `tests/test-results.test.ts` を新規作成し、`extractReqTags()` のテストを記述する:
  - `"[REQ-001] should do something"` → `["REQ-001"]`
  - `"[REQ-001][REQ-002] should do both"` → `["REQ-001", "REQ-002"]`
  - `"[001-auth/FR-001] auth test"` → `["001-auth/FR-001"]`
  - `"no tags here"` → `[]`
  - `"[REQ-001] and [REQ-001] duplicate"` → `["REQ-001"]`（重複除去）
- [x] T013 `tests/test-results.test.ts` に `parseVitestJson()` のテストを追加する:
  - `vitest-pass.json` → REQ-001 に対して passed: true のレコードが 1 件
  - `vitest-fail.json` → REQ-001 に対して passed: false のレコードが 1 件
  - `vitest-describe-inherit.json` → describe の REQ タグが子テストに継承され、レコードが生成される
  - `vitest-multi-req.json` → REQ-001 と REQ-002 の両方にレコードが生成される
  - `vitest-skip.json` → REQ-001 に対して passed: false のレコードが 1 件
  - `vitest-namespaced.json` → `001-auth/FR-001` の REQ ID でレコードが生成される
  - 不正な JSON 文字列 → 空配列を返す
- [x] T014 [P] `tests/test-results.test.ts` に `parseJUnitXml()` のテストを追加する:
  - `junit-pass.xml` → REQ-001 に対して passed: true のレコードが 1 件
  - `junit-fail.xml` → REQ-001 に対して passed: false のレコードが 1 件
  - `junit-suite-inherit.xml` → testsuite の REQ タグが子 testcase に継承される
  - 不正な XML 文字列 → 空配列を返す
- [x] T015 [P] `tests/test-results.test.ts` に `parseTestResults()` のテストを追加する:
  - JSON コンテンツ → `parseVitestJson()` が呼ばれる（先頭 `{` で判別）
  - XML コンテンツ → `parseJUnitXml()` が呼ばれる（先頭 `<` で判別）
  - 不正コンテンツ → 空配列を返す
- [x] T016 [P] `tests/test-results.test.ts` に `buildTestResultMap()` のテストを追加する:
  - `TestResultRecord[]` → `TestResultMap`（REQ ID でグルーピング）
  - 同一 REQ に複数テストがある場合、全てが配列に含まれる
  - 空配列 → 空の Map

Checkpoint: テストファイルが存在し、全テストが FAIL する（実装がないため）。

---

## Phase 3: テスト結果パーサー実装（GREEN）

Purpose: `src/test-results.ts` を新規作成し、Phase 2 のテストを通す。

- [x] T017 `src/test-results.ts` を新規作成し、以下の関数をエクスポートする:
  - `extractReqTags(text: string): string[]` — `[REQ-xxxx]` または `[namespace/REQ-xxxx]` パターンを抽出。重複除去して返す
  - `parseVitestJson(content: string): TestResultRecord[]` — Vitest JSON レポーター形式をパース。`testResults[].assertionResults[]` を走査し、`ancestorTitles` と `title` から REQ タグを抽出。`ancestorTitles` の REQ タグは子テストに継承。status が `"passed"` なら `passed: true`、それ以外は `false`
  - `parseJUnitXml(content: string): TestResultRecord[]` — JUnit XML を正規表現でパース。`<testsuite name="...">` と `<testcase name="...">` から REQ タグを抽出。testsuite の REQ タグは子 testcase に継承。`<failure>` / `<error>` / `<skipped>` 子要素がなければ `passed: true`
  - `parseTestResults(content: string): TestResultRecord[]` — 先頭文字で JSON/XML を判別し、適切なパーサーを呼び出す
  - `buildTestResultMap(records: TestResultRecord[]): TestResultMap` — レコード配列を REQ ID でグルーピングした Map に変換
- [x] T018 Phase 2 のテスト（T012-T016）が全て PASS することを確認する（`pnpm test tests/test-results.test.ts`）

Checkpoint: `src/test-results.ts` のコア関数が実装され、ユニットテストが全て PASS する。

---

## Phase 4: coverage 判定のテスト結果対応（RED → GREEN）

Purpose: `computeCoverage()` にテスト結果を反映するロジックを追加する。

- [x] T019 `tests/coverage.test.ts` を新規作成し、以下のテストを記述する:
  - `verifies` エッジあり + テスト結果なし（従来動作）→ `verified`
  - `verifies` エッジあり + 全テスト pass → `verified`
  - `verifies` エッジあり + 1 件 fail → `impl-only`
  - `verifies` エッジあり + テスト結果 Map にエントリなし → `impl-only`
  - `verifies` エッジなし + テスト結果あり → `impl-only`（エッジがないので verified にならない）
  - `implements` エッジなし → `untagged`（テスト結果の有無に関わらず）
  - `testResults` 引数が undefined → 従来動作を維持（後方互換）
- [x] T020 `src/coverage.ts` の `computeCoverage()` を拡張する:
  - 第 2 引数に `testResults?: TestResultMap` を追加
  - `testResults` が undefined の場合: 従来のロジック（`verifies` エッジの有無のみ）
  - `testResults` が渡された場合: `verifies` エッジが存在し、かつ `testResults.get(reqId)` の全レコードが `passed: true` の場合のみ `verified`。テスト結果が Map に存在しない、または 1 件でも `passed: false` なら `impl-only`
- [x] T021 T019 のテストが全て PASS することを確認する

Checkpoint: `computeCoverage()` がテスト結果を反映した判定を行い、後方互換を維持する。

---

## Phase 5: ファイル読み込みと統合のテスト（RED → GREEN）

Purpose: テスト結果ファイルの読み込み・統合・複数ファイル対応を実装する。

- [x] T022 `tests/test-results.test.ts` に `loadTestResults()` のテストを追加する:
  - 単一 Vitest JSON ファイルパス → テスト結果が読み込まれる
  - 単一 JUnit XML ファイルパス → テスト結果が読み込まれる
  - 存在しないパス → 空の Map を返す（エラーにならない）
  - 不正フォーマットのファイル → 空の Map を返す（警告は stderr に出力）
- [x] T023 `tests/test-results.test.ts` に複数ファイル統合のテストを追加する:
  - 2 つのファイルに異なる REQ のテスト結果 → 両方の REQ が Map に含まれる
  - 2 つのファイルに同一 REQ のテスト結果（一方 pass、他方 fail）→ 両レコードが配列に含まれる（1 件でも fail なら coverage は impl-only）
  - Vitest JSON と JUnit XML の混在 → 両方がパースされて統合される
- [x] T024 `src/test-results.ts` に `loadTestResults()` を追加する:
  - `loadTestResults(paths: string[], rootDir: string): TestResultMap` — 各パスを rootDir からの相対パスとして解決し、ファイルを読み込み、`parseTestResults()` でパース、`buildTestResultMap()` で Map に統合。存在しないファイルはスキップ。不正フォーマットは stderr に警告を出力してスキップ
- [x] T025 T022, T023 のテストが全て PASS することを確認する

Checkpoint: テスト結果ファイルの読み込みと複数ファイル統合が動作する。

---

## Phase 6: CLI 統合（check, coverage, scan）

Purpose: 各コマンドに `--test-results` オプションを追加し、E2E テストを通す。

- [x] T026 `src/config.ts` の `loadConfig()` を変更し、`testResultPaths` フィールドを読み込む
- [x] T027 `src/check.ts` の `check()` にオプショナルな `testResults?: TestResultMap` 引数を追加し、`computeCoverage(graph, testResults)` に渡す
- [x] T028 `src/cli.ts` の `check` コマンドに `--test-results <paths...>` オプションを追加する:
  - オプション指定時: パスからテスト結果を読み込み、`check()` に渡す
  - オプション未指定 + `config.testResultPaths` あり: 設定ファイルのパスを使用
  - いずれも未指定: 従来動作（テスト結果なし）
  - CLI オプションは設定ファイルを上書きする
- [x] T029 [P] `src/cli.ts` の `coverage` コマンドに `--test-results <paths...>` オプションを追加する:
  - `computeCoverage(graph, testResults)` にテスト結果を渡す
  - テスト結果読み込みロジックは check と同一パターン
- [x] T030 [P] `src/cli.ts` の `scan` コマンドに `--test-results <paths...>` オプションを追加する:
  - テスト結果の統計情報（テスト結果ファイル数、マッチした REQ 数、pass/fail 数）をスキャン出力に含める
- [x] T031 `tests/cli.test.ts` に以下の CLI 統合テストを追加する:
  - `spectrace check --test-results vitest-pass.json` → exit 0、coverage に `verified` が含まれる
  - `spectrace check --test-results vitest-fail.json` → coverage に `impl-only` が含まれる
  - `spectrace check` (テスト結果なし) → 従来と同一の結果
  - `spectrace coverage --test-results vitest-pass.json` → `verified` 表示
  - `spectrace coverage --test-results vitest-fail.json` → `impl-only` 表示
  - `spectrace coverage` (テスト結果なし) → 従来と同一の結果
- [x] T032 全テスト PASS、`pnpm build` 成功を確認する

Checkpoint: 全コマンドで `--test-results` オプションが動作し、CLI 統合テストが PASS する。

---

## Phase 7: 設定ファイル対応と glob パターン

Purpose: `.spectrace.json` の `testResultPaths` フィールドによるテスト結果パス指定を実装する。

- [x] T033 `tests/cli.test.ts` に設定ファイルベースのテストを追加する:
  - `.spectrace.json` に `testResultPaths: ["fixtures/test-results/*.json"]` を設定 → テスト結果が自動的に読み込まれる
  - `.spectrace.json` の `testResultPaths` と `--test-results` オプションが両方指定 → CLI オプションが優先される
  - `testResultPaths` で指定されたパスにファイルがない → エラーにならず従来動作
- [x] T034 `src/test-results.ts` の `loadTestResults()` を拡張し、glob パターンをサポートする:
  - glob パターン（`*`, `**`）を展開してファイルパスリストに変換
  - 既存の `glob` パッケージ（依存済み）を使用
- [x] T035 T033 のテストが全て PASS することを確認する

Checkpoint: 設定ファイルからのテスト結果パス指定と glob パターンが動作する。

---

## Phase 8: 最終検証

Purpose: 全体の品質確認と手動検証

- [x] T036 全テスト（`pnpm test`）がパスし、ビルド（`pnpm build`）が成功することを確認する
- [x] T037 以下のシナリオを手動で検証する:
  - `spectrace check --test-results` で Vitest JSON のテスト結果が正しく反映される
  - `spectrace check --test-results` で JUnit XML のテスト結果が正しく反映される
  - `spectrace coverage --test-results` で check と同一の判定結果が得られる
  - `--test-results` なしで従来と同一の挙動
  - 存在しないファイルパスを指定してもエラーにならない

Checkpoint: 全テスト PASS、ビルド成功、手動検証完了。

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (型定義・フィクスチャ): No dependencies — can start immediately
- Phase 2 (パーサーテスト RED): Depends on Phase 1
- Phase 3 (パーサー実装 GREEN): Depends on Phase 2
- Phase 4 (coverage 判定): Depends on Phase 1（型定義のみ依存）。Phase 2/3 と並列可能
- Phase 5 (ファイル読み込み): Depends on Phase 3
- Phase 6 (CLI 統合): Depends on Phase 3, Phase 4, Phase 5
- Phase 7 (設定ファイル): Depends on Phase 6
- Phase 8 (最終検証): Depends on Phase 7

### Parallel Opportunities

- T002-T011 can run in parallel (independent fixture files)
- T013, T014, T015, T016 can run in parallel (independent test describe blocks)
- Phase 4 can run in parallel with Phase 2/3 (coverage テストはパーサーテストと独立)
- T028, T029, T030 は異なるコマンドへの変更だが、同一ファイル (cli.ts) を変更するため順次実行

### Within Each Phase

- Tests MUST be written and FAIL before implementation (TDD)
- テスト（RED） → 実装（GREEN） → リファクタリング（REFACTOR）の順序

---

## Implementation Strategy

### MVP First

1. Phase 1-3: テスト結果パーサーの TDD 実装（extractReqTags, parseVitestJson, parseJUnitXml, parseTestResults, buildTestResultMap）
2. Phase 4: coverage 判定の拡張（computeCoverage へのテスト結果反映）
3. STOP and VALIDATE: ユニットテストで coverage 判定が正しく動作することを確認
4. Phase 5: ファイル読み込みと複数ファイル統合
5. Phase 6: CLI 統合（check, coverage, scan コマンドへの --test-results 追加）
6. STOP and VALIDATE: `spectrace check --test-results` で手動検証
7. Phase 7-8: 設定ファイル対応と最終検証

### Key Design Decisions

- テスト結果パーサーを `src/test-results.ts` に集約し、グラフ構築パーサー (`src/parsers/`) とは分離
- `computeCoverage()` の第 2 引数はオプショナルにし、下位互換を完全に維持
- JUnit XML は正規表現ベースでパース（外部依存の追加を回避）
- フォーマット自動判別はファイル拡張子ではなく内容ベース（FR-007）
- 複数ファイルの統合時、同一 REQ に対して 1 件でも fail があれば `impl-only`（FR-008）
- CLI オプションは設定ファイルの `testResultPaths` を上書きする（US5-2）

---

## Notes

- [P] tasks = different files, no dependencies
- 新規ファイルは `src/test-results.ts` と `tests/test-results.test.ts`、`tests/coverage.test.ts` の 3 つ
- 既存コード変更: `src/types.ts`, `src/coverage.ts`, `src/check.ts`, `src/config.ts`, `src/cli.ts`
- 外部依存の追加なし（JUnit XML は正規表現、glob は既存依存）
- テスト結果ファイルはグラフ構築とは独立したフェーズで読み込む（scan の後、check/coverage の前）

---

## Phase 9: PR #30 レビュー対応 (敵対的レビュー指摘)

- [x] R001 REQ タグ正規表現を `src/req-id.ts` の `REQ_ID_TOKEN` に共有化し、`src/parsers/typescript.ts` と `src/test-results.ts` で統一（`Requirement-N`・`Auth-1` の取りこぼし解消）
- [x] R002 `parseVitestJson` の `ancestorTitles`/`title` 欠落ガード、`extractReqTags` の非文字列ガード
- [x] R003 `loadConfig` で `testResultPaths` の配列・要素型を検証（`[123]` 等で明確なエラー）
- [x] R004 `loadTestResults`: `globSync` の try/catch、glob 0 件マッチ警告、破損 JSON と「結果なし」を区別する警告
- [x] R005 JUnit XML パーサー強化: `name` 属性をオプショナル化（属性順非依存）、`<error>`/`<skipped>` 対応
- [x] R006 `computeCoverage` の O(REQ × edges) を target インデックス化で O(edges + reqs) に
- [x] R007 `check --gate` がテスト失敗を gate 判定に反映（FR-012/SC-007、`CheckResult.testFailures`）
- [x] R008 CLI 統合テストの ID 一致化と verified→impl-only 遷移・gate exit 2 の断定
- [x] R009 `src/cli.ts` の testResultPaths 取得ロジックを `resolveTestResults` ヘルパーに集約
