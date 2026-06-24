# Feature Specification: 要求 ⇔ 要求 (req→req) の依存をインライン注釈で表現する

Feature Branch: `feat/req-req-dependency-issue13`

Created: 2026-06-24

Status: Draft

Input: 要求 ID を構造化して書く運用のプロジェクト向けに、要求の箇条書き／見出し行にインライン注釈（例: `(depends_on: AUTH-001)` / `(derives_from: AUTH-001, AUTH-002)`）を書くことで req→req の `depends_on` / `derives_from` エッジを artgraph グラフに生成する。注釈の追加・変更で上流 req が drift 扱いにならないようハッシュは注釈除去版で計算する。

関連 Issue: #13 / 関連オープン: #35 (GraphEdge provenance)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - list-item 形式の要求に注釈で依存関係を書く (Priority: P1)

開発者が `spec.md` の要求リスト（`- AUTH-002: セッション管理`）に対し、行末尾へ
`(depends_on: AUTH-001)` のような注釈を追記する。`artgraph scan` を実行すると、
注釈から `AUTH-002 --depends_on--> AUTH-001` エッジがグラフに生成され、
`artgraph impact` で AUTH-001 を起点にしたとき AUTH-002 が影響範囲に入る。

Why this priority: 最も基本かつ Issue #13 の例文と完全一致するケース。
これ単独で MVP として価値が成立する（heading 形式や rename 連携が無くてもグラフ
出力が改善する）。

Independent Test: 同一 spec.md 内に `AUTH-001` と `AUTH-002 ... (depends_on: AUTH-001)`
を配置 → `artgraph scan` → グラフに `AUTH-002 --depends_on--> AUTH-001` エッジが存在
することを確認。

Acceptance Scenarios:

1. Given 同一 spec.md に `- AUTH-001: 認証` と `- AUTH-002: セッション管理 (depends_on: AUTH-001)` がある, When `artgraph scan` を実行する, Then `AUTH-002 --depends_on--> AUTH-001` エッジが生成される
2. Given list-item 行に `(derives_from: AUTH-001)` がある, When `artgraph scan` を実行する, Then `derives_from` 種別のエッジが生成される
3. Given 注釈に `(depends_on: AUTH-001, AUTH-003)` と複数 ID がカンマ区切りで列挙されている, When `artgraph scan` を実行する, Then 各 ID へ独立した `depends_on` エッジが生成される
4. Given 注釈に `(depends_on: **AUTH-001**)` のような Markdown 強調記法を含む ID が書かれている, When `artgraph scan` を実行する, Then `**` を除いた `AUTH-001` を target としたエッジが生成される
5. Given 注釈内のコロン前後・カンマ前後・括弧内縁に空白がある（例: `( depends_on : AUTH-001 , AUTH-002 )`）, When `artgraph scan` を実行する, Then 同じく正しい 2 本のエッジが生成される
6. Given list-item req 本体に注釈が無く、散文中に `(depends on AUTH-001)`（アンダースコア無し）が含まれている, When `artgraph scan` を実行する, Then 依存エッジは生成されない（誤検出ゼロ）

---

### User Story 2 - heading 形式の要求でも同じ依存表現を使える (Priority: P1)

開発者が Kiro `Requirement N:` のような heading 形式で要求を書いている。
heading 直下の最初の本文行（要約行）に `(depends_on: REQ-001)` を書くことで
list-item と同じ req→req エッジが生成される。これにより list-item / heading
どちらの執筆スタイルでも同じ抽象が使える。

Why this priority: Issue #13 で「heading 型 req は除外困難」と挙げられていた論点を
本仕様で明示的に解消する。Kiro 系出力を主に扱うプロジェクトでは US1 単独では
価値が成立しないため P1。

Independent Test: heading 形式の `## Requirement 2:` 直下に `(depends_on: Requirement-1)`
を含む 1 行を配置 → `artgraph scan` → エッジ生成を確認。

Acceptance Scenarios:

