# Feature Specification: impact CLI 再設計 (file-only / --from-tasks) + plan-coverage 新設

**Feature Branch**: `feat/reinvent-impact-cli`

**Created**: 2026-06-28

**Status**: Draft

**Input**: User description: 「spec 012-skills-expansion ([#98](https://github.com/ShintaroMorimoto/artgraph/issues/98), PR [#103](https://github.com/ShintaroMorimoto/artgraph/pull/103)) で `artgraph-plan` → `artgraph-impact` への rename と 3 入力モード化を行ったが、CLI 機能と Skill description が約束する価値の間に距離がある。本 spec で `impact` CLI を file-only に再設計し、SDD 駆動の網羅性ガード `plan-coverage` を新設する。」

**Parent issue**: [#104](https://github.com/ShintaroMorimoto/artgraph/issues/104) — spec 012 振り返り由来

**Related**: [#98](https://github.com/ShintaroMorimoto/artgraph/issues/98) (P0 parent), [#103](https://github.com/ShintaroMorimoto/artgraph/pull/103) (P0 PR), [#101](https://github.com/ShintaroMorimoto/artgraph/issues/101) (spec 013 cross-agent — `plan-coverage` Skill 配布は 013 の portable Skills 経路に合流), [#102](https://github.com/ShintaroMorimoto/artgraph/issues/102) (pkg-mgr agnosticism), [#105](https://github.com/ShintaroMorimoto/artgraph/issues/105) (spec 015 候補 — `plan-coverage` enforcement / `Files:` 強制 / before_implement hook)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — 新規 REQ 実装時の暗黙波及検知 (Priority: P1)

ユーザーが新規 REQ-005 を実装するため tasks.md に `Files: src/auth.ts, src/new-2fa.ts` と書いて `/speckit-implement` を起動する。`src/auth.ts` は既存で `@impl REQ-001` を持っており、REQ-003 にも `verifies` edge で間接的に繋がっている。ユーザーは REQ-001 / REQ-003 を意識していない。

`artgraph plan-coverage` を実行すると「`src/auth.ts` を編集すると REQ-001 と REQ-003 にも影響が及ぶが、tasks.md / spec.md でこれらは一切言及されていない」と暗黙波及を列挙する。ユーザーは各 REQ を調査し、(a) 実際に対応が必要なら tasks.md に追加 / (b) 影響無しと判明したら tasks.md に `Considered: REQ-003 — investigated, no impact` 等の任意形式で記録 / (c) CI を一時的に通すために `--ignore` で suppress、のいずれかを選ぶ。

**Why this priority**: artgraph のコア価値「変更漏れを起こさない」の中核。`impact` (file 起点 forward 波及) と `check` (実装 vs spec drift) では捉えられない「人間が tasks.md を書いたとき、既存仕様への暗黙の波及を見落としていないか」を埋める唯一の機能。

**Independent Test**: 既存の `src/auth.ts` に `@impl REQ-001` tag があり、tasks.md は `Files: src/auth.ts` のみ・本文に `REQ-001` の文字列が一切無い fixture で `artgraph plan-coverage --format json` を実行し、`implicitImpacts[].reqs` に `REQ-001` が含まれる。tasks.md 本文のどこかに `REQ-001` を追記すると次の実行では `implicitImpacts` から消える。

**Acceptance Scenarios**:

1. **Given** tasks.md の `Files: src/auth.ts` 起点で impact() の `affectedReqs` が `[REQ-001, REQ-003, REQ-007]`、tasks.md / spec.md 本文に `REQ-001` の文字列だけが出現する、 **When** `artgraph plan-coverage` を実行、 **Then** `implicitImpacts` に `REQ-003` と `REQ-007` が列挙され、`REQ-001` は含まれない。exit 0。
2. **Given** 暗黙波及ゼロの状態、 **When** 同コマンド、 **Then** "No implicit impacts." を出力し exit 0。
3. **Given** 暗黙波及 REQ がある状態、 **When** `--gate` 付き、 **Then** exit 1 (CI 用)。
4. **Given** `--ignore REQ-003,REQ-007` を付けた `--gate` 実行、 **When** 残りの暗黙波及がゼロ、 **Then** exit 0(one-shot 抑止、永続化しない)。
5. **Given** 暗黙波及検知済の状態でユーザーが tasks.md に `Considered: REQ-003 — no actual impact, verified by reading src/auth.ts:120-140` の 1 行を追加、 **When** 次の実行、 **Then** `REQ-003` が `implicitImpacts` から消える(any-mention 判定なのでラベルや keyword は問わない)。
6. **Given** `SPECIFY_FEATURE_DIRECTORY` 環境変数も `.specify/feature.json` も無い repo、 **When** `--spec` / `--tasks` 省略で実行、 **Then** "use --spec to point at .specify/specs/<name>/ or .kiro/specs/<name>/" エラーで exit 1。
7. **Given** `implicitImpacts` で `src/auth.ts` と `src/session.ts` の 2 sourceFile から同じ REQ-003 に波及、 **When** `implicitImpactsByReq` を確認、 **Then** `{ reqId: "REQ-003", sourceFiles: ["src/auth.ts", "src/session.ts"] }` の 1 エントリで表現される(by-FR 軸の reorganize ビュー)。

---

### User Story 2 — impact CLI の file-only 化 (Priority: P1)

ユーザーが「auth まわり触る予定」のような file 起点で影響範囲を見たいとき、`artgraph impact src/auth.ts` か `artgraph impact --from-tasks tasks.md` のどちらかで起点 file を指示し、CLI は forward 波及を返す。REQ-ID 入力経路は撤去され、`impact` の mental model は「file → 波及」一方向に揃う。

**Why this priority**: `impact REQ-001` のような REQ 起点入力は SDD workflow の実態 (tasks.md に書かれた file 起点) と乖離しており、Skill description の "planning / designing / scoping" wide-match の根拠にもなっていた。CLI を file-only に絞ることで Skill description との約束が一致し、`plan-coverage` (US1) との役割分担も明確になる。

**Independent Test**: `artgraph impact REQ-001` がエラー終了し、メッセージで file path / `--from-tasks` / `--from-plan` / `--diff` の 4 入力経路を案内する。`artgraph impact --from-tasks specs/014-reinvent-impact-cli/tasks.md` が tasks.md 内の file パスを抽出して期待される `affectedReqs` を返すことを E2E で確認。

**Acceptance Scenarios**:

1. **Given** 任意の fixture、 **When** `artgraph impact src/auth.ts` を実行、 **Then** forward BFS の結果 (`affectedReqs` / `affectedDocs` / `affectedFiles` / `drifted`) を返す。
2. **Given** 同じ fixture、 **When** `artgraph impact REQ-001` を実行、 **Then** エラー終了し、メッセージで `--from-tasks <path>` / `--from-plan <path>` / file path 直指定 / `--diff` の 4 経路を案内する。
3. **Given** tasks.md に `Files: src/auth.ts, src/session.ts` 形式のセクションがある、 **When** `artgraph impact --from-tasks <path>` を実行、 **Then** 2 file 起点で impact を計算する。
4. **Given** tasks.md に `Files:` セクションが無く本文に `src/auth.ts` 等の path 形が含まれる、 **When** 同コマンド、 **Then** regex フォールバックで実在 file path を抽出して起点にする。
5. **Given** `--diff`、 **When** `artgraph impact --diff` を実行、 **Then** git diff から file を抽出して起点にする。

---

### User Story 3 — `artgraph-impact` Skill description の正直化 (Priority: P1)

エージェントが「Plan 段階だから」「設計だから」という弱い動機で `artgraph-impact` Skill を発火させなくなる。Skill は「file を起点とした forward 波及確認」だけを約束し、「tasks の暗黙波及チェック」は別 Skill `artgraph-plan-coverage` が受け持つ。エージェントの誤発火が減り、`artgraph` 系 CLI の責務分担が外部から見ても整理される。

**Why this priority**: spec 012 PR #103 で配備した Skill description が CLI 機能より広い約束をしていた。US2 の CLI 変更とロックステップで Skill 側も更新しないと、Skill が「Plan」「設計」で発火しても CLI 機能で応えられない状況が残る。

**Independent Test**: `templates/skills/artgraph-impact/SKILL.md` の `description` から "planning / designing / scoping" の wide-match 表現が消えていること、Mode (b) の REQ-ID 抽出指示が消えていること、`--from-tasks` の使い方サンプルが追記されていることを grep で確認。

**Acceptance Scenarios**:

1. **Given** 改訂後の `artgraph-impact/SKILL.md`、 **When** Skill description を grep、 **Then** "planning" / "designing" / "scoping" のいずれも含まれない。
2. **Given** 同 SKILL.md、 **When** Mode (b) の記述を確認、 **Then** REQ-ID 抽出指示は消え、file path / `--from-tasks` 経路のみが記載されている。
3. **Given** 同 SKILL.md、 **When** Mode (c) (ask) の質問文を確認、 **Then** "Which tasks.md / plan.md path, or which file(s)?" 形に書き換えられている。

---

### User Story 4 — `artgraph-plan-coverage` Skill 配布 (Priority: P2)

ユーザーが `/speckit-tasks` の直後、または `/speckit-implement` の直前で「tasks の暗黙波及チェック」をエージェントに頼むと、`artgraph-plan-coverage` Skill が semantic match で発火し、`artgraph plan-coverage --format json` を実行して暗黙波及 REQ を提示する。エージェントはその出力を使って tasks.md への追記候補(対応 or `Considered:` 記録)を提示する。

**Why this priority**: US1 で CLI は完成しているが、エージェントワークフロー (Spec Kit / Kiro) に乗せて「自動的に呼ばれる」体験を作るには Skill が必要。優先度は P1 より低 (CLI 単体・CI 経由でも機能する) が、P2 として cross-agent (spec 013) より先に配布する価値がある。

**Independent Test**: `.claude/skills/artgraph-plan-coverage/SKILL.md` を配備後、Claude Code に「tasks の波及確認」と依頼し、Skill が発火して `artgraph plan-coverage --format json` を実行することを目視確認。Skill 本文が 100 行以下、`_shared/install-check.md` を参照していることを静的検証。

**Acceptance Scenarios**:

1. **Given** spec 014 PR マージ済の repo、 **When** `artgraph init` を実行、 **Then** `.claude/skills/artgraph-plan-coverage/SKILL.md` が配備される。
2. **Given** 配備済、 **When** ユーザーが「tasks 波及確認」「`/speckit-tasks` 後の整合性チェック」等を依頼、 **Then** `artgraph-plan-coverage` Skill が発火し `artgraph plan-coverage --format json` を実行する。
3. **Given** 同 Skill 本文、 **When** `wc -l`、 **Then** 100 行以下。

---

### User Story 5 — SDD 統合テンプレで `Files:` / REQ-ID mention 規約を推奨化 (Priority: P2)

Spec Kit / Kiro 統合テンプレが「tasks.md の各タスクに `Files:` セクションを書く」「波及調査済の REQ は tasks.md に明示記録する(任意ラベル)」ことを推奨として明文化する。これにより `plan-coverage` の regex フォールバックに依存せず構造化抽出が効くようになり、検知後ループも自然な習慣になる。強制 (`--require-files-section`) は opt-in なので既存プロジェクトを壊さない。enforcement (Stop hook / before_implement gating) は spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) で扱う。

**Why this priority**: テンプレ修正は軽量で本 spec に同梱できるが、enforcement (blocking hook) は範囲が広いので別 issue (#105) に切り出す。本 spec ではあくまで「推奨」の文章追加に留めることでスコープ膨張を防ぐ。

**Independent Test**: `templates/integrate/speckit/extension.yml` または関連ガイドに `Files:` 規約と REQ-ID mention 規約の記述があること、`templates/integrate/kiro/artgraph.md` にも同等のガイダンスがあることを grep で確認。

**Acceptance Scenarios**:

1. **Given** PR マージ後の repo、 **When** Spec Kit 統合テンプレ (`templates/integrate/speckit/`) を grep、 **Then** "Files:" 規約と REQ-ID 明示言及 (例 `Considered:` / `Affected:` 任意ラベル) のガイダンスが含まれる。
2. **Given** 同 PR、 **When** Kiro 統合テンプレ (`templates/integrate/kiro/artgraph.md`) を grep、 **Then** 同等のガイダンスが含まれる。

---

### User Story 6 — ドキュメント更新 (Priority: P3)

`docs/skills-guide.md` と `README.md` の Skills 表が新設計 (`artgraph-impact` 改訂 + `artgraph-plan-coverage` 追加) を反映する。Skills 種別は P0 で 7 種だったものが本 spec で 8 種になる。

**Why this priority**: ユーザー向けドキュメントの整合性。CLI / Skill が動けば技術的には機能するが、未更新ドキュメントは新規ユーザーを混乱させる。優先度を P3 にしているのは「CLI / Skill が出来上がってから書く」順序のため。

**Acceptance Scenarios**:

1. **Given** PR マージ後、 **When** `docs/skills-guide.md` の `artgraph-impact` 節を確認、 **Then** file-only 化 + `--from-tasks` の説明が記載されている。
2. **Given** 同 docs、 **When** `artgraph-plan-coverage` 節を確認、 **Then** 新規節が追加されている。
3. **Given** `README.md` の Skills 表、 **When** 確認、 **Then** 8 種が掲載されている。

---

### Edge Cases

- **REQ-ID 入力**: `artgraph impact REQ-001` のような REQ-ID 入力は専用エラー終了。silent な fallback はしない(mental model 簡素化が目的)。
- **`--from-tasks` で `Files:` セクション無し**: regex フォールバックで `[\w./-]+\.\w+` 形の path を拾い、`graph.nodes` に file ノードがあるか `fs.existsSync` で実在検証したものだけ採用する。1 件も抽出できない場合は警告 + exit 1。
- **`plan-coverage` 入力推論失敗**: `--spec` / `--tasks` 省略で `SPECIFY_FEATURE_DIRECTORY` env var → `.specify/feature.json#feature_directory` の順で探索し、いずれも見つからない場合は明示引数を要求するエラーで終了。**Kiro には canonical な current spec 指標が存在しない(公式 docs で確認)** ため、Kiro 利用時は `--spec .kiro/specs/<name>/` を明示する必要がある。
- **暗黙波及 REQ の言及判定**: `tasks.md` + `plan.md` + `spec.md` のテキストを union し、impact() の `affectedReqs` 各 ID 文字列が `\b<ID>\b` 相当の境界マッチで出現するかで判定する。ラベル (`Considered:` / `Affected:` 等) は区別しない — どんな書き方でも「言及」とみなす。
- **`--ignore` の永続性**: `--ignore REQ-003,REQ-007` は当該実行限定の one-shot 抑止。設定ファイルに書き出さない(永続的に黙らせたいなら tasks.md に書く方針)。
- **`--require-files-section` ON だが任意の task block に `Files:` 無し**: `diagnostics` 配列に `{ kind: "missingFilesSection", ... }` を追加。`--gate` 併用時のみ exit 非 0。デフォルト OFF なので既存プロジェクトを壊さない。
- **`affectedReqs` ゼロ**: tasks.md の Files: が抽出ゼロ、または抽出 file が impact() で REQ に到達しないケース。`implicitImpacts: []` + summary に明示 + exit 0 (= 健全状態として扱う)。
- **同名 REQ-ID prefix**: `REQ-1` と `REQ-10` の区別は `\b` 境界判定で行う。markdown link 内 (`[#REQ-3](...)`) も `\bREQ-3\b` でマッチする。
- **CLI と Skill のリリース順序**: Skill 改訂 (US3) と CLI 改訂 (US2) を別 PR にすると、merge 順序によっては中間状態で Skill と CLI が整合しない時間が発生する。両者を **同一 PR でロックステップ merge** することで回避する。

## Requirements *(mandatory)*

### Functional Requirements

**`artgraph impact` 再設計 (US2)**

- **FR-001**: `artgraph impact` の `[targets...]` 引数は **file path のみ** を受け付ける。REQ-ID / `doc:` prefix 入力は受け付けない。
- **FR-002**: `src/graph/traverse.ts:resolveStartIds` から REQ-ID / `doc:` prefix 解決ロジックを削除し、file path 解決のみに絞る(関数名は `resolveFileStartIds` に rename して責務を明示)。
- **FR-003**: REQ-ID 風の入力 (e.g. `/^[A-Z]+-\d+$/` にマッチ) が来た場合は専用エラーで終了し、メッセージで `--from-tasks <path>` / `--from-plan <path>` / file path 直指定 / `--diff` の 4 経路を案内する。
- **FR-004**: 新オプション `--from-tasks <path>` を追加。指定 path から file 群を抽出して起点にする(抽出戦略は FR-005)。
- **FR-005**: `--from-tasks` / `--from-plan` のパース戦略は二段: (a) `Files: src/a.ts, src/b.ts` 形のセクションがあればそれを優先抽出、(b) 全文 regex `[\w./-]+\.\w+` で path 形を拾い `graph.nodes.has('file:<path>')` または `fs.existsSync(path)` で実在検証したものだけ採用。両戦略でゼロ件なら警告 + exit 1。
- **FR-006**: 新オプション `--from-plan <path>` を `--from-tasks` と同等の挙動で追加(パース戦略共通)。
- **FR-007**: `--diff` / `--depth` / `--format` / `--mode` オプションは挙動を保つ。
- **FR-008**: `impact()` 関数本体(`src/graph/traverse.ts:11`)は変更しない。`plan-coverage` の内部処理でも `impact(graph, fileStartIds, lock)` を同じシグネチャで再利用する。

**`artgraph-impact` Skill 正直化 (US3)**

- **FR-009**: `templates/skills/artgraph-impact/SKILL.md` の frontmatter `description` から `planning` / `designing` / `scoping` の語を削除し、「file 起点で forward 影響を分析する」だけを約束する文面に書き換える。
- **FR-010**: 同 SKILL.md の Mode (b) 説明から REQ-ID 抽出指示を削除する。Mode (a) (`--diff`) / Mode (b) (file path or `--from-tasks`) / Mode (c) (ask user) の 3 入力経路に再構成する。
- **FR-011**: 同 SKILL.md の Mode (c) 質問文を "Which tasks.md / plan.md path, or which file(s) should I analyze?" 形に変更する。
- **FR-012**: 同 SKILL.md に `--from-tasks specs/<latest>/tasks.md` 形の使用例を追記する。

**`artgraph plan-coverage` 新設 (US1)**

- **FR-013**: 新 CLI サブコマンド `artgraph plan-coverage` を追加。オプション: `--spec <dir>` / `--tasks <path>` / `--plan <path>` / `--format json|text` / `--gate` / `--ignore <REQ-IDs>` / `--require-files-section`。
- **FR-014**: `--spec` / `--tasks` 省略時の自動探索は次の順序: (1) `SPECIFY_FEATURE_DIRECTORY` 環境変数, (2) `.specify/feature.json#feature_directory` (Spec Kit canonical: `github/spec-kit:scripts/bash/common.sh:get_feature_paths()` 準拠), (3) どちらも無ければ "use --spec to point at .specify/specs/<name>/ or .kiro/specs/<name>/" エラー。Kiro には canonical な current spec 指標が存在しないため Kiro 利用時は `--spec` 必須。
- **FR-015**: 処理は次の通り: (a) `--tasks` / `--plan` (省略時は spec dir 内の `tasks.md` / `plan.md`) から file 群を抽出 (FR-005 と同じ二段戦略)、(b) その file 群を `startIds` として `impact(graph, fileStartIds, lock)` を実行し `affectedReqs` を得る、(c) `tasks.md` + `plan.md` + `spec.md` のテキスト全体に対し各 `affectedReqs` ID の境界マッチ (`\b<ID>\b`) で言及検査、(d) **言及されていない affected REQ** = `implicitImpacts` として report、(e) `--ignore` で渡された ID は事後フィルタで除外。
- **FR-016**: JSON 出力スキーマは次のキーを持つ: `implicitImpacts` (by-sourceFile 軸 `[{ sourceFile, reqs: [{ reqId, kind }] }]`)、`implicitImpactsByReq` (by-FR 軸 `[{ reqId, sourceFiles: [string] }]`、同じ implicit データを REQ 起点で reorganize した view)、`summary: { totalAffected, mentioned, implicit, ignored }`、`diagnostics: [{ kind, ... }]`、`ignored: [reqId]`。`diagnostics[].kind` は `"missingFilesSection"` (FR-018) 等。`implicitImpactsByReq` 追加の動機: 既存 file を修正する task で「FR-003 はどの file 経由で来ているか」を直接知りたいユースケースを覆う(spec.md と並ぶ FR 軸の自然なビュー)。
- **FR-017**: デフォルトは exit 0 + report (informational)。`--gate` 付きで `implicitImpacts` が非空または diagnostics が非空のとき exit 1。
- **FR-018**: `--require-files-section` フラグ ON、または `.artgraph.json` に `{ "planCoverage": { "requireFilesSection": true } }` がある場合、tasks.md の各 task block に `Files:` セクションが無いものを `diagnostics` 配列に `{ kind: "missingFilesSection", taskId, line }` 形で報告する。デフォルト OFF。
- **FR-019**: `--ignore REQ-003,REQ-007` は当該実行限定の one-shot 抑止。設定ファイルへの永続化はしない。永続的な抑止が必要な場合はユーザーが tasks.md / plan.md / spec.md 内に REQ-ID を mention する(言及判定が拾うので自然に外れる)。
- **FR-020**: 言及判定の source set は `tasks.md` + `plan.md` + `spec.md` のテキスト union。ラベル (`Considered:` / `Affected:` / `[REQ-003]` 等) は区別しない — 単に REQ-ID 文字列の境界マッチで判定する。

**`artgraph-plan-coverage` Skill (US4)**

- **FR-021**: 新 Skill `templates/skills/artgraph-plan-coverage/SKILL.md` を追加。description は「Detects implicit impacts: files declared in tasks.md may affect existing REQs that are not mentioned in tasks.md / spec.md. Run after `/speckit-tasks` or before `/speckit-implement`.」基調。`planning` / `designing` の wide-match は使わない。
- **FR-022**: 同 Skill は `_shared/install-check.md` を参照(重複回避)、本文は 100 行以下に収める。
- **FR-023**: 同 Skill の frontmatter `allowed-tools` は `Bash(npx artgraph plan-coverage *)` / `Bash(artgraph plan-coverage *)` を含める。
- **FR-024**: `artgraph init` デフォルト(full agent-native setup)で新 Skill が配備される(= `templates/skills/` 全配布の対象に含まれる)。

**SDD 統合テンプレ強化 (US5)**

- **FR-025**: `templates/integrate/speckit/extension.yml` または関連ドキュメント(`templates/integrate/speckit/README.md` 等)に以下のガイダンスを追記する: (a) tasks.md の各タスクに `Files: <path>, <path>` セクションを書くことを推奨、(b) `plan-coverage` で出た暗黙波及 REQ を調査後、tasks.md / plan.md / spec.md のいずれかで REQ-ID を mention することを推奨(ラベル形式は自由)。
- **FR-026**: `templates/integrate/kiro/artgraph.md` に FR-025 と同等のガイダンスを追記する。
- **FR-027**: enforcement(Stop hook / before_implement hook で `plan-coverage --gate` を blocking、`requireFilesSection` をデフォルト ON 化)は本 spec のスコープ外。spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) で扱う。

**ドキュメント (US6)**

- **FR-028**: `docs/skills-guide.md` の `artgraph-impact` 節を新設計(file-only / `--from-tasks`)に合わせて改訂する。
- **FR-029**: `docs/skills-guide.md` に `artgraph-plan-coverage` 節を新規追加する(検知後 3 経路 (mention / `--ignore` / 将来 strict mode) も記載)。
- **FR-030**: `README.md` の Skills 表を 8 種に更新する。

**Cross-cutting**

- **FR-031**: 全変更は既存 constitution (Determinism First, Spec Owns the ID, Boundary of Determinism) を維持する。`plan-coverage` は読み取り専用で graph や lock を書き換えない。
- **FR-032**: 全新機能は vitest で integration test 可能であること。具体的には `artgraph impact` の REQ-ID 入力エラー、`--from-tasks` 抽出、`plan-coverage` の暗黙波及計算、言及判定、`--ignore` フィルタ、`--require-files-section` 診断を E2E test で覆う。

### Key Entities

- **Implicit Impact**: `plan-coverage` の中心出力 entity。tasks.md の Files: 起点に impact() が拾った `affectedReqs` のうち tasks.md / plan.md / spec.md で一切 mention されていないものを表す。**2 つの軸で同じデータを出力**する: (a) by-sourceFile 軸 `implicitImpacts: [{ sourceFile, reqs: [{ reqId, kind }] }]` — 「この file を触ると何が波及するか」、(b) by-FR 軸 `implicitImpactsByReq: [{ reqId, sourceFiles: [string] }]` — 「この FR はどの file 経由で来ているか」。後者は前者の inversion view で、データ重複は意図的(人間が見やすい軸を選べるように)。
- **File Extraction Strategy**: `--from-tasks` / `--from-plan` および `plan-coverage` で共有される 2 段パース戦略(`Files:` セクション優先 → regex フォールバック)。`src/parsers/sdd-files.ts`(新規)に集約する。
- **REQ Mention Detector**: tasks.md / plan.md / spec.md のテキスト union に対し各 REQ-ID の境界マッチを行う検出器。ラベル無依存(`Considered:` / `Affected:` / `[REQ-003]` を区別しない)。`src/plan-coverage/mention.ts`(新規)に集約する。
- **Plan Coverage Config**: `.artgraph.json` の新セクション `{ "planCoverage": { "requireFilesSection": boolean } }`。デフォルト `false` (lenient)。
- **artgraph-plan-coverage Skill**: 新 Skill。`description` は「tasks.md の Files: が及ぼす暗黙波及を検知する」だけを約束し wide-match を避ける。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `artgraph impact` の `[targets...]` 引数に REQ-ID 風の入力が来た場合、専用エラーメッセージ(4 経路案内)で終了する。`grep` で `resolveFileStartIds` 内に REQ-ID 解決パスが残っていないことを確認。
- **SC-002**: `artgraph impact --from-tasks <path>` が `Files:` セクションありの tasks.md で **100%** の正解率(fixture テスト 5 件)、regex フォールバックでも実在 file 抽出の正解率 **>= 90%**(`Files:` 無しの fixture 10 件)。
- **SC-003**: `artgraph plan-coverage` の `implicitImpacts` 計算が、3 件の fixture(各 5–10 task block、REQ-ID mention の有無を網羅)で **100%** 期待通りの暗黙波及 REQ を列挙する。
- **SC-004**: REQ mention 検出が `[REQ-3]` / `REQ-3` / `Considered: REQ-3` / `## REQ-3 ...` のいずれの形でも検出する一方、`REQ-30` / `REQ-300` を `REQ-3` の mention と誤判定しない(境界マッチ正解率 **100%**)。
- **SC-005**: `templates/skills/artgraph-impact/SKILL.md` の `description` から `planning` / `designing` / `scoping` の語が **0 件**。`grep -i "planning\|designing\|scoping"` で空。
- **SC-006**: 新 Skill `artgraph-plan-coverage` の `SKILL.md` が **100 行以下**、`_shared/install-check.md` を参照、`allowed-tools` に `plan-coverage` 系コマンドが宣言されている。
- **SC-007**: `artgraph init` デフォルト実行後、`.claude/skills/artgraph-plan-coverage/SKILL.md` が配備される(E2E test)。
- **SC-008**: `--gate` 付きで暗黙波及が非空のとき exit 1、`--gate` 無しでは exit 0(E2E test 2 件)。`--ignore REQ-X,REQ-Y` で残りがゼロになれば `--gate` 付きでも exit 0(E2E test 1 件)。
- **SC-009**: `--require-files-section` OFF(デフォルト)では既存 tasks.md fixture(`Files:` セクション無し 10 件)で diagnostics が空、ON にすると **100%** の task block について diagnostics に `missingFilesSection` が含まれる。
- **SC-010**: `docs/skills-guide.md` と `README.md` Skills 表が 8 種を掲載(`artgraph-impact` 改訂 + `artgraph-plan-coverage` 追加)。peer review で確認。

## Assumptions

- **`expectedFiles` 概念は持たない**: 旧案 (spec.md に `**Affected Files**` 宣言を追加して REQ ごとに expected files を計算) は廃案。`plan-coverage` は「tasks.md の Files: → impact() の affectedReqs → tasks.md / plan.md / spec.md での REQ mention 引き算 → 暗黙波及」というシンプルなセマンティクスに統一する。
- **REQ-level coverage 概念も持たない**: 「spec の REQ 群が tasks で網羅的に実装される予定か」のチェックは本 spec のスコープ外。本 spec の目的は「人間が tasks を書いたとき、既存仕様への暗黙波及を見落としていないか」を埋めることに限定する。
- **言及判定のラベル無依存**: `Considered:` / `Affected:` 等のラベル keyword を強制しない。REQ-ID 文字列が tasks.md / plan.md / spec.md のどこかに境界マッチで現れれば「考慮済」とみなす。将来 `--require-ack-keyword` のような strict mode を導入する余地は残すが本 spec では実装しない。
- **`Files:` 規約の強度**: 本 spec では「推奨」(`--require-files-section` opt-in 強制)に留め、enforcement (Stop hook / before_implement) は spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) で扱う。
- **着手前提**: spec 012 (PR #103) は merged 済。spec 012 P1 (Stop hook / agent-context) は本 spec と並走可能(impact 再設計と Stop hook 配備は疎)。
- **spec 013 (cross-agent) との順序**: 独立。`artgraph-plan-coverage` Skill は当面 `.claude/skills/` に配備し、spec 013 の portable Skills 仕組みが整ったら載せ替える。
- **REQ-ID 入力の完全撤去 vs 残置 (issue #104 Q1)**: **完全撤去**を採用。spec-rewriter 用途は `plan-coverage` の出力で吸収できるため CLI 表面に `--from-req` のような明示オプションを残す必要なし。
- **`plan-coverage` 入力推論 (issue #104 Q2)**: **Spec Kit canonical の lookup order を踏襲** (`SPECIFY_FEATURE_DIRECTORY` env → `.specify/feature.json#feature_directory` → エラー)。Kiro は公式 docs 上 canonical な current spec 指標が存在しないため `--spec` 必須。
- **exit code (issue #104 Q3)**: **デフォルト exit 0 + report、`--gate` でのみ非 0**。`check --gate` と対称的な CLI 契約。
- **`Files:` 規約強度 (issue #104 Q4)**: **regex フォールバック + opt-in 強制 (`--require-files-section`)**。デフォルトは lenient で既存プロジェクトを壊さず、強制したいプロジェクトは flag / config で opt-in 可能。enforcement は別 issue [#105](https://github.com/ShintaroMorimoto/artgraph/issues/105) に分離。
- **Skill 統合 vs 分離 (issue #104 Q5)**: **別 Skill (`artgraph-plan-coverage`)**。description のセマンティクス(forward 波及 vs 暗黙波及)が別物なので 1 Skill にまとめると wide-match が再発する。
- **PR 構成**: 本 spec は単一 PR で出す(CLI / Skill / templates / docs を一括)。理由: US2 (CLI の REQ-ID 撤去) と US3 (Skill 改訂) を分割すると merge 順序によって Skill と CLI が中間状態で整合しない時間が発生するため、ロックステップ merge する。
