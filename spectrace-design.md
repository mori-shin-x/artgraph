# spectrace — 設計ハンドオフ（実装引き継ぎ用）

> 仮称 **spectrace**（spec + trace）。名前は未確定。
> ステータス: 設計合意済み / 実装未着手。本書を Claude Code に渡して具体設計・実装に入る。

---

## 1. 何を作るか（目的）

TS/JS プロジェクトで、**コード・.md 仕様・設計ドキュメントを1つのインパクトグラフに統合**し、双方向に辿れるツール。

解決する課題:

- ファイル追加/修正時に、**ドキュメントまで含めた影響範囲**を把握し、**修正漏れ（特にドキュメント）**と**デグレ**を防ぐ
- 大量に生成される SDD ドキュメント間の**整合性の維持・管理**
- AI エージェントの **Plan を精緻化**する（着手前に「何に波及するか」を渡す）

**Non-goals**: 仕様文の意味的な正しさの判定、要求の良し悪し評価、ドキュメントの自動生成・自動書き換え。これらは人/AI の判断に委ねる（→ D5）。

## 2. ポジショニング（差別化）

| ツール                     | 対象グラフ                                  | リンク機構             | 性質                        | 言語              |
| -------------------------- | ------------------------------------------- | ---------------------- | --------------------------- | ----------------- |
| **spectrace（本件）**      | **要求↔ドキュメント↔コード↔テスト（統合）** | 宣言リンク ＋ AST 派生 | **決定的・TS シンボル精度** | **JS ネイティブ** |
| CoDD                       | ドキュメント↔ドキュメント                   | frontmatter 宣言       | 確率的・LLM 伝播            | Python            |
| OpenFastTrace              | 仕様↔コード                                 | ID タグ                | 決定的                      | Java(JVM)         |
| reqmd                      | 仕様↔コード                                 | ID タグ                | 決定的                      | Go                |
| eslint-plugin-traceability | コード→仕様（片方向）                       | `@supports` 注釈       | 決定的・コード側のみ        | JS                |
| Cucumber                   | 振る舞い↔ステップ実装                       | 実行束縛               | 決定的・振る舞い限定        | JS                |

**勝ち筋**: SDD 成果物チェーン全体（要求→設計→コード→テスト）を**1つの決定的グラフ**に統合し、**コードシンボル精度**で辿れること。CoDD はドキュメント階層で止まり伝播が LLM、他は仕様↔コードのみ。spectrace は **統合 ＋ 決定性 ＋ TS シンボル精度 ＋ JS ネイティブ** で重ならない。CoDD を LLM で上回ろうとしない。

## 3. コアモデル（型付きアーティファクトグラフ）

すべてを**1つの型付きグラフ**で表す。

**ノード型**: `req`（要求・ID 持ち、.md 内）/ `doc`（設計書・詳細設計書、ID 持ち）/ `symbol`|`file`（コード）/ `test`（テスト）

**エッジ型**:

- `depends_on` / `derives_from`（doc→doc, doc→req）: **frontmatter で宣言**。決定的 DAG
- `implements`（code→req/doc）: `@impl` タグ
- `verifies`（test→req）: テストタグ
- `imports`（code→code）: TS AST から派生。**デグレ波及面**

**統合 impact クエリ**: `git diff` の変更を起点に全エッジ型を双方向トラバース。例 `impact REQ-7f3a` は「依存する設計書 →（推移的に）詳細設計書 →（implements）実装シンボル →（verifies）テスト → さらにそのシンボルの**コード依存元**」まで一本で返す（＝要求から V 字の末端まで）。出力 = `{ 影響を受ける依存元コード, 紐づくドキュメント/仕様, drift したリンク, 未リンクの新シンボル }`。

## 4. 確定した設計判断

### D1. リンク機構 — 仕様が ID を所有

- SDD で .md 仕様を書く時に **ID を仕様側で発行**。対応コードはエージェントが `@impl REQ-xxxx` で claim。
- 機械的チェックが2つ立つ:
  - **網羅性（仕様→コード）**: 各 `REQ-X` に `@impl REQ-X` が1つ以上あるか → 未実装検出
  - **妥当性（コード→仕様）**: `@impl REQ-Y` が実在の `REQ-Y` を指すか → orphan/stale 検出
