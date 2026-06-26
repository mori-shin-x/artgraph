# Changelog

## Unreleased

### Schema v2 — Edge provenance & Lock dependsOn (Issue #35)

> **方針反転の note**: 本 PR は、下の Issue #13 で導入した「lock から annotation
> edge を除外」方針を反転し、annotation 由来も `dependsOn` に含める設計に再設計する。
> Issue #13 の SC-006「annotation 追記による churn が `check --gate` を倒さない」は、
> `check` 側が `contentHash` のみで drift 判定する設計で引き続き保証される（lock の
> `dependsOn` 変動は gate 失敗の判定には使われない）。

#### BREAKING (未リリースのため migration なし)

- `GraphEdge.provenances: NonEmptyArray<EdgeProvenance>` (旧
  `provenance?: EdgeProvenance`) を required・複数値化。同一
  `(source, target, kind)` が複数経路から生成された場合は集合 union で由来を保持する。
- `EdgeProvenance` を 8 値に拡張: `annotation` / `frontmatter` / `convention`
  / `code-tag` / `task-tag` / `inline-link` / `ts-import` / `structural`。
  旧 `tag` 値は廃止。
- `LockEntry.dependsOn` を `Array<{id: string; provenances: EdgeProvenance[]}>`
  に schema 化 (旧 `string[]`)。**旧 v1 形式の lock は `readLock` 段階で
  `LockSchemaError` で fail-fast (regenerate 要求)**。
- CLI JSON 出力 `provenance` (単数) を完全削除、`provenances` (複数) のみ emit。
- 旧 Issue #13 で導入した「lock から annotation edge を除外」フィルタを撤去。
  annotation 由来 `(depends_on: ...)` も `dependsOn` に
  `{id, provenances: ["annotation"]}` 形で書き込まれる。これにより下の
  「`.trace.lock` の `dependsOn` 配列は annotation edge を含まない」エントリは
  本 PR で **撤回 (superseded)** される。

#### Notes for existing users (Schema v2)

- 既存環境の `.trace.lock` (旧 `dependsOn: string[]` 形式) は次回
  `artgraph reconcile` で全エントリ書き直し新 schema に上書きされる。
  CI で `.trace.lock` の drift gate を運用している場合、Schema v2 移行直後の
  `reconcile` で 1 回 churn が発生することに注意。
- `artgraph graph --format json` の各 edge の `provenance` (単数) フィールドを
  parse している外部ツールがあれば、`provenances` (複数) へ追従する必要がある。
- 新 schema の `dependsOn` は現状 runtime では参照されない (drift 判定は
  `contentHash` のみ参照)。価値は (a) `git diff .trace.lock` で PR レビュー時に
  依存変化を可視化する presentational 用途、(b) `artgraph rename` 時の
  参照書き換え対象、の 2 点。1st-class consumer (`artgraph diff` 等) は
  future work。

### Changed

- **Package layout**: pnpm workspace を撤廃し単一パッケージ構成に変更
  (`packages/artgraph/{src,tests,templates,...}` → リポジトリ直下)。
  `eslint-plugin` 別パッケージ化計画 (#24) が見送られ workspace 層を維持する
  便益が無くなったため。配布物 (`dist/` + `templates/` + `bin/artgraph`) と
  npm install 経由の挙動は不変。Constitution v1.0.0 → v1.1.0
  (§技術基盤と制約 の Monorepo 規定を Package layout 規定に改訂)。

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
- **Major** _(superseded by Schema v2 / Issue #35 above)_: lock ファイル
  (`.trace.lock`) の `dependsOn` から annotation edge を除外。`(depends_on: X)`
  を追記しただけで lock が churn し `check --gate` が誤って失敗する問題を解消
  (contracts/provenance-field.md 通り)。**注**: Schema v2 ではこの除外を撤回し、
  annotation も `dependsOn` に含める。SC-006 の保証は `check` 側が
  `contentHash` のみで drift 判定する設計に移った。
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
- ~~`.trace.lock` の `dependsOn` 配列は annotation edge を含まない。
  `artgraph reconcile` 実行後の lock 差分には注釈追加分が現れないことを想定して
  ほしい~~ — **撤回 (superseded by Schema v2 / Issue #35 above)**: 同 Unreleased
  の Schema v2 で `dependsOn` は `Array<{id, provenances}>` 構造化され、
  annotation 由来も含めて出力される。SC-006「annotation 追記で `check --gate`
  を倒さない」は `check` 側が `contentHash` のみで drift 判定する設計で
  引き続き保証される (lock churn は gate 失敗とは無関係)。
