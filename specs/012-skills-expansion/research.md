# Phase 0: Research & Design Decisions

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)

spec.md には [NEEDS CLARIFICATION] マーカーが 0 件なので、本 research は (a) 設計判断の根拠の明示と (b) 採用しなかった代替案の記録に充てる。

すべての出典は 2026-06-27 時点の一次資料 (公式 docs / GitHub の最新 main) で確認済。

---

## R1. Skill vs MCP の使い分け

### Decision

Skills + CLI + Hooks で 28 FR を実現する。MCP サーバ実装は本 spec のスコープ外 (P4 条件付き延期)。

### Rationale

artgraph のコアユースケース (Plan 時 impact / Verify 時 check / Coverage / Rename) は **per-call の latency が緩い** (人の判断時間と並行) かつ **state-less** (各 call は独立) なので、Skills + Bash 起動で十分。MCP の固有メリット (daemon warm cache、tool list 常駐) は本 feature では決定打にならない。

MCP の真の差別化価値は「Cursor / Windsurf / Kiro Custom Agents 等のクロスエージェント対応」であり、これは現状の artgraph ユーザー (Claude Code 中心) に対しては未需要。`cc-sdd` (17 Skills, MCP なし) が同哲学で成立している実例も傍証。

PostToolUse hook のレイテンシ問題は専用 HTTP daemon でも代替可能 (`docs/architecture.md` §8 が示唆)。MCP に限定する必要なし。

### Alternatives considered

- **MCP-first 設計**: architecture.md §8 の元来計画。**却下**理由 = Skills が成熟した後に再評価すると ROI が低い (実装コスト中〜大、ユーザー価値が「あれば便利」止まり)。
- **Skill + MCP のハイブリッド**: Skill が MCP tool を優先呼出し、未登録時は CLI fallback。**却下**理由 = 二重メンテ。MCP 実装が必要になった段階で改めて設計する。

### Source

