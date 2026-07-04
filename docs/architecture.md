# artgraph — アーキテクチャ設計

> 本書は artgraph の設計判断（D1〜D7）・差別化軸・アーキテクチャ（L1〜L3）・スキーマ・統合方式・既知のリスクを 1 箇所にまとめた一次資料。実装の意思決定や Constitution Check（`.specify/memory/constitution.md`）の根拠としてここを参照する。
>
> 履歴メモ: コードネームは当初 `spectrace`（spec + trace）。名称衝突（spectrace.io / spectraceai.com）を避けるため Issue [#15](https://github.com/ShintaroMorimoto/artgraph/issues/15) で `artgraph`（artifact graph）に確定。

---

## 1. 何を作るか（目的）

TS/JS プロジェクトで、コード・.md 仕様・設計ドキュメントを1つのインパクトグラフに統合し、双方向に辿れるツール。

解決する課題:

- ファイル追加/修正時に、ドキュメントまで含めた影響範囲を把握し、修正漏れ（特にドキュメント）とデグレを防ぐ
- 大量に生成される SDD ドキュメント間の整合性の維持・管理
- AI エージェントの Plan を精緻化する（着手前に「何に波及するか」を渡す）

Non-goals: 仕様文の意味的な正しさの判定、要求の良し悪し評価、ドキュメントの自動生成・自動書き換え。これらは人/AI の判断に委ねる（→ D5）。

## 2. ポジショニング（差別化）

| ツール                          | 対象グラフ                                  | リンク機構                | 性質                            | 言語              |
| ------------------------------- | ------------------------------------------- | ------------------------- | ------------------------------- | ----------------- |
| artgraph（本件）               | 要求↔ドキュメント↔コード↔テスト（統合） | 宣言リンク ＋ AST 派生    | 決定的・TS シンボル精度         | JS ネイティブ     |
| **StrictDoc**                   | 要求↔コード（関数/クラス）↔テスト          | `@relation` マーカー（手動） | 決定的・AST 由来                | Python/C/C++/Rust |
| CoDD (Coherence-Driven Development) | ドキュメント↔ドキュメント               | frontmatter 宣言          | 確率的・LLM 伝播                | Python            |
| OpenFastTrace                   | 仕様↔コード                                 | ID タグ                   | 決定的                          | Java(JVM)         |
| reqmd                           | 仕様↔コード                                 | ID タグ                   | 決定的                          | Go                |
| eslint-plugin-traceability      | コード→仕様（片方向）                       | `@supports` 注釈          | 決定的・コード側のみ            | JS                |
| Cucumber                        | 振る舞い↔ステップ実装                       | 実行束縛                  | 決定的・振る舞い限定            | JS                |
| VSDD                            | REQ→PROP→TEST→IMPL（チェーン）            | Chainlink ビード追跡      | **方法論ドキュメント（gist）**  | 言語非依存        |
| Spec Kit                        | 仕様→コード生成                             | 仕様ファイル駆動          | 生成パイプライン                | 言語非依存        |
| **OpenSpec**                    | 仕様→コード生成（changes/ デルタ）          | 見出し駆動 + propose/archive | 生成パイプライン             | 言語非依存        |
| cc-sdd                          | 仕様→コード生成（Claude Code Skills）       | Skills 駆動               | 生成パイプライン                | JS                |
| Kiro (AWS)                      | 要求→設計→タスク→コード                   | IDE 統合 SDD フロー       | 生成パイプライン                | 言語非依存        |
| ContextGit                      | コード変更→影響ドキュメント検出             | diff ベース推定           | MCP Server                      | Python            |
| **`traceability-tool` (hatvan)** | Markdown 要求 ID ↔ コード注釈              | ID タグ                   | 決定的（**2024-12 アーカイブ済**） | TS                |
| **SpecSync (Kiro 用試作)**      | 仕様↔コード（Kiro 向け）                   | LLM ベース推定            | LLM 依存                        | 言語非依存        |
| **SmartBear Swagger Drift Detection** | API コントラクト↔実装                  | OpenAPI スキーマ比較      | 決定的・API スコープ限定        | 言語非依存        |
| **DeepDocs / Mintlify**         | コード↔ドキュメント                         | LLM 推定                  | 確率的・LLM ベース              | 言語非依存        |

勝ち筋: 以下の交差点を満たすツールは複数角度の敵対的調査でも発見されなかった —

- **JS/TS ネイティブ** ×
- **決定的（非 LLM）** ×
- **コードシンボル精度（AST 由来の自動エッジ）** ×
- **要求↔doc↔コード↔テストの全4層統合グラフ**

最も近いのは StrictDoc（決定的・AST・統合）だが、**JS/TS 非対応**、かつリンクは手動 `@relation` マーカー必須で **AST 由来の自動エッジが無い**。CoDD は doc 階層で止まり伝播が LLM。eslint-plugin-traceability は片方向。AI コーディングアシスタント（Cursor / Augment / Copilot）は全て「コードの RAG」か「要求/仕様を知らないコードグラフ」のどちらかであり、4層を統合する決定的グラフを持つものは皆無。

市場の空白: 2025年後半から SDD ツールが急増（**Spec Kit 114k+ stars**、Kiro、BMAD-METHOD 49k+ stars、**OpenSpec 55k+ stars**）。全て「仕様→コード生成」の前半パイプラインに集中している。「変更時の継続的整合性検証」をやるツール自体は複数存在する（DeepDocs / Mintlify は LLM ベース doc 同期、SmartBear Swagger Drift Detection は API スコープ限定、SpecSync は Kiro 試作）が、いずれも上記4交差点の一部しか埋めない。**「軽量・自動・AI ネイティブで、要求↔doc↔コード↔テストの全4層を決定的グラフとして継続検証し、手動リンク管理を不要とする」位置は空白**。artgraph は既存 SDD ツールの後半（継続検証）を担う補完レイヤーとして位置づける。

市場検証データ:

- Google DORA 2025: AI 高採用チームほど change failure rate が上昇 — 仕様との整合性管理の需要は構造的に高まっている
- LUUP 実測: SDD 導入で Vibe Coding 比、開発時間 43% 短縮・バグ 83% 削減
- Zenn 15+ 記事がコード↔ドキュメント乖離を最大級のペインとして報告（2025–2026）

反証として注意すべきデータ（→ §10 リスクで詳述）:

- **Brenn Hill の実証研究**（SSRN、100,247 PR 分析）: 仕様の存在は欠陥率を**上げる**傾向（+1.4pp）。「仕様→品質向上」の因果は実証的に支持されていない
- **ContextGit の牽引力のなさ**（10 stars）: 最も近いコンセプトのツールが普及していない＝「技術的に実現可能でも普及が難しい」リスク

## 3. コアモデル（型付きアーティファクトグラフ）

すべてを1つの型付きグラフで表す。

ノード型: `req`（要求・ID 持ち、.md 内）/ `doc`（設計書・詳細設計書、ID 持ち）/ `symbol`|`file`（コード）/ `test`（テスト）

エッジ型:

- `depends_on` / `derives_from`（doc→doc, doc→req）: frontmatter で宣言。決定的 DAG
- `implements`（code→req/doc）: `@impl` タグ
- `verifies`（test→req）: テストタグ
- `imports`（code→code）: TS AST から派生。デグレ波及面

統合 impact クエリ: `git diff` の変更を起点に全エッジ型を双方向トラバース。例 `impact FR-001` は「依存する設計書 →（推移的に）詳細設計書 →（implements）実装シンボル →（verifies）テスト → さらにそのシンボルのコード依存元」まで一本で返す（＝要求から V 字の末端まで）。出力 = `{ 影響を受ける依存元コード, 紐づくドキュメント/仕様, drift したリンク, 未リンクの新シンボル }`。

## 4. 確定した設計判断

### D1. リンク機構 — 仕様が ID を所有

- SDD で .md 仕様を書く時に ID を仕様側で発行。対応コードはエージェントが `@impl FR-001` 等で claim。
- 機械的チェックが2つ立つ:
  - 網羅性（仕様→コード）: 各仕様 ID に `@impl` が1つ以上あるか → 未実装検出
  - 妥当性（コード→仕様）: `@impl` が実在の仕様 ID を指すか → orphan/stale 検出
- 「未カバー」は通常エラーではなく TODO。→ 未カバーは Plan の入力（やることリスト）。ゲートが弾くのは "この変更の一貫性"（drift / orphan / 「Plan で FR-001 実装と言ったのに未カバーで終了」）であり、グローバル網羅は必ずしもゲートにしない。
- 確信度の二段化: `@impl` タグ（＝意図と位置）に加え、仕様 ID に紐づく "通るテスト"（＝振る舞い）をセットにする。カバレッジ状態 = `untagged` / `impl-only` / `verified(impl＋緑テスト)`。

### D2. ID スキーム — SDD ツール ID 直接使用

- SDD ツール（Spec Kit, Kiro, BMAD 等）が付与する ID（FR-001, Requirement 1 等）をそのまま artgraph の仕様 ID として使用する。artgraph 独自の ID レイヤーは設けない。
- 名前空間: 同一 ID が複数の spec ファイルに存在する場合、spec ディレクトリ名で修飾する（例: `001-auth/FR-001`）。プロジェクト内で一意なら修飾不要。`@impl FR-001` が曖昧な場合は artgraph が警告し修飾を要求する。
- rename/renumber/split/merge は `artgraph rename` で @impl タグと lock を一括書換。req・doc 両方の ID に適用。
- 効果: 開発者は SDD ツールで見慣れた ID をそのまま `@impl` に書ける。学習コスト・導入摩擦を最小化。
- トレードオフ: 仕様のリナンバリングで `@impl` タグの書換が発生する（rename コマンドで軽減）。不変 ID 方式と比べ rename 耐性は低いが、既存 SDD ツールとの低摩擦な統合を優先する。

### D3. 粒度 — 使う側に委ねる

- 粒度は意味的性質でツールは判定不能（D5）。かつインパクト精度が良い粒度を自己インセンティブ化する（粗いとノイズ、細かいとタグ過多）ので縛らない。
- ツールが機械的にやるのは: ID パターン認識（PREFIX-NNN リスト項目、Requirement N 見出し等、設定で拡張可能） ＋ 任意の構造束縛 ＋ 任意の助言ヒューリスティック（既定オフ）。

### D4. drift 検出 — content-hash ＋ lock

- 紐づくアーティファクト（仕様ブロック / ドキュメント）を content-hash。上流が変われば「上流が変わったが下流が未追従」と検出。
- 承認 = lock ファイルにハッシュを再ピン。手動リビジョン採番は不要。

### D5. 決定性の境界

- 保証するのは 構造的整合（リンクが解決する / 未承認 drift が無い / claim 済み未カバーが無い / 依存元を特定）まで。
- 意味的正しさ（そのコードが本当に要求を満たすか、その doc が実際に整合しているか）は人/AI に残す。

### D6. グラフ粒度 — 2モード（コード側）

- file-level（速い） と symbol-level（精密） を共通スキーマで持つ（file = symbol をファイルに畳んだもの）。
- symbol モードで解決不能なエッジ（動的 import / `import *` / リフレクション）は file-level にフォールバックし、モードを表示。
- Hook のレイテンシ予算に対応: PreToolUse → file、Stop/Plan → symbol。

### D7. ドキュメント間整合（doc↔doc）— 決定的グラフ層のみ取り込む

- CoDD（Coherence-Driven Development）の機能は2層に分かれる: グラフ層（frontmatter `depends_on` の DAG、決定的）と 伝播層（確信度バンド＋LLM 自動更新、意味的）。
- artgraph はグラフ層だけ取り込む。`doc` を `req`/`code`/`test` と並ぶ一級ノードにし、`depends_on` を宣言エッジとして追加。drift は同じ content-hash（D4）——上流 doc が変われば下流を stale。
- 伝播層は入れない（D5 の境界）。「doc B は doc A 依存、A が変わった→B 要レビュー」までを構造的に出すだけ。実際の不整合判定や B の自動書換は Stop フックで提示しエージェントに直させる（＝CoDD 的“整合維持”の挙動を、本体 LLM フリーで得る）。
- Green/Amber/Gray が欲しければ確信度でなく depth/エッジ型で決定的に振る（直接依存＝要レビュー、推移的＝参考）。
- 効果: 要求→設計→詳細→コード→テストが1グラフになり、CoDD（doc で止まる）にも従来のトレーサビリティツール（仕様から始まり doc を扱わない）にも無い統合 impact が出せる。仕組みは D1（宣言リンク）＋ D4（hash drift）の一般化で新規機械ゼロ。

## 5. アーキテクチャ（L1–L3）

- L1 グラフ構築: コード↔コードは TS AST（ts-morph / TS language service、将来 tsgo）。コード↔仕様/ドキュメントは ID タグ ＋ frontmatter `depends_on`。.md は remark でパース。symbol-level は barrel/re-export の貫通が要る（最難所）。
- L2 インパクトクエリ: diff からの双方向トラバース（全エッジ型）。出力 = 依存元コード / 紐づくドキュメント・仕様 / drift / 未リンク新シンボル。
- L3 表出: Plan 時 = MCP ツール。検証時 = Claude Code Hook。

## 6. 具体スキーマ（実装の出発点）

タグ文法（code↔spec, test）

仕様(.md) — SDD ツールの記法をそのまま使用（D2）。artgraph は以下のパターンを認識する:

- リスト項目（Spec Kit / BMAD 形式）: `- FR-001: ユーザーはメールでログインできる`
- 見出し（Kiro 形式）: `### Requirement 1: ユーザーはメールでログインできる`
- ID パターンは設定で拡張可能。デフォルトはリスト項目の `PREFIX-NNN`（例: FR-001, SC-001, NFR-1, REQ-001）と見出しの `Requirement N`。

req→req 依存（インライン注釈、issue #13）— 構造化 req 運用のプロジェクト向け:

- list-item 行末尾、または heading 直下にある最初の段落ブロックの先頭行／末尾行（単一行段落の場合はその 1 行）に独立した注釈括弧を書く。
- 文法: `(depends_on: ID1, ID2, …)` / `(derives_from: ID1, …)`。キーワードは小文字＋アンダースコアの厳密一致。`(depends on …)` のようなアンダースコア無し散文は誤検出しない。
- 複数 ID をカンマ区切りで列挙、`**ID**` の BOLD と空白バリエーション (`( depends_on : A , B )`) を許容。
- 注釈は req の `contentHash` 計算前に除去される（`stripAnnotations`）ため、注釈の追加・変更で drift は発生しない（NON-NEGOTIABLE 原則 I）。
- 注釈由来エッジは `GraphEdge.provenances` に `"annotation"` を含む。issue #35 で全 8 値の語彙（`annotation` / `frontmatter` / `convention` / `code-tag` / `task-tag` / `inline-link` / `ts-import` / `structural`）に統一済（[specs/011-edge-provenance/](../specs/011-edge-provenance/)）。同一 `(source, target, kind)` を複数経路から生成した際は dedup union（昇順 sort）で 1 本に集約され、lock の `dependsOn` も `{id, provenances}` 形式に構造化される。
- 同名 ID が複数 specDir に存在する場合、注釈を含む req と同じ specDir のターゲットを優先（`010-a/REQ-001`）。曖昧な場合は `ambiguous-id` 警告。
- `artgraph rename OLD NEW` は注釈括弧内の `OLD` 参照も同時に書き換える（fenced code block は対象外）。

コード: 実装シンボルの近くに `// @impl FR-001`

テスト: テスト名に `[FR-001]`、または meta（`test(name, { annotations: { req: "FR-001" } })`）

名前空間（D2）: 同一 ID が複数 spec に存在する場合は修飾形式で参照。`// @impl 001-auth/FR-001`

ドキュメント frontmatter（doc↔doc, D7）

```yaml
---
artgraph:
  node_id: "doc:api-design"
  depends_on:
    - { id: "doc:system-design", relation: derives_from }
    - { id: "FR-001", relation: implements }
---
```

lock ファイル（`.trace.lock`, JSON）— 承認済み状態

```json
{
  "FR-001": {
    "specFile": "specs/001-auth/spec.md",
    "contentHash": "sha256:…",
    "impl": ["src/auth/login.ts#login", "src/auth/session.ts#createSession"],
    "tests": ["tests/login.test.ts#[FR-001] logs in with valid email"],
    "lastReconciled": "2026-06-20T00:00:00Z"
  },
  "doc:api-design": {
    "docHash": "sha256:…",
    "dependsOn": ["doc:system-design", "FR-001"],
    "lastReconciled": "2026-06-20T00:00:00Z"
  }
}
```

drift = 現在の hash ≠ lock の hash。

## 7. CLI / MCP サーフェス

| コマンド                                                            | 役割                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `artgraph init`                                                    | 設定・lock の雛形生成                                                                                 |
| `artgraph scan`                                                    | 統合グラフ構築/更新（AST ＋ タグ ＋ frontmatter）、キャッシュ更新                                     |
| `artgraph impact <files\|--diff> [--mode file\|symbol] [--type …]` | Plan 用: 変更から `{依存元 / 紐づく doc・仕様 / drift / 未カバー}` を出力                             |
| `artgraph check [--gate] [--diff]`                                 | 検証: drift（コード・doc 両方）/ orphan / 未カバー-vs-Plan / 未テスト。`--gate` 時は問題で exit 2     |
| `artgraph rename --from … --to … / --split / --merge`              | ID ライフサイクル（req・doc のタグ一括書換 ＋ lock 更新）                                             |
| `artgraph mcp-server`                                              | `impact` を MCP ツールとして公開（Plan 時にエージェントが呼ぶ）                                       |

共通フラグ: `--mode`, `--diff`, `--gate`, `--type req|doc|code|test`, `--format json|text`。
`impact`/`check` は全エッジ型（doc↔doc 含む）を辿る。

**Update (spec 013, 2026-06)**: 当初の `artgraph mcp-server` 構想は spec 013 で再評価した結果スコープ外とし、5 エージェント (Claude Code / Codex CLI / Cursor / GitHub Copilot / Kiro) を **Tier 1** として位置づけ、Skills + AGENTS.md + 薄ラッパー方式でカバーする構成に転換した。`artgraph init --agents=<csv>` で各エージェントの canonical Skills パス (`.claude/skills/` / `.agents/skills/` / `.cursor/skills/` / `.github/skills/` / `.kiro/skills/`) に同一の SKILL.md を配布し、AGENTS.md を canonical agent-context として `CLAUDE.md` / `.github/copilot-instructions.md` から `@AGENTS.md` 取り込みのみで参照する。診断は新サブコマンド `artgraph doctor` が drift / 欠落 / extraneous-file を検出する。MCP サーバの差別化価値は将来 Tier 2 拡張時 (Cline / Goose / Continue 等) に再検討する。詳細は [`specs/013-cross-agent-extensions/research.md`](../specs/013-cross-agent-extensions/research.md) R4 を参照。**§8 は spec 013 以前に書かれた `mcp-server` ベースの Hook 統合構想であり、現行スコープ (Tier 1: Skills + AGENTS.md) には含まれない。** 実装判断の根拠として §8 に沿った PR を出さないこと。

## 8. Claude Code 統合（spec 013 以前の構想 — 現行スコープ外、Tier 2 参考）

- ~~Plan 精緻化 → `mcp-server` を登録し、エージェントがプラン時に `impact` を呼ぶ。任意で SessionStart で現状を context 注入。~~ (spec 013 で見送り。Tier 1 では `artgraph-impact` Skill がこの役割を代替する。Tier 2 拡張時に再評価)
- PreToolUse（`Edit|Write`）→ 助言。`tool_input.file_path` からインパクトを `additionalContext` で注入（exit 0 + JSON）。低遅延必須 → http ハンドラで常駐デーモンに POST。ブロック（exit 2）は orphan 化等の狭い場合のみ。
- PostToolUse（`Edit|Write`）→ グラフ増分更新 ＋ 軽いナッジ（フィードバック可、取り消し不可）。
- Stop（＝検証ゲート） → diff 全体を `check --gate`。drift（コード・ドキュメント両方）/ orphan / 未カバー / 未テストがあれば exit 2 で作業継続させる（stderr 再注入）。`stop_hook_active` を見て無限ループ回避。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "http", "url": "http://localhost:7777/impact" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "artgraph scan --quiet" }]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "artgraph check --gate --diff" }
        ]
      }
    ]
  }
}
```

## 9. 実装方針

- 言語: まず Node/TS（ts-morph ＋ TS language service ＋ remark ＋ glob）を常駐デーモンで。symbol 精度がタダ、出荷が速い、PreToolUse 遅延はデーモンで償却。
  - Rust/Go は profiling で file-level が律速と判明してからの最適化。その時の現実形は「fast core（Rust=oxc / Go）＋ tsgo（typescript-go）で意味解析」。TS セマンティクスを Rust で再実装しない（oxlint/rslint も tsgo に委譲している）。モード別に言語を分けてよい（file=Rust, symbol=TS コンパイラ）。
- テスト結果の取り込み: Vitest JSON レポーター / JUnit XML を読み、REQ-ID で join → `verified` 判定。
- npm 配布: Rust/Go コアでもプリビルドバイナリを npm 配布して `npx` 可能に（UX は JS ネイティブを維持）。

MVP: データモデルは最初から型付きアーティファクトグラフ（doc を表現可能）。実装範囲は code↔spec まで——symbol-level 主＋file-level フォールバック（共通スキーマ）/ `@impl` 仕様 ID ＋ `[REQ]` テストタグ / `scan`・`impact`・`check --gate` / PreToolUse 助言 ＋ Stop ゲート / content-hash drift ＋ lock。

フェーズ

- P1: 汎用アーティファクトグラフのデータモデル ＋（code↔spec の）impact＋check＋lock＋2 Hook（Node デーモン）。※モデルは req/doc/code/test を表現可能にし、doc エッジの実装だけ後回し
- P2: doc↔doc（depends_on）＋ doc-drift ＋ 統合 impact、MCP サーバ／Plan 連携、rename/split/merge、depth/型ベースの影響 UX
- P3: Rust(oxc) file-mode ＋ tsgo、barrel 強化、VS Code 可視化

## 10. 未解決・リスク

- リンクの自己申告問題: エージェントが `@impl` を自己 claim する。緩和 = 仕様所有 ID（捏造不可）＋ drift ハッシュ＋ impl＋通るテスト＋意味は人（D5）。ここが設計の根。
- doc エッジも自己申告: `depends_on` は著者/エージェント宣言。貼り忘れ＝見えない影響。緩和は `@impl` と同じ（解決と drift を検証）。「prose で REQ/doc に言及あるが `depends_on` 無し→提案」lint は任意・既定オフ。
- barrel/re-export の symbol 解決（symbol-level の古典的難所）。
- drift 粒度: doc/仕様を丸ごとハッシュは小編集で全下流点灯（ノイズ）、節単位は安定アンカーが要る。まず丸ごと、後で節単位（コードの file/symbol と同じ綱引きが一段上で再現）。
- PreToolUse のレイテンシ予算（デーモン必須）。
- 未カバー = TODO か漏れか: 未カバーは Plan 信号に留め、ゲートは変更一貫性のみ。
- 既存プロジェクトへの導入（ブラウンフィールド）: `@impl` タグが無い既存プロジェクトにどう導入するか。調査で判明した重要知見: 仕様を書く文化自体が未定着のプロジェクトが多数派。→ タグゼロでも import グラフだけで file-level impact は出せる設計にし、`@impl` タグは段階的に付与していける必要がある。新しく書く Spec から徐々に入れる段階的導入 ＋ それ用の Skill 提供が鍵。
- 仕様粒度パラドックス: 「良い仕様とは何か」の業界合意が無い。過仕様は保守不能、過少仕様はトレース不能。Martin Fowler は MDD と同列の普及障壁として警告。artgraph は D3（粒度を使う側に委ねる）で対処しているが、導入ガイダンスは必要。
- Source of Truth 問題: 仕様とコードが矛盾した時にどちらが正かの合意が無いまま運用されるケースが多い。artgraph は D5（意味的正しさは人/AI に残す）で線引きしているが、「実装済みならコードが真実、未実装ならユーザーに確認」等の推奨ルールを提示すべきか。
- この表記方法の強制方法: Skill / Claude Code Rules などの提供？
- 既存ツールとの組み合わせ: Cucumber、Spec Kit / OpenSpec / Kiro 等の SDD ツールで仕様を書き → artgraph で継続検証、というパイプラインの後半を担う形。frontmatter の `depends_on` 形式は CoDD / DocDD と互換にしておくと既存プロジェクトからの移行が容易。
- CLAUDE.md 肥大化との関係: 仕様やルールを CLAUDE.md に集約するとトークン圧迫で AI 精度が下がるという報告が複数。artgraph の impact 出力が AI へのコンテキスト最適化フィルタとして機能すれば（必要な部分だけ渡す）、この問題の緩和にもなる。
- **「仕様→品質」の因果が実証的に未支持**: Brenn Hill の SSRN 論文（100,247 PR 分析）では仕様の存在が欠陥率を **+1.4pp 押し上げる** 結果。artgraph の前提（仕様トレースで品質が上がる）は実証では支持されていない。価値訴求は「品質向上」ではなく「変更時の影響把握＋ドキュメント整合の維持コスト削減」に絞るべき。
- **市場牽引のリスク**: 最も近いコンセプトの ContextGit（Python + MCP Server で diff→影響 doc 検出）は 10 stars に留まる。「技術的に実現可能でも普及が難しい」典型例。技術勝負だけでなく、Skills / Hook 統合の摩擦をどこまで下げられるかが普及の鍵になる。
- **Kiro 等 SDD ツール側の継続整合性**: 設計時点では「Kiro が公式に未解決と認めている」と捉えていたが、公式文書での明言は確認できず。実態は **Kiro 公式リポジトリ Issue #9435（コミュニティ起票）** ＋ **「手動/オンリクエスト同期」設計** が傍証として残るのみ。空白主張の根拠としては弱いので、市場検証は別の角度（DORA / Zenn / LUUP データ）で補強する。

## 11. 先行事例（学ぶ点）

- CoDD（Coherence-Driven Development）: frontmatter スキーマ（node_id/depends_on/relation）は D7 のグラフ層としてそのまま採用。Green/Amber/Gray は depth/型ベースに読み替え。`extract`（ブラウンフィールド）、Skills/Hook/MCP の作法も参考。※ CoDD の LLM 伝播層は取り込まない＝棲み分け（artgraph は統合＋決定性、CoDD は doc 限定＋自動修正が厚い）。
- **StrictDoc**（最重要・最近の競合）: Tree-sitter による AST 解析で要求↔コード（関数・クラス）↔テストを決定的にトレース。非 LLM。Apache 2.0、Python 製、v0.24.0 / 2026-06-15 リリース。**artgraph との残る差別化は「JS/TS ネイティブ」と「AST 由来の自動エッジ（手動 `@relation` マーカー不要）」の2点に絞られる。** ここを明確に上回らないと優位性が崩れる。
- OpenFastTrace: ID モデル、Needs/Covers、"Outdated" 安全網。
- reqmd: カバレッジを .md に書き戻す UX。
- eslint-plugin-traceability: grep 可能な検証チェックポイント、`traceability-maint` リネーム CLI。
- oxc / typescript-go(tsgo) / oxlint / rslint: 「fast core ＋ tsgo」の実装パターン。
- VSDD（SDD+TDD+VDD 融合）: Chainlink ビード追跡（REQ-001→PROP-001→TEST-001→IMPL-001）で仕様→コードの双方向チェーンを管理するコンセプト。**実態は方法論ドキュメント（gist）であり Claude Code プラグインや動作する CLI 実装は確認できず**、`.vsdd/state.json` 等の具体仕様も裏付けが取れない。ビード ID の連番方式や 4段チェーンのアイデアは参考になるが、実装事例としては扱わない。
- Spec Kit: SDD ツールの代表格。**Spec Kit 114k+ stars（2026-06 時点）**、急増中。仕様ファイルから AI がコード生成する「前半パイプライン」。artgraph は後半（継続的整合性検証）を担う補完レイヤーとして共存する設計。
- **OpenSpec**（`Fission-AI/OpenSpec`、**55k+ stars**、BMAD-METHOD より多い）: Markdown ベースの SDD で、`openspec/specs/` を正本、`openspec/changes/<name>/` を提案中デルタとして管理し、propose → implement → archive（specs/ へマージ）のライフサイクルを持つ。要件は `### Requirement: <name>` 見出し駆動で **ID 文字列を持たない**（artgraph の ID 主キー前提と相性が悪い）。artgraph 側は `ID = <domain>/slug(requirement-name)` の slug 派生で対応可（Issue #25 で設計検討中）。
- cc-sdd: Claude Code Skills 駆動の SDD ツール。artgraph の Skills 統合方針と直接競合せず、補完関係。
- dev-flow-gate: **実態は `sd0xdev/sd0x-dev-flow` で Stop Hook ベースの 4 フェーズ品質ゲート（Plan→Build→Gate→Ship）**。プロセス的アプローチ（構造的グラフなし）。artgraph の check --gate と組み合わせ可能。
- DocDD（AI 駆動ドキュメント駆動開発）: frontmatter で `depends_on` を宣言し AI が下流を伝播更新。artgraph の D7 と同じ宣言形式だが伝播が LLM 依存。frontmatter 互換を維持しておけば DocDD 採用プロジェクトからの移行が容易。
- ContextGit: Python + MCP Server で diff→影響ドキュメント検出。技術的に最も近いが牽引力を得られていない（10 stars）。TS 特化・AST 解析なし。「技術的に実現可能でも普及が難しい」リスクを示唆。
- `konstantin-hatvan/traceability-tool`（**2024-12 アーカイブ済**、修士論文成果物、8 stars）: TS 製 CLI でマークダウン要求 ID とコード注釈を紐づける。**概念的に artgraph に最も近い JS/TS 向けツール**だが、AST なし・lock なし・アーカイブ。「同じ問題を認識して着手したが完成しなかった」市場の難しさの傍証。
- 2層仕様構造パターン（kozoka_ai 記事）: 作業 spec（機能単位）と権威仕様書（ドメイン単位）を分離し、カテゴリ命名規則で自動ルーティング。artgraph が仕様の粒度問題（D3）に対して提示できる運用パターンの参考。

## 参考リンク

- StrictDoc: https://github.com/strictdoc-project/strictdoc
- OpenSpec: https://github.com/Fission-AI/OpenSpec
- CoDD: https://github.com/yohey-w/codd-dev
- traceability-tool: https://github.com/konstantin-hatvan/traceability-tool
- Kiro Issue #9435: https://github.com/kirodotdev/Kiro/issues/9435
- DORA 2025: https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
- Brenn Hill 実証研究: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6515898
- SmartBear Swagger Drift Detection: https://aithority.com/machine-learning/smartbear-delivers-new-swagger-capabilities-to-elevate-api-governance-quality-and-ai-readiness/
