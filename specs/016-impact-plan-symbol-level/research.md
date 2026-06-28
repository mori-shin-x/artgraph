# Research: impact / plan-coverage の symbol-level 入力対応

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

Spec 段階で 4 つの scope 質問はすべて解消済 (Scope=Full / scan default=opt-in / syntax=path:name / mixing=同セクション内 OK)。本ドキュメントは plan 段階で残った **実装上の意思決定** を Decision / Rationale / Alternatives 形式で整理する。

**前提**: artgraph は未リリースのため、本 spec は spec 014 で書いた型 / 関数 / JSON schema を **後方互換を一切考慮せず clean に置き換える**。以下の各決定は「旧 field / 旧 API を残す」案を一切採らない。

---

## R-001: parser の戻り値型 (single source of truth)

**Decision**: `ExtractResult` は `entries: SymbolEntry[]` を唯一の入力起点 field として返す。`files: string[]` は **廃止**。`SymbolEntry` は `{ path: string; symbol?: string; line: number }` で、`symbol === undefined` が file 単位、定義済が symbol 単位を表す。caller (CLI / plan-coverage / hook-pretool) は `entries` を直接受け取り、必要なら自前で `entries.map(e => e.path)` のようなビューを作る。

```ts
export type ExtractResult = {
  entries: SymbolEntry[];                    // dedup + sort 済 (path → symbol の二段ソート)
  stage: "files-section" | "regex-fallback" | "empty";
  diagnostics: Diagnostic[];
  taskBlocks?: TaskBlock[];
};
```

**Rationale**:

- 入力起点が 1 つの型に統一されることで、caller が file/symbol 混在を考慮する分岐ポイントが「parser から受け取る最初の 1 ヶ所だけ」になる。読み手のコストが最小。
- `files: string[]` と `entries: SymbolEntry[]` を両方返すと「どちらが正規か」が曖昧になり、test も両方の整合チェックを書くハメになる。型分岐の表面積を最小化する方針と直結。
- `symbol?` を optional にすることで file 単位と symbol 単位を同じ array で扱える (FR-002 の混在を 1 配列で表現)。

**Alternatives considered**:

- (A) `entries: Array<string | SymbolEntry>` の union: 各 caller で narrowing が要る。union は型情報を引き継ぐ pure な値に対しては表現力が高いが、ここでは「symbol field が無いだけ」なので optional 1 field で済む。
- (B) parser が `path:symbol` の生文字列を `entries: string[]` に入れる: 各 caller で再 split が必要、検証ロジックが分散して二重実装になる。

---

## R-002: SymbolEntry の型定義場所

**Decision**: `src/parsers/sdd-files.ts` に export として定義する。type 名は `SymbolEntry`、shape は `{ path: string; symbol?: string; line: number }`。CLI / plan-coverage / traverse は parser から import する。

**Rationale**:

- spec 014 の `Diagnostic` / `TaskBlock` / `ExtractResult` / `ExtractOptions` も `sdd-files.ts` に同居している。一貫した置き場。
- `src/types.ts` (グラフの ArtifactGraph 等) と分離: ArtifactGraph は graph データモデル、SymbolEntry は parser の I/O。レイヤが違う。
- `symbol?` を optional にすることで file unit entry も同じ型で表現可能 (FR-002 の混在を一つの array で扱える)。

**Alternatives considered**:

- (A) `src/types.ts` に移す: graph 型と parser 型が混在し責務が膨らむ。
- (B) inline anonymous type: caller 側で再宣言が必要、refactor 耐性が低い。

---

## R-003: `path:symbol` 検出ルール

**Decision**: parser の Stage A 内で各 entry に対し以下の正規表現で split:

```
const PATH_SYMBOL_RE = /^([^:\s]+\.[\w]+):([^\s,()]+)$/;
```

- グループ 1: path (拡張子付き、`:` を含まない)
- グループ 2: symbol (空白 / カンマ / 括弧を含まない、先頭の `:` で 1 回 split)

マッチしない entry は spec 014 と同じく path-only として扱う。`(new)` / `(deleted)` annotation を剥がした後に評価する。Stage B (regex fallback) では symbol 検出を行わない (FR-006: Stage A only)。

**Rationale**:

- `path.ts:fn` のような最小ケースから、ハイフン / 数字 / アンダースコアを含む symbol 名まで広くマッチ。
- 「拡張子があること」を path 条件に含めることで、例えば `Considered: REQ-003` の `REQ-003` を path として誤検出しない (拡張子なし → ヒットしない)。
- Stage B での regex fallback は元々 URL や HTML 属性を排除するための弱検証経路で、symbol 解決まで広げると誤検出が増える (URL 内の `:port` など)。明示 opt-in の Stage A のみ symbol 対応とする。

**Alternatives considered**:

- (A) `path.split(":")` で機械的に分割: Windows path (`C:\...`) や URL (`http://`) が誤分割される。
- (B) Stage B でも symbol 検出: 上述の URL `:port` 等で false positive が増える。Stage A のみで十分。
- (C) symbol 名に空白を許容: `Files: src/a.ts:My Class` 形を許容するか? → spec 確認 (FR-005) では `:` で 1 回 split し残りは symbol 名の一部、と決まっているが、文法的に空白を含む export 名は存在しない。`\s` を境界に入れるのは安全。

---

## R-004: symbol 解決の lookup 戦略

**Decision**: parser は path / symbol の生文字列を `SymbolEntry` で返すだけで graph lookup は行わない。lookup は `src/graph/traverse.ts` の新 resolver で行う。`SymbolEntry[]` を受け取り、entry ごとに以下の順で解決:

1. `symbol !== undefined` なら `symbol:<path>#<name>` を graph.nodes から exact lookup → ヒットしたら startId 採用、miss なら `unresolvedSymbols` array に積む。
2. `symbol === undefined` なら `file:<path>` を graph.nodes から exact lookup → ヒットしたら startId 採用。

呼び出し元 (CLI / plan-coverage) は返ってきた `unresolvedSymbols` から `unresolvedSymbol` diagnostic を組み立てる。

**Rationale**:

- parser 層で graph を参照しないことで、parser の unit test を graph 無しで書ける (現状そう作られている)。`ExtractOptions.graph` は file path 存在検証用にしか使われていない (Stage A の `unresolvedFilePath`)。symbol lookup を parser に持ち込むと parser の責務が肥大する。
- 解決失敗を別 array で返すと、CLI / plan-coverage で diagnostics 生成のロジックを統一できる。
- `traverse.ts` は元々 graph traversal の責任を持つレイヤなので、lookup を集約しても責務が拡張せず自然。

**Alternatives considered**:

- (A) parser 内で graph.nodes を引いて `unresolvedSymbol` diagnostic を生成: parser の責務が「path 抽出」から「graph 参照」に膨らむ。
- (B) CLI 側で `graph.nodes.has(\`symbol:\${path}#\${symbol}\`)` を直書き: 同じ lookup ロジックが 2 ヶ所に重複 (CLI と plan-coverage)。

---

## R-005: traverse.ts の resolver 設計 (single function)

**Decision**: 既存 `resolveFileStartIds(graph, inputs: string[])` を **削除** し、新 `resolveStartIds()` 一本に置き換える。シグネチャは:

```ts
export function resolveStartIds(
  graph: ArtifactGraph,
  entries: SymbolEntry[],
): { startIds: string[]; unresolvedSymbols: SymbolEntry[] };
```

- `entry.symbol` が定義済なら `symbol:<path>#<name>` を lookup、miss なら `unresolvedSymbols` に積む。
- `entry.symbol` が undefined なら `file:<path>` を lookup、miss なら spec 014 の `unresolvedFilePath` 経路 (parser 側で既に diagnostic 発出済) に依存。
- 戻り値の `startIds` は dedup + 安定ソート済。

caller (CLI `impact` / plan-coverage / hook-pretool) は全員このシグネチャに統一する。

**Rationale**:

- file 入力と symbol 入力を 1 関数で扱うことで、混在 (`Files: src/a.ts:fn1, src/b.ts`) を caller が分岐せずに渡せる。FR-002 の混在許容と直結。
- 関数を 2 つ並べる (`resolveFileStartIds` と `resolveSymbolStartIds`) と「どちらに渡せばいいか」を caller が判断する責務が生まれる。entry 単位の symbol 有無で内部 dispatch する方が、caller の型分岐の表面積が小さい。
- 戻り値を `{ startIds, unresolvedSymbols }` の object にすることで、CLI / plan-coverage で diagnostic 生成のフローを統一できる (parser → resolver → diagnostic builder の 3 段)。

**Alternatives considered**:

- (A) `resolveFileStartIds` と `resolveSymbolStartIds` を別々に export: file/symbol 混在 entry の処理が呼び出し側に漏れる。FR-002 で混在は許容されるので 1 関数で扱う方が自然。
- (B) `resolveStartIds(graph, inputs: string[])` で path:symbol 文字列を受け、resolver 内で split: 既に parser で split 済の情報を文字列に戻して再 parse する無駄。型情報を捨てる anti-pattern。

---

## R-006: `impact()` の symbol 入力時の挙動

**Decision**: `impact()` 本体は **完全に据え置き** (spec 014 の FR-008 と同じ)。startIds に `symbol:<path>#<name>` が渡れば、既存の BFS が自然に symbol 単位の forward 波及を辿る。同 file 内の他 symbol は startIds に含まれないため、BFS は file ノード経由でしか他 symbol に到達しない。

ただし spec 014 の `impact()` には以下のロジックがある (`src/graph/traverse.ts:29-35`):

```
if (node && node.kind === "file") {
  for (const [symId, symNode] of graph.nodes) {
    if (symNode.kind === "symbol" && symNode.filePath === node.filePath && !visited.has(symId)) {
      queue.push({ id: symId, depth: depth + 1 });
    }
  }
}
```

これは file 起点 BFS で同 file 内の symbol を取り込む経路。**symbol 起点入力時はこのロジックが意図せず file 経由で他 symbol を集める可能性がある**。BFS が bidirectional なので symbol → file (parent) → 他 symbol という経路が成立してしまう。

**対策**: 本 spec の `impact()` には介入しないが、symbol 入力時の startId に「file ノードを含めない」ことで bidirectional 探索の最初の hop で file に到達しないようにする。file に到達するのは `imports` エッジ経由のときだけで、その場合は別 file の話なので問題なし。

**Rationale**:

- 新 `resolveStartIds()` (R-005) は symbol entry に対して **file ノードを startIds に含めず symbol ノードのみ** を返す方針。file entry に対してのみ `file:<path>` を返す。これにより file 経由の他 symbol 取り込みは symbol 入力時には発生しない。
- 動作確認は US1 Acceptance Scenario 1 と Independent Test で観察可能 (同 file 多 symbol fixture で REQ-005 / REQ-009 が implicit に上がらないこと)。

**Alternatives considered**:

- (A) `impact()` 本体に「symbol 起点なら同 file 他 symbol を skip する」フラグを追加: spec 014 の `impact()` 契約破壊、`maxDepth` と並ぶ第 4 引数増。複雑性増。
- (B) symbol 起点で `--depth 1` を強制: 想定外の制約、ユーザーが意識せねばならず UX 悪。

---

## R-007: `--mode` 自動推論の挙動

**Decision**: CLI `impact` で `--mode` 省略時、(a) 入力に `:` 構文があれば内部 mode を `symbol` 扱い、(b) 入力が file path のみなら config の `mode` をそのまま継承。明示的に `--mode file` を指定して symbol 入力すると、parser で `:` を split せず file path として graph lookup → 当然 miss → 「No matching nodes found」エラー (現行の不一致挙動と同じ)。

**Rationale**:

- 「symbol syntax があれば auto switch」が issue #107 の question B 案。spec で確定。
- 明示 `--mode file` で symbol input が混ざるケースは矛盾入力 (user error)。標準的な「指示通りに動かして失敗を観察させる」挙動でよい。silent fallback は予測困難になり害が大きい。

**Alternatives considered**:

- (A) 明示 `--mode file` で symbol input → エラーで「mode と入力が不整合」と教える: 親切だが特殊エラー経路を 1 つ増やす。R-007 の rationale で書いた通り標準挙動で十分。
- (B) `--mode` を完全に廃止し常に input から推論: 一部 fixture / test が `--mode` を明示しているため、test 群全体の書き換えが必要。本 spec のスコープに対して bang-for-buck が低い。

---

## R-008: `plan-coverage` の `implicitImpactsByReq` schema (single shape)

**Decision**: `implicitImpactsByReq[]` の各エントリは `{ reqId: string; sourceLocations: Array<{ file: string; symbol?: string }> }` の **単一の shape** とする。spec 014 の `sourceFiles: string[]` field は **廃止**。

```ts
export interface ImplicitImpactByReq {
  reqId: string;
  sourceLocations: Array<{ file: string; symbol?: string }>;  // dedup + sort 済
}
```

