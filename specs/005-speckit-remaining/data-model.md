# Data Model: Issue #28 (FR-009 / FR-010 / FR-012)

**Date**: 2026-06-24

本機能の追加で導入される型・拡張される型・新規エッジ生成ルールをまとめる。実装ファイル: `packages/artgraph/src/types.ts` を中心に、`parsers/markdown.ts` / `graph/builder.ts` / `config.ts` に波及。

---

## 1. NodeKind 拡張

> **用語**: Constitution Principle II は **4 抽象層** (`req` / `doc` / `code` / `test`) を宣言する。現行実装は code 層を `file` と `symbol` の **2 NodeKind** で表現しているため、現行は **5 NodeKind** (4 抽象層 / 5 NodeKind の関係)。本 PR は `task` を追加し **6 NodeKind** とする (4 抽象層は不変、code 層と並ぶ 5 番目の抽象層という位置付けは [plan.md Complexity Tracking](./plan.md) で justify 済)。

### Before (現行)

```ts
// types.ts:1 — 5 NodeKind
export type NodeKind = "req" | "doc" | "file" | "symbol" | "test";
```

### After (本 PR)

```ts
// 6 NodeKind
export type NodeKind = "req" | "doc" | "file" | "symbol" | "test" | "task";
```

### Semantics

| NodeKind | レイヤー | 役割 | 典型的な `implements`/`verifies` での位置 |
|---|---|---|---|
| `req` | spec / docs | WHAT (要求) | **target** (例: `code → implements → req`) |
| `task` | plan.md / tasks.md | HOW (実装手順) | **source** (例: `task → implements → target-id`) |
| `doc` | あらゆる .md | 文書ノード | source/target どちらでも (主に `derives_from` / `depends_on`) |
| `file` / `symbol` | code | 実装 | `implements` の source（既存） |
| `test` | test code | 検証 | `verifies` の source（既存） |

### Edge incidence rules

`task` から出るエッジ:
- `task → implements → target-id`（FR-009、`@impl(target-id)` から生成）
- `task → verifies → target-id`（FR-010、`[REQ-xxx]` から生成）

`task` に入るエッジ:
- `doc → contains → task`（同ファイル内、`autoContains` 有効時、R5 参照）
- 名前空間衝突解決時の修飾 ID (`specDir/T001`) 経由のみ

---

## 2. 新規型: `TaskConventionPreset`

### Type definition

```ts
// types.ts に追加
export interface TaskConventionPreset {
  /** プリセット表示名（エラーメッセージ・整合性確認のため）。例: "spec-kit" / "kiro" / "openspec" */
  name: string;
  /** 適用対象ファイルの (lowercase / 拡張子除去後) stem 配列。
   *  例: ["plan", "tasks"] (spec-kit) / ["tasks"] (kiro) */
  fileStems: string[];
  /** タスク ID 抽出用の正規表現文字列。
   *  - capture group 1 = task ID（必須）
   *  - リスト項目テキストの先頭から match を試行する（multiline / global 不要）
   *  例: spec-kit "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(T\\d+)\\b"
   *  例: kiro    "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(\\d+(?:\\.\\d+)*)\\.?[\\s\\u00A0]"
   */
  taskIdRe: string;
}
```

### Built-in presets

| name | fileStems | taskIdRe | 補足 |
|---|---|---|---|
| `spec-kit` | `["plan", "tasks"]` | `^(?:\[[xX ]\][\s ]+)?(T\d+)\b` | チェックボックス `[X]`/`[x]`/`[ ]` を許容し、後続の `T###` を捕捉 |
| `kiro` | `["tasks"]` | `^(?:\[[xX ]\][\s ]+)?(\d+(?:\.\d+)*)\.?[\s ]` | 階層数字 `1`, `1.1`, `1.1.1`。末尾の任意のドット `.` を許容 |

### Validation rules

- `name` は空文字不可・unique（同名複数登録はエラー）
- `fileStems` は空配列不可、各要素は lowercase の英数字+ハイフン
- `taskIdRe` は `config.ts` の既存 `validateReqPatterns()` と同じバリデーション規則を適用:
  - 200 文字以内
  - nested quantifier `(a+)+` パターン拒否（ReDoS 対策）
  - capture group 1 が必須（whole-match ではなく capture）

### Storage

- **Built-in**: `packages/artgraph/src/parsers/markdown.ts` 冒頭に `const BUILTIN_TASK_PRESETS: TaskConventionPreset[]` として定数定義。
- **User-defined**: `.artgraph.json` の `taskConventions` フィールド。
- **適用順序**: builtin + user を**配列結合**して順次評価。重複（同一 fileStem に対する複数プリセット）は両方適用 → `(source|target|kind)` dedup で最終的に 1 件に集約。

---

## 3. 拡張型: `ArtgraphConfig`

### Before

```ts
export interface ArtgraphConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  docGraph?: DocGraphConfig;
  mode?: "file" | "symbol";
  testResultPaths?: string[];
}
```

### After

```ts
export interface ArtgraphConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  docGraph?: DocGraphConfig;
  mode?: "file" | "symbol";
  testResultPaths?: string[];
  /**
   * SDD ツール別の task ID 抽出プリセット。
   * builtin の `spec-kit` / `kiro` に追加で適用される（builtin を上書きはしない）。
   * 未指定時は builtin のみ適用。
   */
  taskConventions?: TaskConventionPreset[];
}
```

