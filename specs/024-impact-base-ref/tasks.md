# Tasks: impact --diff --base <ref> — CI テスト選択

**Feature**: `specs/024-impact-base-ref/` | **Branch**: `feat/impact-base-ref`

**Input**: plan.md / spec.md / research.md / data-model.md / contracts/cli-impact-base.md / quickstart.md

## 進め方 (TDD: List ⇒ Red ⇒ Green ⇒ Refactor)

各実装ユニットは **Red (失敗するテストを先に書く) → Green (最小実装で通す) → Refactor** の順。`[P]` は別ファイルで依存なく並列実行可。7 観点 (境界条件 / 条件分岐の組み合わせ / 不正な状態遷移 / 例外系・失敗時 / 実運用事故 / エッジケース / 変更外ファイルへの影響) を各テストタスク末尾に `〔観点: …〕` で明示。

実装変更は `src/commands/impact.ts` 1 ファイルに閉じる (plan.md Structure Decision)。`src/diff.ts` / `src/baseline.ts` / `src/graph/traverse.ts` / `src/commands/check.ts` に触れる変更が必要に見えたら、それは設計からの逸脱 — 手を止めて spec を確認する。

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

単一パッケージ CLI。実装は `src/`、テストは `tests/`。

---

## Phase 1: Setup & 前提検証

- [x] T001 023 配管の再利用可能性を実コードで裏取りする (Cat6): (a) `resolveMergeBase` / `FETCH_DEPTH_HINT` / `classifyBaseRef` が `src/baseline.ts` から export されている、(b) `getGitDiffFiles(rootDir, baseSha?)` の optional 引数が impact からそのまま呼べる (src/diff.ts:48)、(c) `nonOptionValue` (src/commands/shared.ts:24) が `--base` 値ガードに流用可能、(d) `src/commands/impact.ts:65` が raw `--format` である (D-7 の前提)、(e) `--diff` エントリは `line: 1` (impact.ts:193 — 016 契約 §1.3 の `line: 0` は drift、contract §1.2 に記載済み)。〔観点: 前提検証〕
  - Files: (実測のみ — 変更なし)
- [x] T002 `tests/helpers.ts` に `--tests` 用の fixture を追加する: spec 023 の `makeRepoWithBaseBranch` / `withBaseAndFeatureBranches` / `gitCheckoutBranch` を再利用し、trace shard (`.artgraph/trace/*.jsonl` を fixture として直書き — `tests/impact-evidence.test.ts` の既存 shard 組み立てパターンを流用) を持つ base/feature ブランチ repo を組み立てられるようにする。feature ブランチのコミットが「evidence が exercise している symbol の変更」になる形を 1 ヘルパーで提供。
  - Files: tests/helpers.ts

---

## Phase 2: Foundational — parse 層の fail-closed 化 (全 US のブロッキング前提)

**⚠️ Phase 3 以降の全 US はここに依存。option 定義と検証順 (contract §2) が土台。**

- [x] T003 [P] Red: `tests/impact-base-ref.test.ts` を新規作成し、parse 層のテストを書く (失敗する):
  (a) `--format yaml` → exit 1 (choices エラー、従来の silent text fallback の廃止 — I11)、(b) `--format --diff` → exit 1 (swallow 拒否)、(c) `--format json` / `--format text` は従来どおり、(d) `--base ""` → exit 1、(e) `--base --tests` → exit 1 (I13 — 値ガードが次フラグの swallow を遮断)。〔観点: 実運用事故 (CI 変数の空展開)・境界条件〕
  - Files: tests/impact-base-ref.test.ts
- [x] T004 Green: `src/commands/impact.ts` の option 定義を変換する — `--format` を `new Option(...).choices(["json", "text"]).default("text")` に (FR-010)、`--base <ref>` を `new Option(...).argParser(nonOptionValue("--base", { hint: ... }))` で追加 (FR-001。hint は `refs/...` 完全形の案内)。`Option` / `nonOptionValue` の import を追加。
  - Files: src/commands/impact.ts
