# 設計: ドキュメント間グラフ構造の整理

- ステータス: ドラフト
- 対象ブランチ: `claude/document-graph-structure-hjgvia`
- 作成日: 2026-06-20

## 1. 背景と狙い

spectrace は「仕様 ⇔ 実装」の双方向トレーサビリティを主軸にしてきた。しかし
本来の狙いは、**SDD（Spec-Driven Development）ツールが出力する各種 Markdown
ファイル間の依存関係を管理すること**にある。具体的には次のようなツール出力を
対象とする。

| ツール | 主な出力ファイル | 自然な依存の連鎖 |
| --- | --- | --- |
| GitHub Spec Kit | `spec.md` → `plan.md` → `tasks.md`（+ `research.md`） | `plan` derives from `spec`、`tasks` derives from `plan` |
| AWS Kiro | `requirements.md` → `design.md` → `tasks.md` | `design` derives from `requirements`、`tasks` derives from `design` |

これらのツールでは「個々の要求ID」よりも、**ファイル単位のドキュメントそのもの**が
依存グラフの基本単位になる。`design.md` が `requirements.md` から派生し、`tasks.md`
が `design.md` から派生する、という連鎖を管理できることが本質的なゴールである。

参考:
- GitHub Spec Kit: https://github.com/github/spec-kit/blob/main/spec-driven.md
- Kiro Specs: https://kiro.dev/docs/specs/
- Kiro Steering: https://kiro.dev/docs/steering/

## 2. 現状分析

### 2.1 ノード／エッジモデル

`src/types.ts` で 5 種のノードと 5 種のエッジを定義している。

```
NodeKind = "req" | "doc" | "file" | "symbol" | "test"
EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports"
```

| エッジ | 意味 | 入力経路 |
| --- | --- | --- |
| `implements` | コード → 要求 | `// @impl REQ-ID`（`src/parsers/typescript.ts`） |
| `verifies` | テスト → 要求 | `[REQ-ID]` / `req:` 注釈 |
| `imports` | コード → コード | TS AST 解析 |
| `depends_on` / `derives_from` | doc → 要求 | frontmatter `spectrace.depends_on`（`src/parsers/markdown.ts:54-63`） |

### 2.2 Markdown 取り込みフロー（`src/parsers/markdown.ts`）

1 ファイルからノードが生まれる経路は **3 つだけ**。

1. frontmatter に `spectrace.node_id` がある時のみ `doc` ノードを 1 個生成
   （`:44-52`）。同時に `depends_on` をエッジ化（`:54-63`）。
2. リスト項目が `LIST_ITEM_RE`（`- FEAT-001:` 等）にマッチ → `req` ノード（`:66-82`）。
3. 見出しが `KIRO_HEADING_RE`（`Requirement 1:`）にマッチ → `req` ノード（`:84-100`）。

### 2.3 ここから判明する現状の制約

- **C 相当（ファイル＝ドキュメント）が無い**: `doc` ノードは frontmatter を
  手書きした時しか作られない。Kiro の `design.md`/`tasks.md`、Spec Kit の
  `plan.md`/`research.md` のように要求IDの箇条書きを持たない散文 md は、
  frontmatter を足さない限り **ノードが 1 個も生成されずグラフから消える**。
- **A 相当（req → req）が無い**: `depends_on` のソースは実質 `doc` 限定
  （パーサが `node_id` を持つ doc にしか `depends_on` を読みに行かない）。
  要求どうしの依存を張れない。
- **B 相当（doc → doc）は部分的に動く**: `depends_on.id` に別 doc の `node_id`
  を書けば、builder は非 req エッジとして通し（`src/graph/builder.ts:48-56,116-127`）、
  traverse も双方向に辿る（`src/graph/traverse.ts:13-20`）。ただし両ファイルに
  frontmatter が必要で、C が無いと実用にならない。

### 2.4 周辺コンポーネントの現状対応

- `src/graph/traverse.ts`: `impact()` は既に双方向 BFS。新エッジ種別を足しても
  追加実装なしで伝播する。`affectedDocs` は doc ノードを id で収集（`:38-40`）。
- `src/lock.ts`: `buildLockFromGraph` は `req`/`doc` ノードのみロック化し、
  `depends_on`/`derives_from` を `dependsOn` 配列に保存（`:48-53`）。doc ノードが
  増えればそのままロック対象になる。
