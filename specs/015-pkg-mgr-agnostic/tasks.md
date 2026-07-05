---
description: "Task list for 015-pkg-mgr-agnostic — PM 非依存化の基盤 + 既存配布物の PM 非依存化 + Bun/Deno smoke"
---

# Tasks: package manager 非依存化 (基盤 + 既存配布物 + Bun/Deno smoke)

> **Superseded reference notice (post PR #151 / issue #141)**: 本ドキュメント内で「`_shared/package-manager.md` の bash スニペット」または「bash 検出順」等と参照している箇所は、issue #141 で shell 非依存の **prose ルール表** (`## Detection rules`) に置き換え済みです。SC-007 の同期契約はルールレベル (prose ↔ TS: 同じ優先順位・同じ結果・同じ warning/error 文言) で維持されており、`tests/package-manager-detection.test.ts` の prose↔TS meta-test が verbatim ワーディングを含めて検証します。詳細は [`contracts/package-manager.md`](contracts/package-manager.md) の "Note (issue #141)" ブロック参照。本文中の「bash」語は spec 015 起草時点の呼称としてそのまま保持しています (歴史的経緯の可読性のため)。

**Input**: Design documents from `/specs/015-pkg-mgr-agnostic/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [contracts/package-manager.md](./contracts/package-manager.md)

**Tests**: TDD per established project convention (spec 012/014 と同じ — write test first, ensure it fails, then implement)。

**Organization**: Phase は plan.md の internal phase (0–6) に対応。単一 PR で出す。基盤 (Phase 2–3) は別 issue #109 / #110 / #111 より先にマージされる必要がある。

**Self-dogfooding**: 本 tasks.md は `Files:` セクション + FR/SC mention 規約を採用。spec 完了後に `artgraph plan-coverage --spec specs/015-pkg-mgr-agnostic/` を走らせ暗黙波及ゼロを T020 で検証する。

## Format

各タスクは `### T<NNN> [P?] [Story] 概要 [FR/SC-IDs]` + 直後に `Files:` 行 + 任意で実装メモ。

- **[P]**: 同 phase 内で並列実行可能 (touch する file が独立)
- **[Story]**: マップする user story (US1〜US4)

## Path Conventions

Single project (plan.md Project Structure):
- Source: `src/` / Tests: `tests/` / Templates: `templates/` / Docs: `docs/`
- Branch: `claude/artgraph-issue-102-1dn27j` (worktree root: `/home/user/artgraph`)

---

## Phase 0: Research — ✅ 完了

[research.md](./research.md) に Bun/Deno 実測を記録済。Deno は正式サポート (ts-morph 動作)、`exports` に `./cli` 追加が必須、未公開のため CI Deno は `./dist/cli.js` 直接実行。

---

## Phase 1: Setup

### T001 [Setup] Verify dev environment

Files: (no source changes)

Node >= 22 (`node -v`)、pnpm available、`bun --version` (1.x)、`deno --version` (2.x、無ければ `npm i -g deno`)、working tree clean、branch `claude/artgraph-issue-102-1dn27j`、`pnpm build` が通ること。

---

## Phase 2: Foundational — PM 検出 + コマンド組み立て (US1)

**⚠️ CRITICAL**: 別 issue #109 / #110 / #111 が consume する基盤。最優先で完成させる。[contracts/package-manager.md](./contracts/package-manager.md) を SSOT とする。

### T002 [US1] Write tests/package-manager-detection.test.ts [FR-001, FR-002, FR-003, FR-004, FR-005, FR-018, SC-001, SC-003]

Files: tests/package-manager-detection.test.ts

[contracts/package-manager.md](./contracts/package-manager.md) §1 の真理値表 8 系統を tmp-dir fixture 化 (1a pnpm field / 2a bun.lockb / 2b deno (no pkg.json) / 2c pnpm-lock / 2d yarn→pnpm+warn / 2e package-lock→npm / 3 pkg.json のみ→pnpm / 4 空→null+warn)。§2 `buildExecCommand` の 4 PM 出力、§3 `buildInstallCommand` の 4 PM 出力も検証。yarn fallback / 検出不能時の warning が stderr に出ることも確認。**この時点では実装が無いので red**。

### T003 [US1] Implement src/package-manager.ts [FR-001, FR-002, FR-003, FR-004, FR-005, SC-001, SC-003, SC-007, FR-022]

Files: src/package-manager.ts

`_shared/package-manager.md` の bash 検出を逐語移植。export: `PackageManager` 型 (再 export 用)、`detectPackageManager(rootDir): PackageManager | null` (contracts §1 の評価順 first-match を厳守、yarn→pnpm fallback、null=検出不能)、`buildExecCommand(pm, subcommand): string` (contracts §2)、`buildInstallCommand(pm): string` (contracts §3)。検出は `node:fs` の `existsSync` / `package.json` read のみ (決定的、FR-022)。T002 を green に。

**Checkpoint**: 基盤完成。Phase 3 着手可能。

---

## Phase 3: config 配線 — 記録 / 読み込み (US1)

### T004 [US1] Add PackageManager to types [FR-006]

Files: src/types.ts

`PackageManager = "npm" | "pnpm" | "bun" | "deno"` を export し、`ArtgraphConfig` に `packageManager?: PackageManager` を追加。`src/package-manager.ts` の型と一致させる (型は types.ts を single source とし package-manager.ts は import する形が望ましい)。

### T005 [US1] loadConfig validate/passthrough for packageManager [FR-006]

Files: src/config.ts

`loadConfig` で `raw.packageManager` が 4 値 union のいずれかなら採用、それ以外は無視 (`undefined`)。既存の lenient validate パターン (`validatePlanCoverage` 等) を踏襲。

### T006 [US1] runInit records packageManager [FR-007, FR-008, SC-002]

Files: src/init.ts

`runInit` で `detectPackageManager(abs)` を呼び、non-null のとき書き出す config に `packageManager` をセット。null のときは省略 + 警告 (init は完走、他ステージ続行)。`generateConfig` は純粋なまま (記録は runInit 側)。

### T007 [US1] Extend tests/init.test.ts for packageManager recording [FR-007, FR-008, SC-002]

Files: tests/init.test.ts

4 PM fixture で `.artgraph.json` に正しい `packageManager` が記録されること、検出不能 fixture で init が exit 0 で完走し `packageManager` が省略されることを検証。`--force` 再 init で検出値が再検出・上書きされること (edge case, contracts §4) も明示アサーションする。

**Checkpoint**: 基盤 + 記録完成。#109/#110/#111 が consume 可能。

---

## Phase 4: bash SSOT 追従 (US2)

### T008 [US2] Update _shared/package-manager.md defaults npm→pnpm [FR-012, SC-007]

Files: templates/skills/_shared/package-manager.md

Detection order の散文 step 3 (シグナル無しデフォルト) と Yarn fallback (field / lockfile 両方) を npm→pnpm に変更。Bash detection snippet (`detect_package_manager`) の該当 `echo "npm"` を `echo "pnpm"` に。Command mapping 表は contracts §2 と一致確認 (変更不要のはず)。TS 実装 (T003) と検出順・デフォルトが完全一致することを目視突合。

---

## Phase 5: 既存 Skill の PM 非依存化 (US2)

### T009 [P] [US2] allowed-tools に 4 PM exec を pre-approve [FR-009, SC-004]

Files: templates/skills/artgraph-coverage/SKILL.md, templates/skills/artgraph-impact/SKILL.md, templates/skills/artgraph-integrate/SKILL.md, templates/skills/artgraph-plan-coverage/SKILL.md, templates/skills/artgraph-rename/SKILL.md, templates/skills/artgraph-verify/SKILL.md, templates/skills/artgraph-detect/SKILL.md, templates/skills/artgraph-setup/SKILL.md

各 SKILL.md の frontmatter `allowed-tools` に `Bash(artgraph *)` + 4 PM exec 形 (`pnpm exec artgraph*` / `bunx artgraph*` / `deno run*` / `npx artgraph *`) を揃える。`artgraph-setup` は既存の網羅セットを維持。

### T010 [P] [US2] 本文の裸 `npx artgraph` をプレースホルダ化 [FR-010, FR-011, SC-004]

Files: templates/skills/artgraph-coverage/SKILL.md, templates/skills/artgraph-impact/SKILL.md, templates/skills/artgraph-integrate/SKILL.md, templates/skills/artgraph-plan-coverage/SKILL.md, templates/skills/artgraph-rename/SKILL.md, templates/skills/artgraph-verify/SKILL.md

各 Skill 本文 (frontmatter 除く) の裸 `npx artgraph <sub>` を `artgraph-detect` 既採用の `<PM-exec>` プレースホルダ表現 (または裸 `artgraph`) に統一。`artgraph-setup` の PM 対応表は退行なく維持 (FR-011)。

### T011 [US2] Extend tests/skills-templates.test.ts [SC-004]

Files: tests/skills-templates.test.ts

全 `templates/skills/*/SKILL.md` の本文 (frontmatter 除く) に裸 `npx artgraph <sub>` が 0 件、`allowed-tools` に `Bash(artgraph *)` が含まれることを検証。

---

## Phase 6: docs (US3)

### T012 [P] [US3] README 本文の PM 非依存化 [FR-013, SC-005]

Files: README.md

本文の `npx artgraph reconcile` / `check` / `init` 等を PM 非依存表現に。Quickstart の 4 PM 列挙 (L19-24) は維持。

### T013 [P] [US3] docs/skills-guide.md の PM 非依存化 [FR-014, SC-005]

Files: docs/skills-guide.md

`npx artgraph init` 等 (L25-26 ほか) を PM 非依存表現に。

---

## Phase 7: Bun/Deno smoke + CI + exports (US4)

### T014 [US4] package.json exports に ./cli 追加 [FR-016]

Files: package.json

`exports` に `"./cli": "./dist/cli.js"` を追加 (research R3 で必須と確定)。`bin` 経由の npx/bunx/pnpm exec には無影響。

### T015 [US4] CI に PM matrix smoke job 追加 [FR-015, FR-016, FR-017, SC-006]

Files: .github/workflows/ci.yml

npm / pnpm / bun / deno それぞれで最小 fixture に対し `init` → `scan` → `check` を実行し exit 0 を検証する job (or matrix) を追加。bun は `oven-sh/setup-bun`、deno は `denoland/setup-deno`。**deno は未公開のため `deno run -A ./dist/cli.js`** を使う (research R4)。pnpm exec / bunx / npx は build 済 `node_modules/.bin` 経由。continue-on-error 不要 (4 PM 実測済)。

### T016 [US4] (任意) smoke 用 fixture / スクリプト整備 [FR-015, FR-016]

Files: scripts/pm-smoke.sh

各 PM 共通の smoke 手順 (tmp fixture 作成 → init/scan/check → exit code 検証) を 1 スクリプトに集約し CI から呼ぶ (job 重複を避ける)。fixture は `package.json` + `specs/*.md` (REQ) + `src/*.ts` (@impl) の最小構成。

---

## Phase 8: 統合検証

### T017 [Polish] 全テスト green [SC-001〜SC-006]

Files: (no source changes)

`pnpm build && pnpm test:unit && pnpm test:e2e` が green。`pnpm knip` / `pnpm typecheck` も通す。

### T018 [Polish] ローカル 4 PM smoke 再実測 [SC-006]

Files: (no source changes)

`node` / `bunx 相当` / `pnpm exec 相当` / `deno run -A ./dist/cli.js` で init/scan/check を手元で再実行し exit 0 を確認 (research の再現性チェック)。

### T019 [Polish] grep 静的検証 [SC-004, SC-005, SC-007]

Files: (no source changes)

`templates/skills/*/SKILL.md` 本文に裸 `npx artgraph <sub>` 0 件、README/docs に npm 専用生コマンドが残っていないことを grep。`_shared/package-manager.md` (bash) と `src/package-manager.ts` (TS) の検出デフォルトが pnpm で一致していることを突合。

### T020 [Polish] self-dogfooding plan-coverage [SC-002]

Files: (no source changes)

`artgraph reconcile` 後に `artgraph plan-coverage --spec specs/015-pkg-mgr-agnostic/` を本 tasks.md に対して実行し、暗黙波及がゼロ (= tasks.md の Files: が触れる REQ/FR がすべて spec/plan/tasks で mention 済) であることを確認。

---

## Phase 9: 敵対的レビュー / メタレビュー対応 (PR #112 中の追補)

### T021 [Polish] 既存タスクの達成範囲拡張 (PR 中 review 反映)

Files: (拡張のみ — 担当ファイルは下記 task に紐づく)

PR #112 の 4 観点敵対的レビュー + メタレビューで妥当判定された指摘を、新規タスクを切らず既存タスクの中で吸収した。記録のみのドキュメント反映:

- **T002 拡張** — `tests/package-manager-detection.test.ts` に (a) 検出不能 warning 文言マッチ (`/cannot detect/i`)、(b) `buildExecCommand` の trim + multi-word prefix (`deno run -A npm:artgraph/cli`) 末尾空白回避を追加 (SC-001/SC-003 の精度向上)。
- **T003 拡張** — `src/package-manager.ts` の `buildExecCommand` に前後空白トリム + 空 subcommand での末尾空白回避ロジックを追加 (FR-004 補強)。
- **T005 拡張** — `tests/config.test.ts` に `loadConfig` 読み込み側テストを新設 (有効 4 値採用 / `"yarn"` などの未知文字列→`undefined` / 型違い→`undefined` / フィールド欠落→`undefined`)。FR-006 / contracts §4 の読み込み側カバレッジ。
- **T007 拡張** — `tests/init.test.ts` の検出不能ケースに `console.error` spy を追加し test output を清潔化 (動作仕様は不変)。
- **T008 拡張** — `templates/skills/_shared/package-manager.md` の bash `packageManager` field 検出を `grep` から node の top-level JSON parse に変更。nested `"packageManager"` 誤検出による TS との SC-007 乖離を解消。
- **T011 拡張** — `tests/skills-templates.test.ts` の SC-004 offender 正規表現を、フラグ / 大文字 / 二重空白に対応するよう強化 (`--no-install` probe は subcommand が `-` 始まりのため引き続き除外)。
- **T013 補完漏れ修正** — `docs/skills-guide.md` L15/L67 に残っていた「Yarn フォールバック先 npm」表記を pnpm に修正 (FR-014/SC-005 の実装漏れ)。

これらは新規 FR/SC を生まず、既存 FR/SC の達成精度を上げる修正に閉じている (詳細はコミット `74144ed`)。

---

## Dependencies

- Phase 2 (T002→T003) → Phase 3 (T004→T005→T006→T007): 基盤 → config 配線の直列依存。
- Phase 3 完了で #109 / #110 / #111 が consume 可能 (本 PR マージが前提)。
- Phase 4 (T008) は T003 の検出順に追従 (SSOT)。
- Phase 5 (T009/T010 は [P]、T011 は両者後)。
- Phase 6 (T012/T013 は [P])。
- Phase 7 (T014 → T015 → T016)。
- Phase 8 は全 Phase 後。
