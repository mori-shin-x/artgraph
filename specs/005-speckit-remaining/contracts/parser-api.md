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

### `task → implements → target-id`

- **トリガ**: 同じ listItem 配下の paragraph 全テキストに対し regex `/@impl\(([^)]+)\)/g` でマッチ
- **生成**: `{ source: taskId, target: targetId.trim(), kind: "implements" }` を 1 マッチごとに 1 件
- target-id の空白 trim のみ行い、それ以上の正規化はしない（自由形式）

### `task → verifies → target-id`

- **トリガ**: 同じ listItem 配下の paragraph 全テキストに対し `NAMESPACED_ID_TOKEN` の bracket 形式（`testReqRe`）でマッチ
- **生成**: `{ source: taskId, target: bracketInner, kind: "verifies" }` を 1 マッチごとに 1 件
- bracket 内文字列はそのまま使用（`REQ-` prefix を含む）

### 既存タグとの共存

- `[REQ-]` タグは TS パーサ (`typescript.ts:253`) と同じ token を使うため、ID 形式に完全な互換性がある
- `@impl(...)` タグは TS パーサの `@impl REQ-001`（パーレン無し）とは regex が異なるため衝突しない

---

## 4. 後方互換

- `taskConventions` 未指定の既存呼び出しは builtin 適用となり、空 `tasks.md` / 空 `plan.md` の場合は task ノード生成ゼロ → 観察可能な差異なし
- 既存テスト (`tests/parsers/markdown.test.ts` ほか) はそのまま通過することを期待

---

## 5. エラー / 警告契約

| 状況 | 挙動 |
|---|---|
| preset の `taskIdRe` が無効 regex | `config.ts` 段階で throw（既存 `reqPatterns` と同じ UX） |
| preset の `name` が重複 | `config.ts` 段階で throw |
| 該当ファイルでタスク行ゼロ | 正常終了（task ノード ゼロ） |
| タスク行に `@impl()` 空内容 | エッジ生成スキップ（warning なし） |
| `[REQ-]` の REQ- prefix なし `[FOO]` | regex (`NAMESPACED_ID_TOKEN`) にマッチしなければスキップ |