- `src/graph/traverse.ts:75-88` `findUncovered`: `req` のみ対象。doc は未カバレッジ
  判定の対象外（このままで良い）。

## 3. ゴールと非ゴール

### ゴール

- **A**: 要求 ⇔ 要求（`req → req`）の依存を表現できる。
- **B**: ドキュメント ⇔ ドキュメント（`doc → doc`）の依存を表現できる。
- **C**: Markdown ファイルそのものを `doc` ノードとして自動登録し、さらに
  doc → doc リンクを以下 3 方式で取得できる。
  - **C-1** frontmatter 明示（`spectrace.depends_on`）
  - **C-2** md 内インラインリンク（`[design](./design.md)`）の自動抽出
  - **C-3** ツール規約（Kiro / Spec Kit のフォルダ構成）の自動推論
- 既存の「仕様 ⇔ 実装」トレースと後方互換であること。

### 非ゴール（今回の設計範囲外）

- グラフの可視化出力（DOT/Mermaid エクスポート）— 別設計とする。
- `symbol` 粒度のトレース。
- ドキュメントの版管理・履歴追跡。

## 4. エッジの向きとセマンティクス

混乱を避けるため、エッジの向きを次の規約に統一する。

- `derives_from`: **下流 → 上流**。「派生したもの」から「派生元」へ向ける。
  - `design.md --derives_from--> requirements.md`
  - `tasks.md --derives_from--> design.md`
- `depends_on`: 一般的な依存（向きの意味が `derives_from` ほど強くない場合）。
  - `A --depends_on--> B`（A は B に依存する）
- 影響解析（`impact`）は双方向 BFS なので、向きは「人間が読むときの意味」と
  「lock の `dependsOn` 配列の起点」を決めるためのもの。`buildLockFromGraph` は
  `source === id` のエッジを `dependsOn` に格納する（`src/lock.ts:48-53`）ため、
  「自分が依存している先」が下流ノードのエントリにまとまる。

> 補足: 既存テスト fixture `tests/fixtures/specs/auth.md` は
> `depends_on: [{ id: "AUTH-001", relation: implements }]` と書いており、
> `relation: implements` は現状 `derives_from` 以外として `depends_on` に倒される
> （`src/parsers/markdown.ts:56`）。本設計では relation の許容値を明確化する
> （6.1 参照）。

## 5. データモデルの変更

### 5.1 ノード ID 規約

ファイル＝ドキュメントの `doc` ノード ID を規約化する。

- frontmatter に `spectrace.node_id` があればそれを優先（後方互換）。
- 無ければ **`doc:<specDir からの相対パス>`** を自動採番。
  - 例: `specs/003-chat/design.md` → `doc:003-chat/design.md`
- 衝突回避は既存の req と同様、builder で重複検出・警告（`duplicate-id`）。

### 5.2 型の追加・変更（`src/types.ts`）

`EdgeKind` は既存の `depends_on` / `derives_from` を流用するため**追加不要**。
A（req → req）も B（doc → doc）も同じ 2 種で表現できる。

エッジの出所をデバッグ・出力で区別できるよう、`GraphEdge` に任意メタを足す。

```ts
export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  // 追加: リンクの取得元（C-1/C-2/C-3 や @impl などの由来）
  via?: "frontmatter" | "inline-link" | "convention" | "impl-tag" | "verify-tag" | "import";
}
```

`via` は任意。既存コードは無視できるため後方互換。

### 5.3 設定の追加（`SpectraceConfig`）

```ts
export interface SpectraceConfig {
  // 既存
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  // 追加
  docGraph?: {
    autoDocNodes?: boolean;        // C-1: md=doc ノード自動生成（既定 true）
    inlineLinks?: boolean;         // C-2: インラインリンク抽出（既定 true）
    conventions?: Array<"kiro" | "spec-kit">; // C-3: 規約推論（既定 []）
  };
}
```

既定値は「自動 doc ノード ON・インラインリンク ON・規約推論 OFF」とし、
規約推論は明示的にオプトインさせる（誤検出リスクを抑えるため）。

## 6. 各機能の設計

### 6.1 A: 要求 ⇔ 要求の依存（`req → req`）

**入力記法（2 通りをサポート）**