- **「未カバー」は通常エラーではなく TODO**。→ 未カバーは **Plan の入力**（やることリスト）。**ゲートが弾くのは "この変更の一貫性"**（drift / orphan / 「Plan で REQ-X 実装と言ったのに未カバーで終了」）であり、グローバル網羅は必ずしもゲートにしない。
- **確信度の二段化**: `@impl` タグ（＝意図と位置）に加え、**REQ-X に紐づく "通るテスト"**（＝振る舞い）をセットにする。カバレッジ状態 = `untagged` / `impl-only` / `verified(impl＋緑テスト)`。

### D2. ID スキーム — 不変コア ＋ 任意 slug

- `REQ-7f3a`（不変・非可読）＋ 任意の人間用 slug `auth-login`。対応台帳はツールが保持。
- 効果: **言い換えではタグを触らない**。本当に分割/統合した時だけ追従コマンドを使う。
- → **rename/split/merge 追従コマンドが必要**（タグ一括書換 ＋ lock 更新）。req・doc 両方の ID に適用。

### D3. 粒度 — 使う側に委ねる

- 粒度は意味的性質でツールは判定不能（D5）。かつ**インパクト精度が良い粒度を自己インセンティブ化**する（粗いとノイズ、細かいとタグ過多）ので縛らない。
- ツールが機械的にやるのは: **ID フォーマット強制（正規表現）** ＋ **任意の構造束縛**（見出し1つ/受け入れ基準1つに ID 1個）＋ **任意の助言ヒューリスティック**（既定オフ）。

### D4. drift 検出 — content-hash ＋ lock

- 紐づくアーティファクト（仕様ブロック / ドキュメント）を **content-hash**。上流が変われば「上流が変わったが下流が未追従」と検出。
- 承認 = lock ファイルにハッシュを再ピン。**手動リビジョン採番は不要**。

### D5. 決定性の境界

- 保証するのは **構造的整合**（リンクが解決する / 未承認 drift が無い / claim 済み未カバーが無い / 依存元を特定）まで。
- **意味的正しさ（そのコードが本当に要求を満たすか、その doc が実際に整合しているか）は人/AI に残す**。

### D6. グラフ粒度 — 2モード（コード側）

- **file-level（速い）** と **symbol-level（精密）** を**共通スキーマ**で持つ（file = symbol をファイルに畳んだもの）。
- symbol モードで解決不能なエッジ（動的 import / `import *` / リフレクション）は **file-level にフォールバックし、モードを表示**。
- **Hook のレイテンシ予算に対応**: PreToolUse → file、Stop/Plan → symbol。

### D7. ドキュメント間整合（doc↔doc）— 決定的グラフ層のみ取り込む

- CoDD の機能は2層に分かれる: **グラフ層**（frontmatter `depends_on` の DAG、決定的）と **伝播層**（確信度バンド＋LLM 自動更新、意味的）。
- spectrace は**グラフ層だけ取り込む**。`doc` を `req`/`code`/`test` と並ぶ一級ノードにし、`depends_on` を宣言エッジとして追加。**drift は同じ content-hash（D4）**——上流 doc が変われば下流を stale。
- **伝播層は入れない（D5 の境界）**。「doc B は doc A 依存、A が変わった→B 要レビュー」までを構造的に出すだけ。実際の不整合判定や B の自動書換は **Stop フックで提示しエージェントに直させる**（＝CoDD 的“整合維持”の挙動を、本体 LLM フリーで得る）。
- Green/Amber/Gray が欲しければ**確信度でなく depth/エッジ型で決定的に**振る（直接依存＝要レビュー、推移的＝参考）。
- 効果: 要求→設計→詳細→コード→テストが**1グラフ**になり、CoDD（doc で止まる）にも従来 spectrace（仕様から始まる）にも無い統合 impact が出せる。仕組みは **D1（宣言リンク）＋ D4（hash drift）の一般化で新規機械ゼロ**。

## 5. アーキテクチャ（L1–L3）

