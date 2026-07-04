---

description: "Task list for 012-skills-expansion — Agent-Native Toolkit (revised post-feedback)"
---

# Tasks: Agent-Native Toolkit (Skills / Hooks / Plugin / SDD Integrations)

**Input**: Design documents from `/specs/012-skills-expansion/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Tests are **REQUIRED** (TDD per user guidance). Each implementation task is preceded by its test task.

**Organization**: Phases map 1-to-1 to PR units (PR-A/B/C/D) so each can be merged independently. Within each PR phase, tasks are ordered by dependency. **未リリース前提のため後方互換タスクは含めない**。

**Scope notes**:
- OpenSpec 統合は本 spec 対象外 → [issue #25](https://github.com/ShintaroMorimoto/artgraph/issues/25) ベースの別 spec で進める
- Bun/Deno 等 package manager 検出は `artgraph-setup` Skill 内に**最小実装**として組み込む。Stop hook テンプレ等の全面 generic 化はフォローアップ issue

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

- [x] T001 Verify dev environment: Node >= 22 active (`node -v`), pnpm available, working tree clean (`git status`), on branch `docs/skills-expansion`, `.specify/feature.json` points to `specs/012-skills-expansion`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared changes that all P0 user stories depend on. MUST complete before Phase 3 begins.

**⚠️ CRITICAL**: All P0 user story (US1 / US2 / US3) work depends on these tasks.

- [x] T002 Refactor `installSkills()` in `src/init.ts` to handle **only the new directory-format Skills** (`templates/skills/<name>/SKILL.md`). Walk `templates/skills/` recursively, copy `_shared/` and each `<name>/SKILL.md` into `.claude/skills/`. Preserve `references/` and `scripts/` sub-folders within Skill directories. Legacy flat-file (`templates/skills/<name>.md`) support is NOT included (pre-release, no back-compat required)
- [x] T003 [P] Create `templates/skills/_shared/install-check.md` (**English**) — common artgraph CLI install-check procedure referenced by all Skills (DRY out the duplicated 9-line block currently in 4 Skills). 30 lines max. Format: short markdown with shell snippets (FR-008, R2)
- [x] T004 [P] Create `templates/skills/_shared/output-schema.md` (**English**) — short reference of `artgraph impact|check|coverage|rename --format json` output shapes, linked from Skills that consume JSON (R2)
- [x] T004a [P] Create `templates/skills/_shared/package-manager.md` (**English**) — package manager detection logic (npm / pnpm / Bun / Deno from lockfile or `package.json#packageManager`; **Yarn intentionally excluded** — `yarn.lock` triggers npm fallback + user warning), install/exec command mapping table, bash detection snippet for `artgraph-setup` Skill to use (FR-026, R14)

**Checkpoint**: Foundation ready — Phase 3 can begin.

---

## Phase 3: P0 — Skills 拡充 (US1 + US2 + US3) 🎯 MVP / PR-A

**Goal**: issue #98 直接対応。エージェント自己駆動セットアップ・既存リポへの後付け統合・既存 4 Skill の DRY 化 + impact rename + 英語化を一括で完成させる。

**Independent Test**: [quickstart.md](./quickstart.md) US1 / US2 / US3 全シナリオ通過。`tests/skills-templates.test.ts` で全 7 Skill が frontmatter / 100 行 / `_shared` 参照 / **英語** 規約に合致。