1. Given `## Requirement 2: セッション管理` の直下行に `(depends_on: Requirement-1)` がある, When `artgraph scan` を実行する, Then `Requirement-2 --depends_on--> Requirement-1` エッジが生成される
2. Given heading 直下に通常の本文段落があり、その末尾に `(depends_on: REQ-001)` が混入している, When `artgraph scan` を実行する, Then 注釈は heading 直下「最初の段落の冒頭または末尾」に限定し、本文内の括弧式は誤検出しない
3. Given heading 直下に注釈が無く、heading 本文に `(depends_on: X)` が含まれている, When `artgraph scan` を実行する, Then 依存エッジは生成されない（heading 行自体を注釈位置にしない）

---

### User Story 3 - 注釈の追加・変更で上流 req が drift 扱いにならない (Priority: P1)

要求文の content-hash で drift を検出する artgraph の判定ロジックが、注釈の
追記によって誤発火しないことを開発者が信頼できる。注釈は本文 content-hash の
計算から除外されるため、依存関係の追記・修正は req の意味的変更と区別される。

Why this priority: Constitution 原則 I（決定的グラフ第一）の中核に直結する。
US1/US2 が成立しても本要件が崩れていると「依存を追加しただけで関連する全
コードが drift 扱いになる」状況が起き、機能としては有害。NON-NEGOTIABLE。

Independent Test: 既存の AUTH-002 req の content-hash を記録 → 後から
`(depends_on: AUTH-001)` を追記 → 再 scan → AUTH-002 の content-hash が
変動しないこと、`artgraph check` で AUTH-002 由来の drift が発生しないことを確認。

Acceptance Scenarios:

1. Given list-item req `- AUTH-002: セッション` の content-hash が記録されている, When 同行末尾に `(depends_on: AUTH-001)` を追記して再 scan, Then AUTH-002 の content-hash は不変
2. Given heading 形式 req の content-hash が記録されている, When heading 直下に `(depends_on: REQ-001)` を追記して再 scan, Then 当該 req の content-hash は不変
3. Given 注釈の依存先 ID を `AUTH-001` から `AUTH-001, AUTH-003` に変更, When 再 scan, Then req 本体の content-hash は不変（注釈変更は drift 判定の対象外）
4. Given 注釈は変えずに req の説明文（`セッション管理` → `セッション維持`）を変更, When 再 scan, Then 当該 req の content-hash は変動し drift が検出される（本文変更は従来通り検出されること）

---

### User Story 4 - REQ ID rename で注釈内の依存参照も追従する (Priority: P2)

開発者が `artgraph rename AUTH-001 AUTH-100` を実行すると、依存先として
`AUTH-001` を参照しているすべての注釈（`(depends_on: AUTH-001)` /
`(derives_from: AUTH-001)`）が `AUTH-100` に書き換わる。これにより
rename 後にグラフ上で依存リンクが失われない。

Why this priority: US1/US2/US3 が完成すれば最低限の機能は使える（注釈は手動で
追従可能）ため P2。ただしこれが無いと既存の rename ワークフロー（`req:` キーの
追従と同水準のサポート）と非対称になり中期的に運用負荷が高い。

Independent Test: `(depends_on: AUTH-001)` を含む spec.md がある状態で
`artgraph rename AUTH-001 AUTH-100` を実行 → 当該注釈が `(depends_on: AUTH-100)`
に書き換わっていることを確認。

Acceptance Scenarios:

1. Given `(depends_on: AUTH-001)` が複数ファイルに存在する, When `artgraph rename AUTH-001 AUTH-100` を実行, Then すべての該当注釈が `(depends_on: AUTH-100)` に書き換わる
2. Given `(depends_on: AUTH-001, AUTH-002, AUTH-001)` のような複数 ID 注釈に `AUTH-001` が含まれる, When `AUTH-001 → AUTH-100` rename, Then 該当 ID のみが置換され他 ID は不変、結果は `(depends_on: AUTH-100, AUTH-002, AUTH-100)`
3. Given fenced code block 内の `(depends_on: AUTH-001)` がある, When rename を実行, Then code block 内は書き換えられない（既存 F6 規約を踏襲）
4. Given 注釈ではない散文中の `AUTH-001` 文字列, When rename を実行, Then 注釈のスコープ外として扱う（既存 rename ロジックの責務範囲外）

---

### Edge Cases