`sourceLocations` 内で `symbol === undefined` のエントリは file-only 入力に由来、`symbol` 定義済は symbol-level 入力に由来。

**Rationale**:

- 起点情報を 1 つの shape (`{ file, symbol? }`) に統一すると、JSON consumer は「常に sourceLocations を読めば file も symbol も両方手に入る」と言える。consumer の分岐が消える。
- `sourceFiles` を別配列で並走させると「sourceLocations 由来の file を集計して並べるだけの冗長 field」になり、consumer が「どちらを正規として読めばいい?」と迷う。
- ソート / dedup は `(file, symbol ?? null)` の複合キーで決定的に決められ、出力安定性は保てる。

**Alternatives considered**:

- (A) `sourceFiles: string[]` だけを残し symbol 情報を捨てる: symbol 起点の表示や drift 集計が JSON consumer 側で不可能になり、本 spec の目的 (symbol 粒度の機械可読性) に反する。
- (B) `sourceLocations` を string union (`"src/a.ts"` か `"src/a.ts:fn1"`) で並べる: consumer 側で再 split が必要、`#` / `:` のどちらを delimiter にするかで output / input の grammar が二重実装になる。

---

## R-009: `unresolvedSymbol` diagnostic の発出ルール

**Decision**: 以下の優先順位で発出:

1. **path も symbol も両方 graph 未登録** → `unresolvedFilePath` のみ (既存挙動、symbol は重ね打ちしない: Edge Case 「file path も symbol も両方 graph に無い」)。
2. **path は graph or fs に存在するが symbol が graph 未登録** → `unresolvedSymbol`。
3. **path が graph or fs に存在し symbol も graph 登録済** → 診断なし、startId 採用。

`unresolvedSymbol` の形:

```ts
{ kind: "unresolvedSymbol"; sourceFile: string; symbol: string; line: number }
```

`unresolvedFilePath` (既存) と排他 (per entry)。1 entry あたり最大 1 つの診断のみ。

**Rationale**:

- 重ね打ちは UX を悪化させる (path typo の警告と symbol 不在の警告が同じ entry に対して両方出る → user は何を直せばいいか分かりにくい)。
- 「path も無い」は path 修正の方が先 (symbol は path 解決後にしか意味を持たない)。
- diagnostic 1 entry あたり最大 1 つにすることで、`plan-coverage` の `diagnostics[]` のソート / 表示ロジックが単純になる。

**Alternatives considered**:

- (A) 両方発出: user の認知負荷増。
- (B) 全 path / symbol miss を 1 つの `unresolvedEntry` に統合: kind 区別ができず error message を type-safe に出し分けられない。

---

## R-010: scan mode mismatch (symbol input on file-mode graph) のエラー設計

**Decision**: parser / traverse は graph 内に symbol node が 1 つもない状態を「symbol-mode scan されていない」と判定し、`unresolvedSymbol` diagnostic を全 symbol entry に発出する (個別 entry の検出失敗と同じパス)。

加えて CLI `impact` 層では「symbol 入力があったが symbol node が graph に 1 つもない」グローバル条件を検出し、stderr に追加メッセージを出す:

```
ERROR: symbol-level input requires `artgraph scan --mode symbol`.
Set `mode: symbol` in `.artgraph.json` and re-run scan to enable symbol-mode lookup.
```

そして exit 1。

**Rationale**:

- 「全 entry が unresolvedSymbol」だと user は個別 typo と勘違いする恐れがある。グローバル条件としての警告メッセージで「scan mode を変えろ」と明示する方が UX 良。
- 既存 plan-coverage の挙動 (empty extraction → emptyExtraction diagnostic + hint) と同じ pattern。

**Alternatives considered**:

- (A) parser 層で scan mode を検出して特殊 diagnostic を発出: parser は graph type を見ない方が責務分離が美しい。
- (B) silent fallback (symbol を path として扱う): R-007 と同じく silent fallback は予測困難。

---

## R-011: `--from-tasks` 経由での scan mode mismatch ハンドリング

**Decision**: `--from-tasks` 経由でも CLI 層で graph の symbol node 存在チェックを行い、symbol entry が含まれるが symbol node が無い場合は R-010 と同じエラーで exit 1。

**Rationale**:

- 本 spec の新 resolver `resolveStartIds` は parser → resolver → CLI の 3 段で呼ばれるので、symbol mismatch チェックを CLI 一箇所に集約できる。
- plan-coverage の方では「diagnostic として並べる」運用なので、CLI と plan-coverage で finally の警告メッセージ表示は同じだが exit code 制御は独立 (`impact` は exit 1、`plan-coverage` は `--gate` 付きのときだけ exit 1)。

---

## R-012: 出力 text フォーマットでの symbol 表現

**Decision**: text フォーマット (spec 014 の `formatText`) で symbol 起点の sourceFile を `src/auth.ts#validateToken` 形で表示。`#` を境界文字に使う (npm package 名や JSON path で symbol を表す慣例)。

```
By source file:
  src/auth.ts#validateToken
    Affected: REQ-001, REQ-007  (req)
    Origin (claim): REQ-001
    Drift candidates: REQ-007
  src/session.ts
    Affected: REQ-005  (req)
```

`src/auth.ts:validateToken` の input syntax と区別: `:` は input grammar (sdd-files Stage A) の責務、`#` は output rendering の責務で対称的。symbol-id 形式 (`symbol:src/auth.ts#validateToken`) からも prefix を剥がしただけの形で自然。

**Rationale**:

- 既存の symbol node ID 形式 (`symbol:<path>#<name>`) と整合。
- `:` を区切りに使うと WindowsPath との見た目衝突。`#` は path に現れない anchor 慣例 (URL fragment, JSON Pointer)。

**Alternatives considered**:

- (A) `src/auth.ts:validateToken` (input と同じ): WindowsPath 衝突や、後で qualified name 拡張時に `Class::method` を含めると `:` が 2 重に現れて読みにくい。
- (B) `src/auth.ts validateToken` (空白区切り): copy-paste で 1 token として扱いにくい。

---

## R-013: テスト fixture の設計

**Decision**: `tests/fixtures/symbol-mode/` を新設し、以下の構成:

```
tests/fixtures/symbol-mode/
├── .artgraph.json                  # mode: symbol
├── src/
│   └── auth.ts                     # 3 export: validateToken/issueToken/revokeToken
├── specs/
│   └── 001-symbol-demo/
│       ├── spec.md                 # REQ-001/REQ-005/REQ-009 を発行
│       └── tasks.md                # `Files: src/auth.ts:validateToken` 等
└── tests/
    └── auth.test.ts                # 3 symbol を verify
```

`tests/sdd-files-parser.test.ts` / `tests/impact-cli.test.ts` / `tests/plan-coverage.test.ts` の 3 ファイルにこの fixture を使った integration ケースを追加。`tests/traverse.test.ts` には `resolveStartIds` の unit test を直接書く (fixture 不要)。

**Rationale**:

- 既存 fixture (`tests/fixtures/specs/` 配下) は file mode 前提なので継続。symbol mode 専用 fixture を分離することで、scan mode mismatch のテスト (R-010 / R-011) も自然に書ける。
- 3 symbol / 3 REQ の最小構成で過剰検知抑制 (US1) と symbol 直接入力 (US2) の両方を検証可能。

---

## R-014: docs/skills-guide.md の追記内容

**Decision**: 「file mode vs symbol mode」の独立節を新設 (既存 Skills 解説の後半)。以下を含める:

| 項目 | file mode | symbol mode |
|---|---|---|
| 起動コスト (scan latency) | 低 (file の content-hash) | 高 (ts-morph で export 抽出) |
| Files: syntax | `src/a.ts` | `src/a.ts:fn1` (上述に加えて file 単位も混在 OK) |
| 想定ユーザー | 新規実装 / 大規模 refactor | 既存関数 1 個だけ修正する保守ケース |
| 必要な scan 設定 | デフォルト | `.artgraph.json` で `"mode": "symbol"` |
| barrel / re-export | OK 対応 | 一部不可 (動的 import / namespace import) |

各 Skill 本文 (artgraph-impact / artgraph-plan-coverage) には 1 行で「symbol-level 入力は `scan --mode symbol` 実行済の graph が前提」のみ記載し、詳細は docs/skills-guide.md に流す。100 行制約を守るため。

**Rationale**:

- Skill 本文は agent が毎回読むので簡潔に。
- docs/skills-guide.md は人間がじっくり読むドキュメントなので trade-off 表が向く。
- 「barrel / re-export 一部不可」は Constitution 「symbol-level に解決できないエッジは file-level にフォールバック」の運用ガイドとして重要。

---

## R-015: `originReqs` の算出方針 (1-hop `implements` reverse)

