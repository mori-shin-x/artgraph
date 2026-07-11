<!--
Sync Impact Report — Constitution v1.2.1
================================================================
Version change: 1.2.0 → 1.2.1 (PATCH — 表現の実態合わせ、原則の変更なし)
Amended: 2026-07-11

Modified sections:
- 技術基盤と制約 (Technical Stack & Constraints)
  - 「AST 解析」: 「ts-morph を一次解析として採用する」→「oxc-parser を一次解析
    として採用する」に修正(実コード src/parsers/typescript.ts は issue #159 で
    ts-morph backend を oxc-parser に置換済み、ts-morph は依存にも存在しない)。
    file-level フォールバックとグラフモード明示の方針は不変。
  - 「Runtime / Language」: 「Node.js >= 20」→「Node.js >= 22」に修正
    (package.json#engines の実態、CI も 22 系)。

Principles (5): 変更なし。原則本文への影響なし(技術基盤節は原則の下位の実装
制約記述であり、表現ドリフトの是正のみ)。

Templates / dependent artifacts — grep 確認結果 (ts-morph / Node 20 表記):
- docs/architecture.md   ✅ 既に「現在は oxc-parser ベースの軽量抽出層に
  置換済み — #159」と正しく記述済み(ts-morph は歴史的経緯としてのみ言及)。
  変更不要。
- README.md / README.ja.md ✅ 既に Node.js ≥ 22 / badge も ≥22 で正しい。
  ts-morph の言及なし。変更不要。
- .specify/templates/*.md ✅ 技術基盤の具体値を記述しておらず変更不要。
- specs/**/*.md (011, 015, 016, 004, 007, 012, 021, 005, 009, 010, 013,
  017, 018, 008, 006 ほか) — ts-morph / Node 20 の言及は当時の spec 記録
  (plan.md の Primary Dependencies、research.md の実測ログ等)であり、本改訂
  では変更しない(過去の意思決定の記録として保持)。

本 issue (#252) はドキュメントのみの是正であり、spec 021 の実装差分を含まない
(main から分岐、spec 021 とは独立)。

Follow-up TODOs: なし(本改訂で完結)。
-->

# artgraph Constitution

## Core Principles

### I. 決定的グラフ第一 (Determinism First) — NON-NEGOTIABLE

artgraph が生成・更新するグラフ、エッジ、判定はすべて決定的でなければならない。
LLM・統計推定・確率的ヒューリスティックに依存した結論を artifact graph や
CLI の判定出力に混入させてはならない。実装の意思決定はこの原則を満たす方法を
最初に選ぶ。

- ノード/エッジは frontmatter 宣言、ID タグ、TS AST、または正規化済みテスト実行
  トレース成果物のいずれかから派生する。トレース由来のエッジ (`exercises`) は
  `graph = f(files, trace)` を満たし、同一の trace 入力から byte-identical に
  再導出できなければならない。
- drift / orphan / uncovered の判定は content-hash と lock ファイルだけで決まる。
  トレース由来エッジの鮮度 (staleness) 判定も同じく content-hash 照合だけで決まる。
- LLM ベースの推定は、CLI 出力ではなく Skill / エージェント側の補助情報に閉じる。

**Why**: 競合ツール（DeepDocs, SpecSync 等）の弱点は LLM 推定の非再現性にある。
artgraph の市場ポジション（決定的 × AST × 4 層統合）はこの原則を捨てた瞬間に
崩れる。

### II. 単一型付き4層グラフ (Single Typed Four-Layer Graph)

すべての追跡対象は `req` / `doc` / `symbol`|`file` / `test` の 4 ノード型と、
`depends_on` / `derives_from` / `implements` / `verifies` / `imports` のエッジ
型を持つ 1 つのグラフに収容する。新機能を追加する場合は、まずどのノード/
エッジ型に写像できるかを検討し、それで表現できる限り独自スキーマを追加しない。

- 異なるレイヤー（要求↔doc↔code↔test）の探索は同じトラバーサルロジックで賄う。
- グラフモデルへの新フィールド追加は plan.md の Constitution Check で正当性を
  説明する。

**Why**: 4 層統合グラフは差別化の核（docs/architecture.md §3）。レイヤー別の
スキーマを並走させると impact クエリの一貫性が崩壊する。

### III. Spec が ID を所有、コードが claim する (Spec Owns the ID; Code Claims) — NON-NEGOTIABLE

要求 ID（FR-NNN, Requirement N 等）は仕様ファイル側で発行する。実装側は
`// @impl FR-001` のように claim タグで参照するだけで、独自 ID を発行しない。
カバレッジは三段階で評価する: `untagged` / `impl-only` /
`verified(impl + green test)`。オプトイン設定 (`trace.acceptExercises`) が
有効な場合に限り、claim を持たない REQ に第 4 状態 `exercised`(green な
タグ付きテストによる排他的実行証拠あり)を許す。`exercised` は claim 済み
REQ の評価には影響せず、実行証拠が claim を代替することはあっても、claim が
実行証拠を偽装することはできない(証拠は claim を監査する方向にのみ働く)。

- 一致しない `@impl` (= orphan) と、テストで verify されない `@impl` は CLI で
  即時可視化される。
- claim(`@impl`)と実行証拠(`exercises`)の不一致 — 実行されない claim、
  claim なき排他的実行 — は CLI で即時可視化される。
- グローバルな「全 ID が verified」を必須ゲートにはしない。ゲートは「この変更
  で claim した ID が drift / orphan / uncovered のまま残っていないこと」。

**Why**: ID 所有権を分散させると drift 検出ロジックが壊れる。三段階カバレッジ
は「タグだけで安心する」を防ぐための非対称な信頼境界。

### IV. SDD ツール ID 直接利用 (Reuse SDD Tool IDs)

Spec Kit / Kiro / BMAD 等の SDD ツールが発行する ID をそのまま artgraph の
req ID として扱う。artgraph 独自の ID レイヤーを設けてはならない。同一 ID が
複数の spec ファイルに出現する場合のみ spec ディレクトリ名で修飾する
（例: `004-id-lifecycle/FR-001`）。

- ID 形式（PREFIX-NNN、`Requirement N` 見出し）は `.artgraph.json` の
  `reqPatterns` で拡張するが、独自プレフィックスを SDD ツール側より優先しない。
- rename / split / merge は `artgraph rename` で `@impl` タグと lock を一括書換。

**Why**: 学習コストと導入摩擦の最小化。独自 ID 層は SDD ツール側のリナンバ
リングと二重管理を生み、現場で破綻する。

### V. 構造整合のみ保証 (Boundary of Determinism) — NON-NEGOTIABLE

artgraph が保証するのは構造的整合（リンクが解決する / 未承認 drift が無い /
claim 済み未カバーが無い / 依存元が特定できる）までである。意味的正しさ（その
コードが本当に要求を満たすか、その doc が事実と整合しているか）は人/AI レビュー
の責務であり、artgraph の CLI 出力で判定してはならない。

- 「仕様文の善し悪し」「要求の妥当性」「ドキュメントの自動生成・自動書き換え」
  はスコープ外。
- Skill / エージェントが LLM で意味判定する場合も、その結論を `.trace.lock` や
  グラフへ自動コミットしてはならない。承認は人間レビュー経由のみ。

**Why**: 構造と意味の境界を曖昧にすると、自動化が暴走した時の被害が観測不能に
なる。境界が明確であるからこそ、artgraph の judgement を信頼できる。

## 技術基盤と制約 (Technical Stack & Constraints)

- **Runtime / Language**: Node.js >= 22、TypeScript（`"type": "module"` の ESM）。
- **Package layout**: 単一パッケージ。CLI 本体は `src/` に置き、配布物は `dist/` と
  `templates/` のみ（`package.json#files`）。追加パッケージ計画が再浮上した時点で
  pnpm workspace 化を再検討する。
- **AST 解析**: oxc-parser を一次解析として採用する。`import *` / 動的 import /
  リフレクション等で symbol-level に解決できないエッジは file-level にフォール
  バックし、グラフモードを出力に明示する。
- **Markdown 解析**: unified + remark-parse、frontmatter は eemeli/yaml ベースの自前スプリッタ。
- **テスト**: vitest（ユニット / 統合）。CLI の振る舞いは E2E 相当のシナリオ
  テストで担保する。
- **静的解析**: oxlint（lint）、knip（未使用検出）、oxfmt（フォーマット）。
  CI と pre-commit で実行可能であることを維持する。
- **配布物**: `artgraph` CLI（`bin/artgraph`）、Claude Code Skills、
  `.artgraph.json` テンプレート。これら以外を public API として公開しない。

## 開発ワークフローと品質ゲート (Development Workflow & Quality Gates)

- **ブランチ運用**: P2 以降の機能は独立ブランチで並行開発する（例: `p2/skills`,
  `p2/id-lifecycle`）。main から分岐し、機能単位で独立マージ可能であること。
- **Spec-Driven**: 新機能は `specs/NNN-feature/` に spec.md → plan.md → tasks.md
  を順に整備する。spec-kit Skill（`/speckit-specify`, `/speckit-plan`,
  `/speckit-tasks`）の利用を推奨する。
- **PR レビュー**: すべての変更は PR レビューを経る。レビュー観点に
  「Constitution Check の遵守」「artgraph check の drift / orphan / uncovered
  ゼロ」「該当 Skill が壊れていないか」を含める。
- **ゲート**: `artgraph check --gate` が drift / orphan / claim 済み uncovered を
  検出した場合、その PR は通さない。グローバルな全 ID カバレッジは推奨であり
  ゲートではない（原則 III）。
- **Hook 戦略**: PreToolUse は file-level（速度優先）、Stop / Plan 系は
  symbol-level（精度優先）に分けて呼び出す。レイテンシ予算を超える Hook は
  採用しない。

## Governance

- **権威**: 本憲法は他のあらゆる開発プラクティス・README・docs の記述に優先する。
  矛盾が生じた場合は本憲法を真とし、他方を更新する。
- **改訂手続き**: 改訂は PR で提案する。PR には (a) 改訂後の constitution 全文、
  (b) 影響を受けるテンプレート / docs の同時更新、(c) Sync Impact Report の更新
  を含める。承認はオーナー（@mori-shin-x）のレビューを必須とする。
- **Versioning**:
  - MAJOR: 既存原則の削除・後方非互換な再定義、ガバナンス手続きの破壊的変更。
  - MINOR: 新規原則 / セクションの追加、ガイダンスの実質的拡張。
  - PATCH: 表現の明確化、誤字、非意味的な改善。
- **遵守レビュー**: `/speckit-plan` の Constitution Check で各原則と整合する
  ことを確認する。違反は plan.md の Complexity Tracking 表に正当化理由と棄却
  された代替案を明記しない限り許容しない。
- **逸脱の扱い**: 原則 I, III, V は NON-NEGOTIABLE。例外は本憲法の改訂を経た
  上でのみ認められる。それ以外の原則は Complexity Tracking で justify した場合
  に限り feature 単位の逸脱を許容する。

**Version**: 1.2.1 | **Ratified**: 2026-06-23 | **Last Amended**: 2026-07-11
