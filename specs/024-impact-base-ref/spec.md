# Feature Specification: impact --diff --base <ref> — CI テスト選択 (spec 023 follow-up)

**Feature Branch**: `feat/impact-base-ref`

**Created**: 2026-07-15

**Status**: Draft

**Input**: issue [#305](https://github.com/mori-shin-x/artgraph/issues/305) — spec 023 D3 / Out of Scope が follow-up として委ねた `impact --base`。CI の checkout は作業ツリーがコミットと完全一致するため、`impact --diff --tests` (spec 020 FR-018 のテスト選択) の変更ファイル集合 (staged + unstaged + untracked) は恒常的に空になり、「No changes detected in git diff.」exit 0 でテスト選択が無言で空振りする。`--base <ref>` で PR のコミット範囲 (merge-base..HEAD) を変更ファイル集合に加え、CI での変更起因テスト選択を可能にする。

## Clarifications

### Session 2026-07-15/16 (approved design decisions, issue #305)

- **Decision D-1 — current-graph-only 意味論**: `impact` は baseline worktree を **持たない**。base..HEAD 内のコミットで削除されたファイルは merged diff には現れるが、現在グラフで startId を解決せず、エラーも警告もなく何も寄与しない (silent)。これは **宣言された選択の限界 (declared selection limitation)** である: `impact --tests` は最適化レイヤーであり、コミット済み削除の正しさゲートは `check --diff --base --gate` (spec 023 SC-003 / baseline union) が担う。却下した代替案 (未解決 diff path を `ownerFilePath` で trace evidence に直接 join する trace-join 回復 — 安価で、後から追加可能) は research.md に follow-up 候補として記録し、本 feature では明示的に out of scope とする。
- **Decision D-2 — fail-closed エラー**: `classifyBaseRef !== "resolved"` → `error: base ref "<ref>" does not resolve` + `FETCH_DEPTH_HINT`。`resolveMergeBase` 失敗 → その診断文字列 (ヒント既含)。どちらも **stderr のみ・`--format json` でも JSON を出さない** (環境失敗は verdict ではない)・exit 1。working-tree-only diff への fallback は行わない (spec 023 research R6 parity)。display-only 縮退 (check の `--gate` なし警告続行に相当) を持たない理由: impact には gate / no-gate の区別がなく、CI consumer は exit 1 を見て full suite に fallback しなければならないため。
- **Decision D-3 — `--base` は `--diff` 必須**: hard usage error exit 1。文言は check FR-002 をミラーする ("--base sets the base point of the git diff...")。検証の優先順位を pin する: REQ-ID / `doc:` rejection が先 (不変)、**次に --base-requires-diff、その後に** targets×`--diff` 排他 / no-source 検査。したがって `impact src/a.ts --base x` (`--diff` なし) は「--base requires --diff」で落ち、`impact src/a.ts --diff --base x` は排他エラーで落ちる。
- **Decision D-4 — 全 path 未解決の merged diff**: 今日の exit 1「No matching nodes found」を維持する (`--base` なしと byte-identical の経路 — `--base` は新しい early exit を追加しない)。CI consumer 向けに exit code と fallback 規則をドキュメント化する (D-5)。
- **Decision D-5 — consumer rule (mandatory FR + docs)**: 「削除された、またはグラフ未追跡の変更ファイルは startId を寄与しない。`impact --tests` は **最適化** として扱うこと — exit 1 時や不確かな場合は full suite に fallback する。正しさのゲートは `check --diff --base --gate` のまま。」
- **Decision D-6 — 検証順** (contract §2): commander parse (`--base` 値の parse 時ガード — `nonOptionValue`、空文字列と `-` 始まりを拒否 (spec 023 F1/F2 クラス) — と `--format` の `.choices()`) → REQ-ID rejection → `doc:` rejection → --base-requires-diff → targets/`--diff` 排他 + no-source → `--tests` shard 存在ガード (`TRACE_NO_SHARDS_GUIDANCE`) → **base-ref 検証 + merge-base 解決 (1 回、scan より前 — fast fail。check は scan 後の `--diff` 分岐内で解決するが、impact には先に scan を払う理由がない)** → scan → `getGitDiffFiles(rootDir, baseSha)` による merged diff。
- **Decision D-7 — `--format` の `.choices()` 化**: FR としてスコープに含める。`src/commands/impact.ts:65` は issue #306 F7 後、gate 隣接コマンド群 (check / doctor / rename / plan-coverage / integrate は `.choices()` 済み) の中で唯一の raw `--format` である。bogus 値の silent text fallback と、greedy な `--format --diff` swallow を修正する。小さな挙動変更 (bogus 値が exit 1 になる) は独立の変更点として明示する。
- **Decision D-8 — rename**: impact に `getGitRenameMap` を **追加しない**。base range の rename は `-M` により new path 1 エントリに畳まれるが、それは current-graph query には正しい (rename map は baseline グラフの old path への翻訳のため **だけ** に存在する)。意図的な非目標として明記し、レビュアーが「rename 対応漏れ」として追加しないようにする。
- **Decision D-9 — staleness exclude**: CI で `trace.staleness: "exclude"` + `--base` + `--tests` を組み合わせると、変更されたコードの evidence はちょうど stale-by-construction (trace 取得時からハッシュが変わっている) で除外され、**そのテストが選択されない** — 機能の目的を反転させる。FR: spec / docs / output-schema.md に明記し、かつ 3 条件の共起時 (`--tests && --base && staleness === "exclude"`) に **非致命の stderr 警告** を実行時に出す。
- **Agreement property (FR 化)**: 同一 repo 状態・同一 `<ref>` に対し、(i) impact の merged changed-file set は check のそれと **一致する** (両者とも単一の `resolveMergeBase` 意味論からの `getGitDiffFiles(rootDir, sha)`)、(ii) check-scope ⊇ impact-reach であり、⊂ には決してならない (deleted-edge ケースは正当に superset になる)。US4 agreement test (`tests/check-baseline-diff.test.ts:576-609`) を `--base` variant で拡張する。

## 背景 / 問題

spec 023 は `check --diff --base <ref> --gate` で CI の PR ゲートを実現し、その配管 (`resolveMergeBase` / `getGitDiffFiles(rootDir, baseSha?)` / `FETCH_DEPTH_HINT`) を再利用可能な形で実装した (023 plan.md Follow-up)。しかし `impact` は据え置かれた (023 D3): CI の checkout では作業ツリーが clean のため、`impact --diff --tests` (spec 020 FR-018) は「No changes detected」exit 0 で常に空選択になり、**CI での変更起因テスト選択という spec 020 の主ユースケースが CI で機能しない**。

本 feature は `impact` に `--base <ref>` を追加し、変更ファイル集合を check と同一の merged diff (three-way union ∪ merge-base..HEAD) に拡張する。check と異なり **baseline worktree は導入しない** (D-1): impact は現在グラフに対する forward query であり、テスト選択は最適化レイヤーとして「選び漏れは full suite への fallback で回復できる」ことを契約に含める (D-5)。`--base` 未指定の挙動は byte-identical とする (D-7 の `--format` 検証強化のみ独立の例外)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — CI で PR のコミット範囲からテストを選択する (Priority: P1)

開発者が PR を出す。GitHub Actions が `actions/checkout` (`fetch-depth: 0`) で PR の head をチェックアウトし、`artgraph impact --diff --base origin/${{ github.base_ref }} --tests --format json` を実行して `testsToRun` を抽出し、選択されたテストだけを実行する。exit 1 (環境失敗 / 未解決) の場合は full suite に fallback する。

作業ツリーが clean であること (CI の通常状態) は選択の空振りを意味しない — merged diff は PR のコミット範囲を含む。

**Why this priority**: 本 feature の存在理由。spec 020 のテスト選択 (`impact --diff --tests`) を CI に届かせる唯一の手段であり、spec 023 D3 / plan.md Follow-up が明示的に本 feature へ委ねた。

**Independent Test**: base ブランチと feature ブランチ + trace shards を持つ一時 git repo で、feature ブランチに REQ を exercise するコードの変更をコミット (作業ツリー clean) し、`impact --diff --base <base> --tests --format json` の `testsToRun` にその REQ のタグ付きテストが列挙されることを確認する。`--base` なしでは「No changes detected」になる同一入力であること。

**Acceptance Scenarios**:

1. **Given** feature ブランチに、trace evidence が exercise している symbol を変更するコミット (作業ツリー clean)、 **When** `impact --diff --base <base> --tests --format json`、 **Then** exit 0 で `testsToRun` に該当 REQ のタグ付きテストが列挙される (`--base` なしの同一実行は「No changes detected」)。
2. **Given** merged diff の一部がグラフ未追跡ファイル (README 等) のコミット、 **When** 同上、 **Then** 未追跡ファイルは startId を寄与せず (エラーなし、D-1)、残りの解決分から選択される。
3. **Given** 同一 repo 状態・同一 `<ref>`、 **When** `impact --diff --base <ref>` と `check --diff --base <ref>` を実行、 **Then** 両者の merged changed-file set は一致する (agreement (i))。
4. **Given** base..HEAD 内のコミットで sole `@impl` ファイルが削除されている、 **When** `impact --diff --base <base> --tests` と `check --diff --base <base> --gate`、 **Then** impact は削除ファイル由来の選択を含まず (silent、D-1)、check は exit 2 で uncovered 転落を捕まえる — 宣言どおりの分業 (check-scope ⊇ impact-reach)。

---

### User Story 2 — ローカルで push 前にブランチ全体のテスト選択をする (Priority: P2)

開発者が feature ブランチで数コミット積んだ後、push 前に `artgraph impact --diff --base origin/main --tests` を実行し、「このブランチ全体 + 手元の未コミット変更」が触るテストだけを再実行する。

作業ツリーの未コミット変更 (staged / unstaged / untracked) も従来どおり変更ファイル集合に含まれる — `--base` はコミット間差分を **追加** するのであって、作業ツリー差分を置き換えるのではない (spec 023 FR-006 と同一の union 意味論を `getGitDiffFiles` の共有で継承)。

**Why this priority**: CI (US1) と同じ機構のローカル利用。選択の意味論 (union) が両環境で一致していることが、CI の選択結果を手元で再現・デバッグできる条件になる。

**Independent Test**: コミット済み変更 + untracked 新ファイルの両方を持つ repo で `impact --diff --base <base>` を実行し、変更ファイル集合が両者の和集合になることを確認する。

**Acceptance Scenarios**:

1. **Given** コミット済みの変更 + untracked の新規ファイル (グラフ追跡対象)、 **When** `impact --diff --base <base> --format json`、 **Then** 両方が startId 解決の入力に入り、`affectedFiles` に両系統の到達が現れる。
2. **Given** `--base HEAD` (merge-base == HEAD、コミット間差分が空)、 **When** `impact --diff --base HEAD`、 **Then** 現行の `--diff` (作業ツリーのみ) と同一の結果に退化する。
3. **Given** `--base` を指定しない従来の実行 (targets / `--diff` / `--tests` の全組み合わせ)、 **When** 実行、 **Then** 挙動は本 feature 導入前と byte-identical (FR-003。唯一の例外は FR-010 の `--format` bogus 値で、それは独立に pin する)。

---

### User Story 3 — 構成ミス・shallow clone は fail-closed で明示エラー (Priority: P2)

CI 担当者が `--diff` を書き漏らす、`fetch-depth: 1` のまま実行する、または base-ref 変数が空展開する。テスト選択は「黙って全選択 / 黙って空選択」のどちらにも縮退せず、exit 1 と対処ヒントで終了する。CI スクリプトは exit 1 を full suite への fallback トリガーにできる (D-5)。

**Why this priority**: 選択レイヤーの誤構成が「テストが走らない緑の CI」に化けることを防ぐ。fail-closed + fallback 規則が US1 の信頼の前提。

**Independent Test**: (a) `--diff` なしの `--base`、(b) 解決しない ref、(c) unrelated histories、の 3 系統で exit 1 + 各ヒントを確認。`--format json` でも stdout に JSON が出ないこと。

**Acceptance Scenarios**:

1. **Given** `--diff` なしで `--base` を指定 (targets の有無に関わらず)、 **When** `impact src/a.ts --base origin/main` / `impact --base origin/main`、 **Then** usage error「--base requires --diff」で exit 1 (D-3 の優先順位: 排他エラーより先)。JSON は出力されない。
2. **Given** `--base` に解決しない ref (typo / 未 fetch)、 **When** `impact --diff --base nosuchref --tests --format json`、 **Then** exit 1、stderr に `error: base ref "nosuchref" does not resolve` + `FETCH_DEPTH_HINT`、stdout に JSON なし (D-2)。
3. **Given** `<ref>` は解決するが merge-base が計算できない (shallow clone / unrelated histories)、 **When** `impact --diff --base <ref>`、 **Then** exit 1 + `resolveMergeBase` の診断 (fetch-depth ヒント込み)。working-tree-only diff への縮退はしない。
4. **Given** `--format` に bogus 値、 **When** `impact --diff --format yaml`、 **Then** commander の `.choices()` エラーで exit 1 (D-7 — 従来の silent text fallback を廃止)。
5. **Given** CI で base-ref 変数が空展開 (`--base --tests` / `--base ""`)、 **When** 実行、 **Then** parse 時の値ガードで usage error exit 1 (spec 023 F1/F2 クラス — 次フラグの swallow / no-base への無言縮退を許さない)。

---

### Edge Cases

- **base..HEAD 内のコミットで削除されたファイル (D-1)**: merged diff に現れるが、HEAD にも作業ツリーにも現在グラフにも存在せず startId を解決しない。警告なしで寄与ゼロ。**選択の限界として宣言** — 静的 import の削除は importer 側の編集 (import 文の除去) が merged diff に入るため、その経路のテストは importer 経由で選択される (bounded fail-open、research.md R1)。正しさは `check --diff --base --gate` (spec 023 SC-003) が担保。
- **merged diff の全 path が未解決 (D-4)**: 既存の exit 1「No matching nodes found」— `--base` なしと同一経路・同一文言。CI は exit 1 を full suite fallback として扱う (D-5)。
- **空 merged diff (base と同一 tip かつ clean tree)**: 既存の「No changes detected in git diff.」early exit。`--base` 指定時、これは **正当な clean 判定** (比較は実際に行われた) であり exit 0。JSON shape は既存 E4 payload (contract §4.2 で pin) — フィールド追加なし。
- **untracked ∪ range の和集合**: `--base` 指定時も untracked は集合に残る (US2 AS1)。`getGitDiffFiles` を check と共有するため、union 意味論・`-z`/quotePath 統一 (spec 023 FR-006) は無償で継承される。
- **`trace.staleness: "exclude"` × `--base` × `--tests` (D-9)**: 変更コードの evidence は stale-by-construction で除外され、そのテストが選択されない。非致命の stderr 警告 + docs 明記 (FR-012)。exit code / JSON は不変。
- **`--base HEAD` / HEAD と同一コミット**: merge-base == HEAD、コミット間差分は空 → 現行 `--diff` に自然退化 (US2 AS2)。
- **unborn HEAD で `--base HEAD`**: `classifyBaseRef` が `"unborn"` を返し `"resolved"` ではない → 「does not resolve」扱いの exit 1 (spec 023 contract F5 と同型の fail-closed。実運用で踏む形ではないため仕様として許容)。
- **非 ASCII path が base range にのみ含まれる**: spec 023 FR-006 が `getGitDiffFiles` 全体を `-z` + `core.quotePath=false` に統一済みのため、本 feature は追加対応なしで verbatim path を得る (Assumptions 参照)。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: システムは `impact` コマンドに `--base <ref>` オプションを追加しなければならない。意味論は spec 023 D1 と同一: `<ref>` の tip ではなく `git merge-base <ref> HEAD` (`resolveMergeBase` の再利用)。値は parse 時に fail-closed 検証する (spec 023 F1/F2 クラス): 空文字列と `-` で始まる値は `nonOptionValue` (src/commands/shared.ts) により usage error (exit 1) として拒否し、次フラグの swallow / no-base 動作への無言縮退を許さない。
- **FR-002**: `--base` は `--diff` と併用されなければならない。`--diff` なしの `--base` は fail-closed の usage error として exit 1 で即時終了する (D-3)。文言は check FR-002 をミラーする。検証位置を pin する: REQ-ID / `doc:` rejection の **後**、targets×`--diff` 排他 / no-source 検査の **前** — `impact src/a.ts --base x` は「--base requires --diff」で落ちる (排他エラーではない)。`--format json` 指定時も JSON を出力しない。
- **FR-003**: `--base` 未指定時の `impact` (targets / `--diff` / `--tests` / `--format` の全組み合わせ) の挙動は、本 feature 導入前と byte-identical でなければならない。唯一の意図的例外は FR-010 (`--format` bogus 値が silent text fallback から exit 1 に変わる) であり、独立の変更点として明示・テスト固定する。`IMPACT_REQ_ID_REJECTION` / `IMPACT_DOC_PREFIX_REJECTION` の文言は変更しない — targets は従来どおり同一に拒否され、`--base` は start source ではなく `--diff` の **modifier** である (エラーメッセージの start source 列挙に `--base` を加えない)。
- **FR-004**: `--base` の環境失敗は fail-closed とする (D-2): (a) `classifyBaseRef(rootDir, <ref>) !== "resolved"` → stderr に `error: base ref "<ref>" does not resolve` + `FETCH_DEPTH_HINT`、(b) `resolveMergeBase` 失敗 → その診断文字列 (ヒント既含)。どちらも exit 1 で、**stdout に JSON を出力しない** (`--format json` でも — 環境失敗は verdict ではない)。working-tree-only diff への fallback、警告のみでの続行は行わない。
- **FR-005**: merge-base は **1 回だけ** 解決しなければならない (`resolveMergeBase` 再利用、再実装禁止)。base-ref 検証と merge-base 解決は **scan より前** に行う (D-6 fast fail — check が scan 後の `--diff` 分岐内で解決するのと異なり、impact には環境失敗の前に scan コストを払う理由がない)。得られた baseSha の消費者は `getGitDiffFiles(rootDir, baseSha)` のみ (impact は rename map / tracked-path probe / baseline worktree を持たない — D-1/D-8)。
- **FR-006**: `--base` 指定時の変更ファイル集合は、check `--base` と **同一の定義・同一の実装** (`getGitDiffFiles(rootDir, baseSha)` の共有) による three-way union (staged ∪ unstaged ∪ untracked) ∪ コミット間差分でなければならない。merged diff が空の場合は既存の「No changes detected in git diff.」early exit (exit 0) に乗る — `--base` 指定時それは正当な clean 判定であり、JSON shape は既存 E4 payload のまま (フィールド追加なし、contract §4.2 で pin)。
- **FR-007**: startId 解決は **現在グラフのみ** で行う (D-1)。base..HEAD 内で削除されたファイルは merged diff に現れても startId を解決せず、エラー・警告なしで寄与しない。baseline worktree・baseline グラフ側の startId 解決を導入してはならない。これは宣言された選択限界であり、FR-009 の consumer rule とセットでドキュメント化する。
- **FR-008**: merged diff の全 path が startId を解決しない場合、既存の exit 1「No matching nodes found」で終了する (D-4) — `--base` なしの同経路と byte-identical で、`--base` は新しい early exit・新しいメッセージを追加しない。
- **FR-009**: consumer rule をドキュメント (README / docs/commands.md / SKILL.md / output-schema.md) に明記しなければならない (D-5): 「削除された、またはグラフ未追跡の変更ファイルは startId を寄与しない。`impact --tests` は最適化として扱うこと — exit 1 時や不確かな場合は full suite に fallback する。正しさのゲートは `check --diff --base --gate` のまま。」
- **FR-010**: `impact` の `--format` は `.choices(["json", "text"])` に変換しなければならない (D-7、issue #306 F7 の残余 — src/commands/impact.ts:65)。bogus 値は exit 1 (従来の silent text fallback を廃止 — 挙動変更として明示)、`--format --diff` の greedy swallow も parse 時に拒否される。
- **FR-011**: `impact` に `getGitRenameMap` を追加してはならない (D-8)。base range の rename は `getGitDiffFiles` の `-M` により new path 1 エントリに畳まれ、current-graph query にはそれが正しい (rename map は baseline グラフの old path への翻訳専用の機構であり、baseline を持たない impact に翻訳対象は存在しない)。意図的な非目標としてコードコメントと contract に明記する。
- **FR-012**: `--tests` と `--base` と `trace.staleness: "exclude"` が共起する場合、システムは非致命の stderr 警告を 1 回出力しなければならない (D-9): 変更コードの evidence は stale-by-construction で除外され、そのテストが選択されない可能性がある旨。exit code / JSON 出力は不変。あわせて docs / `templates/skills/_shared/output-schema.md` に相互作用を明記する。
- **FR-013**: agreement property を保証しなければならない: 同一 repo 状態・同一 `<ref>` に対し、(i) impact の merged changed-file set は check のそれと一致する (単一の `resolveMergeBase` 意味論 + `getGitDiffFiles(rootDir, sha)` の共有による構造的保証 — 独自の diff 取得を実装しない)、(ii) check-scope ⊇ impact-reach であり ⊂ には決してならない (deleted-edge ケースは正当に superset)。US4 agreement test (`tests/check-baseline-diff.test.ts:576-609`) を `--base` variant で拡張して pin する。

### Key Entities

- **base ref**: ユーザーが `--base` で指定する git 参照。検証は `classifyBaseRef`、意味論への寄与は merge-base 経由のみ (spec 023 と同一概念)。
- **merge-base SHA**: `resolveMergeBase(rootDir, <ref>)` の結果。impact での唯一の消費者は `getGitDiffFiles(rootDir, baseSha)` (check と異なり rename map / probe / baseline へは配布されない)。
- **merged diff files**: three-way union ∪ コミット間差分。**check と同一の関数・同一の定義** (agreement (i) の SSOT)。
- **testsToRun**: spec 020 FR-018 と同一の概念・同一の JSON 形。本 feature は評価対象の startId 集合が merged diff 由来に広がるだけで、evidence join・staleness フィルタの構造は不変。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `fetch-depth: 0` の CI checkout (作業ツリー clean) 上で `impact --diff --base origin/<base> --tests --format json` が、PR のコミット範囲の変更に紐づく `testsToRun` を返す。現状の「No changes detected → 空選択」の無言空振りが発生しない。
- **SC-002**: 同一 repo 状態・同一 `<ref>` に対し、impact の merged changed-file set が check のそれと一致する (agreement (i) — テストで pin)。
- **SC-003**: base..HEAD 内のコミットで sole `@impl` ファイルが削除されたケースで、`check --diff --base --gate` は exit 2 になり、`impact --diff --base --tests` は削除ファイル由来の選択を含まない — check-scope ⊇ impact-reach の分業がテストで固定される (agreement (ii))。
- **SC-004**: 解決不能な `--base` / merge-base 計算不能で exit 1 とともに `FETCH_DEPTH_HINT` を含む診断が stderr に出力され、`--format json` でも stdout に JSON が 1 byte も出ない。
- **SC-005**: `--base` 未指定の全実行の出力・exit code が本 feature 導入前と byte-identical である (回帰テストで固定)。唯一の例外 (`--format` bogus 値 → exit 1) は独立の回帰テストで新挙動を pin する。
- **SC-006**: `--tests` + `--base` + `trace.staleness: "exclude"` の共起時にのみ D-9 警告が stderr に出力される (3 条件のいずれかを欠く組み合わせでは出力されない)。
- **SC-007**: `--base HEAD` (merge-base == HEAD) が `--base` なしの `--diff` と同一の結果に退化する (union の境界が正しい)。

## Assumptions

- **spec 023 の配管を前提とする**: `resolveMergeBase` / `FETCH_DEPTH_HINT` / `classifyBaseRef` (src/baseline.ts)、`getGitDiffFiles(rootDir, baseSha?)` (src/diff.ts) は 023 で実装・テスト済みであり、本 feature は **変更なしで再利用する** (data-model.md §2 の reuse 台帳)。これらのモジュールに 1 行も手を入れない。
- **非 ASCII path は解決済み**: `getGitDiffFiles` の `-z` + `core.quotePath=false` 統一 (023 FR-006) を共有するため、本 feature 側の追加対応・追加 FR は不要 (回帰はテストで確認)。
- **trace evidence は現在の shards を使う**: `--tests` の evidence join は従来どおり現在の trace shards (`trace.artifacts`) に対して行う。base ref 時点の trace を復元する概念はない (baseline を持たない D-1 と同型の「現在基準」方針)。CI では直近の (例: base ブランチで生成しキャッシュした) shards を使う運用を想定し、staleness の含意は D-9 / quickstart.md troubleshooting に記す。
- **`--tests` なしの `--base` も合法**: `--base` はテスト選択専用ではなく、`--diff` の変更ファイル集合の一般化である。REQ 影響の base-range 化 (`impact --diff --base <ref> --format json` の `impactReqs`) も同じ機構で成立する。
- **impact は副作用ゼロのまま**: baseline worktree を導入しない (D-1) ため、spec 017/023 が check 側で管理する worktree ライフサイクル・cleanup の複雑さは一切持ち込まれない。

## Out of Scope

- **impact での baseline union**: baseline worktree / baseline グラフ側 startId 解決 (check FR-007〜009 相当) は導入しない (D-1)。コミット済み削除の正しさは `check --diff --base --gate` が担う。
- **trace-join 回復**: 未解決 diff path を `ownerFilePath` で trace evidence に直接 join して「削除ファイルが exercise していた REQ のテスト」を選択に加える案 — 安価で後付け可能な follow-up 候補として research.md R1 に記録するが、本 feature では実装しない。
- **rename map (`getGitRenameMap`) の impact への導入** (D-8 / FR-011)。
- **check コマンド・共有配管の変更**: `src/diff.ts` / `src/baseline.ts` / `src/graph/traverse.ts` / `src/commands/check.ts` は変更しない。
- **rejection 文言の変更**: `IMPACT_REQ_ID_REJECTION` / `IMPACT_DOC_PREFIX_REJECTION` は不変 — targets は同一に拒否され、`--base` は modifier であって start source ではない。
- **他コマンドへの `--base`**: `plan-coverage` 等への展開は本 feature の対象外。
- **`--base` の複数指定・range 構文 (`A...B` 等)**: 023 と同じく単一 ref のみ受理。

## 参照

- issue #305 (spec 023 D3 / Out of Scope の tracked follow-up)
- spec 023: `specs/023-check-base-ref/` — spec.md D1/D2 (merge-base 意味論・fail-closed)、research.md R1/R6、contracts/cli-check-base.md §1 (値検証 F1/F2)、plan.md Follow-up (`impact --base`)
- spec 020: `specs/020-coverage-derived-edges/spec.md` FR-017 (evidence traversal / staleness) / FR-018 (`--tests`)
- spec 017: `specs/017-check-gate-baseline-diff/spec.md` FR-007 (impact の blast radius を縮小しない — 本 feature の agreement (ii) の前提)
- spec 016: `specs/016-impact-plan-symbol-level/contracts/cli-flags.md` §1.3 / §2 — 本 feature が拡張する `--diff` 起動契約。**既知の drift**: §1.3 は `line: 0` と記すが実装は `line: 1` (`src/commands/impact.ts:193` / `src/commands/shared.ts` `pathsToEntries`)、§1/§2 は撤去済みの `--from-tasks` / `--from-plan` channel を参照する。本 spec の contract は実装の現行意味論 (`line: 1`) を正とし、016 側には forward-pointer 注記を追加する (contracts/cli-impact-base.md §1.2)。
- spec 014: `specs/014-reinvent-impact-cli/spec.md` FR-001 / FR-003 (file-only targets・REQ-ID rejection — 検証順の先頭が不変である根拠)
