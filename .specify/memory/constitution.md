<!--
Sync Impact Report — Constitution v1.1.0
================================================================
Version change: 1.0.0 → 1.1.0 (MINOR — §技術基盤と制約 内の package layout 規定を改訂)
Amended: 2026-06-26

Modified sections:
- 技術基盤と制約 (Technical Stack & Constraints)
  - `Monorepo: pnpm workspace。packages/artgraph が CLI 本体…` を
    `Package layout: 単一パッケージ。CLI 本体は src/ に置き、配布物は dist/ と templates/ のみ` に改訂。
    eslint-plugin 等の追加パッケージ計画 (Issue #24) が見送られ、workspace 層を維持する便益が
    無くなったため (1パッケージのまま workspace を保つ運用コストを削減)。
    将来の追加パッケージ計画が再浮上した時点で workspace 化を再検討する。

Principles (5): 変更なし。
- I. 決定的グラフ第一 (Determinism First) — NON-NEGOTIABLE
- II. 単一型付き4層グラフ (Single Typed Four-Layer Graph)
- III. Spec が ID を所有、コードが claim (Spec Owns the ID; Code Claims) — NON-NEGOTIABLE
- IV. SDD ツール ID 直接利用 (Reuse SDD Tool IDs)
- V. 構造整合のみ保証 (Boundary of Determinism) — NON-NEGOTIABLE

Templates / dependent artifacts:
- .specify/templates/plan-template.md       ✅ Constitution Check は generic placeholder のままで整合
- .specify/templates/spec-template.md       ✅ 変更不要
- .specify/templates/tasks-template.md      ✅ 変更不要
- .specify/templates/commands/*.md          ✅ 該当パス無し
- README.md / docs/spectrace-design.md      ✅ パッケージ層に関する記述は無いので影響なし
- .specify/scripts/bash/common.sh           ✅ SPECIFY_INIT_DIR の説明は Spec Kit 一般機能の説明であり、artgraph 固有のレイアウトに依存しないため変更不要
- specs/005-speckit-remaining/quickstart.md ✅ 未完 spec の実行手順をフラットパスに更新

Follow-up TODOs:
- specs/ 配下の完了 spec (006/009/010 等) が含む `packages/artgraph/...` パスは履歴アーティファクトとして保持。
-->

# artgraph Constitution

## Core Principles

### I. 決定的グラフ第一 (Determinism First) — NON-NEGOTIABLE

artgraph が生成・更新するグラフ、エッジ、判定はすべて決定的でなければならない。
LLM・統計推定・確率的ヒューリスティックに依存した結論を artifact graph や
CLI の判定出力に混入させてはならない。実装の意思決定はこの原則を満たす方法を
最初に選ぶ。

- ノード/エッジは frontmatter 宣言、ID タグ、TS AST のいずれかから派生する。
- drift / orphan / uncovered の判定は content-hash と lock ファイルだけで決まる。
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

**Why**: 4 層統合グラフは差別化の核（spectrace-design.md §3）。レイヤー別の
スキーマを並走させると impact クエリの一貫性が崩壊する。

### III. Spec が ID を所有、コードが claim する (Spec Owns the ID; Code Claims) — NON-NEGOTIABLE

要求 ID（FR-NNN, Requirement N 等）は仕様ファイル側で発行する。実装側は
`// @impl FR-001` のように claim タグで参照するだけで、独自 ID を発行しない。
カバレッジは三段階で評価する: `untagged` / `impl-only` /
`verified(impl + green test)`。

- 一致しない `@impl` (= orphan) と、テストで verify されない `@impl` は CLI で
  即時可視化される。
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

- **Runtime / Language**: Node.js >= 20、TypeScript（`"type": "module"` の ESM）。
- **Package layout**: 単一パッケージ。CLI 本体は `src/` に置き、配布物は `dist/` と
  `templates/` のみ（`package.json#files`）。追加パッケージ計画が再浮上した時点で
  pnpm workspace 化を再検討する。
- **AST 解析**: ts-morph を一次解析として採用する。`import *` / 動的 import /
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
  を含める。承認はオーナー（@ShintaroMorimoto）のレビューを必須とする。
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

**Version**: 1.1.0 | **Ratified**: 2026-06-23 | **Last Amended**: 2026-06-26
