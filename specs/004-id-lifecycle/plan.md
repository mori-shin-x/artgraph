# Implementation Plan: rename / split / merge（ID ライフサイクル管理）

Branch: `004-id-lifecycle` | Date: 2026-06-22 | Spec: [spec.md](./spec.md)

Input: Feature specification from `specs/004-id-lifecycle/spec.md`

## Summary

`spectrace rename` サブコマンドを新規に追加し、仕様 ID のリネーム・分割・統合を
プロジェクト全体で一括実行する。対象は 5 種類の参照パターン（spec リスト項目/見出し、
`@impl` タグ、テスト `[ID]` タグ、frontmatter `depends_on`、`.trace.lock` キー）に限定し、
無関係なテキストは書き換えない。

書き換え対象は git 追跡ファイルに限定し、`--dry-run` で変更一覧の事前確認が可能。
`doc:xxx` 形式や名前空間修飾付き ID（`001-auth/FR-001`）にも対応する。

3 つの操作モード:
- **rename** (`--from <old> --to <new>`) — P1: 全参照を一括置換
- **split** (`--split <old> --into <new1> <new2> [...]`) — P2: 仕様分割 + impl 警告
- **merge** (`--merge <id1> <id2> --into <new>`) — P2: 参照統合 + lock 合算

## Technical Context

Language/Version: TypeScript 5.x（Node.js ランタイム）

Primary Dependencies: commander, ts-morph, remark (unified), glob, gray-matter

Storage: `.trace.lock`（JSON ファイル）、`.spectrace.json`（設定ファイル）

Testing: Vitest

Target Platform: Node.js CLI（npm 配布）

Project Type: CLI ツール / ライブラリ

Constraints: 書き換え中の失敗時は `git checkout` で復元する想定（ロールバック機構不要）。
全バリデーションを書き換え前に完了させる fail-fast 設計とする。

## Constitution Check

GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Integrity | Pass | 全処理は決定的。正規表現ベースのパターンマッチ + 文字列置換。LLM 不使用 |
| II. Declarative Links — SDD ツール ID 直接使用 | Pass | 仕様 ID（REQ-xxx, doc:xxx）をそのまま操作対象とする |
| III. JS/TS Native | Pass | Node.js CLI として実装。既存の ts-morph + remark を継続使用 |
| IV. CLI-First Interface | Pass | `spectrace rename` サブコマンドとして公開。`--dry-run`, `--format` オプション |
| V. Incremental Adoption | Pass | rename は既存コマンド群と独立。他コマンドへの影響なし |

## Project Structure

### Documentation (this feature)

```text
specs/004-id-lifecycle/
├── spec.md
├── plan.md              # This file
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
src/
├── cli.ts               # 変更: rename サブコマンド追加
├── rename.ts            # 新規: rename/split/merge のコアロジック
│                        #   rewriter（5 種類のパターン書き換え）
│                        #   lock-updater（lock キー操作）
│                        #   executor（オーケストレーション）
├── diff.ts              # 変更: getGitTrackedFiles() 追加
├── config.ts            # 変更なし
├── scan.ts              # 変更なし（ID 存在チェックに graph を利用）
├── graph/
│   ├── builder.ts       # 変更なし
│   └── traverse.ts      # 変更なし
├── parsers/
│   ├── markdown.ts      # 変更なし（正規表現パターンを参照）
│   └── typescript.ts    # 変更なし（正規表現パターンを参照）
├── types.ts             # 変更なし
├── lock.ts              # 変更なし（readLock/writeLock を利用）
├── check.ts             # 変更なし
├── coverage.ts          # 変更なし
├── init.ts              # 変更なし
└── hook-pretool.ts      # 変更なし

tests/
├── rename.test.ts       # 新規: rewriter + lock-updater のユニットテスト
├── rename-cli.test.ts   # 新規: CLI 統合テスト
└── fixtures/
    └── rename/          # 新規: rename テスト用フィクスチャ
        ├── .spectrace.json
        ├── .trace.lock
        ├── specs/
        │   └── feature.md
        ├── src/
        │   └── feature.ts
        ├── tests/
        │   └── feature.test.ts
        └── tsconfig.json
```