- **同名 ID 衝突（builder の req→req target remap）**: 異なる specDir に同じ ID（`AUTH-001`）の req があり、注釈が `(depends_on: AUTH-001)` と書かれた場合、builder は既存の `specDir/REQ` 衝突解決ロジックを適用してターゲットを解決する（doc→req と同様の規約）。曖昧で解決できない場合は警告を出して edge を生成しない。
- **存在しない依存先 ID**: 注釈で参照された ID がグラフ内のどの req とも一致しない場合、edge は生成され target はそのまま記録される（`orphan-edge` 相当の警告）。既存 doc→req の挙動と同様。
- **自己参照**: `AUTH-001` 自身に `(depends_on: AUTH-001)` を書いた場合、警告を出して edge を生成しない。
- **同一行に keyword が複数回**: `(depends_on: A)(depends_on: B)` のように同一行で同じ keyword が複数回出現した場合、すべてを受理して edge を生成する（v1 では順序・重複は dedup）。
- **異なる keyword の混在**: 同一行で `(depends_on: A)(derives_from: B)` のように両 keyword を独立した注釈で書ける（v1 で許容）。ただし 1 注釈括弧内に複数 keyword を混在させる形式（`(depends_on: A; derives_from: B)` 等）は受理しない。
- **空の注釈**: `(depends_on:)` や `(depends_on: )` は警告を出して無視。
- **fenced code block 内の注釈**: パース対象外（既存 F6 規約に従う）。
- **不正な ID 文字**: ID 文字列が config の `reqPatterns.codeId` 形式に合致しない場合は警告して無視。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST list-item 形式 req 行の末尾に書かれた `(depends_on: ID1, ID2, ...)` および `(derives_from: ID1, ID2, ...)` 注釈を認識する。
- **FR-002**: System MUST heading 形式 req（既存の `LIST_ITEM_RE` / `KIRO_HEADING_RE` で検出する req）について、heading 直下にある最初の段落ブロックの **先頭行** または **末尾行** に出現する独立した注釈括弧を認識する（段落が単一行の場合はその 1 行）。中間行や複数行にまたがる注釈は認識しない。
- **FR-003**: System MUST 注釈の許容キーワードを `depends_on` と `derives_from` のみに限定し、`depends on`（アンダースコアなし）など散文中の英語表現は誤検出しない。
- **FR-004**: System MUST 1 注釈内に複数 ID をカンマ区切りで列挙できる（`(depends_on: A, B, C)`）。各 ID は独立した同種別 edge を生成する。
- **FR-005**: System MUST `**ID**` 形式の Markdown 強調を ID から剥がして edge target とする（`(depends_on: **AUTH-001**)` → target `AUTH-001`）。
- **FR-006**: System MUST 注釈内の空白バリエーション（括弧の内縁、コロンの前後、カンマの前後）を許容する。
- **FR-007**: System MUST 注釈の追加・変更・削除によって当該 req の content-hash が変動しないよう、ハッシュ計算前に注釈相当の文字列を本文から除去する（list-item / heading の両形式で）。
- **FR-008**: System MUST 注釈由来の req→req エッジに provenance 由来情報（値: `"annotation"` 相当、フィールド名は #35 解決時の語彙に追従可能な形）を保持する。
- **FR-009**: System MUST 注釈で参照された ID を builder 既存の req→req target remap（衝突 ID の `specDir/REQ` 解決）に通す。
- **FR-010**: System MUST `artgraph rename OLD NEW` 実行時に、すべての注釈括弧内の依存先 ID のうち `OLD` に一致するものを `NEW` に書き換える（fenced code block 内は対象外）。
- **FR-011**: System MUST 自己参照（注釈が含まれる req と同一 ID を依存先に指定）に対して警告を出力し、当該 edge は生成しない。
- **FR-012**: System MUST 注釈で参照された ID がグラフ内のどの req とも一致しない場合、`orphan-edge` 警告を出力する（edge 自体は doc→req と同様の挙動で生成）。
- **FR-013**: System MUST 空の注釈（`(depends_on:)`）に対して警告を出力し、edge は生成しない。
- **FR-014**: System MUST 注釈構文の testbed として 10 件以上のテストケース（誤検出系・許容空白系・複数 ID 系・`**BOLD**` 系・誤キーワード系・heading 配置系・同一行 multi-keyword 系・dedup 系を含む）で誤検出ゼロを担保する。最低限の testbed は [`contracts/annotation-grammar.md`](./contracts/annotation-grammar.md) の「期待される単体テストケース」リスト全件とする。
- **FR-015**: System MUST 注釈の位置・形式が許容範囲外（中間行・複数行にまたがる注釈、heading 行自体の括弧式、リスト項目外の散文中、fenced code block 内 等）の場合、**警告を出さず無視** する。一方、許容位置内かつ構文上は注釈として認識できるが内容が不正な場合（空 ID リスト、`reqPatterns.codeId` にマッチしない ID、自己参照）は **必ず警告を emit** する（FR-011 / FR-013 / `invalid-annotation-id`）。

