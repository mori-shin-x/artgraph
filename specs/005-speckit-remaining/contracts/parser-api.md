# Contract: `parseMarkdown` API 拡張

**File**: `packages/artgraph/src/parsers/markdown.ts`

本機能で `parseMarkdown` 関数の入出力契約に追加される事項のみを列挙する。既存契約は不変。

---

## 1. Input: `ParseMarkdownOptions`

### 追加フィールド

```ts
taskConventions?: TaskConventionPreset[];
```

- **省略時**: `BUILTIN_TASK_PRESETS`（`spec-kit`, `kiro`）のみが適用される
- **指定時**: builtin に **追加** で適用される（builtin を置換しない）
- **空配列 `[]` 指定時**: builtin のみ適用（指定しなかった場合と等価）

### 検証

- 各 preset は `data-model.md §2 Validation rules` を満たすこと
- 検証は `config.ts` の `loadConfig()` 段階で行う（`parseMarkdown` には valid な値のみ到達する想定）

---

## 2. Output: `ParsedSpec.nodes` の拡張

### task ノードの形

```ts
{
  id: string,            // task ID (例: "T001", "1.1") もしくは衝突解決後の "specDir/T001"
  kind: "task",
  filePath: string,      // rootDir 相対パス
  label: string,         // タスク行のテキスト全体（先頭の `[X]` checkbox + ID + 説明）
  contentHash: string,   // タスク行 1 行のテキストの SHA-256 先頭 16 文字
}
```

### 抽出ルール

- 対象ファイル: file-stem（拡張子・大文字小文字を除いた basename）が任意の preset の `fileStems` に一致するもの
- 対象 mdast ノード: `listItem` の中の最初の `paragraph` の `toString()` 結果
- マッチ: 該当ファイルに適用される preset 群の `taskIdRe` 全てを順次評価し、いずれかの capture group 1 が ID として採用される
- 同一 listItem が複数 preset でマッチした場合、最初にマッチした preset の ID を採用（プリセット順序: builtin → user）
- リスト項目以外（見出し / 段落 / コードブロック / etc.）からは task ノードを抽出しない

---

## 3. Output: `ParsedSpec.edges` の拡張

タグ抽出は **preset がそれぞれ供給する `implementsTagRe` / `verifiesTagRe`** に従う (parser 側に hardcoded な共通 regex は無い)。

### 適用スコープ

- task ID が抽出された listItem の subtree を walk
- 各 `paragraph` ノードに対し独立して preset の tag regex を `/g` で適用 (cross-paragraph leak を防ぐため)
- subtree 内に **別の task** を生成する nested listItem がある場合は、そのサブツリーを除外 (親 task が子 task のタグを継承しない)

### Edge 生成

- `task → implements → target`: 該当 preset の `implementsTagRe` が定義されている場合のみ。capture group 1 を `trim()` し、空でなければ edge 化
- `task → verifies → target`: 該当 preset の `verifiesTagRe` が定義されている場合のみ。capture group 1 を `trim()` し、空でなければ edge 化
- preset がどちらの tag regex も持たない場合、その preset から生成される edge は taskNode のみ (cross-link は無し)

### 既存タグとの共存

- spec-kit の `[REQ-XXX]` token は TS パーサ (`typescript.ts:253`) の `testReqRe` と互換 (capture group は parser 側 vs builder 側で異なるが ID 形式は同じ)
- `@impl(...)` (Markdown 側 / カッコ付き) は TS パーサの `@impl REQ-001` (コメント形式 / カッコ無し) とは regex が異なるため衝突しない

---

## 4. 後方互換

- `taskConventions` 未指定の既存呼び出しは builtin 適用となり、空 `tasks.md` / 空 `plan.md` の場合は task ノード生成ゼロ → 観察可能な差異なし
- 既存テスト (`tests/parsers/markdown.test.ts` ほか) はそのまま通過することを期待

---

## 5. エラー / 警告契約

| 状況 | 挙動 |
|---|---|
| preset の `taskIdRe` / `implementsTagRe` / `verifiesTagRe` が無効 regex | `config.ts` 段階で throw (既存 `reqPatterns` と同じ UX) |
| preset の `name` が重複 (builtin 名との衝突含む) | `config.ts` 段階で throw |
| 該当ファイルでタスク行ゼロ | 正常終了 (task ノード ゼロ) |
| タスク行のタグ capture が空 (`@impl()` 等) | エッジ生成スキップ (warning なし) |
| preset の `implementsTagRe` 未定義 | implements edge は当該 preset からは生成されない (例: Kiro) |
| preset の `verifiesTagRe` 未定義 | verifies edge は当該 preset からは生成されない |
| nested task の tag が親 scope に流入する可能性 | parser 側で nested-task subtree を除外することで防止 |
