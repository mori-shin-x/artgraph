# 設計: ドキュメント間グラフ構造の整理（リーン v1）

- ステータス: ドラフト（敵対的レビュー反映済み 2026-06-20）
- 対象ブランチ: `claude/document-graph-structure-hjgvia`

## 0. この版について

初版（A+B+C 全部入り）に対し、4 視点の敵対的レビューを実施。その結果を受けて
**スコープを「リーン v1」に縮小**し、前提の弱さ・整合性の穴を是正した。主要な変更:

- C-2（インラインリンク）/ C-3（規約推論・ConventionPreset）/ A（req↔req）/
  `via` フィールドは **v1 から外し、後続 Issue 化**（§11）。
- `doc --contains--> req`（旧 Issue #10）を **v1 に昇格**。doc グラフを要求・実装と
  繋ぐ骨格として必須と判断。
- **`spectrace graph` 出力コマンドを v1 ゴールに追加**。グラフを「見える化」しないと
  「md 依存を管理する」という目的が達成されないため。

レビューで指摘された整合性の穴（向き競合・デデュープ未定義・ハッシュ机上論・
リンク解決の曖昧さ）は、原因だった C-2/C-3/A を後送りしたことで v1 では大半が消滅
する。残る論点（doc の drift 粒度、contains の影響範囲、orphan 検出）は §6〜§8 で確定。

## 1. 背景と狙い

spectrace は「仕様 ⇔ 実装」の双方向トレーサビリティが主軸。本来の狙いは
**SDD ツールが出力する Markdown 群の依存関係を管理すること**にある。

| ツール | 主な出力 | 自然な連鎖 |
| --- | --- | --- |
| GitHub Spec Kit | `spec.md` → `plan.md` → `tasks.md`（+ `research.md`） | plan derives from spec、tasks derives from plan |
| AWS Kiro | `requirements.md` → `design.md` → `tasks.md` | design derives from requirements、tasks derives from design |

### 1.1 前提の明確化（レビュー指摘 #4 への対応）

実物の Kiro `requirements.md` は EARS 記法（"WHEN … THEN the system SHALL …"）の
**散文**、Spec Kit `spec.md` も散文中心であり、`FEAT-001:` のような要求 ID の
箇条書きを必ずしも含まない。したがって本設計では:

- **グラフの基本単位はファイル（doc ノード）**とする。要求 ID 抽出は
  「ある場合に拾う」ベストエフォートに格下げ。
- 要求 ID が無くても、ファイル＝ doc ノードとして依存グラフが成立することを保証する
  （C-1）。

参考: Spec Kit https://github.com/github/spec-kit/blob/main/spec-driven.md ／
Kiro https://kiro.dev/docs/specs/ ／ https://kiro.dev/docs/steering/

## 2. 現状分析

### 2.1 モデル（`src/types.ts`）

```
NodeKind = "req" | "doc" | "file" | "symbol" | "test"
EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports"
```

| エッジ | 意味 | 入力 |
| --- | --- | --- |
| `implements` | コード → 要求 | `// @impl REQ-ID`（`src/parsers/typescript.ts`） |
| `verifies` | テスト → 要求 | `[REQ-ID]` / `req:` 注釈 |
| `imports` | コード → コード | TS AST |
| `depends_on` / `derives_from` | doc → 要求 | frontmatter `spectrace.depends_on`（`src/parsers/markdown.ts:54-63`） |

### 2.2 Markdown 取り込み（`src/parsers/markdown.ts`）

ノード生成は 3 経路: (1) frontmatter `spectrace.node_id` がある時のみ `doc` ノード
（`:44-52`）、(2) リスト項目 `- FEAT-001:`（`:66-82`）→ req、(3) 見出し
`Requirement 1:`（`:84-100`）→ req。

### 2.3 現状の制約（v1 で解消する範囲）

- frontmatter が無い散文 md（design.md 等）は **ノード 0 個**でグラフから消える
  → C-1 で解消。
- doc グラフと req/実装が **filePath による暗黙の繋がりしか持たず分断**
  → `contains` エッジで解消。
- doc 依存構造を **見るコマンドが無い**（`scan` は件数のみ）
  → `graph` コマンドで解消。

## 3. ゴールと非ゴール

### v1 ゴール

- **C-1**: 各 md ファイルを `doc` ノードとして自動登録（frontmatter 不要）。
- **B**: doc → doc 依存を **frontmatter で**表現できる。
- **contains**: `doc --contains--> req` を生成し、ドキュメント階層 → 要求 → 実装を
  一気通貫で辿れる。
