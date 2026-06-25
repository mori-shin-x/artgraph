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
  /** プリセット表示名 (エラーメッセージ・整合性確認のため)。例: "spec-kit" / "kiro" / "openspec" */
  name: string;
  /** 適用対象ファイルの (lowercase / 拡張子除去後) stem 配列。
   *  例: ["plan", "tasks"] (spec-kit) / ["tasks"] (kiro) */
  fileStems: string[];
  /** タスク ID 抽出用の正規表現。capture group 1 = task ID。 */
  taskIdRe: string;
  /** 実装ポインタタグ。capture group 1 = target ID。/g セマンティクスで適用。
   *  preset がこの tag 種別を持たない場合は省略 (例: Kiro は @impl を使わない)。 */
  implementsTagRe?: string;
  /** 要件参照タグ。capture group 1 = target ID。/g セマンティクスで適用。
   *  preset 別に書式が異なる: spec-kit は `[REQ-...]`、kiro は `_Requirements: X, Y_` 等。 */
  verifiesTagRe?: string;
}
```

### Built-in presets

| name | fileStems | taskIdRe | implementsTagRe | verifiesTagRe |
|---|---|---|---|---|
| `spec-kit` | `["plan", "tasks"]` | `^(?:\[[xX ]\][\s ]+)?(T\d+)\b` | `@impl\(([^)\n]+)\)` | `\[((?:REQ-[\w/-]+)\|(?:NAMESPACED_ID_TOKEN))\]` |
| `kiro` | `["tasks"]` | `^\[[xX ]\][\s ]+(\d+(?:\.\d+)*)\.?[\s ]` | *(未定義)* | `(?<=Requirements:[\s\d.,]*)(\d+(?:\.\d+)*)` |

- spec-kit: checkbox は **optional** (T### prefix が十分 distinctive のため)
- kiro: checkbox **required** (number-only listItem の false positive 防止、H1 fix)。verifiesTagRe は lookbehind で `Requirements:` ラベル後の `[\s\d.,]*` スコープに限定 → 散文中の数字は除外
- spec-kit verifiesTagRe の `NAMESPACED_ID_TOKEN` は `(?:[\w-]+/)?(?:[A-Z][A-Za-z]*-\d+|Requirement-\d+)` の展開 (req-id.ts 由来) + `REQ-` chained prefix の alternation

### Validation rules

- `name` は空文字不可・unique (builtin `spec-kit`/`kiro` 名との衝突も拒否)
- `fileStems` は空配列不可、各要素は非空 string
- `taskIdRe` / `implementsTagRe` / `verifiesTagRe` 共通バリデーション:
  - 200 文字以内
  - nested quantifier `(a+)+` パターン拒否 (ReDoS 対策)
  - capture group 1 が必須
  - 明示的に空文字列 `""` は拒否 (タグ種別を持たない preset は **field 自体を省略**する)

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

## 5. タグ抽出: preset-supplied 正規表現

タグ抽出は **preset がそれぞれ供給する `implementsTagRe` / `verifiesTagRe`** に従う (hardcoded 共通 regex は無い)。マッチした task の preset に応じて適用される regex が切り替わる。

### スコープ (どのテキストに regex を適用するか)

- task ノードが抽出された listItem の subtree を再帰的に walk し、**各 `paragraph` ごとに独立して** regex を適用する。
- ただし、subtree 内に**別の task ノード**を生成する nested listItem がある場合は、その subtree は除外する (親 task が子 task の `_Requirements:` 等を二重計上しないため)。
- 段落単位で適用するため、`(?<=Requirements:...)` のような lookbehind が段落境界を跨いで暴発しない。

### Built-in preset 別の挙動

| Preset | implements tag | verifies tag |
|---|---|---|
| **spec-kit** | `@impl(target-id)` → capture group 1 を trim、空なら edge skip (warning なし) | `[REQ-XXX]` / `[FR-001]` / `[Requirement-3]` / `[ns/FR-1]` の bracket 内文字列を verbatim で target に |
| **kiro** | *(未定義 — Kiro は @impl を使わない)* | `_Requirements: 1.1, 2.3, 3.1_` のカンマ区切り list から各 ID を 1 件ずつ抽出 (mdast `toString` が emphasis underscore を strip するため lookbehind は `Requirements:` ラベル後の `[\s\d.,]*` でスコープ |

### 共通の挙動

- 1 タスク項目に複数のタグがある場合は複数エッジ生成 (`/g` 適用)
- task ID が抽出されない箇所のタグは無視 (warning なし)
- 1 ファイル内で複数 tag 種別が同じ task に共存する場合、両エッジを生成 (直交)
- preset が当該 tag regex を定義していない場合、その edge 種別は生成されない (Kiro の implements が空、等)

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
