# Tasks: check --base <ref> — CI PR gating

**Feature**: `specs/023-check-base-ref/` | **Branch**: `feat/check-base-ref`

**Input**: plan.md / spec.md / research.md / data-model.md / contracts/cli-check-base.md / quickstart.md

## 進め方 (TDD: List ⇒ Red ⇒ Green ⇒ Refactor)

各実装ユニットは **Red (失敗するテストを先に書く) → Green (最小実装で通す) → Refactor** の順。`[P]` は別ファイルで依存なく並列実行可。7 観点 (境界条件 / 条件分岐の組み合わせ / 不正な状態遷移 / 例外系・失敗時 / 実運用事故 / エッジケース / 変更外ファイルへの影響) を各テストタスク末尾に `〔観点: …〕` で明示。

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

単一パッケージ CLI。実装は `src/`、テストは `tests/`。

---

## Phase 1: Setup & 前提検証

- [x] T001 `git merge-base <ref> HEAD` の挙動を実測で裏取りする: (a) shallow clone (`git clone --depth 1`) で失敗すること、(b) unrelated histories で失敗すること、(c) merge-base == HEAD (同一 tip) が正常解決すること、(d) `git diff --name-only -M -z <sha> HEAD` の rename R レコードで old/new 両 path が name-only に現れること。実測メモを PR 説明に残す。〔観点: 前提検証・実運用事故〕 **実測結果**: (a)(b)(c) は想定どおり ((a)(b) は exit 1 + 空 stdout/stderr)。(d) は想定と異なり `--name-only -M` は **new path のみ** を出力する — old path は rename map (FR-008) 経由で回復されるため正しさへの影響なし。research.md R3 / data-model.md §2 を実測に合わせて修正済み。
  - Files: (実測のみ — 変更なし)
- [x] T002 `tests/helpers.ts` に base ブランチ fixture ヘルパーを追加する: `gitCheckoutBranch(dir, name)` / `makeRepoWithBaseBranch(prefix)` (base ブランチ + そこから分岐した feature ブランチ + 双方に独立コミットを積める multi-commit scaffolding)。moved-ahead base (分岐後に base 側へコミット) と unrelated-histories (2 つ目の root commit を `git checkout --orphan` で作る) を組み立てられること。既存 `makeRepoWithDebt` / `gitInit` / `gitCommitAll` を再利用・拡張。
  - Files: tests/helpers.ts

---

## Phase 2: Foundational (全 User Story のブロッキング前提)

**⚠️ Phase 3 以降の全 US はここに依存。merge-base 解決と diff.ts の base パラメータ化が土台。**

### 2A. resolveMergeBase (data-model §3, FR-005)

- [x] T003 [P] Red: `tests/baseline.test.ts` に `resolveMergeBase` の単体テストを追加: (a) 分岐した 2 ブランチで正しい merge-base SHA (`{sha}`) を返す、(b) merge-base == HEAD (同一 tip)、(c) unrelated histories → `{error}` (非空、`FETCH_DEPTH_HINT` を含む)、(d) 解決しない ref → `{error}` (この時点で失敗する)。〔観点: 例外系・境界条件〕
  - Files: tests/baseline.test.ts, tests/helpers.ts
- [x] T004 Green: `src/baseline.ts` に `resolveMergeBase(rootDir, ref): {sha} | {error}` と `FETCH_DEPTH_HINT` 定数 (fetch-depth: 0 / base ref fetch の対処ヒント、SSOT) を実装。`execFileSync("git", ["merge-base", ref, "HEAD"], ...)`、失敗は `extractErrorMessage` + `FETCH_DEPTH_HINT` 連結。`debugLog` 経路も既存流儀に合わせる。
  - Files: src/baseline.ts
- [x] T005 [P] Red→Green: `tests/baseline.test.ts` に `isUnbornHead` / `classifyBaseRef` の pin テスト — 解決しない **named ref** (非 HEAD) が `"unborn"` に分類されず `"error"` になること (src/baseline.ts:381 の early return を回帰固定。FR-004 の安全性前提)。〔観点: 不正な状態遷移 (named ref → empty 化の禁止)〕
  - Files: tests/baseline.test.ts

