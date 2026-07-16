# Feature Specification: impact BFS の contains 辺方向制約 — 同一 spec 兄弟 REQ の巻き込み解消

**Feature Branch**: `feat/impact-doc-containment`

**Created**: 2026-07-10

**Status**: Draft

**Input**: Issue [#215](https://github.com/mori-shin-x/artgraph/issues/215) — 「`artgraph impact <file>:<symbol>` が、コード上の依存 (import / 呼び出し) がゼロでも、対象 REQ と同じ spec ドキュメントファイルに同居している他の全 REQ を Impact reqs / Drift candidates に巻き込む。Spec Kit / Kiro の標準は『1 feature = 1 spec.md に複数 REQ』なので、この構成では symbol 単位で impact を引いても実質その feature の全 REQ が毎回返ってくることになり、"per-change context" という中核の価値提案が最も一般的なプロジェクト構成で機能しない。」

**Parent issue**: [#215](https://github.com/mori-shin-x/artgraph/issues/215)

**Related**:

- spec 014 / spec 016 ([#104](https://github.com/mori-shin-x/artgraph/issues/104), [#107](https://github.com/mori-shin-x/artgraph/issues/107)) — 現行 BFS セマンティクス(全辺無条件双方向)の出自。`src/graph/traverse.ts` 冒頭コメントは「req → 親 doc → 兄弟 reqs への到達は意図された設計」と明記しており、**本 spec はその設計判断を上書きする**。本 spec マージ後は本 spec が traversal セマンティクスの SSOT。
- [#177](https://github.com/mori-shin-x/artgraph/issues/177) / [#179](https://github.com/mori-shin-x/artgraph/issues/179) / [#188](https://github.com/mori-shin-x/artgraph/issues/188) — symbol-level 精度改善の系譜。doc 経由の巻き込みが支配的な現状ではこれらの効果が観測できず、本 spec が解決して初めてフルに効く。
- [#218](https://github.com/mori-shin-x/artgraph/issues/218) — クラスメソッド粒度。本 spec 解決後に次の支配的な過剰検知源となる後続課題。本 spec のスコープ外。
- [#122](https://github.com/mori-shin-x/artgraph/issues/122) (closed) — tag-zero impact UX。`ts-import` エッジのみの経路で req / doc ノードを経由しないため、本 spec の変更の影響を受けない。既存 brownfield E2E が回帰ガードになる。
- spec 008 (document-graph) — doc↔doc の `derives_from` / `depends_on` 辺。本 spec は `contains` 辺のみを対象とし、doc 間辺のセマンティクスは変更しない。
- spec 017 (check-gate-baseline-diff) — `check --diff` の scoped arrays は impact() の到達集合から計算されるため、本 spec により縮小する(US3)。
- [#229](https://github.com/mori-shin-x/artgraph/issues/229) — コードのみ diff での `@impl` タグ削除がスコープ外に落ちる境界問題。現行でも確実には検出されておらず(doc 経由の偶然の検出のみ)、本 spec の設計レビューで切り出したフォローアップ。本 spec のスコープ外 (FR-014)。

**前提**: artgraph は公開済みだが 0.1 であり実利用者はいない想定。作者判断 (2026-07-10 設計レビュー) により**破壊的変更を許容**する — 後方互換・移行導線・非推奨期間は一切考慮せず、traversal セマンティクスを clean に変更する。兄弟 REQ 到達を assert している既存テスト・fixture は新セマンティクスに書き直す(削除ではなく期待値の反転として明示的にレビュー可能にする)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — symbol 起点 impact から同一 spec 兄弟 REQ を排除 (Priority: P1)

ユーザーが Spec Kit 標準構成(1 つの spec.md に REQ-901 / REQ-902 を記述)で、`fnA` (`@impl REQ-901`) と `fnB` (`@impl REQ-902`) を実装している。`fnA` は `fnB` を一切呼んでいない。`artgraph impact src/sample.ts:fnA` を実行すると、Impact reqs は `REQ-901` のみ、Drift candidates にも Affected files にも `REQ-902` / `fnB` 側のファイルは現れない。一方、REQ-901 が属する spec ドキュメントは「この変更がどの spec の話か」の帰属情報として Affected docs に残り続ける。

**Why this priority**: Issue #215 の存在理由そのもの。「変更に関連する REQ だけを agent に渡す」という per-change context の中核価値が、最も一般的なプロジェクト構成(1 feature = 1 spec.md に複数 REQ)で機能しない状態を解消する。spec 016 で積んだ symbol 粒度・二軸出力の投資は、doc 経由の巻き込みが支配的な現状では回収できていない。

**Independent Test**: `fnA` (`@impl REQ-901`) / `fnB` (`@impl REQ-902`) が同一ファイルにあり、REQ-901 / REQ-902 が同一 spec.md にある fixture を symbol mode で scan する。`artgraph impact src/sample.ts:fnA --format json` の `impactReqs` が `["REQ-901"]` であることを assert する。

**Acceptance Scenarios**:

1. **Given** 同一ファイルの `fnA` (`@impl REQ-901`) / `fnB` (`@impl REQ-902`)、REQ-901/902 が同一 spec.md、fnA→fnB のコード依存なし、 **When** `artgraph impact src/sample.ts:fnA --format json`、 **Then** `impactReqs = ["REQ-901"]`。`REQ-902` は `impactReqs` / `drifted` に含まれない (issue #215 再現手順 1 の非再現)。
2. **Given** `fnA` / `fnB` を別ファイル (`src/sample.ts` / `src/other.ts`) に分けた同構成、 **When** 同コマンド、 **Then** `impactReqs = ["REQ-901"]` かつ `affectedFiles` に `src/other.ts` が含まれない (issue #215 再現手順 2 の非再現)。
3. **Given** 同構成で `fnA` が `fnB` を import して呼んでいる、 **When** 同コマンド、 **Then** `imports` 辺経由の到達により `REQ-902` / `src/other.ts` は**含まれる** (コード依存由来の巻き込みは正当な blast radius として維持)。
4. **Given** シナリオ 1 の構成、 **When** 同コマンド、 **Then** `affectedDocs` に REQ-901 の親 spec doc が含まれる(帰属メタデータ)。親 doc の contentHash が lock と異なる場合は `drifted` に doc entry として現れる。
5. **Given** REQ-901 / REQ-902 を別々の spec ファイルに分けた構成、 **When** 同コマンド、 **Then** 従来 (issue #215 再現手順 3) と同一の結果 — 挙動不変。
6. **Given** シナリオ 1 の構成に spec 側で `REQ-901 depends_on REQ-903` (REQ-903 は別 spec) を追加、 **When** 同コマンド、 **Then** `impactReqs = ["REQ-901", "REQ-903"]` — req→req 辺経由の到達は維持され、spec 016 の二軸ドリフト検知 (`impactReqs \ originReqs`) が引き続き機能する。

---

### User Story 2 — plan-coverage のドリフト候補軸の浄化 (Priority: P1)

ユーザーが spec 016 US1 の標準フロー(tasks.md に `Files: src/auth.ts:validateToken`)を、Spec Kit 標準構成(REQ-001 / REQ-005 / REQ-009 が**同一 spec.md** に同居)で回す。`artgraph plan-coverage --format json` の per-entry `impactReqs` にはコード依存由来の REQ のみが載り、同一 doc 同居だけを理由とする兄弟 REQ は載らない。これにより `impactReqs \ originReqs` のドリフト候補軸が「spec 側で増えた依存」だけを指すようになる。

**Why this priority**: 同一 spec 内の兄弟 REQ は spec.md に定義されている時点で mention 済みとなるため `implicit` リストには出ないが、per-entry の `impactReqs` には現状混入し続け、ドリフト候補軸 (`impactReqs \ originReqs`) を常時汚染する。spec 016 が設計した二軸比較は同一 spec 複数 REQ 構成では実質使えない。US1 と同じ BFS 修正で自動的に直るが、plan-coverage 側の観測点として独立に固定する。

**Independent Test**: spec 016 US1 の fixture (validateToken/issueToken/revokeToken、各 `@impl REQ-001/005/009`) の 3 REQ を**同一 spec.md** に配置し直し、tasks.md に `Files: src/auth.ts:validateToken` のみを書いて `artgraph plan-coverage --format json` を実行。`implicitImpacts[0].impactReqs` が `[{reqId: "REQ-001", ...}]` のみであることを assert する。

**Acceptance Scenarios**:

1. **Given** REQ-001 / REQ-005 / REQ-009 が同一 spec.md、`src/auth.ts` の 3 symbol が各々を `@impl`、tasks.md に `Files: src/auth.ts:validateToken`、 **When** `artgraph plan-coverage --format json`、 **Then** `implicitImpacts[0].impactReqs` は REQ-001 のみ。`originReqs = ["REQ-001"]` との二軸差分は空(ドリフトなしが正しく観測できる)。
2. **Given** 同構成に spec 側で `REQ-001 depends_on REQ-007` を追加、 **When** 同コマンド、 **Then** `impactReqs = [REQ-001, REQ-007]` / `originReqs = [REQ-001]` — ドリフト候補は依存由来の REQ-007 のみで、REQ-005 / REQ-009 は混入しない (spec 016 US1 シナリオ 6 の同一 spec 版)。

---

### User Story 3 — `check --diff` スコープの浄化と spec 変更経路の維持 (Priority: P1)

ユーザーがコードファイル 1 個だけを変更して `artgraph check --diff` を実行すると、scoped arrays (`drifted` / `orphans` / `uncovered` / `coverage`) の範囲はその変更が実際に到達する REQ 群に限定され、同一 spec に同居しているだけの兄弟 REQ の負債(uncovered 等)が「in range の pre-existing debt」としてカウントされない。一方、spec.md 自体を変更した場合は従来どおりその spec の全 REQ がスコープに入る(新 REQ 追加 → uncovered 検出のゲート経路は無退行)。

**Why this priority**: `check --diff` は impact() の到達集合でスコープを計算するため、US1 の BFS 変更が自動的に波及する。波及自体は望ましい(スコープの意味が正しくなり `suppressedCount` のノイズが減る)が、**ゲートの挙動変更**なので受け入れシナリオとして明示的に固定し、特に「spec ファイル変更時は全 REQ がスコープに残る」ことを退行テストで担保する。

**Independent Test**: 同一 spec.md に REQ-A (`@impl` あり) / REQ-B (`@impl` なし = uncovered) がある fixture で、REQ-A の実装ファイルのみを diff に含めて `check --diff --format json` を実行し、`uncovered` に REQ-B が含まれないことを assert する。次に spec.md 自体を diff に含めて再実行し、REQ-B が `uncovered` に含まれることを assert する。

**Acceptance Scenarios**:

1. **Given** 同一 spec.md の REQ-A (実装あり) / REQ-B (実装なし)、diff は REQ-A の実装ファイルのみ、 **When** `check --diff`、 **Then** scoped `uncovered` に REQ-B が含まれない。
2. **Given** 同構成で diff に spec.md 自体が含まれる、 **When** `check --diff`、 **Then** REQ-B が `uncovered` としてスコープに入る(`resolveStartIds` の filePath fallback が doc / 全 req ノードを seed し、順方向 contains もこれを補強する)。
3. **Given** spec.md に新 REQ を追記し実装を追加する通常の SDD ループ、 **When** `check --diff`、 **Then** 従来と同じ検出結果(spec 変更経路の無退行)。

---

### User Story 4 — 兄弟 REQ の情報専用軸 `sameSpecReqs` (Priority: Deferred — 本 spec では実装しない)

> **設計レビュー裁定 (2026-07-10)**: 実装見送り。理由: (a) FR-004 の帰属アトリビューションにより「文脈が欲しければ `affectedDocs` の spec を読む」という迂回路が常に存在し、agent ワークフローはそれで足りる (Skill に 1 行書けば済む)。(b) 出力フィールドは後から足すのは非破壊だが消すのは破壊的で、非対称性は延期に有利。(c) ドッグフーディング 4 ループで文脈不足の実需は観測されておらず、困っていたのは常に文脈過多だった。絞った出力をドッグフーディングした上で、具体的なワークフローが要求したら足す。以下の記述は将来の設計スケッチとして残置する。

「同じ spec の兄弟 REQ も参考情報としては見たい」ユーザー(例: agent が変更前に feature 全体の文脈を掴みたいケース)のために、`artgraph impact` の出力に `sameSpecReqs` — affected docs に含まれる REQ のうち `impactReqs` に入らなかったもの — を**情報専用の別軸**として載せる。この軸は Drift candidates に一切寄与せず、text 出力でも「Same-spec REQs (informational)」として明確に区別される。

**Why this priority**: Issue #215 の対応方向 2 の採用。巻き込みを止めた上でなお「同一 feature の文脈」が欲しい場面は agent workflow で現実にあるが、blast radius と混ざることが害だったのであり、分離されたチャネルなら価値になる。ただし P1 (巻き込み排除) が成立すれば `affectedDocs` から spec を読めば同じ情報に到達できるため、優先度は P2。

**Independent Test**: US1 シナリオ 1 の fixture で `artgraph impact src/sample.ts:fnA --format json` を実行し、`sameSpecReqs = ["REQ-902"]` かつ `drifted` に REQ-902 が含まれないことを assert する。

**Acceptance Scenarios**:

1. **Given** US1 シナリオ 1 の構成、 **When** `impact --format json`、 **Then** 出力 JSON に `sameSpecReqs: ["REQ-902"]` が含まれ、`impactReqs` / `drifted` には含まれない。
2. **Given** 同構成、 **When** text 出力 (`--format` なし)、 **Then** 「Same-spec REQs (informational)」等の独立セクションに REQ-902 が表示され、Impact reqs / Drift candidates セクションとは視覚的に区別される。
3. **Given** REQ-902 の contentHash が lock と drift している、 **When** `impact --format json`、 **Then** REQ-902 は `sameSpecReqs` に載るが `drifted` には載らない(情報軸は drift 判定対象外)。
4. **Given** すべての同 doc REQ が impactReqs に含まれる(依存で全到達)、 **When** 同コマンド、 **Then** `sameSpecReqs = []`。
5. `plan-coverage` / `check` の出力スキーマには `sameSpecReqs` を**追加しない**(スコープ外宣言 — FR-014)。

---

### User Story 5 — ドキュメント / Skill / dogfood テンプレートの追随 (Priority: P2)

traversal セマンティクスの SSOT が変わるため、(a) `src/graph/traverse.ts` 冒頭の設計コメント(旧「意図された設計」宣言)を本 spec 準拠に書き換え、(b) README / docs/skills-guide.md の impact 説明、(c) `artgraph-impact` / `artgraph-plan-coverage` Skill の出力解説、(d) 5 agent path に配布される dogfood テンプレート(byte-identical 同期テストあり)を更新する。

**Why this priority**: コメント・ドキュメントが旧設計を「意図」と主張したまま実装だけ変わると、次の開発者(або agent)が回帰させるリスクが高い。#215 の調査でも traverse.ts のコメントが「これはバグではなく設計」という誤誘導の起点になった。

**Acceptance Scenarios**:

1. **Given** 本 spec の実装マージ後、 **When** `src/graph/traverse.ts` を読む、 **Then** 冒頭コメントが「contains は順方向のみ・親 doc は帰属アトリビューション」という新セマンティクスを spec 019 参照付きで説明している。
2. **Given** Skill テンプレート更新後、 **When** dogfood 同期テストを実行、 **Then** 5 agent path すべてで byte-identical に通る。

---

### Edge Cases

- **同一 REQ ID が複数 doc に含まれる場合**: 帰属アトリビューションは該当するすべての親 doc を `affectedDocs` に列挙する。
- **`maxDepth` 指定時**: 親 doc の帰属アトリビューションは BFS の到達集合に対する後処理であり、depth を消費しない。`maxDepth` の意味は「グラフ辺のトラバース段数」のまま変わらない(従来コメントの「contains の広がりすぎを maxDepth で抑える」という回避策は不要になり、記述を削除する)。
- **`contains` は doc→task 辺にも存在する** (tasks.md 由来): 方向制約は req と task に等しく適用する。task 起点/経由の traversal が tasks.md の兄弟 task を巻き込む同型の問題も同時に解消され、親 doc (tasks.md) は帰属として `affectedDocs` に残る。
- **`autoContains: false` 構成**: contains 辺が存在しないため帰属アトリビューションは空集合。従来との差分なし。(spec 021 追記) この記述は doc 系 contains (doc→req|task) に限る — spec 021 のクラスメソッド粒度が導入する class→method contains は `docGraph.autoContains` 設定に従わず常時生成される (spec 021 FR-006 参照)。
- **lock に親 doc が存在しない場合**: 既存の drift 判定と同じく skip(`lock[id]` が無ければ判定しない)。
- **起点自体が doc / spec パスの場合** (`artgraph impact specs/auth.md`): `resolveStartIds` の filePath fallback が doc ノードと全 req ノードを直接 seed するため、方向制約後も spec→code 方向の全展開が維持される。加えて doc ノードからの順方向 contains 展開も従来どおり機能する。
- **seed された doc からの doc↔doc 辺経由の到達**: 起点 / diff に spec ファイルが入った場合、その doc から `depends_on` / `derives_from` (inline link / frontmatter / convention) で繋がる別 doc とその配下 REQ には従来どおり到達する (旧実装と同一挙動 — doc↔doc 辺セマンティクスは FR-014(d) でスコープ外)。US3 / FR-011 の「当該 spec の全 REQ がスコープに入る」は、この既存の doc 間到達を制限する意図ではない (PR #232 レビューで確認した列挙ギャップの補記)。
- **req↔doc の往復による無限ループ**: 方向制約により構造的に発生しなくなる(従来は visited set で抑止していた)。
- **1 つの task が複数 REQ を参照する場合** (`T010 ... [REQ-901, REQ-902]`): `REQ-901 → (逆implements) T010 → (順implements) REQ-902` のブリッジは**残る(意図)**。doc 同居と異なり「作者が明示的に 1 つの作業単位に束ねた」という task-tag 由来の宣言であり、因果的に意味がある。ただし Spec Kit convergence phase のような「1 task に大量の REQ 列挙」パターンがノイズ源になるかはドッグフーディングで観測する (watch item)。
- **コードのみ diff での `@impl` タグ削除**: 削除で `implements` 辺ごと消えるため、新たに uncovered になった REQ へ到達できずスコープ外に落ちる。現行実装でも最小構成では素通りしており (doc 経由で偶然捕まる場合があるだけ)、本 spec の退行ではなく既存の境界問題。[#229](https://github.com/mori-shin-x/artgraph/issues/229) で独立に扱う (FR-014g)。

## Requirements *(mandatory)*

### Functional Requirements

#### BFS 方向制約 (core)

- **FR-001**: `impact()` の BFS は `contains` 辺を**順方向のみ** (edge.source = doc → edge.target = req|task) 辿る。逆方向 (req|task → 親 doc) はトラバースしない。
- **FR-002**: `contains` 以外の 5 辺種 (`depends_on` / `derives_from` / `implements` / `verifies` / `imports`) の双方向トラバース、および file→symbol 展開 (spec 016 R-006 の挙動) は一切変更しない。**issue #303 による事後修正**: この不変性は `verifies` / `imports` について部分的に狭められた。reverse `verifies`/`imports` で `kind: test` のノードへ到達した場合、その到達に限り「制限付きテストハブ」となり、当該ハブ自身の forward `verifies` は target REQ が evidence-only (`implements` 辺を全く持たない) の場合のみ許可、forward `imports` は常に不許可となる — test ノードがハブとなって無関係な sibling REQ / sibling ファイルへブリッジする leak (#215 / #286 と同じクラス) を防ぐため。test 以外のノードへの reverse `verifies`/`imports`、および test ノード自身を startId とした到達は無制限のまま、5 辺種のうち `depends_on` / `derives_from` / `implements` は完全に無制限のまま。詳細は `src/graph/traverse.ts` のファイルヘッダコメント(issue #303 節)および spec 020 FR-017 を参照。
- **FR-003**: 方向制約は `contains` 辺の target 種別 (req / task) を問わず一律に適用する。**これは一貫性のためではなく修正の成立条件である**: task preset が有効なプロジェクト (Spec Kit の `T\d{3}` 等) では tasks.md の各 task が参照 REQ への `implements` 辺 (task-tag provenance) を持ち、feature の tasks.md は集合としてその feature のほぼ全 REQ を参照する。req のみ制約して task を除外すると、`REQ → (逆implements) task → (逆contains) doc:tasks.md → (順contains) 兄弟 task → (順implements) feature 全 REQ` の経路で #215 の症状がほぼ完全に復活する。

#### 親 doc の帰属アトリビューション

- **FR-004**: BFS 完了後、到達した req / task ノードそれぞれについて、当該ノードを target とする `contains` 辺の source doc を解決し、`affectedDocs` に追加する (dedup、BFS で直接到達した doc との重複は集合として collapse)。
- **FR-005**: 帰属アトリビューションで追加された doc も、BFS で直接到達した doc と同様に drift 判定 (lock との contentHash 比較) の対象とする。
- **FR-006**: 帰属アトリビューションで追加された doc から先へのグラフ展開は行わない (その doc の子 req が `impactReqs` / `affectedFiles` / `drifted` に寄与しない)。

#### `sameSpecReqs` 情報軸 (Deferred — 実装対象外、将来の設計スケッチ)

- **FR-007**: `sameSpecReqs` は「`affectedDocs` (BFS 到達 + 帰属アトリビューション) の contains 子 req のうち `impactReqs` に含まれないもの」と定義し、dedup + reqId 昇順で返す。
- **FR-008**: `sameSpecReqs` は `artgraph impact` の JSON / text 出力にのみ載せる。text 出力では Impact reqs / Drift candidates と明確に区別された informational セクションとする。`sameSpecReqs` の要素は `drifted` の対象にならない。
- **FR-009**: `sameSpecReqs` の算出は `resolveOriginReqs` と同じパターン(traverse 層の独立ヘルパーを CLI 層が呼ぶ)とし、`impact()` 本体の戻り値契約への追加は最小限に留める。plan-coverage / check はこのヘルパーを呼ばない。

#### 呼び出し元への波及の固定

- **FR-010**: `plan-coverage` の per-entry `impactReqs` に、同一 doc 同居のみを理由とする兄弟 REQ が混入しないこと (US2 — BFS 変更の自動波及をテストで固定)。
- **FR-011**: `check --diff` の scoped arrays に、コード側変更起点で兄弟 REQ 由来の項目が混入しないこと。spec ファイルが diff に含まれる場合は当該 spec の全 REQ がスコープに入ること (US3)。

#### ドキュメント / Skill

- **FR-012**: `src/graph/traverse.ts` 冒頭の設計コメント (spec 014/016 由来の「bidirectional は意図」宣言) を本 spec 準拠に書き換え、spec 019 を参照させる。maxDepth による回避策の記述を削除する。
- **FR-013**: README / docs/skills-guide.md / `artgraph-impact` / `artgraph-plan-coverage` Skill テンプレートの impact 出力説明を新セマンティクス (同一 spec 同居は blast radius に入らない・feature 文脈は `affectedDocs` の spec を読む) に更新し、dogfood テンプレート 5 agent path の byte-identical 同期を維持する。

#### Scope exclusion (明示)

- **FR-014**: 以下は本 spec のスコープ外: (a) #218 クラスメソッド粒度、(b) REQ-ID 直接入力の受理 (spec 016 FR-012 の rejection を維持)、(c) `maxDepth` のデフォルト値変更、(d) doc↔doc 辺 (`derives_from` / `depends_on`) のセマンティクス変更、(e) `contains` 辺の**生成側** (builder.ts) の変更、(f) `sameSpecReqs` の実装 (Deferred — US4)、(g) コードのみ diff での `@impl` タグ削除による新規 uncovered の検出 (baseline 側グラフ辺のスコープ計算への併用 — [#229](https://github.com/mori-shin-x/artgraph/issues/229) として切り出し済み。現行でも確実には検出されていないため本 spec の退行ではない)。

### Key Entities

- **`contains` 辺**: 生成 (builder.ts、provenance `structural`、doc→req|task) は不変。**消費側 (traverse) のセマンティクスのみ変更**。
- **`ImpactResult`**: US4 の deferral により**型・JSON フィールド構成は完全に不変**。変わるのは各フィールドの値(到達集合の中身)のみで、`affectedDocs` の算出方法が「BFS 到達」から「BFS 到達 ∪ 帰属アトリビューション」に変わる。(将来 `sameSpecReqs` を実装する場合は `resolveOriginReqs` / `originReqs` と同じ責務分担 — traverse 層ヘルパー + CLI 層合成 — に従う。)
- **`DriftEntry`**: 型・判定ロジック不変。母集合 (visited + attributed docs) の変化のみ。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Issue #215 の再現手順 1 / 2 が非再現になり、手順 3 (別 spec 分割) の挙動が不変であることを、issue 記載の最小構成 fixture の E2E で確認できる。
- **SC-002**: spec 016 の受け入れシナリオ (二軸出力・symbol 過剰検知抑制) がすべて green のまま維持される。
- **SC-003**: tag-zero brownfield E2E (#122) が**無変更で** green (ts-import 経路への非干渉の証明)。
- **SC-004**: 既存テストスイート (typecheck / unit / e2e / knip) が green。兄弟 REQ 到達を expect していた既存テストは新セマンティクスへの書き換えとして PR 上で列挙・レビュー可能にする。
- **SC-005**: dogfooding 環境 (artgraph-dogfooding リポ、specs 001〜004 + src/todo.ts) で `artgraph impact src/todo.ts:<symbol>` を実行すると、当該 symbol の `@impl` claim とコード依存由来の REQ のみが返る (実プロジェクト構成での価値提案の回復確認)。

## Alternatives Considered

| 案 | 内容 | 裁定 |
|----|------|------|
| 案 1: contains 方向制約 | BFS で doc contains を双方向に辿らない。req→doc は帰属メタデータとしてのみ扱う | **採用 (core)**。根本原因の除去。帰属は事後アトリビューション (FR-004) で温存 |
| 案 2: `sameSpecReqs` 分離 | 兄弟 REQ を別カテゴリに分離し Drift candidates に混ぜない | **採用見送り (Deferred)**。設計レビュー (2026-07-10) で実装対象外と裁定 — 理由は US4 冒頭の裁定注記を参照。案 1 なしの案 2 単独 (BFS は今のまま出力だけ分類) は、affectedFiles / check スコープ / plan-coverage の汚染が残るため元より不採用 |
| 案 3: docs 明記のみ | 「1 spec.md 複数 REQ で impact は spec 単位」と制約を明記 | **不採用**。最も一般的な構成で中核価値提案が壊れたままになる。#177/#179/#188/spec 016 の投資も回収不能 |
| 変形案: 経路依存 BFS | reverse contains で到達した doc を「非展開ノード」としてマークし BFS 内で処理 | **不採用**。訪問順で結果が変わりうる経路依存性を BFS に持ち込み、決定性の検証コストが上がる。事後アトリビューションが同じ出力をより単純に達成する |

## Assumptions

- 公開済みだが 0.1 で実利用者はいない想定。作者判断 (2026-07-10 設計レビュー) により破壊的変更を許容し、移行導線・非推奨期間は設けない。出力は狭くなる方向にのみ変わる。
- `contains` 辺の生成は builder.ts の 1 箇所 (provenance `structural`) のみであり、方向制約の適用点は traverse 層に閉じる。
- traverse.ts 冒頭コメントおよび spec 014/016 の「bidirectional は意図」という記述は、同一 doc 内の狭い fixture では妥当に見えたが、Spec Kit / Kiro の標準構成 (1 spec.md = 1 feature = 複数 REQ) に対する検証を欠いていた。#215 の 3 段階切り分け (dogfooding で実証) を優先し、本 spec で設計判断を更新する。
- `visited` 集合ベースの現行 BFS 実装は方向制約後も決定的であり、出力順序の契約 (INV-S2 等) に影響しない。