- **L1 グラフ構築**: コード↔コードは TS AST（ts-morph / TS language service、将来 tsgo）。コード↔仕様/ドキュメントは ID タグ ＋ frontmatter `depends_on`。.md は remark でパース。symbol-level は **barrel/re-export の貫通**が要る（最難所）。
- **L2 インパクトクエリ**: diff からの双方向トラバース（全エッジ型）。出力 = 依存元コード / 紐づくドキュメント・仕様 / drift / 未リンク新シンボル。
- **L3 表出**: Plan 時 = MCP ツール。検証時 = Claude Code Hook。

## 6. 具体スキーマ（実装の出発点）

**タグ文法（code↔spec, test）**

- 仕様(.md): 各要求が ID を持つ。例 `#### REQ-7f3a (auth-login): ユーザーはメールでログインできる`
- コード: 実装シンボルの近くに `// @impl REQ-7f3a`
- テスト: テスト名に `[REQ-7f3a]`、または meta（`test(name, { annotations: { req: "REQ-7f3a" } })`）

**ドキュメント frontmatter（doc↔doc, D7）**

```yaml
---
spectrace:
  node_id: "doc:api-design"
  depends_on:
    - { id: "doc:system-design", relation: derives_from }
    - { id: "REQ-7f3a", relation: implements }
---
```

**lock ファイル（`.trace.lock`, JSON）— 承認済み状態**

```json
{
  "REQ-7f3a": {
    "slug": "auth-login",
    "specHash": "sha256:…",
    "impl": ["src/auth/login.ts#login", "src/auth/session.ts#createSession"],
    "tests": ["tests/login.test.ts#[REQ-7f3a] logs in with valid email"],
    "lastReconciled": "2026-06-20T00:00:00Z"
  },
  "doc:api-design": {
    "docHash": "sha256:…",
    "dependsOn": ["doc:system-design", "REQ-7f3a"],
    "lastReconciled": "2026-06-20T00:00:00Z"
  }
}
```

drift = 現在の hash ≠ lock の hash。slug 台帳もここに同居。

## 7. CLI / MCP サーフェス

| コマンド                                                            | 役割                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `spectrace init`                                                    | 設定・lock の雛形生成                                                                                 |
| `spectrace scan`                                                    | 統合グラフ構築/更新（AST ＋ タグ ＋ frontmatter）、キャッシュ更新                                     |
| `spectrace impact <files\|--diff> [--mode file\|symbol] [--type …]` | **Plan 用**: 変更から `{依存元 / 紐づく doc・仕様 / drift / 未カバー}` を出力                         |
| `spectrace check [--gate] [--diff]`                                 | **検証**: drift（コード・doc 両方）/ orphan / 未カバー-vs-Plan / 未テスト。`--gate` 時は問題で exit 2 |
| `spectrace rename --from … --to … / --split / --merge`              | ID ライフサイクル（req・doc のタグ一括書換 ＋ lock 更新）                                             |
| `spectrace mcp-server`                                              | `impact` を MCP ツールとして公開（Plan 時にエージェントが呼ぶ）                                       |

共通フラグ: `--mode`, `--diff`, `--gate`, `--type req|doc|code|test`, `--format json|text`。
`impact`/`check` は全エッジ型（doc↔doc 含む）を辿る。

## 8. Claude Code 統合