- [x] T005 [P] Red: 検証順 (contract §2 / D-3) のテストを書く (失敗する): (a) `impact --base x` (`--diff` なし・targets なし) → exit 1 + §5.1 文言 + stdout 空、(b) `impact src/a.ts --base x` (`--diff` なし・targets あり) → **同じ** §5.1 文言 (排他エラーではない — I1 の優先順位 pin)、(c) `impact src/a.ts --diff --base x` → 既存の排他エラー文言、(d) `impact REQ-001 --base x` → 既存の REQ-ID rejection (rejection が requires-diff より先)、(e) `--format json` 併用でも (a)(b) は JSON を出さない。〔観点: 条件分岐の組み合わせ・不正な状態遷移 (エラー優先順位)〕
  - Files: tests/impact-base-ref.test.ts
- [x] T006 Green: `src/commands/impact.ts` に FR-002 の requires-diff 検証を実装する — 位置は REQ-ID / `doc:` rejection ループの直後・排他/no-source 検査の前 (contract §2 の 3)。文言は contract §5.1 の canonical string。
  - Files: src/commands/impact.ts

**Checkpoint**: parse 層と検証順が green。`--base` の値はまだ何もしない (次 Phase で配線)。

---

## Phase 3: User Story 1 — CI で PR のコミット範囲からテスト選択 (P1) 🎯 MVP

**Goal**: 作業ツリー clean でも `impact --diff --base <ref> --tests` が base range の変更から testsToRun を返す。
**Independent Test**: base ブランチ fixture + trace shards で、コミット済み変更 → testsToRun 非空、`--base` なし同一入力 → No changes。

- [x] T007 [P] [US1] Red: `tests/impact-base-ref.test.ts` に US1 の主経路テストを書く (失敗する): T002 の fixture で (a) feature ブランチに evidence 対象 symbol の変更をコミット (tree clean) → `impact --diff --base base --tests --format json` の `testsToRun` に該当 REQ のテストが列挙され exit 0 (I3)、(b) 同一 repo で `--base` なし → `message: "No changes detected in git diff."` (現状の CI 空振りの再現 = 本 feature が解く問題の pin)、(c) `--tests` なしの `--base` でも `impactReqs` が base range の変更から解決される (Assumptions — テスト選択専用ではない)。〔観点: 条件分岐の組み合わせ (CI の主経路)〕
  - Files: tests/impact-base-ref.test.ts
- [x] T008 [US1] Green: `src/commands/impact.ts` に data-model §3 のフローを実装する — `--tests` shard ガードの後・`scan()` の前に `classifyBaseRef` → `resolveMergeBase` (FR-004/FR-005: 失敗は stderr + exit 1、JSON なし、fast fail)、成功時の `baseSha` を `getGitDiffFiles(rootDir, baseSha)` に配線 (FR-006)。merge-base は 1 回だけ解決 (SSOT)。空 merged diff は既存 early exit にそのまま乗る (分岐追加なし)。rename map / tracked probe / baseline は **呼ばない** (D-1/D-8) — その旨と FR-011 の意図 (new-path 畳み込みが current-graph query に正しい) をコードコメントで明記。
  - Files: src/commands/impact.ts
- [x] T009 [P] [US1] Red→Green: グラフ未追跡ファイルの無言許容 (D-1 の非削除側) — base range のコミットに README 等のグラフ外ファイル変更 + コード変更を混在させ、エラー・警告なしでコード側だけから選択されること (I3 変形)。〔観点: エッジケース (silent contribution ゼロ)〕
  - Files: tests/impact-base-ref.test.ts
- [x] T010 [P] [US1] Red→Green: base..HEAD 内のコミットで sole `@impl` ファイルを削除 (I5 / SC-003) — (a) `impact --diff --base <base>` が削除ファイル由来の startId を持たず、エラーなしで残りから出力する (D-1 の削除側 pin)、(b) 同一 fixture で `check --diff --base <base> --gate` が exit 2 (spec 023 SC-003 の再確認 = check-scope ⊇ impact-reach の分業を 1 テストで固定)。023 の `makeRepoWithSoleImplTag` 系 fixture を再利用。〔観点: 例外系・実運用事故 (宣言された選択限界の境界)〕
  - Files: tests/impact-base-ref.test.ts, tests/helpers.ts
