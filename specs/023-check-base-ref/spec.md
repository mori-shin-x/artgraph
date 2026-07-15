# Feature Specification: check --base <ref> — CI PR gating (spec 017 Phase 2)

**Feature Branch**: `feat/check-base-ref`

**Created**: 2026-07-15

**Status**: Draft

**Input**: issue [#185](https://github.com/mori-shin-x/artgraph/issues/185) — spec 017 Phase 2。CI の checkout は作業ツリーがコミットと完全一致するため、`check --diff --gate` の git 差分 (staged + unstaged + untracked) は恒常的に空になり、ゲートは無言で no-op する (spec 017 plan.md Follow-up / issue #182 レビュー E1)。`--base <ref>` で「PR のマージ先ブランチ」を基準点に指定できるようにし、CI でコミット間差分によるゲート判定を可能にする。

## Clarifications

### Session 2026-07-15 (approved design decisions)

- **D1 — merge-base 統一**: `--base <ref>` の意味論は「`<ref>` の tip」ではなく **`git merge-base <ref> HEAD`** に統一する。diff range (`<mergeBase>..HEAD`) と baseline worktree (`computeBaselineIssues` に渡すコミット) は **同一の merge-base SHA** を使う。GitHub PR の three-dot 比較 (`base...head`) と同じ意味論であり、base ブランチが分岐後に進んだ場合の双方向の誤判定 (branch point 以降に base で修正された issue が suppress されなくなる false exit 2 / base で新規導入された issue が本 PR の新規 issue を suppress する fail-open) を構造的に防ぐ。
- **D2 — `--base` は `--diff` 必須、違反はハードエラー**: `--diff` なしの `--base` は fail-closed の usage error として **exit 1** で終了する。`--ignore` 型の「警告して無視・続行」は採らない — CI でフラグの綴り漏れがゲートの無言 no-op に化けることを許さない。
- **D3 — スコープは `check` のみ**: `impact --base` は本 feature のスコープ外 (follow-up issue)。CI でのテスト選択ユースケース (`impact --diff --tests`) が同じ base-range 化を必要とするが、spec 016 `contracts/cli-flags.md` §1.3 (`--diff` の起動契約) の改訂を伴うため別 feature とする (Out of Scope 参照)。

## 背景 / 問題

spec 017 は `check --diff --gate` のゲート合否を「変更が新規に導入した issue のみ」に絞り (baseline 差分)、内部 API (`computeBaselineIssues(rootDir, baseRef, ...)`) を base ref パラメータ化した (017/FR-012)。しかし CLI からは base ref を指定できず、Phase 1 は HEAD 固定である。

このため CI では機能しない: CI の checkout はコミット済み状態と作業ツリーが完全一致し、`--diff` の変更ファイル集合 (staged + unstaged + untracked) が空になる。現状は `CI=true` のとき警告 (`src/commands/check.ts:90-93`) を出すだけで、ゲートは「何も比較していないのに exit 0」する。PR が実際に導入した drift / orphan / uncovered を CI で捕まえる手段が存在しない。

本 feature は `check` に `--base <ref>` を追加し、変更ファイル集合とベースライン算出基準の両方を merge-base 起点のコミット間差分に拡張する。ローカルの既定挙動 (base ref 未指定 = HEAD 固定) は byte 単位で不変とする。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — CI で PR が新規に導入した問題だけを gate する (Priority: P1)

開発者が PR を出す。GitHub Actions が `actions/checkout` (`fetch-depth: 0`) で PR の head をチェックアウトし、`artgraph check --diff --base origin/${{ github.base_ref }} --gate` を実行する。

ゲートは、PR (merge-base..HEAD のコミット済み変更) が新規に導入した drift / orphan / uncovered / test failure のみで合否を判定する。main 側の pre-existing 債務は suppress される。作業ツリーが clean であること (CI の通常状態) はゲートの空振りを意味しない。

**Why this priority**: 本 feature の存在理由。issue #182 レビュー E1 で判明した「CI でゲートが無言 no-op」の唯一の解消手段であり、spec 017 plan.md Follow-up が本 Phase 2 に明示的に委ねた。

**Independent Test**: base ブランチと feature ブランチを持つ一時 git repo で、feature ブランチのコミットに新規 orphan を含めて `check --diff --base <baseBranch> --gate` を実行し、作業ツリー clean のまま exit 2 になることを確認する。新規問題なしのコミットでは exit 0。

**Acceptance Scenarios**:

1. **Given** base ブランチから分岐した feature ブランチに、存在しない REQ を指す `@impl` タグをコミット済み (作業ツリー clean)、 **When** `check --diff --base <base> --gate`、 **Then** exit 2 で、その orphan が `newIssues` に含まれる。
2. **Given** feature ブランチのコミットが新規問題を導入していない (純リファクタ)、base 側に pre-existing 債務あり、 **When** `check --diff --base <base> --gate`、 **Then** exit 0 で pre-existing 債務は合否に影響しない。
3. **Given** base ブランチが分岐後に進み、branch point 時点で存在した issue を base 側で修正済み (moved-ahead base)、 **When** `check --diff --base <base> --gate`、 **Then** その issue は merge-base 時点の baseline に存在するため引き続き suppress され、exit 0 (base の tip を使うと false exit 2 になるケース)。
4. **Given** feature ブランチのコミットの 1 つがファイルを削除し、そのファイルが持っていた唯一の `@impl` エッジが失われて REQ が uncovered に転落、 **When** `check --diff --base <base> --gate`、 **Then** exit 2 (baseline 側グラフで解決されるため fail-open しない — spec 017 US2 AS3 / issue #229 の base-range 版)。
5. **Given** base..HEAD 内のコミットで pre-existing orphan を持つファイルが `git mv` 済み (内容不変)、 **When** `check --diff --base <base> --gate`、 **Then** その orphan は rename 正規化により pre-existing のまま suppress され exit 0 (017/SC-004 の base-range 版)。

---

### User Story 2 — ローカルで push 前に origin/main と比較する (Priority: P2)

開発者が feature ブランチで数コミット積んだ後、push / PR 作成前に `artgraph check --diff --base origin/main --gate` を実行し、「このブランチ全体が main に対して新規に導入した問題」を手元で確認する。

作業ツリーの未コミット変更 (staged / unstaged / untracked) も従来どおり変更ファイル集合に含まれる — `--base` はコミット間差分を **追加** するのであって、作業ツリー差分を置き換えるのではない。

**Why this priority**: CI (US1) と同じ機構のローカル利用。CI で赤くなる前に手元で同じ判定を再現できることが、ゲートの信頼と修正コストの低減に直結する。

**Independent Test**: コミット済み変更 + 未コミット変更の両方を持つ repo で `check --diff --base <base>` を実行し、変更ファイル集合が両者の和集合になることを確認する。

**Acceptance Scenarios**:

1. **Given** コミット済みの新規 orphan + 未コミット (untracked) の新規ファイル、 **When** `check --diff --base <base> --gate`、 **Then** 両方が変更ファイル集合に入り、コミット済み orphan で exit 2。
2. **Given** merge-base..HEAD のコミット差分も作業ツリー差分も空 (ブランチが base と同一 tip かつ clean)、 **When** `check --diff --base <base>`、 **Then** 「No changes」の正常終了 exit 0 で、CI 空 diff 警告は出ない (FR-010)。
3. **Given** `--base` を指定しない従来の実行、 **When** `check --diff --gate`、 **Then** 挙動 (変更ファイル集合・baseline・出力・exit code) は本 feature 導入前と byte-identical (FR-003)。

---

### User Story 3 — shallow clone / 解決不能 ref は fail-closed で明示エラー (Priority: P2)

CI 担当者が `actions/checkout` を既定 (`fetch-depth: 1`) のまま `--base origin/main` を実行してしまう。origin/main が fetch されていない、または merge-base が計算できない。

ゲートは判定不能を黙って exit 0 にせず、専用 exit code (exit 1, spec 017 FR-010 意味論) と、**原因と対処 (shallow clone / `fetch-depth: 0` の指定) を示すメッセージ** で終了する。gate fail (exit 2) と pass (exit 0) のどちらとも区別できる。

**Why this priority**: `--base` の導入とセットで最も踏みやすい運用事故。ここで fail-open すると US1 の価値 (CI ゲートの信頼) が成立しない。

**Independent Test**: 存在しない ref を `--base` に渡して exit 1 + ヒントを確認。unrelated histories の 2 repo で merge-base 失敗 → exit 1 + 同じヒントを確認。

**Acceptance Scenarios**:

1. **Given** `--base` に解決しない ref (typo / 未 fetch)、 **When** `check --diff --base nosuchref --gate`、 **Then** exit 1 で、メッセージに shallow clone / `fetch-depth: 0` のヒントを含む。unborn HEAD (017/FR-014) とは決して混同されない。
2. **Given** `<ref>` は解決するが `git merge-base <ref> HEAD` が失敗する (shallow clone で共通祖先が欠落 / unrelated histories)、 **When** `check --diff --base <ref> --gate`、 **Then** exit 1 + 同じヒント。
3. **Given** 同上で `--gate` なし、 **When** `check --diff --base <ref>`、 **Then** 017 の `unavailable` 意味論どおり警告 + 全表示 exit 0 (`pass:false`, `baselineStatus:"unavailable"`)。
4. **Given** `--diff` なしで `--base` を指定、 **When** `check --base origin/main --gate`、 **Then** usage error として exit 1 (D2)。警告して続行しない。

---

### Edge Cases

- **`--base` が HEAD 自身 / HEAD と同一コミットを指す**: `merge-base(<ref>, HEAD) == HEAD` となり、コミット間差分は空。変更ファイル集合は作業ツリー差分のみ = 現行 `--diff` と同じ挙動に自然に退化する (baseline も HEAD で構築され Phase 1 と一致)。
- **base が分岐後に進んでいる (moved-ahead base)**: merge-base 統一 (D1) により、diff range も baseline も branch point を見る。base の tip を使った場合の双方向の誤判定 (US1 AS3 / research.md R1) は発生しない。
- **base..HEAD 内のコミットで削除されたファイル**: HEAD にも作業ツリーにも存在せず現在グラフで startId 解決不能。merge-base tree を probe しなければ baseline build が skip され fail-open する (issue #229 の再発形; FR-009 で防止)。
- **base..HEAD 内のコミット済み rename**: 現行の rename 検出は `git diff -M HEAD` (作業ツリー vs HEAD) 固定のため、コミット済み rename が見えない。`git diff -M <mergeBase>` へのパラメータ化 (FR-008) で、startId の inverse-rename 解決と baseline orphan-key 正規化の両方に届かせる。
- **非 ASCII path が base range にのみ含まれる**: コミット間差分の取得も `-z` + `core.quotePath=false` で行う (FR-006)。既存の作業ツリー側 3 呼び出しも同時に `-z` 化し、path の取り扱いを揃える。
- **merged diff が空 (base と同一 + clean tree)**: 正常系の「No changes」exit 0。`--base` 指定時は CI 空 diff 警告 (check.ts:90-93) を出さない — 比較は実際に行われた (FR-010)。
- **unrelated histories**: `git merge-base` が失敗 → `unavailable` (US3 AS2)。
- **`trace.staleness: "gate"` との相互作用**: base range の広い diff はより多くの REQ を scope に引き込むため、従来 scope 外だった stale evidence が新たに exit 2 を引き起こしうる。これは意味的に正しい (その REQ は本当にこの変更範囲にある) ため修正しない。ドキュメントと output-schema.md に明記する (Assumptions 参照)。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: システムは `check` コマンドに `--base <ref>` オプションを追加しなければならない。`<ref>` は任意の git ref (ブランチ名 / リモート追跡ブランチ / SHA / タグ)。`impact` コマンドには追加しない (D3)。
- **FR-002**: `--base` は `--diff` と併用されなければならない。`--diff` なしの `--base` は fail-closed の usage error として exit 1 で即時終了しなければならない (D2)。警告して無視・続行する縮退 (`--ignore` 型) は許容しない。`--format json` 指定時もエラーは対称に扱う。また `<ref>` の**値そのもの**も fail-closed に検証する (PR #304 review F1/F2): 空文字列、および `-` で始まる値 (CI で base-ref 変数が空展開し次のフラグを値として食うケース) は option パース時点で usage error (exit 1) として拒否し、no-base 動作への無言縮退や gate フラグの喪失を許さない。
- **FR-003**: `--base` 未指定時の `check` (plain / `--diff` / `--gate` の全組み合わせ) の挙動は、本 feature 導入前と byte-identical でなければならない。配布 Stop hook テンプレート (`templates/hooks/settings.json.template` の `check --gate --diff`) は変更しない。
- **FR-004**: `<ref>` の検証は `classifyBaseRef` (src/baseline.ts:362) で行わなければならない。解決しない named ref は決して "unborn" に分類してはならない (`isUnbornHead` は非 HEAD で常に false — src/baseline.ts:381 の既存挙動を pin)。解決不能な `--base` は `baselineStatus:"unavailable"` として扱い、`--gate` 時は exit 1 (017/FR-010 意味論)。エラーメッセージには shallow clone の可能性と `fetch-depth: 0` (または対象 ref の fetch) の対処ヒントを含めなければならない。
- **FR-005**: システムは merge-base を **1 回だけ** 解決しなければならない: `git merge-base <ref> HEAD`。以後の全処理 (diff range / rename 検出 / tracked-path probe / baseline worktree) はこの単一の merge-base SHA を共有する。merge-base 解決の失敗 (shallow clone / unrelated histories) は `baselineStatus:"unavailable"` + FR-004 と同じ fetch-depth ヒントで扱う。`<ref>` の tip を直接使ってはならない (D1)。
- **FR-006**: `--base` 指定時の変更ファイル集合は、現行の three-way union (staged ∪ unstaged ∪ untracked) に `git -c core.quotePath=false diff --name-only -M -z <mergeBase> HEAD` の結果を **和集合で追加** したものでなければならない (FR-003 の作業ツリー差分は縮小しない)。あわせて、既存の 3 呼び出し (src/diff.ts:38-49 の staged / unstaged / untracked) も `-z` + `core.quotePath=false` に変換し、非 ASCII path の取り扱いをコミット間差分と一致させなければならない。
- **FR-007**: baseline worktree は diff range と **同一の merge-base SHA** で構築しなければならない: `computeBaselineIssues(rootDir, <mergeBaseSHA>, lock, config)`。diff range と baseline が異なるコミットを参照する実装 (例: diff は merge-base、baseline は `<ref>` tip) を許容しない (D1 の divergence 防止)。
- **FR-008**: rename 検出 (`getGitRenameMap`, src/diff.ts:153 — 現在 HEAD 固定) は base ref にパラメータ化し、`--base` 時は `git diff -M <mergeBase>` を実行しなければならない。base..HEAD 内でコミットされた rename が、(a) `src/commands/check.ts:136` の inverse-rename による baseline 側 startId 解決、(b) `src/baseline.ts:229` の orphan-key 正規化 (017 C2/SC-004) の **両方** に反映されること。
- **FR-009**: baseline-resolvable 判定に使う tracked-path probe (`getHeadTrackedPaths`, src/diff.ts:119 — 現在 `git ls-tree -r HEAD` 固定) は、`--base` 時に merge-base tree も probe しなければならない。base..HEAD 内のコミットで削除されたファイル (HEAD 非追跡・作業ツリー不在・現在グラフで解決不能) が baseline build の skip 判定をすり抜けて fail-open すること (issue #229 の failure mode の再発) を防ぐ。
- **FR-010**: `--base` 指定時、CI 空 diff 警告 (`src/commands/check.ts:90-93` "gate is not active in CI without --base <ref>") を出力してはならない。merged diff (three-way union ∪ base range) が空の場合は正当な「No changes detected」として exit 0 で終了する (json 出力は既存 E4 ショートサーキットの shape に従い、`warnings[]` に CI 警告を含めない)。
- **FR-011**: 実装は、#185 を future work として言及する in-code 文字列を更新しなければならない: `src/commands/check.ts:92` の CI 警告文言 (「--base <ref> を渡せ」への書き換え)、`src/baseline.ts:174` の submodule メッセージ ("see #185" — submodule 対応は本 feature でも行わないため、参照先を新 follow-up または「未対応」に改める)、`src/commands/check.ts:82-89, 157` 付近の Phase 2 言及コメント。
- **FR-012**: `--base` に起因する全異常系 (ref 解決不能 / merge-base 失敗 / worktree 構築失敗) は `baselineStatus:"unavailable"` に集約し、新しい failure channel・新しい CheckResult フィールドを追加してはならない。これは設計制約である: `--ignore` の pass 再計算 (`src/commands/check.ts:300-310`) は `baselineStatus === "unavailable"` を明示的に non-passing に保っており、`--base` の失敗がこの経路以外を通ると `--ignore` 併用時に fail-open しうる。

### Key Entities

- **base ref**: ユーザーが `--base` で指定する git 参照。検証は `classifyBaseRef`、意味論への寄与は merge-base 経由のみ。
- **merge-base SHA**: `git merge-base <ref> HEAD` の結果。diff range (`<sha>..HEAD`)・rename 検出・tracked-path probe・baseline worktree が共有する単一の基準点 (SSOT)。
- **merged diff files**: three-way union (staged ∪ unstaged ∪ untracked) ∪ コミット間差分 (`<sha>..HEAD` name-only)。`--base` 未指定時は前者のみ (現行不変)。
- **baseline issues**: spec 017 と同一の概念。base ref が HEAD から merge-base SHA に一般化されるだけで、キー生成・`unavailable` 意味論・遅延/skip 判定の構造は不変。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `fetch-depth: 0` の CI checkout 上で `check --diff --base origin/<base> --gate` が、PR のコミットが新規導入した issue のみで exit 0/2 を決定する。作業ツリー clean による無言 no-op (現状の CI 挙動) が発生しない。
- **SC-002**: base ブランチが分岐後に進み branch point 時点の issue を修正済みのケース (moved-ahead base) で、その issue が引き続き suppress され exit 0 になる (tip 比較なら false exit 2 になる入力で検証)。
- **SC-003**: base..HEAD 内のコミットでファイルが削除され唯一の `@impl` エッジが失われた場合、`check --diff --base <base> --gate` が exit 2 になる (fail-open ゼロ)。
- **SC-004**: base..HEAD 内でコミット済みの pure rename を持つ pre-existing orphan が引き続き suppress され、exit 0 になる。
- **SC-005**: `--base` 未指定の全実行の出力・exit code が本 feature 導入前と byte-identical である (回帰テストで固定)。
- **SC-006**: 解決不能な `--base` / merge-base 計算不能 (shallow clone・unrelated histories) で、`--gate` 時に exit 1 とともに `fetch-depth: 0` を含む対処ヒントが表示される (exit 0 / exit 2 と明確に区別)。
- **SC-007**: 非 ASCII path (例: `specs/日本語.md`) が base range のコミット間差分にのみ含まれる場合でも、正しく変更ファイル集合に入りゲート判定される。

## Assumptions

- **spec 017 の基盤を前提とする**: baseline 算出 (`computeBaselineIssues`) は 017 で既に base ref パラメータ化済み (017/FR-012)。本 feature は CLI 露出と「HEAD 以外の base ref で正しく動くための git 配管の一般化」であり、issue キー生成・worktree ライフサイクル・`unavailable` 意味論は変更しない。
- **`trace.staleness: "gate"` の scope 拡大は許容 (documented, not fixed)**: base range の広い diff がより多くの REQ を scope に引き込み、従来出なかった stale-evidence exit 2 が新たに出うる。意味的に正しい挙動として受容し、docs / `templates/skills/_shared/output-schema.md` に明記する。
- **baseline scan は現在の `.artgraph.json` を base worktree に適用する (既存挙動)**: base ref 時点の config は使わない (017 の R3 と同型の「現在基準」方針)。base が遠いほど config-vs-content の skew が大きくなりうる — 既知の制限としてドキュメント化する。
- **CI レシピは `fetch-depth: 0` を前提とする**: 部分 fetch (`fetch-depth: N`) でも merge-base が取れれば動作するが、保証はしない。取れない場合は fail-closed (exit 1 + ヒント) であり fail-open しない (SC-006)。
- **`--base` 失敗はすべて `baselineStatus:"unavailable"` 経路**: FR-012 の設計制約。`--ignore` 併用の安全性はこの集約に依存する。
- **Stop hook は変更しない**: ローカルの Stop hook (`check --gate --diff`) は作業ツリー差分の即時ゲートとして正しく、`--base` を配布テンプレートに加えない (FR-003)。

## Out of Scope

- **`impact --base`**: follow-up issue とする。CI でのテスト選択 (`impact --diff --tests` による変更起因テストのみの実行) が base-range 化の主ユースケースだが、spec 016 `contracts/cli-flags.md` §1.3 が `--diff` の起動契約 (作業ツリー差分・`line: 0` エントリ) を確定しており、その改訂を伴う。`check --base` の merge-base 配管 (本 feature の `resolveMergeBase` / `getGitDiffFiles` の base 対応) は再利用可能な形で実装する。
- **Stop hook テンプレートの変更**: `templates/hooks/settings.json.template` は `check --gate --diff` のまま。ローカル hook に `--base` は不要。
- **Submodule 対応**: 017 と同様に `unavailable` へ fail-closed する。`src/baseline.ts:174` のメッセージが "see #185" と本 feature を参照しているため、実装で文言を改める (FR-011) — 対応自体は行わない。
- **base ref 時点の config / lock での baseline 評価**: 現在の config・現在の lock を基準にする 017 方針を維持 (Assumptions 参照)。
- **`--base` の複数指定・range 構文 (`A...B` 等)**: 単一 ref のみ受理。merge-base 計算は内部で行う。

## 参照

- issue #185 (spec 017 Phase 2 の tracked follow-up)
- spec 017: `specs/017-check-gate-baseline-diff/` — spec.md FR-002 / FR-010 / FR-012、plan.md Follow-up、contracts/baseline-diff.md §2 (`getGitDiffFilesFrom` スケッチ)
- issue #229 (deleted-edge fail-open — FR-009 が base-range で再発を防ぐ対象)
- issue #182 レビュー E1 (CI 無言 no-op) / C2 (rename 正規化 — FR-008 が base-range へ拡張)
