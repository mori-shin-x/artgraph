---

description: "Task list for 012-skills-expansion — Agent-Native Toolkit"
---

# Tasks: Agent-Native Toolkit (Skills / Hooks / Plugin / SDD Integrations)

**Input**: Design documents from `/specs/012-skills-expansion/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Tests are **REQUIRED** (TDD per user guidance). Each implementation task is preceded by its test task.

**Organization**: Phases map 1-to-1 to PR units (PR-A/B/C/D) so each can be merged independently. Within each PR phase, tasks are ordered by dependency.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps task to user story (US1, US2, US3, US4, US5, US6, US7, US8) — required for Phase 3+ tasks
- Include exact file paths in descriptions

## Path Conventions

Single project (per [plan.md](./plan.md) Project Structure):
- Source: `src/`
- Tests: `tests/`
- Templates: `templates/`
- Plugin manifest: `.claude-plugin/`
- Plugin Stop hook: `hooks/`
- Repo root: `/home/morimoto-s1/skills-expansion/` (worktree)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Pre-flight checks before any implementation.

- [ ] T001 Verify dev environment: Node >= 22 active (`node -v`), pnpm available, working tree clean (`git status`), on branch `docs/skills-expansion`, `.specify/feature.json` points to `specs/012-skills-expansion`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared changes that all P0 user stories depend on. MUST complete before Phase 3 begins.

**⚠️ CRITICAL**: All P0 user story (US1 / US2 / US3) work depends on these tasks.

- [ ] T002 Refactor `installSkills()` in `src/init.ts` to handle both legacy flat-file Skills (`templates/skills/<name>.md`) and new directory-format Skills (`templates/skills/<name>/SKILL.md`). Walk `templates/skills/` recursively, copy `_shared/` and each `<name>/SKILL.md` (or legacy `<name>.md`) into `.claude/skills/`. Preserve `references/` and `scripts/` sub-folders within Skill directories
- [ ] T003 [P] Create `templates/skills/_shared/install-check.md` — common artgraph CLI install-check procedure referenced by all Skills (DRY out the duplicated 9-line block currently in 4 Skills). 30 lines max. Format: short markdown with shell snippets (FR-008, R2)
- [ ] T004 [P] Create `templates/skills/_shared/output-schema.md` — short reference of `artgraph impact|check|coverage|rename --format json` output shapes, linked from Skills that consume JSON (R2)

**Checkpoint**: Foundation ready — Phase 3 can begin.

---

## Phase 3: P0 — Skills 拡充 (US1 + US2 + US3) 🎯 MVP / PR-A

**Goal**: issue #98 直接対応。エージェント自己駆動セットアップ・既存リポへの後付け統合・既存 4 Skill の DRY 化を一括で完成させる。

**Independent Test**: [quickstart.md](./quickstart.md) US1 / US2 / US3 全シナリオ通過。`tests/skills-templates.test.ts` で全 7 Skill が frontmatter / 100 行 / `_shared` 参照規約に合致。

**PR target**: PR-A (issue #98 close 単位)

### Tests for Phase 3 (TDD) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation in Phase 3**

- [ ] T005 [P] [US3] Write `tests/skills-templates.test.ts` — メタテストで全 SKILL.md を walk: (a) frontmatter に `name` `description` 必須、(b) `name === directory name`、(c) description ≤ 1024 chars、(d) body ≤ 100 行、(e) 4 既存 Skill が `_shared/install-check.md` への markdown link を含む、(f) `allowed-tools` 配列要素が `<Name>(...)` 形式、(g) 全 Skill description が unique (FR-008, FR-009, FR-010, FR-011, FR-028 — Skill template format invariants)
- [ ] T006 [P] [US1] Extend `tests/init.test.ts` — `--integrate=auto` フラグ追加: (a) SDD ツール検出ゼロで no-op (exit 0)、(b) Spec Kit のみ検出で speckit integrate 実行、(c) Spec Kit + Kiro 両方で両方 integrate、(d) `--integrate=auto` と `--integrate=speckit,kiro` の同時指定はエラー (FR-003, FR-028 — --integrate auto coverage, R11)
- [ ] T007 [P] [US3] Write `tests/integrate-cli.test.ts` の `integrate list` カバレッジ拡張 — 出力に既存 provider (speckit, kiro) + 将来追加分 (openspec は Phase 6 で追加) が含まれること、`detected` / `installed` フィールドが正しいこと (FR-006)

### Implementation for Phase 3

#### CLI フラグ追加 (US1)

- [ ] T008 [US1] Add `--integrate auto` special value to `init` in `src/cli.ts` (commander option definition + validation: `--integrate=auto` と `--integrate=<csv>` の同時指定エラー)
- [ ] T009 [US1] Implement auto-detect-and-integrate logic in `src/init.ts` — `--integrate=auto` 時に `detectProject()` を呼んで検出された全 provider に `runIntegrate()` を順次実行。検出ゼロは no-op。`--integrate-gate` (デフォルト true) を尊重 (FR-003, R11)

#### 既存 4 Skill のディレクトリ化 + リライト (US3)

- [ ] T010 [P] [US3] Migrate `templates/skills/artgraph-plan.md` → `templates/skills/artgraph-plan/SKILL.md`. 100 行以下に短縮。冒頭の install 確認ブロックを `[install-check](../_shared/install-check.md) を参照` に置換。frontmatter の `description` を [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md) の `artgraph-plan` 行 (English, third person + push) に更新。`allowed-tools: ["Bash(npx artgraph *)", "Bash(artgraph *)"]` を追加 (FR-008, FR-009, FR-010, FR-011, R10)
- [ ] T011 [P] [US3] Migrate `templates/skills/artgraph-verify.md` → `templates/skills/artgraph-verify/SKILL.md` (T010 と同じ規約: FR-008, FR-009, FR-010, FR-011, R10)
- [ ] T012 [P] [US3] Migrate `templates/skills/artgraph-coverage.md` → `templates/skills/artgraph-coverage/SKILL.md` (T010 と同じ規約: FR-008, FR-009, FR-010, FR-011, R10)
- [ ] T013 [P] [US3] Migrate `templates/skills/artgraph-rename.md` → `templates/skills/artgraph-rename/SKILL.md` + `references/lifecycle-flows.md` (split/merge の詳細手順を分離して SKILL.md を 100 行以下に保つ progressive disclosure。FR-008, FR-009, FR-010, FR-011, R10)
- [ ] T014 [US3] Delete legacy flat files `templates/skills/artgraph-{plan,verify,coverage,rename}.md` (T010–T013 完了後)。同時に `installSkills()` のレガシー path 対応コード (T002 で残した互換層) を削除し、ディレクトリ形式のみサポートに簡素化

#### 新規 Skill 追加 (US1, US2)

- [ ] T015 [P] [US1] Create `templates/skills/artgraph-setup/SKILL.md` — description は [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md) の `artgraph-setup` 行。本文は: (a) install 確認 (`_shared/install-check.md` 参照)、(b) ユーザー同意取得、(c) `npm install -D artgraph` 実行、(d) `npx artgraph init --with-skills --integrate=auto --with-hooks --with-agent-context` 実行 (※ `--with-hooks` `--with-agent-context` は Phase 4 で実装されるため、現時点では `--with-skills --integrate=auto` まで)、(e) `artgraph check` で成功確認、(f) **`npm install` がネットワーク不通等で失敗した場合は stderr を user に報告して終了 — リトライ判断はユーザーに委ねる** (EC9 対応) (FR-001, FR-002, FR-004, R10)。`allowed-tools: ["Bash(npm install*)", "Bash(npx artgraph *)", "Bash(artgraph *)"]`
- [ ] T016 [P] [US2] Create `templates/skills/artgraph-integrate/SKILL.md` — description は contracts 通り。本文: (a) install 確認、(b) `artgraph integrate list` 実行で利用可能 provider 一覧、(c) 検出済 provider への integrate を提案 (per-tool で `--gate` 採否を確認)、(d) `artgraph integrate <tool>` 実行 (FR-005, FR-006, R10)。`allowed-tools: ["Bash(npx artgraph *)", "Bash(artgraph *)"]`
- [ ] T017 [P] [US2] Create `templates/skills/artgraph-detect/SKILL.md` — description は contracts 通り。本文: (a) `command -v artgraph` で CLI 確認、(b) 未導入なら `artgraph-setup` 提案、(c) 導入済なら `.artgraph.json` / `.specify/extensions/artgraph/` / `.kiro/steering/artgraph.md` / `openspec/schemas/artgraph/` / `.claude/skills/artgraph-*` の存在を確認して要約 (FR-007, R10)。`allowed-tools: ["Bash(npx artgraph *)", "Bash(artgraph *)", "Bash(ls *)", "Bash(test *)"]`

#### ドキュメント (US1, US2, US3)

- [ ] T018 [P] [US3] Update `docs/skills-guide.md` — 既存 4 Skill のセクションは内容変わらず参照パスを `.claude/skills/<name>/SKILL.md` 形式に更新。冒頭の「セットアップ」節を `artgraph-setup` 経由のフローに置換。「Skills 一覧」を 7 つに拡張 (artgraph-{setup, integrate, detect, plan, verify, coverage, rename})。各 Skill description 文面を [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md) と同期 (FR-008 — DRY な docs)
- [ ] T019 [P] [US1] Update root `README.md` — "Claude Code skills" 節を新 Skill 含めて更新。Quickstart の冒頭に「Claude Code エージェントで artgraph をセットアップする」案内を追加 (`/artgraph-setup` で 1 コマンド完結)

**Checkpoint Phase 3**: P0 完了。`pnpm test` + `pnpm test:e2e` 通過。[quickstart.md](./quickstart.md) US1 / US2 / US3 を手動で走らせて成功。PR-A を出して issue #98 を close。

---

## Phase 4: P1 — Hooks + Agent Context + Kiro inclusion auto (US4 + US5) / PR-B

**Goal**: 検証ゲートと AI エージェント context を配布物に組み込み、Kiro での semantic 発火に切り替える。

**Independent Test**: [quickstart.md](./quickstart.md) US4 (4 case の settings.json merge + CLAUDE.md 注入) と US5 (Kiro inclusion auto) 全シナリオ通過。

**PR target**: PR-B

### Tests for Phase 4 (TDD) ⚠️

- [ ] T020 [P] [US4] Write `tests/hooks-merge.test.ts` — 4 cases per [contracts/settings-merge.md](./contracts/settings-merge.md): (A) settings.json なし、(B) `{}`、(C) 他 hook あり Stop なし、(D) Stop hook 衝突 (exit 1)。`--force` を渡しても Case D で上書きしないことを assert (FR-012, FR-013, FR-028 — --with-hooks, R4)
- [ ] T021 [P] [US4] Write `tests/agent-context-injection.test.ts` — (a) CLAUDE.md なしで作成、(b) 既存 CLAUDE.md に追記、(c) マーカー既存で更新、(d) 2 回実行で idempotent (diff なし)、(e) AGENTS.md にも同等動作、(f) スニペットが 30 行以下 (FR-014, FR-015, FR-028 — --with-agent-context, R3)

### Implementation for Phase 4

#### テンプレファイル (US4)

- [ ] T022 [P] [US4] Create `templates/hooks/settings.json.template` — 内容は [data-model.md](./data-model.md) E3 + [contracts/settings-merge.md](./contracts/settings-merge.md) の入力ソース節通り (Stop hook で `npx artgraph check --gate --diff` を登録)
- [ ] T023 [P] [US4] Create `templates/hooks/pre-commit.sh.template` — husky/lefthook 利用者向けの参考スクリプト (本体は `npx artgraph check --gate --diff` を実行)。任意配布で、現フェーズでは `--with-hooks` から自動配置しない (将来の `--with-precommit` 用テンプレ予約)
- [ ] T024 [P] [US4] Create `templates/agent-context/claude-md-snippet.md` — 30 行以下。`<!-- artgraph: BEGIN agent context -->` / `<!-- artgraph: END agent context -->` で囲った内容。Skills の使い方、`@impl` 文法、`artgraph impact` / `check` の呼びどころ、Skills 配置場所の 4 点を簡潔に (FR-014, R3, [data-model.md](./data-model.md) E5)
- [ ] T025 [P] [US4] Create `templates/agent-context/agents-md-snippet.md` — 同上スニペット (OpenSpec / Kiro / 他エージェント共通プロトコル AGENTS.md 用)

#### `installHooks()` 実装 (US4)

- [ ] T026 [US4] Implement `installHooks(targetDir)` in `src/init.ts` per [contracts/settings-merge.md](./contracts/settings-merge.md) implementation guide. Case A/B/C は merge して exit 0、Case D は警告 + exit 1。 `--force` 不問 (settings.json merge は常に fail-on-conflict、R4)
- [ ] T027 [US4] Implement `installAgentContext(targetDir)` in `src/init.ts` — CLAUDE.md / AGENTS.md のターゲットファイル走査、HTML マーカー検出、idempotent 注入。両ファイル無ければ CLAUDE.md を新規作成 (FR-015, R3)

#### CLI フラグ wire-up (US4)

- [ ] T028 [US4] Add `--with-hooks` and `--with-agent-context` options to `init` in `src/cli.ts` (commander definitions). `runInit()` で T026 / T027 を呼ぶ ([contracts/cli-flags.md](./contracts/cli-flags.md))
- [ ] T029 [US4] Update `templates/skills/artgraph-setup/SKILL.md` (Phase 3 で作成済) の本文を、Phase 4 で実装した `--with-hooks --with-agent-context` を含む完全な init 引数列に更新 (FR-002 完全形)

#### Kiro steering 改修 (US5)

- [ ] T030 [P] [US5] Edit `templates/integrate/kiro/artgraph.md` — 冒頭に frontmatter `---\ninclusion: auto\ndescription: "Use when checking drift between specs/design/tasks/code, before approving an implementation step, or when running impact analysis."\n---` を追加。本文は変更なし (FR-016, R8)
- [ ] T031 [US5] Update `examples/kiro-integration/README.md` — `inclusion: auto` 採用の説明を 1 段落追加 (常時 token 消費の回避メリットと、関連作業時のみ発火する旨)

**Checkpoint Phase 4**: P1 完了。`pnpm test` 通過 ([quickstart.md](./quickstart.md) US4 + US5 手動検証通過)。PR-B を出してマージ。

---

## Phase 5: P2 — Plugin マニフェスト配布 (US6) / PR-C

**Goal**: `.claude-plugin/` 配下に marketplace + plugin manifest を配置し、`/plugin install artgraph@artgraph-marketplace` 経路で skills + hooks bundle を入手できるようにする。

**Independent Test**: [quickstart.md](./quickstart.md) US6 全シナリオ通過 (別 repo での install、source-of-truth 同期検証、CI validator pass)。

**PR target**: PR-C

### Tests for Phase 5 (TDD) ⚠️

- [ ] T032 [P] [US6] Write `tests/plugin-manifest.test.ts` per [contracts/plugin-manifest.md](./contracts/plugin-manifest.md) CI 検証節: (1) plugin.json が valid JSON、(2) `name === "artgraph"`、(3) `plugin.json.version === package.json.version`、(4) `plugin.json.skills` が物理的に存在、(5) `plugin.json.hooks` が物理的に存在、(6) marketplace.json が valid JSON、(7) `marketplace.json.plugins[0].name === "artgraph"`、(8) `hooks/hooks.json` の Stop hook command が `npx artgraph` で始まる、(9) plugin.json と marketplace.json の version 一致、(10) **Plugin install + `init --with-skills` の共存テスト**: project-local `.claude/skills/<name>/SKILL.md` と user-global `~/.claude/plugins/cache/.../skills/<name>/SKILL.md` が同時存在する場合、Claude Code の優先順位 (project local > user global) に従って Skill が解決されることを確認する fixture (EC6 対応) (FR-018)

### Implementation for Phase 5

- [ ] T033 [P] [US6] Create `.claude-plugin/plugin.json` per [contracts/plugin-manifest.md](./contracts/plugin-manifest.md). `version` は現 `package.json#version` と同期。`skills: "./templates/skills/"` (FR-017, FR-018, R5, R6)
- [ ] T034 [P] [US6] Create `.claude-plugin/marketplace.json` per contracts. `name: "artgraph-marketplace"`、`plugins[0].source: "./"` (R5)
- [ ] T035 [P] [US6] Create `hooks/hooks.json` per contracts. Stop hook で `npx artgraph check --gate --diff` を実行 (FR-019, R12)
- [ ] T036 [P] [US6] Add `claude plugin validate .` step to `.github/workflows/ci.yml` (existing CI workflow に追加。`claude` CLI を CI に install するステップも必要 — npm `@anthropic/claude-cli` または同等パッケージから)。Plugin manifest 変更時のみ走らせる path filter を設定 (FR-020)
- [ ] T037 [P] [US6] Update root `README.md` — "Installation" 節に Plugin 経由 install 手順を追加 (`/plugin marketplace add ShintaroMorimoto/artgraph` → `/plugin install artgraph@artgraph-marketplace`)。npm 経由とどちらも選べることを明記

