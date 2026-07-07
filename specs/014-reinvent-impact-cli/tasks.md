---
description: "Task list for 014-reinvent-impact-cli — impact CLI file-only 化 + plan-coverage 新設"
---

# Tasks: impact CLI 再設計 + plan-coverage 新設

**Input**: Design documents from `/specs/014-reinvent-impact-cli/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [contracts/](./contracts/)

**Tests**: TDD per established project convention (spec 012 と同じ規律 — write test first, ensure it fails, then implement).

**Organization**: Phases map to plan.md の internal phases (0–6). 単一 PR でロックステップ merge する(spec.md Assumptions の通り — US2 / US3 / US1 を分離するとリリース中間状態で Skill と CLI が整合しない時間が発生)。

**Self-dogfooding**: 本 tasks.md は自分自身で `Files:` セクション + REQ-ID mention 規約を採用している。spec 完了後に `artgraph plan-coverage --spec specs/014-reinvent-impact-cli/` を本 tasks.md に対して走らせ、暗黙波及がゼロであることを T026 で検証する。

## Format

各タスクは `### T<NNN> [P?] [Story] 概要 [FR-IDs]` の heading + 直後に `Files:` 行 + 任意で実装メモ。

- **[P]**: 同 phase 内で並列実行可能(touch する file が独立)
- **[Story]**: マップする user story(US1〜US6)
- **[FR-IDs]**: 対応する Functional Requirement(plan-coverage の mention 検出対象)

## Path Conventions

Single project(plan.md Project Structure):
- Source: `src/`
- Tests: `tests/`
- Templates: `templates/`
- Docs: `docs/`
- Worktree root: `/home/morimoto-s1/reinvent-impact-cli/`

---

## Phase 1: Setup

### T001 [Setup] Verify dev environment

Files: (no source changes)  
Requires: (prerequisite check only)

Node >= 22 active (`node -v`)、pnpm available、working tree clean、on branch `feat/reinvent-impact-cli`、`.specify/feature.json#feature_directory` が `specs/014-reinvent-impact-cli` を指している(必要なら update)。

---

## Phase 2: Foundational — Shared file-extraction parser

**⚠️ CRITICAL**: Phase 3 (US2 impact 改修) と Phase 4 (US1 plan-coverage) の両方が依存する共通基盤。先に完成させる。

### T002 [P] [US1, US2] Write tests/sdd-files-parser.test.ts [FR-005]

Files: tests/sdd-files-parser.test.ts

[contracts/sdd-files-parser.md](./contracts/sdd-files-parser.md) のエッジケース表を fixture 化。Stage A(`Files:` セクション・inline / bullet / 混在)、Stage B(regex フォールバック・validation)、ゼロ件抽出時のエラー、`unresolvedFilePath` diagnostic、絶対 path スキップ、URL / HTML タグ誤検出回避、dedup を網羅。

### T003 [US1, US2] Implement src/parsers/sdd-files.ts [FR-005]

Files: src/parsers/sdd-files.ts

[contracts/sdd-files-parser.md](./contracts/sdd-files-parser.md) を実装。`extractFiles(text, { graph, repoRoot }): ExtractResult` をエクスポート。Stage A 優先 → 抽出ゼロ時のみ Stage B、両方ゼロなら呼び出し側がエラーを出せるよう `stage: "empty"` を返す。T002 が green になることを確認。

**Checkpoint**: Phase 3 と Phase 4 が並列着手可能。

---

## Phase 3: P1 — US2 impact CLI file-only 化

**Goal**: `artgraph impact` を file-only に絞り、`--from-tasks` / `--from-plan` を追加、REQ-ID 入力時の専用エラーを実装。

### T004 [P] [US2] Write tests/impact-cli.test.ts updates [FR-001, FR-003]

Files: tests/impact-cli.test.ts