1. frontmatter（ファイル全体ではなく、要求にぶら下げにくいので補助的）。
2. 要求の箇条書き行内のインライン注釈を推奨。

```md
- AUTH-002: セッション管理 (depends_on: AUTH-001)
- AUTH-003: ログアウト機能 (derives_from: AUTH-002)
```

**パーサ変更（`src/parsers/markdown.ts`）**

- `visit(tree, "listItem")` / `visit(tree, "heading")` の中で、ラベル文字列から
  `(depends_on: X, Y)` / `(derives_from: Z)` を正規表現抽出し、`source = reqId`,
  `target = X` のエッジを生成。
- 抽出後、ラベル/ハッシュ計算には注釈を含めるか除くかを決める（drift 安定性の
  観点では、注釈変更で req 本体が drift 扱いになるのを避けるため**注釈を除いた
  本文でハッシュ**するのが望ましい）。

**builder 変更（`src/graph/builder.ts`）**

- 現在 `isFromReq` 判定で req 由来エッジを `req.edges` に振り分けている（`:48-56`）。
  req → req エッジはソースが req なのでこの経路に乗る。Pass 2 で source/target を
  最終 ID（衝突時は `specDir/ID`）へ remap する必要がある。現状 target の remap が
  req → req では未対応なので、**target も `idMapping` で解決**するよう拡張する。

**relation 許容値の明確化**

- `depends_on` / `derives_from` のみ正式サポート。
- それ以外（例: 既存 fixture の `implements`）は警告を出しつつ `depends_on` に
  フォールバック（後方互換）。将来的に fixture を `derives_from` へ修正。

### 6.2 B: ドキュメント ⇔ ドキュメントの依存（`doc → doc`）

**入力記法**

1. frontmatter（C-1）:

```yaml
---
spectrace:
  node_id: "doc:003-chat/design"
  depends_on:
    - { id: "doc:003-chat/requirements", relation: derives_from }
---
```

2. インラインリンク（C-2）/ 規約（C-3）から自動生成（6.3 参照）。

**builder 変更**

- doc → doc エッジはソースが req でないため `nonReqEdges` 経路（`:48-56,116-127`）。
  現状でも通るが、**target が存在しない doc を指す場合の警告**（`orphan-doc`）を
  追加する。`findOrphans`（`src/graph/traverse.ts:61-73`）は現在 implements/verifies
  のみ対象なので、doc 依存先の欠落も検出対象に含めるか検討（既定は警告のみ）。

### 6.3 C: 自動 doc ノード生成とリンク取得

#### C-1: ファイル＝doc ノードの自動生成

**パーサ変更（`src/parsers/markdown.ts`）**

- `config.docGraph.autoDocNodes !== false` のとき、frontmatter の有無に関わらず
  各 md に対して `doc` ノードを必ず 1 個生成する。
  - ID は 5.1 の規約。`node_id` があれば優先。
  - `contentHash` はファイル全体ハッシュ（既存 `fileHash` を流用）。
- 既存挙動との関係: これまで req ノードしか出さなかった `speckit-style.md` 等も、
  追加で `doc:...` ノードを持つようになる。req ノードは従来どおり併存。
- 「その md に属する req は、その doc から `contains`/`derives_from` で結ぶか」は
  オプション。まずは**結ばない**（要求は引き続き独立ノード）で開始し、必要なら
  後続で `doc --contains--> req` を追加検討（EdgeKind 追加が必要なので別途）。

> パーサは `config` を受け取っていないため、`parseMarkdown` のシグネチャに
> `options?: { docGraph?: ... }` を追加し、builder から渡す。

#### C-2: インラインリンクの自動抽出

**パーサ変更**

- remark AST を `visit(tree, "link")` で走査し、`url` が**ローカルの相対 .md**を
  指すものを抽出。
- 解決: リンク元 md の doc ノード ID → リンク先パスを正規化し、対応する doc
  ノード ID（5.1 規約 or `node_id`）へ `derives_from`（既定）または `depends_on`
  のエッジを張る。`via: "inline-link"`。
- 向きの既定: 「自分が参照している先 = 依存先」とみなし `A --depends_on--> B`。
  ただし規約由来（C-3）の連鎖は `derives_from` を使う。