**Checkpoint Phase 5**: P2 完了。`pnpm test` 通過 + 別 repo で smoke test (Plugin install → skill が `~/.claude/plugins/cache/.../skills/` に存在)。PR-C を出してマージ。

---

## Phase 6: P3 — Spec Kit hook 出力消費型 + Kiro Smart Hook + OpenSpec 統合 (US7 + US8) / PR-D

**Goal**: 3 大 SDD ツール (Spec Kit / Kiro / OpenSpec) との連携を深め、agent-native goal を完成させる。

**Independent Test**: [quickstart.md](./quickstart.md) US7 + US8 全シナリオ通過。OpenSpec community schema 配備 + Kiro Smart Hook 配備 + Spec Kit `after_tasks` の出力消費型 dispatch (20-trial smoke で >= 95%)。

**PR target**: PR-D

### Tests for Phase 6 (TDD) ⚠️

- [ ] T038 [P] [US7] Write `tests/speckit-extension-command.test.ts` per [contracts/speckit-extension-command.md](./contracts/speckit-extension-command.md) テスト表: (a) `artgraph.scan-reconcile.md` 本文に `ARTGRAPH:` prefix 例、(b) `npx artgraph scan` + `npx artgraph reconcile` 呼び出し、(c) emit 指示 ("emit a single line")、(d) `templates/integrate/speckit/README.md` に troubleshooting セクション、(e) `extension.yml#requires.speckit_version` が `>=0.11.0` 以上 (FR-021, FR-022, FR-023)
- [ ] T039 [P] [US8] Extend `tests/integrate-cli.test.ts` with `integrate kiro --with-hooks` case: 実行後に `.kiro/hooks/artgraph-verify.json` が配備されること、再実行で `--force` なしは no-op、`--force` で再配備 (FR-024)
- [ ] T040 [P] [US8] Extend `tests/integrate-cli.test.ts` with `integrate openspec` case: `openspec/` が存在する fixture 上で実行、`openspec/schemas/artgraph/schema.yaml` + `templates/<phase>.md` が配備されることを assert。`openspec/` が無い fixture で no-op。**`--force` 再配備** (既存 schema を上書き) と **`--force` なし再実行** (no-op で配備済を保つ) の両ケースを assert (EC7 補強) (FR-025, FR-026, FR-028 — integrate openspec)