### Key Entities

- **req→req エッジ (Annotation Edge)**: source = 注釈を含む req の ID、target = 注釈内に列挙された依存先 ID、kind = `depends_on` または `derives_from`、provenance = `annotation` 相当。グラフ上では doc→req の `depends_on` / `derives_from` エッジと同じ kind を共有するが provenance で由来が区別できる。
- **注釈 (Inline Annotation)**: 1 つの注釈は「括弧 `(` `)` で囲まれた単一 keyword + コロン + 1 つ以上の ID リスト」の組。1 req に対し複数注釈（同 keyword・別 keyword）を独立して書ける。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 構造化 req 運用のプロジェクト（要求 ID を箇条書きや heading で明示する Spec Kit / Kiro / OpenSpec 形式）において、req 間の依存関係をグラフ上で可視化できる req の割合が、現状（注釈未対応）に対して 80% 以上カバーされる。
- **SC-002**: list-item / heading 双方を含む 10 件以上の代表的注釈パターンと、その対称となる誤検出パターン（散文中の `(depends on ...)` 等）10 件以上で構成される回帰テスト群で、誤検出率 0%・取りこぼし率 0% を達成する。
- **SC-003**: 既存 req に対し依存注釈を追記しても、当該 req に紐づくコード／テストが drift / re-verify 扱いに変化しない（content-hash が不変）。SC として「100% のケースで drift 影響ゼロ」。
- **SC-004**: `artgraph rename OLD NEW` 実行後、グラフを再構築すると rename 前後で依存エッジ本数が一致し、孤立 edge（orphan-edge）が増えない。
- **SC-005**: 既存の 4 層グラフ出力（`artgraph graph`）に provenance 付き req→req エッジが現れ、Issue #35 解決時に追加変更なくフィールド名の置換だけで取り込める。

## Assumptions

- 注釈は list-item req 行の **末尾**、または heading 形式 req の直下「最初の段落の冒頭または末尾」に書く運用前提。req 本文の中間や複数段落をまたぐ位置は v1 では対象外。
- 注釈キーワードは `depends_on` / `derives_from` の 2 種のみ。`required_by` / `blocks` 等の追加キーワードは将来 issue で別途検討（v1 スコープ外）。
- 注釈内 ID の正規表現は config の `reqPatterns.codeId`（または default の `[A-Z][A-Za-z]*-\d+` 系）に従う。プロジェクト独自パターンも既存設定をそのまま流用する。
- provenance フィールドの正式な型／名称は Issue #35 で確定する。本 issue では「将来 #35 解決時に低コストで追従できる形」で実装する（具体的なフィールド名・enum 値は plan フェーズで決定）。
- 循環依存（A→B→A 等）の検出は本 issue のスコープ外。グラフ全体の整合性チェック（`artgraph check`）の責務として別途扱う。
- 同一 spec.md 内の同一 keyword の重複注釈（`(depends_on: A)(depends_on: A)`）は dedup される（同じ source / target / kind の edge を複数本持たない）。
- 既存の fenced code block スキップ規約（F6）は注釈抽出・rename の両方で踏襲する。
- 注釈の位置・形式が許容範囲外の場合の挙動は FR-015 を参照（silent skip と warn の境界はそこで明文化）。