(a) `artgraph impact REQ-001` が exit 1 + 4 経路案内エラー、(b) `artgraph impact doc:specs/foo.md` も同様、(c) `artgraph impact src/auth.ts` は既存通り動作、(d) `[targets...]` / `--from-tasks` / `--diff` の mutually exclusive 違反でエラー、(e) 全フラグ不在で「no targets」エラー。

### T005 [P] [US2] Write integration test for --from-tasks / --from-plan [FR-004, FR-006]

Files: tests/impact-cli.test.ts (同 file、T004 と sequential)

Spec Kit 風 fixture(spec dir + tasks.md with `Files:` セクション)で `artgraph impact --from-tasks <fixture>/tasks.md --format json` が期待 file 群から impact を計算する。Stage A 採用パスと Stage B fallback パス両方の E2E。

### T006 [US2] Rename resolveStartIds → resolveFileStartIds [FR-002, FR-008]

Files: src/graph/traverse.ts

REQ-ID 解決パス(`graph.nodes.has(input)` のうち REQ ノードへの直接マッチ)と `doc:` prefix 解決パスを削除。file path 解決のみに絞る。call sites(`src/cli.ts` の impact / check / 他)を更新。`impact()` 関数本体(`src/graph/traverse.ts:11`)には**触らない**(FR-008 — plan-coverage 側でも同じシグネチャで再利用するため)。

### T007 [US2] Update src/cli.ts impact subcommand [FR-001, FR-003, FR-004, FR-006, FR-007]

Files: src/cli.ts

[contracts/cli-flags.md](./contracts/cli-flags.md) `artgraph impact` 節を実装: (a) `[targets...]` の REQ-ID 風入力(`/^[A-Z]+-\d+$/`)を専用エラーで弾く、(b) `--from-tasks <path>` / `--from-plan <path>` フラグ追加、(c) 4 起点経路の mutually exclusive 検証、(d) `--diff` / `--depth` / `--format` / `--mode` は据え置き。エラー文面は contract 通り(4 経路案内含む)。

### T008 [US2] Verify T004 / T005 green

Files: tests/impact-cli.test.ts

`pnpm test tests/impact-cli.test.ts` が all green。`pnpm test` 全体で他テストへの regression がないことも確認。

---

## Phase 4: P1 — US1 plan-coverage CLI 新設

**Goal**: 新 CLI `artgraph plan-coverage` を [contracts/](./contracts/) 通りに実装。

### T009 [P] [US1] Write tests/mention-detector.test.ts [FR-020]

Files: tests/mention-detector.test.ts

[contracts/mention-semantics.md](./contracts/mention-semantics.md) Test 戦略 8 項目を fixture 化。境界マッチの正例(8 件)+ 反例(7 件)+ 複数 source 結合 + ラベル無依存 + 大文字小文字 + 同 REQ 複数マッチ + ハイフン拡張命名。

### T010 [P] [US1] Implement src/plan-coverage/mention.ts [FR-020]

Files: src/plan-coverage/mention.ts

[contracts/mention-semantics.md](./contracts/mention-semantics.md) のアルゴリズム実装。`detectMentions(affectedReqIds, sources): { mentioned, implicit }` を export。境界マッチは `(?<![A-Za-z0-9_])<ID>(?![A-Za-z0-9_])`。

### T011 [P] [US1] Implement src/plan-coverage/spec-resolver.ts [FR-014]

Files: src/plan-coverage/spec-resolver.ts, tests/plan-coverage-resolver.test.ts

`resolveSpecDir({ explicitFlag, env, fs }): string | Error` を export。順序: (1) `--spec` 明示、(2) `SPECIFY_FEATURE_DIRECTORY` env、(3) `.specify/feature.json#feature_directory`、(4) 失敗時は Kiro `--spec` 案内メッセージ付きエラー。テストは各分岐 + Kiro env での失敗 + 不正 JSON 耐性。

### T012 [P] [US1] Add planCoverage section to src/config.ts [FR-018]

