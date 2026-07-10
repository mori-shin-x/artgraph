# Feature Specification: symbol mode のクラスメソッド粒度 — メソッド単位シンボルの導入

**Feature Branch**: `feat/method-grain-symbols`

**Created**: 2026-07-11

**Status**: Draft

**Input**: Issue [#218](https://github.com/mori-shin-x/artgraph/issues/218) — 「`mode: "symbol"` で、クラスの各メソッド直上に別々の `@impl REQ-NNN` を置いても、グラフ上はすべてクラス全体のシンボル (`symbol:file.ts#ClassName`) に集約され、メソッド単位のシンボルは生成されない。『1 クラス・複数メソッド・各メソッドが別 REQ を実装』は OOP コードベースの標準形であり、このパターンでは `impact` が『メソッド A だけ変更』でも『クラスが実装する全 REQ』を返すため、per-change context の解像度がファイルモード相当まで落ちる。」

**Parent issue**: [#218](https://github.com/mori-shin-x/artgraph/issues/218)

**Related**:

- spec 019 / [#215](https://github.com/mori-shin-x/artgraph/issues/215) (merged, PR [#232](https://github.com/mori-shin-x/artgraph/pull/232)) — 同一 spec 兄弟 REQ の巻き込み解消。**本 spec の前提**: #215 が解決したことで、メソッド粒度の向上が impact 出力で初めて観測可能になった。また本 spec は spec 019 が確立した「containment は順方向限定でトラバースする」原則を symbol 層 (class → method) にそのまま再利用する。
- spec 016 (impact/plan-coverage の symbol-level 入力) — `Files: <path>:<symbol>` 構文・二軸出力 (impactReqs/originReqs)・R-006 (symbol 起点は親 file を seed しない)。本 spec のメソッドシンボルはこの基盤の上に乗る。
- spec 018 / [#177](https://github.com/mori-shin-x/artgraph/issues/177) / [#179](https://github.com/mori-shin-x/artgraph/issues/179) / [#188](https://github.com/mori-shin-x/artgraph/issues/188) — re-export の per-symbol 精度 (隣接するが別軸: あちらはファイル間、こちらはクラス内部の粒度)。
- 発見経緯: dogfooding (artgraph-dogfooding リポ) で TodoStore クラス案が本制約のため standalone functions 設計に変更された。本 spec の完了により OOP 標準形が第一級でサポートされる。

**前提**: artgraph は公開済みだが 0.1 で実利用者はいない想定 (作者確認済み、spec 019 と同一方針)。**破壊的変更を許容** — lock ファイルへの新規 symbol エントリ追加・グラフ構造の変化に移行導線は設けない (`scan` + `reconcile` の再実行で追随)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — メソッド直上の `@impl` がメソッド単位シンボルに帰属する (Priority: P1)

ユーザーが export されたクラスの各メソッド直上に `// @impl REQ-NNN` を書くと、scan 後のグラフに `symbol:<path>#ClassName.methodName` 形式のメソッドシンボルが生成され、`implements` 辺はメソッドシンボル起点になる。同ファイルのトップレベル export function と同じ解像度がクラスメンバーにも与えられる。

**Why this priority**: Issue #218 の存在理由。OOP 標準形 (1 クラス・複数メソッド・各メソッドが別 REQ) で symbol mode の価値提案 (per-change context) が機能するようにする。

**Independent Test**: issue #218 再現コード (standaloneFn + class Sample { methodA / methodB }) を symbol mode で scan し、`symbol:<path>#Sample.methodA` / `#Sample.methodB` ノードと、それぞれを source とする `implements` 辺が生成されることを assert する。

**Acceptance Scenarios**:

1. **Given** issue #218 の再現コード (`// @impl REQ-902` を methodA 直上、`// @impl REQ-903` を methodB 直上)、 **When** symbol mode で scan、 **Then** グラフに `symbol:src/sample.ts#Sample.methodA` (contentHash = methodA のスパン) と `#Sample.methodB` が存在し、`implements` 辺は各メソッドシンボル起点。クラスシンボル `#Sample` も従来どおり存在する (クラス全体スパン)。
2. **Given** クラス宣言の直上に `// @impl REQ-901`、 **When** scan、 **Then** REQ-901 の `implements` はクラスシンボル `#Sample` 起点 (従来どおり)。
3. **Given** メソッド本文の内部に書かれた `// @impl REQ-904`、 **When** scan、 **Then** 最内包 (innermost) の attribution range であるメソッドシンボルに帰属する (従来はクラスに帰属していた — 挙動変更)。
4. **Given** メソッド直上の JSDoc の上に `// @impl` (leading-trivia、issue #177 のイディオム)、 **When** scan、 **Then** コメント連続行の遡上によりメソッドシンボルに帰属する (トップレベル function と同じ規則)。
5. **Given** static メソッド / getter / setter / private `#member` / クラスプロパティのアロー関数 (`onClick = () => {}`)、 **When** scan、 **Then** いずれも `#ClassName.<memberName>` のメソッドシンボルを得る (getter/setter 等の同名メンバーは Edge Cases 参照)。
6. **Given** 非 export のクラス内のメソッド直上タグ、 **When** scan、 **Then** 従来どおりファイル帰属 (非 export クラスはクラスシンボル自体が無い — 挙動不変)。

---

### User Story 2 — メソッド起点 impact の解像度向上と兄弟メソッド非巻き込み (Priority: P1)

ユーザーが `artgraph impact src/sample.ts:Sample.methodA` (または tasks.md の `Files: src/sample.ts:Sample.methodA`) を実行すると、methodA が claim する REQ とそのコード依存・spec 依存由来の到達先だけが返り、同じクラスの兄弟メソッド (methodB) の REQ は混入しない。一方、`impact src/sample.ts:Sample` (クラス単位) は全メソッドの REQ を含む — file-unit が全 symbol を巻き込むのと同じ「広い単位は広い爆風」の関係。

**Why this priority**: US1 の粒度向上は impact で観測できて初めて価値になる。spec 019 で doc 経由の巻き込みが消えた今、クラス経由の収束が最後の支配的な過剰検知源。

**Independent Test**: US1 の fixture で `impact src/sample.ts:Sample.methodA --format json` の `impactReqs` が `["REQ-902"]` のみであること、`impact src/sample.ts:Sample` の `impactReqs` が REQ-901/902/903 を含むことを assert する。

**Acceptance Scenarios**:

1. **Given** US1 シナリオ 1 の fixture、 **When** `impact src/sample.ts:Sample.methodA --format json`、 **Then** `impactReqs = ["REQ-902"]`。REQ-903 (兄弟メソッド) も REQ-901 (クラスレベル claim) も含まれない。
2. **Given** 同 fixture、 **When** `impact src/sample.ts:Sample`、 **Then** `impactReqs` は REQ-901 / REQ-902 / REQ-903 をすべて含む (クラス→メソッドの順方向 containment 展開)。
3. **Given** 別ファイルが `import { Sample }` している構成、 **When** そのファイル起点の `impact`、 **Then** imports 辺→クラスシンボル→順方向 containment→全メソッド REQ に到達する (クラスを import する側は任意のメソッドを使いうる — クラス粒度の爆風を維持、偽の狭まりなし)。
4. **Given** methodA が同クラスの methodB を `this.methodB()` で呼んでいる、 **When** `impact src/sample.ts:Sample.methodA`、 **Then** REQ-903 は**含まれない** (クラス内部の呼び出し解決は静的に行わない — Assumptions 参照。従来も symbol 間の call-graph 解決は無い)。
5. **Given** `Files: src/sample.ts` (file-unit)、 **When** plan-coverage、 **Then** file→symbol 展開により全メソッドシンボル経由で全 REQ に到達 (file-unit の広さは従来どおり)。
6. **Given** tasks.md に `Files: src/sample.ts:Sample.methodA`、 **When** plan-coverage、 **Then** per-entry `impactReqs` は REQ-902 のみ。`originReqs` も `["REQ-902"]` (メソッドシンボルの直接 claim)。二軸が一致しドリフトなしと観測される。

---

### User Story 3 — 既存入力構文の無変更受理と診断 (Priority: P1)

`Files:` / CLI の `path:symbol` 構文はドットを含む symbol 名 (`Sample.methodA`) を**文法変更なしで**受理する (Stage A `PATH_SYMBOL_RE` / `CLI_PATH_SYMBOL_RE` の symbol 文字集合 `[^\s,()]+` は現行のままドットを許容)。存在しないメソッド名は既存の `unresolvedSymbol` 診断に乗る。

**Why this priority**: 入力面の互換確認は US2 の成立条件。「文法は変えない」ことを明示的にテストで固定し、パーサ差分をゼロに保つ。

**Acceptance Scenarios**:

1. **Given** `Files: src/sample.ts:Sample.methodA`、 **When** plan-coverage、 **Then** Stage A が `{ path: "src/sample.ts", symbol: "Sample.methodA" }` を抽出し `symbol:src/sample.ts#Sample.methodA` に解決する。
2. **Given** `impact src/sample.ts:Sample.doesNotExist`、 **When** 実行、 **Then** 既存の unresolved-symbol エラー (exit 1) — メソッド名も同じ診断経路に乗る。
3. **Given** `impact src/sample.ts:Sample.methodA` を **file mode** の graph に対して実行、 **When** 実行、 **Then** 既存の「symbol-level input requires symbol mode」ガイダンス (exit 1、従来どおり)。

---

### User Story 4 — ドキュメント / Skill / bootstrap の追随 (Priority: P2)

README / docs/skills-guide.md / `artgraph-impact`・`artgraph-plan-coverage`・`artgraph-bootstrap` Skill テンプレートを更新し、(a) メソッド粒度の記法 (`ClassName.methodName`) と使いどころ、(b) 「メソッドごとに別 REQ を追跡したい場合は standalone function に分割せよ」という旧回避策の記述の削除、(c) bootstrap がクラスメンバー直上へのタグ提案をしてよいことを反映する。dogfood テンプレート 5 agent path の byte-identical 同期を維持する。

**Acceptance Scenarios**:

1. **Given** 更新後のドキュメント群、 **When** 全文検索、 **Then** 「クラスはメソッド粒度を持たない」旨の旧制約記述が残っていない。
2. **Given** Skill テンプレート更新後、 **When** dogfood 同期テスト実行、 **Then** 5 agent path すべて byte-identical で green。

---

### Edge Cases

- **同名メンバー (getter/setter ペア、instance/static 同名、オーバーロード宣言群)**: 同一クラス内で同じ名前を持つメンバー出現は **1 つのメソッドシンボルに収束**する。シンボル ID は `#ClassName.<name>` 1 つ、contentHash は**最初の出現のスパン**で計算し (離散スパンの合成はしない — 間に挟まる他メンバーの編集で偽 drift するため)、**attribution range は各出現位置に張る** (getter 直上のタグも setter 直上のタグも同じシンボルに帰属する)。
- **computed property name (`[Symbol.iterator]() {}` / `["foo-" + x]() {}`)**: 静的に名前が決まらないため メソッドシンボルを生成せず、タグはクラスシンボルへフォールバック (従来どおりの帰属)。決定性優先。
- **constructor**: `#ClassName.constructor` として通常のメンバーと同様にシンボル化する。
- **private member (`#priv() {}`)**: 名前をソース表記のまま使い `#ClassName.#priv`。ID 中の `#` はシンボル名の一部 (ノード ID の `#` 区切りは最初の 1 個のみが path/symbol 境界 — 既存の実装もこの前提)。
- **クラス式 (`export const Sample = class { ... }`)**: 変数宣言経由のシンボル (既存挙動) のままとし、メンバー抽出は**行わない** (スコープ外 — ClassDeclaration のみ対象。将来必要になれば拡張)。
- **ネストしたクラス / メソッド内のクラス宣言**: 対象外 (トップレベルの export された ClassDeclaration のみ)。
- **デコレータ付きメソッド**: attribution span はデコレータを含むメンバー全体。leading-trivia 遡上はデコレータの上のコメントにも届く (クラス宣言の `declTextStart` と同じ扱い)。
- **メソッドシンボルと lock**: メソッドシンボルは既存の symbol と同様 lock エントリになる。メソッド編集時は**メソッドシンボルとクラスシンボルの両方が drift** する (クラスのスパンはメソッドを包含するため)。これは正直な二重報告として許容する — doc とその子 REQ の hash 関係 ([#235](https://github.com/mori-shin-x/artgraph/issues/235) で議論中の特性) と同型であり、reconcile で両方解消される。
- **`Files: src/a.ts:Sample` (クラス unit) の originReqs**: クラス直上タグの claim のみ。メソッドの claim は**継承しない** — file-unit が子 symbol の claim を継承しない規則 (spec 016 data-model §3.2) と同一の原則。クラス unit の `impactReqs` はメソッド REQ を含むため二軸差分が出るが、これは「広い単位を宣言した」ことの正直な表示。精度が欲しければ `Sample.methodA` を書く (file-unit → symbol-unit の関係と相似)。

## Requirements *(mandatory)*

### Functional Requirements

#### メソッドシンボル抽出 (parser)

- **FR-001**: symbol mode の TypeScript パーサは、export された ClassDeclaration (named / default) の名前付きメンバー (method / getter / setter / constructor / static 各種 / private `#member` / 関数値のクラスプロパティ) について、`symbol:<path>#<ClassName>.<memberName>` のシンボルノードを生成する。contentHash はメンバーのスパン (デコレータ含む) から計算する。
- **FR-002**: メソッドシンボルは自前の attribution range (leading-trivia 遡上込み) を持つ。既存の innermost-wins 帰属規則 (`typescript.ts` の enclosing-group 解決) により、メンバー直上・メンバー本文内のタグはメソッドシンボルへ、クラス直上・メンバー間の浮きタグはクラスシンボルへ帰属する。
- **FR-003**: 同名メンバーの複数出現 (get/set、static/instance、オーバーロード) は 1 シンボルに収束する: ID は 1 つ、hash は最初の出現スパン、attribution range は全出現位置。
- **FR-004**: computed property name のメンバーはシンボル化せず、クラスシンボルへの帰属を維持する。非 export クラス・クラス式・ネストクラスは対象外 (挙動不変)。
- **FR-005**: クラスシンボル自体は無変更 (ID・スパン・hash とも従来どおり)。default export クラスのメンバーは `#default.<memberName>`。

#### class→method containment (graph)

- **FR-006**: パーサ (または builder) は class シンボル → method シンボルの `contains` 辺 (provenance `structural`) を生成する。
- **FR-007**: impact BFS は spec 019 の方向制約をそのまま適用する — `contains` は順方向 (class→method) のみトラバースし、逆方向 (method→class) は辿らない。これにより: クラス起点・クラスへの imports 到達からは全メソッドへ展開する (US2-2/2-3)、メソッド起点からクラス経由で兄弟メソッドへは到達しない (US2-1)。**spec 019 で実装済みの辺種一律ガードにより、この FR は追加のトラバースコードを要求しない** (fixture テストでの固定のみ)。
- **FR-008**: spec 019 の帰属アトリビューション (FR-004〜006) は doc source 限定ガードを持つため、method シンボルの親 class が `affectedDocs` に混入しないこと (既存ガードの検証をテストで固定)。

#### 入力・解決・診断

- **FR-009**: `Files:` (Stage A) / CLI の `path:symbol` 構文は文法変更なしでドット入り symbol 名を受理し、`symbol:<path>#<ClassName>.<memberName>` への解決は既存の `resolveStartIds` の完全一致 lookup で行う。未解決は既存の `unresolvedSymbol` 診断に乗る。
- **FR-010**: メソッド symbol 起点の `resolveStartIds` は親クラス・親 file ノードを seed しない (spec 016 R-006 の原則をメソッドに延長)。
- **FR-011**: `entryOriginIds` / `resolveOriginReqs` はメソッドシンボルの直接 claim を origin とする。クラス unit エントリの origin にメソッドの claim を含めない (Edge Cases 参照)。

#### lock / check

- **FR-012**: メソッドシンボルは既存 symbol と同様に lock エントリ (contentHash) を持ち、`check` の drift 対象になる。`check --diff` のスコープ集合には filePath ベースの symbol 掃引 (`check.ts` 既存ロジック) で自動的に入る。

#### ドキュメント / Skill

- **FR-013**: README / docs/skills-guide.md / `artgraph-impact`・`artgraph-plan-coverage`・`artgraph-bootstrap` Skill テンプレート・`_shared/output-schema.md` (該当があれば) を更新し、メソッド粒度の記法・旧回避策記述の削除・bootstrap のクラスメンバータグ提案を反映する。5 agent path byte-identical 同期を維持する。

#### Scope exclusion (明示)

- **FR-014**: 以下は本 spec のスコープ外: (a) クラス内メソッド間の call-graph 解決 (`this.methodB()` → REQ 到達、US2-4)、(b) オブジェクトリテラルのメソッドプロパティ (`export const api = { m() {} }`) のシンボル化、(c) interface / enum メンバーの粒度 (実装実体がない)、(d) クラス式・ネストクラスのメンバー抽出、(e) `imports` 辺のメソッド粒度化 (`instance.methodA()` の静的解決)、(f) issue #218 対応方向 3 の doctor 検知 (メソッド粒度の実装により不要化)、(g) doc/symbol の contentHash 粒度の見直し ([#235](https://github.com/mori-shin-x/artgraph/issues/235))。

### Key Entities

- **メソッドシンボルノード**: `kind: "symbol"`、ID `symbol:<path>#<ClassName>.<memberName>`。既存の symbol ノードと同一の型 — NodeKind 追加なし。
- **class→method `contains` 辺**: 既存 EdgeKind `contains` の適用範囲拡大 (doc→req|task に加えて symbol→symbol)。トラバースセマンティクスは spec 019 で確立済みの順方向限定。**生成側の新規、消費側の変更なし**が原則。
- **`.trace.lock`**: メソッドシンボル分のエントリが増える。フォーマット・スキーマ変更なし。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Issue #218 の再現コードで、`implements` 辺がメソッドシンボル起点になり、`impact <file>:Sample.methodA` が methodA の REQ のみを返す (再現手順の非再現)。
- **SC-002**: spec 019 の全受け入れテスト・spec 016 の二軸テスト・spec 018 の re-export テスト・tag-zero brownfield E2E が green のまま (退行なし)。
- **SC-003**: 既存スイート (typecheck / unit / e2e / knip) green。クラスタグがクラスシンボルに帰属する既存テストは挙動不変で green のまま。メソッド内タグのクラス帰属を expect していたテストがあれば新セマンティクスへ期待値反転 (PR で列挙)。
- **SC-004**: dogfooding 環境で TodoStore クラス (メソッドごとに別 REQ) を試作し、`impact` がメソッド単位の REQ を返すことを確認 — issue #218 の「実プロジェクトで回避した」制約が解消されたことの実証。
- **SC-005**: scan 2 回実行の byte-identical (決定性)、reconcile 後の lock byte-stable が保たれる。

## Alternatives Considered

| 案 | 内容 | 裁定 |
|----|------|------|
| メソッドシンボル + contains 順方向 | メンバー単位のシンボル生成、class→method を contains で表現 | **採用**。spec 019 の containment 原則を symbol 層に再利用し、消費側 (traverse) 変更ゼロで成立する |
| ID を `#ClassName#methodName` (ハッシュ 2 個) | ネスト表現として issue 記載の案 | **不採用**。`Files:`/CLI 構文にそのまま書けるドット記法が入力面の変更ゼロで済む。`#` の複数出現はノード ID の分割前提を持つ将来コードに脆い |
| 展開規則を file→symbol と同型の暗黙掃引にする (辺なし、名前 prefix 一致) | impact() に `Sample.` prefix 掃引の分岐を追加 | **不採用**。名前ベースの暗黙結合は決定性の検証が難しく、graph に関係が現れない (render / 将来の消費者から不可視)。contains 辺なら既存セマンティクスに乗る |
| docs 明記のみ (issue 対応方向 2) | 「standalone function に分割せよ」を正式な回避策として文書化 | **不採用**。dogfooding で実際に設計を歪めた (TodoStore → standalone functions)。ツールがコードベースの設計を強制するのは本末転倒 |
| doctor 検知 (issue 対応方向 3) | 1 クラスに N 個 REQ 集約で警告 | **不要化**。メソッド粒度の実装により中間案の意義が消える (FR-014f) |

## Assumptions

- 公開済みだが 0.1 で実利用者はいない想定 (作者確認済み)。lock への symbol エントリ追加・帰属の挙動変更 (US1-3: メソッド本文内タグ) に移行導線は設けない。
- クラス内メソッド間の呼び出し (`this.methodB()`) の静的解決は行わない (FR-014a)。既存アーキテクチャでも symbol 間 call-graph は解決しておらず (imports 辺は module import 由来のみ)、本 spec は粒度を上げるだけで解決範囲は変えない。メソッド起点の爆風が「狭すぎる」ケースはクラス unit (`:Sample`) か file unit で広げるのが対処。
- oxc パーサの AST でクラスメンバー (MethodDefinition / PropertyDefinition) のスパン・名前・static 修飾は決定的に取得できる。
- `contains` 辺の消費側 (spec 019 の方向制約・帰属アトリビューション、renderer、diff) は辺の source/target kind を検査しており、symbol→symbol contains の追加で誤動作しない — 実装時に既存テスト + 新規 fixture で確認する (FR-008)。
