# Contract: rename での注釈書換挙動

Plan: [../plan.md](../plan.md) | Spec: [../spec.md](../spec.md)

## 対象 CLI

`artgraph rename <oldId> <newId>` 実行時、すべての追跡対象ファイルに対して
**rewriter チェーン** を実行する。本 issue では既存 rewriter（`rewriteSpecListItem`、
`rewriteSpecHeading`、`rewriteImplTag`、`rewriteFrontmatterReqKey` 等）に
`rewriteAnnotationIds` を追加する。

## `rewriteAnnotationIds` の契約

### 入力

```ts
function rewriteAnnotationIds(
  content: string,
  oldId: string,
  newId: string,
  opts?: RewriteOptions,
): RewriteResult;
```

- `content`: ファイル全文
- `oldId`: rename 前の req ID
- `newId`: rename 後の req ID
- `opts.reqPatterns.codeId` を用いて ID 形式を判定（既存 rewriter と同等）

### 動作

1. `content` を行に分割
2. `fencedLineSet(lines)` で fenced code block の行番号集合を取得
3. 各行について、fenced 内ならスキップ
4. ブロッククォート行（`/^\s*>/` で始まる行）はスキップ
5. 行内のインラインコードスパン（`` `...` ``）と HTML コメント（`<!-- ... -->`）は
   `maskInlineProtectedSpans` で同長空白に置換し、注釈マッチ判定から除外
6. 行内に対し以下の正規表現でマッチ（`g` フラグ）:

   ```regex
   \(\s*(depends_on|derives_from)\s*:\s*([^()]*?)\s*\)
   ```

7. 各マッチについてマスク済み行で対応スパンが全空白なら（= protected
   コンテキスト内）スキップ。それ以外は capture group 2 の ID リストを `,` で
   分割し、各 ID を strip 後に `oldId` と比較して一致するものを `newId` に置換
6. 置換した ID リストで注釈文字列を再構成し行に書き戻す
7. 置換が 1 件以上発生したら `RewriteResult.changes` に記録

### 出力

```ts
interface RewriteResult {
  content: string;            // 書換後の全文
  changes: RewriteChange[];   // 置換箇所のリスト（行番号、置換前後）
}
```

## 受理／非受理マトリクス

| 入力行 | rename 後 |
|---|---|
| `- AUTH-002: (depends_on: AUTH-001)` + `AUTH-001 → AUTH-100` | `- AUTH-002: (depends_on: AUTH-100)` |
| `- X: (depends_on: AUTH-001, AUTH-002, AUTH-001)` + `AUTH-001 → AUTH-100` | `- X: (depends_on: AUTH-100, AUTH-002, AUTH-100)` |
| `- X: (depends_on: **AUTH-001**)` + `AUTH-001 → AUTH-100` | `- X: (depends_on: **AUTH-100**)`（BOLD 形式を保ったまま ID のみ置換） |
| `\`\`\`\n(depends_on: AUTH-001)\n\`\`\`` + rename | 変更なし（fenced 内） |
| `` `(depends_on: AUTH-001)` `` + rename | 変更なし（インラインコード内） |
| `<!-- (depends_on: AUTH-001) -->` + rename | 変更なし（HTML コメント内） |
| `> - X: (depends_on: AUTH-001)` + rename | 変更なし（ブロッククォート行） |
| `- AUTH-002: (depends_on: AUTH-001)\r\n` + rename | `- AUTH-002: (depends_on: AUTH-100)\r\n`（CRLF 入力でも書換、改行コード保持） |
| 散文中の `(depends on AUTH-001)` + rename | 変更なし（誤キーワードはマッチしない） |
| 散文中の `AUTH-001 の説明` + rename | 注釈外なので本関数は変更しない（list-item / heading の req 定義は別 rewriter が処理） |

## 既存 rewriter との関係

- `rewriteSpecListItem`: list-item の **REQ ID 自体** を書き換える（`- AUTH-001: ...` の `AUTH-001`）
- `rewriteSpecHeading`: heading の **REQ ID 自体** を書き換える
- `rewriteFrontmatterReqKey`: frontmatter `req:` キーの値を書き換える
- `rewriteImplTag`: コード中の `// @impl AUTH-001` を書き換える
- **`rewriteAnnotationIds`（新規）**: 注釈括弧内の **依存先 ID** を書き換える

これらは独立に動作し、同じファイルの異なる位置を担当する。同一行に複数 rewriter
の対象がある場合は順次適用する（既存実装と同じパイプライン構造）。

## 不変条件

1. `rewriteAnnotationIds` は注釈括弧外の文字列を変更しない（散文・他キーワード・
   コードブロックは保護される）
2. 注釈括弧内でも `oldId` と完全一致しない ID は変更しない（部分マッチによる
   誤書換を起こさない）
3. BOLD（`**`）や空白の形式は **そのまま保持** し、ID 部分のみ置換する
4. 1 回の呼び出しで idempotent（2 回適用しても結果が変わらない、`oldId === newId` の場合は no-op）

## 期待される単体テストケース

1. 単一 ID 注釈の rename
2. 複数 ID 注釈で対象 ID のみ置換
3. 同一注釈内に `oldId` が複数回出現 → 全部置換
4. `derives_from` 種別でも同じ挙動
5. BOLD 形式の ID rename → BOLD 維持
6. 空白バリエーション保持
7. fenced code block 内の注釈は変更されない
8. 同一行に複数注釈 → 該当 ID を含む全注釈で置換
9. `oldId === newId` の no-op
10. `oldId` を含まないファイル → no-op、changes 空