### 2B. diff.ts の base パラメータ化 (data-model §2, FR-006/008/009)

- [x] T006 [P] Red: `tests/diff.test.ts` に base 引数対応のテストを追加 (失敗する):
  (a) `getGitDiffFiles(dir)` — 引数なしが現行と同一の集合 (三 way union) を返す回帰、(b) `getGitDiffFiles(dir, baseSha)` — base..HEAD のコミット済み変更が union に加わる、(c) untracked が (b) でも含まれる、(d) 非 ASCII path (`specs/日本語.md`) が base range 由来でも作業ツリー由来でも verbatim (octal-escape なし) で返る、(e) `getGitRenameMap(dir, baseSha)` — base..HEAD 内のコミット済み `git mv` が map に入る / 引数なしは現行 (HEAD 比較) のまま、(f) `getHeadTrackedPaths(dir, paths, baseSha)` — HEAD で削除済みだが merge-base tree に存在する path が tracked 判定される。〔観点: 境界条件・エッジケース (非 ASCII)・変更外影響 (引数なし回帰)〕
  - Files: tests/diff.test.ts, tests/helpers.ts
- [x] T007 Green: `src/diff.ts` を実装 —
  (a) `getGitDiffFiles(rootDir, baseSha?)`: 既存 3 呼び出し (staged/unstaged/untracked) を `-z` + `-c core.quotePath=false` + `parseNulSeparated` に変換し、`baseSha` 指定時は `git -c core.quotePath=false diff --name-only -M -z <baseSha> HEAD` を union に追加 (FR-006)。
  (b) `getGitRenameMap(rootDir, baseSha?)`: 比較基準を `baseSha ?? "HEAD"` に (FR-008)。
  (c) `getHeadTrackedPaths(rootDir, paths, baseSha?)`: `baseSha` 指定時は `git ls-tree -r <baseSha>` も batch で probe し和集合 (FR-009)。conservative fallback (失敗 batch を tracked 扱い) は両 tree に適用。JSDoc の HEAD 前提記述も更新。
  - Files: src/diff.ts
- [x] T008 Refactor: `-z` 化に伴う既存テスト・呼び出し元の追随を grep で確認 (`parseDiffFiles` が deadcode になる場合は knip 対応)。`getGitDiffFiles` の既存呼び出し (impact 側 `src/commands/impact.ts` 等) が引数なしで従来どおり動くことを確認。〔観点: 変更外影響〕
  - Files: src/diff.ts, tests/diff.test.ts, (grep 対象: src/commands/impact.ts ほか getGitDiffFiles 呼び出し元)

**Checkpoint**: merge-base 解決と git 配管の base 対応が単体で green。コマンド層へ配線可能。

---

## Phase 3: User Story 1 — CI で PR の新規問題だけを gate する (P1) 🎯 MVP

**Goal**: `check --diff --base <ref> --gate` が、作業ツリー clean でも base range の新規問題で exit 2 / なければ exit 0。
**Independent Test**: base ブランチ fixture でコミット済み新規 orphan → exit 2、純リファクタ → exit 0。

- [x] T009 [P] [US1] Red: `tests/check-base-ref.test.ts` を新規作成。`makeRepoWithBaseBranch` で (a) feature ブランチに新規 orphan をコミット (tree clean) → `check --diff --base <base> --gate` が exit 2 + `newIssues.orphans` に該当、(b) 無害なコミットのみ → exit 0、(c) base 側 pre-existing 債務が suppress される、を検証 (失敗する)。〔観点: 条件分岐の組み合わせ〕
  - Files: tests/check-base-ref.test.ts
- [x] T010 [US1] Green: `src/commands/check.ts` に `--base <ref>` option を追加し (FR-001)、`--diff` 分岐内で data-model §4 のフローを実装: `classifyBaseRef` → `resolveMergeBase` → `baseSha` を `getGitDiffFiles` / `getGitRenameMap` / `getHeadTrackedPaths` / `computeBaselineIssues(rootDir, baseSha ?? "HEAD", lock, config)` に配布 (FR-005/006/007/008/009 の配線)。merge-base は 1 回だけ解決し再解決しない (SSOT)。
  - Files: src/commands/check.ts
