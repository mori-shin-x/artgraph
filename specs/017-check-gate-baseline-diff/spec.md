# Feature Specification: check --gate baseline 差分化 (pre-existing 債務の gate 誤爆解消)

**Feature Branch**: `feat/check-gate-baseline-diff`

**Created**: 2026-07-07

**Status**: Draft

**Input**: issue [#174](https://github.com/ShintaroMorimoto/artgraph/issues/174) — `artgraph check --diff --gate` が、変更と因果的に無関係な pre-existing の untagged/ambiguous REQ 債務まで gate 対象に含めてしまい、`src/doctor.ts` のような多くの REQ に波及するファイルを touch しただけで必ず exit 2 になる。

## Clarifications

### Session 2026-07-07

- Q: baseline 状態を構築できない異常系 (worktree 生成失敗等。HEAD 無しの初回コミット前は別途「baseline 空 = 全部新規」で扱う) での `check --diff --gate` の挙動は? → A: エラー終了 — 判定を行わず、ゲート合否 (exit 2/0) とは区別できる専用 exit code (exit 1) と明示メッセージで終了する。判定不能を黙殺せず (Constitution 原則 I)、CI が検知でき、縮退判定ロジックを別途維持しない (シンプルさ優先)。

## 背景 / 問題

`artgraph check --diff --gate` は、Stop hook および `artgraph-verify` Skill 経由でユーザーに配布されている正式なゲート機能である。現状この機能は、変更ファイルの「影響範囲 (blast radius)」を汎用の双方向グラフ探索で広く計算し、その範囲内で見つかった drift / orphan / uncovered を **すべて** ゲートの合否に流し込んでいる。

このため、1 ファイルを変更しただけでもプロジェクトの広範囲 (実測で REQ 全体の約 35%) がゲート対象に入り、その中に含まれる **変更とは因果的に無関係な pre-existing の債務** (他 spec の未タグ付け REQ、重複 / ambiguous ID) が surfaced されて exit 2 になる。開発者は「自分の変更でグラフが壊れた」と誤解し、無関係な調査コストを負う。

これは本プロジェクトの Constitution に定義されたゲートの意味論に反する。Constitution 原則 III および「開発ワークフローと品質ゲート」は、ゲートを **「この変更で claim した ID が drift / orphan / uncovered のまま残っていないこと」** と定義し、**「グローバルな全 ID カバレッジは推奨でありゲートではない」** と明記している。現状の実装は「変更の影響範囲に触れた pre-existing 債務」までゲートに含めており、この定義から逸脱している。本 feature はゲートを Constitution の定義に一致させる。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — 無関係な pre-existing 債務でゲートが赤くならない (Priority: P1)

開発者が、多数の REQ にグラフ上つながっているファイル (例: `src/doctor.ts`) を、意味的な変更ゼロ (空行追加程度) で編集し、`check --diff --gate` を実行する。プロジェクトには別 spec 由来の未タグ付け REQ や重複 ID が pre-existing で多数存在するが、それらは今回の編集とは無関係である。

ゲートは exit 0 で通る。今回の編集が新たに壊したものが何も無いためである。pre-existing の債務はゲートの合否に影響しない。

**Why this priority**: issue #174 の核心であり、この feature の存在理由。ゲートが無関係な債務で誤爆すると、開発者の信頼を失い、ゲートそのものが無視されるようになる。

**Independent Test**: pre-existing の未タグ付け REQ を含むリポジトリで、それらの REQ にグラフ上つながっているコードファイルに意味を変えない編集を加え、`check --diff --gate` が exit 0 で終わることを確認する。編集前の clean な状態でも exit 0 であることと対照する。

**Acceptance Scenarios**:

1. **Given** pre-existing で未タグ付けの REQ 群が存在し、`src/doctor.ts` がそれらの REQ に間接的につながっている、 **When** `src/doctor.ts` に意味を変えない編集を加えて `check --diff --gate` を実行、 **Then** exit 0 で終了し、pre-existing の未タグ付け REQ はゲートの不合格理由に含まれない。
2. **Given** 同じリポジトリで作業ツリーが clean (diff なし)、 **When** `check --diff --gate` を実行、 **Then** exit 0 (現状の挙動を維持)。
3. **Given** 無関係なファイル (例: `README.md`) だけを変更、 **When** `check --diff --gate` を実行、 **Then** exit 0 (現状の挙動を維持)。

---

### User Story 2 — 変更が新規に導入した問題は確実にゲートで捕まえる (Priority: P1)

開発者が、実際にグラフの整合性を壊す変更 (存在しない REQ を指す `@impl` タグの追加、spec を編集して lock を更新し忘れた drift、新 REQ を追加して実装しないままの uncovered など) を加えて `check --diff --gate` を実行する。

ゲートは exit 2 で止め、**新規に導入された問題だけ** を不合格理由として報告する。pre-existing 債務を無視することが、実際に導入された問題まで見逃すこと (fail-open) につながってはならない。

**Why this priority**: ゲートの本来の目的。US1 (誤爆を消す) と US2 (見逃さない) は表裏一体であり、両方満たして初めてゲートとして正しい。

**Independent Test**: baseline に存在しない新規の orphan / uncovered / drift をそれぞれ 1 件導入し、`check --diff --gate` が exit 2 になり、その 1 件が不合格理由に含まれることを確認する。

**Acceptance Scenarios**:

1. **Given** 変更ファイルに、存在しない REQ を指す新しい `@impl` タグを追加 (新規 orphan)、 **When** `check --diff --gate`、 **Then** exit 2 で、その orphan が新規問題として報告される。
2. **Given** spec ファイルを編集して対応する lock を更新していない (新規 drift)、 **When** `check --diff --gate`、 **Then** exit 2 で、その drift が新規問題として報告される。
3. **Given** 変更で既存 REQ から唯一の `@impl` タグを削除し、その REQ が uncovered に転落 (新規 uncovered)、 **When** `check --diff --gate`、 **Then** exit 2 で、その uncovered が新規問題として報告される。
4. **Given** 新規に導入した問題が無く pre-existing 債務のみが範囲内にある、 **When** `check --diff --gate`、 **Then** exit 0。

---

### User Story 3 — 大きな差分でも出力が読める (Priority: P2)

開発者が、多数のファイル (例: 50 ファイル) にまたがる変更を加えて `check --diff --gate` を実行する。変更の影響範囲は広いが、そのうち実際に新規で壊れた問題は少数 (多くの場合ゼロ) である。

ゲートの text 出力は、変更の影響範囲の広さではなく **新規に導入された問題の実数** に比例した分量になる。先頭に新規問題数のサマリを示し、詳細は新規分だけを列挙し、範囲内の pre-existing 債務は件数のみを示して抑制し、広い波及を見たいユーザーを `impact --diff` に誘導する。

**Why this priority**: 出力が読めなければゲートは実運用で無視される。ただし US1/US2 の合否ロジックが正しければ機能自体は成立するため P2。

**Independent Test**: 50 ファイルにまたがる純粋なリファクタ (spec/タグ非変更) で `check --diff --gate` を実行し、text 出力が新規問題ゼロを示す簡潔な出力 (数行) に収まり、pre-existing 債務の全リストを吐き出さないことを確認する。

**Acceptance Scenarios**:

1. **Given** 50 ファイルにまたがる純粋なリファクタ (新規問題ゼロ)、 **When** `check --diff --gate`、 **Then** 出力は「新規問題なし」を示す簡潔なもので、pre-existing 債務の全件列挙を含まず、exit 0。
2. **Given** 新規問題が数件あり範囲内に pre-existing 債務も多数ある、 **When** `check --diff`、 **Then** 先頭に新規問題数のサマリ、続いて新規分の詳細、末尾に「抑制した pre-existing 件数」と `impact --diff` への誘導が示される。
3. **Given** 機械処理したい利用者、 **When** `check --diff --format json`、 **Then** 範囲内の全 issue が出力され、各 issue に「新規かどうか」を区別するフラグが付く。

---

### User Story 4 — 影響範囲の可視化 (blast radius) は温存される (Priority: P2)

開発者が「自分の変更がどこまで波及するか」を知りたいとき、`artgraph impact --diff` および `check --diff` (ゲートなしの表示) は、これまでどおり広い双方向の影響範囲を示す。ゲート判定を新規問題に絞ることが、影響範囲を「知る」機能を縮小させてはならない。

**Why this priority**: 「変更が触れていない箇所へどこまで影響するかを知る」ことは artgraph のコア価値である。この feature はゲートの **合否判定** だけを絞るのであって、影響範囲の **可視化** を絞るのではない。両者を分離することがこの feature の設計原則。

**Independent Test**: `impact --diff` の出力する影響 REQ / doc / file の件数が、この feature の前後で変わらないことを確認する。

**Acceptance Scenarios**:

1. **Given** 任意の変更、 **When** `artgraph impact --diff`、 **Then** 影響範囲は本 feature 導入前と同一 (縮小しない)。
2. **Given** 任意の変更、 **When** `check --diff` (ゲートなし)、 **Then** 変更の影響範囲に関する情報は引き続き参照できる (合否判定のみが新規問題基準に変わる)。

---

### Edge Cases

- **baseline が構築できない異常系** (git リポジトリでない / worktree 等の baseline 構築に失敗): ゲートは「判定不能」を隠蔽せず、専用 exit code (exit 1) と明示メッセージで終了する (FR-010)。判定不能を黙って exit 0 にして見逃すことは Constitution 原則 I (決定的・判定を隠さない) に反するため許容しない。縮退した別判定は行わない。
- **lock ファイルが存在しない / gitignore されている**: 本プロジェクトの `.trace.lock` は gitignore されておりコミットされない。したがって baseline の drift 判定に「base ref 時点の lock」は使えない。drift の baseline は現在の lock を基準に計算する (FR-011 / Assumptions 参照)。
- **初回コミット前 (HEAD 無し) で全ファイルが untracked**: baseline は空 (比較対象が無い) となり、現在の全 issue が新規扱いになる。これは「まだ何もコミットしていない = すべてがこの変更」であり意味的に正しい。
- **変更が spec ファイル自身を編集した場合**: そのファイルが定義する REQ / doc は変更の直接対象であり、それらに生じた drift / orphan / uncovered は新規問題として正しくゲート対象になる。
- **baseline 計算のための一時的な作業領域生成がユーザーの作業ツリー・index・lock を汚染しないこと**: 副作用ゼロが必須 (FR-004, SC-003)。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: システムは `check --diff --gate` の合否を、変更が **新規に導入した** 問題 (`current issues \ baseline issues`) のみで決定しなければならない。範囲内に存在する pre-existing の drift / orphan / uncovered は合否に影響してはならない。
- **FR-002**: システムは baseline を「base ref 時点のプロジェクト状態」から算出しなければならない。本 feature (Phase 1) では base ref を現在の HEAD に固定する。
- **FR-003**: 変更ファイルの集合は、現在の git 差分 (staged + unstaged + untracked の和集合) から求めなければならない (現状の `--diff` の定義を維持)。
- **FR-004**: baseline の算出は、ユーザーの作業ツリー・git index・lock ファイルを一切変更してはならない。`git stash` のような作業ツリーを書き換える方式を採ってはならない。
- **FR-005**: baseline の算出は、現在の状態で新規候補となる問題が 1 件も無い場合は実行を省略してよい (遅延評価)。問題なしのケースで追加コストが発生しないこと。
- **FR-006**: orphan がゲート対象かどうかの判定は、**厳密な ID 一致** で行わなければならない。現状の部分文字列マッチ (無関係なファイルの orphan 行を範囲内と誤判定する) を廃止し、変更ファイル起点で因果的につながる orphan のみを対象にする。
- **FR-007**: `artgraph impact --diff` の影響範囲 (blast radius) と、`check --diff` (ゲートなし) の影響範囲情報は、本 feature の前後で縮小してはならない。ゲート判定の絞り込みは可視化に波及してはならない。
- **FR-008**: text 出力は、先頭に新規問題数のサマリを示し、新規問題の詳細のみを列挙し、範囲内の pre-existing 債務は件数のみを示して抑制し、広い影響範囲を確認する手段 (`impact --diff`) を案内しなければならない。
- **FR-009**: `--format json` 出力は、範囲内の全 issue を含め、各 issue が新規かどうかを区別できるフラグを持たなければならない。
- **FR-010**: システムは baseline を算出できない異常系 (非 git / worktree 等の baseline 構築失敗) に、判定不能を黙って合格にしてはならない。ゲートの合否 (exit 2 / exit 0) とは区別できる専用の exit code (exit 1) と明示メッセージで終了しなければならない。縮退した別判定 (直接 claim のみ等) は行わない。なお HEAD が存在しない初回コミット前は「baseline 空 = 全 current issue が新規」として扱い (FR-014)、これは異常系ではなく正常系である。
- **FR-011**: baseline の drift 判定は、`.trace.lock` が gitignore されコミットされないことを前提に、**現在の lock** を基準に行わなければならない (base ref 時点の graph を現在の lock と比較して得た drift を baseline drift とする)。
- **FR-012**: 内部構造は、将来 base ref を任意指定できるように、base ref をパラメータとして受け取れる形で実装しなければならない (Phase 2 準備。CLI への露出は本 feature のスコープ外)。
- **FR-013**: 変更が「グラフに登録されたノードに一切対応しない」場合 (グラフ外のファイルのみの変更) の挙動は、現状の `check --diff` の挙動を維持しなければならない。
- **FR-014**: HEAD が存在しない初回コミット前は、baseline を「空」(比較対象なし) として扱い、現在の全 current issue を新規とみなさなければならない。これは異常系ではなく正常系であり、FR-010 のエラー終了とは区別する。

### Key Entities

- **current issues**: 現在の作業ツリー状態でゲート候補となる問題の集合 (drift / orphan / uncovered / test failure)。各 issue は種別と対象 ID (または orphan の場合は source→target 表現) で一意に識別される。
- **baseline issues**: base ref 時点のプロジェクト状態で同様に算出した問題の集合。drift 判定のみ現在の lock を基準とする。
- **new issues**: `current issues \ baseline issues`。ゲートの合否を決める唯一の集合。
- **base ref**: baseline を算出する git 参照点。Phase 1 では HEAD 固定。Phase 2 で任意指定可能にする。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: pre-existing の未タグ付け債務のみが影響範囲に入る変更 (例: 多数の REQ につながるファイルへの意味を変えない編集) で、`check --diff --gate` が exit 0 で終わる。現状この操作は exit 2 になる。
- **SC-002**: 変更が新規に導入した drift / orphan / uncovered が 1 件でもある場合、`check --diff --gate` は exit 2 になり、その新規問題が不合格理由として報告される (見逃しゼロ)。
- **SC-003**: baseline 算出の前後で、ユーザーの `git status` (作業ツリー・index)・lock ファイルの内容が完全に一致する (副作用ゼロ)。
- **SC-004**: 50 ファイルにまたがる純粋なリファクタ (新規問題ゼロ) で、`check --diff` の text 出力が新規問題ゼロを示す簡潔な出力に収まり、pre-existing 債務の全件 (数百行規模) を列挙しない。
- **SC-005**: 現在の状態で新規候補問題がゼロのとき、baseline 算出のための一時作業領域生成が実行されない (遅延評価が効いている)。
- **SC-006**: `impact --diff` が報告する影響 REQ / doc / file の件数が、本 feature の前後で同一である。

## Assumptions

- **lock は gitignore されコミットされない**: 本プロジェクトの `.trace.lock` は gitignore されている (確認済み)。したがって baseline の drift 判定は base ref 時点の lock ではなく現在の lock を基準に行う (FR-011)。この前提が変わり lock がコミット対象になっても、現在の lock を基準にする方針は有効なままである。
- **git worktree が利用可能な環境**: baseline 状態の構築は、ユーザーの作業ツリーを汚さずに base ref のファイル内容を別領域へ展開できる手段 (git worktree 等) が利用できることを前提とする。parse キャッシュは当該領域では自動的に無効化され、キャッシュ汚染は生じない (別領域に依存パッケージ環境が無いため)。
- **baseline 構築不能時はエラー終了 (Clarification 2026-07-07 で確定)**: baseline を構築できない異常系 (非 git / worktree 生成失敗等) では、縮退した別判定は行わず、ゲート合否 (exit 2 / exit 0) と区別できる専用 exit code (exit 1) と明示メッセージで終了する (FR-010)。判定不能の黙殺 (Constitution 原則 I 違反) を避けつつ、稀な異常系のために別判定ロジックを維持しないシンプルさを優先した。HEAD 無しの初回コミット前は異常系ではなく「baseline 空」の正常系として扱う (FR-014)。
- **Phase 2 (`--base <ref>` の CLI 露出) は本 feature のスコープ外**: コミット済み / プッシュ済み / PR 済みブランチを base ref 指定でチェックする機能は follow-up の別 PR とする。本 feature では内部構造を base ref パラメータ化するに留める (FR-012)。
- **中間実装状態のゲート挙動 (#178) はスコープ外**: 新 spec で REQ を追加し実装途中の状態で、未実装 REQ が新規 uncovered として正当にゲートを止める問題は本 feature の対象外であり、issue #178 で別途扱う。
- **pre-existing 債務そのものの解消はスコープ外**: 他 spec の未タグ付け REQ・重複 / ambiguous ID の整理は本 feature の対象外。baseline 差分によりゲートからは無害化されるため、債務解消は独立した衛生タスクとする。
