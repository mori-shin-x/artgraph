# Phase 0 Research: Issue #28 (FR-009 / FR-010 / FR-012)

**Date**: 2026-06-24
**Status**: Closed — all NEEDS CLARIFICATION resolved.

## R1: Kiro tasks.md の実フォーマット

### Decision

Kiro `tasks.md` のタスク ID は **チェックボックス付きリスト項目の先頭にある階層数字**（例: `1`, `1.1`, `1.1.1`）と確定する。`taskIdRe` パターンは `^(?:\[[xX ]\][\s ]+)?(\d+(?:\.\d+)*)\.?[\s ]` を採用（末尾ドット許容 `1.` を含む）。

### Verification (2026-06-24 web research)

公式テンプレート + 公開 production リポジトリ 3 件のサンプル調査で実フォーマットを確定:

- **task ID 形式**: `- [x] N. ...` (top-level、末尾ドット) または indented `- [ ] N.M ...` (sub-task)。**checkbox 必須** (`H1` fix で required 化済)。
- **cross-link 構文**: `- _Requirements: 1.1, 2.3, 3.1_` (italic, カンマ区切り) — **`[REQ-]` でも `@impl(...)` でも無い**。Kiro 独自。
- **`implementsTagRe`**: 未定義 (Kiro は実装ポインタを task tag で表現しない)。
- **`verifiesTagRe`**: `(?<=Requirements:[\s\d.,]*)(\d+(?:\.\d+)*)` — mdast `toString` が emphasis underscore を strip するため `_` には依存せず、`Requirements:` ラベルと直前文字種制限で散文中の数字を除外する。

**情報源**:

- 公式テンプレート: [kiro tasks-phase.md](https://github.com/jasonkneen/kiro/blob/main/spec-process-guide/process/tasks-phase.md) — 「numbered checkbox list with a maximum of two levels of hierarchy」明記。
- 実 production:
  - [Veloera/Veloera `.kiro/specs/inbox-system/tasks.md`](https://github.com/Veloera/Veloera/blob/6525dfce816beaa270e78f0d8b762e19e54d13b8/.kiro/specs/inbox-system/tasks.md)
  - [GreaterWMS/GreaterWMS `.kiro/specs/ci-pipeline/tasks.md`](https://github.com/GreaterWMS/GreaterWMS/blob/f8b931d02e2afcfa933c549d58a86ab581490de2/.kiro/specs/ci-pipeline/tasks.md) (ネスト sub-task)
  - [trilogy-group/ttv-pipeline `.kiro/specs/api-server/tasks.md`](https://github.com/trilogy-group/ttv-pipeline/blob/046cf366ba793f0d5a655c8a3f88c7f746c872cc/.kiro/specs/api-server/tasks.md)

### Rationale (preset 拡張)

当初は `[REQ-]` / `@impl(...)` を hardcoded preset 共通として実装したが、Kiro が `_Requirements:` 形式を使う事実が判明したため、**`TaskConventionPreset` に `implementsTagRe` / `verifiesTagRe` を optional で追加**し SDD ツール別に cross-linking 構文を切り替える設計に変更:

- spec-kit: `implementsTagRe = @impl(...)`, `verifiesTagRe = [REQ-...]` (従来通り)
- kiro: `implementsTagRe = undefined`, `verifiesTagRe = (?<=Requirements:[\s\d.,]*)(\d+(?:\.\d+)*)` (新規)
- OpenSpec 等のユーザ定義 SDD ツール: 任意の preset を `.artgraph.json` で追加可能

`parsers/markdown.ts` の hardcoded `IMPL_TAG_RE` / `REQ_TAG_RE` は preset-supplied 形に置換。`data-model.md §2` の `TaskConventionPreset` 形も拡張。

### Alternatives considered

- **`#1` / `#1.1` の hash-prefix 形式**: 一部のチケットツール由来の慣習だが、Markdown 見出し `#` と衝突するため不適。
- **GitHub Issue 風 `#N` 単独**: 階層を持てないため Kiro のサブタスク構造を表現できない。
- **強制必須ドット (`\d+\.`)**: 単一階層の場合に `1` が捕まらず実害大。
- **hardcoded REQ/impl tag を維持して Kiro 対応を別 issue に分離**: 採用検討したが、Kiro は本 PR の builtin preset であり、preset を提供しながら cross-link 0 件は誤解を招くため却下。`TaskConventionPreset` 拡張に踏み切った。

## R2: 既存 fixture / 実 tasks.md への影響

### Decision

既存 fixture (`tests/fixtures/conventions/specs/`) はいずれも task ID 行を含まないため、本変更による task ノード生成数はゼロ。**既存 565 件のテストは無破壊**で通過する。

ただし **リポジトリの実 `specs/00N-*/tasks.md`** は T001 〜 T### を多数含むため、`pnpm artgraph scan` 実行時に新規 task ノードが生成される。これは本機能の意図そのものなので想定内挙動。PR レビュー時に `pnpm artgraph scan` 出力の diff を確認する。

### Rationale — Fixture Inventory (実機 grep 2026-06-24)

`grep -RnE '^(\s*-\s*\[[xX ]\]\s+)?(T\d+|\d+\.\d+)' packages/artgraph/tests/fixtures/conventions/specs/` を `feat/issue-28` ブランチで実行し、**マッチ件数ゼロ**を確認。fixture サブディレクトリ別の中身は以下:

| Fixture dir | Files | T### / 階層数字 行 |
|---|---|---|
| `case-variant/` | `DESIGN.md` / `Requirements.md` | なし |
| `kiro-feature/` | `design.md` / `requirements.md` / `tasks.md` | なし（`tasks.md` 全文: "# Tasks\n\nThe tasks derived from design.\n"） |
| `mixed-tools/` | `design.md` / `plan.md` / `tasks.md` | なし（`plan.md` は "# Plan (mixed)" + 説明散文、`tasks.md` は "# Tasks (mixed)" + 説明散文のみ） |
| `multi-dot/` | `my.design.md` / `requirements.md` | なし |
| `other-dir/` | `requirements.md` | なし |
| `partial/` | `tasks.md` | なし（`tasks.md` 全文: "# Tasks\n\nOnly tasks here.\n"） |
| `speckit-feature/` | `plan.md` / `research.md` / `spec.md` / `tasks.md` | なし（`plan.md` 全文: "# Plan\n\nThe plan derived from spec.\n"） |
| `with-frontmatter/` | `design.md` / `requirements.md` | なし |

確認手順は [tasks.md T014.5](./tasks.md) (Phase 3 内追加タスク) に再現可能な grep として組み込み済。これにより NFR-004 (Phase 2 後方互換) が定量的に保証される。

実 `specs/006-test-results/tasks.md` 等の T### 行は既存テスト対象外（テストは fixture を使う）なので、ユニットテスト回帰の心配なし。

### Alternatives considered

- **既存 fixture を更新してタスクを足す**: C-3 (PR #33) のテストが「ファイル存在のみ確認」の前提で書かれているため、安易な追加は既存テストの assertion を壊しうる。**棄却**。本機能用に専用 fixture (`tests/fixtures/tasks/`) を新規作成する。

## R3: タグ認識のファイル別スコープ

### Decision

`@impl(target)` と `[REQ-XXX]` の両タグは、**`taskConventions` プリセットの file-stem に一致するファイル全てで認識する**（プリセット適用と同じスコープ）。

- Spec Kit プリセット: file-stem `plan` および `tasks` の両方で task 抽出 + 両タグ認識
- Kiro プリセット: file-stem `tasks` で task 抽出 + 両タグ認識
- ユーザがプリセット追加すれば OpenSpec 等にも同じスコープルールが適用される

### Rationale

- FR-009 は「plan.md 内の `@impl`」、FR-010 は「tasks.md 内の `[REQ-]`」と例示しているが、本質は**プリセットが認識する task ファイルでタスクをグラフ化する**こと。タグごとに別 file-stem を持たせる必要はない。
- 実運用では plan.md にも `[REQ-]` を、tasks.md にも `@impl` を書くケースがあり得る（テストタスクが実装ファイルにも触れる等）。symmetric な認識のほうが UX が素直。
- 実装側も 1 つの `extractTaskTags()` 関数で両タグを処理できコード簡素化。

### Alternatives considered

- **FR 例の文字通り解釈**: plan.md → `@impl` のみ / tasks.md → `[REQ-]` のみ。FR の例示を厳格化する。**棄却**: 上記 UX 観点 + 実装の冗長化（タグ別 file-stem テーブルが必要）。
- **タグ別プリセット**: `taskConventions` を `taskIdRe`/`implTag`/`verifiesTag` の三本柱に拡張。**棄却**: YAGNI。タグ書式の差異は実例として観測されていない。

## R4: C-3 convention edges との競合分析

### Decision

C-3 の `inferConventionEdges` が生成する `derives_from` エッジ（例: spec→plan の `tasks → derives_from → plan`）と、本機能の `task → implements/verifies → target` エッジは **別 EdgeKind** のため `(source|target|kind)` dedup では衝突しない。両者は安全に共存。

### Rationale

- C-3 は doc 粒度 (`doc:plan.md → doc:spec.md`)。本機能は task 粒度 (`task:T001 → target-id`)。source/target がそもそも異なる。
- 仮に偶然 source/target が一致しても EdgeKind が `derives_from` vs `implements`/`verifies` で異なるため別キーとなる。
- Issue #11 のインライン link `depends_on` 抑止ロジック (`explicitPairs`, `builder.ts:334`) には影響なし（task node は doc ではないため `sourceNode?.kind === "doc"` ガードに引っかからない）。

### Alternatives considered

- **無し**（特に問題なし）。

## R5: `contains` エッジを doc → task に拡張するか

### Decision

**拡張する**。`autoContains` 有効時、doc ノード（plan.md / tasks.md）から同ファイル内の task ノードへ `contains` エッジを生成する。

実装変更点: `builder.ts:246-258` の loop で `reqNode.kind === "req"` を `reqNode.kind === "req" || reqNode.kind === "task"` に拡張。

### Rationale

- 現行 `contains` は「doc は自身の同ファイル内 req を含む」というセマンティクス。task も「同ファイル内の構成要素」であり同一視が自然。
- impact 分析で「plan.md を編集 → 影響する task → 影響する code」を辿るために必要。
- `autoContains: false` の場合は生成しない（既存挙動と一貫）。

### Alternatives considered

- **task は contains の対象外**: doc → task トレースを辿るには別エッジを引く必要があり、impact 分析の精度低下。**棄却**。
- **新 `has_task` エッジ kind**: EdgeKind 追加は Constitution Principle II に追加抵触で、追加 justify 必要。`contains` 拡張で意図を満たせるため不要。

## R6: タスクの contentHash

### Decision

task ノードの `contentHash` は **タスク行 1 行の文字列**を SHA-256 → 先頭 16 文字（既存 `hash()` ヘルパ流用）で算出する。ヒエラルキー子孫を含めない。

### Rationale

- req ノードは見出しベースの場合「セクション全体」をハッシュ（`extractSectionContent`、`markdown.ts:295`）、リスト項目ベースの場合「項目全体」をハッシュ。task は基本リスト項目相当のため、項目テキスト 1 行で十分。
- Kiro の `1.1` 等の階層タスクで子孫を含めると、子の編集で親の hash が変わり drift 検出が誤発火する。
- 階層関係はエッジ（`derives_from` を後続で生成するか別 task → task `depends_on` を導入するかは Issue #28 のスコープ外）で表現する未来拡張に委ねる。

### Alternatives considered

- **同セクション内の全行を含める**: 上記の通り誤検出リスク。**棄却**。
- **タスク行 + 直後の説明インデントブロック**: 妥当だがパーサ複雑化。Spec Kit の `- [X] T001 \`path\` description` は 1 行で完結するケースが大半のため YAGNI。

## R7: タスク node の ID 名前空間衝突

### Decision

task ID も既存の req 衝突解決ロジック（`builder.ts:134-184`, `extractSpecDir`）と**同じ枠組み**で扱う。同一 ID（例: `T001`）が異なる specDir に存在する場合、`specDir/T001` に修飾する。

### Rationale

- Spec Kit の T001 はフィーチャーごとに同番号を振る慣行のため、複数フィーチャーで衝突するケースが頻発する。req と同じ修飾ルールが自然。
- 実装は `kind === "req"` を `kind === "req" || kind === "task"` に拡張するだけ（builder.ts pass 1/2 全般）。

### Alternatives considered

- **task に独自 prefix を強制**: `task:T001` 等。**棄却**: Constitution Principle IV「SDD ツール ID 直接利用」に反する。
- **衝突は warning のみ、修飾しない**: 同 ID が複数 specDir に存在すると impact 分析が破綻。**棄却**。

## R8: TaskConventionPreset の配置と公開

### Decision

`packages/artgraph/src/parsers/markdown.ts` 冒頭に定数として **コロケート** する。`TaskConventionPreset` 型は `types.ts` で export し、`ArtgraphConfig.taskConventions` でユーザ拡張可。

```ts
// in types.ts
export interface TaskConventionPreset {
  name: string;          // 表示用 (例: "spec-kit" / "kiro" / "openspec")
  fileStems: string[];   // 適用対象 (例: ["plan", "tasks"])
  taskIdRe: string;      // ID 抽出 regex (capture group 1 = ID)
}

// in markdown.ts (or graph/conventions.ts に分離可、YAGNI で markdown.ts 内)
const BUILTIN_TASK_PRESETS: TaskConventionPreset[] = [
  { name: "spec-kit", fileStems: ["plan", "tasks"],
    taskIdRe: "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(T\\d+)\\b" },
  { name: "kiro", fileStems: ["tasks"],
    taskIdRe: "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(\\d+(?:\\.\\d+)*)\\.?[\\s\\u00A0]" },
];
```

ユーザ拡張プリセットは **追加** 適用（builtin を削除する場合は `taskConventions: []` で空にする運用、または明示的に `inherit: false` フィールドを後追加 — YAGNI）。

### Rationale

- C-3 の `CONVENTION_EDGES` (`builder.ts:47`) と同じ配置思想（パーサ/ビルダーにコロケートした純データ）。
- 専用ファイル `graph/conventions.ts` への分離はプリセット数が 5+ に増えた段階で実施。現状 2 件のためコロケート優位。
- `taskConventions: TaskConventionPreset[]` の型は `.artgraph.json` から JSON でそのまま渡せるシリアライザブル型に限定。

### Alternatives considered

- **`graph/conventions.ts` に新規ファイル**: 上記の通り早すぎる抽象化。
- **regex を JSON ではなくコード生成**: ユーザ拡張不能になる。**棄却**。
- **builtin と user preset の merge ポリシー設定可能化**: 現状 1 行で書けるユースケースに対し過剰設計。**棄却** (将来 issue で対応)。

## R9: parseMarkdown シグネチャ拡張

### Decision

`ParseMarkdownOptions` に `taskConventions?: TaskConventionPreset[]` を追加。未指定時は builtin の 2 件を適用。

```ts
export interface ParseMarkdownOptions {
  rootDir?: string;
  specDirPrefix?: string;
  reqPatterns?: ReqPatternConfig;
  taskConventions?: TaskConventionPreset[];  // 新規
}
```

### Rationale

- `reqPatterns` と同じパターン（既存 `markdown.ts:11-15`）に揃え、API の一貫性を保つ。
- `config.ts` の `loadConfig()` で `.artgraph.json` の `taskConventions` 配列を読み込み、`parseMarkdown` に渡す。
- builder 側の `parseMarkdown(file, { rootDir, specDirPrefix: specDirName, reqPatterns: config.reqPatterns })` (`builder.ts:82`) を `taskConventions: config.taskConventions` 追加で拡張するのみ。

### Alternatives considered

- **`reqPatterns.taskId` として既存型に詰める**: スコープ・file-stem の概念が `reqPatterns` にないため不一致。**棄却**。

## Open Items (Phase 1 以降に残す)

- Kiro の実 tasks.md サンプルが入手できたら R1 のパターンを再検証（PR レビューでもユーザ確認）。
- 階層タスクの親子関係を表すエッジ（`task → derives_from → task`）は本 Issue スコープ外。Issue #13（req→req 依存）の議論に近いため、別 issue で。
- `task` ノードを `coverage`/`check` の集計対象にするかは future work（現状は req のみ集計、task は impl/verify の source のため除外）。
