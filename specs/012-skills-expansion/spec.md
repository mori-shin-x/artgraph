# Feature Specification: Agent-Native Toolkit (Skills / Hooks / Plugin / SDD Integrations)

**Feature Branch**: `docs/skills-expansion`

**Created**: 2026-06-27

**Status**: Draft

**Input**: User description: 「artgraph を Claude Code および周辺 AI エージェント (Kiro, Cursor 等) に対してセットアップ・開発中・検証の全フェーズで『ネイティブ』に動くツールへ昇格させる。issue #98 の Skills 拡充を出発点に、Skills 改修 + Hooks テンプレ配布 + Plugin 配布 + 各 SDD ツール統合改修を 4 フェーズ (P0–P3) で進める。」

**Parent issue**: [#98](https://github.com/ShintaroMorimoto/artgraph/issues/98) — 拡張スコープ追記コメント [#issuecomment-4814340128](https://github.com/ShintaroMorimoto/artgraph/issues/98#issuecomment-4814340128)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — エージェント自己駆動のセットアップ (Priority: P1)

新規プロジェクトでユーザーが Claude Code に「artgraph をこのプロジェクトに入れて」と頼むと、エージェントが 1 ターンで package manager 検出 → install (`npm` / `pnpm` / `yarn` / `bun` / `deno` のいずれか適切なもの) → `artgraph init` (デフォルトで full agent-native setup) → SDD ツール統合・Skills/Hooks/agent-context 配置までを完了する。ユーザーの追加操作は基本的に同意 (Y/N) のみ。

**Why this priority**: artgraph 体験のエントリーポイント。これが滑らかでないと他のすべての価値 (Impact 分析、Verify、Coverage、SDD 統合) が届かない。OSS としての初回導入摩擦は普及の最大ボトルネック。

**Independent Test**: クリーンな TS/JS リポ (npm / pnpm / Bun / Deno いずれの環境でも) で Claude Code に「artgraph をセットアップして」と依頼し、結果として `.artgraph.json` / `.claude/skills/artgraph-*` / `.claude/settings.json` (Stop hook) / `CLAUDE.md` (snippet) / (Spec Kit/Kiro があれば) `.specify/extensions/artgraph/` か `.kiro/steering/artgraph.md` が生成され、`artgraph check` が exit 0 で通ることを確認する。

**Acceptance Scenarios**:

1. **Given** Node 22 以上が入った空の TS プロジェクト (Spec Kit/Kiro なし、`package-lock.json` のみ存在で npm 利用と判定される)、 **When** ユーザーが Claude Code で「artgraph 入れて」と依頼する、 **Then** エージェントは `artgraph-setup` Skill を発火させ、ユーザーの 1 回の同意で `npm install -D artgraph` → `npx artgraph init` (デフォルトで full setup) を実行し、その後 `artgraph check` が exit 0 で通る。
2. **Given** `bun.lockb` が存在するプロジェクト、 **When** 同様の依頼をする、 **Then** エージェントは Bun を検出し `bun install -D artgraph` → `bunx artgraph init` を実行する。
3. **Given** `.specify/` が存在するプロジェクト、 **When** ユーザーが「artgraph 入れて」と依頼する、 **Then** エージェントは Spec Kit の検出を報告し、統合 (Spec Kit extension 配備) も同セッション内で完了する (`init` デフォルトの `--integrate=auto` が動く)。
4. **Given** `.specify/` と `.kiro/` の両方が存在するプロジェクト、 **When** 同様の依頼をする、 **Then** エージェントは両方の SDD ツールの検出を報告し、ユーザーの 1 回の同意で両方の統合を配備する。

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

Impact 分析時 (Plan 策定 / 設計検討 / 影響範囲確認)・実装完了時・進捗確認時・ID リネーム時に、対応する Skill (artgraph-impact [`artgraph-plan` から rename] / verify / coverage / rename) がエージェントの description マッチで自動発火し、適切な CLI 呼び出しを行う。`artgraph-impact` は 3 入力モード (diff / 明示 target / 確認質問) を持ち、Plan の本来の段階 (diff 不要) にも使える設計に修正される。Skill 自体は短く保たれ、共通の前提チェックは外出しされている。

**Why this priority**: 既存 4 Skills の体験品質を上げる作業で、毎日の開発で artgraph の価値を届ける主経路。`artgraph-plan` の現状実装は `--diff` 前提でしか動かず Plan 名と矛盾していたため、`artgraph-impact` にリネーム + 3 経路化することで Plan/設計/影響分析全てをカバーする。description マッチが弱ければ Skill が発火せず存在しないのと同じになる。

**Independent Test**: Skill description の改訂後、Claude Code に「この変更の影響範囲教えて」「REQ-001 に何が依存してる?」「実装完了したのでチェックして」「カバレッジ確認して」と依頼して、それぞれ対応する Skill が発火することを目視確認。Skill ファイルが 100 行以下に収まり、`_shared/install-check.md` を参照していることを静的検証。

**Acceptance Scenarios**:

1. **Given** artgraph + Skills 導入済のリポで diff があり、 **When** ユーザーが「変更の影響範囲を見て」と依頼する、 **Then** `artgraph-impact` Skill (`artgraph-plan` から rename) が発火して `artgraph impact --diff --format json` を実行し、結果をエージェントが分析に反映する。
2. **Given** diff が無い状態のリポ、 **When** ユーザーが「REQ-001 を変更する予定なので影響範囲教えて」と依頼する、 **Then** `artgraph-impact` Skill が発火し、ユーザー発話から REQ-ID (`REQ-001`) を抽出して `artgraph impact REQ-001 --format json` を実行する (= 真の Plan 段階・diff 不要)。
3. **Given** diff も target も無い状態で「impact 出して」とだけ依頼、 **When** Skill が発火する、 **Then** ユーザーに「どの requirement / file を起点に分析しますか?」と確認質問する (空振り終了しない)。
4. **Given** 実装完了状態、 **When** ユーザーが「整合性チェックして」と依頼する、 **Then** `artgraph-verify` Skill が発火して `artgraph check --diff --format text` を実行し、drift / orphan / uncovered の有無を報告する。
5. **Given** Skills 改訂後の repo、 **When** いずれかの Skill SKILL.md を開く、 **Then** 100 行以下で、共通前提 (install 確認) は `_shared/install-check.md` への参照にまとめられている。

---

### User Story 4 — 検証ゲートと agent context の配布 (Priority: P2)

`artgraph init` (デフォルト) または `artgraph init --no-hooks=false` で `.claude/settings.json` に Stop hook (`artgraph check --gate --diff`) を merge 配備、デフォルトで CLAUDE.md / AGENTS.md に artgraph スニペットを追記する。既存ファイルを破壊せず安全に追記する。明示的に hook や agent context を入れたくない場合は `--no-hooks` / `--no-agent-context` で opt-out 可能。

**Why this priority**: Skill (ガイダンス) と Hook (deterministic ゲート) の補完関係を初めて配布できる。これがあると drift がコミット前に止まり、Skills だけの guidance では達成できない強制力が成立する。デフォルト on にすることで「セットアップしたら検証ゲートも当然付いてくる」体験になる。

**Independent Test**: `artgraph init` 実行後の `.claude/settings.json` で Stop hook エントリが追加され、既存セクションは保持されていることを diff で確認。意図的に drift を作って `artgraph check --gate --diff` が exit 2 を返すことを E2E で検証。

**Acceptance Scenarios**:

1. **Given** `.claude/settings.json` が存在しない repo、 **When** `artgraph init` を実行、 **Then** `.claude/settings.json` が生成され Stop hook が登録される。
2. **Given** 既存の `.claude/settings.json` に Stop hook が無い、 **When** 同コマンドを実行、 **Then** 既存セクションを保持したまま `hooks.Stop` だけが追記される (他のセクションは無変更)。
3. **Given** 既存の `.claude/settings.json` に Stop hook が既存、 **When** 同コマンドを実行、 **Then** 既存 hook を上書きせず警告を出し、ユーザーに手動マージを促す (ユーザーデータ保護)。
4. **Given** 既存の CLAUDE.md がある、 **When** `artgraph init` (agent-context もデフォルト ON) を実行、 **Then** `<!-- artgraph: BEGIN ... END -->` で囲まれた 30 行以内のスニペットが追記され、既存内容は無変更。
5. **Given** `artgraph init --minimal` を実行、 **When** 同 repo で `.claude/settings.json` を確認、 **Then** Stop hook は **登録されない** (bare config モードでは hook を配布しない)。

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

### User Story 8 — Kiro Smart Hook (Priority: P3)

`.kiro/hooks/artgraph-verify.json` テンプレを追加し、`after_save` (または同等の event) で `artgraph verify --diff` を発火する Smart Hook を提供する。Kiro エージェントが手動で `artgraph` を呼ばなくても、ファイル保存のたびに整合性が継続検証される。

**Why this priority**: Kiro の自動 verify 経路を完成させ、Steering (semantic 発火) と Smart Hook (event 駆動) を補完関係で配備する。

**Note**: OpenSpec 統合は別 spec (issue [#25](https://github.com/ShintaroMorimoto/artgraph/issues/25) ベース) で扱う。理由は OpenSpec 対応が「artgraph CLI コア層の改修 (`### Requirement: <name>` パーサ、`<domain>/slug(name)` ID 派生モデル、`openspec/changes/` のデルタライフサイクル、サイドカー ID、`migrate-id` コマンド)」を本質的に要求するため、本 spec の配布物層の作業とは性質が違う。本 spec から外し、issue #25 の設計検討に沿った別 spec として進める。

**Independent Test**: `artgraph integrate kiro --with-hooks` 実行後、`.kiro/hooks/artgraph-verify.json` が配備され、ファイル保存時に `artgraph verify --diff` が発火することを確認 (Kiro 内で目視)。

**Acceptance Scenarios**:

1. **Given** Kiro 導入済 + artgraph 既統合、 **When** `artgraph integrate kiro --with-hooks` を実行、 **Then** `.kiro/hooks/artgraph-verify.json` が配備される。
2. **Given** 同環境、 **When** Kiro 内でファイルを編集して保存する、 **Then** Smart Hook が発火し `artgraph verify --diff` の結果がエージェントに報告される。

---

### Edge Cases

- **両 SDD ツール並存**: `.specify/` と `.kiro/` 両方が存在する repo で `init` (デフォルト `--integrate=auto` 相当) は両方の統合を順次配備する (どちらかを優先せず両立)。
- **SDD ツールゼロ**: SDD ツール検出ゼロの repo で `--integrate=auto` は no-op (エラーにせずスキップ)。
- **既存 settings.json との衝突**: 既存 Stop hook がある repo で hook 注入は上書きせず警告し、ユーザーに手動マージを促す (ユーザーデータ保護のため)。
- **既存 CLAUDE.md との衝突**: 既存 CLAUDE.md がある repo で agent context 注入は HTML コメント境界 (`<!-- artgraph: BEGIN ... END -->`) で囲った範囲のみ更新する (既存内容を破壊しない)。
- **Spec Kit hook dispatch 失敗**: `after_tasks` hook が無音 skip した場合 (#2730 系の dispatch 不安定パス) も、`scan-reconcile` コマンドが出力消費型なので確実に発火する。フォールバックとして slash command 手動呼び出しも document する。
- **Plugin install と npm install の併用**: 同一 repo で Plugin install と `init` の両方を実行した場合、後者の Skills が `.claude/skills/` (project local) に置かれ、Plugin 経由 Skills は `~/.claude/plugins/cache/` (user-global) に置かれる。Claude Code の優先順位ルール (project local > global) に従う。
- **既存 artgraph 統合の重複適用**: artgraph integrate 配備済の repo で同コマンドを再実行した場合、`--force` フラグなしでは no-op (ユーザーが意図的に作成・編集したファイルを保護)、`--force` で再配備する。
- **CLAUDE.md / AGENTS.md の差異**: 一方しか存在しない repo では、存在する方のみ更新。両方無ければ CLAUDE.md を新規作成。
- **`artgraph-setup` で `npm`/`bun`/`deno`/`pnpm`/`yarn` 混在**: lockfile (`bun.lockb` / `deno.lock` / `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`) または `package.json#packageManager` を見て、適切な install/exec コマンドを構築する。検出ゼロは npm 既定。
- **ネットワーク不通時の `<pkg-mgr> install`**: `artgraph-setup` Skill が install で失敗した場合、stderr を user に報告して終了 (リトライ判断はユーザーに委ねる)。
- **`artgraph-impact` で diff も target もない**: ユーザー発話に REQ-ID/ファイルパス指定がなく git diff も空の場合、Skill は「どの requirement / file を起点に分析しますか?」と確認質問を出す (空振りで終了しない)。

## Requirements *(mandatory)*

### Functional Requirements

**Setup & install (US1)**

- **FR-001**: System MUST provide a `artgraph-setup` Skill (under `templates/skills/artgraph-setup/SKILL.md`) whose `description` triggers on user phrases like "install artgraph", "set up artgraph", "add artgraph to this project".
- **FR-002**: The `artgraph-setup` Skill MUST, after a single user consent, execute the install + init sequence appropriate to the detected package manager (FR-026), then complete the full agent-native setup in one turn.
- **FR-003**: `artgraph init` (with no flags) MUST default to the **full agent-native setup**: Skills install + auto SDD integration + Stop hook merge + CLAUDE.md/AGENTS.md snippet injection. `artgraph init --minimal` MUST opt out to **bare config generation only** (`.artgraph.json` and nothing else). Individual opt-out flags (`--no-skills`, `--no-integrate`, `--no-hooks`, `--no-agent-context`) MUST also be supported for partial configurations.
- **FR-004**: `artgraph-setup` Skill MUST verify on completion that `artgraph check` exits 0 (or report the first failure to the user) before declaring success.
- **FR-026**: `artgraph-setup` Skill MUST detect the project's package manager from lockfile presence (`bun.lockb` → Bun, `deno.json`/`deno.lock` → Deno, `pnpm-lock.yaml` → pnpm, `yarn.lock` → Yarn, `package-lock.json` → npm) or `package.json#packageManager` field, and construct install/exec commands accordingly (e.g., `bun install -D artgraph && bunx artgraph init` for Bun, `pnpm add -D artgraph && pnpm exec artgraph init` for pnpm). Detection-miss MUST default to npm. (Wider package-manager-agnostic rewrites of Stop hook templates, Skill body samples, README, and Plugin hook are scoped to a follow-up issue.)

**Integrate to existing repos (US2)**

- **FR-005**: System MUST provide a `artgraph-integrate` Skill whose `description` triggers on user phrases like "integrate artgraph with Spec Kit", "wire up Kiro", "set up the SDD integration".
- **FR-006**: The `artgraph-integrate` Skill MUST first run `artgraph integrate list` to enumerate available providers and their detected/undetected status, then propose integration of detected ones (and optionally ask about `--gate`).
- **FR-007**: System MUST provide a `artgraph-detect` Skill that, on phrases like "is artgraph installed", "what's set up here", reports the current artgraph install + integration + skill status (or proposes `artgraph-setup` if absent).

**Skill refactoring (US3)**

- **FR-008**: All 4 existing Skills (`artgraph-impact` [renamed from `artgraph-plan` — see FR-025], `verify`, `coverage`, `rename`) MUST share their install-check prologue via `templates/skills/_shared/install-check.md` (single source of truth, referenced rather than duplicated).
- **FR-009**: Each refactored SKILL.md MUST be under 100 lines (progressive disclosure: detailed flows go into `references/` or `scripts/` sub-files if needed).
- **FR-010**: Each Skill's frontmatter `description` MUST follow the "third person + what + when + slight push" pattern documented in Anthropic Skills best practices (e.g., "Runs artgraph impact when planning or designing changes. Make sure to use this skill whenever the user is about to make non-trivial edits.").
- **FR-011**: Each Skill's frontmatter MUST declare `allowed-tools` to pre-approve the specific `artgraph` CLI invocations it needs (so users are not re-prompted per call).
- **FR-029**: Every SKILL.md MUST be authored entirely in English (both YAML frontmatter `description` and markdown body). This applies to the 3 new Skills (`artgraph-setup`, `artgraph-integrate`, `artgraph-detect`) and the 4 refactored Skills (`artgraph-impact` [renamed from `artgraph-plan`], `verify`, `coverage`, `rename`). Rationale: (a) Claude Skills training data and best practices documentation are predominantly English, increasing model invocation reliability for English-authored descriptions; (b) artgraph is being positioned as an OSS for the broader AI-coding ecosystem (Claude Code, Cursor, Kiro, etc.) where English is the lingua franca; (c) Skill bodies are read by the model, not human contributors who would prefer their native language. Project-level docs (`docs/skills-guide.md`, `README.md` sections, `CLAUDE.md` snippet, `AGENTS.md` snippet) MAY remain in Japanese to serve the maintainer's primary audience, but the Skill source itself stays English.
- **FR-025**: The `artgraph-plan` Skill MUST be renamed to **`artgraph-impact`** (Skill file path: `templates/skills/artgraph-impact/SKILL.md`). The renamed Skill MUST support three input modes: (a) when staged/unstaged changes exist, call `artgraph impact --diff`; (b) when the user's request mentions REQ-IDs or file paths, extract them and call `artgraph impact <targets>`; (c) when neither (a) nor (b) applies, ask the user "which requirement(s) or file(s) do you want analyzed?" and run mode (b) with the answer. The Skill description must reflect that it is invoked at planning / design / impact-analysis time, regardless of whether changes have started.

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

**Kiro Smart Hook (US8)**

- **FR-024**: `artgraph integrate kiro` MUST accept a `--with-hooks` flag that deploys `.kiro/hooks/artgraph-verify.json` (or directory-equivalent per Kiro current convention) triggering `artgraph verify --diff` on file save.

> **OpenSpec integration (`integrate openspec` + community schema + parser + sidecar ID + changes/ lifecycle + `migrate-id`) is OUT OF SCOPE for this spec.** It is being tracked separately as issue [#25](https://github.com/ShintaroMorimoto/artgraph/issues/25) and will be addressed in a dedicated future spec (likely `013-openspec-support` or similar). The reason: OpenSpec needs CLI core changes (heading-based parser, slug-derived IDs, changes/ delta lifecycle awareness), not just configuration distribution.

**Cross-cutting**

- **FR-027**: All new and refactored Skills MUST honor the existing constitution (Determinism First, Spec Owns the ID, Boundary of Determinism). No Skill MAY auto-commit lock files, auto-claim `@impl` tags, or write to the artifact graph without explicit `artgraph reconcile` / `rename` invocation.
- **FR-028**: All new functionality MUST be coverable by the existing test stack (vitest). Concretely, default `artgraph init` (full agent-native setup), `artgraph init --minimal`, Skill template format invariants, `artgraph-impact` 3-mode behavior, and package manager detection MUST have integration tests.

### Key Entities

- **Skill (Claude Code Skill)**: a markdown file with YAML frontmatter (`name`, `description`, `allowed-tools`, etc.) that becomes a model-invocable instruction set. Lives under `templates/skills/<slug>/SKILL.md` and is distributed both via the default `artgraph init` and via Plugin. The 7 Skills shipped in this spec: `artgraph-setup`, `artgraph-integrate`, `artgraph-detect`, `artgraph-impact` (renamed from `artgraph-plan`), `artgraph-verify`, `artgraph-coverage`, `artgraph-rename`.
- **Integration Provider**: an implementation of the `Provider` interface (see `src/integrate/providers/`) that knows how to detect, install, validate, and uninstall an integration for one SDD tool. Currently `SpecKitProvider` and `KiroProvider`. `OpenSpecProvider` is OUT OF SCOPE (issue [#25](https://github.com/ShintaroMorimoto/artgraph/issues/25), separate spec).
- **Package Manager Detector**: a utility (used inside `artgraph-setup` Skill) that inspects lockfiles and `package.json#packageManager` to determine which package manager (npm / pnpm / Yarn / Bun / Deno) to use for install and exec commands.
- **Hook Template**: a JSON or YAML fragment under `templates/hooks/` and `templates/integrate/<tool>/hooks/` that gets merged into Claude Code (`.claude/settings.json`) or Kiro (`.kiro/hooks/*.json`) configuration without destroying existing content.
- **Plugin Manifest**: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` at repo root, enabling Claude Code Plugin distribution that shares Skills source with the default `artgraph init`.
- **Agent Context Snippet**: a bounded markdown block injected into `CLAUDE.md` / `AGENTS.md` describing artgraph's contract for AI agents reading the project (`@impl` tags, when to call `impact` / `check`, where Skills live).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New-user "install artgraph" → first successful `artgraph check --gate` passes within **3 user inputs** (1 install consent + at most 2 follow-ups). Measured by manual walkthrough in a clean Vitest project across all 5 supported package managers (npm / pnpm / Yarn / Bun / Deno).
- **SC-002**: Each of the 4 existing Skills (`artgraph-impact` [renamed from `artgraph-plan`], `verify`, `coverage`, `rename`) `SKILL.md` shrinks to **under 100 lines** and the duplicated 9-line install-check prologue is removed across all 4 (replaced by a single reference). Measured by `wc -l` and grep.
- **SC-003**: 100% of Skill descriptions pass a peer-review checklist confirming "third person + what + when + slight push". Measured by reviewer sign-off on the PR.
- **SC-004**: A 1-line edit to `templates/skills/artgraph-impact/SKILL.md` propagates to both (a) default `artgraph init` output and (b) `/plugin install artgraph@artgraph-marketplace` output, without any extra build step. Measured by E2E test.
- **SC-005**: In a Spec Kit ≥ v0.11.0 project, `/speckit.tasks` followed by `/speckit.implement` results in 2 visible artgraph hook dispatches (1 reconcile + 1 check) in **>= 95% of runs** over 20 trials. Measured by smoke-test counter.
- **SC-006**: Kiro steering `artgraph.md` is **not injected** when the user works on artgraph-irrelevant tasks (e.g., README typo fix). Measured by Kiro context inspection.
- **SC-007**: `artgraph-impact` Skill correctly invokes one of three input modes (diff / target / ask) in 100% of test scenarios. Specifically: diff-present → `--diff`, diff-empty + user mentions REQ-ID → `<target>`, neither → confirmation question. Measured by Skill firing tests.
- **SC-008**: After full P0–P3 ship, parent issue #98 is closed without follow-up `/please fix X` issues for at least 30 days post-merge. Measured by issue tracker.
- **SC-009**: CI `claude plugin validate .` passes on every PR that touches `.claude-plugin/` or `templates/skills/`. Measured by CI history.
- **SC-010**: `artgraph-setup` Skill successfully completes (npm install equivalent + `init` + Skills available) on test fixtures for **all 5 package managers** (npm / pnpm / Yarn / Bun / Deno). Measured by 5 E2E fixture tests, one per package manager.

## Assumptions

- **Target Claude Code version**: ≥ v2.0 (Skills, Plugins, Hooks all GA). plugin-hints (require ≥ v2.1.172) is out of scope, so no hard version dependency for the core flow.
- **Target Spec Kit version**: ≥ **v0.11.0** (the version since which PR #1702 / #1886 / #2713 / #2724 が全て含まれ、全 18 event の hook wiring が揃う; current latest at time of writing is v0.11.9 / 2026-06-26). Versions < 0.11.0 are not actively supported. FR-023 で `requires.speckit_version: ">=0.11.0"` を `extension.yml` に固定する。
- **Target Kiro version**: current public Kiro IDE release as documented at https://kiro.dev/docs (uses `.kiro/steering/`, `.kiro/mcp.json`, `.kiro/hooks/`).
- **artgraph is pre-release**: no backwards compatibility is preserved with prior `init` flag conventions, Skill file layout, or default behaviors. Every design decision is made on technical merit alone.
- **Default `init` behavior**: zero-argument `artgraph init` now triggers the **full agent-native setup** (Skills + auto SDD integration + Stop hook + agent context snippet). Users wanting bare config use `artgraph init --minimal`. Individual opt-out flags (`--no-skills`, `--no-integrate`, `--no-hooks`, `--no-agent-context`) are also supported.
- **Package manager**: artgraph CLI itself is published as an npm package, but install/exec commands generated by `artgraph-setup` Skill adapt to npm / pnpm / Yarn / Bun / Deno based on detected lockfile or `package.json#packageManager`. Fallback is npm. Wider rewrites (Stop hook templates, README examples, Plugin hook) to be fully package-manager-agnostic are tracked in a follow-up issue.
- **Git tracked**: project is in a git repo (already required for `artgraph check --diff` and `artgraph-impact` mode (a) `--diff`).
- **MCP server**: out of scope for this spec. Cross-agent (Cursor / Windsurf / Kiro Custom Agents) demand triggers a future spec.
- **plugin-hints**: out of scope. Requires official-marketplace (anthropics/claude-plugins-official) registration which is discretionary per Anthropic.
- **OpenSpec integration**: out of scope for this spec. Tracked separately as issue [#25](https://github.com/ShintaroMorimoto/artgraph/issues/25) and slated for a dedicated spec (`013-openspec-support` or similar). OpenSpec requires CLI core changes (heading-based parser, `<domain>/slug(name)` ID derivation, `openspec/changes/` delta lifecycle, sidecar ID file, `migrate-id` command, 3 OpenSpec-specific Skills) that fall outside the configuration-distribution scope of this spec.
- **`--integrate=auto` semantics**: invokes all *detected* integrations sequentially with `--gate` enabled by default; users who want a different gate posture can re-run with explicit `--no-integrate-gate` or per-tool `integrate <tool>` later. `auto` is the default value when `init` is invoked with no flags.
- **Plugin marketplace path**: `ShintaroMorimoto/artgraph` (the existing GitHub repo) doubles as the marketplace via `.claude-plugin/marketplace.json` at repo root (self-marketplace pattern — no application required, immediately distributable). Future submission to `anthropics/claude-plugins-community` (open submission form, automated validator + safety screening) is a P5 follow-up. Official marketplace `anthropics/claude-plugins-official` is invitation-only and not targeted.
- **Source-of-truth**: `templates/skills/` is the authoritative skill source. Plugin and the default `artgraph init` both reference it (plugin via `plugin.json#skills`, `init` via `installSkills()` copy). No symlinks (would break under Claude Code's plugin cache copy).