- 解決できないリンク（外部 URL、アンカーのみ、対象 md がスキャン対象外）は無視。

#### C-3: ツール規約の自動推論

**新規モジュール（例: `src/graph/conventions.ts`）**

- builder が全 md をパースした後、`config.docGraph.conventions` に応じて
  フォルダ単位でファイル名パターンを照合し、連鎖エッジを生成する。

| 規約 | 検出 | 生成エッジ（derives_from, via: "convention"） |
| --- | --- | --- |
| `kiro` | 同一ディレクトリ内の `requirements.md` / `design.md` / `tasks.md` | `design → requirements`、`tasks → design` |
| `spec-kit` | 同一ディレクトリ内の `spec.md` / `plan.md` / `tasks.md`（+ `research.md`） | `plan → spec`、`tasks → plan`、`research → spec` |

- 規約推論は **C-1（doc ノード自動生成）が前提**。対象ファイルが doc ノードと
  して存在する場合のみエッジを張る。
- 重複（C-1/C-2/C-3 で同じ source→target が複数回出る）は builder でデデュープ。

### 6.4 優先順位の推奨実装順

1. C-1（doc ノード自動生成）+ B（doc → doc, frontmatter）— グラフの骨格。
2. C-2（インラインリンク）— 手書き不要で連鎖が埋まる。
3. C-3（規約推論）— ツール出力をそのまま投入できる。
4. A（req → req）— ドキュメント内・要求粒度の依存。

## 7. 影響範囲まとめ（ファイル別）

| ファイル | 変更内容 |
| --- | --- |
| `src/types.ts` | `GraphEdge.via?` 追加、`SpectraceConfig.docGraph?` 追加 |
| `src/parsers/markdown.ts` | C-1 自動 doc ノード、C-2 インラインリンク抽出、A の req→req 注釈抽出、relation 検証、シグネチャに options 追加 |
| `src/graph/builder.ts` | req→req の target remap、doc→doc の orphan 警告、規約推論呼び出し、エッジ デデュープ |
| `src/graph/conventions.ts`（新規） | C-3 Kiro/Spec Kit 規約推論 |
| `src/graph/traverse.ts` | 変更ほぼ不要（双方向 BFS が新エッジを自動処理）。orphan-doc を含める場合のみ拡張 |
| `src/lock.ts` | 変更不要（doc ノード増・dependsOn は既存ロジックで対応） |
| `src/cli.ts` | `scan` のサマリにエッジ種別別カウントを追加（任意） |

## 8. 後方互換性

- `node_id` 付き frontmatter は従来どおり動作（優先される）。
- 既存の `depends_on: [{ relation: implements }]` は警告付きで `depends_on` に
  フォールバックし、エラーにしない。
- `docGraph` 未設定でも、自動 doc ノード/インラインリンクは既定 ON のため、
  既存プロジェクトでもグラフが豊かになる。**lock の差分が出る**点に注意し、
  リリース時は `reconcile` の実行を案内する。
- 規約推論（C-3）は既定 OFF。誤検出を避けるためオプトイン。

## 9. テスト方針

- fixtures に Kiro 形式（`requirements.md`/`design.md`/`tasks.md`）と Spec Kit
  形式（`spec.md`/`plan.md`/`tasks.md`）のフォルダを追加。
- 単体: markdown パーサが (a) 自動 doc ノード、(b) インラインリンク、(c) req→req
  注釈、を期待どおり出すこと。
- 統合: builder + traverse で
  `tasks.md` を起点に `design.md` → `requirements.md` まで `impact` が伝播すること。
- 後方互換: 既存 `auth.md`/`speckit-style.md`/`kiro-style.md` のスナップショットが
  「req ノードは不変・doc ノードが追加される」形であること。

## 10. 未決事項（要レビュー）

1. インラインリンクの既定の向きは `depends_on` でよいか（`derives_from` の方が
   自然なケースもある）。
2. `doc --contains--> req`（ファイルとその中の要求の所属関係）を導入するか。
   導入すると「ファイル単位の影響」と「要求単位の影響」を綺麗に橋渡しできるが、
   `EdgeKind` 追加が必要。
3. 規約推論の対象ファイル名は固定でよいか、設定で上書き可能にするか。
4. 自動 doc ノード ON による既存 lock の差分をどう周知するか（マイグレーション）。
