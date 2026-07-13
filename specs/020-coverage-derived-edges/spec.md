# Feature Specification: カバレッジ由来トレーサビリティ — per-test 実行証拠からの REQ↔code `exercises` エッジ自動導出

**Feature Branch**: `feat/coverage-derived-edges`

**Created**: 2026-07-10

**Status**: Draft

**Input**: 設計セッション (2026-07-10) — 「`[REQ-NNN]` タグ付きテストを per-test カバレッジ付きで実行し、各 REQ のテストが実際に実行したコード(関数/シンボル)から req↔code エッジを自動導出する。`@impl` タグなしで 4 層グラフが埋まり(タグ税の減免)、エージェントの `@impl` 自己申告を実行証拠で監査でき、決定的・非 LLM の哲学と整合する」。PoC 検証済み: Vitest カスタムランナー + per-test 精密カバレッジで REQ→シンボル対応の分離取得に成功(forks/threads 両プール、関数名忠実度良好、実測オーバーヘッド約 33%)。

**Related**:

- spec 006 (test-results) — 直接の前身。テスト実行成果物(Vitest JSON / JUnit XML)を入力として取り込み `[REQ-xxx]` タグと join する機構は実装済み。本 spec はこの「実行成果物を入力アーティファクトとして扱う」型を踏襲し、pass/fail に「実行したシンボル集合」を加える。
- spec 011 (edge-provenance) — エッジの provenance 分離モデル。本 spec は provenance 値 `coverage` を追加する(型 union と runtime Set の両方 — spec 011 SC-008 の同期テスト対象)。
- spec 016 / 019 (impact symbol-level / doc-containment) — impact BFS のセマンティクス。本 spec の `exercises` エッジは impact の新しい到達経路となり、逆引き(変更→実行すべきテスト)を可能にする。
- spec 017 (check-gate-baseline-diff) — `check --diff --gate` の baseline 方式。staleness ゲート(US5)は同じ「変更が新規に導入した問題のみ」哲学に従う。
- spec 018 (reexport-symbol-precision) — fail-safe フォールバック哲学(symbol 精度を失っても file 粒度で REQ 到達は保つ・fail-open にしない)。本 spec の関数名 join 曖昧時フォールバックは同じ規範に従う。
- Issue [#218](https://github.com/mori-shin-x/artgraph/issues/218) — クラスメソッド粒度。実行証拠は V8 がメソッド単位で報告するため、`exercises` エッジは `@impl` の「クラスシンボル収束」制約を受けない(本 spec で部分的に先行解決)。
- Issue [#178](https://github.com/mori-shin-x/artgraph/issues/178) / [#229](https://github.com/mori-shin-x/artgraph/issues/229) — ゲートの中間状態ブロック / `@impl` 削除の素通り。証拠エッジは両者に対する独立の検出チャネルになるが、ゲートポリシー変更自体は本 spec のスコープ外。
- Issue [#166](https://github.com/mori-shin-x/artgraph/issues/166) / [#165](https://github.com/mori-shin-x/artgraph/issues/165) — FileSource 層 / LanguageParser 拡張点。trace 取り込みは新しい入力面であり、両者の設計線引きに従う。
- **Constitution 改訂依存**: 本 spec は憲法 v1.1.0 の 2 箇所と衝突するため、実装前に MINOR 改訂を要する(Governance 手続きに従い PR で提案)。(a) 原則 I の edge 導出元列挙「frontmatter 宣言、ID タグ、TS AST のいずれか」に「テスト実行トレース成果物(決定的入力)」を追加。(b) 原則 III のカバレッジ三段階 `untagged / impl-only / verified` に第 4 状態 `exercised` を追加。いずれも「決定的・非 LLM・再現可能」という原則の精神は維持される(同一入力 → 同一出力)。

**前提**: spec 019 と同じく、artgraph は 0.1 で実利用者はいない想定であり、スキーマ追加(lock / JSON 出力)に後方互換の移行導線は設けない。既存の宣言エッジ(`@impl` / `[REQ]`)のセマンティクスは一切変更しない — 本 spec は**追加**であり置換ではない。証拠エッジ(`exercises`)は宣言エッジ(`implements`)に黙って昇格しない。

## エッジ意味論(本 spec の設計核)

artgraph のエッジは現在 2 つの認識論的クラスを持つ: **宣言**(`@impl` / `[REQ]` / frontmatter — 誰かの主張)と**静的構造**(`ts-import` — バイト列からの機械的導出)。本 spec は第 3 のクラス**実行証拠**(テスト実行で観測された事実)を追加する。

| クラス | 例 | 意味 | 捏造可能性 |
| --- | --- | --- | --- |
| 宣言 | `@impl REQ-001` | 「実装している」(意図の主張) | 可(自己申告) |
| 静的構造 | `ts-import` | 「依存している」(構造的事実) | 不可 |
| **実行証拠** | `exercises` | 「REQ-001 のテストに実行される」(観測) | 不可(実行しないと生成されない) |

3 クラスの突き合わせが新しい価値を生む:

| 宣言 (`@impl`) | 証拠 (exercises) | 診断 |
| --- | --- | --- |
| あり | あり | 裏付けられた主張(`implements` に provenance `coverage` を追記) |
| あり | なし | **UNEXERCISED CLAIM**(タグ誤り or テスト欠落の監査所見) |
| なし | あり(排他的) | **SUGGESTED IMPL**(`@impl` 提案) |
| なし | あり(共有) | 静音(インフラコード、`sharedThreshold` で降格) |

決定性は「trace 成果物を入力アーティファクトとして形式化する」ことで維持する: `graph = f(files, trace)`。同一の files と trace からは byte-identical な出力が得られる(spec 006 の `testResultPaths` と同型)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — タグゼロ・トレーサビリティ(trace 採取 → グラフ反映) (Priority: P1)

ユーザーは `vitest.config.ts` に runner 指定を 1 行追加し、普段どおり `vitest run` を実行する。テスト実行の副産物として `.artgraph/trace/` に per-test 実行証拠が生成される。`artgraph scan` がこれを入力として取り込み、**コード側に `@impl` タグが 1 つもなくても** `[REQ-NNN]` タグ付きテストが実行したシンボルへの `exercises` エッジがグラフに現れる。`scan --serve` では証拠由来エッジが宣言エッジと視覚的に区別されて描画される。

**Why this priority**: 本 feature の存在理由。brownfield 導入の最大障壁「コード全体への `@impl` タグ付け(タグ税)」を、テスト側タグだけ + 1 コマンドに減免する。30 秒デモ(「テストを回したらグラフが埋まる」)の成立条件でもある。

**Independent Test**: `@impl` タグゼロ・`[REQ-001]`/`[REQ-002]` タグ付きテストありの fixture で `vitest run` → `artgraph scan --format json` を実行し、`exercises` エッジが REQ ごとに正しいシンボル集合を指すことを assert する。

**Acceptance Scenarios**:

1. **Given** `@impl` タグが 1 つもない TS プロジェクト、`it("[REQ-001] ...")` が `signIn` のみを、`it("[REQ-002] ...")` が `resetPassword` のみを実行する、 **When** trace 生成後 `artgraph scan --format json`、 **Then** グラフに `REQ-001 → symbol:src/auth.ts#signIn`、`REQ-002 → symbol:src/auth.ts#resetPassword` の `exercises` エッジ(provenance `coverage`)が存在し、交差しない。
2. **Given** 同一 fixture、 **When** 同じ files と同じ trace で `scan` を 2 回実行、 **Then** 出力(グラフ JSON)は byte-identical(決定性)。
3. **Given** trace 成果物が存在しない、 **When** `artgraph scan`、 **Then** 従来と完全に同一の出力(exercises エッジは 0 本、警告なし — trace はオプトイン入力)。
4. **Given** REQ-001 のタグ付きテストが 3 本あり、実行シンボル集合が異なる、 **When** `scan`、 **Then** REQ-001 の exercises 集合は 3 本のテストのカバレッジの**和集合**(N:M セマンティクス — 既存の「全テスト green で verified」の `every()` と対をなす)。
5. **Given** 無名 default export など V8 関数名からシンボルを一意に解決できないカバレッジエントリ、 **When** `scan`、 **Then** 該当エッジは file 粒度(`file:src/x.ts`)にフォールバックし、symbol 粒度エッジとしては生成されない(fail-safe / spec 018 と同じ規範。fail-open にならない)。
6. **Given** モジュールトップレベル(module-init)のみを実行したテスト、 **When** `scan`、 **Then** module-init 実行はシンボルへの exercises エッジを生成しない(最初に import したテストへの誤帰属を排除)。

---

### User Story 2 — `@impl` 監査: 主張と証拠の突き合わせ (Priority: P1)

エージェントがコードに `@impl REQ-001` を付けて turn を終えようとする。Stop hook の `artgraph check` が、「REQ-001 のタグ付きテストはこのシンボルを一度も実行していない」ことを検出し、**UNEXERCISED CLAIM** として報告する。逆に、REQ-002 のテストだけが排他的に実行しているのに `@impl` がないシンボルは **SUGGESTED IMPL** として提案される。

**Why this priority**: docs/architecture.md §11 筆頭リスク「リンクの自己申告問題」(エージェントによる `@impl` 捏造)への構造的対策。宣言を置換せず**監査**する — 本 feature の差別化メッセージの核。

**Independent Test**: `@impl REQ-001` を持つが REQ-001 のテストが実行しないシンボルを含む fixture で `artgraph check --format json` を実行し、UNEXERCISED CLAIM 所見が該当シンボルを指すことを assert する。

**Acceptance Scenarios**:

1. **Given** `src/auth.ts#signIn` に `@impl REQ-001`、REQ-001 のタグ付きテストが存在するがいずれも `signIn` を実行しない(trace あり)、 **When** `artgraph check --format json`、 **Then** 所見 `unexercisedClaims` に `{reqId: "REQ-001", symbol: "symbol:src/auth.ts#signIn"}` が含まれる。
2. **Given** `src/auth.ts#resetPassword` に `@impl` なし、REQ-002 のテストのみが排他的に実行する、 **When** 同コマンド、 **Then** 所見 `suggestedImpls` に `{reqId: "REQ-002", symbol: "symbol:src/auth.ts#resetPassword"}` が含まれる。
3. **Given** `sharedThreshold`(既定 3)以上の REQ から実行される共有ヘルパ `validateEmail`、 **When** 同コマンド、 **Then** `suggestedImpls` に現れない(インフラコード降格 — ノイズ抑制)。
4. **Given** `@impl REQ-001` があり REQ-001 のテストも実行している(宣言と証拠の一致)、 **When** `scan --format json`、 **Then** 当該 `implements` エッジの provenances は `["code-tag", "coverage"]`(裏付けられた主張)。所見は出ない。
5. **Given** trace 成果物が存在しない、 **When** `check`、 **Then** UNEXERCISED CLAIM / SUGGESTED IMPL は一切出力されない(証拠がないことは主張の反証ではない)。
6. **Given** REQ-001 のタグ付きテストのうち 1 本が失敗している、 **When** `check`、 **Then** 失敗テストのカバレッジは exercised 集合に算入されない(既定。green な実行のみを証拠と数える — 既存 `verified` の `every()` セマンティクスと整合)。

---

### User Story 3 — 実行到達性 impact とテスト選択 (`impact --tests`) (Priority: P2)

ユーザー(またはエージェント)がコードを変更し、`artgraph impact --diff --tests` を実行する。変更されたシンボルを実行している REQ と、**その REQ のタグ付きテスト(ファイルとテスト名)の一覧**が出力される。エージェントは全テストではなく該当テストだけを回して検証できる。

**Why this priority**: 静的 import グラフでは原理的に答えられない「この変更でどのテストを走らせるべきか」への回答。商用 TIA(Test Impact Analysis)相当の機能が副産物として得られ、獲得側(攻め)の価値提案になる。US1 のエッジが前提。

**Independent Test**: `charge` のみを変更した diff 状態で `artgraph impact --diff --tests --format json` を実行し、REQ-003 のタグ付きテストのみが列挙されることを assert する。

**Acceptance Scenarios**:

1. **Given** `src/billing.ts#charge` が REQ-003 のテストに排他的に実行されており、`charge` のみを変更した working tree、 **When** `artgraph impact --diff --tests --format json`、 **Then** `testsToRun` に REQ-003 のタグ付きテスト(ファイルパス + テスト名)のみが含まれる。
2. **Given** 変更シンボルを実行する trace 由来の REQ と、静的 `@impl`/import 由来の REQ が異なる、 **When** `impact --diff --format json`、 **Then** 両方が `impactReqs` に含まれ、各到達の由来(静的 / 証拠)が provenance で区別できる。
3. **Given** trace 成果物なし、 **When** `impact --diff --tests`、 **Then** exit 1 とし「trace がありません(runner 導入方法への誘導)」を明示する(静かに空を返さない)。

---

### User Story 4 — 証拠によるカバレッジ充足(オプトイン `acceptExercises`) (Priority: P2)

タグ軽量運用のチームが `.artgraph.json` で `trace.acceptExercises: true` を設定する。`@impl` タグがなくても、排他的 exercises エッジを持つ REQ は `uncovered` ではなく新ステータス **`exercised`** として報告され、`check --gate` を通過する。既定は `false` で、既存の三段階評価は一切変わらない。

**Why this priority**: 「粒度と厳格さを使う側に委ねる」既存方針(D3)の延長。厳格チームは `@impl` 必須のまま、軽量チームはタグゼロ運用が可能になる。オプトインである限り原則 III の非対称な信頼境界を破らない。

**Independent Test**: `@impl` ゼロ + 排他的 exercises ありの fixture で、設定 off/on それぞれの `check --format json` の coverage ステータスを assert する。

**Acceptance Scenarios**:

1. **Given** REQ-001 に `@impl` なし・排他的 exercises あり・`acceptExercises: false`(既定)、 **When** `check --format json`、 **Then** REQ-001 は `uncovered`(従来どおり)。
2. **Given** 同構成で `acceptExercises: true`、 **When** 同コマンド、 **Then** REQ-001 のステータスは `exercised` であり、`uncovered` リストに現れない。
3. **Given** `acceptExercises: true` かつ REQ-002 は `@impl` あり + テスト green + exercises あり、 **When** 同コマンド、 **Then** REQ-002 は `verified`(最上位ステータスは変わらない — `exercised` は宣言なし REQ の救済であり、宣言済み REQ の評価軸を変えない)。

---

### User Story 5 — 鮮度管理(staleness) (Priority: P2)

ユーザーが trace 生成後にコードを編集する。`artgraph check` は「REQ-003 の exercises 対象シンボルのうち 2 つが trace 取得時からハッシュ変更されている — テストを再実行してください」と警告する(`trace.staleness: "warn"`、既定)。`"exclude"` では stale エッジを判定から除外し、`"gate"` では `check --gate` を fail させる。

**Why this priority**: 実行証拠は「ある時点の観測」であり、既存の無時間的な静的エッジと違って陳腐化する。鮮度を明示的にモデル化しないと決定性ブランドが濁る。trace 生成時に各実行シンボルの contentHash を記録し、既存の drift 機構(hash 照合)をそのまま転用する。

**Independent Test**: trace 生成 → 対象シンボルを編集 → `check --format json` で stale 警告が該当 REQ とシンボルを指すことを assert する。

**Acceptance Scenarios**:

1. **Given** trace 取得後に `charge` の本文を変更(REQ-003 が exercises)、`staleness: "warn"`、 **When** `check --format json`、 **Then** `staleEvidence` に `{reqId: "REQ-003", symbols: [...], tracedAt: ...}` が含まれ、exit code は変わらない。
2. **Given** 同構成で `staleness: "exclude"`、 **When** `check --format json`、 **Then** stale な exercises エッジは UNEXERCISED CLAIM / SUGGESTED IMPL / `exercised` 充足のいずれの判定にも使われない(証拠として無効化)。
3. **Given** 同構成で `staleness: "gate"` かつ `--gate`、 **When** `check --diff --gate`、 **Then** exit 2。
4. **Given** テストを再実行して trace を再生成、 **When** `check`、 **Then** stale 警告が消える(trace は世代置き換え — 差分蓄積しない)。

---

### User Story 6 — bootstrap 強化: LLM 提案はテスト側タグのみ (Priority: P3)

brownfield プロジェクトでユーザーが `artgraph-bootstrap` Skill を起動する。Skill は従来の「コードへの `@impl` 提案」ではなく、**既存テストのタイトルへの `[REQ-NNN]` タグ挿入のみ**を提案する(テスト名は要求語彙に近く、判断が容易でレビューも軽い)。ユーザーが受け入れてテストを実行すると、コード側エッジは実行証拠から機械的に導出される。提案の誤りは「タグ付けしたテストの実行経路が spec 記述と乖離している」ことで機械的に疑義を上げられる。

**Why this priority**: US1〜US5 の機構が揃って初めて成立する応用。Skill 文書の更新が主で、CLI 本体の変更は小さい。既存の「LLM proposes, artgraph check verifies」の役割分担を保ったまま、検証側が「evidence verifies」に強化される。

**Independent Test**: Skill 文書(テンプレート)のレビューで確認する — 提案対象をテストファイル + 新規 spec に限定し、実装コードへの `@impl` 挿入をテスト不在領域のフォールバックに限る指示になっていること(LLM の実行結果自体は原則 V によりテスト対象外)。

**Acceptance Scenarios**:

1. **Given** `@impl` ゼロ・タグなしテストありの brownfield fixture、 **When** bootstrap Skill 実行、 **Then** 提案 diff の変更対象はテストファイル(+新規 spec)のみで、実装コードへの変更を含まない。
2. **Given** テストが存在しないコード領域、 **When** bootstrap Skill 実行、 **Then** 従来の `@impl` 提案フローにフォールバックする(カバレッジ路線はテストの存在が前提)。

---

### Edge Cases

- **`it.concurrent` / 並行テスト**: 同一ワーカー内で並行実行されるテストはカバレッジ帰属が混線する。runner は concurrent テストを検出したら該当テストのカバレッジを**破棄**し、trace に `skipped: concurrent` として記録する(誤ったエッジを出すより欠落が正しい — fail-safe)。
- **順序依存テスト**: 前のテストが温めた状態に依存するテストは帰属が不正確になり得る。前提条件として文書化し(Stryker perTest と同じ制約)、検出は本 spec のスコープ外。
- **失敗テストのカバレッジ**: 既定で exercised 集合に算入しない(US2 シナリオ 6)。ただし trace 成果物には記録し、将来の診断(「red テストはこのコードに到達している」)の材料として保持する。
- **REQ の rename / split / merge**: `artgraph rename` は trace 成果物内の REQ ID も書換え対象に含める。書換え不能な形式の trace(旧スキーマ世代)は stale 扱い。
- **trace 内の消滅ファイル/シンボル**: scan 時に解決できない trace エントリ(ファイル削除・シンボル削除)は dangling として無視し、`--format json` の診断カウントに計上する(silent skip しない — issue #189 の教訓)。
- **複数ワーカーの同時書き込み**: ワーカーごとに独立ファイルへ書き、ingest 時にマージする(書き込み競合を設計で排除)。
- **CI シャーディング**: 複数シャードの trace はマージ(和集合)して 1 世代として扱える。
- **exclude glob との交差**: scan 対象外(`include` 外)のファイルへのカバレッジはエッジ化しない(静的エッジと同じ境界)。
- **テストファイル自身・`node_modules`**: カバレッジ対象から除外(app コードのみ)。
- **describe 階層のタグ継承**: `describe("[REQ-001]")` 配下の全 `it` は REQ-001 のテストとして扱う(spec 006 の `extractReqTags` 祖先継承と同一規則)。

## Requirements *(mandatory)*

### Functional Requirements

**trace 採取(runner)**

- **FR-001**: 配布物として Vitest 用テストランナー(`artgraph/vitest`)を提供し、ユーザーの vitest 設定に 1 行追加するだけで導入できること。既存のテスト結果・スナップショット・レポーターの挙動を変更しないこと。
- **FR-002**: runner は各テストケース(`it`)単位で実行カバレッジを分離取得し、テスト名(タグ抽出可能な形)・テストファイル・実行された関数(ファイルパス + 関数名 + 実行有無)を per-test レコードとして `.artgraph/trace/` に出力すること。forks / threads 両プールで動作すること。
- **FR-003**: per-test 分離が保証できないテスト(concurrent 等)のレコードは破棄し、破棄した事実を trace に記録すること(誤帰属エッジを生成しない)。
- **FR-004**: trace 成果物は決定的に正規化されること — 関数粒度で boolean 化(実行回数を保持しない)、エントリはソート済み、タイムスタンプ等の非決定情報はメタデータフィールドに隔離。同一のテスト実行内容からは(実行順によらず)同一の正規化 trace が得られること。
- **FR-005**: trace 成果物には取得時点の各実行シンボルの contentHash と、対象ファイルの相対パスを記録すること(鮮度判定の基準)。

**取り込み(scan)**

- **FR-006**: `artgraph scan` は設定された trace 成果物パス(`trace.artifacts`、spec 006 `testResultPaths` と同型の glob 配列)から trace を読み、`[REQ-NNN]` タグ付きテストのレコードを REQ に join して `exercises` エッジ(req → symbol|file)を導出すること。REQ の exercised 集合は当該 REQ の全タグ付き green テストのカバレッジの和集合とする。
- **FR-007**: カバレッジエントリからシンボルへの解決は「ファイル相対パス × 関数名」の join で行うこと。同名シンボルが同一ファイルに複数ある・関数名が無名/合成名でシンボル表に一致しない場合は、file 粒度エッジにフォールバックすること(fail-safe。fail-open 禁止)。module-init(モジュールトップレベル実行)はエッジ化しないこと。
- **FR-008**: `@impl` 宣言と exercises 証拠が同一 (req, symbol) 対で一致する場合、既存 `implements` エッジの provenances に `coverage` を追記すること。証拠のみの対は独立した `exercises` エッジとして生成し、`implements` として扱わないこと。
- **FR-009**: エッジ provenance に `coverage` を追加すること(spec 011 の型 union と runtime Set の両方。同期テスト SC-008 を更新)。
- **FR-010**: trace 成果物が存在しない場合、scan / check / impact の出力は本 spec 導入前と byte-identical であること(完全オプトイン)。
- **FR-011**: 同一の files と trace 入力に対する scan 出力は byte-identical であること(graph = f(files, trace) の決定性)。lock への永続化(exercises 由来集合)は既存 `impl`/`tests` と同じ dedupe + 辞書順ソートの byte-stable 規約に従うこと。

**check(監査・充足・鮮度)**

- **FR-012**: `check` は trace 存在時、`@impl` 主張があるが当該 REQ のタグ付き green テストが一度も当該シンボルを実行していない (req, symbol) 対を **UNEXERCISED CLAIM** として報告すること。trace 不在時はこの所見を出さないこと。
- **FR-013**: `check` は、`@impl` がなく、**正確に 1 つの REQ** からのみ実行されている(排他的 = 被 exercises REQ 数 = 1)シンボルを **SUGGESTED IMPL** として報告すること。`sharedThreshold`(既定 3)**以上**の REQ から実行されるシンボルはインフラコードとして降格し(レポートの `infrastructure` 区分)、提案・充足判定に使わないこと。REQ 数が 2 以上 `sharedThreshold` 未満のシンボルは **silent**(提案にもインフラにも現れないが、`exercises` エッジ自体はグラフに存在し impact 到達には使われる)。
- **FR-014**: 設定 `trace.acceptExercises`(既定 `false`)が有効な場合のみ、排他的 exercises エッジ(FR-013 と同定義: 被 exercises REQ 数 = 1 のシンボルへのエッジ)を 1 本以上持つ untagged REQ のカバレッジステータスを新値 `exercised` とし、uncovered 判定から除外すること。無効時は既存の三段階評価(`untagged` / `impl-only` / `verified`)を一切変更しないこと。
- **FR-015**: `check` は trace 記録時 contentHash と現在の graph の contentHash を照合し、変更されたシンボルへの exercises エッジを stale と判定すること。設定 `trace.staleness` は `warn`(既定: 報告のみ) / `exclude`(stale エッジを全判定から除外) / `gate`(`--gate` 時 exit 2)の 3 値を持つこと。
- **FR-016**: `rename` は trace 成果物内の REQ ID を spec / code / test / lock と同時に書き換えること。

**impact(到達とテスト選択)**

- **FR-017**: `impact` は `exercises` エッジを到達経路として辿り、静的経路と証拠経路の由来を出力で区別できること。stale な exercises エッジは `staleness: exclude` 時は辿らないこと。traversal は REQ→symbol の**順方向のみ**とする (逆方向は #286 で除外)。symbol→REQ の到達は `implements` 辺経由で担う。
- **FR-018**: `impact --diff --tests` は、変更シンボルを exercises している REQ のタグ付きテスト(テストファイルパス + テスト名)を列挙すること。trace 不在時は exit 1 と導入ガイダンスを出すこと。

**bootstrap / Skills**

- **FR-019**: `artgraph-bootstrap` Skill は、テストが存在する領域では「テストタイトルへの `[REQ-NNN]` 挿入 + spec 提案」のみを提案し、実装コードへの `@impl` 挿入はテスト不在領域へのフォールバックに限ること。Skill 文書に「提案 → テスト実行 → 証拠突き合わせ」の検証手順を含むこと。
- **FR-020**: `artgraph-verify` / `artgraph-impact` Skill 文書を更新し、UNEXERCISED CLAIM / SUGGESTED IMPL / stale 所見をエージェントがどう扱うべきか(修正・再実行・ユーザー確認の分岐)を定義すること。

**可視化**

- **FR-021**: `scan --serve` / `--output` は `exercises` エッジを宣言エッジと視覚的に区別して描画し(具体形は実装定義。例: 破線)、凡例に区分を追加すること。

### Key Entities

- **Trace 成果物 (TraceArtifact)**: 1 回のテスト実行(または CI シャードのマージ)から生成される正規化済み実行証拠。per-test レコード(テスト名 / ファイル / 実行シンボル集合 / pass・fail)、取得時 contentHash 表、スキーマバージョン、破棄レコードの記録を持つ。世代置き換え(append しない)。scan への**入力**であり、graph/lock とは独立のライフサイクルを持つ。
- **exercises エッジ**: req → symbol|file の新エッジ種。provenance は `coverage` のみ。「当該 REQ のタグ付き green テストが当該コードを実行した」という観測事実を表し、意図の主張(`implements`)とは独立。
- **provenance `coverage`**: spec 011 の provenance 値集合への追加。`implements` エッジ上では「裏付けられた主張」の印、`exercises` エッジ上では唯一の由来。
- **カバレッジステータス `exercised`**: `acceptExercises` 有効時のみ出現する第 4 状態。「宣言はないが排他的実行証拠がある」を表す。`exercised` は untagged REQ の**救済**であり、宣言済み REQ の評価(impl-only / verified)には影響しない(タグの有無と証拠の有無は独立軸)。
- **staleness**: exercises エッジの鮮度属性。trace 記録時 hash ≠ 現在 hash で stale。設定 3 値(`warn` / `exclude` / `gate`)で扱いが変わる。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `@impl` タグが 1 つもない brownfield プロジェクト(タグ付きテストあり)で、設定 1 行 + テスト実行 1 回 + scan 1 回の 3 手順以内に req↔code 対応が可視化される(タグゼロ・トレーサビリティの成立)。
- **SC-002**: 同一入力(files + trace)からの scan / check 出力が実行ごとに byte-identical である(決定性の維持 — 既存 INV 群と同水準)。
- **SC-003**: 「REQ のテストが実行しないコードへの `@impl`」を含む fixture で、check が当該対を UNEXERCISED CLAIM として 100% 検出する(自己申告監査の成立)。
- **SC-004**: 3 REQ 以上から実行される共有ヘルパが SUGGESTED IMPL / exercised 充足に一切現れない(既定 `sharedThreshold` でのノイズ抑制)。
- **SC-005**: runner 導入によるテストスイート実行時間の増加が 50% 以下である(PoC 実測 33% を上限バジェット化。超過時は正規化・バッチングで最適化する)。
- **SC-006**: シンボル解決できないカバレッジエントリが原因で REQ 到達が失われるケースがゼロである(常に file 粒度へフォールバック — fail-safe 検証)。
- **SC-007**: trace 不在プロジェクトにおける全コマンド出力が本 feature 導入前と完全一致する(オプトイン性の回帰ガード)。

## Assumptions

- **Vitest first**: 対応テストランナーは Vitest のみ(カスタムランナー + per-test 精密カバレッジは PoC 検証済み)。Jest / Playwright / ブラウザ実行は将来 spec(FR には含めない)。Node ランタイム上の実行のみを対象とする。
- **テストの順序独立性**: per-test 帰属の正確性はテストが順序独立であることを前提とする(Stryker `perTest` と同じ制約)。違反の検出は本 spec のスコープ外。
- **trace 成果物の置き場所**: `.artgraph/trace/` を既定とし、コミットするか CI アーティファクトとするかは利用者の運用に委ねる(init は .gitignore 追記を提案する)。lock に永続化されるのは導出済みエッジ集合のみで、raw trace は再現用入力として扱う。
- **失敗テストは証拠に数えない**(既定)。red テストのカバレッジは trace に保持するが、エッジ・充足・提案には使わない。
- **シンボル join は「パス × 関数名」**: V8 のバイトオフセットはトランスフォーム後の値のため使用しない。source-map 復元は採用しない(複雑性回避)。名前解決不能は file 粒度フォールバック。
- **単一パッケージ前提**: monorepo の複数パッケージ横断 trace は対象外(既存 scan の `include` 境界に従う)。
- **Constitution v1.1.0 の MINOR 改訂**(原則 I の導出元列挙への trace 追加、原則 III のステータス `exercised` 追加)が実装開始前に承認されること。改訂 PR は本 spec とは別に Governance 手続きで提出する。
- **段階導入**: 実装は Phase A(FR-001〜005: runner + trace 採取 + 突き合わせレポートのみ・グラフ非改変)→ Phase B(FR-006〜011, 016: scan/lock 統合)→ Phase C(FR-012〜015, 017〜020: check/impact/Skills)の順に独立レビュー可能な単位で進める。Phase A 単体でも「`@impl` と実行証拠の矛盾レポート」として価値が立つ。
