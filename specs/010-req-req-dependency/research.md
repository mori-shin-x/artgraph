# Phase 0: Research — req→req dependency annotation

Date: 2026-06-24
Spec: [spec.md](./spec.md) | Plan: [plan.md](./plan.md)

## R1. 注釈の正規表現と検出スコープ

**Decision**: 注釈は以下の単一正規表現で抽出する（list-item 行末尾、または heading 直下段落の冒頭・末尾のみで適用）:

```regex
\(\s*(depends_on|derives_from)\s*:\s*([^()]+?)\s*\)
```

抽出後の ID リスト（capture group 2）は `,` で split し、各 ID は前後空白を strip、
両端の `**` を strip した上で `reqPatterns.codeId` の正規表現にマッチするものだけ採用する。
マッチしない ID は警告 `invalid-annotation-id` を出し edge は生成しない。

**Rationale**:
- アンダースコア必須化で散文中の `(depends on ...)` を排除（FR-003）
- `[^()]+?` は非貪欲かつ括弧除外で `(depends_on: A)(depends_on: B)` を 2 マッチに分離（Edge Case）
- ID 解析は別ステップにすることで `**BOLD**`、空白、`,` の許容が単純化（FR-004/5/6）

**Alternatives considered**:
- 単一正規表現で ID 列まで完全に分解 → エスケープが複雑化、可読性低下
- AST ベース抽出（remark の inlineCode/text walk）→ オーバーキル、注釈は単一行内で完結する
- 注釈位置を「list-item 行 / heading 直下段落」に固定せず本文全域でマッチ → 誤検出リスク増、性能影響

## R2. heading 形式 req における注釈配置位置

**Decision**: heading 形式 req（`KIRO_HEADING_RE` でマッチする見出し）について、
注釈は以下のいずれかで認識する:

1. heading 直下の最初の段落の **先頭行** に独立した注釈括弧として出現
2. heading 直下の最初の段落の **末尾行** の末尾に出現

heading 行自体（`## Requirement 2: セッション管理 (depends_on: X)` の括弧）は注釈
として扱わない（spec.md US2 Acceptance Scenario 3 と整合）。
中間段落・複数段落をまたぐ配置は受理しない（spec Assumptions 通り、警告も出さない）。

**Rationale**:
- 先頭行 = 「要約一文の後に注釈を付ける」自然な書き方
- 末尾行 = 「段落の最後に補足として付ける」自然な書き方
- heading 行を注釈位置にしない理由は、heading text が `extractSectionContent` の起点に
  なっているため、heading 行の括弧式は要約タイトルの一部と区別できない（FR-002）
- 制限を厳しくすることで誤検出を抑える（取りこぼしは「位置を変えれば検出される」ため救済可）

**Alternatives considered**:
- heading 行末尾も受理 → タイトル内の括弧との区別不能、却下
- heading 直下「最初のリスト項目」 → SDD ツール出力にこのパターン稀、却下
- 段落内任意位置 → 誤検出リスク高、却下

## R3. 注釈除去ハッシュの実装方針

**Decision**: list-item req と heading req で別々の strip 関数を実装する。

- list-item req: `toString(node)` → 末尾の注釈括弧群（R1 の正規表現に該当する部分）を
  繰り返し置換除去 → trim → そのバイト列を `hash()` に渡す
- heading req: `extractSectionContent(content, startLine)` の出力に対し、最初の段落
  範囲（次の見出しまでの本文）の先頭行・末尾行から注釈括弧を除去 → そのバイト列を hash

removed 文字列のテスト容易化のため、`stripAnnotations(text: string): string` 純粋関数を
1 つ用意し、list-item / heading 共通で使う。

**Rationale**:
- 既存 hash 流路（`hash(toString(node))` / `hash(extractSectionContent(...))`）に最小
  侵襲で挿入できる
- 純粋関数化により単体テストで「注釈追加で hash 不変」を直接検証可能
- list-item と heading で文字列ソースが異なるため strip 適用位置は分けるが、strip
  ロジック本体は単一実装

**Alternatives considered**:
- AST 走査で注釈ノードを取り除く → remark の inlineCode/text ノードの分解粒度に依存、もろい
- list-item / heading で同一の strip 関数を全文に適用 → 散文中の注釈っぽい文字列を
  誤って除去するリスク（誤検出 → ハッシュ過剰除去）

## R4. provenance フィールド設計（Issue #35 との forward compatibility）

**Decision**: `GraphEdge` に optional フィールド `provenance?: EdgeProvenance` を追加。

```ts
export type EdgeProvenance = "annotation" | "frontmatter" | "convention" | "tag";

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  provenance?: EdgeProvenance;
}
```

本 issue では `"annotation"` のみ生成する（他は既存エッジに後追いで付与）。
Issue #35 の解決時に他値の付与と dedup 時の merge 戦略（複数 provenance を持つ
edge の表現）を確定する。

**Rationale**:
- フィールド名 `provenance` は Issue #35 本文で例示されている候補（"provenance / origin"）
  の一つ。一般的な用語で他値追加時にも違和感がない
- string union 型なら #35 で要素追加するだけで拡張可能
- optional にしておくことで既存テストへの破壊を回避