- **Plan 精緻化** → `mcp-server` を登録し、エージェントがプラン時に `impact` を呼ぶ。任意で SessionStart で現状を context 注入。
- **PreToolUse**（`Edit|Write`）→ 助言。`tool_input.file_path` からインパクトを `additionalContext` で注入（exit 0 + JSON）。低遅延必須 → **http ハンドラで常駐デーモンに POST**。ブロック（exit 2）は orphan 化等の狭い場合のみ。
- **PostToolUse**（`Edit|Write`）→ グラフ増分更新 ＋ 軽いナッジ（フィードバック可、取り消し不可）。
- **Stop（＝検証ゲート）** → diff 全体を `check --gate`。drift（コード・**ドキュメント両方**）/ orphan / 未カバー / 未テストがあれば exit 2 で作業継続させる（stderr 再注入）。**`stop_hook_active` を見て無限ループ回避**。

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
        "hooks": [{ "type": "command", "command": "spectrace scan --quiet" }]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "spectrace check --gate --diff" }
        ]
      }
    ]
  }
}
```

## 9. 実装方針

- **言語: まず Node/TS**（ts-morph ＋ TS language service ＋ remark ＋ glob）を**常駐デーモン**で。symbol 精度がタダ、出荷が速い、PreToolUse 遅延はデーモンで償却。
  - Rust/Go は **profiling で file-level が律速と判明してから**の最適化。その時の現実形は「**fast core（Rust=oxc / Go）＋ tsgo（typescript-go）で意味解析**」。**TS セマンティクスを Rust で再実装しない**（oxlint/rslint も tsgo に委譲している）。モード別に言語を分けてよい（file=Rust, symbol=TS コンパイラ）。
- **テスト結果の取り込み**: Vitest JSON レポーター / JUnit XML を読み、REQ-ID で join → `verified` 判定。
- **npm 配布**: Rust/Go コアでもプリビルドバイナリを npm 配布して `npx` 可能に（UX は JS ネイティブを維持）。

**MVP**: データモデルは**最初から型付きアーティファクトグラフ**（doc を表現可能）。実装範囲は code↔spec まで——symbol-level 主＋file-level フォールバック（共通スキーマ）/ `@impl` 仕様 ID ＋ `[REQ]` テストタグ / `scan`・`impact`・`check --gate` / PreToolUse 助言 ＋ Stop ゲート / content-hash drift ＋ lock。

**フェーズ**

- P1: **汎用アーティファクトグラフのデータモデル** ＋（code↔spec の）impact＋check＋lock＋2 Hook（Node デーモン）。※モデルは req/doc/code/test を表現可能にし、doc エッジの実装だけ後回し
- P2: **doc↔doc（depends_on）＋ doc-drift ＋ 統合 impact**、MCP サーバ／Plan 連携、rename/split/merge、depth/型ベースの影響 UX
- P3: Rust(oxc) file-mode ＋ tsgo、barrel 強化、VS Code 可視化

## 10. 未解決・リスク

- **リンクの自己申告問題**: エージェントが `@impl` を自己 claim する。緩和 = 仕様所有 ID（捏造不可）＋ drift ハッシュ＋ impl＋通るテスト＋意味は人（D5）。**ここが設計の根**。
- **doc エッジも自己申告**: `depends_on` は著者/エージェント宣言。貼り忘れ＝見えない影響。緩和は `@impl` と同じ（解決と drift を検証）。「prose で REQ/doc に言及あるが `depends_on` 無し→提案」lint は任意・既定オフ。
- **barrel/re-export の symbol 解決**（symbol-level の古典的難所）。
- **drift 粒度**: doc/仕様を丸ごとハッシュは小編集で全下流点灯（ノイズ）、節単位は安定アンカーが要る。まず丸ごと、後で節単位（コードの file/symbol と同じ綱引きが一段上で再現）。
- **PreToolUse のレイテンシ予算**（デーモン必須）。
- **未カバー = TODO か漏れか**: 未カバーは Plan 信号に留め、ゲートは変更一貫性のみ。
- 既存プロジェクトへの導入方針(初期セットアップ)：この表記まったく無い既存プロジェクトに、どう導入するか。新しく書くSpecから徐々に入れる？それ用の Skill はあって良いかも
- この表記方法の強制方法：Skill などの提供？
- 既存ツールとの組み合わせ：Cucumber など

## 11. 先行事例（学ぶ点）

- **CoDD**: frontmatter スキーマ（node_id/depends_on/relation）は **D7 のグラフ層としてそのまま採用**。Green/Amber/Gray は depth/型ベースに読み替え。`extract`（ブラウンフィールド）、Skills/Hook/MCP の作法も参考。※ CoDD の **LLM 伝播層は取り込まない**＝棲み分け（spectrace は統合＋決定性、CoDD は doc 限定＋自動修正が厚い）。
- **OpenFastTrace**: ID モデル、Needs/Covers、"Outdated" 安全網。
- **reqmd**: カバレッジを .md に書き戻す UX。
- **eslint-plugin-traceability**: grep 可能な検証チェックポイント、`traceability-maint` リネーム CLI。
- **oxc / typescript-go(tsgo) / oxlint / rslint**: 「fast core ＋ tsgo」の実装パターン。