- [x] T011 [US1] Red→Green: agreement (i) (I4 / SC-002 / FR-013) — US4 agreement suite (`tests/check-baseline-diff.test.ts:576-609`) を `--base` variant で拡張する: base ブランチ fixture で `impact --diff --base <ref> --format json` の `affectedFiles` 系到達と `check --diff --base <ref>` の scope が一致すること (既存テストと同じ「impact の view と check の scope は乖離しない」不変条件を merged diff に持ち上げる)。〔観点: 変更外影響 (check との契約整合)〕
  - Files: tests/check-baseline-diff.test.ts

**Checkpoint**: CI の主経路 (US1) が単独で動作・テスト可能。MVP。

---

## Phase 4: User Story 2 — ローカル pre-push (和集合の意味論) (P2)

**Goal**: `--base` はコミット間差分を **追加** する — 作業ツリー差分 (untracked 含む) は縮小しない。
**Independent Test**: コミット済み + 未コミットの混在 diff で両方が startId 入力に入る。

- [x] T012 [P] [US2] Red→Green: (a) コミット済み変更 + untracked 新規ファイル (グラフ追跡対象) の混在 → 両系統が `affectedFiles` に現れる (I9)、(b) untracked のみ + `--base` → 現行 `--diff` と同じ判定。〔観点: 境界条件 (union の両端)〕
  - Files: tests/impact-base-ref.test.ts
- [x] T013 [P] [US2] Red→Green: `--base HEAD` (merge-base == HEAD) → `--base` なし `--diff` と同一の出力に退化 (I10 / SC-007)。〔観点: 境界条件〕
  - Files: tests/impact-base-ref.test.ts
- [x] T014 [P] [US2] Red→Green: 空 merged diff + `--base` (base と同一 tip かつ clean) → 「No changes detected in git diff.」exit 0、`--format json` の E4 payload が contract §4.2 の shape と一致 (フィールド追加なし — I8)。〔観点: エッジケース (正当な clean 判定)〕
  - Files: tests/impact-base-ref.test.ts

**Checkpoint**: union 意味論が両環境 (CI clean tree / ローカル dirty tree) で正しい。

---

## Phase 5: User Story 3 — fail-closed エラー系 (P2)

**Goal**: 誤構成・shallow clone を「黙って空選択 / 黙って全選択」にしない (exit 1 + 対処ヒント、JSON なし)。
**Independent Test**: 存在しない ref / unrelated histories / `--diff` なし、の 3 系統で exit 1 + stdout 空。

- [x] T015 [P] [US3] Red: (a) `impact --diff --base nosuchref` → exit 1、stderr に contract §5.2 の見出し + `FETCH_DEPTH_HINT` (I6)、(b) unrelated histories fixture (023 helpers の orphan-branch 組み立てを再利用) で merge-base 失敗 → exit 1 + `resolveMergeBase` の診断、(c) (a)(b) とも `--format json` で **stdout が空** (JSON なし — SC-004)、(d) `--tests` 併用時も同じ (shard ガードが先に通っていれば base 失敗で落ちる — contract §2 の 5→6 順)。〔観点: 例外系・実運用事故 (shallow clone)〕
  - Files: tests/impact-base-ref.test.ts, tests/helpers.ts
- [x] T016 [US3] Green: T008 のエラー分岐を contract §5.2 の canonical string で仕上げる (`FETCH_DEPTH_HINT` は import — 文言の重複定義禁止、data-model §4)。
  - Files: src/commands/impact.ts
- [x] T017 [P] [US3] Red→Green: merged diff 全 path 未解決 (削除のみ / グラフ外のみの base range) → 既存の「No matching nodes found」exit 1 が **文言・経路とも byte-identical** に出る (I7 / FR-008 — `--base` は新しい early exit を追加しない)。〔観点: 変更外影響 (既存エラー経路の不変)〕
  - Files: tests/impact-base-ref.test.ts

**Checkpoint**: US1〜US3 が揃い、選択の意味論とエラー系が完成。

---

## Phase 6: D-9 警告 + 回帰固定