### Implementation for Phase 6

#### Spec Kit hook 出力消費型化 (US7)

- [ ] T041 [P] [US7] Edit `templates/integrate/speckit/commands/artgraph.scan-reconcile.md` per [contracts/speckit-extension-command.md](./contracts/speckit-extension-command.md) の改修後構造。`ARTGRAPH: {"reconciled": N, "drift": M}` 形式の 1 行 JSON サマリ emit を明示的に指示 (FR-021, R7)
- [ ] T042 [P] [US7] Edit `templates/integrate/speckit/README.md` — "Troubleshooting" セクション追加: Spec Kit Issue #2730 への言及、`/artgraph.scan-reconcile` 手動実行のフォールバック手順 (FR-022, R7)
- [ ] T043 [P] [US7] Verify `templates/integrate/speckit/extension.yml` の `requires.speckit_version: ">=0.11.0"` — 既存値の確認 (PR #1702 / #1886 / #2713 が含まれるバージョン以降)。必要があれば update (FR-023)

#### Kiro Smart Hook (US8)

- [ ] T044 [P] [US8] Create `templates/integrate/kiro/hooks/artgraph-verify.json` — Kiro Smart Hook config (`after_save` event で `npx artgraph verify --diff` 発火)。Kiro 現行 hook schema に従って書く (kiro.dev/docs/cli/mcp/ 系の hook docs を参照)
- [ ] T045 [US8] Implement `--with-hooks` option in `src/integrate/providers/kiro.ts` — `KiroProvider.install({ withHooks: true })` で `.kiro/hooks/artgraph-verify.json` を配備。`--uninstall` 時は撤去対象に含める (FR-024)
- [ ] T046 [US8] Wire `--with-hooks` to `artgraph integrate kiro` in `src/cli.ts` integrate subcommand (commander option)

#### OpenSpec 統合 (US8)

- [ ] T047 [P] [US8] Create `templates/integrate/openspec/schemas/artgraph/schema.yaml` — OpenSpec community schema 形式 (Fission-AI/OpenSpec の `docs/customization.md` 規約)。`apply` フェーズの verify ステップで `npx artgraph check --diff` を必須化 (FR-026, R9)
- [ ] T048 [P] [US8] Create `templates/integrate/openspec/schemas/artgraph/templates/apply-verify.md` — `/opsx:apply` 時に AI agent が読む verify step 説明 markdown
- [ ] T049 [P] [US8] Create `templates/integrate/openspec/README.md` — install / uninstall / schema 利用方法の説明
- [ ] T050 [US8] Implement `src/integrate/providers/openspec.ts` — `detect()` (`openspec/` ディレクトリの存在チェック)、`install()` (`templates/integrate/openspec/schemas/artgraph/*` を `openspec/schemas/artgraph/` にコピー)、`isInstalled()`、`uninstall()`。既存 `SpecKitProvider` / `KiroProvider` のパターンを継承 (FR-025)
- [ ] T051 [US8] Register `OpenSpecProvider` in `src/integrate/index.ts` `registerBuiltinProviders()` — speckit, kiro と並ぶ 3 番目の builtin provider として
- [ ] T052 [US8] Add `openspec` to `--integrate=<tools>` の許容値リスト (`src/cli.ts` / `src/init.ts` のバリデーション) — `--integrate=openspec` および `--integrate=auto` 時に openspec が detect されれば走るように

**Checkpoint Phase 6**: P3 完了。`pnpm test` + `pnpm test:e2e` 通過。`quickstart.md` US7 / US8 手動検証通過。PR-D を出してマージ。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 横断的な仕上げと validation。各 Phase の checkpoint で部分的に実施するが、最終確認はここで。

- [ ] T053 [P] Run full `pnpm test` (unit + integration + new metatests) and confirm zero failures
- [ ] T054 [P] Run `pnpm test:e2e` (e2e suite) and confirm zero failures
- [ ] T055 [P] Run `pnpm typecheck` and confirm zero TypeScript errors
- [ ] T056 [P] Run `claude plugin validate .` and confirm pass (FR-020, P2 で CI 化済だがローカルでも確認)
- [ ] T057 Manual walk through of [quickstart.md](./quickstart.md) US1–US8 in a clean `/tmp` repo per US section
- [ ] T058 [P] Run `pnpm knip` and confirm no unused exports / files
- [ ] T059 [P] Update `CHANGELOG.md` — 各 PR phase ごとにエントリ追加 (`Added: artgraph-setup, artgraph-integrate, artgraph-detect Skills` / `Added: --with-hooks --with-agent-context init flags` / `Added: Plugin distribution via .claude-plugin/` / `Added: OpenSpec integration, Kiro Smart Hook, Spec Kit #2730 fix`)
- [ ] T060 Re-evaluate Constitution Check post-implementation (plan.md の Constitution Check section が現実装と整合することを確認、Complexity Tracking が空のままであることを確認、FR-027 「No Skill MAY auto-commit lock files, auto-claim `@impl` tags, or write to the artifact graph without explicit `artgraph reconcile` / `rename` invocation」の遵守を実装で確認) (FR-027)

---

## Dependencies & Execution Order

### Phase Dependencies (PR merge order)

- **Phase 1 (Setup)**: 環境確認。即実施可
- **Phase 2 (Foundational)**: Phase 1 後。Phase 3 以降の全 P0 US をブロックする
- **Phase 3 (PR-A, P0)**: Phase 2 後。issue #98 直接対応
- **Phase 4 (PR-B, P1)**: Phase 3 後 (主に `artgraph-setup` Skill の `--with-hooks --with-agent-context` 引数列の整合性のため。T029 で sync)
- **Phase 5 (PR-C, P2)**: Phase 4 後 (Plugin の hooks/hooks.json が Phase 4 で配布される hook 構造と同じ。Phase 5 独立で merge も理論的に可能だが、整合性のため逐次 merge を推奨)
- **Phase 6 (PR-D, P3)**: Phase 5 後 (Phase 5 まで蓄積したテスト基盤の上に追加)
- **Phase 7 (Polish)**: 全 Phase 完了後

### User Story Dependencies (within phases)

- **US1, US2, US3 (Phase 3)**: 並列実行可。共通の Phase 2 を待つ
- **US4, US5 (Phase 4)**: 並列実行可。Phase 3 の Skill 構造に依存
- **US6 (Phase 5)**: Phase 4 の hook 構造を `hooks/hooks.json` に流用
- **US7, US8 (Phase 6)**: 並列実行可。US7 は Spec Kit (既存) を改修、US8 は新規 (Kiro hook + OpenSpec)

### Within Each User Story

- Test 作成 (TDD) MUST be written and FAIL before implementation
- Skill ファイル / template 作成 → CLI 統合 → docs 更新 の順
- 各 US 完了後にチェックポイントで quickstart シナリオを手動検証

### Parallel Opportunities

**Phase 2**:
- T003, T004 が並列実行可 (`_shared/install-check.md` と `_shared/output-schema.md`)

**Phase 3**:
- T005, T006, T007 (テスト) が並列実行可
- T010, T011, T012, T013 (既存 4 Skill のリライト) が並列実行可
- T015, T016, T017 (新規 3 Skill 作成) が並列実行可
- T018, T019 (docs/skills-guide.md と README.md 更新、異なるファイル) が並列実行可

**Phase 4**:
- T020, T021 (テスト) が並列実行可
- T022, T023, T024, T025 (テンプレファイル) が並列実行可
- T030 (Kiro steering) は他と独立で並列実行可

**Phase 5**:
- T033, T034, T035 (Plugin マニフェスト 3 ファイル) が並列実行可
- T036, T037 (CI 設定追加 と README 更新、異なるファイル) が並列実行可 (ただし T036 は T033–T035 完了に依存)

**Phase 6**:
- T038, T039, T040 (テスト) が並列実行可
- T041, T042, T043 (Spec Kit 配下の異なるファイルを編集) が並列実行可
- T044, T047, T048, T049 (Kiro hook + OpenSpec テンプレ) が並列実行可

**Phase 7**:
- T053, T054, T055, T056, T058, T059 が並列実行可 (T057 manual walk は人手なので別)

---

## Parallel Example: Phase 3 (P0)

```bash
# Foundational 完了後、テスト 3 つを並列で書く:
Task: "Write tests/skills-templates.test.ts" (T005)
Task: "Extend tests/init.test.ts" (T006)
Task: "Extend tests/integrate-cli.test.ts" (T007)

# テスト完了後、既存 4 Skill のリライトを並列で:
Task: "Migrate artgraph-plan to directory format" (T010)
Task: "Migrate artgraph-verify to directory format" (T011)
Task: "Migrate artgraph-coverage to directory format" (T012)
Task: "Migrate artgraph-rename to directory format" (T013)

# 並列で新規 3 Skill 作成:
Task: "Create artgraph-setup SKILL.md" (T015)
Task: "Create artgraph-integrate SKILL.md" (T016)
Task: "Create artgraph-detect SKILL.md" (T017)
```

---

## Implementation Strategy

### MVP First (Phase 3 = P0 = issue #98 close)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002–T004)
3. Complete Phase 3 (PR-A): US1 + US2 + US3 (T005–T019)
4. **STOP and VALIDATE**: [quickstart.md](./quickstart.md) US1 / US2 / US3 を手動検証
5. **Merge PR-A → issue #98 close → MVP 達成**

### Incremental Delivery

1. PR-A merge (issue #98 close)
2. PR-B (P1 hooks + agent context + Kiro inclusion auto) → 検証 → merge
3. PR-C (P2 Plugin manifest) → 検証 → merge
4. PR-D (P3 Spec Kit/Kiro/OpenSpec deeper integration) → 検証 → merge
5. Polish (Phase 7) → release notes → 配布

各 PR が単独でレビュー・マージ可能 (Constitution 「機能単位で独立マージ可能」)。

### Parallel Team Strategy (将来、複数 developer 体制で)

Phase 3 を 3 developer で分担可:
- Dev A: 既存 4 Skill リライト (T010–T013, T014) + ドキュメント (T018, T019)
- Dev B: 新規 3 Skill (T015, T016, T017) + テスト (T005)
- Dev C: CLI フラグ + `installSkills()` 改修 (T008, T009, T002) + テスト (T006, T007)

ただし本作業は 1 developer (Claude + ShintaroMorimoto レビュー) を想定するため、逐次実行で十分。

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD)
- Commit after each task or logical group
- Stop at any checkpoint to validate story / phase independently
- Avoid: vague tasks, same file conflicts, cross-PR dependencies that break independence
- 各 task 完了後は `git add` + `git commit` (commit message に対応 Task ID を含める例: `feat(skills): T015 artgraph-setup Skill 追加`)
- PR タイトル例: `feat(skills): P0 — Skills 拡充 (#98)` / `feat(hooks): P1 — Stop hook + agent context テンプレ` / `feat(plugin): P2 — Plugin 配布 (.claude-plugin)` / `feat(integrate): P3 — Spec Kit/Kiro/OpenSpec deeper integration`

---

## Task Count Summary

| Phase | Task Range | Count | PR |
|-------|------------|-------|-----|
| Phase 1 Setup | T001 | 1 | — (pre-flight) |
| Phase 2 Foundational | T002–T004 | 3 | PR-A 同梱 |
| Phase 3 P0 (US1+US2+US3) | T005–T019 | 15 | **PR-A** |
| Phase 4 P1 (US4+US5) | T020–T031 | 12 | PR-B |
| Phase 5 P2 (US6) | T032–T037 | 6 | PR-C |
| Phase 6 P3 (US7+US8) | T038–T052 | 15 | PR-D |
| Phase 7 Polish | T053–T060 | 8 | All-PR 共通 / 最終 |
| **Total** | T001–T060 | **60** | 4 PRs |

| User Story | Tasks |
|------------|-------|
| US1 (setup) | T006, T008, T009, T015, T019 = 5 |
| US2 (integrate existing) | T007, T016, T017 = 3 |
| US3 (skill refactor) | T005, T010, T011, T012, T013, T014, T018 = 7 |
| US4 (hooks + agent context) | T020, T021, T022, T023, T024, T025, T026, T027, T028, T029 = 10 |
| US5 (Kiro inclusion auto) | T030, T031 = 2 |
| US6 (Plugin) | T032, T033, T034, T035, T036, T037 = 6 |
| US7 (Spec Kit hook) | T038, T041, T042, T043 = 4 |
| US8 (Kiro Smart Hook + OpenSpec) | T039, T040, T044, T045, T046, T047, T048, T049, T050, T051, T052 = 11 |
| Phase 1+2+7 (cross-cutting) | T001, T002, T003, T004, T053, T054, T055, T056, T057, T058, T059, T060 = 12 |