**PR target**: PR-A (issue #98 close 単位)

### Tests for Phase 3 (TDD) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation in Phase 3**

- [x] T005 [P] [US3] Write `tests/skills-templates.test.ts` — メタテストで全 SKILL.md を walk: (a) frontmatter に `name` `description` 必須、(b) `name === directory name` (新 Skill 名: setup, integrate, detect, impact, verify, coverage, rename)、(c) description ≤ 1024 chars、(d) body ≤ 100 行、(e) 4 既存 Skill が `_shared/install-check.md` への markdown link を含む、(f) `allowed-tools` 配列要素が `<Name>(...)` 形式、(g) 全 Skill description が unique、(h) **すべての SKILL.md が英語** (CJK Unicode blocks 不検出) (FR-008, FR-009, FR-010, FR-011, FR-029, FR-028 — Skill template format invariants)
- [x] T006 [P] [US1] Write/Extend `tests/init.test.ts` — `init` default behavior 全変更カバー: (a) **フラグなし** で full setup (`.artgraph.json` + Skills + integrate auto + Stop hook + agent context) が走る、(b) `--minimal` で `.artgraph.json` のみ、(c) `--no-skills` / `--no-integrate` / `--no-hooks` / `--no-agent-context` の個別 opt-out、(d) `--minimal --with-skills` の部分 opt-in、(e) SDD ツール検出ゼロで integrate auto 部分が no-op (exit 0)、(f) Spec Kit のみ検出で speckit integrate 実行、(g) Spec Kit + Kiro 両方で両方 integrate (FR-003, FR-028 — init default coverage, R15)
- [x] T007 [P] [US3] Write `tests/integrate-cli.test.ts` の `integrate list` カバレッジ拡張 — 出力に既存 provider (speckit, kiro) が含まれること、`detected` / `installed` フィールドが正しいこと (FR-006)

### Implementation for Phase 3

#### CLI 改修 (US1, US4) — `init` default 大幅変更

- [x] T008 [US1] Redesign `init` command in `src/cli.ts`: add `--minimal` flag + `--no-skills` / `--no-integrate` / `--no-hooks` / `--no-agent-context` opt-out flags + `--with-skills` / `--with-integrate` / `--with-hooks` / `--with-agent-context` opt-in flags (for use with `--minimal`). Keep `--force`, `--no-scan`, `--integrations <csv|all>`, `--integrate-gate` / `--no-integrate-gate`, `--format` (FR-003, R15, [contracts/cli-flags.md](./contracts/cli-flags.md))
- [x] T009 [US1] Implement new `runInit()` logic in `src/init.ts`: default flow runs all stages (config + scan + skills + integrate-auto + hooks + agent-context), `--minimal` skips all stages except config, `--no-*` selectively skips, `--with-*` (under `--minimal`) selectively enables (FR-003, FR-026 — pkg manager detection NOT here, that's in artgraph-setup Skill)

#### 既存 4 Skill のリネーム + ディレクトリ化 + リライト + 英語化 (US3)

- [x] T010 [P] [US3] **Rename `artgraph-plan` → `artgraph-impact`**. Migrate `templates/skills/artgraph-plan.md` → `templates/skills/artgraph-impact/SKILL.md` (**English body**, 100 行以下). 冒頭の install 確認ブロックを `[install-check](../_shared/install-check.md) を参照` に置換 (英訳: "See [install-check](...) for the standard pre-flight check"). frontmatter の `description` を [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md) の `artgraph-impact` 行に更新. **3 入力モード (a/b/c)** を body に明記 (mode (a) diff present → `artgraph impact --diff`、mode (b) user mentions REQ-ID/file → `artgraph impact <targets>`、mode (c) neither → ask user). `allowed-tools: ["Bash(npx artgraph *)", "Bash(artgraph *)", "Bash(git diff*)"]` (FR-008, FR-009, FR-010, FR-011, FR-025, FR-029, R10, R13)
- [x] T011 [P] [US3] Migrate `templates/skills/artgraph-verify.md` → `templates/skills/artgraph-verify/SKILL.md` (**English body**, T010 と同じ規約: FR-008, FR-009, FR-010, FR-011, FR-029, R10)
- [x] T012 [P] [US3] Migrate `templates/skills/artgraph-coverage.md` → `templates/skills/artgraph-coverage/SKILL.md` (**English body**, T010 と同じ規約: FR-008, FR-009, FR-010, FR-011, FR-029, R10)
- [x] T013 [P] [US3] Migrate `templates/skills/artgraph-rename.md` → `templates/skills/artgraph-rename/SKILL.md` (**English body**) + `references/lifecycle-flows.md` (**English**, split/merge の詳細手順を分離して SKILL.md を 100 行以下に保つ progressive disclosure) (FR-008, FR-009, FR-010, FR-011, FR-029, R10)
- [x] T014 [US3] Delete legacy flat files `templates/skills/artgraph-{plan,verify,coverage,rename}.md` after T010–T013 land (no back-compat needed, pre-release). Verify `installSkills()` (T002) does not break

#### 新規 Skill 追加 (US1, US2) — 英語

- [x] T015 [P] [US1] Create `templates/skills/artgraph-setup/SKILL.md` (**English**) — description は [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md) の `artgraph-setup` 行. 本文: (a) install 確認 (`_shared/install-check.md` 参照, but expected to fail since CLI not installed)、(b) **detect package manager** via `_shared/package-manager.md` (lockfile / `package.json#packageManager` 順、**Yarn は npm fallback + 警告**)、(c) ユーザー同意取得、(d) `<pkg-mgr install cmd> -D artgraph` 実行 (例: `npm install -D artgraph` / `bun install -D artgraph` / `pnpm add -D artgraph` / `deno add npm:artgraph`)、(e) `<pkg-mgr exec cmd> artgraph init` 実行 (default で full setup が走る — `--with-*` フラグ列を渡す必要なし)、(f) `artgraph check` で成功確認、(g) **install / init / check のいずれかが失敗したら stderr を user に報告して終了** (EC9 ネットワーク失敗ハンドリング含む) (FR-001, FR-002, FR-004, FR-026, R10, R14)。`allowed-tools: ["Bash(npm install*)", "Bash(pnpm add*)", "Bash(bun install*)", "Bash(deno add*)", "Bash(npx artgraph *)", "Bash(pnpm exec artgraph*)", "Bash(bunx artgraph*)", "Bash(deno run*)", "Bash(artgraph *)", "Bash(test *)", "Bash(ls *)"]` (Yarn 関連の `Bash(yarn *)` は意図的に除外)
- [x] T016 [P] [US2] Create `templates/skills/artgraph-integrate/SKILL.md` (**English**) — description は contracts 通り. 本文: (a) install 確認、(b) `artgraph integrate list` 実行で利用可能 provider 一覧、(c) 検出済 provider への integrate を提案 (per-tool で `--gate` 採否を確認)、(d) `artgraph integrate <tool>` 実行 (FR-005, FR-006, FR-029, R10)。`allowed-tools: ["Bash(npx artgraph *)", "Bash(artgraph *)"]`
- [x] T017 [P] [US2] Create `templates/skills/artgraph-detect/SKILL.md` (**English**) — description は contracts 通り. 本文: (a) `command -v artgraph` で CLI 確認、(b) 未導入なら `artgraph-setup` 提案、(c) 導入済なら `.artgraph.json` / `.specify/extensions/artgraph/` / `.kiro/steering/artgraph.md` / `.claude/skills/artgraph-*` の存在を確認して要約 (FR-007, FR-029, R10)。`allowed-tools: ["Bash(npx artgraph *)", "Bash(artgraph *)", "Bash(ls *)", "Bash(test *)", "Bash(command *)"]`

#### ドキュメント (US1, US3)

- [x] T018 [P] [US3] Update `docs/skills-guide.md` (**Japanese OK** — docs ターゲット読者向け) — 既存 4 Skill のセクションは内容を `artgraph-impact` rename + ディレクトリ形式に更新。冒頭の「セットアップ」節を `artgraph-setup` 経由のフローに置換 (`init` default = full setup を反映)。「Skills 一覧」を 7 つに拡張 (artgraph-{setup, integrate, detect, impact, verify, coverage, rename})。各 Skill description 文面を [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md) と同期 (FR-008 — DRY な docs)
- [x] T019 [P] [US1] Update root `README.md` (**Japanese OK**) — "Claude Code skills" 節を新 Skill 含めて更新 (artgraph-plan → artgraph-impact の旨を明記)。Quickstart の冒頭に「Claude Code エージェントで artgraph をセットアップする」案内を追加 (`/artgraph-setup` で 1 コマンド完結)。`init` の default 挙動が変わった旨と `--minimal` 案内を追加

**Checkpoint Phase 3**: P0 完了。`pnpm test` + `pnpm test:e2e` 通過。[quickstart.md](./quickstart.md) US1 (5 package manager 環境) / US2 / US3 を手動で走らせて成功。PR-A を出して issue #98 を close。

---

## Phase 4: P1 — Hooks + Agent Context + Kiro inclusion auto (US4 + US5) / PR-B

**Goal**: 検証ゲートと AI エージェント context を配布物に組み込み、Kiro での semantic 発火に切り替える。

**Note**: `init` の default で hooks + agent context は既に ON (Phase 3 の T008/T009 で実装)。Phase 4 は **テンプレファイル本体の整備と Kiro steering 改修**。

**Independent Test**: [quickstart.md](./quickstart.md) US4 (4 case の settings.json merge + CLAUDE.md 注入) と US5 (Kiro inclusion auto) 全シナリオ通過。

**PR target**: PR-B

### Tests for Phase 4 (TDD) ⚠️

- [x] T020 [P] [US4] Write `tests/hooks-merge.test.ts` — 4 cases per [contracts/settings-merge.md](./contracts/settings-merge.md): (A) settings.json なし、(B) `{}`、(C) 他 hook あり Stop なし、(D) Stop hook 衝突 (exit 1)。`--force` を渡しても Case D で上書きしないことを assert (FR-012, FR-013, FR-028 — --with-hooks, R4)
- [ ] T021 [P] [US4] Write `tests/agent-context-injection.test.ts` — (a) CLAUDE.md なしで作成、(b) 既存 CLAUDE.md に追記、(c) マーカー既存で更新、(d) 2 回実行で idempotent (diff なし)、(e) AGENTS.md にも同等動作、(f) スニペットが 30 行以下 (FR-014, FR-015, FR-028 — --with-agent-context, R3)

### Implementation for Phase 4

#### テンプレファイル (US4)

- [x] T022 [P] [US4] Create `templates/hooks/settings.json.template` — 内容は [data-model.md](./data-model.md) E3 + [contracts/settings-merge.md](./contracts/settings-merge.md) の入力ソース節通り (Stop hook で `npx artgraph check --gate --diff` を登録)。**(注: `npx` 表記は npm 環境前提。pkg mgr 検出による generic 化はフォローアップ issue)**
- [ ] T023 [P] [US4] Create `templates/hooks/pre-commit.sh.template` — husky/lefthook 利用者向けの参考スクリプト (本体は `npx artgraph check --gate --diff` を実行)。任意配布で、`init` の default では自動配置しない (将来の `--with-precommit` 用テンプレ予約)
- [ ] T024 [P] [US4] Create `templates/agent-context/claude-md-snippet.md` (**Japanese OK**) — 30 行以下。`<!-- artgraph: BEGIN agent context -->` / `<!-- artgraph: END agent context -->` で囲った内容。Skills の使い方、`@impl` 文法、`artgraph impact` / `check` の呼びどころ、Skills 配置場所の 4 点を簡潔に (FR-014, R3, [data-model.md](./data-model.md) E5)
- [ ] T025 [P] [US4] Create `templates/agent-context/agents-md-snippet.md` (**Japanese OK**) — 同上スニペット (Kiro / 他エージェント共通プロトコル AGENTS.md 用)

#### `installHooks()` / `installAgentContext()` 実装 (US4)

- [x] T026 [US4] Implement `installHooks(targetDir)` in `src/init.ts` per [contracts/settings-merge.md](./contracts/settings-merge.md) implementation guide. Case A/B/C は merge して exit 0、Case D は警告 + exit 1。 `--force` 不問 (settings.json merge は常に fail-on-conflict、R4)
- [ ] T027 [US4] Implement `installAgentContext(targetDir)` in `src/init.ts` — CLAUDE.md / AGENTS.md のターゲットファイル走査、HTML マーカー検出、idempotent 注入。両ファイル無ければ CLAUDE.md を新規作成 (FR-015, R3)
- [x] T028 [US4] Wire `installHooks()` and `installAgentContext()` into the default `runInit()` flow from T009. Verify both are called by default and skipped by `--no-hooks` / `--no-agent-context` / `--minimal`

#### Kiro steering 改修 (US5)

- [ ] T030 [P] [US5] Edit `templates/integrate/kiro/artgraph.md` — 冒頭に frontmatter `---\ninclusion: auto\ndescription: "Use when checking drift between specs/design/tasks/code, before approving an implementation step, or when running impact analysis."\n---` を追加。本文は変更なし (FR-016, R8)
- [ ] T031 [US5] Update `examples/kiro-integration/README.md` — `inclusion: auto` 採用の説明を 1 段落追加 (常時 token 消費の回避メリットと、関連作業時のみ発火する旨)

**Checkpoint Phase 4**: P1 完了。`pnpm test` 通過 ([quickstart.md](./quickstart.md) US4 + US5 手動検証通過)。PR-B を出してマージ。

---

## Phase 5: P2 — Plugin マニフェスト配布 (US6) / PR-C

**Goal**: `.claude-plugin/` 配下に marketplace + plugin manifest を配置し、`/plugin install artgraph@artgraph-marketplace` 経路で skills + hooks bundle を入手できるようにする。README に marketplace 3 経路 (self / community / official) の説明を追加。

**Independent Test**: [quickstart.md](./quickstart.md) US6 全シナリオ通過 (別 repo での install、source-of-truth 同期検証、CI validator pass)。

**PR target**: PR-C

### Tests for Phase 5 (TDD) ⚠️

- [ ] T032 [P] [US6] Write `tests/plugin-manifest.test.ts` per [contracts/plugin-manifest.md](./contracts/plugin-manifest.md) CI 検証節: (1) plugin.json が valid JSON、(2) `name === "artgraph"`、(3) `plugin.json.version === package.json.version`、(4) `plugin.json.skills` が物理的に存在、(5) `plugin.json.hooks` が物理的に存在、(6) marketplace.json が valid JSON、(7) `marketplace.json.plugins[0].name === "artgraph"`、(8) `hooks/hooks.json` の Stop hook command が `npx artgraph` で始まる、(9) plugin.json と marketplace.json の version 一致、(10) **Plugin install + `artgraph init` の共存テスト**: project-local `.claude/skills/<name>/SKILL.md` と user-global `~/.claude/plugins/cache/.../skills/<name>/SKILL.md` が同時存在する場合、Claude Code の優先順位 (project local > user global) に従って Skill が解決されることを確認する fixture (EC6 対応) (FR-018)

### Implementation for Phase 5

- [ ] T033 [P] [US6] Create `.claude-plugin/plugin.json` per [contracts/plugin-manifest.md](./contracts/plugin-manifest.md). `version` は現 `package.json#version` と同期。`skills: "./templates/skills/"` (FR-017, FR-018, R5, R6)
- [ ] T034 [P] [US6] Create `.claude-plugin/marketplace.json` per contracts. `name: "artgraph-marketplace"`、`plugins[0].source: "./"` (R5)
- [ ] T035 [P] [US6] Create `hooks/hooks.json` per contracts. Stop hook で `npx artgraph check --gate --diff` を実行 (FR-019, R12)
- [ ] T036 [P] [US6] Add `claude plugin validate .` step to `.github/workflows/ci.yml` (existing CI workflow に追加。`claude` CLI を CI に install するステップも必要 — npm `@anthropic/claude-cli` または同等パッケージから)。Plugin manifest 変更時のみ走らせる path filter を設定 (FR-020)
- [ ] T037 [P] [US6] Update root `README.md` — "Installation" 節に Plugin 経由 install 手順を追加 (`/plugin marketplace add ShintaroMorimoto/artgraph` → `/plugin install artgraph@artgraph-marketplace`)。npm 経由とどちらも選べることを明記。**Marketplace 3 経路 (self / community / official) の選択肢を 3 行で説明** (本 spec は self、community submission は将来、official は対象外) (R5, [contracts/plugin-manifest.md](./contracts/plugin-manifest.md) Marketplace 配布の 3 経路節)

**Checkpoint Phase 5**: P2 完了。`pnpm test` 通過 + 別 repo で smoke test (Plugin install → skill が `~/.claude/plugins/cache/.../skills/` に存在)。PR-C を出してマージ。

---

## Phase 6: P3 — Spec Kit hook 出力消費型 + Kiro Smart Hook (US7 + US8) / PR-D

**Goal**: Spec Kit との連携を Issue #2730 対策で完成させ、Kiro の自動 verify 経路を追加する。**OpenSpec 統合は本 spec から外したため Phase 6 は縮小**。

**Note**: OpenSpec 統合は別 spec ([issue #25](https://github.com/ShintaroMorimoto/artgraph/issues/25) ベース) で進める。

**Independent Test**: [quickstart.md](./quickstart.md) US7 + US8 全シナリオ通過。Spec Kit `after_tasks` の出力消費型 dispatch (20-trial smoke で >= 95%)、Kiro Smart Hook 配備。

**PR target**: PR-D

### Tests for Phase 6 (TDD) ⚠️

- [ ] T038 [P] [US7] Write `tests/speckit-extension-command.test.ts` per [contracts/speckit-extension-command.md](./contracts/speckit-extension-command.md) テスト表: (a) `artgraph.scan-reconcile.md` 本文に `ARTGRAPH:` prefix 例、(b) `npx artgraph scan` + `npx artgraph reconcile` 呼び出し、(c) emit 指示 ("emit a single line")、(d) `templates/integrate/speckit/README.md` に troubleshooting セクション、(e) `extension.yml#requires.speckit_version` が `>=0.11.0` 以上 (FR-021, FR-022, FR-023)
- [ ] T039 [P] [US8] Extend `tests/integrate-cli.test.ts` with `integrate kiro --with-hooks` case: 実行後に `.kiro/hooks/artgraph-verify.json` が配備されること、再実行で `--force` なしは no-op、`--force` で再配備 (FR-024)

### Implementation for Phase 6

#### Spec Kit hook 出力消費型化 (US7)

- [ ] T041 [P] [US7] Edit `templates/integrate/speckit/commands/artgraph.scan-reconcile.md` per [contracts/speckit-extension-command.md](./contracts/speckit-extension-command.md) の改修後構造。`ARTGRAPH: {"reconciled": N, "drift": M}` 形式の 1 行 JSON サマリ emit を明示的に指示 (FR-021, R7)
- [ ] T042 [P] [US7] Edit `templates/integrate/speckit/README.md` — "Troubleshooting" セクション追加: Spec Kit Issue #2730 への言及、`/artgraph.scan-reconcile` 手動実行のフォールバック手順 (FR-022, R7)
- [ ] T043 [P] [US7] Verify `templates/integrate/speckit/extension.yml` の `requires.speckit_version: ">=0.11.0"` — 既存値の確認 (PR #1702 / #1886 / #2713 が含まれるバージョン以降)。必要があれば update (FR-023)

#### Kiro Smart Hook (US8)

- [ ] T044 [P] [US8] Create `templates/integrate/kiro/hooks/artgraph-verify.json` — Kiro Smart Hook config (`after_save` event で `npx artgraph verify --diff` 発火)。Kiro 現行 hook schema に従って書く (kiro.dev/docs 系の hook docs を参照)
- [ ] T045 [US8] Implement `--with-hooks` option in `src/integrate/providers/kiro.ts` — `KiroProvider.install({ withHooks: true })` で `.kiro/hooks/artgraph-verify.json` を配備。`--uninstall` 時は撤去対象に含める (FR-024)
- [ ] T046 [US8] Wire `--with-hooks` to `artgraph integrate kiro` in `src/cli.ts` integrate subcommand (commander option)

**Checkpoint Phase 6**: P3 完了。`pnpm test` + `pnpm test:e2e` 通過。`quickstart.md` US7 / US8 手動検証通過。PR-D を出してマージ。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 横断的な仕上げと validation。各 Phase の checkpoint で部分的に実施するが、最終確認はここで。

- [x] T053 [P] Run full `pnpm test` (unit + integration + new metatests) and confirm zero failures
- [x] T054 [P] Run `pnpm test:e2e` (e2e suite) and confirm zero failures
- [x] T055 [P] Run `pnpm typecheck` and confirm zero TypeScript errors
- [ ] T056 [P] Run `claude plugin validate .` and confirm pass (FR-020, P2 で CI 化済だがローカルでも確認) — **DEFERRED to P2 (Phase 5)**
- [ ] T057 Manual walk through of [quickstart.md](./quickstart.md) US1 (5 package manager 環境) / US2 / US3 / US4 / US5 / US6 / US7 / US8 in clean `/tmp` repos per US section
- [x] T058 [P] Run `pnpm knip` and confirm no unused exports / files
- [ ] T059 [P] Update `CHANGELOG.md` — 各 PR phase ごとにエントリ追加 (`Added: 7 Claude Code Skills (English)` / `Added: init full default + --minimal / --no-* / --with-* flags` / `Renamed: artgraph-plan → artgraph-impact` / `Added: Hooks/agent-context templates` / `Added: Plugin distribution` / `Added: Kiro Smart Hook + Spec Kit #2730 fix`)
- [ ] T060 Re-evaluate Constitution Check post-implementation (plan.md の Constitution Check section が現実装と整合することを確認、Complexity Tracking が空のままであることを確認、FR-027 「No Skill MAY auto-commit lock files, auto-claim `@impl` tags, or write to the artifact graph without explicit `artgraph reconcile` / `rename` invocation」の遵守を実装で確認) (FR-027)

---

## Dependencies & Execution Order

### Phase Dependencies (PR merge order)

- **Phase 1 (Setup)**: 環境確認。即実施可
- **Phase 2 (Foundational)**: Phase 1 後。Phase 3 以降の全 P0 US をブロックする
- **Phase 3 (PR-A, P0)**: Phase 2 後。issue #98 直接対応
- **Phase 4 (PR-B, P1)**: Phase 3 後 (Phase 3 の T009 で `installHooks()` / `installAgentContext()` を `runInit()` から呼ぶ flow が出来ているため、Phase 4 はテンプレファイル + 実装を埋めるだけ)
- **Phase 5 (PR-C, P2)**: Phase 4 後 (Plugin の `hooks/hooks.json` が Phase 4 で配布される hook 構造と同じ)
- **Phase 6 (PR-D, P3)**: Phase 5 後
- **Phase 7 (Polish)**: 全 Phase 完了後

### User Story Dependencies (within phases)

- **US1, US2, US3 (Phase 3)**: 並列実行可。共通の Phase 2 を待つ
- **US4, US5 (Phase 4)**: 並列実行可。Phase 3 の Skill 構造に依存
- **US6 (Phase 5)**: Phase 4 の hook 構造を `hooks/hooks.json` に流用
- **US7, US8 (Phase 6)**: 並列実行可。US7 は Spec Kit (既存) を改修、US8 は新規 Kiro Smart Hook

### Within Each User Story

- Test 作成 (TDD) MUST be written and FAIL before implementation
- Skill ファイル / template 作成 → CLI 統合 → docs 更新 の順
- 各 US 完了後にチェックポイントで quickstart シナリオを手動検証

### Parallel Opportunities

**Phase 2**:
- T003, T004, T004a が並列実行可 (`_shared/install-check.md` と `_shared/output-schema.md` と `_shared/package-manager.md`)

**Phase 3**:
- T005, T006, T007 (テスト) が並列実行可
- T010, T011, T012, T013 (既存 4 Skill のリライト + rename) が並列実行可
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
- T038, T039 (テスト) が並列実行可
- T041, T042, T043 (Spec Kit 配下の異なるファイルを編集) が並列実行可
- T044 (Kiro hook テンプレ) は他と独立で並列実行可

**Phase 7**:
- T053, T054, T055, T056, T058, T059 が並列実行可 (T057 manual walk は人手なので別)

---

## Parallel Example: Phase 3 (P0)

```bash
# Foundational 完了後、テスト 3 つを並列で書く:
Task: "Write tests/skills-templates.test.ts" (T005)
Task: "Write/Extend tests/init.test.ts" (T006)
Task: "Extend tests/integrate-cli.test.ts" (T007)

# テスト完了後、既存 4 Skill のリライトを並列で:
Task: "Rename + migrate artgraph-plan → artgraph-impact" (T010)
Task: "Migrate artgraph-verify to directory format" (T011)
Task: "Migrate artgraph-coverage to directory format" (T012)
Task: "Migrate artgraph-rename to directory format" (T013)

# 並列で新規 3 Skill 作成:
Task: "Create artgraph-setup SKILL.md (with pkg mgr detection)" (T015)
Task: "Create artgraph-integrate SKILL.md" (T016)
Task: "Create artgraph-detect SKILL.md" (T017)
```

---

## Implementation Strategy

### MVP First (Phase 3 = P0 = issue #98 close)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002–T004a)
3. Complete Phase 3 (PR-A): US1 + US2 + US3 (T005–T019)
4. **STOP and VALIDATE**: [quickstart.md](./quickstart.md) US1 (5 package manager 環境) / US2 / US3 を手動検証
5. **Merge PR-A → issue #98 close → MVP 達成**

### Incremental Delivery

1. PR-A merge (issue #98 close)
2. PR-B (P1 hooks + agent context + Kiro inclusion auto) → 検証 → merge
3. PR-C (P2 Plugin manifest) → 検証 → merge
4. PR-D (P3 Spec Kit/Kiro deeper integration) → 検証 → merge
5. Polish (Phase 7) → release notes → 配布

各 PR が単独でレビュー・マージ可能 (Constitution 「機能単位で独立マージ可能」)。

### Out of scope (本 spec で扱わないもの)

- OpenSpec 統合 → [issue #25](https://github.com/ShintaroMorimoto/artgraph/issues/25) で別 spec
- 全面 package manager 非依存化 (Stop hook テンプレ / Skill 本文 / README / Plugin hook の `npx artgraph` 表記の generic 化) → 後続 issue で
- MCP サーバ実装 → 需要先行で延期
- plugin-hints (`<claude-code-hint>` 等) → official marketplace 入り後

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD)
- Commit after each task or logical group
- Stop at any checkpoint to validate story / phase independently
- Avoid: vague tasks, same file conflicts, cross-PR dependencies that break independence
- 各 task 完了後は `git add` + `git commit` (commit message に対応 Task ID を含める例: `feat(skills): T015 artgraph-setup Skill (English, pkg-mgr detect)`)
- PR タイトル例: `feat(skills): P0 — Agent-native skills (#98)` / `feat(hooks): P1 — Stop hook + agent context templates` / `feat(plugin): P2 — Plugin distribution (.claude-plugin)` / `feat(integrate): P3 — Spec Kit #2730 fix + Kiro Smart Hook`

---

## Task Count Summary (revised)

| Phase | Task Range | Count | PR |
|-------|------------|-------|-----|
| Phase 1 Setup | T001 | 1 | — (pre-flight) |
| Phase 2 Foundational | T002–T004a | 4 | PR-A 同梱 |
| Phase 3 P0 (US1+US2+US3) | T005–T019 | 15 | **PR-A** |
| Phase 4 P1 (US4+US5) | T020–T031 (T029 削除) | 11 | PR-B |
| Phase 5 P2 (US6) | T032–T037 | 6 | PR-C |
| Phase 6 P3 (US7+US8) | T038, T039, T041–T046 (T040, T047–T052 削除) | 9 | PR-D |
| Phase 7 Polish | T053–T060 | 8 | All-PR 共通 / 最終 |
| **Total** | T001–T060 (一部削除) | **54** | 4 PRs |

| User Story | Tasks |
|------------|-------|
| US1 (setup) | T006, T008, T009, T015, T019 = 5 |
| US2 (integrate existing) | T007, T016, T017 = 3 |
| US3 (skill refactor + impact rename + English) | T005, T010, T011, T012, T013, T014, T018 = 7 |
| US4 (hooks + agent context) | T020, T021, T022, T023, T024, T025, T026, T027, T028 = 9 |
| US5 (Kiro inclusion auto) | T030, T031 = 2 |
| US6 (Plugin) | T032, T033, T034, T035, T036, T037 = 6 |
| US7 (Spec Kit hook) | T038, T041, T042, T043 = 4 |
| US8 (Kiro Smart Hook only — OpenSpec is out of scope) | T039, T044, T045, T046 = 4 |
| Phase 1+2+7 (cross-cutting) | T001, T002, T003, T004, T004a, T053, T054, T055, T056, T057, T058, T059, T060 = 13 |

> **Note**: T029, T040, T047–T052 are intentionally deleted (T029 was `artgraph-setup` SKILL.md sync, now subsumed by T015's full body. T040/T047–T052 were OpenSpec — out of scope). T014 retained for explicit deletion of legacy flat files post-migration.