- [Skills 公式](https://code.claude.com/docs/en/skills) / [Skill 著者ベストプラクティス](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [cc-sdd (gotalab)](https://github.com/gotalab/cc-sdd) — 17 Skill, MCP 0 の SDD 補完ツール

---

## R2. 既存 4 Skill の共通化方式

### Decision

`templates/skills/_shared/install-check.md` を共通参照ファイルとして配置し、各 SKILL.md は「最初に `_shared/install-check.md` を読んで前提を確認」と記述する。frontmatter の `references:` 等は使わない (まだ標準化されていない)。

### Rationale

Anthropic 公式の progressive disclosure (3 段: metadata / SKILL.md / `references/` `scripts/`) は SKILL.md がディレクトリ内の `references/` を持つことを推奨。共通参照の場合は **共通の祖先ディレクトリ (`templates/skills/_shared/`) に置き、SKILL.md からマークダウンリンク** ([../\_shared/install-check.md](./_shared/install-check.md) 風) で誘導するのが、Claude Code が現在サポートしている範囲で最もシンプル。

### Alternatives considered

- **frontmatter で `references: [_shared/install-check.md]` を宣言**: **却下**理由 = 公式 frontmatter schema にこのフィールドは未定義。互換性リスク。
- **ファイル include (`{{> include}}`)**: **却下**理由 = SKILL.md は plain markdown であり template engine を使わない方針。
- **SKILL.md に install-check を inline コピー** (現状): **却下**理由 = 4 ファイル重複、変更時に同期忘れリスク。issue #98 が指摘した DRY 違反。

### Source

- [anthropic-skills/mcp-builder](https://github.com/anthropics/skills/tree/main/skills/mcp-builder) — `reference/python_mcp_server.md` 等で progressive disclosure
- [anthropic-skills/skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) — `scripts/` / `agents/` 切り出しパターン

---

## R3. CLAUDE.md / AGENTS.md スニペット注入の境界マーカー

### Decision

HTML コメント `<!-- artgraph: BEGIN agent context -->` と `<!-- artgraph: END agent context -->` で囲った領域のみを `init --with-agent-context` で生成・更新する。既存外部コンテンツは破壊しない (idempotent)。

### Rationale

Markdown はコメント構文を持たないが HTML コメントは GFM でも render されないため、ユーザーに見えず安全に境界化できる。Spec Kit 自身が `<!-- SPECKIT START -->` / `<!-- SPECKIT END -->` で同じパターンを採用しており、慣習との衝突なし。

### Alternatives considered

- **YAML frontmatter で artgraph セクションを管理**: **却下**理由 = CLAUDE.md/AGENTS.md は frontmatter を期待しない単純 markdown であり、Claude Code の context 読み込み挙動が frontmatter で変わる懸念。
- **別ファイル (`.claude/artgraph-context.md`)**: **却下**理由 = Claude Code が自動で読まないため context に注入されない。

### Source

- [Spec Kit `update-agent-context.sh`](https://github.com/github/spec-kit/blob/main/.specify/scripts/bash/update-agent-context.sh) — `<!-- SPECKIT START -->` パターンの実装例

---

## R4. `.claude/settings.json` の merge 戦略

### Decision

JSON を読み、`hooks.Stop` と `hooks.PostToolUse` の存在を確認する。**未設定の場合のみ追記**。既存設定がある場合は**上書きせず警告**し、手動マージを促す (FR-013 の fail-on-conflict)。

実装は標準 `JSON.parse` + 構造比較。深い merge ライブラリは導入しない (構造はトップ階層のみ)。

### Rationale

ユーザー設定の破壊は致命的 (CI が落ちる / hooks が壊れる)。安全側に倒し、衝突時は明示的に人に判断を委ねる。Anthropic 公式の `.claude/settings.json` も hook 配列のマージ責任は documented ではないため、保守的に。

### Alternatives considered

- **既存 hook を残しつつ自身を append**: **却下**理由 = 順序依存と無限ループリスク (`stop_hook_active` の扱い)。
- **`--force` で問答無用上書き**: **却下**理由 = ユーザーが意図しない設定を失う恐れ。代わりに「警告 + 手動マージ手順を提示」が安全。

### Source

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks) — hook 配列の serialization 仕様

---

## R5. Plugin 配布の経路選択

### Decision

(a) GitHub repo 自体を marketplace 化 (`/plugin marketplace add ShintaroMorimoto/artgraph`) を即実施し、(b) 安定後 `claude-plugins-community` ([submission フォーム](https://claude.ai/admin-settings/directory/submissions/plugins/new)) に submit する。Anthropic 公式 marketplace (`claude-plugins-official`) は申請窓口無し (discretionary) のため非ターゲット。

### Rationale

(a) は申請不要・即配布可能で 0 コスト。`/plugin marketplace add owner/repo` という 1 コマンドで導入経路を案内できる。(b) は community marketplace (2200 plugin 登録済) に入ることでリーチが広がるが、安定運用 (release 体制、validator 通過、`/plugin install` 経由の smoke test) を確認してから submit するのが堅実。

### Alternatives considered

- **`claude-plugins-official` 入りを目指す**: **却下**理由 = 申請窓口がなく Anthropic 都合の招待制。計画化できない。
- **完全に自前 marketplace のみ**: **却下**理由 = community marketplace 経由のリーチ機会を逃す (将来オプションとして残す)。
- **npm のみで配布 (Plugin なし)**: **却下**理由 = `/plugin install` 経路のユーザー (CLI に慣れていない / npm の global install を避けたい層) を取り逃がす。

### Source

- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Plugin marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces)
- [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community) — 2200 plugin 登録済の community marketplace
- [Submission form](https://claude.ai/admin-settings/directory/submissions/plugins/new)

---

## R6. Plugin と npm の single source of truth

### Decision

`templates/skills/` をすべての配布物の **唯一の skill source** とする。Plugin の `.claude-plugin/plugin.json` は `"skills": "./templates/skills/"` で同ディレクトリを直接指す。npm 配布は `init --with-skills` で同ディレクトリから `.claude/skills/` にコピー。

symlink (`plugins/artgraph/skills/ → ../../templates/skills/`) は使わない。

### Rationale

Plugin install 時に Claude Code は plugin directory を `~/.claude/plugins/cache/` に **丸ごとコピー** するため、symlink は cache 段階で切断される ([Plugin marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces#how-plugins-are-installed))。`plugin.json` 内の path 参照は repo 内 path として解決されるので、`"skills": "./templates/skills/"` で安全。

### Alternatives considered

- **Plugin 用に `plugins/artgraph/skills/` を別途用意し CI で同期**: **却下**理由 = 二重管理。CI の同期ロジックがバグると配布が壊れる。
- **Symlink**: **却下**理由 = 上述の cache 問題で機能しない。

### Source

- [Plugin marketplaces — how plugins are installed](https://code.claude.com/docs/en/plugin-marketplaces#how-plugins-are-installed)
- [BMAD-METHOD / PabloLION/bmad-plugin](https://github.com/PabloLION/bmad-plugin) — 別 fork 化していて参考にならない反例

---

## R7. Spec Kit hook の発火信頼性確保

### Decision

`templates/integrate/speckit/commands/artgraph.scan-reconcile.md` を **出力消費型** にする — コマンド body で「stdout に 1 行 JSON サマリ `{"reconciled": N, "drift": M}` を必ず emit せよ」と明記し、agent が結果を読む形にする。これにより Spec Kit 側の dispatch ロジックが副作用のみ hook を skip するパス (Issue #2730) を回避する。

加えて `templates/integrate/speckit/README.md` で「fire しない場合は `/artgraph.scan-reconcile` を slash command として手動実行」と fallback を明記する。

### Rationale

Spec Kit Issue #2730 (closed 2026-06-25) の事実: `EXECUTE_COMMAND:` directive は emit されるが pure Claude Code 経由では「出力を消費する hook」のみ確実に dispatch される。`bgervin/spec-kit-sync` extension が同問題を「全 hook を諦めて slash command 配布のみ」で回避していることが先例。artgraph は hook を維持しつつ出力消費型化することで両立を狙う。

`after_implement` → `check-diff` は既に pass/fail を返す出力消費型なので影響なし。`after_tasks` → `scan-reconcile` のみ改修対象。

### Alternatives considered

- **`hooks` ブロックを extension.yml から削除し slash command のみ配布**: **却下**理由 = Spec Kit の宣言的拡張機構を活用しないのは「AI エージェントネイティブ」目標と矛盾。
- **dispatch 失敗を諦めて何もしない**: **却下**理由 = ユーザー体験が劣化 (artgraph baseline が古いまま `check` が実行され false positive が出る)。

### Source

- [Spec Kit Issue #2730](https://github.com/github/spec-kit/issues/2730)
- [Spec Kit PR #2713 (Mandatory Post-Execution Hooks)](https://github.com/github/spec-kit/pull/2713)
- [bgervin/spec-kit-sync](https://github.com/bgervin/spec-kit-sync) — hook を諦めた slash command 配布の先例

---

## R8. Kiro steering の `inclusion: auto` 設計

### Decision

`templates/integrate/kiro/artgraph.md` の冒頭に YAML frontmatter:

```yaml
---
inclusion: auto
description: "Use when checking drift between specs/design/tasks/code, before approving an implementation step, or when running impact analysis."
---
```

を追加。本文 (steering 本体) は現状維持。

### Rationale

Kiro の `inclusion: auto` モードは `description` の semantic match で発火するため、関連作業時のみ context に注入される。`always` (現状の挙動) は常時 token 消費するので大規模 repo では context 圧迫源。`description` 文面は Kiro 公式 docs の "describe when this steering is relevant" 推奨に従う。

### Alternatives considered

- **`inclusion: fileMatch` + `fileMatchPattern: "specs/**"`**: **却下**理由 = artgraph の関心領域は spec ファイル編集だけでなく code 編集時の impact 確認も含む。fileMatch は狭すぎ。
- **`inclusion: manual` + `#artgraph` 参照**: **却下**理由 = ユーザーが毎回明示する必要があり、agent-native goal と矛盾。
- **MCP server に置き換え**: **却下**理由 = R1 の通り需要先行で延期。Steering で目的達成可能。

### Source

- [Kiro Steering docs](https://kiro.dev/docs/steering/) — `inclusion` の 4 モード説明

---

## R9. OpenSpec community schema 形式

### Decision

`templates/integrate/openspec/schemas/artgraph/schema.yaml` + `templates/<phase>.md` を Fission-AI/OpenSpec の community schema 規約に従って配置。`artgraph integrate openspec` は `openspec/schemas/artgraph/` 配下にコピーする。schema.yaml には `apply` フェーズの verify ステップとして `artgraph check --diff` の呼び出しを記載する。

### Rationale

OpenSpec の `community schemas` は `openspec/schemas/<name>/{schema.yaml, templates/}` 形式の自己完結バンドルで外部ツールが対応する公式経路 ([customization docs](https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md))。既存先例 (`JiangWay/openspec-schemas`, `intent-driven-dev/openspec-schemas`) と同形式にすることで OpenSpec ユーザーの認知コストを下げる。

OpenSpec の Requirement は見出し駆動で **ID 文字列を持たない** という特性は、`docs/architecture.md` §11 と `Issue #25` で既に slug 派生 (`ID = <domain>/slug(requirement-name)`) の方針が決まっているため、本 feature でも踏襲する。

### Alternatives considered

- **OpenSpec 用に独自 ID 体系を artgraph 側で発行**: **却下**理由 = Constitution IV (SDD ツール ID 直接利用) 違反。
- **OpenSpec 統合は P5+ に延期**: **却下**理由 = 親 issue の「SDD ツール統合の網羅性」目標に対して必須。実装コストも他 SDD ツールと同等。

### Source

- [OpenSpec customization docs](https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md)
- [Fission-AI/OpenSpec README](https://github.com/Fission-AI/OpenSpec/blob/main/README.md) — propose → apply → archive ライフサイクル

---

## R10. Skill description の書き方ベストプラクティス

### Decision

全 7 Skill (新規 3 + 既存改修 4) の `description` を以下のフォーマットに統一:

```
<Third-person verb phrase describing what>. Use when <when>. Make sure to use this skill whenever <trigger phrasing>.
```

例 (`artgraph-setup`):
```
Installs artgraph in the current project and wires up Skills, hooks, and any detected SDD-tool integration. Use when the user asks to install / set up / add artgraph. Make sure to use this skill whenever the user mentions "artgraph" for the first time and `artgraph` CLI is not yet available.
```

英文+日文併記は冗長になるため、English を canonical とし、日本語 description は spec 内 docs (`docs/skills-guide.md`) でカバーする。

### Rationale

Anthropic 公式 [Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) より:
- "third person" (Claude が読み手として理解しやすい)
- "what + when" を 1 文に
- "Make sure to use this skill whenever" で軽く push (Claude は under-trigger 傾向)
- 1,536 文字制限 (description + when_to_use 合計)

### Alternatives considered

- **日本語 description**: **却下**理由 = Claude Code の Skill selector が英語前提で訓練されている可能性が高く、英語の方が安定発火。docs/CLAUDE.md 側で日本語の使い方を補足する。
- **`when_to_use` フィールドを別途使う**: **却下**理由 = 1,536 文字制限内で `description` 単一で表現可能。冗長性を排す。

### Source

- [Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [anthropic-skills/skill-creator/SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)

---

## R11. `init --integrate auto` の挙動

### Decision

`--integrate auto` フラグは内部で `detectProject()` を呼び、検出されたすべての SDD ツール (Spec Kit / Kiro / 将来 OpenSpec) に対して `integrate <tool>` を順次実行する。`--integrate-gate` (デフォルト on) も同時に適用される (各 tool で `--gate` 等価)。検出ゼロなら no-op、エラーにしない。

ユーザー対話: バッチで「2 個の SDD ツールを検出: Spec Kit, Kiro。両方統合を配備します。よろしいですか? (Y/N)」を 1 回だけ。per-tool prompt はしない。

### Rationale

エージェントが何度も Y/N を聞くと UX が悪化する (US1 acceptance scenario 「ユーザー入力は基本的に同意 (Y/N) のみで完結する」と矛盾)。`--integrate auto` は意図的にバッチ動作にし、細かい設定 (個別 tool の `--gate` カスタマイズ) は事後の `integrate <tool> --gate=...` で対応する分業。

### Alternatives considered

- **per-tool Y/N**: **却下**理由 = US1 の体感を損なう。
- **検出ゼロでエラー終了**: **却下**理由 = artgraph 単体使いのユーザーを排除する。
- **`--integrate=speckit,kiro` 明示指定のみサポート (auto キーワードなし)**: **却下**理由 = エージェントが明示指定を組み立てるための余計な context が必要。`auto` で十分。

### Source

- 既存 `src/init.ts:242-294 runRequestedIntegrations()` 実装パターンを継承

---

## R12. Plugin の hooks bundling 方法

### Decision

`.claude-plugin/plugin.json` で `"hooks": "./hooks/hooks.json"` を指し、`hooks/hooks.json` に Stop hook 定義を書く。コマンドは `${CLAUDE_PLUGIN_ROOT}` を使って repo 相対参照を避ける。

例:
```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "npx artgraph check --gate --diff" }
      ]}
    ]
  }
}
```

ただし `${CLAUDE_PLUGIN_ROOT}` を直接使う必要はない (Stop hook は `npx artgraph` で artgraph CLI を呼ぶだけで、plugin 内 script は使わない)。

### Rationale

Plugin install ユーザーは `/plugin install artgraph@...` 一発で skills も hooks も両方手に入る。`init --with-hooks` を別途実行する必要がない (npm 経由ユーザーは必要)。

### Alternatives considered

- **Plugin に hooks を含めず Skill で hooks 設定方法を案内**: **却下**理由 = Plugin の価値が薄れる。設定が手動だと skill+hook の補完関係が成立しない。
- **`hooks.json` 内で `${CLAUDE_PLUGIN_ROOT}` 必須**: **却下**理由 = artgraph CLI は npm global / npx に依存。Plugin 内に bundled bin を置く必要はない。

### Source

- [Plugins reference - hooks フィールド](https://code.claude.com/docs/en/plugins-reference)
- [anthropics/claude-plugins-official/ralph-loop hooks.json](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/ralph-loop/hooks/hooks.json) — `${CLAUDE_PLUGIN_ROOT}` 利用例 (artgraph では不要)

---

## まとめ

12 個の設計判断はすべて一次資料で裏付けられており、Constitution の NON-NEGOTIABLE 原則と整合する。Phase 1 (data-model / contracts / quickstart) は本判断を前提に進行する。
