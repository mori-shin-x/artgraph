# Tasks: PreToolUse Hook (hook-pretool サブコマンド)

Input: Design documents from `specs/007-pretool-hook/`

Prerequisites: plan.md (required), spec.md (required), research.md, data-model.md, contracts/hook-pretool.md

Tests: TDD を推奨。テストタスクを実装タスクの前に配置し、RED-GREEN-REFACTOR で進める。

Organization: 単一の User Story に近い構成だが、stdin パース・impact 実行・出力生成・エラーハンドリングを段階的に実装する。

## Format: `[ID] [P?] Description`

- [P]: Can run in parallel (different files, no dependencies)
- Include exact file paths in descriptions

---

## Phase 1: テストフィクスチャの準備

Purpose: hook-pretool のテスト用 JSON フィクスチャを作成する

- [ ] T001 [P] `tests/fixtures/hooks/edit-input.json` を作成する。内容: `{"tool_name":"Edit","tool_input":{"file_path":"src/auth.ts","old_string":"const x = 1;","new_string":"const x = 2;"}}`
- [ ] T002 [P] `tests/fixtures/hooks/write-input.json` を作成する。内容: `{"tool_name":"Write","tool_input":{"file_path":"src/new-file.ts","content":"export function hello() {}"}}`
- [ ] T003 [P] `tests/fixtures/hooks/multiedit-input.json` を作成する。内容: `{"tool_name":"MultiEdit","tool_input":{"file_path":"src/auth.ts","edits":[{"old_string":"x","new_string":"y"},{"old_string":"a","new_string":"b"}]}}`

Checkpoint: 3 つのフィクスチャ JSON ファイルが `tests/fixtures/hooks/` に存在する。

---

## Phase 2: hook-pretool ユニットテスト（RED）

Purpose: `src/hook-pretool.ts` のコア関数をテスト駆動で定義する。この時点ではテストは全て FAIL する。

- [ ] T004 `tests/hook-pretool.test.ts` を新規作成し、stdin JSON パーステストを記述する:
  - Edit の hook JSON 文字列を `parseHookInput()` に渡すと `HookInput` オブジェクトが返ること
  - Write の hook JSON 文字列を `parseHookInput()` に渡すと `HookInput` オブジェクトが返ること
  - MultiEdit の hook JSON 文字列を `parseHookInput()` に渡すと `HookInput` オブジェクトが返ること
  - 不正な JSON 文字列を渡すと null が返ること
  - 空文字列を渡すと null が返ること
- [ ] T005 [P] `tests/hook-pretool.test.ts` に `extractFilePaths()` のテストを追加する:
  - Edit の HookInput から `["src/auth.ts"]` が返ること
  - Write の HookInput から `["src/new-file.ts"]` が返ること
  - MultiEdit の HookInput から `["src/auth.ts"]` が返ること
  - `tool_input` に `file_path` がない場合、空配列が返ること
- [ ] T006 [P] `tests/hook-pretool.test.ts` に `toRelativePath()` のテストを追加する:
  - 絶対パス `/home/user/project/src/auth.ts` と rootDir `/home/user/project` で `src/auth.ts` が返ること
  - 相対パス `src/auth.ts` はそのまま返ること
- [ ] T007 [P] `tests/hook-pretool.test.ts` に `formatAdditionalContext()` のテストを追加する:
  - `affectedReqs: ["FR-001"]`, `affectedDocs: ["doc:api-design"]` → `"spectrace impact: FR-001 (req), doc:api-design (doc)"` が返ること
  - `affectedReqs: ["FR-001", "SC-001"]`, `affectedDocs: []` → `"spectrace impact: FR-001 (req), SC-001 (req)"` が返ること
  - `affectedReqs: []`, `affectedDocs: []` → `"spectrace impact: (none)"` が返ること
- [ ] T008 [P] `tests/hook-pretool.test.ts` に `buildHookOutput()` のテストを追加する:
  - additionalContext 文字列を渡すと `{ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "..." } }` が返ること
  - 空文字列を渡すと `additionalContext` が空文字列の HookOutput が返ること

Checkpoint: テストファイルが存在し、全テストが FAIL する（実装がないため）。テスト設計が contracts/hook-pretool.md と一致していること。

---

## Phase 3: hook-pretool コアロジック実装（GREEN）

Purpose: `src/hook-pretool.ts` を新規作成し、Phase 2 のテストを通す。

