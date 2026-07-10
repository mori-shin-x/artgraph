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
5. **Given** static メソッド / getter / setter / クラスプロパティのアロー関数 (`onClick = () => {}`)、 **When** scan、 **Then** いずれも `#ClassName.<memberName>` のメソッドシンボルを得る (getter/setter 等の同名メンバーは Edge Cases 参照)。private `#member` は**シンボル化せず**クラス帰属のまま (Edge Cases 参照)。
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
7. **Given** 別ファイル `src/consumer.ts` が `import { Sample }` している構成、 **When** `impact src/sample.ts:Sample.methodA`、 **Then** `affectedFiles` に `src/consumer.ts` は**含まれない** (メソッド起点はファイル内精度のクエリ — Edge Cases「メソッド起点と依存元ファイル」の裁定参照)。クラス unit (`:Sample`) / file unit / `--diff` (file-unit seed) では従来どおり consumer に到達する。

---

### User Story 3 — 既存入力構文の無変更受理と診断 (Priority: P1)

`Files:` / CLI の `path:symbol` 構文はドットを含む symbol 名 (`Sample.methodA`) を**文法変更なしで**受理する (Stage A `PATH_SYMBOL_RE` / `CLI_PATH_SYMBOL_RE` の symbol 文字集合 `[^\s,()]+` は現行のままドットを許容)。存在しないメソッド名は既存の `unresolvedSymbol` 診断に乗る。

**Why this priority**: 入力面の互換確認は US2 の成立条件。「文法は変えない」ことを明示的にテストで固定し、パーサ差分をゼロに保つ。

**Acceptance Scenarios**:

1. **Given** `Files: src/sample.ts:Sample.methodA`、 **When** plan-coverage、 **Then** Stage A が `{ path: "src/sample.ts", symbol: "Sample.methodA" }` を抽出し `symbol:src/sample.ts#Sample.methodA` に解決する。
2. **Given** `impact src/sample.ts:Sample.doesNotExist`、 **When** 実行、 **Then** 既存の unresolved-symbol エラー (exit 1) — メソッド名も同じ診断経路に乗る。エラー hint の文言 (現行は `grep "export.*<symbol>"` へ誘導) は export されないメソッド名にも通用する表現へ更新する。
3. **Given** `impact src/sample.ts:Sample.methodA` を **file mode** の graph に対して実行、 **When** 実行、 **Then** 既存の「symbol-level input requires symbol mode」ガイダンス (exit 1、従来どおり)。

---

### User Story 4 — ドキュメント / Skill / bootstrap の追随 (Priority: P2)

README / docs/skills-guide.md / `artgraph-impact`・`artgraph-plan-coverage`・`artgraph-bootstrap` Skill テンプレートを更新し、(a) メソッド粒度の記法 (`ClassName.methodName`) と使いどころ、(b) 「メソッドごとに別 REQ を追跡したい場合は standalone function に分割せよ」という旧回避策の記述の削除、(c) bootstrap がクラスメンバー直上へのタグ提案をしてよいことを反映する。dogfood テンプレート 5 agent path の byte-identical 同期を維持する。

**Acceptance Scenarios**:

1. **Given** 更新後のドキュメント群、 **When** 全文検索、 **Then** 「クラスはメソッド粒度を持たない」旨の旧制約記述が残っていない。
2. **Given** Skill テンプレート更新後、 **When** dogfood 同期テスト実行、 **Then** 5 agent path すべて byte-identical で green。

---

### Edge Cases

