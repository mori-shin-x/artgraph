# Feature Specification: impact / plan-coverage の symbol-level 入力対応 (file:symbol syntax)

**Feature Branch**: `feat/impact-plan-symbol-level`

**Created**: 2026-06-28

**Status**: Draft

**Input**: User description: 「spec 014 (#104, PR #106) で `artgraph plan-coverage` を file 単位の入力/出力で実装したが、既存関数 1 個だけを改修するケースでは file 全体扱いになり同 file 内の他関数経由で広範囲な REQ が implicit に上がってしまう (過剰検知)。symbol-level 入力経路を追加し、`Files: src/auth.ts:validateToken` と書けば `validateToken` 1 個に限定した forward 波及で REQ を絞り込めるようにする。あわせて symbol 単位での "由来 FR" (`@impl` で claim している REQ) も出力に載せ、波及先 REQ との二軸比較でドリフト追跡を可能にする。」

**Parent issue**: [#107](https://github.com/ShintaroMorimoto/artgraph/issues/107) — spec 014 振り返り由来

**Related**:

- 親 spec: spec 014-reinvent-impact-cli ([#104](https://github.com/ShintaroMorimoto/artgraph/issues/104), PR [#106](https://github.com/ShintaroMorimoto/artgraph/pull/106)) — file unit で完成、本 spec が後継
- 隣接 spec: spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) — plan-coverage enforcement / before_implement hook、本 spec と orthogonal
- 隣接 spec: spec 013 cross-agent ([#101](https://github.com/ShintaroMorimoto/artgraph/issues/101))
- spec 012 ([#98](https://github.com/ShintaroMorimoto/artgraph/issues/98), PR [#103](https://github.com/ShintaroMorimoto/artgraph/pull/103)) — Skill 配備の親

**前提**: artgraph は未リリースのため、本 spec は **後方互換 / 既存ユーザー保護を一切考慮しない**。spec 014 で書いた型 / 関数 / JSON schema も clean に置き換えてよい。テスト・fixture は本 spec の実装と並行して書き直す。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — symbol 単位の過剰検知抑制 + 由来 FR の併走表示 (Priority: P1)

ユーザーが `src/auth.ts` の `validateToken` 関数 1 個だけを修正する予定で `/speckit-tasks` を回し、各 task の `Files:` セクションに `Files: src/auth.ts:validateToken` と書く。`src/auth.ts` には他に `issueToken` / `revokeToken` も存在し、それぞれ別 REQ (`REQ-005` / `REQ-009`) を implements しているが、これらは今回の修正対象外。

`artgraph plan-coverage` を実行すると、symbol-level 入力により:

1. **過剰検知の抑制**: `validateToken` 起点の forward 波及のみが計算され、`REQ-005` / `REQ-009` は implicit リストから除外される。
2. **由来 FR の併走表示**: 各 entry に `originReqs` (= この symbol が `@impl` で claim している REQ 集合) と `impactReqs` (= BFS で到達した REQ 集合) の二軸が出る。ユーザーは「自分が宣言した FR (`originReqs = [REQ-001]`)」と「実際に手を伸ばす範囲 (`impactReqs = [REQ-001]`)」を見比べてドリフトが起きていないことを確認できる。

**Why this priority**: 本 spec の存在理由そのもの。spec 014 の user feedback で「`validateToken` 1 個触る予定でもファイル全体扱いで過剰検知」と指摘された問題を解消し、同時に artgraph のコア価値「**実装だけがドリフトしていくのを避ける**」を symbol 粒度でも維持する。file 粒度に落とすと「広く曖昧」、symbol 粒度に上げると「狭く焦点」だが、`originReqs` を併走させることで symbol 粒度でも「この変更は本来どの FR の話か」を見失わない。

**Independent Test**: `src/auth.ts` が `validateToken` (`@impl REQ-001`)、`issueToken` (`@impl REQ-005`)、`revokeToken` (`@impl REQ-009`) の 3 export を持ち、graph が symbol mode で scan 済の fixture を用意する。tasks.md に `Files: src/auth.ts:validateToken` のみを書いて `artgraph plan-coverage --format json` を実行すると:

- `implicitImpactsByReq[].reqId` は `REQ-001` のみで `REQ-005` / `REQ-009` は含まれない (過剰検知抑制)
- `implicitImpacts[0].originReqs = ["REQ-001"]`、`implicitImpacts[0].impactReqs = ["REQ-001"]` (二軸一致 = ドリフトなし)

同 fixture で spec.md が後追いで `REQ-001 depends_on REQ-007` を追加すると、次の plan-coverage 実行で `impactReqs = ["REQ-001", "REQ-007"]` / `originReqs = ["REQ-001"]` となり、`impactReqs \ originReqs = [REQ-007]` がドリフト候補として人間の目に観測可能になる。

**Acceptance Scenarios**:

1. **Given** `src/auth.ts` に export された 3 symbol (`validateToken` / `issueToken` / `revokeToken`)、graph が symbol mode で scan 済、tasks.md に `Files: src/auth.ts:validateToken`、tasks/plan/spec 本文に REQ-001 言及なし、 **When** `artgraph plan-coverage --format json`、 **Then** `implicitImpactsByReq[].reqId` に `REQ-001` のみが含まれ、`REQ-005` / `REQ-009` は含まれない。`implicitImpacts[0]` は `{ sourceFile: "src/auth.ts", sourceSymbol: "validateToken", impactReqs: [{reqId: "REQ-001", kind: "req"}], originReqs: [{reqId: "REQ-001", kind: "req"}] }`。
2. **Given** 同 fixture を `Files: src/auth.ts` に書き換え、 **When** 同コマンド、 **Then** 3 REQ すべてが implicit に挙がる(file 単位は全 symbol を巻き込む)。`implicitImpacts[0]` の `sourceSymbol` は存在せず、`originReqs` は file 単位の `@impl` claim 集合(file-top タグなし fixture なら空配列)。
3. **Given** `Files: src/auth.ts:validateToken, src/session.ts:createSession` の symbol 混在、 **When** 同コマンド、 **Then** 2 つの ImpactGroup が並び、それぞれ独立した `impactReqs` / `originReqs` を持つ。
4. **Given** `Files: src/auth.ts:validateToken, src/legacy.ts` の file/symbol 混在、 **When** 同コマンド、 **Then** symbol entry は `sourceSymbol` あり、file entry は `sourceSymbol` なしの 2 ImpactGroup が並ぶ。
5. **Given** `Files: src/auth.ts:validateToken (deleted)` と annotation 付き、 **When** 同コマンド、 **Then** annotation は剥がされ、symbol 解決は `validateToken` で行われる。
6. **Given** spec.md で `REQ-001 depends_on REQ-007` を追加し他は据え置き、 **When** 同コマンド、 **Then** `impactReqs = ["REQ-001", "REQ-007"]` / `originReqs = ["REQ-001"]` となり、二軸の差分 `impactReqs \ originReqs` を JSON consumer が計算できる。

---

### User Story 2 — `artgraph impact` の symbol 直接入力 + 二軸出力 (Priority: P1)

ユーザーが手動で「`validateToken` を触る予定」のような symbol 起点の forward 波及を見たいとき、`artgraph impact src/auth.ts:validateToken` と直接入力する。CLI は `:` を検出して symbol syntax と判定し、(a) `--mode` 指定がなくても symbol-mode の resolver を発動、(b) `symbol:src/auth.ts#validateToken` start id で BFS、(c) 出力に `impactReqs` (= BFS で到達した REQ) と `originReqs` (= start ids の `@impl` claim 集合の union) の二軸を載せる。`--from-tasks` 経由でも同 syntax を継承し、tasks.md に `Files: src/auth.ts:validateToken` と書いてあれば同じ symbol-mode 解決を行う。

**Why this priority**: US1 の plan-coverage は impact() を内部で呼ぶため、impact CLI 側の symbol 入力経路が完成していなければ US1 も成立しない。US1 と一体で出荷する。CLI が直接 symbol 受理 + 二軸出力を返せれば、エージェントが Skill 経由でドリフト検知のロジックを agent 側で組めるようになる。

**Independent Test**: `artgraph impact src/auth.ts:validateToken --format json` が exit 0 で完了し、出力に `impactReqs` と `originReqs` の両方が含まれる。`originReqs` は `validateToken` の `@impl` claim と一致。存在しない symbol を渡せば exit 1。

**Acceptance Scenarios**:

1. **Given** 任意の symbol-mode fixture、 **When** `artgraph impact src/auth.ts:validateToken --format json`、 **Then** 出力 JSON に `impactReqs` (forward BFS) と `originReqs` (1-hop @impl claims) の両方が含まれる。
2. **Given** 同 fixture で `validateToken` の `@impl` タグが `REQ-001`、spec で `REQ-001 depends_on REQ-007`、 **When** 同コマンド、 **Then** `impactReqs = ["REQ-001", "REQ-007"]`、`originReqs = ["REQ-001"]`。差分 `impactReqs \ originReqs = ["REQ-007"]` を CLI text 出力でも「Drift candidates」セクションに表示する。
3. **Given** 同 fixture、 **When** `artgraph impact src/auth.ts:doesNotExist`、 **Then** exit 1 で「No matching symbol found for: src/auth.ts:doesNotExist」相当のエラー。
4. **Given** `--from-tasks tasks.md` で tasks.md に `Files: src/auth.ts:validateToken`、 **When** 同コマンド、 **Then** symbol startId で impact が計算され、同じ二軸出力が返る。
5. **Given** symbol mode で scan されていない graph (`.artgraph.json` が `mode: file`)、 **When** `artgraph impact src/auth.ts:validateToken`、 **Then** exit 1 で「symbol-level input requires `artgraph scan --mode symbol`」相当のガイダンス。
6. **Given** REQ-ID 入力 (`REQ-001`) と symbol input の混在、 **When** 実行、 **Then** REQ-ID rejection で exit 1 (FR-012)。
7. **Given** 複数 symbol 同時入力 (`artgraph impact src/auth.ts:validateToken src/session.ts:createSession`)、 **When** 実行、 **Then** `impactReqs` は 2 symbol からの BFS の union、`originReqs` は 2 symbol の `@impl` claim の union。

---

### User Story 3 — `plan-coverage` 出力スキーマの二軸 + symbol 情報 (Priority: P1)

`artgraph plan-coverage --format json` の出力 JSON は spec 014 から **clean に再設計** され、以下の 3 つの主要変更を持つ:

1. **`implicitImpacts[]` の各 ImpactGroup が `impactReqs` と `originReqs` の二軸を持つ** (`reqs` フィールドは廃止 → `impactReqs` に rename)。
2. **`implicitImpactsByReq[]` の起点表現を `sourceFiles: string[]` から `sourceLocations: Array<{ file, symbol? }>` に置き換え** (symbol 情報を機械可読に保持)。
3. **`ImpactGroup` に `sourceSymbol?: string` を追加** し、同 file 多 symbol は別エントリで並ぶ。

`originReqs` は ImpactGroup ごとに、start node (file node or symbol node) の `@impl` claim を 1-hop 辿った REQ 集合として populate される。file 入力で file-top `@impl` タグが無ければ `originReqs: []`。

**Why this priority**: US1 / US2 を実装しても、出力 JSON で「どの symbol が起点だったか」と「symbol の home FR は何か」を機械可読に表現できなければ Skill / エージェントが活用できない。US1/US2 と必ず lockstep で出荷する。

**Independent Test**: 1 file から 2 symbol 起点 (`Files: src/auth.ts:validateToken, src/auth.ts:issueToken`) で plan-coverage を実行し、`implicitImpacts[]` に 2 エントリ (sourceFile が同じ、sourceSymbol が異なる) が並ぶ。各エントリで `originReqs` がそれぞれの `@impl` claim と一致。file-level 入力 (`Files: src/auth.ts`) では `sourceSymbol` が省略され、`originReqs` は file-top `@impl` claim (またはなければ `[]`)。

**Acceptance Scenarios**:

1. **Given** tasks.md に `Files: src/auth.ts:validateToken`、 **When** `--format json` 実行、 **Then** `implicitImpacts[0] = { sourceFile: "src/auth.ts", sourceSymbol: "validateToken", impactReqs: [...], originReqs: [...] }`。`reqs` field は出力に存在しない。
2. **Given** tasks.md に `Files: src/auth.ts`、 **When** 同コマンド、 **Then** `implicitImpacts[0] = { sourceFile: "src/auth.ts", impactReqs: [...], originReqs: [...] }`(`sourceSymbol` は省略)。
3. **Given** tasks.md に `Files: src/auth.ts:validateToken, src/auth.ts:issueToken`、 **When** 同コマンド、 **Then** `implicitImpacts` に sourceFile が同一・sourceSymbol が異なる 2 エントリ。各エントリの `originReqs` はそれぞれの `@impl` claim と一致。
4. **Given** 同状況、 **When** `implicitImpactsByReq` を確認、 **Then** `[{ reqId: "REQ-001", sourceLocations: [{ file: "src/auth.ts", symbol: "validateToken" }] }, ...]` の形で symbol 情報を保持。`sourceFiles` field は存在しない。
5. **Given** symbol が graph に存在しない(`Files: src/auth.ts:doesNotExist`)、 **When** 同コマンド、 **Then** `diagnostics[]` に `{ kind: "unresolvedSymbol", sourceFile: "src/auth.ts", symbol: "doesNotExist", line: N }` が追加され、当該エントリは `implicitImpacts` から除外される。

---

### User Story 4 — Skill / ドキュメントでの symbol mode + 二軸ガイダンス (Priority: P2)

ユーザー(エージェント)が `artgraph-impact` / `artgraph-plan-coverage` Skill を発火させたとき、Skill 本文が (a) file mode と symbol mode の使い分け、(b) `impactReqs` と `originReqs` の二軸の解釈、(c) `scan --mode symbol` 前提を案内する。`docs/skills-guide.md` に file vs symbol の trade-off 表と二軸出力の解釈ガイドを追加する。`README.md` の Skills 表に対応 mode 列を加える。

**Why this priority**: US1/US2/US3 で CLI と schema は完成するが、エージェントワークフローでの自動発火と二軸出力の正しい解釈には Skill / docs の更新が必要。優先度は P1 より低い(CLI 単体・手動運用でも機能する)が、配布パスとして必須なので P2 で扱う。

**Independent Test**: `templates/skills/artgraph-impact/SKILL.md` を grep して「symbol-level input」「originReqs」の言及があること、`docs/skills-guide.md` の Skills 表に「file / symbol」列または注釈があること、Skill 本文の合計行数が 100 行以下を維持していることを静的検証。

**Acceptance Scenarios**:

1. **Given** PR マージ後の repo、 **When** `templates/skills/artgraph-impact/SKILL.md` を grep、 **Then** "symbol-level" / "originReqs" / "src/auth.ts:validateToken" などのキーワードが含まれる。
2. **Given** `templates/skills/artgraph-plan-coverage/SKILL.md` を grep、 **Then** "impactReqs" / "originReqs" / "drift" 系のキーワードが含まれる。
3. **Given** `docs/skills-guide.md` を確認、 **When** symbol mode の節を grep、 **Then** 「scan --mode symbol を実行しないと symbol-level 入力は無効」「impactReqs と originReqs の二軸でドリフト追跡」が明示されている。
4. **Given** `README.md` の Skills 表、 **When** 確認、 **Then** 各 Skill の対応 mode (file / symbol / both) が読み取れる。
5. **Given** 改訂後の 2 Skill 本文、 **When** `wc -l`、 **Then** 各 100 行以下。

---

### Edge Cases

- **symbol が graph に存在しない**: `Files: src/auth.ts:doesNotExist` のように file は存在するが symbol が export されていない場合、parser は `unresolvedSymbol` 診断を発出し、当該エントリは `implicitImpacts` / `impactReqs` 計算から除外する。
- **file path も symbol も両方 graph に無い**: `unresolvedFilePath` 診断のみ発出し、symbol 側の警告は重ねない(`unresolvedFilePath` と `unresolvedSymbol` は per entry で排他)。
- **symbol 名に `:` が含まれる**: `src/auth.ts:foo:bar` のような入力は `path = src/auth.ts`、`symbol = foo:bar` と最初の `:` で 1 回だけ split。symbol が graph に解決しなければ `unresolvedSymbol` で警告。
- **`Files: src/auth.ts:validateToken, src/auth.ts`** (同 file の symbol と file 両方): 両方を独立した entry として扱い、別々の ImpactGroup として並ぶ(file-only エントリは `sourceSymbol` なし)。
- **同 symbol が複数 task で重複言及**: dedup は `(sourceFile, sourceSymbol)` ペアで行う(`sourceSymbol === undefined` も dedup キーの一要素として扱う)。
- **scan が `mode: file` の graph に対して symbol 入力が来た**: graph に symbol node が 1 つもないため、symbol 入力は **全て** `unresolvedSymbol` または exit 1 のグローバルエラー。CLI 層で「`scan --mode symbol` が必要」と明示する。
- **Windows path 区切り `\` を含む入力**: spec 014 と同じく POSIX path 前提。絶対パス(`C:\...` や `/abs/...`)は parser で従来通り `unresolvedFilePath` として扱い、symbol 検知は repo-relative path のみ。
- **symbol 名のみの入力 (`:validateToken`)**: parser は path 部分が空のため Stage A の `path:symbol` regex にマッチせず、entry として認識されない(無視)。
- **trailing annotation (`(new)` / `(deleted)`) と symbol 併用**: `Files: src/auth.ts:validateToken (new)` の場合、annotation を剥がしてから `:` 分割。
- **`originReqs` が空のケース**: file 入力で file-top `@impl` タグが無い、または symbol 入力で symbol に `@impl` タグが付いていないケース。`originReqs: []` を返し、ImpactGroup から除外はしない(`impactReqs` 単独で意味を持つため)。
- **`impactReqs` が空、`originReqs` だけ存在するケース**: symbol が `@impl` claim を持つが、claim 先 REQ が孤立ノード (graph 上で forward 探索しても他に何も繋がらない) の場合。ImpactGroup 自体は populate されるが、`implicitImpacts` のソート / 表示順は通常通り。

## Requirements *(mandatory)*

### Functional Requirements

#### sdd-files parser 拡張

- **FR-001**: System MUST `Files:` セクション (Stage A: inline / bullet 形式) で `path:symbol` 形のエントリを受け付け、`{ path, symbol, line }` の `SymbolEntry` として抽出する。
- **FR-002**: System MUST 同 `Files:` セクション内で file 単位エントリ(`src/a.ts`)と symbol 単位エントリ(`src/b.ts:fn1`)の混在を許容し、それぞれ独立した entry として保持する。
- **FR-003**: System MUST `path:symbol` エントリの trailing annotation(`(new)` / `(deleted)` 等)を file-level と同じ規則で剥がしてから `:` で split する。
- **FR-004**: System MUST symbol が graph 上の `symbol:<path>#<name>` ノードと一致しない場合、`unresolvedSymbol` kind の診断を発出する(path は graph or fs に存在し、symbol のみが miss のケース)。`unresolvedFilePath` と per entry で排他。
- **FR-005**: System MUST `path:symbol` の `:` が複数現れる場合は最初の `:` で split し、後続は symbol 名の一部として扱う。
- **FR-006**: System MUST Stage B (regex fallback) は本 spec で **symbol 抽出の対象外**。symbol-level 入力は Stage A (`Files:` セクション) のみで受け付ける。
- **FR-007**: System MUST `ExtractResult.entries: SymbolEntry[]` を一意の返り値型として提供する。`files: string[]` の併走 field は提供しない。

#### `artgraph impact` symbol 直接入力 + 二軸出力

- **FR-008**: System MUST `artgraph impact <path:symbol>` 形の直接入力を受け付け、`:` を検出した時点で symbol-level resolver にディスパッチする。
- **FR-009**: System MUST symbol 入力時に `--mode` が省略されていれば内部で symbol-mode を採用する(graph に symbol node が無い場合は FR-013 のエラー)。
- **FR-010**: System MUST `--from-tasks <path>` / `--from-plan <path>` 経由でも `SymbolEntry` を継承し、対応する symbol startId で BFS を起動する。
- **FR-011**: System MUST symbol が graph に存在しない場合、exit 1 で「No matching symbol found for: <input>」相当のエラーを返す。
- **FR-012**: System MUST REQ-ID 入力(`REQ-001` 等)と symbol 入力が同時指定された場合、REQ-ID rejection を symbol 検出より先に評価する。
- **FR-013**: System MUST graph に symbol node が 1 つも存在しない場合、symbol 入力に対して exit 1 で「symbol-level input requires `artgraph scan --mode symbol`」相当のガイダンスを表示する。
- **FR-014**: System MUST impact CLI の出力 JSON / text の両方に、forward BFS 結果 (`impactReqs`) と並んで `originReqs` (start ids 全部の `@impl` claim の union、1-hop 辿り、dedup + sort 済) を含める。
- **FR-015**: System MUST CLI text 出力で `impactReqs \ originReqs` (= ドリフト候補) を別セクションで表示する(空集合の場合はセクション省略)。

#### `artgraph plan-coverage` 出力スキーマ (二軸)

- **FR-016**: System MUST `implicitImpacts[]` の各 ImpactGroup に `impactReqs: ReqEntry[]` と `originReqs: ReqEntry[]` を含める。spec 014 の `reqs` field は廃止し、`impactReqs` に置き換える。
- **FR-017**: System MUST `originReqs` を「ImpactGroup の startId ノード(file node または symbol node)の `@impl` claim を 1-hop 辿った REQ 集合」として populate する。file 入力で file-top `@impl` タグが無いケースは `originReqs: []`。
- **FR-018**: System MUST `implicitImpacts[]` の各エントリに `sourceSymbol?: string` を含める。symbol 起点で symbol 名、file 起点で省略。
- **FR-019**: System MUST 同 sourceFile から複数 symbol を起点にしたとき、symbol 数分の ImpactGroup を並べる(マージしない)。dedup キーは `(sourceFile, sourceSymbol ?? null)` の複合。
- **FR-020**: System MUST `implicitImpactsByReq[]` の起点表現を `sourceLocations: Array<{ file: string; symbol?: string }>` として提供する。spec 014 の `sourceFiles: string[]` field は廃止する。
- **FR-021**: System MUST symbol が graph に存在しない場合、`diagnostics[]` に `{ kind: "unresolvedSymbol", sourceFile, symbol, line }` を追加し、当該エントリは `implicitImpacts` から除外。
- **FR-022**: System MUST `--ignore REQ-XXX` の挙動を維持する。symbol 起点で集計された REQ も `--ignore` で suppress 可能(`impactReqs` / `originReqs` の両方から該当 REQ を除く)。
- **FR-023**: System MUST text フォーマット出力で symbol 起点エントリは `src/auth.ts#validateToken` の表記で sourceFile と区別する。`impactReqs` と `originReqs` は別セクションで併記する。

#### scan / config / init

- **FR-024**: System MUST `artgraph init` のデフォルトは `mode: file` のままで、symbol mode への切り替えは `.artgraph.json` の手動編集または `artgraph init --mode symbol` の明示 opt-in を維持する。
- **FR-025**: System MUST `.artgraph.json` の `mode: symbol` 設定が有効な場合、`scan` は `symbol:<path>#<name>` ノードを生成する(既存 `parsers/typescript.ts` の symbol 経路を流用)。

#### Skill / ドキュメント

- **FR-026**: System MUST `templates/skills/artgraph-impact/SKILL.md` に symbol-level 入力の例 (`artgraph impact src/auth.ts:validateToken`)、`scan --mode symbol` 前提、二軸出力 (`impactReqs` / `originReqs` / ドリフト候補) の解釈を追記する。
- **FR-027**: System MUST `templates/skills/artgraph-plan-coverage/SKILL.md` に `impactReqs` / `originReqs` の意味、`unresolvedSymbol` 診断の解釈方法を追記する。
- **FR-028**: System MUST `docs/skills-guide.md` に (a) file mode と symbol mode の trade-off (精度 vs scan コスト)、(b) `Files:` syntax 例(symbol 含む)、(c) `.artgraph.json` の `mode` 設定方法、(d) 二軸出力 (`impactReqs` / `originReqs`) によるドリフト追跡ガイドを記載する。
- **FR-029**: System MUST `README.md` の Skills 表に対応 mode 列(または注釈)を追加する。
- **FR-030**: System MUST 改訂後の 2 Skill 本文 (artgraph-impact / artgraph-plan-coverage SKILL.md) が各 100 行以下を維持する。

#### Scope exclusion (明示)

- **FR-031**: System MUST qualified name (`src/auth.ts:Class::method` / `src/auth.ts:Class.method`) を本 spec のスコープ外とする。parser は `:` で 1 回 split のみ行い、`Class::method` が graph に登録されていなければ `unresolvedSymbol` 警告で終わる(将来 issue に切り出し)。

### Key Entities

- **SymbolEntry**: Stage A parser が抽出する `{ path: string; symbol?: string; line: number }`。`symbol === undefined` で file 単位、定義済で symbol 単位。
- **unresolvedSymbol Diagnostic**: parser / plan-coverage が発出する `{ kind: "unresolvedSymbol"; sourceFile: string; symbol: string; line: number }`。`unresolvedFilePath` と per entry で排他。
- **ImpactGroup**: `{ sourceFile: string; sourceSymbol?: string; impactReqs: ReqEntry[]; originReqs: ReqEntry[] }`。symbol 起点なら `sourceSymbol` あり。`impactReqs` は BFS で到達した REQ、`originReqs` は startId の `@impl` claim 1-hop。
- **ImplicitImpactByReq**: `{ reqId: string; sourceLocations: Array<{ file: string; symbol?: string }> }`。symbol 情報を保持した起点ロケーション。
- **ReqEntry**: `{ reqId: string; kind: "req" }`。impactReqs / originReqs の要素型(spec 014 の AffectedReqEntry を継承)。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 同 file 内に複数 symbol が存在し各々別 REQ にひも付くテストプロジェクトで、`Files: src/X.ts:symbolA` と `Files: src/X.ts` の plan-coverage 結果を比較すると、symbol-level 入力では implicit REQ 数が **少なくとも 50% 以上削減** される(file 内に少なくとも 2 つの export がある前提)。
- **SC-002**: `artgraph impact src/auth.ts:validateToken` がローカルマシン (CPU 1 core, Node 22) で **2 秒以内に結果を返す** (file 入力と同オーダーのレイテンシを維持)。
- **SC-003**: symbol 入力時の plan-coverage / impact 出力 JSON で、`impactReqs` と `originReqs` の二軸が常に populate されている(graph に start node が解決された場合)。JSON consumer は二軸の差分 (`impactReqs \ originReqs`) をクライアント側で計算可能で、ドリフト候補を検知できる。
- **SC-004**: 改訂後の `artgraph-impact` / `artgraph-plan-coverage` Skill 本文がそれぞれ **100 行以下を維持**し、新規ユーザーが symbol mode の使い分けと二軸出力の解釈を 5 分以内に把握できる(`docs/skills-guide.md` の対応節を読む時間込み)。
- **SC-005**: `docs/skills-guide.md` 内で file mode と symbol mode の trade-off 表、`.artgraph.json` の `mode` 設定例、二軸出力によるドリフト追跡ガイドの 3 要素が掲載されている。
- **SC-006**: `tests/fixtures/symbol-mode/` の新規 fixture 上で、`Files: src/auth.ts:validateToken` 入力 → spec 後追いで `REQ-001 depends_on REQ-007` 追加 → 次回 plan-coverage で `impactReqs \ originReqs = [REQ-007]` が JSON 上で検知可能、を E2E テストで確認できる。

## Assumptions

- artgraph は **未リリース**。後方互換 / 既存ユーザー保護は考慮しない。spec 014 で書いた型 / 関数 / JSON schema は本 spec で clean に置き換える。テスト・fixture は本 spec の実装と並行して書き直す。
- graph builder と TypeScript parser には symbol 機能が既に存在 (`src/parsers/typescript.ts:107` `extractSymbols`、`mode: "symbol"` 経路) するため、本 spec は scan 側の新規実装ではなく **入力経路 / schema / docs の拡張に集中** する。
- `@impl` タグの抽出 (`extractImplTags` in `src/parsers/typescript.ts`) は spec 012 以前から既存。本 spec は `originReqs` を「graph 上で symbol node から `implements` edge を 1 hop 辿って到達する REQ」として計算するだけで、tag parse 側に新規実装は不要。
- 対象言語は TypeScript / JavaScript。他言語 (Python, Go 等) の symbol / `@impl` 解決は本 spec の対象外。
- symbol 名は **export された top-level symbol** に限る。class method、内部関数、nested function は対象外 (qualified name と同じく将来 issue)。
- enforcement (`--gate` exit code、`before_implement` hook) は spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/issues/105)) の範疇で、本 spec とは orthogonal。本 spec の `unresolvedSymbol` 診断は `--gate` 付きで非 0 exit に寄与する(spec 014 の既存ルール継承)。
- cross-agent 配布 (Spec Kit / Kiro / OpenSpec 等) は spec 013 ([#101](https://github.com/ShintaroMorimoto/artgraph/issues/101)) で扱い、本 spec は Skill 本文の symbol / 二軸言及追加に留める。
- User Story rollup (`### User Story N` 構造を graph node 化) は本 spec の対象外。`originReqs` は REQ (= FR) レベルまでで止め、US レベルの集約は別 spec の検討事項。
- Constitution v1.1.0 の原則(決定的グラフ第一 / 単一型付き4層グラフ / Spec Owns the ID / 構造整合のみ保証)は本 spec のすべての変更で維持される(LLM 推定なし、graph 操作は決定的、ID は spec 側で発行、新規 node 型なし)。
