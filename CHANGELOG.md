# Changelog

## Unreleased

### Fixed (meta-review remediation for req⇔req inline annotations)

- **Blocker**: collision で同名 req の注釈 edge が最初の specDir の req に集約される
  バグを修正 (`builder.ts`). 010-a / 010-b に同名 `AUTH-001` がある場合でも、
  各 specDir の注釈 edge が正しい req に帰属するようになった。
- **Blocker**: CLI `printWarnings` が新警告タイプ (`orphan-edge` /
  `invalid-annotation-id` / `empty-annotation` / `self-reference-annotation`)
  を完全に握りつぶしていた問題を修正。`BuildWarning.type` 拡張に対する
  exhaustiveness check (`never` assertion) も追加。
- **Blocker**: parser と rewriter の Markdown 文脈保護を整備。inline code
  (`` `(depends_on: X)` ``)、HTML コメント (`<!-- (depends_on: X) -->`)、
  blockquote (`> - X: (depends_on: ...)`) 内の注釈は edge も書換も生成しない。
- **Major**: ambiguous な注釈 target は edge を生成せず、`ambiguous-id` 警告 1 件
  のみ emit するように変更 (`research.md` R6 の通り)。orphan-edge 二重警告も解消。
- **Major**: `rewriteAnnotationIds` が `RewriteOptions` (=`reqPatterns.codeId`) を
  受け取らない問題を修正。カスタム ID 形式を使うプロジェクトでも parser/rewriter
  parity が保たれる。
- **Major**: heading req の注釈で contentHash が drift する複数経路を修正。
  first paragraph 全行を strip 対象に拡大し、注釈削除後の空行を collapse する。
  注釈括弧前後の空白の有無も `stripAnnotations` が正規化するので、`X(ann)Y` と
  `X Y` のような書き方差でも hash 不変。
- **Major**: 空トークン要素 (`(depends_on: ,A,,B,)`) で `invalid-annotation-id key=""`
  警告を多発させる挙動を修正。空要素は黙って捨て、全要素が空ならば
  `empty-annotation` 1 件のみ emit。
- **Major**: lock ファイル (`.trace.lock`) の `dependsOn` から annotation edge を
  除外。`(depends_on: X)` を追記しただけで lock が churn し `check --gate` が
  誤って失敗する問題を解消 (contracts/provenance-field.md 通り)。
- **Major**: CRLF 改行のファイルでも parser/rewriter が一貫して動作する。
  parser は LF に正規化、rewriter は LF で書き換えた後に元の改行コードを復元する。
- **Major**: `format.ts` の provenance 出力に type guard を追加。
  `EdgeProvenance` literal union のメンバ値以外 (`""` / `null` / 未知の文字列)
  は JSON 出力から省略する。
- **Major**: `idToDirs.get(...)!` の non-null assertion を nullish 検査に置換。
  ambiguous-id 警告の `files` 配列も決定的順序 (sort 済み) で出力。
- **Major**: 不変条件のリグレッションテスト 17 件を `req-req-invariants.test.ts`
  に追加 (collision edge 帰属、文脈保護、hash 不変、rename round-trip など)。

### Notes for existing users

- 散文中に `(depends_on: X)` のような括弧式を「説明」として書いていたユーザは、
  この PR 以降 **インライン注釈として解釈され edge 化される** 場合がある。
  edge を作りたくない箇所は次の文脈に入れて保護できる:
  - インラインコード: `` `(depends_on: X)` ``
  - HTML コメント: `<!-- (depends_on: X) -->`
  - blockquote: 行頭 `> ` を付ける
  - fenced code block: ` ``` ` または `~~~` で囲む
  - indented code block: 行頭 4 スペース以上のインデント
- `.trace.lock` の `dependsOn` 配列は annotation edge を含まない。
  `artgraph reconcile` 実行後の lock 差分には注釈追加分が現れないことを想定して
  ほしい (Issue #35 の lock スキーマ再設計で改めて扱う)。