**Decision**: `originReqs` は ImpactGroup の startId ノード(file node or symbol node)から、graph 上の `implements` edge を **逆向きに 1 hop だけ** 辿った先の REQ ノード集合とする。dedup + sort 済の `ReqEntry[]` で表現。

- symbol startId (`symbol:src/auth.ts#validateToken`) → `implements` edge の source が当該 symbol、target が REQ のエッジを集める → target を REQ 集合に追加。
- file startId (`file:src/auth.ts`) → 同上、source が file node のエッジのみ。
- claim が無いケースは `originReqs: []`。

実装上は graph.edges を線形スキャン (`edge.kind === "implements" && edge.source === startId`) で十分。N が小さい (通常 1 file あたり数本) ため index は不要。

**Rationale**:

- graph に既に `implements` edge が登録されており (`extractImplTags` in `src/parsers/typescript.ts`)、1 hop 辿るだけなので新規 BFS や新規 parser は不要。Constitution V (構造整合のみ保証) と整合。
- 1 hop に限定することで決定的かつ高速。SC-002 (impact が 2 秒以内) に余裕で収まる。
- `originReqs` (claim) と `impactReqs` (forward BFS reach) を **別軸として明確に分離** することで、consumer は二軸の差分 `impactReqs \ originReqs` を「symbol が claim していない波及先 = drift 候補」として読める。1 hop が長くなると claim 集合自体が膨らみ、差分の意味が「真のドリフト」と「自然な遷移」の区別を失う。

**Alternatives considered**:

- (A) `@impl` タグを文字列ベースで再 parse して `originReqs` を組み立てる: graph と parser で同じ事実を二重実装、ズレた時にどちらが正かが曖昧。graph を信用する単一経路にすべき。
- (B) startId から forward BFS で深く辿った REQ 集合を `originReqs` にする: `impactReqs` と区別がつかなくなり、二軸出力の意味が消える。drift 検知の前提が崩壊。
- (C) symbol startId が同 file の file-top `@impl` タグも継承する: 各 symbol は自分が claim した REQ だけを originReqs として持つ前提を崩す。file-top タグは file 入力時のみ意味を持ち、symbol 入力時に勝手に紛れ込むと claim が不正確に膨らみ、drift 計算がノイジーになる。

---

## R-016: 二軸出力 (`impactReqs` + `originReqs`) の表示形式

**Decision**: `ImpactGroup` は `impactReqs: ReqEntry[]` と `originReqs: ReqEntry[]` を **独立した 2 array** として保持。CLI text 出力では ImpactGroup ごとに以下 3 セクションで表示:

```
src/auth.ts#validateToken
  Affected: REQ-001, REQ-007
  Origin (claim): REQ-001
  Drift candidates: REQ-007
```

- `Affected:` → `impactReqs` の中身。
- `Origin (claim):` → `originReqs` の中身。空集合ならセクション省略。
- `Drift candidates:` → `impactReqs \ originReqs` を CLI 側で計算して表示。空集合ならセクション省略 (FR-015)。

JSON consumer (Skill / エージェント) は `impactReqs` / `originReqs` の 2 array を直接読み、必要に応じて差分計算をクライアント側で実装する。

**Rationale**:

- spec.md (user 確定済) で「差分計算は consumer 側で行い、CLI で `driftedClaim` 自動 diagnostic は発出しない」方針が確定。1 hop だけで「真のドリフト」と「spec.md が追加された自然な拡張」を区別するのは不可能で、自動 diagnostic は誤検知の温床になる。
- JSON では 2 array をそのまま並べ、人間向けの text 出力でのみ親切な差分計算 + 表示を行う。format ごとに「機械可読 vs 人間可読」の責務を分けるのは spec 014 の formatText / json 分離と同じ思想。
- `impactReqs \ originReqs` を CLI text で 1 セクションとして見せることで、ユーザーは追加 enforcement 機能 (spec 015) を待たずに「drift 候補」を目視確認できる。即座に価値が出る最小実装。

**Alternatives considered**:

- (A) 差分を `driftedClaim` kind の diagnostic として自動発出: 1 hop だけだと REQ-001 → REQ-007 が「依存追加」なのか「クレーム漏れ」なのか機械的に区別できず、誤検知だらけになる。spec 015 の enforcement で文脈を持って判定する。
- (B) `impactReqs` から `originReqs` を引いた `driftedReqs` field を JSON にも入れる: consumer 側で 1 行で計算できる差分を field として持つのは API の冗長化。consumer の柔軟性 (ignore list 適用後に差分を取りたい等) を奪う。