- **graph 出力**: `spectrace graph` で doc 依存チェーンを text / JSON で出力。

### v1 非ゴール（後続 Issue 化、§11）

- C-2 インラインリンク自動抽出。
- C-3 ツール規約の自動推論 / `ConventionPreset`。
- A 要求 ⇔ 要求の依存。
- `via` エッジメタ。
- DOT / Mermaid 等のリッチ可視化（v1 は text/JSON のみ）。
- `symbol` 粒度、steering doc、task 粒度のモデル化、版管理。

## 4. エッジの向きとセマンティクス

- `derives_from`: 下流 → 上流（派生したもの → 派生元）。
  - 例: `design.md --derives_from--> requirements.md`
- `depends_on`: 一般的な依存。
- `contains`: doc → その doc 内で定義された req。**所属関係**（新規 EdgeKind）。
  - 例: `doc:auth/requirements.md --contains--> AUTH-001`
- `impact()` は双方向 BFS（`src/graph/traverse.ts:13-20`）。

### 4.1 v1 で向き競合が起きない理由（レビュー指摘 #1 への対応）

初版では doc↔doc エッジを frontmatter / インラインリンク / 規約の 3 経路で生成し、
経路ごとに向きが異なって**同一ペアに逆向きエッジ**が生じ得た。v1 では doc↔doc の
入力を **frontmatter 1 経路のみ**に限定するため、向きは作者が `relation` で一意に
指定する。複数経路のデデュープ問題自体が v1 では発生しない。

ただし最小限の防御として builder で**エッジのデデュープ**を入れる（§6.4）。
デデュープのキーは **`(source, target, kind)`**。同一 source→target でも kind が
違えば別エッジとして保持する。

## 5. データモデルの変更

### 5.1 doc ノード ID 規約

- frontmatter `spectrace.node_id` があれば優先。
- 無ければ **`doc:<specDir からの相対パス>`** を自動採番。
  - 例: `specs/003-chat/design.md` → `doc:003-chat/design.md`
- 制約: req ID は `doc:` / `file:` / `test:` / `symbol:` プレフィクスを持てない
  （builder で検出し `duplicate-id` 警告）。レビュー指摘の名前空間衝突対策。

### 5.2 型変更（`src/types.ts`）

```ts
export type EdgeKind =
  | "depends_on" | "derives_from" | "implements" | "verifies" | "imports"
  | "contains"; // 追加: doc → req の所属関係
```

`via` フィールドは v1 では**追加しない**（消費者がいないため。後続で必要なら導入）。

### 5.3 設定（`SpectraceConfig`）

```ts
export interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  // 追加（v1 は per-file の 2 フラグのみ）
  docGraph?: {
    autoDocNodes?: boolean; // C-1: md=doc ノード自動生成（既定 true）
    contains?: boolean;     // doc→req contains エッジ生成（既定 true）
  };
}
```

`conventions` / `inlineLinks` / `ConventionPreset` は v1 では持たない（後続）。
パーサに渡すのは per-file フラグのみとし、ディレクトリ横断の関心事を持ち込まない
（レビュー指摘の層分離）。

## 6. 各機能の設計

### 6.1 C-1: ファイル＝ doc ノードの自動生成

**パーサ変更（`src/parsers/markdown.ts`）**

- シグネチャを `parseMarkdown(filePath, rootDir?, options?: ParseMarkdownOptions)`
  に拡張。`ParseMarkdownOptions = { autoDocNodes?: boolean; contains?: boolean }`。
  builder から `config.docGraph` の該当フラグを渡す。
- `autoDocNodes !== false` のとき、frontmatter の有無に関わらず各 md に `doc` ノードを
  1 個生成。ID は §5.1。`contentHash` はファイル全体ハッシュ（既存 `fileHash`、
  `:38`）。
- 既存挙動との関係: req ノードは従来どおり併存。`node_id` 付き frontmatter の doc は
  自動採番より優先（指定の尊重。互換目的ではない）。

**drift 粒度（レビュー指摘への対応）**

- doc ノードの `contentHash` はファイル全体。**散文を直すと doc が drift する**のは
  仕様として受容する（ドキュメントの変更を検知するのが目的のため妥当）。
- 同一ファイル内の req ノードは従来どおり**その req の本文のみ**でハッシュ（`:73`,
  `:90-91`）。doc の drift と req の drift は独立。要求が変わらず散文だけ直した場合は
  doc のみ drift し、req は drift しない。これは意図どおり。

### 6.2 B: ドキュメント ⇔ ドキュメント依存（frontmatter）

**入力**