Files: src/config.ts, tests/config.test.ts

`.artgraph.json` schema に `planCoverage: { requireFilesSection?: boolean }`(デフォルト `false`)を追加。後方互換は不要(未リリース)。

### T013 [US1] Write tests/plan-coverage.test.ts [FR-013〜FR-020]

Files: tests/plan-coverage.test.ts

`plan-coverage` 主処理の単体・統合テスト: (a) impact() 呼び出しと affectedReqs 取得、(b) mention 引算で implicitImpacts 算出、(c) `--ignore` フィルタ、(d) `--gate` exit code、(e) `--require-files-section` 診断、(f) `diagnostics[]` 出力、(g) JSON output が [contracts/plan-coverage-json.md](./contracts/plan-coverage-json.md) と一致(top-level に `implicitImpacts` と `implicitImpactsByReq` の **両軸が並ぶ**こと)、(h) by-FR 軸の inversion が正しい(同 REQ が複数 sourceFile から来る場合 `sourceFiles` が両方含む)、(i) `summary.implicit == implicitImpactsByReq.length` の不変条件、(j) text 出力が by-file / by-FR の両 view を含む。

### T014 [US1] Implement src/plan-coverage/index.ts [FR-013, FR-015, FR-016, FR-017, FR-019]

Files: src/plan-coverage/index.ts

主処理: (a) `spec-resolver` で spec dir 確定、(b) tasks.md / plan.md を読んで `extractFiles` で file 群取得、(c) その file 群を startIds に `impact(graph, fileStartIds, lock)` 呼び出し、(d) `affectedReqs` を `detectMentions` で振り分け、(e) `--ignore` で除外、(f) `--require-files-section` ON 時に task block の Files: 有無検査(Stage A の by-product として `sdd-files.ts` から task block の境界情報を返してもらう拡張が必要 — `extractFiles` の戻り値拡張で対応)、(g) **by-sourceFile 軸 (`implicitImpacts`) と by-FR 軸 (`implicitImpactsByReq`) の両ビューを構築**(後者は前者の inversion: REQ→sourceFile[] の map 化、dedup + sort)、(h) JSON / text 整形して stdout(text は両ビュー併記)。

### T015 [US1] Add plan-coverage subcommand to src/cli.ts [FR-013]

Files: src/cli.ts

Commander に `plan-coverage` を追加。全フラグ([contracts/cli-flags.md](./contracts/cli-flags.md))を declare、`src/plan-coverage/index.ts` の主処理を呼ぶ。exit code テーブル通りに分岐。

### T016 [US1] Verify T013 green

Files: tests/plan-coverage.test.ts

`pnpm test tests/plan-coverage.test.ts` all green。

---

## Phase 5: P1 — US3 `artgraph-impact` Skill 正直化

**Goal**: spec 012 で配備した SKILL.md から誇大表現を削除し、`--from-tasks` 経路を追記。

### T017 [P] [US3] Update templates/skills/artgraph-impact/SKILL.md [FR-009, FR-010, FR-011, FR-012]

Files: templates/skills/artgraph-impact/SKILL.md

frontmatter `description` から `planning` / `designing` / `scoping` の語を削除し、「file 起点 forward 波及分析」だけを約束する文面に。Mode (b) の REQ-ID 抽出指示を削除し file path / `--from-tasks` 経路のみに。Mode (c) の質問文を `"Which tasks.md / plan.md path, or which file(s) should I analyze?"` に。本文末尾に `artgraph impact --from-tasks specs/<latest>/tasks.md` の使用例を追記。

### T018 [P] [US3] Extend tests/skills-templates.test.ts [FR-009]

Files: tests/skills-templates.test.ts

`artgraph-impact/SKILL.md` の description で `planning` / `designing` / `scoping` (case-insensitive) が **0 件** であることを assert(SC-005)。

---