- **同名メンバー (getter/setter ペア、instance/static 同名、オーバーロード宣言群)**: 同一クラス内で同じ名前を持つメンバー出現は **1 つのメソッドシンボルに収束**する。シンボル ID は `#ClassName.<name>` 1 つ、contentHash は**全出現スパンのテキストをソース順に `\0` 連結したハッシュ** (前例: re-export の `synthReexportHash`)。囲み範囲ハッシュ (min-start..max-end) は間に挟まる他メンバーの編集で偽 drift し、最初の出現のみのハッシュは setter やオーバーロード実装本体の編集がメソッド粒度 drift から漏れるため、いずれも不採用。**attribution range は各出現位置に張る** (getter 直上のタグも setter 直上のタグも同じシンボルに帰属する)。static/instance 同名の収束は get/set と異なり「別実体のマージ」だが、希少ケースの複雑化を避けるため同一規則とする。
- **computed property name (`[Symbol.iterator]() {}` / `["foo-" + x]() {}`)**: 静的に名前が決まらないため メソッドシンボルを生成せず、タグはクラスシンボルへフォールバック (従来どおりの帰属)。決定性優先。
- **constructor**: `#ClassName.constructor` として通常のメンバーと同様にシンボル化する。
- **private member (`#priv() {}`)**: **シンボル化せず、タグはクラスシンボルへフォールバック** (computed name と同じ扱い)。`#ClassName.#priv` は ID に 2 個目の `#` を持ち込むが、既存実装の ID 分割は first-`#` / last-`#` が**混在**しており (`baseline.ts:311` / `parse-cache.ts:179` / `builder.ts:512` は `lastIndexOf("#")`、`builder.ts:521` は first-`#`)、特に baseline の orphan rename 正規化は 2 個目の `#` で誤分割して `check --diff` の rename 追跡を壊す。Alternatives 表が `#ClassName#methodName` 案を棄却した理由そのものに抵触するため不採用。private 粒度が必要になったら `#` 分割 3 箇所の監査・修正とセットで別 spec とする (FR-014i)。
- **クラス式 (`export const Sample = class { ... }`)**: 変数宣言経由のシンボル (既存挙動) のままとし、メンバー抽出は**行わない** (スコープ外 — ClassDeclaration のみ対象。将来必要になれば拡張)。
- **ネストしたクラス / メソッド内のクラス宣言**: 対象外 (トップレベルの export された ClassDeclaration のみ)。
- **デコレータ付きメソッド**: attribution span はデコレータを含むメンバー全体。leading-trivia 遡上はデコレータの上のコメントにも届く (クラス宣言の `declTextStart` と同じ扱い)。
- **メンバー間の「浮きタグ」の実際の帰属**: leading-trivia 遡上は直前のコード行まで登るため、メンバーとメンバーの間にコメント/空行のみで置かれたタグは**次のメンバーに帰属する** (トップレベルの関数間タグが次の関数に帰属するのと相似形)。クラスへ落ちるのは「最終メンバーの後〜閉じ括弧」と「シンボル化されないメンバー (computed / private / データプロパティ等) の直上」のみ。
- **遡上の下限と同サイズ tie**: メンバーの attribution 遡上は**クラス宣言の開始行を越えない** (1 行クラスや `export class Sample { methodA() {` の同一行開始で、クラス直上のタグをメソッドが横取りするのを防ぐ)。attribution range が同サイズになる場合 (1 行クラス) の tie 解決は既存実装が「登録順で先勝ち」のため、**クラス → メンバーの順に登録してクラスが勝つ**ことを固定する。
- **メソッドシンボル ID と既存シンボル名の衝突**: `export { helper as "Sample.methodA" }` (文字列エクスポート名) は現行 main でもドット入りシンボル ID を生成するため、クラスメンバーと同一 ID が衝突しうる。衝突時は**クラスメンバー側を優先**し、破棄した側について build warning を emit する (無言の先勝ちにしない)。
- **メソッド起点と依存元ファイル (consumer)**: `impact <file>:Sample.methodA` の `affectedFiles` は**依存元ファイルを含まない** (imports 辺はクラスシンボルに着地し、method→class の逆 contains は辿らないため)。メソッド起点は「この編集がどの REQ の話か」を絞るファイル内精度のクエリと位置づける。consumer を含む爆風が必要な場面はクラス unit / file unit / `--diff` (file-unit seed により従来どおり consumer へ到達) を使う。トップレベル関数起点 (逆 imports で consumer に到達する) との非対称は**意図的な裁定**でありドキュメントに明記する (FR-013)。spec 019 帰属と同型の「親クラス経由 consumer 1-hop 付与」はドッグフーディングで実需が観測されたら別 spec で検討 (FR-014j)。
- **メソッド起点とクラス直上 claim**: `impact <file>:Sample.methodA` の `impactReqs` にクラス直上タグの REQ (US1-2 の REQ-901) は含まれない。クラス直上 claim は「クラス契約全体」の宣言でありメソッド単位の per-change context には混ぜない、という裁定。ただしメソッド編集はクラススパンの編集でもあるため `check` はクラスシンボル drift を別経路で報告する — impact (絞った文脈) と check (変更検出の網) の役割分担として意図的。
- **maxDepth への影響**: クラス起点からメソッド REQ への到達は class→method→REQ の 2 hop になる (従来はクラス収束で 1 hop)。`maxDepth` 指定時は必要 hop 数が 1 増える (ドキュメント注記)。
- **barrel 経由のメソッド指定**: `Files: src/barrel.ts:Sample.methodA` は解決不能 (メンバーシンボルは origin ファイル側にのみ存在する)。既存の `unresolvedSymbol` 診断に乗る。origin 直指定 (`src/sample.ts:Sample.methodA`) が正。
- **メソッドシンボルと lock**: メソッドシンボルは既存の symbol と同様 lock エントリになる。メソッド編集時は**メソッドシンボルとクラスシンボルの両方が drift** する (クラスのスパンはメソッドを包含するため)。これは正直な二重報告として許容する — doc とその子 REQ の hash 関係 ([#235](https://github.com/mori-shin-x/artgraph/issues/235) で議論中の特性) と同型であり、reconcile で両方解消される。
- **`Files: src/a.ts:Sample` (クラス unit) の originReqs**: クラス直上タグの claim のみ。メソッドの claim は**継承しない** — file-unit が子 symbol の claim を継承しない規則 (spec 016 data-model §3.2) と同一の原則。クラス unit の `impactReqs` はメソッド REQ を含むため二軸差分が出るが、これは「広い単位を宣言した」ことの正直な表示。精度が欲しければ `Sample.methodA` を書く (file-unit → symbol-unit の関係と相似)。

## Requirements *(mandatory)*

### Functional Requirements

#### メソッドシンボル抽出 (parser)

- **FR-001**: symbol mode の TypeScript パーサは、**インライン export された** ClassDeclaration (`export class` / `export default class`) の名前付きメンバーについて、`symbol:<path>#<ClassName>.<memberName>` のシンボルノードを生成する。対象メンバー: method / getter / setter / constructor / static 各種、および initializer が ArrowFunctionExpression / FunctionExpression のクラスプロパティ。contentHash はメンバーのスパン (デコレータ含む) から計算する (同名複数出現は FR-003)。分離 export (`export { Sample }`) / alias export のクラスは対象外 (クラスシンボルのみ、挙動不変 — 現行の分離 export 解決 `LocalDecl` は AST 参照を持たない)。同一クラスの二重 export (inline + 分離) でもメンバーシンボルは inline 形態の prefix で 1 セットのみ。既存シンボル名との ID 衝突時はクラスメンバー優先 + build warning (Edge Cases 参照)。
- **FR-002**: メソッドシンボルは自前の attribution range (leading-trivia 遡上込み) を持ち、既存の innermost-wins 帰属規則 (`typescript.ts` の enclosing-group 解決) で解決する。帰属規則: (a) メンバー直上 (コメント/空行のみを挟む)・メンバー本文内のタグは当該メソッドへ、(b) メンバー間の浮きタグは**次のメンバー**へ (トップレベルの関数間タグと相似形)、(c) クラス直上・最終メンバー後・シンボル化されないメンバー直上のタグはクラスへ。遡上の下限: メンバー range は**クラス宣言の開始行を越えて widen しない**。range 同サイズ tie はクラス優先 (登録順で固定 — Edge Cases 参照)。
- **FR-003**: 同名メンバーの複数出現 (get/set、static/instance、オーバーロード) は 1 シンボルに収束する: ID は 1 つ、contentHash は**全出現スパンのテキストをソース順に `\0` 連結したハッシュ**、attribution range は全出現位置。
- **FR-004**: 次のメンバーはシンボル化せず、タグはクラスシンボルへ帰属する: computed property name、private `#member`、データプロパティ (関数値でない initializer)、`accessor`、abstract / `declare` メンバー、static block。非 export クラス・分離/alias export クラス・クラス式・ネストクラスは対象外 (挙動不変)。
- **FR-005**: クラスシンボル自体は無変更 (ID・スパン・hash とも従来どおり)。default export クラスのメンバーは `#default.<memberName>`。

#### class→method containment (graph)

- **FR-006**: **パーサが** class シンボル → method シンボルの `contains` 辺 (provenance `structural`) を生成する (builder 側での名前 prefix 一致による生成は不可 — Alternatives で棄却した名前ベースの暗黙結合そのものになる上、ドット入り既存シンボル名との衝突で誤エッジを張る)。パーサ出力の変化に伴い parse-cache の `SCHEMA_VERSION` を bump する。`docGraph.autoContains` は doc→req|task の contains のみを制御し、class→method contains には**適用しない** (常時生成)。
- **FR-007**: impact BFS は spec 019 の方向制約をそのまま適用する — `contains` は順方向 (class→method) のみトラバースし、逆方向 (method→class) は辿らない。これにより: クラス起点・クラスへの imports 到達からは全メソッドへ展開する (US2-2/2-3)、メソッド起点からクラス経由で兄弟メソッドへは到達しない (US2-1)。**spec 019 で実装済みの辺種一律ガードにより、この FR は追加のトラバースコードを要求しない** (fixture テストでの固定のみ)。
- **FR-008**: spec 019 の帰属アトリビューション (FR-004〜006) は doc source 限定ガードを持つため、method シンボルの親 class が `affectedDocs` に混入しないこと (既存ガードの検証をテストで固定)。

#### 入力・解決・診断

- **FR-009**: `Files:` (Stage A) / CLI の `path:symbol` 構文は文法変更なしでドット入り symbol 名を受理し、`symbol:<path>#<ClassName>.<memberName>` への解決は既存の `resolveStartIds` の完全一致 lookup で行う。未解決は既存の `unresolvedSymbol` 診断に乗る。
- **FR-010**: メソッド symbol 起点の `resolveStartIds` は親クラス・親 file ノードを seed しない (spec 016 R-006 の原則をメソッドに延長)。
- **FR-011**: `entryOriginIds` / `resolveOriginReqs` はメソッドシンボルの直接 claim を origin とする。クラス unit エントリの origin にメソッドの claim を含めない (Edge Cases 参照)。

#### lock / check

- **FR-012**: メソッドシンボルは既存 symbol と同様に lock エントリ (contentHash) を持ち、`check` の drift 対象になる。`check --diff` のスコープ集合には filePath ベースの symbol 掃引 (`check.ts` 既存ロジック) で自動的に入る。

#### ドキュメント / Skill

- **FR-013**: README / docs/skills-guide.md / `artgraph-impact`・`artgraph-plan-coverage`・`artgraph-bootstrap` Skill テンプレート・`_shared/output-schema.md` (該当があれば) を更新し、メソッド粒度の記法・旧回避策記述の削除・bootstrap のクラスメンバータグ提案を反映する。あわせて (a) メソッド起点は consumer ファイルを含まない裁定の明記、(b) `unresolvedSymbol` エラー hint のメソッド対応文言化、(c) spec 019 Edge Case の「autoContains: false なら contains 辺が存在しない」記述が本 spec 以降は doc 系 contains に限る旨の追記、を含める。5 agent path byte-identical 同期を維持する。

#### Scope exclusion (明示)

- **FR-014**: 以下は本 spec のスコープ外: (a) クラス内メソッド間の call-graph 解決 (`this.methodB()` → REQ 到達、US2-4)、(b) オブジェクトリテラルのメソッドプロパティ (`export const api = { m() {} }`) のシンボル化、(c) interface / enum メンバーの粒度 (実装実体がない)、(d) クラス式・ネストクラスのメンバー抽出、(e) `imports` 辺のメソッド粒度化 (`instance.methodA()` の静的解決)、(f) issue #218 対応方向 3 の doctor 検知 (メソッド粒度の実装により不要化)、(g) doc/symbol の contentHash 粒度の見直し ([#235](https://github.com/mori-shin-x/artgraph/issues/235))、(h) `export namespace N { ... }` 内関数の namespace シンボル収束 (同型の別問題 — 別 issue 候補)、(i) private `#member` のシンボル化 (ID の `#` 分割 3 箇所の監査が前提 — Edge Cases 参照)、(j) メソッド起点 impact への consumer 1-hop 付与 (spec 019 帰属と同型の拡張 — 実需観測後)。

### Key Entities

- **メソッドシンボルノード**: `kind: "symbol"`、ID `symbol:<path>#<ClassName>.<memberName>`。既存の symbol ノードと同一の型 — NodeKind 追加なし。
- **class→method `contains` 辺**: 既存 EdgeKind `contains` の適用範囲拡大 (doc→req|task に加えて symbol→symbol)。トラバースセマンティクスは spec 019 で確立済みの順方向限定。**生成側の新規、消費側の変更なし**が原則。
- **`.trace.lock`**: メソッドシンボル分のエントリが増える。フォーマット・スキーマ変更なし。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Issue #218 の再現コードで、`implements` 辺がメソッドシンボル起点になり、`impact <file>:Sample.methodA` が methodA の REQ のみを返す (再現手順の非再現)。
- **SC-002**: spec 019 の全受け入れテスト・spec 016 の二軸テスト・spec 018 の re-export テスト・tag-zero brownfield E2E が green のまま (退行なし)。
- **SC-003**: 既存スイート (typecheck / unit / e2e / knip) green。クラス直上タグがクラスシンボルに帰属する既存テストは挙動不変で green のまま。メソッド内タグのクラス帰属を expect していたテスト、および `tests/typescript-oxc-regression.test.ts` の「クラスはメンバーシンボルを持たない」前提の期待値 (例: `export default class { m() {} }` → `default` のみ) は新セマンティクスへ期待値反転 (PR で列挙)。`typescript.ts` 冒頭の ts-morph bit-for-bit 互換 contract コメントも本 spec 準拠へ書き換える。
- **SC-004**: dogfooding 環境で TodoStore クラス (メソッドごとに別 REQ) を試作し、`impact` がメソッド単位の REQ を返すことを確認 — issue #218 の「実プロジェクトで回避した」制約が解消されたことの実証。
- **SC-005**: scan 2 回実行の byte-identical (決定性)、reconcile 後の lock byte-stable が保たれる。

## Alternatives Considered

| 案 | 内容 | 裁定 |
|----|------|------|
| メソッドシンボル + contains 順方向 | メンバー単位のシンボル生成、class→method を contains で表現 | **採用**。spec 019 の containment 原則を symbol 層に再利用し、消費側 (traverse) 変更ゼロで成立する (実 traverse コードでのシミュレーションで US2 全シナリオの成立を確認済み) |
| メソッドシンボルのみ・辺なし (タグ帰属改善だけ) | class→method の graph 関係を張らない最小案 | **不採用**。claim がメソッドへ移るため、クラスを import する consumer 起点の impact がメソッドの REQ に到達できず、**現行 main より退化**する (現行はクラス収束のおかげで consumer が全メソッド REQ に到達している)。contains 辺はこの現状維持に必須 |
| ID を `#ClassName#methodName` (ハッシュ 2 個) | ネスト表現として issue 記載の案 | **不採用**。`Files:`/CLI 構文にそのまま書けるドット記法が入力面の変更ゼロで済む。`#` の複数出現はノード ID の分割前提を持つ将来コードに脆い |
| 展開規則を file→symbol と同型の暗黙掃引にする (辺なし、名前 prefix 一致) | impact() に `Sample.` prefix 掃引の分岐を追加 | **不採用**。名前ベースの暗黙結合は決定性の検証が難しく、graph に関係が現れない (render / 将来の消費者から不可視)。contains 辺なら既存セマンティクスに乗る |
| docs 明記のみ (issue 対応方向 2) | 「standalone function に分割せよ」を正式な回避策として文書化 | **不採用**。dogfooding で実際に設計を歪めた (TodoStore → standalone functions)。ツールがコードベースの設計を強制するのは本末転倒 |
| doctor 検知 (issue 対応方向 3) | 1 クラスに N 個 REQ 集約で警告 | **不要化**。メソッド粒度の実装により中間案の意義が消える (FR-014f) |

## Assumptions

- 公開済みだが 0.1 で実利用者はいない想定 (作者確認済み)。lock への symbol エントリ追加・帰属の挙動変更 (US1-3: メソッド本文内タグ) に移行導線は設けない。
- クラス内メソッド間の呼び出し (`this.methodB()`) の静的解決は行わない (FR-014a)。既存アーキテクチャでも symbol 間 call-graph は解決しておらず (imports 辺は module import 由来のみ)、本 spec は粒度を上げるだけで解決範囲は変えない。メソッド起点の爆風が「狭すぎる」ケースはクラス unit (`:Sample`) か file unit で広げるのが対処。
- oxc パーサの AST でクラスメンバー (MethodDefinition / PropertyDefinition) のスパン・名前・static 修飾は決定的に取得できる。
- `contains` 辺の消費側 (spec 019 の方向制約・帰属アトリビューション、renderer、diff) は辺の source/target kind を検査しており、symbol→symbol contains の追加で誤動作しない — 実装時に既存テスト + 新規 fixture で確認する (FR-008)。