Structure Decision: コアロジックは `src/rename.ts` に集約する。
モジュールを `src/rename/` ディレクトリに分割する選択肢もあるが、
既存コードベース（`src/lock.ts`, `src/check.ts` 等）が単一ファイルの慣習なので合わせる。
ファイルが肥大化した場合のみ分割を検討する。

## Design Decisions

### D1: rewriter は純粋関数として設計

ファイル I/O は executor レイヤーに限定し、rewriter は入力文字列に対して書き換え後の
文字列と変更一覧を返す純粋関数とする。fixture なしの文字列ベースユニットテストが可能。

### D2: 既存パーサーの正規表現と同等パターンを使用

`markdown.ts` の `LIST_ITEM_RE`, `KIRO_HEADING_RE` および `typescript.ts` の
`IMPL_RE`, `TEST_REQ_RE`, `TEST_ANNOTATION_RE` と同等の正規表現を rewriter で使い、
マッチ箇所内で対象 ID を文字列置換する。FR-007（無関係テキスト非書き換え）を満たす。

### D3: frontmatter は行レベル文字列置換

gray-matter で YAML パース → 値置換 → 再シリアライズする方法はフォーマット崩れリスクがある。
行レベルの文字列置換（`node_id:` 行, `id:` 行の中の対象 ID のみ置換）の方が差分が小さく安全。

### D4: symbol: ノードには触れない

lock に存在する `symbol:src/path#name` キーは rename 対象外。
コード内の `@impl` タグを書き換えれば、次回 scan 時に正しい implements エッジが再構築される。

### D5: commander.js のオプション設計

`--from/--to` と `--split/--into` と `--merge/--into` は排他的。
action 内で引数の組み合わせを判定して適切な処理を呼び出す。
`--into` は variadic option（`.option("--into <ids...>")`）、
`--merge` も variadic（`.option("--merge <ids...>")`）として定義する。

## Task Breakdown

### Phase 1: P1 rename 実装

#### Task 1-1: rewriter — 5 種類のパターン書き換えエンジン

`src/rename.ts` に以下の関数を実装:

- `rewriteSpecListItem(content, oldId, newId)` — `- REQ-001:` / `- **REQ-001**:` パターン
- `rewriteSpecHeading(content, oldId, newId)` — `### Requirement N:` パターン
- `rewriteImplTags(content, oldId, newId)` — `// @impl REQ-001` パターン
- `rewriteTestTags(content, oldId, newId)` — `[REQ-001]` パターン + `req: "REQ-001"` アノテーション
- `rewriteFrontmatter(content, oldId, newId)` — frontmatter `depends_on` 内 ID / `node_id` の `doc:xxx`
- `rewriteFile(filePath, content, oldId, newId)` — 拡張子に応じて上記を組み合わせる統合関数

各関数は `{ content: string; changes: RewriteChange[] }` を返す純粋関数。

見積り: 大 | 依存: なし

#### Task 1-2: lock-updater — lock キー操作

`src/rename.ts` に以下の関数を実装:

- `renameLockKey(lock, oldId, newId)` — キー付け替え + dependsOn 内参照更新
- `splitLockKey(lock, oldId, newIds)` — 旧キー削除、新キーに空エントリ追加
- `mergeLockKeys(lock, sourceIds, newId)` — impl/tests 合算して統合

見積り: 中 | 依存: なし

#### Task 1-3: executor — rename オーケストレーション

`src/rename.ts` に `executeRename(options)` を実装:

1. `loadConfig` → `scan` → graph から既存 ID 一覧取得
2. バリデーション（from の存在確認、to の重複チェック）
3. `git ls-files` で git 追跡ファイル一覧取得（`src/diff.ts` に `getGitTrackedFiles()` 追加）
4. 対象ファイルに `rewriteFile()` 適用、変更一覧収集
5. `readLock` → `renameLockKey()` で lock 更新
6. dry-run でなければ `writeFileSync` + `writeLock` で実書き換え