## Phase 6: P2 — US4 `artgraph-plan-coverage` Skill 新設

**Goal**: 新 Skill を配布物に追加。

### T019 [P] [US4] Create templates/skills/artgraph-plan-coverage/SKILL.md [FR-021, FR-022, FR-023]

Files: templates/skills/artgraph-plan-coverage/SKILL.md

英語で 100 行以下、`_shared/install-check.md` 参照。description は `"Detects implicit impacts: files declared in tasks.md may affect existing REQs that are not mentioned in tasks.md / spec.md. Run after /speckit-tasks or before /speckit-implement."` 基調。`allowed-tools: ["Bash(npx artgraph plan-coverage *)", "Bash(artgraph plan-coverage *)"]`。本文は input mode(`--spec` 自動 / 明示)、出力解釈、検知後 3 経路(mention 追加 / `--ignore` / 将来 strict)の指示を含む。

### T020 [P] [US4] Extend tests/skills-templates.test.ts for new Skill [FR-022]

Files: tests/skills-templates.test.ts

`artgraph-plan-coverage/SKILL.md` も既存メタ規約(100 行 / `_shared` 参照 / `allowed-tools` 形式 / 英語)に従うことを assert(SC-006)。

### T021 [US4] Verify init deploys the new Skill [FR-024]

Files: tests/init.test.ts

`artgraph init`(default full setup)実行後、`.claude/skills/artgraph-plan-coverage/SKILL.md` が配備されることを E2E test で確認(SC-007)。

---

## Phase 7: P2 — US5 SDD 統合テンプレ強化

**Goal**: Spec Kit / Kiro 統合テンプレに `Files:` 規約と REQ-ID mention 規約の **推奨** を追記。enforcement は spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) で扱う。

### T022 [P] [US5] Update templates/integrate/speckit/README.md [FR-025, FR-027]

Files: templates/integrate/speckit/README.md