- [x] T018 [P] Red→Green: D-9 staleness 警告 (I12 / SC-006 / FR-012) — `trace.staleness: "exclude"` の fixture で: (a) `--tests` + `--base` + exclude の 3 条件共起 → stderr に contract §5.3 の WARNING が 1 回、exit code / stdout は不変、(b) 3 条件のうち任意の 1 つを欠く組み合わせ (`--base` なし / `--tests` なし / `staleness: "warn"`) → 警告なし。実装は scan 後の staleness 解決箇所 (impact.ts の `excludeStaleExercises` 分岐) に隣接させる。〔観点: 条件分岐の組み合わせ (3 変数の全周辺)・実運用事故 (選択の目的反転)〕
  - Files: tests/impact-base-ref.test.ts, src/commands/impact.ts
- [x] T019 [P] SC-005 の回帰固定 — `--base` なしの代表経路 (`--diff` json / targets text / REQ-ID rejection / `doc:` rejection / no-source / 排他) の出力・exit code が本 feature 前と一致することを 1 describe で pin。rejection 文言に `--base` が **現れない** こと (FR-003 — `--base` は start source ではない) も明示アサート。既存 `tests/impact-cli.test.ts` / `tests/impact-evidence.test.ts` が `pnpm test` で無修正のまま green であることを確認 (`--format` choices 化で期待値が変わるテストがあれば、それは bogus 値に依存していた箇所のみ — 新挙動側に追随)。〔観点: 変更外影響 (byte-identical)〕
  - Files: tests/impact-base-ref.test.ts, (確認: tests/impact-cli.test.ts, tests/impact-evidence.test.ts)

---

## Phase 7: Polish — docs / skills / templates / タグ付け / dogfood

### 7A. docs / README (FR-009 consumer rule の配布)

- [x] T020 [P] `docs/commands.md` の `impact --diff --tests` 節 (:190 付近) に `--base <ref>` を追記: merge-base 意味論 / `--diff` 必須 / exit code と fallback 規則 / **consumer rule (FR-009 の文言)** / D-1 の選択限界 (削除・グラフ未追跡は寄与しない、正しさは `check --diff --base --gate`) / D-9 相互作用。exit code 表に「exit 1 → full suite に fallback」の行を追加。〔観点: doc 同時更新 (Cat3)〕
  - Files: docs/commands.md
- [x] T021 [P] `README.md` / `README.ja.md` の CI 節 (check --base レシピの隣) に quickstart.md S1 のテスト選択レシピ (jq 抽出 + full-suite fallback パターン) を追加。`impact --tests` は最適化であり gate は check 側という分業を 1 文で明記。両言語で等価に。
  - Files: README.md, README.ja.md

### 7B. skills / templates (配布物の consistency テストに注意)