- [ ] T009 `src/hook-pretool.ts` を新規作成し、型定義を追加する:
  - `HookInput`: `{ tool_name: string; tool_input: { file_path?: string; edits?: Array<{ file_path?: string }>; [key: string]: unknown } }`
  - `HookOutput`: `{ hookSpecificOutput: { hookEventName: "PreToolUse"; additionalContext: string } }`
- [ ] T010 `src/hook-pretool.ts` に以下の関数をエクスポートする:
  - `parseHookInput(json: string): HookInput | null` — JSON.parse で HookInput に変換。パース失敗時は null を返す
  - `extractFilePaths(input: HookInput): string[]` — `tool_input.file_path` を取得して配列で返す。存在しない場合は空配列
  - `toRelativePath(filePath: string, rootDir: string): string` — `path.isAbsolute()` で判定し、絶対パスなら `path.relative(rootDir, filePath)` で変換。相対パスはそのまま返す
  - `formatAdditionalContext(result: ImpactResult): string` — affectedReqs を `ID (req)` 形式、affectedDocs を `ID (doc)` 形式でカンマ区切りに結合。reqs を先、docs を後に配置。両方空なら `"spectrace impact: (none)"` を返す
  - `buildHookOutput(additionalContext: string): HookOutput` — hookSpecificOutput JSON オブジェクトを生成して返す
- [ ] T011 Phase 2 のテスト（T004-T008）が全て PASS することを確認する（`pnpm test tests/hook-pretool.test.ts`）

Checkpoint: `src/hook-pretool.ts` のコア関数が実装され、ユニットテストが全て PASS する。

---

## Phase 4: CLI 統合テスト（RED）

Purpose: `spectrace hook-pretool` サブコマンドの E2E テストを先に書く。

- [ ] T012 `tests/cli.test.ts` に `CLI: hook-pretool` describe ブロックを追加し、以下のテストケースを記述する（stdin 経由で hook JSON を渡す CLI テスト）:
  - Edit の hook JSON を stdin に渡して `node dist/cli.js hook-pretool` を実行し、stdout が有効な hookSpecificOutput JSON であること、exit code が 0 であること
  - Write の hook JSON を stdin に渡して実行し、stdout が有効な hookSpecificOutput JSON であること、exit code が 0 であること
  - MultiEdit の hook JSON を stdin に渡して実行し、stdout が有効な hookSpecificOutput JSON であること、exit code が 0 であること
- [ ] T013 `tests/cli.test.ts` に graceful degradation テストを追加する:
  - `.spectrace.json` が存在しないディレクトリ（例: `/tmp`）で実行した場合、exit 0 で additionalContext が空文字列であること
  - 不正な JSON を stdin に渡した場合、exit 0 で additionalContext が空文字列であること
  - `tool_input` に `file_path` が存在しない hook JSON を渡した場合、exit 0 で additionalContext が空文字列であること

Checkpoint: CLI テストが存在し、サブコマンド未実装のため FAIL する。

---

## Phase 5: CLI サブコマンド登録と結合（GREEN）

Purpose: `src/cli.ts` に `hook-pretool` サブコマンドを追加し、E2E テストを通す。

- [ ] T014 `src/cli.ts` の import 文に `parseHookInput`, `extractFilePaths`, `toRelativePath`, `formatAdditionalContext`, `buildHookOutput` を `"./hook-pretool.js"` から追加する
- [ ] T015 `src/cli.ts` に `hook-pretool` サブコマンドを追加する。commander の `.command("hook-pretool")` で登録し、以下のフローを action 内に実装する:
  1. `process.hrtime.bigint()` で開始時刻を記録
  2. stdin を全て読み取る（`process.stdin` から Buffer を蓄積して文字列化）
  3. `parseHookInput(stdinText)` で JSON パース。null の場合は stderr に `spectrace: failed to parse hook input` を出力し、空 additionalContext の hookSpecificOutput を stdout に出力して exit 0
  4. `extractFilePaths(input)` で file_path を抽出。空配列の場合は空 additionalContext の hookSpecificOutput を stdout に出力して exit 0
  5. `toRelativePath(filePath, rootDir)` で各パスを相対パスに変換
  6. `loadConfig(rootDir)` で設定読み込み
  7. `scan(rootDir, config)` でグラフ構築（try-catch で囲み、失敗時は stderr に出力して空 additionalContext で exit 0）
  8. `resolveStartIds(graph, filePaths)` で開始ノード ID を解決。空なら `"spectrace impact: (none)"` の additionalContext で exit 0
  9. `readLock(rootDir, config.lockFile)` でロックファイル読み取り
  10. `impact(graph, startIds, lock)` で影響範囲計算
  11. `formatAdditionalContext(result)` で additionalContext 生成
  12. `buildHookOutput(additionalContext)` で HookOutput を生成し、`JSON.stringify()` で stdout に出力
  13. stderr に `spectrace: hook-pretool completed in Xms` を出力（経過時間を計算）
  14. 全体を try-catch で囲み、予期しないエラー時は stderr に出力して空 additionalContext で exit 0