```yaml
---
spectrace:
  node_id: "doc:003-chat/design"
  depends_on:
    - { id: "doc:003-chat/requirements", relation: derives_from }
---
```

- `relation` の許容値は **`depends_on` / `derives_from` のみ**。それ以外は
  ビルド警告（`invalid-relation`）を出す。未リリースのためフォールバックは設けず、
  既存 fixture `tests/fixtures/specs/auth.md` の `relation: implements` は
  `derives_from` へ修正する。
- ターゲットは別 doc の ID（B）または req ID（doc→req を frontmatter で明示する場合）。

**builder（`src/graph/builder.ts`）**

- doc→doc エッジはソースが req でないため `nonReqEdges` 経路（`:48-56,116-127`）。
  既存どおり通る。
- ターゲット未存在時に **`orphan-doc` 警告**を出す（§6.5）。

### 6.3 contains: doc → req の所属関係（旧 Issue #10、v1 昇格）

**目的**: doc グラフと req/実装グラフを接続し、`design.md` 変更 → 中の要求 →
実装まで impact が到達するようにする。

**生成ロジック（`src/parsers/markdown.ts`）**

- `contains !== false` のとき、1 つの md から生成した doc ノードと、その同じ md から
  抽出した各 req ノードの間に `doc --contains--> req` エッジを張る。
- doc ノードが無い（autoDocNodes=false かつ node_id 無し）場合は contains を張らない。
- パーサはファイル単位で完結するため、doc とその file 内 req の対応は自明
  （同一 `parseMarkdown` 呼び出し内で生成）。

**builder の ID remap 整合**

- 衝突した req は最終 ID が `specDir/REQ` に変わる（`:77-108`）。contains エッジの
  ターゲットも同じ remap を通す必要がある。contains は req をソースに持たない
  （ソースは doc）ため `nonReqEdges` 経路に乗る。`remapId`（`:180-193`）が
  ターゲット req を解決できるよう、**contains も remap 対象に含める**。

**impact への影響（ブラストradius、レビュー指摘 #3 への対応）**

- contains により doc 起点の impact が中の全 req＋実装へ広がる。これは**意図した
  挙動**（一気通貫トレースの実現）。
- ただし「広がりすぎ」を可視化するため、`impact` 出力に到達ノード数の内訳
  （docs / reqs / files）を表示する（既存 `ImpactResult` のまま CLI 表示を拡充）。
- 上限深さ等の制御は v1 では入れない（必要なら後続）。

### 6.4 builder のエッジデデュープ

- 全エッジ確定後、`(source, target, kind)` をキーに重複を除去する単純パスを追加。
- v1 では入力経路が限られるため重複は稀だが、frontmatter で同じ依存を二重記載した
  場合などの保険。

### 6.5 orphan-doc / 名前空間検証

- `findOrphans`（`src/graph/traverse.ts:61-73`）を拡張し、`depends_on` /
  `derives_from` でターゲットノードが存在しないものを `orphan` として報告する
  （現状は implements/verifies のみ）。
- builder で req ID が予約プレフィクス（`doc:` 等）を使っていないか検証し、
  使用時は警告。

### 6.6 graph 出力コマンド

**新規 CLI サブコマンド `spectrace graph`（`src/cli.ts`）**

- `spectrace graph [--format text|json] [--kind doc|req|all]`
  - `--format text`（既定）: doc を起点に依存チェーンをインデント表示。
    ```
    doc:003-chat/tasks.md
      └─ derives_from → doc:003-chat/design.md
           └─ derives_from → doc:003-chat/requirements.md
                └─ contains → AUTH-001  (impl: src/auth/login.ts)
    ```
  - `--format json`: `{ nodes: [...], edges: [...] }` をそのまま出力（機械可読・
    後続の可視化やCIで利用）。
  - `--kind` で表示対象ノード種別を絞り込み（既定 all）。
- 実装はグラフを構築して整形するだけ。DOT/Mermaid は後続 Issue。

## 7. 影響範囲（ファイル別）

| ファイル | 変更 |
| --- | --- |
| `src/types.ts` | `EdgeKind` に `contains` 追加、`SpectraceConfig.docGraph?`（2 フラグ）追加 |
| `src/parsers/markdown.ts` | C-1 自動 doc ノード、contains エッジ、relation 検証、options 引数追加 |
| `src/graph/builder.ts` | contains の target remap、エッジデデュープ、req ID 予約プレフィクス検証、orphan-doc |
| `src/graph/traverse.ts` | `findOrphans` を depends_on/derives_from に拡張。impact は変更不要（双方向 BFS） |
| `src/lock.ts` | `contains` は lock 化しない（doc/req のハッシュは従来どおり保存）。doc ノード増は既存ロジックで吸収 |
| `src/cli.ts` | `graph` サブコマンド追加、`impact` 出力に到達内訳表示 |