### Config loading

- `config.ts` の `loadConfig()` で JSON 読み込み時に `taskConventions` 配列を validate（上記 R8 ルール）。
- 不正値は明示エラー（既存 `reqPatterns` のエラー UX を踏襲）。

---

## 4. 拡張型: `ParseMarkdownOptions`

### Before

```ts
// markdown.ts:11
export interface ParseMarkdownOptions {
  rootDir?: string;
  specDirPrefix?: string;
  reqPatterns?: ReqPatternConfig;
}
```

### After

```ts
export interface ParseMarkdownOptions {
  rootDir?: string;
  specDirPrefix?: string;
  reqPatterns?: ReqPatternConfig;
  /** 未指定時は BUILTIN_TASK_PRESETS のみ適用。指定時は builtin に追加。 */
  taskConventions?: TaskConventionPreset[];
}
```

---

## 5. 新規パース対象: タグ

### `@impl(target-id)` タグ

- **Where**: `taskConventions` で task ID 抽出対象となる**全ファイル** (R3 参照)
- **Regex**: `/@impl\(([^)]+)\)/g`（target-id は capture group 1、内容は空白以外の任意文字）
- **挙動**:
  - リスト項目内に出現した場合、その項目に紐づく task ノードから target-id への `implements` エッジを生成
  - リスト項目に紐づかない（task ID が抽出されない）箇所での `@impl(...)` は無視（warning なし）
  - 1 タスク項目に複数の `@impl(...)` がある場合は複数エッジ生成

### `[REQ-xxx]` タグ

- **Where**: `taskConventions` で task ID 抽出対象となる**全ファイル**
- **Regex**: 既存 TS パーサの `testReqRe` と同じ token (`NAMESPACED_ID_TOKEN` の bracket 形式)
- **挙動**:
  - リスト項目内に出現した場合、task ノードから bracket 内文字列 (prefix 維持) への `verifies` エッジを生成
  - 1 タスク項目に複数の `[REQ-]` がある場合は複数エッジ生成

### 適用優先度

- 1 ファイル内で `[REQ-]` と `@impl(...)` が同じ task 項目に共存する場合、両エッジを生成（互いに直交）。

---

## 6. 新規エッジ生成ルール

| エッジ | source | target | kind | 生成タイミング |
|---|---|---|---|---|
| task → implements | `task` ノード ID | `@impl(X)` の X (自由形式) | `implements` | `parseMarkdown` |
| task → verifies | `task` ノード ID | `[REQ-X]` の X (prefix 維持) | `verifies` | `parseMarkdown` |
| doc → contains | doc ノード ID | 同ファイル内の task ノード ID | `contains` | `builder.ts:246` |
| (修飾) | `specDir/T001` | 元 target | 同上 | `builder.ts` pass 2 |

すべて既存 `(source|target|kind)` dedup の対象。

---

## 7. 既存ロジックへの最小波及

| ファイル | 変更内容 | 行数規模 |
|---|---|---|
| `types.ts` | NodeKind 拡張、TaskConventionPreset 追加、ArtgraphConfig 拡張 | ~10 行 |
| `config.ts` | taskConventions のロード + validate | ~30 行 |
| `parsers/markdown.ts` | BUILTIN_TASK_PRESETS / extractTasks / extractTaskTags / task ノード生成 | ~80 行 |
| `graph/builder.ts` | task を req と同じ衝突解決パスに通す + contains 拡張 | ~15 行 |
| `scan.ts` | ScanSummary に `taskCount` 追加 | ~5 行 |
| `graph/format.ts` | NodeKind 型の都合で `task` ラベル表示の追加（既存ルールに合わせる） | ~5 行 |
| `coverage.ts` | 変更なし（`kind === "req"` のフィルタを維持、task は集計対象外） | 0 行 |
| `graph/traverse.ts` | **決定**: lock 連動判定 (`traverse.ts:69 `付近の `kind === "req" \|\| kind === "doc"` 条件) には **task を追加しない** (Constitution Principle III の境界保持、[spec.md Clarifications U2](./spec.md#clarifications))。一方、impact 分析や single-source traversal の入口としては task ノードも自然に経由されるため、その他のフィルタはそのまま既存 EdgeKind ベースで動く想定。差分ゼロを期待。 | 0–2 行 |

合計 ~150 行の実装変更。テストは fixture + ユニット + 統合で ~250 行程度を想定。

---

## 8. 後方互換性

- `taskConventions` 未設定の `.artgraph.json` でも builtin が動作するため、Issue #28 マージ後**全プロジェクトで自動的に task ノードが生成される**。
- 既存プロジェクトの `tasks.md` が空ないしテキストのみ（タスク行なし）の場合は task ノード ゼロ。実害なし。
- 既存プロジェクトの `tasks.md` に T001 等が記載されている場合、**新規 task ノード追加 + contains エッジ追加**が `.trace.lock` に乗る。これは仕様変更扱いで、ユーザは `artgraph reconcile` で lock baseline 更新が必要になる旨を CHANGELOG に明記する。
- 既存テスト（vitest 565 件）への影響: R2 で確認の通り、fixture には task 行がないため**全件通過想定**。
