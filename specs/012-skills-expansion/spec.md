# Feature Specification: Agent-Native Toolkit (Skills / Hooks / Plugin / SDD Integrations)

**Feature Branch**: `docs/skills-expansion`

**Created**: 2026-06-27

**Status**: Draft

**Input**: User description: 「artgraph を Claude Code および周辺 AI エージェント (Kiro, Cursor 等) に対してセットアップ・開発中・検証の全フェーズで『ネイティブ』に動くツールへ昇格させる。issue #98 の Skills 拡充を出発点に、Skills 改修 + Hooks テンプレ配布 + Plugin 配布 + 各 SDD ツール統合改修を 4 フェーズ (P0–P3) で進める。」

**Parent issue**: [#98](https://github.com/ShintaroMorimoto/artgraph/issues/98) — 拡張スコープ追記コメント [#issuecomment-4814340128](https://github.com/ShintaroMorimoto/artgraph/issues/98#issuecomment-4814340128)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — エージェント自己駆動のセットアップ (Priority: P1)

新規プロジェクトでユーザーが Claude Code に「artgraph をこのプロジェクトに入れて」と頼むと、エージェントが 1 ターンで `npm install -D artgraph` → `npx artgraph init` → 既存 SDD ツール検出と統合 → Skills/Hooks 配置までを完了する。ユーザーの追加操作は基本的に同意 (Y/N) のみ。

**Why this priority**: artgraph 体験のエントリーポイント。これが滑らかでないと他のすべての価値 (Plan 時 impact、Verify、Coverage、SDD 統合) が届かない。OSS としての初回導入摩擦は普及の最大ボトルネック。

**Independent Test**: クリーンな TS/JS リポで Claude Code に「artgraph をセットアップして」と依頼し、結果として `.artgraph.json` / `.claude/skills/artgraph-*` / (Spec Kit/Kiro があれば) `.specify/extensions/artgraph/` か `.kiro/steering/artgraph.md` が生成され、`artgraph check` が exit 0 で通ることを確認する。

**Acceptance Scenarios**:

1. **Given** Node 22 以上が入った空の TS プロジェクト (Spec Kit/Kiro なし) で、 **When** ユーザーが Claude Code で「artgraph 入れて」と依頼する、 **Then** エージェントは `artgraph-setup` Skill を発火させ、ユーザーの 1 回の同意で npm install → init → Skills 配置を完了し、その後 `artgraph check` が exit 0 で通る。
2. **Given** `.specify/` が存在するプロジェクト、 **When** ユーザーが「artgraph 入れて」と依頼する、 **Then** エージェントは Spec Kit の検出を報告し、統合 (Spec Kit extension 配備) も同セッション内で完了する。
3. **Given** `.specify/` と `.kiro/` の両方が存在するプロジェクト、 **When** 同様の依頼をする、 **Then** エージェントは両方の SDD ツールの検出を報告し、ユーザーの 1 回の同意で両方の統合を配備する。

---

### User Story 2 — 既存プロジェクトへの SDD 統合の後付け (Priority: P1)

artgraph は導入済だが Spec Kit/Kiro 統合がまだのプロジェクトで、ユーザーが「Spec Kit / Kiro と連携して」と頼むと、エージェントが `artgraph-integrate` Skill を発火し、`artgraph integrate list` → 検出 → 統合配備を 1 ターンで完了する。

**Why this priority**: US1 (新規) と並んで、既存ユーザーが「途中で SDD ツールを入れた」「artgraph を先に入れていた」というパスをカバーする。これも導入摩擦の主要シナリオ。

**Independent Test**: artgraph 導入済かつ Spec Kit 未統合の状態から、エージェント経由で `integrate speckit` を完了し、`.specify/extensions/artgraph/extension.yml` が配備されていることを検証。

**Acceptance Scenarios**:

1. **Given** artgraph 導入済 + Spec Kit 導入済 + 統合未配備、 **When** ユーザーが「Spec Kit と連携して」と依頼する、 **Then** エージェントは `artgraph-integrate` Skill を発火し、`integrate speckit --gate` (ユーザー選択次第) を実行して `.specify/extensions/artgraph/extension.yml` を配備する。
2. **Given** SDD ツール未導入、 **When** ユーザーが「SDD ツールと連携して」と依頼する、 **Then** エージェントは `integrate list` で検出可能ツールゼロを報告し、Spec Kit/Kiro どちらかの導入方法を提示する (artgraph 側からは何も書き換えない)。

---

### User Story 3 — 開発中の自然な Skill 発火 (Priority: P1)

Plan 策定中・実装完了時・進捗確認時・ID リネーム時に、対応する Skill (artgraph-plan / verify / coverage / rename) がエージェントの description マッチで自動発火し、適切な CLI 呼び出しを行う。Skill 自体は短く保たれ、共通の前提チェックは外出しされている。

**Why this priority**: 既存 4 Skills の体験品質を上げる作業で、毎日の開発で artgraph の価値を届ける主経路。description マッチが弱ければ Skill が発火せず存在しないのと同じになる。

**Independent Test**: Skill description の改訂後、Claude Code に「この diff の plan を考えて」「実装完了したのでチェックして」「カバレッジ確認して」と依頼して、それぞれ対応する Skill が発火することを目視確認。Skill ファイルが 100 行以下に収まり、`_shared/install-check.md` を参照していることを静的検証。

**Acceptance Scenarios**:

1. **Given** artgraph + Skills 導入済のリポで diff があり、 **When** ユーザーが「変更の plan を立てて」と依頼する、 **Then** `artgraph-plan` Skill が発火して `artgraph impact --diff --format json` を実行し、結果をエージェントが plan に反映する。
2. **Given** 実装完了状態、 **When** ユーザーが「整合性チェックして」と依頼する、 **Then** `artgraph-verify` Skill が発火して `artgraph check --diff --format text` を実行し、drift / orphan / uncovered の有無を報告する。
3. **Given** Skills 改訂後の repo、 **When** いずれかの Skill SKILL.md を開く、 **Then** 100 行以下で、共通前提 (install 確認) は `_shared/install-check.md` への参照にまとめられている。

---

### User Story 4 — セットアップ時の検証ゲート設置 (Priority: P2)

`npx artgraph init --with-hooks` で `.claude/settings.json` に Stop hook (`artgraph check --gate --diff`) を merge 配備、`--with-agent-context` で CLAUDE.md / AGENTS.md に artgraph スニペットを追記。既存ファイルを破壊せず安全に追記する。

**Why this priority**: Skill (ガイダンス) と Hook (deterministic ゲート) の補完関係を初めて配布できる。これがあると drift がコミット前に止まり、Skills だけの guidance では達成できない強制力が成立する。

**Independent Test**: `--with-hooks` 実行後の `.claude/settings.json` で Stop hook エントリが追加され、既存セクションは保持されていることを diff で確認。意図的に drift を作って `artgraph check --gate --diff` が exit 2 を返すことを E2E で検証。

**Acceptance Scenarios**:

1. **Given** `.claude/settings.json` が存在しない repo、 **When** `npx artgraph init --with-hooks` を実行、 **Then** `.claude/settings.json` が生成され Stop hook が登録される。
2. **Given** 既存の `.claude/settings.json` に Stop hook が無い、 **When** 同コマンドを実行、 **Then** 既存セクションを保持したまま `hooks.Stop` だけが追記される (他のセクションは無変更)。
3. **Given** 既存の `.claude/settings.json` に Stop hook が既存、 **When** 同コマンドを実行、 **Then** 既存 hook を上書きせず警告を出し、ユーザーに手動マージを促す。
4. **Given** 既存の CLAUDE.md がある、 **When** `init --with-agent-context` を実行、 **Then** `<!-- artgraph: BEGIN ... END -->` で囲まれた 30 行以内のスニペットが追記され、既存内容は無変更。

---

### User Story 5 — Kiro での semantic 発火 (Priority: P2)

Kiro 統合の steering ファイルが `inclusion: auto` + 良い `description` で構成され、関連作業時のみ semantic match で発火する。常時 token 消費を回避し、Skills 同等のオンデマンド体験を Kiro でも実現する。

**Why this priority**: 現状 `inclusion` 未指定 (=`always`) の steering は常時 token を消費するため、Kiro ユーザーの context 圧迫源になる。1 行の frontmatter 追加で大きく改善する低コスト・高効果の改修。

**Independent Test**: 改訂後の steering ファイルを Kiro で読み込ませ、(a) 仕様変更や drift 検査と無関係な作業時には注入されないこと、(b) 「artgraph で check」「impact 出して」等の依頼時には注入されること、を目視確認。

**Acceptance Scenarios**:

1. **Given** Kiro IDE で artgraph 統合配備済の repo、 **When** ユーザーが artgraph と無関係な作業を行う、 **Then** Kiro エージェントの context に artgraph steering は注入されない (常時 token 消費なし)。
2. **Given** 同じ環境、 **When** ユーザーが「仕様変更の影響を確認して」「整合性チェックして」等を依頼する、 **Then** steering がセマンティックに match して注入され、エージェントが `artgraph impact` / `artgraph check` を呼ぶ。

---

### User Story 6 — Plugin としての並行配布 (Priority: P3)

`/plugin marketplace add ShintaroMorimoto/artgraph` → `/plugin install artgraph@artgraph-marketplace` の 1 経路で Skills + Hooks bundle が入る。Plugin と npm 配布で **単一 source of truth** が維持され、Skills の編集は両配布チャネルに同時反映される。

**Why this priority**: 配布性の改善で、`init --with-skills` を経ずに Claude Code から直接導入できる経路を提供する。ただし npm 配布で既に最低限の体験は成立するので P1/P2 より優先度低。

**Independent Test**: 別 repo で `/plugin marketplace add ShintaroMorimoto/artgraph` と `/plugin install artgraph@artgraph-marketplace` を実行し、Skills が `~/.claude/plugins/cache/.../skills/` に配置され `/artgraph:check` 等の namespace 経由 invoke が動くことを確認。`templates/skills/artgraph-plan/SKILL.md` を 1 行変更し、両配布物に反映されることを確認。

**Acceptance Scenarios**:

1. **Given** Claude Code v2.1.172 以上が入った別 repo、 **When** `/plugin marketplace add ShintaroMorimoto/artgraph` を実行、 **Then** marketplace が登録される。
2. **Given** 上記後、 **When** `/plugin install artgraph@artgraph-marketplace` を実行、 **Then** Skills + Hooks bundle が `~/.claude/plugins/cache/` に配置される。
3. **Given** artgraph repo で `templates/skills/artgraph-plan/SKILL.md` を 1 行編集して push、 **When** 新規ユーザーが (1)(2) を実行、 **Then** 編集が plugin 配布物にも反映されている (`templates/skills/` 直接参照のため)。

---

### User Story 7 — Spec Kit ワークフローへの組み込み (Priority: P3)

Spec Kit 利用者は `/speckit.tasks` 完了時に `artgraph.scan-reconcile` が自動実行され、`/speckit.implement` 完了時に `artgraph.check-diff` が走る。Spec Kit Issue #2730 (副作用のみ hook の dispatch 信頼性問題) 対策として、`scan-reconcile` コマンドは stdout に 1 行 JSON サマリを返す出力消費型に変更され、確実に dispatch される。

**Why this priority**: 既に `extension.yml` で hook 登録自体は配備されているため改修。具体的には `after_tasks` hook の発火信頼性向上と README フォールバック明文化。重要だが artgraph の中心機能ではなく Spec Kit 側との連携最終調整。

**Independent Test**: Spec Kit ≥ v0.11.0 リポ (実測時は最新 v0.11.9) で `/speckit.tasks` を実行した後、artgraph の最新スキャン結果が stdout で確認できる (= dispatch 成功) ことを E2E で検証。`commands/artgraph.scan-reconcile.md` を読み、出力消費型形式 (1 行 JSON サマリ命令) になっていることを確認。

**Acceptance Scenarios**:

1. **Given** Spec Kit ≥ v0.11.0 導入済かつ artgraph integrate speckit 完了済、 **When** `/speckit.tasks` を実行、 **Then** `artgraph.scan-reconcile` が dispatch され stdout に "Reconciled N nodes" 形式の JSON サマリが返る。
2. **Given** 同環境、 **When** 万一 hook dispatch が失敗した場合、 **Then** ユーザーは `templates/integrate/speckit/README.md` または `commands/artgraph.scan-reconcile.md` の指示に従って `/artgraph.scan-reconcile` を手動で呼び出すフォールバック手段がある。

---

### User Story 8 — Kiro Smart Hook と OpenSpec 統合 (Priority: P3)

- **Kiro**: `.kiro/hooks/artgraph-verify.json` テンプレを追加し、`after_save` (または同等の event) で `artgraph verify --diff` を発火する Smart Hook を提供する。
- **OpenSpec**: 新規 `artgraph integrate openspec` サブコマンドが `openspec/schemas/artgraph/` 配下に community schema (`schema.yaml` + templates) を配備し、`/opsx:apply` の verify ステップで `artgraph check` が組み込まれる。

**Why this priority**: より深い SDD 統合。Kiro の自動 verify と OpenSpec への正式対応で、3 大 SDD ツール (Spec Kit / Kiro / OpenSpec) を横断的にカバーする。P0–P2 の体験が成立したあとに追加で広げる。

**Independent Test**:
- Kiro: `artgraph integrate kiro --with-hooks` 実行後、`.kiro/hooks/artgraph-verify.json` が配備され、ファイル保存時に `artgraph verify --diff` が発火することを確認 (Kiro 内で目視)。
- OpenSpec: `artgraph integrate openspec` 実行後、`openspec/schemas/artgraph/schema.yaml` + templates が配備され、`/opsx:propose --schema artgraph` で change が起こせ、`/opsx:apply` で artgraph check が走ることを確認。

**Acceptance Scenarios**:

1. **Given** Kiro 導入済 + artgraph 既統合、 **When** `artgraph integrate kiro --with-hooks` を実行、 **Then** `.kiro/hooks/artgraph-verify.json` が配備される。
2. **Given** OpenSpec 導入済の repo、 **When** `artgraph integrate openspec` を実行、 **Then** `openspec/schemas/artgraph/schema.yaml` + templates が配備される。
3. **Given** OpenSpec 統合配備済、 **When** `/opsx:apply` を実行、 **Then** verify ステップで `artgraph check` が走り、結果が apply 完了の前提として組み込まれる。

---

### Edge Cases

- **両 SDD ツール並存**: `.specify/` と `.kiro/` 両方が存在する repo で `--integrate auto` は両方の統合を順次配備する (どちらかを優先せず両立)。
- **SDD ツールゼロ**: SDD ツール検出ゼロの repo で `--integrate auto` は no-op (エラーにせずスキップ)。
- **既存 settings.json との衝突**: 既存 Stop hook がある repo で `--with-hooks` は上書きせず警告し、ユーザーに手動マージを促す。
- **既存 CLAUDE.md との衝突**: 既存 CLAUDE.md がある repo で `--with-agent-context` は HTML コメント境界 (`<!-- artgraph: BEGIN ... END -->`) で囲った範囲のみ更新する (既存内容を破壊しない)。
- **Spec Kit hook dispatch 失敗**: `after_tasks` hook が無音 skip した場合 (#2730 系の dispatch 不安定パス) も、`scan-reconcile` コマンドが出力消費型なので確実に発火する。フォールバックとして slash command 手動呼び出しも document する。
- **Plugin install と npm install の競合**: 同一 repo で Plugin install と `init --with-skills` の両方を実行した場合、後者の Skills が `.claude/skills/` (project local) に置かれ、Plugin 経由 Skills は `~/.claude/plugins/cache/` (user-global) に置かれる。Claude Code の優先順位ルール (project local > global) に従う。
- **既存 artgraph 統合の上書き**: 既に artgraph integrate 配備済の repo で同コマンドを再実行した場合、`--force` フラグなしでは no-op (上書き拒否)、`--force` で再配備する (既存挙動を踏襲)。
- **CLAUDE.md / AGENTS.md の差異**: 一方しか存在しない repo では、存在する方のみ更新。両方無ければ CLAUDE.md を新規作成。
- **ネットワーク不通時の `npm install`**: `artgraph-setup` Skill が npm install で失敗した場合、エラーを user に報告して終了 (リトライ判断はユーザーに委ねる)。

## Requirements *(mandatory)*

### Functional Requirements

**Setup & install (US1)**

- **FR-001**: System MUST provide a `artgraph-setup` Skill (under `templates/skills/artgraph-setup/SKILL.md`) whose `description` triggers on user phrases like "install artgraph", "set up artgraph", "add artgraph to this project".
- **FR-002**: The `artgraph-setup` Skill MUST, after a single user consent, execute `npm install -D artgraph` followed by `npx artgraph init --with-skills --integrate auto --with-hooks --with-agent-context` (or equivalent sequence).
- **FR-003**: `npx artgraph init` MUST accept a new option `--integrate auto` that triggers detection (via existing `detectProject()`) and runs `integrate <tool>` for every detected SDD tool without per-tool prompts (one-shot batch integration).
- **FR-004**: `artgraph-setup` Skill MUST verify on completion that `artgraph check` exits 0 (or report the first failure to the user) before declaring success.

**Integrate to existing repos (US2)**

- **FR-005**: System MUST provide a `artgraph-integrate` Skill whose `description` triggers on user phrases like "integrate artgraph with Spec Kit", "wire up Kiro", "set up the SDD integration".
- **FR-006**: The `artgraph-integrate` Skill MUST first run `artgraph integrate list` to enumerate available providers and their detected/undetected status, then propose integration of detected ones (and optionally ask about `--gate`).
- **FR-007**: System MUST provide a `artgraph-detect` Skill that, on phrases like "is artgraph installed", "what's set up here", reports the current artgraph install + integration + skill status (or proposes `artgraph-setup` if absent).

**Skill refactoring (US3)**

- **FR-008**: All 4 existing Skills (`artgraph-plan`, `verify`, `coverage`, `rename`) MUST share their install-check prologue via `templates/skills/_shared/install-check.md` (single source of truth, referenced rather than duplicated).
- **FR-009**: Each refactored SKILL.md MUST be under 100 lines (progressive disclosure: detailed flows go into `references/` or `scripts/` sub-files if needed).
- **FR-010**: Each Skill's frontmatter `description` MUST follow the "third person + what + when + slight push" pattern documented in Anthropic Skills best practices (e.g., "Runs artgraph impact when planning or designing changes. Make sure to use this skill whenever the user is about to make non-trivial edits.").
- **FR-011**: Each Skill's frontmatter MUST declare `allowed-tools` to pre-approve the specific `artgraph` CLI invocations it needs (so users are not re-prompted per call).

**Hooks & agent context (US4)**

- **FR-012**: `artgraph init` MUST accept a `--with-hooks` flag that creates (if absent) or merges (if present) `.claude/settings.json` to add a Stop hook running `npx artgraph check --gate --diff`.
- **FR-013**: The merge MUST preserve all other settings.json content (other hooks, permissions, env vars). On Stop hook conflict, the merge MUST refuse to overwrite, emit a clear diagnostic, and instruct the user on manual merge.
- **FR-014**: `artgraph init` MUST accept a `--with-agent-context` flag that injects an artgraph usage snippet (under 30 lines) bounded by `<!-- artgraph: BEGIN agent context -->` / `<!-- artgraph: END agent context -->` markers into CLAUDE.md and AGENTS.md (or creates CLAUDE.md if neither exists).
- **FR-015**: Re-running `init --with-agent-context` MUST update only the bounded region (idempotent), not duplicate or destroy other content.

**Kiro semantic firing (US5)**

- **FR-016**: `templates/integrate/kiro/artgraph.md` MUST contain frontmatter `inclusion: auto` plus a `description` that captures the steering scope (drift / impact / verification work).

**Plugin distribution (US6)**

- **FR-017**: Repo MUST contain `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` enabling `/plugin marketplace add ShintaroMorimoto/artgraph` + `/plugin install artgraph@artgraph-marketplace`.
- **FR-018**: `.claude-plugin/plugin.json` MUST set `"skills": "./templates/skills/"` so that `templates/skills/` remains the single source of truth (no copy or symlink to a separate `plugins/artgraph/skills/`).
- **FR-019**: The plugin MUST bundle the Stop hook via `hooks/hooks.json` so users who install via `/plugin install` also get the gate hook (using `${CLAUDE_PLUGIN_ROOT}` path expansion).
- **FR-020**: CI MUST run `claude plugin validate .` (or equivalent) on every release so plugin schema integrity is gated alongside npm publish.

**Spec Kit hook reliability (US7)**

- **FR-021**: `templates/integrate/speckit/commands/artgraph.scan-reconcile.md` MUST be output-consuming: the command body MUST instruct the agent to emit exactly one line of JSON summary (e.g., `{"reconciled": N, "drift": M}`) on stdout. This complies with Spec Kit Issue #2730 dispatch-reliability requirements for side-effect-only hooks.
- **FR-022**: `templates/integrate/speckit/README.md` (or a dedicated troubleshooting doc) MUST document the manual fallback `/artgraph.scan-reconcile` for the case where hook dispatch silently skips (i.e., a workaround pattern in line with `bgervin/spec-kit-sync`).
- **FR-023**: `templates/integrate/speckit/extension.yml`'s `requires.speckit_version` MUST be `">=0.11.0"` or later (versions where the full hook wiring is in place per PR #1702/#1886/#2713).

**Kiro Smart Hook & OpenSpec (US8)**

- **FR-024**: `artgraph integrate kiro` MUST accept a `--with-hooks` flag that deploys `.kiro/hooks/artgraph-verify.json` (or directory-equivalent per Kiro current convention) triggering `artgraph verify --diff` on file save.
- **FR-025**: System MUST provide a new subcommand `artgraph integrate openspec` that deploys a community schema bundle (`openspec/schemas/artgraph/schema.yaml` + templates) compatible with OpenSpec's `/opsx:apply` workflow.
- **FR-026**: The OpenSpec schema MUST include an `artgraph check --diff` invocation in the apply verify step so changes that introduce drift / orphans / uncovered references fail the apply gate.

**Cross-cutting**

- **FR-027**: All new and refactored Skills MUST honor the existing constitution (Determinism First, Spec Owns the ID, Boundary of Determinism). No Skill MAY auto-commit lock files, auto-claim `@impl` tags, or write to the artifact graph without explicit `artgraph reconcile` / `rename` invocation.
- **FR-028**: All new functionality MUST be coverable by the existing test stack (vitest). Concretely, `init --with-hooks --with-agent-context --integrate auto`, `integrate openspec`, and Skill template format invariants MUST have integration tests.

### Key Entities

- **Skill (Claude Code Skill)**: a markdown file with YAML frontmatter (`name`, `description`, `allowed-tools`, etc.) that becomes a model-invocable instruction set. Lives under `templates/skills/<slug>/SKILL.md` and is distributed both via npm `init --with-skills` and via Plugin.
- **Integration Provider**: an implementation of the `Provider` interface (see `src/integrate/providers/`) that knows how to detect, install, validate, and uninstall an integration for one SDD tool. Currently `SpecKitProvider`, `KiroProvider`; this spec adds `OpenSpecProvider`.
- **Hook Template**: a JSON or YAML fragment under `templates/hooks/` and `templates/integrate/<tool>/hooks/` that gets merged into Claude Code (`.claude/settings.json`) or Kiro (`.kiro/hooks/*.json`) configuration without destroying existing content.
- **Plugin Manifest**: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` at repo root, enabling Claude Code Plugin distribution that shares Skills source with npm.
- **Agent Context Snippet**: a bounded markdown block injected into `CLAUDE.md` / `AGENTS.md` describing artgraph's contract for AI agents reading the project (`@impl` tags, when to call `impact` / `check`, where Skills live).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New-user "install artgraph" → first successful `artgraph check --gate` passes within **3 user inputs** (1 install consent + at most 2 follow-ups). Measured by manual walkthrough in a clean Vitest project.
- **SC-002**: Each of the 4 existing Skills (`artgraph-plan`, `verify`, `coverage`, `rename`) `SKILL.md` shrinks to **under 100 lines** and the duplicated 9-line install-check prologue is removed across all 4 (replaced by a single reference). Measured by `wc -l` and grep.
- **SC-003**: 100% of Skill descriptions pass a peer-review checklist confirming "third person + what + when + slight push". Measured by reviewer sign-off on the PR.
- **SC-004**: A 1-line edit to `templates/skills/artgraph-plan/SKILL.md` propagates to both (a) `init --with-skills` output and (b) `/plugin install artgraph@artgraph-marketplace` output, without any extra build step. Measured by E2E test.
- **SC-005**: In a Spec Kit ≥ v0.11.0 project, `/speckit.tasks` followed by `/speckit.implement` results in 2 visible artgraph hook dispatches (1 reconcile + 1 check) in **>= 95% of runs** over 20 trials. Measured by smoke-test counter.
- **SC-006**: Kiro steering `artgraph.md` is **not injected** when the user works on artgraph-irrelevant tasks (e.g., README typo fix). Measured by Kiro context inspection.
- **SC-007**: New `artgraph integrate openspec` invocation completes successfully on a clean OpenSpec project and produces a `change` that fails `/opsx:apply` when drift is introduced. Measured by E2E test.
- **SC-008**: After full P0–P3 ship, parent issue #98 is closed without follow-up `/please fix X` issues for at least 30 days post-merge. Measured by issue tracker.
- **SC-009**: CI `claude plugin validate .` passes on every PR that touches `.claude-plugin/` or `templates/skills/`. Measured by CI history.

## Assumptions

- **Target Claude Code version**: ≥ v2.0 (Skills, Plugins, Hooks all GA). plugin-hints (require ≥ v2.1.172) is out of scope, so no hard version dependency for the core flow.
- **Target Spec Kit version**: ≥ **v0.11.0** (the version since which PR #1702 / #1886 / #2713 / #2724 が全て含まれ、全 18 event の hook wiring が揃う; current latest at time of writing is v0.11.9 / 2026-06-26). Versions < 0.11.0 are not actively supported. FR-023 で `requires.speckit_version: ">=0.11.0"` を `extension.yml` に固定する。
- **Target Kiro version**: current public Kiro IDE release as documented at https://kiro.dev/docs (uses `.kiro/steering/`, `.kiro/mcp.json`, `.kiro/hooks/`).
- **Target OpenSpec**: current `Fission-AI/OpenSpec` (uses `openspec/specs/` + `openspec/changes/` + `openspec/schemas/` layout).
- **Node runtime**: Node.js >= 22 (already required by current artgraph; see constitution).
- **Git tracked**: project is in a git repo (already required for `artgraph check --diff`).
- **MCP server**: out of scope for this spec. Cross-agent (Cursor / Windsurf) demand triggers a future spec.
- **plugin-hints**: out of scope. Requires official-marketplace registration which is discretionary per Anthropic.
- **`--integrate auto` semantics**: invokes all *detected* integrations sequentially with `--gate` enabled by default; users who want a different gate posture can re-run with explicit `--no-integrate-gate` or per-tool `integrate <tool>` later.
- **Plugin marketplace path**: `ShintaroMorimoto/artgraph` (the existing GitHub repo) doubles as the marketplace. No separate marketplace repo. Future migration to `anthropics/claude-plugins-community` is a P5 follow-up.
- **Source-of-truth**: `templates/skills/` is the authoritative skill source. Plugin and npm both reference it (plugin via `plugin.json#skills`, npm via `installSkills()` copy). No symlinks (would break under Claude Code's plugin cache copy).