- [ ] T016 `pnpm build` が成功し、Phase 4 のテスト（T012-T013）が全て PASS することを確認する

Checkpoint: `spectrace hook-pretool` サブコマンドが動作し、E2E テストが PASS する。

---

## Phase 6: エラーハンドリング強化

Purpose: contracts/hook-pretool.md のエラーハンドリング表に記載された全ケースの網羅テスト

- [ ] T017 `tests/hook-pretool.test.ts` にエラーケースのテストを追加する:
  - `tool_input` 自体が存在しない JSON（`{"tool_name":"Edit"}`）の場合、`extractFilePaths()` が空配列を返すこと
  - `tool_name` が Edit/Write/MultiEdit 以外（例: `"Read"`）の場合でも、`file_path` があれば正常に抽出されること
- [ ] T018 T017 のテストが全て PASS することを確認する。必要に応じて `src/hook-pretool.ts` の防御的処理を強化する

Checkpoint: 全エラーケースがテストでカバーされ、全テストが PASS する。

---

## Phase 7: 最終検証

Purpose: 全体の品質確認と手動検証

- [ ] T019 `specs/007-pretool-hook/quickstart.md` の検証シナリオ 1-5 を手動で実行し、全て期待通りに動作することを確認する
- [ ] T020 全テスト（`pnpm test`）がパスし、ビルド（`pnpm build`）が成功することを確認する

Checkpoint: 全テスト PASS、ビルド成功、手動検証完了。

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (フィクスチャ): No dependencies — can start immediately
- Phase 2 (ユニットテスト RED): Depends on Phase 1
- Phase 3 (コアロジック GREEN): Depends on Phase 2
- Phase 4 (CLI テスト RED): Depends on Phase 3（コア関数が存在する必要がある）
- Phase 5 (CLI 結合 GREEN): Depends on Phase 4
- Phase 6 (エラーハンドリング): Depends on Phase 3。Phase 4/5 と並列可能
- Phase 7 (最終検証): Depends on Phase 5 and Phase 6

### Parallel Opportunities

- T001, T002, T003 can run in parallel (independent fixture files)
- T005, T006, T007, T008 can run in parallel (independent test describe blocks)
- Phase 6 can run in parallel with Phase 4/5 (ユニットテストと CLI 統合テストは独立)

### Within Each Phase

- Tests MUST be written and FAIL before implementation (TDD)
- テスト（RED） → 実装（GREEN） → リファクタリング（REFACTOR）の順序

---

## Implementation Strategy

### MVP First

1. Phase 1-3: コア関数の TDD 実装（parseHookInput, extractFilePaths, toRelativePath, formatAdditionalContext, buildHookOutput）
2. Phase 4-5: CLI サブコマンド統合
3. STOP and VALIDATE: `echo '...' | node dist/cli.js hook-pretool` で手動検証
4. Phase 6-7: エラーハンドリング強化と最終検証

### Key Design Decisions

- 全ロジックを `src/hook-pretool.ts` に集約し、`src/cli.ts` はサブコマンド登録と stdin 読み取りのみ
- 全エラーケースで exit 0 を返し、Claude Code のワークフローをブロックしない
- `loadConfig()` は `.spectrace.json` がなくてもデフォルト設定を返すが、spec ディレクトリが実際に存在しない場合は空 additionalContext で早期終了する
- additionalContext は `spectrace impact: FR-001 (req), doc:api-design (doc)` 形式。file ノードは含めない
- stderr に実行時間を出力（デバッグ用）

---

## Notes

- [P] tasks = different files, no dependencies
- 新規ファイルは `src/hook-pretool.ts` と `tests/hook-pretool.test.ts` の 2 つ
- 既存コード（`src/graph/traverse.ts`, `src/scan.ts`, `src/config.ts`, `src/lock.ts`）の変更は不要。API をそのまま呼び出す
- v1 では常に exit 0。permissionDecision は返さない（defer 動作）
- キャッシュやタイムアウトは v1 のスコープ外