見積り: 大 | 依存: Task 1-1, 1-2

#### Task 1-4: CLI — rename サブコマンド登録

`src/cli.ts` に `spectrace rename --from <old> --to <new> [--dry-run] [--format json|text]` を追加。
text 出力はファイルパス:行番号と変更前後を表示。

見積り: 中 | 依存: Task 1-3

#### Task 1-5: テスト fixture 作成

`tests/fixtures/rename/` に spec.md（REQ-001, REQ-002, frontmatter depends_on）、
feature.ts（`@impl REQ-001`）、feature.test.ts（`[REQ-001]`）、.trace.lock、tsconfig.json を配置。

見積り: 小 | 依存: なし

#### Task 1-6: ユニットテスト

`tests/rename.test.ts` — rewriter の各パターン書き換え、lock-updater、executor のバリデーション。
spec の Acceptance Scenarios 1-8 および Edge Cases をカバー。

見積り: 大 | 依存: Task 1-3, 1-5

#### Task 1-7: CLI 統合テスト

`tests/rename-cli.test.ts` — 一時ディレクトリに fixture コピー → CLI 実行 → ファイル内容検証。
dry-run、json 出力、エラーケースを含む。

見積り: 中 | 依存: Task 1-4, 1-5

### Phase 2: P2 split / merge 実装

#### Task 2-1: split ロジック

`executeSplit(options)` を実装。spec から旧 ID 行削除 + 新 ID 雛形追記、
`@impl` ファイルへの手動振り分け警告、lock 更新。

見積り: 中 | 依存: Phase 1

#### Task 2-2: merge ロジック

`executeMerge(options)` を実装。全参照を rewriter で一括置換（rename と同じ）、
spec 行削除 + 新 ID 雛形追記、lock の impl/tests 合算。

見積り: 中 | 依存: Phase 1

#### Task 2-3: CLI — split / merge オプション追加

`--split <old> --into <id1> <id2> [...]` と `--merge <id1> <id2> --into <new>` を
rename サブコマンドに追加。排他バリデーション。

見積り: 中 | 依存: Task 2-1, 2-2

#### Task 2-4: split / merge テスト

ユニットテスト + CLI 統合テスト。spec の Acceptance Scenarios（US2: 1-5, US3: 1-5）をカバー。

見積り: 中 | 依存: Task 2-3

## Implementation Order

```
Task 1-1 (rewriter)       ─┐
Task 1-2 (lock-updater)   ─┼─ 並行可能
Task 1-5 (fixture)        ─┘
         │
Task 1-3 (executor)       ← 1-1, 1-2 に依存
         │
Task 1-4 (cli)            ← 1-3 に依存
Task 1-6 (unit tests)     ← 1-3, 1-5 に依存
Task 1-7 (cli tests)      ← 1-4, 1-5 に依存
         │
    ── P1 完了 ──
         │
Task 2-1 (split)          ─┐
Task 2-2 (merge)          ─┼─ 並行可能
                          ─┘
Task 2-3 (cli split/merge)← 2-1, 2-2 に依存
Task 2-4 (tests)          ← 2-3 に依存
         │
    ── P2 完了 ──
```

## Risks

| リスク | 対策 |
|---|---|
| frontmatter 再シリアライズでフォーマット崩れ | D3: 行レベル文字列置換を採用 |
| `@impl REQ-001 REQ-002` で部分一致の誤置換 | 単語境界を意識した正規表現（ID 後に `[\s\]\,]` または行末） |
| 大量ファイルのパフォーマンス | git ls-files + 拡張子フィルタで対象を絞る |
| lock の symbol: ノード破損 | D4: symbol: キーは操作対象外として明示的にスキップ |

## Complexity Tracking

> 違反なし。Constitution Check 全項目パス。
