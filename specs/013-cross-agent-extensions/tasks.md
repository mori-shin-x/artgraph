---

description: "Tasks for spec 013-cross-agent-extensions"
---

# Tasks: Cross-Agent Extensions — Tier 1 多エージェント Skills + AGENTS.md canonical 配布

**Input**: Design documents from `specs/013-cross-agent-extensions/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 本 spec はテスト実装をタスクに含める (artgraph リポジトリは vitest によるテスト網羅が文化として確立、plan.md `Structure Decision` でテストファイル群を明示)。

**Organization**: タスクは User Story 単位で組織化され、各 Story は独立して実装・テスト・デリバリ可能。

**Remediation note (2026-06-29 `/speckit-analyze` 反映)**:
- I1 dismiss: `templates/skills/{artgraph-coverage,artgraph-integrate,artgraph-plan-coverage,artgraph-rename,artgraph-verify}/SKILL.md` の 5 ファイルが `../_shared/...` を実参照していることをセッション内で grep 確認済。FR-004 / T004 / T011(g) の射程は実在の参照に対する契約として有効。
- C1 反映: T014 (Kiro `--agents=kiro --integrations=kiro` 併用統合テスト) を US1 末尾に新設
- C2 反映: T034 で `git diff main..HEAD` による MCP / Plugin / 非 Claude hooks ファイル不在の grep ステップを追加
- C3 反映: T031 (`artgraph check --gate` non-regression テスト) を US4 末尾に新設
- A1 反映: T005 文面を「reject any non-lowercase, no internal normalization」に明確化

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- 単一パッケージ構成 (constitution §技術基盤と制約): `src/` + `tests/` を repo root 直下に配置
- 新規ディレクトリ: `src/agents/`, `tests/agents/`
- 既存ファイル変更: `src/cli.ts`, `src/init.ts`, `tests/init.test.ts`, `tests/cli.test.ts`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: ディレクトリ構造とテスト fixture の準備

- [ ] T001 Create directories `src/agents/` and `tests/agents/` (mkdir -p, commit `.gitkeep` if needed)
- [ ] T002 [P] Create test fixture helper in `tests/agents/helpers.ts` with utilities: `createFreshProject(): tmpdir`, `readDistributedTree(dir): {paths, sha256}`, `injectMarkerBlock(file, body): void`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全 User Story が依存する基盤 — `AgentDescriptor` table、Skills canonical 走査、`--agents` パーサ、直交ルール

**⚠️ CRITICAL**: User Story 実装は本フェーズ完了後に開始

- [ ] T003 [P] Define `AgentDescriptor` TypeScript type + 5 const table (claude / codex / cursor / copilot / kiro) in `src/agents/descriptors.ts` per data-model.md §1
- [ ] T004 [P] Implement `readSkillSource()` (walk `templates/skills/` recursively, compute sha256 per file using `node:crypto`, return `SkillSource` with `_shared/` included per R1) in `src/agents/source.ts`. **Note (I1 dismissal)**: `_shared/` 配下の 3 ファイル (install-check / output-schema / package-manager) は `templates/skills/{artgraph-coverage,artgraph-integrate,artgraph-plan-coverage,artgraph-rename,artgraph-verify}/SKILL.md` から `../_shared/...` で実参照されることを 2026-06-29 grep で確認済。配布契約は実需に基づく。
- [ ] T005 Implement `--agents=<csv>` flag registration + value validation in `src/cli.ts` init command. Parsing rules per contracts/cli-flags.md: (a) split on `,`、(b) trim whitespace around each element、(c) **reject any non-lowercase input with explicit error** (例: `--agents=Claude` → `ERROR: Unknown agent identifier(s): "Claude". Did you mean "claude"? Supported values: claude, codex, cursor, copilot, kiro.`)、(d) reject duplicates、(e) reject empty elements (trailing/leading comma, empty `--agents=`)、(f) reject unknown agents. **A1 明確化**: パーサは内部 normalize を行わない (大文字小文字は入力時点で reject)。
- [ ] T006 Implement orthogonality rules between `--agents` and existing flags (`--minimal` / `--no-skills` / `--no-agent-context` / `--integrations` / `--force`) in `src/cli.ts` preflight + `src/init.ts` stage gating per FR-013 (3-line error UX with corrective options per SC-006 spec)
- [ ] T007 [P] Unit tests for `AgentDescriptor` table integrity (5 entries, id uniqueness, path consistency) and `readSkillSource()` (sha256 stability, `_shared/` inclusion) in `tests/agents/descriptors.test.ts`
- [ ] T008 [P] Update existing `tests/init.test.ts` and `tests/cli.test.ts` to align with `--agents` required behavior (replace previously-implicit Claude-only paths; expect non-zero exit when `--agents` missing on Skills/agent-context path; remove tests asserting old behavior per spec Assumptions "未リリースのため後方互換は意識しない")

**Checkpoint**: 基盤完成、User Story 実装着手可能

---

## Phase 3: User Story 1 (Priority: P1) 🎯 MVP — Tier 1 エージェント単独で artgraph をネイティブ利用

**Goal**: 5 エージェント (Claude Code / Codex CLI / Cursor / GitHub Copilot / Kiro) いずれの単一識別子に対しても `artgraph init --agents=<one>` で canonical Skills パスへ正しく配布されること。

**Independent Test**: 任意の Tier 1 配布対象エージェント値 (claude/codex/cursor/kiro) で init 実行 → 対応 canonical Skills パス (`.claude/skills/` / `.agents/skills/` / `.cursor/skills/` / `.kiro/skills/`) に `templates/skills/` 配下と byte-equal な SKILL.md + `_shared/` がコピーされている。GitHub Copilot は Skills 配布対象外 (wrapper-only) — `.github/skills/` は作成されず、`.github/copilot-instructions.md` (wrapper) + AGENTS.md 経由でのみ Skill 一覧が伝わる (issue #130) (quickstart.md §1-1, §1-3 で検証)。

### Implementation for User Story 1

- [ ] T009 [US1] Implement `distribute(descriptor: AgentDescriptor, source: SkillSource, opts: {force: boolean}): DistributionTarget[]` in `src/agents/distribute.ts` — per-file copy + post-copy sha256 verify + conflict detection (without `--force` → throw; with `--force` → overwrite artgraph-managed paths, preserve user-managed paths outside)
- [ ] T010 [US1] Wire `distribute()` into `src/init.ts` Skills stage — read `--agents` parsed list from cli.ts, iterate over selected `AgentDescriptor` entries, invoke `distribute()` per agent. Remove old single-Claude `installSkills` direct call (per spec Assumptions: backward compat not required; keep `installSkills` as internal helper only if `distribute()` delegates to it)
- [ ] T011 [P] [US1] Distribution unit tests (parametric over 5 Tier 1 agents) in `tests/agents/distribute.test.ts` — verify (a) all files in `templates/skills/<name>/` + `_shared/` land under `<agent.skillsPath>/<rel_path>`, (b) sha256 byte-equality post-copy, (c) sub-tree structure preserved, (d) idempotent re-run produces no changes, (e) `--force` allows overwrite, (f) conflict (manually edited file) refused without `--force`, (g) `_shared/` is distributed (R1 訂正分)
- [ ] T012 [P] [US1] E2E test `artgraph init --agents=<one>` for each Tier 1 agent in `tests/e2e/init-agents.e2e.test.ts` (uses real `artgraph` CLI via Node spawn, real tmp project)
- [ ] T013 [US1] Add CLI error message tests in `tests/cli-error-messages.test.ts` for `--agents` missing (3 corrective options enumerated per SC-006) and unknown value (supported values list shown per FR-001) — Quickstart §1-3, §1-4. **A1 補強**: 大文字混在 (`--agents=Claude`) を拒否し、エラー文に "Did you mean ...?" を含むことも併せて assert。
- [ ] T014 [P] [US1] **(C1 新設)** Kiro `--agents=kiro` × `--integrations=kiro` 同 init 実行の独立性テストを `tests/agents/kiro-stages.test.ts` に追加: (a) `init --agents=kiro --integrations=kiro` 実行で `.kiro/skills/` と `.kiro/steering/artgraph.md` が両方配置されること、(b) `init --agents=kiro` 単独では `.kiro/steering/` が配置されないこと、(c) `init --integrations=kiro` 単独では `.kiro/skills/` が配置されないこと、(d) 2 stage 並走で一方の失敗が他方をブロックしないこと (Skills stage はファイルシステムエラーで止まっても integrate stage は独立に試行される、または逆)。FR-008 完全カバー。

**Checkpoint**: US1 MVP 完成。5 Tier 1 エージェント単独配布 + Kiro 2 stage 独立併用が動作。`--no-agent-context` 付きで agent-context skip すれば独立で価値あり。

---

## Phase 4: User Story 2 (Priority: P2) — 単一プロジェクト内の複数 Tier 1 エージェント並走

**Goal**: `--agents=<comma-separated-list>` で複数エージェントを一括指定し、各エージェントの canonical Skills パスへ byte-equal な配布が同期される。

**Independent Test**: `init --agents=claude,codex,cursor,kiro` 実行 → 4 配布先 (`.claude/skills/` / `.agents/skills/` / `.cursor/skills/` / `.kiro/skills/`) が `diff -rq` で差分ゼロ。canonical 元を書き換えて `--force` 再実行 → 4 配布先すべてが新内容で同期。GitHub Copilot は Skills 配布対象外 (wrapper-only) — `--agents=...,copilot` を含めても `.github/skills/` は作成されない (issue #130) (quickstart §1-2, §1-5)。

### Implementation for User Story 2

> US2 の実装本体は US1 の `distribute()` が単一/複数エージェントを既に loop で扱うため新規コードなし。テストで多エージェントシナリオを担保する。

- [ ] T015 [P] [US2] Multi-agent distribution test (`--agents=claude,codex,cursor,copilot,kiro --force` → 5 destinations diff-zero between each other, all match canonical sha256) in `tests/agents/distribute-multi.test.ts`
- [ ] T016 [P] [US2] Incremental addition test (init `--agents=claude` → init `--agents=claude,codex --force` → claude tree unchanged, codex tree newly populated) in `tests/agents/distribute-multi.test.ts`
- [ ] T017 [P] [US2] Canonical edit propagation test (modify `templates/skills/artgraph-impact/SKILL.md` bytes, re-init `--force` with 5 agents, verify all 5 destinations reflect change) in `tests/agents/distribute-multi.test.ts`

**Checkpoint**: US1 + US2 完成。チームで複数エージェント混在 + canonical 単一真実の運用が可能。

---

## Phase 5: User Story 3 (Priority: P2) — agent-context の AGENTS.md 一元化と薄ラッパー方式

**Goal**: AGENTS.md を canonical 本文とし、`CLAUDE.md` および `.github/copilot-instructions.md` は `@AGENTS.md` 取り込みのみの薄ラッパー。本文の二重コピーゼロ。

**Independent Test**: `init --agents=claude,copilot` 実行 → AGENTS.md に artgraph セクション本文 / CLAUDE.md と `.github/copilot-instructions.md` に `@AGENTS.md` 参照のみ。`init --agents=codex,cursor,kiro` 実行 → AGENTS.md のみ生成、ラッパー 0 件 (quickstart にて diff 検証)。

### Implementation for User Story 3

- [ ] T018 [US3] Implement marker block parser/writer using regex `/<!--\s*artgraph:begin\s*-->[\s\S]*?<!--\s*artgraph:end\s*-->/` in `src/agents/agent-context.ts` per contracts/agent-context-format.md (find-or-append pattern, atomic write via tmp+rename)
- [ ] T019 [US3] Implement AGENTS.md canonical body builder (8 Skills 一覧 + common workflows + quickstart 抜粋、本文は contracts/agent-context-format.md §AGENTS.md セクション参照) in `src/agents/agent-context.ts`
- [ ] T020 [US3] Implement wrapper builders for `CLAUDE.md` (repo-root `[AGENTS.md](./AGENTS.md)` + `@AGENTS.md` literal) and `.github/copilot-instructions.md` (`[AGENTS.md](../AGENTS.md)` + `@AGENTS.md`) in `src/agents/agent-context.ts`; create `.github/` dir if absent
- [ ] T021 [US3] Wire agent-context distribution into `src/init.ts` (called after Skills stage when `--no-agent-context` not set) — always write AGENTS.md; write CLAUDE.md only when `claude ∈ --agents`; write `.github/copilot-instructions.md` only when `copilot ∈ --agents`
- [ ] T022 [P] [US3] Tests for agent-context in `tests/agent-context.test.ts` — marker block idempotent replace + user content preservation + AGENTS.md body content + selective wrapper generation (claude → CLAUDE.md only / copilot → copilot-instructions.md only / codex+cursor+kiro 単独 → no wrapper) + `@AGENTS.md` literal presence in wrappers
- [ ] T023 [P] [US3] E2E test `artgraph init --agents=claude,copilot` verifies AGENTS.md body length > N + CLAUDE.md and copilot-instructions.md wrapper presence (no body duplication: line count ≤ ~10 in wrapper) in `tests/e2e/agent-context.e2e.test.ts`

**Checkpoint**: US1 + US2 + US3 完成。agent-context 一元管理が動作、SC-003 (本文重複ゼロ) を満たす。

---

## Phase 6: User Story 4 (Priority: P3) — doctor で配布物の健全性を診断

**Goal**: `artgraph doctor` 新サブコマンドで Tier 1 配布物の drift / 欠落 / 不整合を診断。text と JSON の両形式で出力、PASS = exit 0、1 件以上 FAIL = 非 0。

**Independent Test**: `init --agents=claude,codex` 後 `doctor` 実行 → 全 PASS / exit 0。配布先 SKILL.md を 1 byte 改竄 → `skill-file-drift` FAIL / exit 非 0。CLAUDE.md ラッパーから `@AGENTS.md` 削除 → `wrapper-no-import` FAIL (quickstart §3)。

### Implementation for User Story 4

- [ ] T024 [US4] Define `DoctorFinding` type + `DoctorFindingKind` enum (`skill-file-present` / `skill-file-missing` / `skill-file-drift` / `agents-md-present` / `agents-md-missing` / `agents-md-marker-broken` / `wrapper-present` / `wrapper-missing` / `wrapper-no-import` / `extraneous-file`) in `src/doctor.ts` per data-model.md §5 and contracts/doctor-output.md
- [ ] T025 [US4] Implement doctor scan engine in `src/doctor.ts` — auto-detect configured agents by scanning known canonical paths (`.claude/skills/` etc.), for each detected agent diff against canonical via sha256, emit `DoctorFinding[]` (including `extraneous-file` for residue cleanup detection)
- [ ] T026 [US4] Implement text formatter (per-agent grouped pass/fail count, FAIL details with expected/actual sha256) in `src/doctor.ts` per contracts/cli-flags.md §text 出力例
- [ ] T027 [US4] Implement JSON formatter (`{version: 1, summary: {...}, findings: [...]}`) in `src/doctor.ts` per contracts/doctor-output.md schema
- [ ] T028 [US4] Register `artgraph doctor` subcommand in `src/cli.ts` with options `--agents=<csv>` (filter, optional; default = all detected) and `--format=<text|json>` (default text); exit code: 0 if all `severity === "pass"` or `findings.length === 0`, non-zero otherwise
- [ ] T029 [P] [US4] Test suite for doctor in `tests/doctor.test.ts` — covers PASS path (healthy project) + FAIL paths (drift / wrapper-missing / wrapper-no-import / marker-broken / extraneous-file / skill-file-missing) + empty project (0 distributions → exit 0) + JSON schema conformance (validate against contracts/doctor-output.md)
- [ ] T030 [P] [US4] E2E test `artgraph doctor` (quickstart §3-1 〜 §3-6 シナリオ) in `tests/e2e/doctor.e2e.test.ts`
- [ ] T031 [P] [US4] **(C3 新設)** `artgraph check --gate` non-regression test in `tests/check-gate-no-regression.test.ts` — assert that gate command's stdout / stderr / exit code are **unchanged** by the presence of spec 013 Tier 1 distributions (`.claude/skills/` 等の存在 / 不在で gate 出力に差分ゼロ)。FR-012 後段「doctor を gate に組み込まない」の non-regression を保証。spec 012 baseline (`tests/check.test.ts` 既存) のスナップショット流用または明示 assertion。

**Checkpoint**: 全 User Story 完成。spec 013 のすべての機能が動作、`check --gate` 既存挙動の non-regression も保証。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: ドッグフーディング、ドキュメント整備、最終整合チェック

- [ ] T032 Dogfood — run `artgraph init --agents=claude,codex,cursor,kiro --force` in artgraph repo itself (verify SC-008). Commit resulting `.claude/skills/` + `.agents/skills/` + `.cursor/skills/` + `.kiro/skills/` + `AGENTS.md` + `CLAUDE.md` + `.github/copilot-instructions.md` to demonstrate the feature working end-to-end on the canonical reference project. (Copilot は issue #130 で Skills 配布対象外に変更 — wrapper-only: `.github/skills/` は生成しない)
- [ ] T033 [P] Update `README.md` to document: (a) `--agents=<list>` required flag with 5 supported values, (b) Tier 1 agent list with canonical paths table (copy from contracts/distribution-paths.md), (c) new `artgraph doctor` subcommand with usage example
- [ ] T034 Run `artgraph check --diff` for spec/code/test consistency self-check (catches missed `@impl FR-NNN` claims). **(C2 補強)** さらに以下を 1 コマンドで実行し、SC-007 (MCP / Plugin / 非 Claude hooks 不在) を機械化検証する:
  ```bash
  git diff origin/main..HEAD -- ':!specs/013-cross-agent-extensions/**' | \
    grep -nE '(mcp[-_]server|\.claude-plugin|\.codex-plugin|\.cursor-plugin|\.codex/hooks|\.cursor/hooks|kiro.*hook)' \
    && echo "SCOPE VIOLATION: file matches spec 013 scope-out list" && exit 1 || echo "scope-out OK"
  ```
  該当ファイルが PR diff に出現したら exit 1。spec 内 (specs/013-*) は除外 (research.md 等は scope-out を引用するのが正当)。
- [ ] T035 [P] Update `docs/architecture.md` §7 (CLI/MCP surface plan) to reference spec 013 for the "MCP server remained out of scope, Skills + AGENTS.md chosen instead" decision. Add 1 paragraph cross-link to spec 013.
- [ ] T036 Run `artgraph doctor` against artgraph repo (post T032) to verify all 5 Tier 1 distributions report PASS
- [ ] T037 Manually walk through quickstart.md §1 (all sub-sections) and §3 as final acceptance check. §2 (per-agent 実機 smoke) is deferred to PR reviewers with the appropriate agent environments — list in PR description. **(C2 補強)** PR description に scope-out 確認チェックリスト (MCP 実装ゼロ / Plugin manifest ゼロ / 非 Claude hooks ゼロ) を箇条書きで明記。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: 依存なし、即着手可能
- **Phase 2 (Foundational)**: Phase 1 完了後。全 User Story を block
- **Phase 3 (US1, P1)**: Phase 2 完了後、最優先
- **Phase 4 (US2, P2)**: Phase 3 の T009-T010 完了後 (US1 の `distribute()` を US2 のテストが利用)
- **Phase 5 (US3, P2)**: Phase 2 完了後、US1/US2 と並行可能 (異なるファイル `src/agents/agent-context.ts`)
- **Phase 6 (US4, P3)**: US1 + US3 完了後 (doctor が両方の配布物を診断するため)。T031 (check --gate non-regression) は spec 013 配布物が無くても実行可能なため US1 と並行可
- **Phase 7 (Polish)**: 全 User Story 完了後

### User Story Dependencies (詳細)

- **US1 (P1)**: Foundational 完了後、独立実装可能。MVP 単独で価値あり (Skills 配布のみ)。T014 (Kiro併用) は既存 `KiroProvider` (spec 009) の挙動を変更しない前提なので、Phase 2 の T006 (orthogonality) 完了直後に実行可
- **US2 (P2)**: US1 の `distribute()` 実装に依存 (テストが利用するため)。実装本体は US1 で完結、US2 は **テストのみ追加**
- **US3 (P2)**: US1 と並行可能 (`src/agents/agent-context.ts` は新ファイル、`init.ts` 統合点が US1 と US3 で異なる箇所)
- **US4 (P3)**: US1 (Skills 配布物) + US3 (AGENTS.md / wrappers) の両方の配布物を診断対象とするため、両者完了後。T031 (gate non-regression) のみ独立に先行可能

### Within Each User Story

- 実装タスク (T009, T018, T024 等) → テストタスク (T011, T022, T029) の順、または並行
- 同一ファイルを触るタスクは sequential、異なるファイルなら [P]
- E2E テスト (T012, T023, T030) は実装完了後

### Parallel Opportunities

- **Phase 2 内**: T003 (descriptors) と T004 (source) は別ファイル → [P]。T007/T008 (tests) も [P]
- **Phase 3 内**: T011 / T012 / T013 / T014 はテスト用の別ファイル → [P]
- **Phase 4 全タスク**: 同じ `distribute-multi.test.ts` のシナリオ追加なので **逐次推奨** (マージ競合回避)、または別ファイル分割
- **Phase 5 内**: T022 / T023 は別テストファイル → [P]
- **Phase 6 内**: T029 / T030 / T031 は別テストファイル → [P]
- **US1 と US3 を異なる開発者で並行**: `src/agents/distribute.ts` と `src/agents/agent-context.ts` が独立、`src/init.ts` 統合は最後にマージ
- **Phase 7 内**: T033 / T035 は別ドキュメント → [P]

---

## Parallel Example: User Story 1 (MVP)

```bash
# Foundational 完了後、US1 実装着手:
# T009 完了を待ち、その後 T010 (init.ts 統合) と T011-T014 (tests) は並行可能
# T011, T012, T013, T014 は別ファイルなので concurrent 実行:
Task: "Distribution unit tests in tests/agents/distribute.test.ts"
Task: "E2E test in tests/e2e/init-agents.e2e.test.ts"
Task: "CLI error message tests in tests/cli-error-messages.test.ts"
Task: "Kiro --agents/--integrations stages test in tests/agents/kiro-stages.test.ts"
```

## Parallel Example: User Story 3 (並行可能な独立モジュール)

```bash
# US1 着手と並行して US3 着手可能 (異なるファイル):
# Developer A: src/agents/distribute.ts (US1)
# Developer B: src/agents/agent-context.ts (US3)
# 統合は src/init.ts の最終 merge ステップで実施
```

---

## Implementation Strategy

### MVP First (US1 のみ)

1. Phase 1 Setup 完了
2. Phase 2 Foundational 完了 (`--agents` パーサ + 直交ルール + descriptors table + source walker)
3. Phase 3 US1 完了 (5 エージェント単独配布 + Kiro 2 stage 独立併用が動作)
4. **STOP & VALIDATE**: quickstart §1-1, §1-3, §1-4 を手動実行、Claude Code で `--agents=claude` の実機 smoke 確認
5. Demo: 「Codex CLI ユーザーが `--agents=codex` で artgraph Skills を使えるようになった」をデモ可能

### Incremental Delivery

1. Phase 1 + 2 + 3 → MVP リリース可能 (US1 単独で価値あり、Skills 配布のみ)
2. Phase 4 (US2) → 多エージェント同期配布デモ
3. Phase 5 (US3) → agent-context 一元化、SC-003 達成
4. Phase 6 (US4) → doctor 診断 + gate non-regression 確認、運用 health 確認手段
5. Phase 7 → ドッグフーディング + ドキュメント整備 + scope-out 機械化検証 → PR レビュー完了 → merge

### Parallel Team Strategy

複数開発者の場合:

1. Phase 1 + 2 を 1 人で集中完了 (基盤の整合性確保)
2. Phase 2 完了後の並行:
   - Developer A: Phase 3 (US1) → Phase 4 (US2) → Phase 6 (US4) (Skills + doctor 系列)
   - Developer B: Phase 5 (US3) (agent-context 系列、独立モジュール)
3. Phase 7 (Polish) は全完了後にまとめて実施

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label = US1/US2/US3/US4 (spec.md User Story と 1:1 対応)
- 各 User Story は independent completable / testable (spec User Story の Independent Test に対応)
- Commit 単位: タスク 1 件または論理グループ (T011-T014 を 1 commit 等)
- 各 Checkpoint で立ち止まり、独立価値を validate してから次 Story へ
- 避けるべきこと: vague tasks / same-file conflicts / cross-story dependencies that break independence
- 「未リリースのため後方互換は意識しない」 (spec Assumptions) のため、T008 / T010 では既存テスト/実装の **削除**を躊躇しない
- `/speckit-analyze` 指摘 5 件 (C1 / C2 / C3 / A1 / I1) は本タスク一覧に反映済 (Remediation note 参照)