**Alternatives considered**:
- フィールド名 `origin` → 同等。`provenance` の方が「由来情報」の含意が広く #35 で
  追加されうる値（"manual", "lint-suggestion" 等）も収まる
- `provenance: string[]`（複数由来集合）→ dedup 戦略を本 issue で先取り決定する
  必要が生じる。#35 で扱うべき設計判断なので scalar に留める
- Phase 0 で型を固めず plan のみで言及 → builder の remap / lock 書き出しで参照する
  必要があり、型なしでは進めない

## R5. rename での注釈書換ロジック

**Decision**: `packages/artgraph/src/rename.ts` に `rewriteAnnotationIds` 関数を追加。

- 入力: ファイル content、`oldId`、`newId`、`RewriteOptions`
- 動作: 各行についてまず R1 の正規表現で注釈をマッチ → capture group 2 内の
  `,` 区切り ID リストを取り出し、`oldId` と等しい ID を `newId` に置換 → 注釈文字列を
  再構成して行に書き戻す
- fenced code block は `fencedLineSet` で除外（既存 F6 と整合）
- 同一注釈に `oldId` が複数回出現する場合は全て置換（spec US4 Acceptance Scenario 2）

CLI 統合は既存 `rewriteSpecListItem` / `rewriteImplTag` の呼び出し列に
`rewriteAnnotationIds` を追加する（rename.ts のオーケストレータ関数）。

**Rationale**:
- 注釈の検出位置は「list-item / heading 直下段落の冒頭・末尾」だが、rename は
  「ID 文字列の正確な書換」のみを保証すればよい。位置制約は parser 側だけで担保し、
  rename は注釈の正規表現マッチを全行に対し適用する（fenced 除外あり）
- 位置を厳格チェックしない理由: rename で「位置外の注釈っぽい文字列」を rewrite して
  しまっても、それは parser で edge 化されない=機能的に無害な書き換え。逆に位置
  チェックを rename に持ち込むと parser とのロジック二重化が起きる
- ただし、`(depends on AUTH-001)`（誤キーワード）は R1 にマッチしないため書き換え
  対象外。これは正しい挙動（注釈ではない散文に手を入れない）

**Alternatives considered**:
- parser 同等の位置チェックを rename にも実装 → ロジック重複、保守負荷
- `extractAnnotations` を parser から re-export して rename で再利用 → 注釈は parser
  では「位置付きで返す」のに対し rename では「行内の生文字列を書き換える」ため、戻り値
  シェイプが異なり再利用しにくい

## R6. builder における req→req target remap

**Decision**: `packages/artgraph/src/graph/builder.ts` の既存 `remapId(target, idMapping, collidingIds)`
ロジックを req→req エッジに対しても適用する。

- parser は注釈由来エッジを `req:<id>` ではなく素の `<id>` 形式で `target` に格納する
  （doc→req と同じ）
- builder は req→req エッジに対し既存ループ（L192 付近の `remappedTarget = remapId(...)`）と
  同一処理を通す
- 衝突 ID で remap 候補が一意に決まらない場合（同名 ID が複数 specDir に存在）、
  既存挙動と同様に警告 `ambiguous-id`（実装側の type 名）を出し edge は生成しない

**Rationale**:
- 既存 doc→req remap と完全に同一の処理パスに乗せられるため、新規ロジック追加なし
- 注釈由来かどうかに依存しない振る舞いとなり、provenance の有無で挙動が分岐しない（原則 II）

**Alternatives considered**:
- 注釈由来エッジは specDir 修飾形式（`010-auth/AUTH-001`）でしか書けない仕様にする →
  ユーザ書きづらい、却下
- 注釈側で specDir 明示を強制し remap 不要にする → 上記同様、却下

## R7. 警告タイプの一覧

新規追加する `ParseWarning` / `BuildWarning` の type 文字列:

| Warning type | 発生条件 | 出力箇所 |
|---|---|---|
| `invalid-annotation-id` | 注釈内の ID が `reqPatterns.codeId` にマッチしない | parser |
| `empty-annotation` | `(depends_on:)` / `(depends_on: )` のような空 ID | parser |
| `self-reference-annotation` | 注釈の依存先 ID が当該 req 自身の ID | builder |
| `ambiguous-id` | 注釈で参照された ID が複数 specDir で衝突し remap 不能 | builder（既存 `ambiguous-id` を流用。edge は生成しない） |

`orphan-edge`（参照先が存在しない）は既存型を再利用する。

**Rationale**: 警告 type は CLI 出力で集計され、運用者が grep で問題種別を絞り込む
ため、新規 type を最小限に保つ。`invalid-annotation-id` と `empty-annotation` は
注釈固有のため新規定義。

## 未確定の小論点（plan / tasks フェーズで決める）

- `extractAnnotations` の戻り値型 / インタフェース細目（位置情報を含めるか） → data-model.md で確定
- heading req の `extractSectionContent` 修正範囲（既存関数を分割するか専用 helper を追加するか） → 実装タスクで判断
- `ambiguous-annotation-target` を新規 warning type にするか既存 `ambiguous-target` を流用するか → 既存挙動との一貫性を実装時に再確認