---

## R-017: file 入力の `originReqs` の挙動 (uniform application)

**Decision**: file startId に対しても symbol startId と **同じロジック** (`implements` edge を逆向きに 1 hop) を uniform に適用する。file-top に `@impl` タグがあれば populate、無ければ `originReqs: []`。symbol/file で API を分岐させない。

```
ImpactGroup {
  sourceFile: "src/auth.ts",
  // sourceSymbol なし (file 入力)
  impactReqs: [REQ-001, REQ-005, REQ-009],  // BFS で 3 symbol の REQ を全部拾う
  originReqs: [],                            // file-top `@impl` タグなしの場合
}
```

**Rationale**:

- 「symbol 入力時だけ二軸、file 入力時は単軸」だと API の型分岐が増え、consumer が `if (sourceSymbol) ... else ...` の分岐を毎回書くハメになる。
- uniform 適用なら型シグネチャがシンプル (`ImpactGroup` は常に `impactReqs` と `originReqs` を持つ)。file-top タグ運用が無いユーザーは `originReqs: []` で運用、それでも `impactReqs` 単独で plan-coverage の本来の価値は提供できる。
- file-top `@impl` タグ運用 (graph に file → REQ の implements edge を持つ) を採用するユーザーがいた場合、自動的に二軸出力が機能する。将来の拡張余地として無料で手に入る。

**Alternatives considered**:

- (A) file 入力時は `originReqs` field 自体を省略 (`undefined`): consumer の型が `originReqs?: ReqEntry[]` になり narrowing が要る。「常に array (空配列許容)」の方が consumer の cost が低い。
- (B) file 入力時に同 file 内の全 symbol の `@impl` claim を集約して `originReqs` に入れる: file 入力の `impactReqs` (= 同 file 内全 symbol からの BFS 集合) とほぼ同じになり、差分が常に空集合になって drift 検知の意味が消える。

---

## まとめ

| 決定領域 | キー判断 |
|---|---|
| parser 戻り値型 | `entries: SymbolEntry[]` 一本、`files: string[]` 廃止 (R-001) |
| SymbolEntry 置き場 | `src/parsers/sdd-files.ts` に export (R-002) |
| `:` 検出 regex | 拡張子付き path で boundary を取り false positive 回避 (R-003) |
| graph lookup 集約 | parser は文字列のみ、resolver は traverse.ts に集約 (R-004) |
| traverse resolver | `resolveStartIds()` 一本、戻り値 `{startIds, unresolvedSymbols}` (R-005) |
| `impact()` 本体 | 完全据え置き、file 経由の他 symbol 取り込みは resolver で startId に file を含めないことで回避 (R-006) |
| `--mode` 自動推論 | `:` syntax 検出時のみ symbol 採用、明示 file mode との衝突は user error (R-007) |
| `implicitImpactsByReq` schema | `sourceLocations: Array<{file, symbol?}>` 一本、`sourceFiles` 廃止 (R-008) |
| diagnostic 排他 | 1 entry 最大 1 diagnostic、path miss 優先 (R-009) |
| scan mode mismatch | CLI 層でグローバル警告 + exit 1 (R-010) |
| `--from-tasks` mismatch | CLI 層で同等チェック、plan-coverage 側は diagnostic 経路 (R-011) |
| text 出力 | symbol は `path#name` 形で表示、3 セクション併記 (R-012) |
| テスト fixture | `tests/fixtures/symbol-mode/` 新設、3 symbol / 3 REQ 構成 (R-013) |
| docs/skills-guide.md | file mode vs symbol mode trade-off 表 + 二軸出力ガイド (R-014) |
| `originReqs` 算出 | `implements` edge を逆向き 1 hop、新規 BFS 不要 (R-015) |
| 二軸出力表示 | `impactReqs` / `originReqs` を独立 array、text のみ Drift candidates セクション (R-016) |
| file 入力の二軸挙動 | symbol と uniform に適用、claim なしは `originReqs: []` (R-017) |

すべての判断は Constitution の決定的グラフ第一 / Spec Owns the ID / 構造整合のみ保証と整合 (LLM 推定なし、graph 操作は決定的、ID は spec 側で発行、新規 node 型なし)。Phase 1 design に進む準備完了。