- [x] T022 `templates/skills/artgraph-impact/SKILL.md` に CI 実行形 (`impact --diff --base <ref> --tests --format json`) と consumer rule / D-1 限界 / D-9 注意を追記し、`templates/skills/_shared/output-schema.md` の impact 節に (a) `--base` 時の `testsToRun` は merged set (working tree ∪ merge-base..HEAD) 上で評価される旨、(b) staleness "exclude" × `--base` × `--tests` の反転注意 (D-9)、を追記。**per-agent 配布複製** (`.claude/` / `.agents/` / `.cursor/` / `.github/` / `.kiro/` 配下の 5 ミラー) を同時更新し、`tests/skills-templates.test.ts` の同期検査と `tests/docs-trio-consistency.test.ts` を green に保つ。〔観点: 変更外影響 (dogfood parity)〕
  - Files: templates/skills/artgraph-impact/SKILL.md, templates/skills/_shared/output-schema.md, .claude/skills/**, .agents/skills/**, .cursor/skills/**, .github/skills/**, .kiro/skills/** (配布複製), tests/skills-templates.test.ts (期待値追随が必要な場合)
- [x] T023 [P] `templates/agent-context/agents-md-snippet.md` の trace 行 (`impact --diff --tests` 言及) に CI 形 (`--base origin/<base>` 併用) を追記し、この repo の `AGENTS.md` の同じ行にも反映 (snippet と実体の等価性を保つ — spec 023 T030 と同型)。
  - Files: templates/agent-context/agents-md-snippet.md, AGENTS.md

### 7C. タグ付け / 契約整合 / dogfood

- [x] T024 本 spec の FR にコード側 `@impl 024-impact-base-ref/FR-NNN` タグを付与 (原則 III。spec 023 の `// @impl 023-check-base-ref/FR-010` 形式を踏襲): FR-001/002/004/005/006/010/012 → `src/commands/impact.ts` の各分岐点。FR-007/008/011 は「変更しない/追加しない」型のため、D-1/D-8 の意図コメント (T008) とテスト側 pin が主。FR-003/013 は回帰・agreement テストで担保。新規 REQ-ID (`024-impact-base-ref/FR-001`〜`FR-013`) の既存衝突なしを再確認 (Cat6)。〔観点: 変更外影響 (dogfood)〕
  - Files: src/commands/impact.ts, tests/impact-base-ref.test.ts, tests/check-baseline-diff.test.ts
- [x] T025 [P] `specs/016-impact-plan-symbol-level/contracts/cli-flags.md` §1.3 の forward-pointer 注記が入っていることを確認 (本 spec 作成時に追記済み — spec 024 への参照 + `line: 1` の drift 明記)。`specs/023-check-base-ref/` 側は変更不要 (D3 / Out of Scope / plan.md Follow-up が既に本 feature を指している) ことを確認。
  - Files: specs/016-impact-plan-symbol-level/contracts/cli-flags.md (確認のみ)
- [x] T026 `pnpm exec artgraph scan && pnpm exec artgraph check` で 024 の FR が意図どおり登録され、実装前は uncovered として見えることを確認 (実装完了で解消)。`pnpm exec artgraph plan-coverage` で本 tasks.md の Files: からの implicit impact を消化 (Considered 記録を本ファイル末尾に追記)。
  - Files: specs/024-impact-base-ref/tasks.md (Considered 追記)
- [x] T027 `quickstart.md` S1〜S5 を手動実行し全期待値を確認。特に S1 (fallback パターンの実挙動) と S5 (byte-identical 回帰)。
  - Files: (検証のみ)
- [x] T028 `pnpm build && pnpm test` (unit+e2e+perf) 全通過、`pnpm knip` / `pnpm typecheck` クリーン、本 repo で `node dist/cli.js impact --diff --format json` (回帰なし) と `git fetch origin main && node dist/cli.js impact --diff --base origin/main --tests` の動作確認。
  - Files: (検証のみ)

---

## Dependencies (完了順)

```
Phase 1 (Setup: T001 前提検証 / T002 fixture)
   └─► Phase 2 (Foundational: T003-T004 parse 層 → T005-T006 検証順)   ← 全 US の前提
          ├─► Phase 3 (US1: T007-T011 配線 + CI 主経路 + agreement) ─┐
          ├─► Phase 4 (US2: T012-T014 union 意味論)                  ─┤ US2/US3 は T008 の配線に依存
          └─► Phase 5 (US3: T015-T017 fail-closed)                   ─┘
                 └─► Phase 6 (T018 D-9 / T019 回帰固定)
                        └─► Phase 7 (Polish: 7A/7B docs → 7C タグ・dogfood)
```

- **T008 (コマンド配線) が US2/US3/D-9 の前提**。T016 (エラー文言) は T008 の分岐に差し込む。
- Phase 7B (skills 複製ミラー) は 7A の文言確定後にまとめて 1 コミットで行う (`tests/skills-templates.test.ts` が中間状態で赤くなるのを避ける — spec 023 T029 と同じ注意)。

## Parallel Opportunities

- Phase 2: T003 と T005 は同一新規ファイル内だが describe 単位で独立 — Red はまとめて書ける。
- Phase 3-5 の Red テスト ([P]) は T008 実装前に並列で書ける。
- Phase 7: T020 / T021 / T023 は別ファイルで並列可。

## Implementation Strategy

- **MVP = Phase 1 + 2 + 3 (US1)**: CI でテスト選択が機能する時点で本 feature の主価値が出る。ここで一度 CI 実機 (fetch-depth: 0 + shards キャッシュ) で dogfood 確認。
- 続けて US2 (union) → US3 (fail-closed) → D-9/回帰固定 → docs/templates。
- **baseline union / trace-join 回復は対象外** — 選び漏れの実例が出たら research.md R1 の trace-join 案で follow-up issue を起票する (plan.md Follow-up)。

## Definition of Done (実装時 Engineering Hygiene)

- [x] 全テスト green (TDD: 各ユニットで Red を先に確認してから Green)。
- [x] `--base` なしの全経路が byte-identical (SC-005 回帰テストで固定。例外は `--format` choices 化のみ、新挙動を pin — Cat5)。
- [x] 共有配管 (src/diff.ts / src/baseline.ts / traverse.ts / check.ts) への変更ゼロ (plan.md Constraints — diff で確認)。
- [x] merge-base の単一解決 (resolveMergeBase 1 回 → baseSha 変数のみ) と FETCH_DEPTH_HINT の import 共有 (Cat2, data-model §4)。
- [x] エラー時 JSON 非出力 (usage / 環境失敗の全系統) をテストで pin (Cat1/Cat5)。
- [x] 変更外ファイル (impact-cli / impact-evidence 既存テスト / skills 5 複製 / docs) の追随完了 (Cat3)。
- [x] ドッグフード: `artgraph check --diff` drift=0、`artgraph plan-coverage` implicit=0 (T026 の Considered 消化)。

---

## Considered: implicit impacts (artgraph plan-coverage 消化記録)

plan-coverage が検出した本 plan の Files: からの graph 到達 REQ。各行の判断:

- Considered: docs/templates への行追加による doc-graph 到達のみ。要件影響なし — 009-sdd-integration/FR-001, 009-sdd-integration/FR-002, 009-sdd-integration/FR-003, 009-sdd-integration/FR-004, 009-sdd-integration/FR-005, 009-sdd-integration/FR-006, 009-sdd-integration/FR-007, 009-sdd-integration/FR-008, 009-sdd-integration/FR-009, 009-sdd-integration/FR-010, 009-sdd-integration/FR-011, 009-sdd-integration/FR-012, 009-sdd-integration/FR-013, 009-sdd-integration/FR-014, 009-sdd-integration/FR-015, 009-sdd-integration/FR-016, 009-sdd-integration/FR-017, 009-sdd-integration/FR-018, 009-sdd-integration/FR-019, 009-sdd-integration/FR-020, 009-sdd-integration/FR-021, 009-sdd-integration/FR-022, 009-sdd-integration/FR-023, 009-sdd-integration/FR-024, 009-sdd-integration/SC-001, 009-sdd-integration/SC-002, 009-sdd-integration/SC-003, 009-sdd-integration/SC-004, 009-sdd-integration/SC-005, 009-sdd-integration/SC-006, 009-sdd-integration/SC-007
- Considered: artgraph-impact SKILL の配布複製ミラー更新による到達のみ。配布機構は不変 — 013-cross-agent-extensions/FR-001, 013-cross-agent-extensions/FR-002, 013-cross-agent-extensions/FR-003, 013-cross-agent-extensions/FR-004, 013-cross-agent-extensions/FR-005, 013-cross-agent-extensions/FR-006, 013-cross-agent-extensions/FR-007, 013-cross-agent-extensions/FR-008, 013-cross-agent-extensions/FR-009, 013-cross-agent-extensions/FR-010, 013-cross-agent-extensions/FR-011, 013-cross-agent-extensions/FR-012, 013-cross-agent-extensions/FR-013, 013-cross-agent-extensions/FR-014, 013-cross-agent-extensions/SC-001, 013-cross-agent-extensions/SC-002, 013-cross-agent-extensions/SC-003, 013-cross-agent-extensions/SC-004, 013-cross-agent-extensions/SC-005, 013-cross-agent-extensions/SC-006, 013-cross-agent-extensions/SC-007, 013-cross-agent-extensions/SC-008
- Considered: start source 意味論は不変 — --base は modifier (FR-003)。rejection 定数の文言も不変 — 014-reinvent-impact-cli/FR-001, 014-reinvent-impact-cli/FR-002, 014-reinvent-impact-cli/FR-003, 014-reinvent-impact-cli/FR-004, 014-reinvent-impact-cli/FR-005, 014-reinvent-impact-cli/FR-006, 014-reinvent-impact-cli/FR-007, 014-reinvent-impact-cli/FR-008, 014-reinvent-impact-cli/FR-009, 014-reinvent-impact-cli/FR-010, 014-reinvent-impact-cli/FR-011, 014-reinvent-impact-cli/FR-012, 014-reinvent-impact-cli/FR-013, 014-reinvent-impact-cli/FR-014, 014-reinvent-impact-cli/FR-015, 014-reinvent-impact-cli/FR-016, 014-reinvent-impact-cli/FR-017, 014-reinvent-impact-cli/FR-018, 014-reinvent-impact-cli/FR-019, 014-reinvent-impact-cli/FR-020, 014-reinvent-impact-cli/FR-021, 014-reinvent-impact-cli/FR-022, 014-reinvent-impact-cli/FR-023, 014-reinvent-impact-cli/FR-024, 014-reinvent-impact-cli/FR-025, 014-reinvent-impact-cli/FR-026, 014-reinvent-impact-cli/FR-027, 014-reinvent-impact-cli/FR-028, 014-reinvent-impact-cli/FR-029, 014-reinvent-impact-cli/FR-030, 014-reinvent-impact-cli/FR-031, 014-reinvent-impact-cli/SC-001, 014-reinvent-impact-cli/SC-002, 014-reinvent-impact-cli/SC-003, 014-reinvent-impact-cli/SC-004, 014-reinvent-impact-cli/SC-005, 014-reinvent-impact-cli/SC-006, 014-reinvent-impact-cli/SC-007, 014-reinvent-impact-cli/SC-008, 014-reinvent-impact-cli/SC-009, 014-reinvent-impact-cli/SC-010
- Affected: cli-flags.md §1.3 を contract 拡張 (forward-pointer 注記済み)。line:1 実装値を 024 contract に明記 — 016-impact-plan-symbol-level/FR-001, 016-impact-plan-symbol-level/FR-002, 016-impact-plan-symbol-level/FR-003, 016-impact-plan-symbol-level/FR-004, 016-impact-plan-symbol-level/FR-005, 016-impact-plan-symbol-level/FR-006, 016-impact-plan-symbol-level/FR-007, 016-impact-plan-symbol-level/FR-008, 016-impact-plan-symbol-level/FR-009, 016-impact-plan-symbol-level/FR-010, 016-impact-plan-symbol-level/FR-011, 016-impact-plan-symbol-level/FR-012, 016-impact-plan-symbol-level/FR-013, 016-impact-plan-symbol-level/FR-014, 016-impact-plan-symbol-level/FR-015, 016-impact-plan-symbol-level/FR-016, 016-impact-plan-symbol-level/FR-017, 016-impact-plan-symbol-level/FR-018, 016-impact-plan-symbol-level/FR-019, 016-impact-plan-symbol-level/FR-020, 016-impact-plan-symbol-level/FR-021, 016-impact-plan-symbol-level/FR-022, 016-impact-plan-symbol-level/FR-023, 016-impact-plan-symbol-level/FR-024, 016-impact-plan-symbol-level/FR-025, 016-impact-plan-symbol-level/FR-026, 016-impact-plan-symbol-level/FR-027, 016-impact-plan-symbol-level/FR-028, 016-impact-plan-symbol-level/FR-029, 016-impact-plan-symbol-level/FR-030, 016-impact-plan-symbol-level/FR-031, 016-impact-plan-symbol-level/SC-001, 016-impact-plan-symbol-level/SC-002, 016-impact-plan-symbol-level/SC-003, 016-impact-plan-symbol-level/SC-004, 016-impact-plan-symbol-level/SC-005, 016-impact-plan-symbol-level/SC-006
- Affected: FR-007 (impact --diff blast radius 非縮小) を FR-013 agreement property で継承。check 側コードは不変 — 017-check-gate-baseline-diff/FR-001, 017-check-gate-baseline-diff/FR-002, 017-check-gate-baseline-diff/FR-004, 017-check-gate-baseline-diff/FR-006, 017-check-gate-baseline-diff/FR-010, 017-check-gate-baseline-diff/FR-011, 017-check-gate-baseline-diff/FR-012, 017-check-gate-baseline-diff/FR-014
- Considered: --tests (FR-018) は merged set 上で同一 join を実行するのみ。trace ingest/engine 不変。staleness-exclude 相互作用は FR-012 で警告+文書化 — 020-coverage-derived-edges/FR-001, 020-coverage-derived-edges/FR-002, 020-coverage-derived-edges/FR-003, 020-coverage-derived-edges/FR-004, 020-coverage-derived-edges/FR-005, 020-coverage-derived-edges/FR-006, 020-coverage-derived-edges/FR-007, 020-coverage-derived-edges/FR-008, 020-coverage-derived-edges/FR-009, 020-coverage-derived-edges/FR-010, 020-coverage-derived-edges/FR-011, 020-coverage-derived-edges/FR-012, 020-coverage-derived-edges/FR-013, 020-coverage-derived-edges/FR-014, 020-coverage-derived-edges/FR-015, 020-coverage-derived-edges/FR-016, 020-coverage-derived-edges/FR-017, 020-coverage-derived-edges/FR-018, 020-coverage-derived-edges/FR-019, 020-coverage-derived-edges/FR-020, 020-coverage-derived-edges/FR-021, 020-coverage-derived-edges/SC-001, 020-coverage-derived-edges/SC-002, 020-coverage-derived-edges/SC-003, 020-coverage-derived-edges/SC-004, 020-coverage-derived-edges/SC-005, 020-coverage-derived-edges/SC-006, 020-coverage-derived-edges/SC-007
- Considered: trace engine 不変。テストファイル共有による到達のみ — 022-instrumented-trace-engine/FR-001, 022-instrumented-trace-engine/FR-002, 022-instrumented-trace-engine/FR-003, 022-instrumented-trace-engine/FR-004, 022-instrumented-trace-engine/FR-005, 022-instrumented-trace-engine/FR-006, 022-instrumented-trace-engine/FR-007, 022-instrumented-trace-engine/FR-008, 022-instrumented-trace-engine/FR-009, 022-instrumented-trace-engine/FR-010, 022-instrumented-trace-engine/FR-011, 022-instrumented-trace-engine/FR-012, 022-instrumented-trace-engine/FR-013, 022-instrumented-trace-engine/FR-014, 022-instrumented-trace-engine/FR-015, 022-instrumented-trace-engine/FR-016, 022-instrumented-trace-engine/SC-001, 022-instrumented-trace-engine/SC-002, 022-instrumented-trace-engine/SC-003, 022-instrumented-trace-engine/SC-004, 022-instrumented-trace-engine/SC-005, 022-instrumented-trace-engine/SC-006
- Affected: 再利用する merge-base 配管の供給元 spec。resolveMergeBase / getGitDiffFiles(baseSha) / FETCH_DEPTH_HINT は変更しない (data-model §2 ledger) — 023-check-base-ref/FR-001, 023-check-base-ref/FR-002, 023-check-base-ref/FR-003, 023-check-base-ref/FR-004, 023-check-base-ref/FR-005, 023-check-base-ref/FR-006, 023-check-base-ref/FR-007, 023-check-base-ref/FR-008, 023-check-base-ref/FR-009, 023-check-base-ref/FR-011, 023-check-base-ref/FR-012
- Affected: 本 feature の実装対象 FR/SC (T001-T028 で実装・検証) — 024-impact-base-ref/FR-002, 024-impact-base-ref/FR-003, 024-impact-base-ref/FR-004, 024-impact-base-ref/FR-005, 024-impact-base-ref/FR-006, 024-impact-base-ref/FR-007, 024-impact-base-ref/FR-008, 024-impact-base-ref/FR-009, 024-impact-base-ref/FR-010, 024-impact-base-ref/FR-011, 024-impact-base-ref/FR-012, 024-impact-base-ref/FR-013, 024-impact-base-ref/SC-001, 024-impact-base-ref/SC-002, 024-impact-base-ref/SC-003, 024-impact-base-ref/SC-004, 024-impact-base-ref/SC-005, 024-impact-base-ref/SC-006, 024-impact-base-ref/SC-007
- Considered: docs 経由の doc-graph 到達のみ。要件影響なし — FR-032, REQ-3
- Considered: docs 経由の doc-graph 到達のみ。要件影響なし — design/SC-005