- [x] T011 [P] [US1] Red→Green: moved-ahead base — 分岐後に base 側で「branch point 時点の issue を修正するコミット」を積んだ fixture で、その issue が引き続き suppress され exit 0 になること (`<ref>` tip を baseline に使うと exit 2 になる入力であることを fixture コメントで明示)。〔観点: エッジケース (D1 の核心)・実運用事故 (CI の常態)〕
  - Files: tests/check-base-ref.test.ts, tests/helpers.ts
- [x] T012 [P] [US1] Red→Green: base..HEAD 内のコミットで sole `@impl` ファイルを削除 (A1) — REQ の uncovered 転落が exit 2 で捕まること (probe が merge-base tree を見ないと「not tracked」exit 0 に化ける #229 再発形の回帰固定)。既存 `makeRepoWithSoleImplTag` を base ブランチ形に拡張。〔観点: 例外系・実運用事故 (fail-open #1 リスク)〕
  - Files: tests/check-base-ref.test.ts, tests/helpers.ts
- [x] T013 [P] [US1] Red→Green: base..HEAD 内のコミット済み pure rename (A2) — pre-existing orphan を持つファイルを `git mv` + commit した後も orphan が suppress され exit 0 (FR-008 が inverse-rename と orphan-key 正規化の両方に効くことを、rename+削除の複合ケース含めて検証)。〔観点: エッジケース (017 C2/SC-004 の base-range 版)〕
  - Files: tests/check-base-ref.test.ts, tests/helpers.ts

**Checkpoint**: CI の主経路 (US1) が単独で動作・テスト可能。

---

## Phase 4: User Story 2 — ローカル pre-push (和集合の意味論) (P2)

**Goal**: `--base` はコミット間差分を **追加** する — 作業ツリー差分 (untracked 含む) は縮小しない。
**Independent Test**: コミット済み + 未コミットの混在 diff で両方が判定に入る。

- [x] T014 [P] [US2] Red→Green: `tests/check-base-ref.test.ts` に (a) コミット済み新規 orphan + untracked の新規ファイルの混在 → 両方が変更ファイル集合に入り exit 2、(b) untracked のみ (`--base` あり) → 現行 `--diff` と同じ判定、を検証・実装。〔観点: 境界条件 (union の両端)〕
  - Files: tests/check-base-ref.test.ts
- [x] T015 [P] [US2] Red→Green: 空 merged diff + `--base` (base と同一 tip かつ clean) → 「No changes detected in git diff.」exit 0、CI 警告が stderr にも json `warnings[]` にも **出ない** (FR-010)。既存 E1 suite (`tests/check-baseline-diff.test.ts:175-224`) を「CI=true + `--base` あり」ケースで拡張し、`--base` なしの既存 3 テストは (文言更新後の) 期待値で維持。〔観点: 条件分岐の組み合わせ (CI × --base × format)・変更外影響〕
  - Files: tests/check-baseline-diff.test.ts, tests/check-base-ref.test.ts, src/commands/check.ts
- [x] T016 [P] [US2] Red→Green: 非 ASCII path (A4) — `specs/日本語.md` を base..HEAD 内のコミットでのみ変更した fixture で、そのファイルが scope に入り判定されること (SC-007)。〔観点: エッジケース (非 ASCII)〕
  - Files: tests/check-base-ref.test.ts
- [x] T017 [US2] Red→Green: `--base HEAD` (merge-base == HEAD) → Phase 1 (HEAD 固定) と同一の判定になる退化ケース。〔観点: 境界条件〕
  - Files: tests/check-base-ref.test.ts

**Checkpoint**: union 意味論が両環境 (CI clean tree / ローカル dirty tree) で正しい。

---

## Phase 5: User Story 3 — fail-closed エラー系 (P2)

**Goal**: 構成ミス・shallow clone を黙って pass にしない (exit 1 + 対処ヒント)。
**Independent Test**: 存在しない ref / unrelated histories / `--diff` なし、の 3 系統で exit 1。

- [x] T018 [P] [US3] Red: `tests/check-base-ref.test.ts` に (a) `check --base <ref>` ( `--diff` なし) → exit 1 + stderr に `--diff` 案内、JSON 非出力 (`--format json` でも同様、contracts §2-2)、(b) `check --diff --base nosuchref --gate` → exit 1 + `FETCH_DEPTH_HINT` 文言 (A10)、(c) unrelated histories fixture で merge-base 失敗 → exit 1 + 同ヒント (shallow clone の代理再現)、(d) (b)(c) の `--gate` なし → 警告 + 全表示 exit 0 + `baselineStatus:"unavailable"` / `baselineError` にヒント、を検証 (失敗する)。〔観点: 例外系・条件分岐の組み合わせ〕
  - Files: tests/check-base-ref.test.ts, tests/helpers.ts
- [x] T019 [US3] Green: `src/commands/check.ts` に FR-002 の usage 検証 (option パース直後、`--diff` 分岐より前) と、FR-004/FR-005 の unavailable 合流 (`{ keys:∅, status:"unavailable", error: 原因 + FETCH_DEPTH_HINT }` を組み立てて既存フローに流す) を実装。exit 1 の text 出力は contracts §7 の形式。
  - Files: src/commands/check.ts
- [x] T020 [P] [US3] Red→Green: `--ignore` 併用の安全性 (FR-012) — `--diff --base nosuchref --gate --ignore REQ-XXX` が exit 1 のまま (pass 再計算が `unavailable` を non-passing に保つ) ことを検証。〔観点: 不正な状態遷移 (--ignore による fail-open 防止)〕
  - Files: tests/check-base-ref.test.ts

**Checkpoint**: US1〜US3 が揃い、ゲートの意味論とエラー系が完成。

---

## Phase 6: 回帰固定 (byte-identical / 変更外影響)

- [x] T021 [P] `tests/check-base-ref.test.ts` (または `tests/check-baseline-diff.test.ts`) に SC-005 の回帰テスト — `--base` なしの `check --diff --gate --format json` の出力が、同一 fixture に対して本 feature 前の shape・値と一致すること (baselineStatus / newIssues / warnings を含む)。`getGitDiffFiles` 引数なしの集合同一性は T006(a) で担保済み。〔観点: 変更外影響 (byte-identical)〕
  - Files: tests/check-base-ref.test.ts
- [x] T022 [P] 既存テストの追随 — `-z` 化 (T007a) と CI 警告文言更新 (T024) で期待値が変わる既存テストを更新: `tests/check-baseline-diff.test.ts` E1 suite (:182-212 の警告文言)、`tests/diff.test.ts` / `tests/cli.test.ts` の getGitDiffFiles 系 (存在すれば)。非 ASCII path の表記変更が既存 fixture を壊さないことを `pnpm test` で確認。〔観点: 変更外影響〕
  - Files: tests/check-baseline-diff.test.ts, tests/diff.test.ts, tests/cli.test.ts
- [x] T023 [P] `trace.staleness: "gate"` × `--base` の相互作用を表駆動で 1 ケース pin — base range で scope 入りした stale evidence が独立チャネルの exit 2 として発火する (spec.md Assumptions の「意味的に正しい」挙動をテストで固定し、暗黙の回帰を防ぐ)。〔観点: 条件分岐の組み合わせ〕
  - Files: tests/check-base-ref.test.ts

---

## Phase 7: Polish — in-code 文言 / docs / skills / templates / dogfood

### 7A. in-code 文言の #185 消化 (FR-011)

- [x] T024 `src/commands/check.ts` の更新: (a) `:92` CI 警告文言を「`--base <ref>` を渡せば CI でゲートが有効になる」旨へ書き換え (もう Phase 2 の future work ではない)、(b) `:82-89` の E1 コメントと `:157` 付近の「Phase 2 can expose --base (FR-012)」コメントを実装済みの記述へ更新。E1 テストの文言アサーション (T015/T022) と同時に。
  - Files: src/commands/check.ts, tests/check-baseline-diff.test.ts
- [x] T025 [P] `src/baseline.ts:174` の submodule メッセージ "see #185" を更新 — submodule は本 feature でも未対応のため、「not supported」の恒常文言 (または新 follow-up issue 参照) に改める。対応する `tests/baseline.test.ts` のメッセージアサーションがあれば追随。
  - Files: src/baseline.ts, tests/baseline.test.ts

### 7B. docs / README

- [x] T026 [P] `README.md` / `README.ja.md` の CI gate 節に GitHub Actions レシピを追加 (quickstart.md S1 と同内容: `actions/checkout@v4` + `fetch-depth: 0` + `pnpm exec artgraph check --diff --base origin/${{ github.base_ref }} --gate`)。shallow clone は fail-closed (exit 1) である旨を注記。両言語で等価に。〔観点: doc 同時更新 (Cat3)〕
  - Files: README.md, README.ja.md
- [x] T027 [P] `docs/commands.md` の `artgraph check` 節に `--base <ref>` を追記 (merge-base 意味論 / `--diff` 必須 / exit code / CI 用途)。
  - Files: docs/commands.md
- [x] T028 [P] `docs/architecture.md` の更新: `:216-222` の CLI 表 check 行に `--base <ref>` (CI: merge-base 基準のコミット間ゲート) を追記、`:274` 周辺 (Stop hook 例) に「CI では `--base` を使う。Stop hook は作業ツリー diff のまま」の注記。共通フラグ行 (`:222`) にも `--base` を追加。
  - Files: docs/architecture.md

### 7C. skills / templates (配布物の consistency テストに注意)

- [x] T029 `templates/skills/artgraph-verify/SKILL.md` に CI 実行形 (`check --diff --base <ref> --gate`) と unavailable 時の fetch-depth ヒントの解釈を追記し、`templates/skills/_shared/output-schema.md` の `baselineStatus` 表へ CI (--base) 行 — `"unavailable"` の発生条件に「`--base` の ref 解決不能 / merge-base 失敗 (shallow clone)」を追加、exit code 表 (:191-193) の `1` の説明に `--base` usage error を追記、`staleness:"gate"` の scope 拡大注記。**per-agent 配布複製** (`.claude/` / `.agents/` / `.cursor/` / `.github/` / `.kiro/` 配下) をミラー更新し、`tests/skills-templates.test.ts` の同期検査と `tests/docs-trio-consistency.test.ts` を green に保つ。〔観点: 変更外影響 (dogfood parity)〕
  - Files: templates/skills/artgraph-verify/SKILL.md, templates/skills/_shared/output-schema.md, .claude/skills/**, .agents/skills/**, .cursor/skills/**, .github/skills/**, .kiro/skills/** (配布複製), tests/skills-templates.test.ts (期待値追随が必要な場合)
- [x] T030 [P] SDD 統合テンプレートの追記: `templates/integrate/speckit/commands/artgraph.check-diff.md` / `artgraph.check-gate.md` と `templates/integrate/kiro/artgraph.md` に「CI では `--base <ref>` を併用する」1 行を追加。`templates/agent-context/agents-md-snippet.md` の Common workflows に CI gate 行 (`pnpm exec artgraph check --diff --base origin/<base> --gate`) を追加し、この repo の `AGENTS.md` にも同じ行を反映 (snippet と実体の等価性を保つ)。
  - Files: templates/integrate/speckit/commands/artgraph.check-diff.md, templates/integrate/speckit/commands/artgraph.check-gate.md, templates/integrate/kiro/artgraph.md, templates/agent-context/agents-md-snippet.md, AGENTS.md

### 7D. dogfood / タグ付け / 最終確認

- [x] T031 本 spec の FR にコード側 `@impl 023-check-base-ref/FR-NNN` タグを付与 (原則 III。spec 017 の `// @impl 017-check-gate-baseline-diff/FR-010` 形式を踏襲): FR-001/002/005/007/010/011 → `src/commands/check.ts`、FR-004/005 (`resolveMergeBase` / `FETCH_DEPTH_HINT`) → `src/baseline.ts`、FR-006/008/009 → `src/diff.ts`。FR-003/012 は回帰・設計制約のためテスト側 pin が主 (必要ならフロー分岐点にタグ)。新規 REQ-ID (`023-check-base-ref/FR-001`〜`FR-012`) の既存衝突なしを再確認 (Cat6)。テスト側は `tests/check-base-ref.test.ts` の該当 describe/it に spec 017 テストと同様のコメント参照 (`// @impl 023-check-base-ref/...` は不要 — verifies はテストタイトル/コメントの REQ 言及で辿れる形に) を付す。〔観点: 変更外影響 (dogfood)〕
  - Files: src/commands/check.ts, src/baseline.ts, src/diff.ts, tests/check-base-ref.test.ts
- [x] T032 `specs/017-check-gate-baseline-diff/` の forward-pointer 注記が入っていることを確認 (spec.md FR-002/FR-012/Assumptions、contracts/baseline-diff.md §2 — 本 spec 作成時に追記済み)。`pnpm exec artgraph scan && pnpm exec artgraph check` で 023 の FR が意図どおり登録され、実装前は uncovered として見えることを確認 (実装完了で解消)。
  - Files: specs/017-check-gate-baseline-diff/spec.md, specs/017-check-gate-baseline-diff/contracts/baseline-diff.md (確認のみ)
- [x] T033 `quickstart.md` S1〜S6 を手動実行し全期待値を確認。特に S1 (実 CI or act 相当での fetch-depth: 0 レシピ) と S6 (byte-identical 回帰)。
  - Files: (検証のみ)
- [x] T034 `pnpm build && pnpm test` (unit+e2e+perf) 全通過、`pnpm knip` / `pnpm typecheck` クリーン、本 repo で `node dist/cli.js check --diff --gate` exit 0 (回帰なし) と `node dist/cli.js check --diff --base origin/main --gate` の動作確認。
  - Files: (検証のみ)

---

## Dependencies (完了順)

```
Phase 1 (Setup: T001 実測 / T002 fixture)
   └─► Phase 2 (Foundational: T003-T005 resolveMergeBase → T006-T008 diff.ts)  ← 全 US の前提
          ├─► Phase 3 (US1: T009-T013 コマンド配線 + CI 主経路) ─┐
          ├─► Phase 4 (US2: T014-T017 union 意味論)             ─┤ US2/US3 は T010 の配線に依存
          └─► Phase 5 (US3: T018-T020 fail-closed)              ─┘
                 └─► Phase 6 (回帰固定: T021-T023)
                        └─► Phase 7 (Polish: 7A 文言 → 7B/7C docs/templates → 7D dogfood)
```

- **T010 (コマンド配線) が US2/US3 の前提**。T019 (エラー系) は T010 のフローに差し込む。
- T015 (CI 警告抑制) と T024 (警告文言更新) は同じ文字列を触るため、T024 を T015 の直後に寄せてもよい (E1 アサーションの二度書き換えを避ける)。
- Phase 7C (skills 複製ミラー) は 7B の文言確定後にまとめて 1 コミットで行う (`tests/skills-templates.test.ts` が中間状態で赤くなるのを避ける)。

## Parallel Opportunities

- Phase 2: T003 (baseline.test) と T006 (diff.test) は別ファイルで [P] 並列可。
- Phase 3-5 の Red テスト ([P]) は T010 実装前に並列で書ける。
- Phase 7: T025 / T026 / T027 / T028 / T030 は別ファイルで並列可。

## Implementation Strategy

- **MVP = Phase 1 + 2 + 3 (US1)**: CI で PR gate が機能する時点で本 feature の主価値が出る。ここで一度 CI 実機 (fetch-depth: 0) で dogfood 確認。
- 続けて US2 (union) → US3 (fail-closed) → 回帰固定 → docs/templates。
- **`impact --base` は対象外** — 本 feature の `resolveMergeBase` / `getGitDiffFiles(rootDir, baseSha?)` を再利用する follow-up issue を起票する (plan.md Follow-up)。

## Definition of Done (実装時 Engineering Hygiene)

- [x] 全テスト green (TDD: 各ユニットで Red を先に確認してから Green)。
- [x] `--base` なしの全経路が byte-identical (SC-005 回帰テストで固定、Cat5)。
- [x] merge-base SHA の SSOT (resolveMergeBase 1 回解決 → 引数配布、再解決ゼロ) と FETCH_DEPTH_HINT の単一定数化 (Cat2, data-model §5)。
- [x] union の dedup key (path 文字列) が `-z`/quotePath 統一で成立していることをテストで pin (Cat7)。
- [x] 異常系 8 系統のうち該当分 (不在 ref / unrelated histories / shallow / 非 ASCII / 空 diff) を処理 (Cat1)。
- [x] 変更外ファイル (E1 suite / diff 系既存テスト / skills 5 複製 / docs) の追随完了 (Cat3)。
- [x] ドッグフード: `artgraph check --diff` drift=0、`artgraph plan-coverage` implicit=0。

---

## Considered: implicit impacts (artgraph plan-coverage 消化記録)

plan-coverage が検出した本 plan の Files: からの graph 到達 REQ。各行の判断:

- Considered: T026-T030 の docs/templates 1 行追記による doc-graph 到達のみ。要件影響なし — 009-sdd-integration/FR-001, 009-sdd-integration/FR-002, 009-sdd-integration/FR-003, 009-sdd-integration/FR-004, 009-sdd-integration/FR-005, 009-sdd-integration/FR-006, 009-sdd-integration/FR-007, 009-sdd-integration/FR-008, 009-sdd-integration/FR-009, 009-sdd-integration/FR-010, 009-sdd-integration/FR-011, 009-sdd-integration/FR-012, 009-sdd-integration/FR-013, 009-sdd-integration/FR-014, 009-sdd-integration/FR-015, 009-sdd-integration/FR-016, 009-sdd-integration/FR-017, 009-sdd-integration/FR-018, 009-sdd-integration/FR-019, 009-sdd-integration/FR-020, 009-sdd-integration/FR-021, 009-sdd-integration/FR-022, 009-sdd-integration/FR-023, 009-sdd-integration/FR-024, 009-sdd-integration/SC-001, 009-sdd-integration/SC-002, 009-sdd-integration/SC-003, 009-sdd-integration/SC-004, 009-sdd-integration/SC-005, 009-sdd-integration/SC-006, 009-sdd-integration/SC-007
- Considered: T029 の skills 配布複製ミラー更新による到達のみ。配布機構自体は不変 — 013-cross-agent-extensions/FR-001, 013-cross-agent-extensions/FR-002, 013-cross-agent-extensions/FR-003, 013-cross-agent-extensions/FR-004, 013-cross-agent-extensions/FR-005, 013-cross-agent-extensions/FR-006, 013-cross-agent-extensions/FR-007, 013-cross-agent-extensions/FR-008, 013-cross-agent-extensions/FR-009, 013-cross-agent-extensions/FR-010, 013-cross-agent-extensions/FR-011, 013-cross-agent-extensions/FR-012, 013-cross-agent-extensions/FR-013, 013-cross-agent-extensions/FR-014, 013-cross-agent-extensions/SC-001, 013-cross-agent-extensions/SC-002, 013-cross-agent-extensions/SC-003, 013-cross-agent-extensions/SC-004, 013-cross-agent-extensions/SC-005, 013-cross-agent-extensions/SC-006, 013-cross-agent-extensions/SC-007, 013-cross-agent-extensions/SC-008
- Affected: check --diff baseline 基盤 spec。意味論は保存 (023/FR-003 byte-identical)、FR-002/FR-012 に forward-pointer 注記済み — 017-check-gate-baseline-diff/FR-001, 017-check-gate-baseline-diff/FR-002, 017-check-gate-baseline-diff/FR-003, 017-check-gate-baseline-diff/FR-004, 017-check-gate-baseline-diff/FR-005, 017-check-gate-baseline-diff/FR-006, 017-check-gate-baseline-diff/FR-007, 017-check-gate-baseline-diff/FR-008, 017-check-gate-baseline-diff/FR-009, 017-check-gate-baseline-diff/FR-011, 017-check-gate-baseline-diff/FR-012, 017-check-gate-baseline-diff/FR-013, 017-check-gate-baseline-diff/FR-014, 017-check-gate-baseline-diff/SC-001, 017-check-gate-baseline-diff/SC-002, 017-check-gate-baseline-diff/SC-003, 017-check-gate-baseline-diff/SC-004, 017-check-gate-baseline-diff/SC-005, 017-check-gate-baseline-diff/SC-006
- Considered: check.ts の trace 配線は不変。staleness gate との相互作用は spec.md Assumptions に記載 (T023 で pin) — 020-coverage-derived-edges/FR-001, 020-coverage-derived-edges/FR-002, 020-coverage-derived-edges/FR-003, 020-coverage-derived-edges/FR-004, 020-coverage-derived-edges/FR-005, 020-coverage-derived-edges/FR-006, 020-coverage-derived-edges/FR-007, 020-coverage-derived-edges/FR-008, 020-coverage-derived-edges/FR-009, 020-coverage-derived-edges/FR-010, 020-coverage-derived-edges/FR-011, 020-coverage-derived-edges/FR-012, 020-coverage-derived-edges/FR-013, 020-coverage-derived-edges/FR-014, 020-coverage-derived-edges/FR-015, 020-coverage-derived-edges/FR-016, 020-coverage-derived-edges/FR-017, 020-coverage-derived-edges/FR-018, 020-coverage-derived-edges/FR-019, 020-coverage-derived-edges/FR-020, 020-coverage-derived-edges/FR-021, 020-coverage-derived-edges/SC-001, 020-coverage-derived-edges/SC-002, 020-coverage-derived-edges/SC-003, 020-coverage-derived-edges/SC-004, 020-coverage-derived-edges/SC-005, 020-coverage-derived-edges/SC-006, 020-coverage-derived-edges/SC-007
- Considered: trace ingest/engine は不変。テストファイル共有による到達のみ — 022-instrumented-trace-engine/FR-001, 022-instrumented-trace-engine/FR-002, 022-instrumented-trace-engine/FR-003, 022-instrumented-trace-engine/FR-004, 022-instrumented-trace-engine/FR-005, 022-instrumented-trace-engine/FR-006, 022-instrumented-trace-engine/FR-007, 022-instrumented-trace-engine/FR-008, 022-instrumented-trace-engine/FR-009, 022-instrumented-trace-engine/FR-010, 022-instrumented-trace-engine/FR-011, 022-instrumented-trace-engine/FR-012, 022-instrumented-trace-engine/FR-013, 022-instrumented-trace-engine/FR-014, 022-instrumented-trace-engine/FR-015, 022-instrumented-trace-engine/FR-016, 022-instrumented-trace-engine/SC-001, 022-instrumented-trace-engine/SC-002, 022-instrumented-trace-engine/SC-003, 022-instrumented-trace-engine/SC-004, 022-instrumented-trace-engine/SC-005, 022-instrumented-trace-engine/SC-006
- Affected: 本 feature の実装対象 FR/SC (T003-T034 で実装・検証) — 023-check-base-ref/FR-002, 023-check-base-ref/FR-003, 023-check-base-ref/FR-004, 023-check-base-ref/FR-005, 023-check-base-ref/FR-006, 023-check-base-ref/FR-007, 023-check-base-ref/FR-008, 023-check-base-ref/FR-009, 023-check-base-ref/FR-010, 023-check-base-ref/FR-011, 023-check-base-ref/FR-012, 023-check-base-ref/SC-001, 023-check-base-ref/SC-002, 023-check-base-ref/SC-003, 023-check-base-ref/SC-004, 023-check-base-ref/SC-005, 023-check-base-ref/SC-006, 023-check-base-ref/SC-007
- Considered: docs 経由の doc-graph 到達のみ。要件影響なし — REQ-3
- Considered: docs 経由の doc-graph 到達のみ。要件影響なし — design/SC-005