`tasks.md / plan.md` の各タスクに `Files: <path>, <path>` セクションを書く推奨と、`plan-coverage` で出た暗黙波及 REQ を tasks.md / plan.md / spec.md のいずれかで mention する推奨(ラベル形式自由)を追記。`/speckit-tasks` 出力に対する `artgraph plan-coverage` 実行を after_tasks ワークフローの推奨手順として記述。enforcement (Stop hook / before_implement gating) は本 spec 対象外、[issue #105](https://github.com/ShintaroMorimoto/artgraph/issues/105) を脚注で参照する(FR-027)。

### T023 [P] [US5] Update templates/integrate/kiro/artgraph.md [FR-026]

Files: templates/integrate/kiro/artgraph.md

T022 と同等のガイダンスを Kiro 向けに記述。Kiro 利用時の `artgraph plan-coverage --spec .kiro/specs/<name>/` 必須(canonical current spec 指標が存在しない)も明記。

---

## Phase 8: P3 — US6 ドキュメント更新

**Goal**: ユーザー向けドキュメントを新設計に同期。

### T024 [P] [US6] Update docs/skills-guide.md [FR-028, FR-029]

Files: docs/skills-guide.md

`artgraph-impact` 節を file-only / `--from-tasks` 説明に改訂。`artgraph-plan-coverage` 節を新規追加(検知後 3 経路の説明含む)。Skills 一覧表を 8 種に。

### T025 [P] [US6] Update README.md Skills table [FR-030]

Files: README.md

Skills 表を 7 → 8 種に更新(`artgraph-plan-coverage` 追加)。

---

## Phase 9: E2E + Self-Dogfooding

**Goal**: 全 SC を fixture と self-application で確認。

### T026 [E2E] Write tests/plan-coverage-integration.test.ts [SC-001〜SC-010]

Files: tests/plan-coverage-integration.test.ts

Spec Kit 風 fixture spec dir で E2E: (a) auto-detect via `SPECIFY_FEATURE_DIRECTORY`、(b) auto-detect via `.specify/feature.json`、(c) `--spec` 明示、(d) Kiro 風 dir で auto-detect 失敗エラー、(e) `--gate` × `--ignore` 全組合せの exit code、(f) `--require-files-section` ON / OFF の diagnostics 差分。

### T027 [E2E] Self-dogfood: run plan-coverage on this spec

Files: (verification only — specs/014-reinvent-impact-cli/)

`artgraph plan-coverage --spec specs/014-reinvent-impact-cli/` を実行し、暗黙波及 REQ がゼロであることを確認(本 tasks.md は全 FR を mention 済みかつ Files: セクション完備のため)。出力結果を PR description にスクリーンショット付きで添付。

### T028 [E2E] Verify all SC-XXX + Constitution + test coverage [FR-031, FR-032]

Files: (verification only)

[spec.md](./spec.md) Success Criteria SC-001〜SC-010 を 1 件ずつ手動 / 自動で確認。`docs/skills-guide.md` と `README.md` の 8 種掲載は peer review (SC-010)。Constitution Check 5 原則がすべて維持されていることを再確認(FR-031 — `plan-coverage` の読み取り専用性、graph / lock 書込なし、決定的境界マッチ)。新機能全項目が vitest で carry されていることを確認(FR-032 — `pnpm test` 全件 green)。

---

## Dependency summary

```
T001 (setup)
  ↓
T002, T003 (sdd-files parser)
  ↓
  ├─ T004, T005 → T006, T007 → T008  (Phase 3: impact CLI)
  └─ T009, T010, T011, T012 → T013 → T014, T015 → T016  (Phase 4: plan-coverage)
        ↓
        T017, T018  (Phase 5: impact Skill)
        T019, T020, T021  (Phase 6: plan-coverage Skill)
        T022, T023  (Phase 7: SDD templates)
        T024, T025  (Phase 8: docs)
        ↓
        T026, T027, T028  (Phase 9: E2E)
```

並列実行可能(`[P]` マーク):
- T002 と T003: T002 を先に書いて red → T003 で green の TDD 順序のため逐次
- T004 と T005 は同 file (`tests/impact-cli.test.ts`) なので逐次
- T009 / T010 / T011 / T012 は file 独立で並列
- T017 / T018, T019 / T020, T022 / T023, T024 / T025 は各ペア並列
- Phase 5–8 は Phase 4 (plan-coverage CLI) 完成後すべて並列

LOC 見積(plan.md より): 600–900 LOC(うちテスト半分)。

---

## Considered: cross-spec / collision-qualified impacts

**Why this section exists** (T027 dogfooding finding): the graph builder
qualifies a REQ-ID as `<specDir>/<id>` when the bare `<id>` appears in
multiple spec dirs (`src/graph/builder.ts:idMapping`). E.g. `FR-001` exists
in both `006-test-results` and `014-reinvent-impact-cli`, so both get
rewritten to `006-test-results/FR-001` and `014-reinvent-impact-cli/FR-001`.
The bare `[FR-001]` mentions in the task headings above satisfy the
human-reader contract, but `detectMentions` does an exact, boundary-anchored
match against graph IDs — so the qualified forms also need to be referenced
verbatim somewhere in the source trio for the mention detector to clear them.

Each entry below is an explicit acknowledgement that the REQ is reached via
`impact()` from this spec's modified files AND that the impact is intentional
(either because the REQ belongs to spec 014 itself, or because the
shared-CLI surface — `src/cli.ts`, `src/config.ts`, etc. — legitimately
co-implements REQs from other specs that we do not modify in this PR).

### Spec 014 own REQs (qualified due to collision with earlier specs)

These REQs ARE the work of this spec. The bare `FR-XXX` / `SC-XXX` mentions
above remain authoritative for human readers; the qualified forms below
exist purely to satisfy the deterministic detector.

- Considered: 014-reinvent-impact-cli/FR-002 — implemented via T006
- Considered: 014-reinvent-impact-cli/FR-003 — implemented via T007
- Considered: 014-reinvent-impact-cli/FR-004 — implemented via T007
- Considered: 014-reinvent-impact-cli/FR-005 — implemented via T002 / T003
- Considered: 014-reinvent-impact-cli/FR-006 — implemented via T007
- Considered: 014-reinvent-impact-cli/FR-007 — implemented via T007
- Considered: 014-reinvent-impact-cli/FR-008 — implemented via T006 (unchanged)
- Considered: 014-reinvent-impact-cli/FR-009 — implemented via T017
- Considered: 014-reinvent-impact-cli/FR-010 — implemented via T017
- Considered: 014-reinvent-impact-cli/FR-011 — implemented via T017
- Considered: 014-reinvent-impact-cli/FR-012 — implemented via T017
- Considered: 014-reinvent-impact-cli/FR-013 — implemented via T015
- Considered: 014-reinvent-impact-cli/FR-014 — implemented via T011
- Considered: 014-reinvent-impact-cli/FR-015 — implemented via T014
- Considered: 014-reinvent-impact-cli/FR-016 — implemented via T014
- Considered: 014-reinvent-impact-cli/FR-017 — implemented via T014 / T015
- Considered: 014-reinvent-impact-cli/FR-018 — implemented via T012 / T014
- Considered: 014-reinvent-impact-cli/FR-019 — implemented via T014 / T015
- Considered: 014-reinvent-impact-cli/FR-020 — implemented via T010
- Considered: 014-reinvent-impact-cli/FR-021 — implemented via T019
- Considered: 014-reinvent-impact-cli/FR-022 — implemented via T019
- Considered: 014-reinvent-impact-cli/FR-023 — implemented via T019
- Considered: 014-reinvent-impact-cli/FR-024 — implemented via T021
- Considered: 014-reinvent-impact-cli/FR-025 — implemented via T022
- Considered: 014-reinvent-impact-cli/FR-026 — implemented via T023
- Considered: 014-reinvent-impact-cli/FR-027 — out-of-scope marker (see #105)
- Considered: 014-reinvent-impact-cli/FR-028 — implemented via T024
- Considered: 014-reinvent-impact-cli/FR-029 — implemented via T024
- Considered: 014-reinvent-impact-cli/FR-030 — implemented via T025 (collision with 016/FR-030 introduced post-merge by spec 016; bare `FR-030` mention at T025 heading authoritative for humans)
- Considered: 014-reinvent-impact-cli/FR-031 — verified via T028 (collision with 016/FR-031 introduced post-merge by spec 016; bare `FR-031` mention at T028 heading authoritative for humans)
- Considered: 014-reinvent-impact-cli/SC-001 — verified via existing tests/impact-cli.test.ts (T004)
- Considered: 014-reinvent-impact-cli/SC-002 — verified via tests/sdd-files-parser.test.ts (T002) + tests/impact-cli.test.ts (T005)
- Considered: 014-reinvent-impact-cli/SC-003 — verified via tests/plan-coverage.test.ts (T013) + tests/plan-coverage-integration.test.ts (T026)
- Considered: 014-reinvent-impact-cli/SC-004 — verified via tests/mention-detector.test.ts (T009)
- Considered: 014-reinvent-impact-cli/SC-005 — verified via tests/skills-templates.test.ts (T018)
- Considered: 014-reinvent-impact-cli/SC-006 — verified via tests/skills-templates.test.ts (T020)
- Considered: 014-reinvent-impact-cli/SC-007 — verified via tests/init.test.ts (T021)
- Considered: 014-reinvent-impact-cli/SC-008 — verified via tests/plan-coverage-integration.test.ts (T026 — gate × ignore matrix)
- Considered: 014-reinvent-impact-cli/SC-009 — verified via tests/plan-coverage-integration.test.ts (T026 — require-files-section toggle)
- Considered: 014-reinvent-impact-cli/SC-010 — peer review on docs/skills-guide.md + README.md (T024 / T025)

### Cross-spec REQs reached via shared CLI surface

These REQs belong to spec **006-test-results** and are reached because
`src/cli.ts` registers BOTH spec 006's `--test-results` flag handling and
spec 014's new `plan-coverage` subcommand on the same Commander tree.
Modifying `src/cli.ts` necessarily forwards-touches the test-results impl
edges. No behavioural change to spec 006 is intended in this PR — the
mentions below are bookkeeping only.

- Considered: 006-test-results/FR-002 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-003 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-004 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-005 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-006 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-007 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-008 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-009 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-010 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-011 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/FR-012 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-001 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-002 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-003 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-004 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-005 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-006 — pre-existing test-results infrastructure, no behaviour change
- Considered: 006-test-results/SC-007 — pre-existing test-results infrastructure, no behaviour change

### Cross-spec REQs reached via shared CLI surface — spec 016 evolution

These REQs belong to spec **016-impact-plan-symbol-level** and are reached
because spec 016 added `@impl 016-impact-plan-symbol-level/FR-XXX` claims to
the same shared CLI / parser / graph files that spec 014 owns (`src/cli.ts`,
`src/config.ts`, `src/graph/traverse.ts`, `src/parsers/markdown.ts`,
`src/parsers/sdd-files.ts`, `src/plan-coverage/index.ts`,
`src/plan-coverage/mention.ts`, `src/plan-coverage/spec-resolver.ts`, and
their tests). No behavioural change to spec 014 is intended by these entries
— they exist purely so the deterministic mention detector clears the cross-
spec impact set introduced after spec 014 was merged.

- Considered: 016-impact-plan-symbol-level/FR-001 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-002 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-003 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-004 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-005 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-006 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-007 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-008 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-009 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-010 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-011 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-012 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-013 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-014 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-015 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-016 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-017 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-018 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-019 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-020 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-021 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-022 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-023 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-024 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-025 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-026 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-027 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-028 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-029 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-030 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/FR-031 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/SC-001 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/SC-002 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/SC-003 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/SC-004 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/SC-005 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 016-impact-plan-symbol-level/SC-006 — added post-merge by spec 016, no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-001 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-002 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-003 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-004 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-005 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-006 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-007 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-008 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-009 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-010 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-011 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-012 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-013 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/FR-014 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-001 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-002 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-003 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-004 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-005 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-006 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-007 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change
- Considered: 013-cross-agent-extensions/SC-008 — added post-merge by spec 013 (cross-agent extensions), no spec 014 behaviour change

### Cross-spec REQs reached via shared CLI surface — spec 017 evolution

These REQs belong to spec **017-check-gate-baseline-diff** and are reached
because spec 017 added `@impl 017-check-gate-baseline-diff/FR-XXX` claims to
the same shared CLI / check / graph surface that spec 014 owns (`src/check.ts`,
`src/commands/check.ts`, `src/baseline.ts`, and the `src/graph/traverse.ts` /
`src/cli.ts` files that transitively import them). Reaching any one 017 REQ
pulls in the whole 017 spec doc via `contains` edges, so the entire FR/SC set
is listed. No behavioural change to spec 014 is intended — these entries exist
purely so the deterministic mention detector clears the cross-spec impact set
introduced after spec 014 was merged.

- Considered: 017-check-gate-baseline-diff/FR-001 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-002 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-003 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-004 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-005 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-006 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-007 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-008 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-009 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-010 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-011 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-012 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-013 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/FR-014 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/SC-001 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/SC-002 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/SC-003 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/SC-004 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/SC-005 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
- Considered: 017-check-gate-baseline-diff/SC-006 — added post-merge by spec 017 (baseline-diff gate), no spec 014 behaviour change
