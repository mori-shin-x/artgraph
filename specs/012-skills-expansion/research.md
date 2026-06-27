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

## R9. OpenSpec 統合 — 本 spec から外す

### Decision (REVISED 2026-06-27)

OpenSpec 統合は本 spec のスコープから外し、issue [#25](https://github.com/ShintaroMorimoto/artgraph/issues/25) ベースで別 spec (`013-openspec-support` 等) として進める。本 spec の P3 OpenSpec 関連タスク (T040, T047–T052) は削除。

### Rationale

OpenSpec 対応は他 SDD ツール (Spec Kit / Kiro) と性質が違う:
- Spec Kit / Kiro は **拡張機構経由で artgraph CLI を呼ばせる**だけ (template 配布層の作業)
- OpenSpec は **artgraph CLI 自身が OpenSpec spec を読めるようにする** 必要がある (CLI コア層の改修)

具体的に issue #25 が要求するもの:
- `### Requirement: <name>` 見出し駆動の parser (OpenSpec は ID 文字列を持たない)
- `<domain>/slug(requirement-name)` の ID 派生モデル
- `openspec/changes/<name>/` のデルタライフサイクル (ADDED/MODIFIED/REMOVED) 認識
- `changes/archive/` の glob 除外
- サイドカー `openspec/.spectrace/ids.json` (明示 ID オプトイン)
- `artgraph migrate-id` コマンド (リネーム吸収)
- OpenSpec 固有 Skills 3 つ (`spectrace-openspec-{propose,verify,archive}`)
- 専用フィクスチャテスト

これらは本 spec の「配布・統合・Skill 層のみ触る」スコープから大きく外れる。本 spec で薄く対応するより、issue #25 の設計検討を踏まえた別 spec で適切な深さで進める方が、品質も保守性も上がる。

本 spec から OpenSpec を外したことで:
- 削除タスク: T040, T047, T048, T049, T050, T051, T052 (計 7 task)
- 削除 FR: FR-025, FR-026 (OpenSpec integrate openspec + apply gate)
- 削除 SC: SC-007 OpenSpec apply gate
- 削除 Edge Case: (なし、Edge Cases は元から少なめ)

代わりに本 spec の P3 は **Spec Kit hook fix (US7) + Kiro Smart Hook (US8)** の 2 機能のみに縮小。

### Alternatives considered

- **本 spec で薄く対応 (provider + schema 配布のみ)**: **却下**理由 = OpenSpec の本質的な ID/parser/changes lifecycle に触らないため「OpenSpec 対応してる」と誤認させて中途半端。issue #25 のレビュアー (= maintainer 本人) の意図とも齟齬。
- **本 spec で issue #25 を全部取り込む**: **却下**理由 = scope が一気に倍増 (parser, ID, changes, sidecar, migrate-id, 3 Skills, fixture)。レビュー粒度も悪化。
- **OpenSpec を最初から外したまま spec を書く**: **適切**だったが、初版で取り込んでしまった。本 R9 で revise。

### Source

- [Issue #25 OpenSpec 形式への対応 (設計検討)](https://github.com/ShintaroMorimoto/artgraph/issues/25) — slug 派生 ID、changes/ ライフサイクル設計、サイドカー方式の詳細
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

---

## R13. `artgraph-plan` Skill のリネームと 3 入力モード化

### Decision

`artgraph-plan` Skill を **`artgraph-impact` にリネーム** し、以下 3 入力モードを持たせる:

- **モード (a) diff**: git diff にステージ/未ステージ変更が存在 → `artgraph impact --diff` を実行
- **モード (b) explicit target**: ユーザー発話が REQ-ID (`REQ-001` 等) または ファイルパスを含む → 抽出して `artgraph impact <targets>` を実行
- **モード (c) ask**: 上記いずれも該当しない → ユーザーに「どの requirement / file を起点に分析しますか?」と確認質問

### Rationale

現 `artgraph-plan` Skill は `--diff` のみを呼ぶ実装で、「Plan」名と矛盾する。本来 Plan は **設計段階** の話 (= まだ変更が始まっていない) だが、`--diff` は **変更が始まった後** の差分。結果として:
- 真の Plan 段階 (空 diff、これから設計) → "No changes detected" で空振り終了
- diff がある (= 既に touch している) → ようやく動く

実 CLI (`src/cli.ts:302`) は `artgraph impact [targets...]` で **ファイルパス / REQ-ID / `--diff` の 3 形式を受け付ける** ことが調査で判明。Skill 側がこれを活用していないだけ。

リネーム理由:
- 機能名 (`impact`) と Skill 名 (`plan`) が一致せず混乱
- 未リリースなのでリネームコスト無し (FR-029 で英語化と同時)
- Skill description で「Use when planning / scoping / designing changes」と書けば「Plan 時に発火する」効果は維持

### Alternatives considered

- **`artgraph-plan` のまま 3 モード化**: **却下**理由 = 名前と機能の不整合が残る。未リリースでリネーム可能ならする方が clean。
- **`artgraph-impact` と `artgraph-plan` の 2 つに分割**: **却下**理由 = 機能的に同じ。差別化のしようがなく、選択ロジックも description マッチで分かれにくい。
- **モード (c) ask をやめて空振り終了**: **却下**理由 = エージェント UX が壊れる (ユーザーから見ると「Skill が動いたのに何もしない」)。

### Source

- 実 CLI 検証: `src/cli.ts:302-340` (`artgraph impact` 定義) — `[targets...]` と `--diff` を両立サポート
- ユーザー指摘 (2026-06-27 会話)

---

## R14. パッケージマネージャ検出 (Bun/Deno 対応の最小実装)

### Decision

`artgraph-setup` Skill に package manager 検出ロジックを組み込む (FR-026)。lockfile 優先順位:

1. `bun.lockb` → **Bun** (`bun install -D artgraph` + `bunx artgraph`)
2. `deno.json` または `deno.lock` → **Deno** (`deno add npm:artgraph` + `deno run -A npm:artgraph/cli`)
3. `pnpm-lock.yaml` → **pnpm** (`pnpm add -D artgraph` + `pnpm exec artgraph`)
4. `package-lock.json` → **npm** (`npm install -D artgraph` + `npx artgraph`)
5. `package.json#packageManager` field がある場合は最優先 (検出を上書き、ただし Yarn 指定時は npm フォールバック)
6. `yarn.lock` → **npm フォールバック** (Yarn 自体は本 spec のサポート対象外、警告を user に表示)
7. lockfile なし → **npm デフォルト** (フォールバック)

**Yarn 除外の理由** (ユーザー指示 2026-06-27): artgraph のターゲットユーザー (Claude Code / Cursor 系の最新 AI コーディング体験を求める層) で Yarn の利用比率は低いと判断。`yarn.lock` 検出時は npm fallback + 警告で扱う。Yarn 完全対応は将来需要が見えた時点で別 issue として検討。

ただし以下は **本 spec のスコープ外** (フォローアップ issue):
- Stop hook テンプレ (`templates/hooks/settings.json.template`) の `npx artgraph` 表記の generic 化
- Skill 本文・README の `npx artgraph` 表記の generic 化
- Plugin `hooks/hooks.json` の `npx artgraph` 表記の generic 化
- artgraph CLI 自身を `deno run` で実行できるように deno-compat (おそらく既に動くが要検証)

### Rationale

artgraph CLI 自身は `bin/artgraph` を提供する Node ESM パッケージなので、Bun (Node-compat) でも実行可能。Deno でも `deno run -A npm:artgraph/cli` で実行可能。問題は **「最初に install / 実行する Skill が npm/npx 前提でドキュメント化されている」** こと。`artgraph-setup` だけ最初に対応すれば「Bun ユーザーが Claude Code で『artgraph セットアップして』と頼んだとき、エージェントが Bun 流のコマンドを構築する」体験が成立する。

Stop hook / README 等の generic 化は別 issue で扱うのが妥当。理由:
- 範囲が広い (Stop hook テンプレ・Skill 本文・README・Plugin hook)
- 検出を template に埋め込む方法 (実行時検出 vs ビルド時テンプレ展開) の設計判断が必要
- `npx` フォールバックが Bun でも動くケースが多い (Bun は npm を含む) ので、実害は低い

### Alternatives considered

- **本 spec で全面 generic 化**: **却下**理由 = scope が一気に膨らむ。最小対応で価値を取り、深掘りは別 issue。
- **検出をやらず常に npm 固定**: **却下**理由 = Bun/Deno ユーザーが Skill 経由で artgraph セットアップした時、npm の lockfile が生成されて壊れる (彼らの workflow と不整合)。
- **検出を CLI 側 (`src/init.ts`) に置く**: **却下**理由 = `init` は既に install 済の前提なので、install フェーズ (`artgraph-setup` Skill) に置くのが論理的。

### Source

- ユーザー指摘 (2026-06-27 会話) — Bun/Deno 使用ケースを意識した記述が必要
- artgraph CLI は ESM + commander で Bun/Deno 互換 (deno-compat は要 smoke test)
- `bun.lockb` / `deno.lock` 等の lockfile signature は各 package manager 公式 docs に従う

---

## R15. `init` デフォルト挙動の根本見直し

### Decision

未リリース前提で、`artgraph init` のデフォルト挙動を **bare-config (現状) から full agent-native setup へ変更**。

- `artgraph init` (フラグなし) = **デフォルト full**: `.artgraph.json` + Skills install + `--integrate=auto` + Stop hook merge + CLAUDE.md/AGENTS.md snippet 注入
- `artgraph init --minimal` = **bare**: `.artgraph.json` のみ
- 個別 opt-out: `--no-skills` / `--no-integrate` / `--no-hooks` / `--no-agent-context` を提供
- (任意で個別 opt-in も支援: `--minimal --with-skills` で一部だけ入れる)

### Rationale

- **未リリース** = 後方互換を意識する必要なし。設計の本質に振り切れる
- agent-native ツールとしての価値は「ユーザーが何も考えなくても適切な設定が入る」こと。`init --with-skills --integrate=auto --with-hooks --with-agent-context` という 4 フラグを覚えてもらうのは UX 失敗
- `--minimal` は「artgraph CLI だけ手で使いたい、Skills/Hooks/integrate は不要」というアドバンスドユーザー向けの opt-out。マイノリティ動線で OK
- `--no-*` フラグは「ほぼ default で良いけど 1 つだけ無効化したい」というケース (例: 既存 `.claude/settings.json` を触られたくない → `--no-hooks`) に対応
- `artgraph-setup` Skill 側もシンプル化: install + `artgraph init` (フラグなし) で完結

### Alternatives considered

- **デフォルト bare のまま、`artgraph-setup` Skill 側でフラグを盛る**: **却下**理由 = 二重メンテ (Skill の中で覚えるフラグ列がある)。CLI 単体使いユーザーも default の悪さに引っかかる。
- **`init` を完全に廃止して `artgraph setup` のみ提供**: **却下**理由 = `init` という名前は npm エコシステムで「最小初期化」の慣習。完全廃止は混乱を招く。

### Source

- ユーザー指摘 (2026-06-27 会話) — 未リリース前提の本質設計
- npm エコシステム慣習: `npm init` / `eslint --init` 等は通常 minimum init

---

## R16. Skills の英語化

### Decision

`templates/skills/**/*.md` (全 7 Skill + `_shared/` 配下) を **完全英語** で書く。フロントマターの `description` だけでなく body も英語。

`docs/skills-guide.md`, `README.md`, `CLAUDE.md` snippet, `AGENTS.md` snippet は **日本語可** (現状の OSS リポの主要読者言語に合わせる)。

### Rationale

- Claude Skills の training data と公式 best practices は英語が主流 ([Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices))
- 英語 description のほうが model invocation triggering が安定する (一般的観察、定量データは未確認だが Anthropic 公式は英語推奨)
- artgraph を Claude Code 以外のエージェント (Cursor / Kiro / API 直叩き) でも使えるようにする方針上、英語化は cross-agent reach を高める
- Skill body はユーザー向けではなくモデル向け (= 人間 contributor の翻訳負担より、モデルの理解精度が重視される)
- リポの主要読者向け docs (skills-guide.md など) は日本語のまま

### Alternatives considered

- **すべて日本語**: **却下**理由 = cross-agent reach が低下、Anthropic 公式ベストプラクティス と乖離
- **すべて英語 (docs も含む)**: **却下**理由 = リポの読者は主に日本語話者で、docs まで英語化すると貢献ハードルが上がる
- **英語版と日本語版を併記**: **却下**理由 = Skill ファイル長が倍増 (Anthropic は 500 行以下推奨) + 同期メンテ負担

### Source

- ユーザー指摘 (2026-06-27 会話) — Skills を英語化
- [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — 英語ベースの推奨
- [anthropic-skills/skill-creator/SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md) — 公式 Skill 実装は英語

---

## まとめ

16 個の設計判断 (R1–R16, ただし R9 OpenSpec は本 spec から外して issue #25 ベースの別 spec へ移管) はすべて一次資料またはユーザー指摘で裏付けられており、Constitution の NON-NEGOTIABLE 原則と整合する。Phase 1 (data-model / contracts / quickstart) は本判断を前提に進行する。