### 7.1 lock と contains（レビュー指摘への対応）

- `buildLockFromGraph`（`src/lock.ts:24-59`）は req/doc ノードをハッシュ保存する。
  **`contains` エッジは lock に永続化しない**（毎回グラフから再生成できる構造情報の
  ため）。lock は drift 検知用のハッシュ台帳という役割を維持し、所属関係は graph で
  都度導出する。これにより「doc が req を含む／req が doc に属する」の二重管理を避ける。

## 8. 互換性

未リリースのため後方互換は考慮しない。

- 自動 doc ノードで lock に doc エントリが増えるが周知不要。必要なら `reconcile` を実行。
- relation 不正値はフォールバックせず警告。fixture を修正（§6.2）。
- `EdgeKind` への `contains` 追加は既存の switch/フィルタに影響しないか確認する
  （`traverse.ts:32-44` の node-kind switch は影響なし。エッジ kind を網羅的に
  分岐している箇所が無いか実装時に grep）。

## 9. テスト方針

- fixtures に Kiro 形式（`requirements.md`/`design.md`/`tasks.md`、frontmatter で
  doc 連鎖を記述）を追加。design.md は**要求 ID を含まない散文**にし、C-1 で doc
  ノードが生成されることを検証。
- 単体（markdown パーサ）:
  - 散文のみの md から doc ノードが 1 個生成される。
  - req を含む md で `doc --contains--> req` が張られる。
  - frontmatter の不正 relation で警告が出る。
- 統合（builder + traverse）:
  - `tasks.md` 起点の `impact` が `design.md` → `requirements.md` → 中の req →
    実装ファイルまで到達する（contains 経由の一気通貫）。
  - 衝突 req を含む doc の contains が正しく remap される。
  - orphan-doc / 予約プレフィクス検証の警告。
  - エッジデデュープ（frontmatter 二重記載が 1 本になる）。
- CLI: `graph --format json` の出力スナップショット、`graph --format text` の整形。
- 回帰: 既存 `auth.md`/`speckit-style.md`/`kiro-style.md` で「req ノード不変・doc
  ノード追加・contains 追加」（auth.md の relation 修正を除く）。

## 10. 実装順

1. C-1（自動 doc ノード）+ parser options 整備。
2. contains エッジ + builder remap/dedup/検証。
3. B（frontmatter doc↔doc）+ orphan-doc。
4. `graph` 出力コマンド + `impact` 内訳表示。

最小で価値が出るのは 1+2（doc 化と一気通貫）。3 で doc 連鎖、4 で可視化。

## 11. 後続 Issue（v1 から外したもの）

| 項目 | 内容 | 備考 |
| --- | --- | --- |
| C-2 | インラインリンク `[x](./y.md)` の doc→doc 自動抽出 | アンカー/参照型リンク/パス正規化/可逆 ID 解決を要設計 |
| C-3 | Kiro/Spec Kit 規約の自動推論 + 設定可能 `ConventionPreset` | まず固定プリセット、設定可は需要次第 |
| A | 要求 ⇔ 要求（`req → req`）依存 | 実出力は散文中心で価値限定。インライン注釈の regex 誤検出/ハッシュ安定性を要設計 |
| via | エッジ取得元メタ + `--explain-edges` | C-2/C-3 導入時に provenance が要るなら |
| viz | DOT / Mermaid 可視化 | `graph --format json` を入力に後付け可能 |

## 12. 決定ログ

| # | 論点 | 決定 |
| --- | --- | --- |
| 1 | doc↔doc の向き競合・デデュープ | v1 は frontmatter 1 経路に限定し競合を回避。デデュープキーは `(source,target,kind)` |
| 2 | `doc contains req` | **v1 に昇格**（旧 Issue #10）。一気通貫トレースの骨格 |
| 3 | 規約推論の設定可能化 | **v1 から除外**。後続 Issue。まず固定、需要次第で設定可 |
| 4 | 自動 doc ノードの lock 差分 | 未リリースのため周知不要。fixture の不正 relation は修正 |
| 5 | グラフ可視化 | text/JSON 出力を v1 に追加。リッチ可視化は後続 |
| 6 | 前提（実 SDD 出力の要求 ID） | 散文中心と認識。doc グラフを基本単位とし req 抽出はベストエフォート |
