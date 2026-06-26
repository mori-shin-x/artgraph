# Feature Specification: GraphEdge / Lock の provenance（由来）を first-class に持たせる

**Feature Branch**: `feat/edge-provenance-issue35`

**Created**: 2026-06-26

**Status**: Draft

**Input**: artgraph のグラフモデルにおいて、`GraphEdge` の「由来」（手書き frontmatter／フォルダ規約推論／インライン注釈／コードタグ／インラインリンク／TS import／構造的派生）を識別可能なメタデータとして必須化する。lock 出力にも由来を保持し、CLI で「なぜこのエッジが存在するか」が説明できる状態にする。関連 Issue: #35。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 由来別に依存エッジが見える (Priority: P1)

開発者が `artgraph graph` を実行したとき、各 `derives_from` / `depends_on` / `implements` / `verifies` / `contains` / `imports` エッジに「どの仕組み（frontmatter / フォルダ規約 / インラインリンク / コードタグ / インライン注釈 等）から生成されたか」が付随情報として表示される。これにより「予想外の依存」を見つけたときに、それが手書き宣言か自動推論かを即座に切り分けられる。

**Why this priority**: Issue #35 が解決したい中心課題（再現性・説明性）。これ単独で MVP として価値が成立し、debugging 体験が改善する。後続シナリオ全ての前提でもある。

**Independent Test**: フォルダ規約推論された `tasks→design` エッジと、frontmatter で `derives_from: [design.md]` と明示宣言されたエッジを同居させた fixture を作り、`artgraph graph --format json` の出力でそれぞれが `provenances: ["convention"]` / `provenances: ["frontmatter"]` を持って区別できることを確認する。

**Acceptance Scenarios**:

1. **Given** フォルダ規約 (`design.md` / `requirements.md` 同ディレクトリ) で推論された derives_from エッジがある, **When** `artgraph graph --format json` を実行, **Then** 当該エッジに `provenances: ["convention"]` が含まれる
2. **Given** frontmatter `artgraph.depends_on: [doc:other.md]` 由来のエッジがある, **When** 同コマンドを実行, **Then** 当該エッジに `provenances: ["frontmatter"]` が含まれる
3. **Given** インライン注釈 `(depends_on: AUTH-001)` 由来の req→req エッジがある, **When** 同コマンドを実行, **Then** `provenances: ["annotation"]` が含まれる
4. **Given** Markdown 本文中のインラインリンク `[design](./design.md)` 由来の `depends_on` エッジ, **When** 同コマンドを実行, **Then** `provenances: ["inline-link"]` が含まれる
5. **Given** TS の `import` 文由来の `imports` エッジ, **When** 同コマンドを実行, **Then** `provenances: ["ts-import"]` が含まれる
6. **Given** TS の `// @impl FR-001` 由来の `implements` エッジ, **When** 同コマンドを実行, **Then** `provenances: ["code-tag"]` が含まれる
7. **Given** Markdown タスク `- T001 [REQ-001]` 由来の `verifies`/`implements` エッジ, **When** 同コマンドを実行, **Then** `provenances: ["task-tag"]` が含まれる
8. **Given** doc → 子 req を `contains` で自動接続したエッジ, **When** 同コマンドを実行, **Then** `provenances: ["structural"]` が含まれる

---

### User Story 2 - 複数経路で同じエッジが生成されたとき由来を保持する (Priority: P1)

開発者が「frontmatter で明示宣言したエッジが、たまたまフォルダ規約推論と同じ `(source, target, kind)` を指す」状況に遭遇する。このとき両方の由来が `provenances` 配列に統合されて保持され、後から「規約推論を切ったらこのエッジは消えるのか／残るのか」を判断できる。

**Why this priority**: Issue 本文と PR #33 レビューが直接挙げた論点。dedup で由来情報が失われる現状を解消しないと US1 で「由来1つだけ表示」されてしまい、`autoConventions: false` 制御の意味論が壊れる。

**Independent Test**: 同ディレクトリの `design.md` と `requirements.md` を用意し、`design.md` の frontmatter に `artgraph.derives_from: [doc:requirements.md]` を明示宣言する。これでフォルダ規約推論と frontmatter 宣言が同じ `derives_from` エッジを生成する。`artgraph graph --format json` の当該エッジが `provenances: ["convention", "frontmatter"]`（順序は決定的）を持つことを確認する。

**Acceptance Scenarios**:

1. **Given** 同じ `(source, target, kind)` を frontmatter と convention が独立に生成, **When** scan, **Then** 結果のエッジは 1 本に統合され `provenances` に両方の値が含まれる
2. **Given** 同じ provenance が複数回追加される経路（例: 同 `@impl(FR-001)` が同ファイル内で 2 回出現）, **When** scan, **Then** `provenances` 配列に同じ値が重複しない
3. **Given** 同じ `(source, target, kind)` を 3 経路以上が生成しうる仮想ケース, **When** scan, **Then** `provenances` に含まれる順序は実装順序ではなく決定的順序（昇順 sort）になる

---

### User Story 3 - lock ファイルの dependsOn から由来が辿れる (Priority: P1)

開発者が `.trace.lock` を VCS にコミットして PR レビューで参照したとき、各 `dependsOn` 要素が単なる ID 文字列ではなく `{id, provenances}` 形式で記録されている。これにより「この依存はフォルダ規約由来だから、規約をやめれば消えるはず」「これは手書き宣言だから残すべき」がレビュー段階で判定できる。

**Why this priority**: Issue 本文の「lock / impact 出力で『なぜこのエッジがあるのか』を辿れない」を直接解消する。US1 と独立してテスト可能だが、由来表示の信頼性は同じ。

**Independent Test**: frontmatter / convention / annotation / inline-link 由来のエッジを含む fixture から lock を生成し、各 `dependsOn` 要素が `{id: string, provenances: [...]}` 形式で書かれ、想定の provenance 値を含むことを確認。続けてもう一度 scan して lock の内容がバイト一致することを確認（決定性）。

**Acceptance Scenarios**:

1. **Given** convention 由来のエッジが lock に乗っている, **When** `.trace.lock` を読む, **Then** 該当 `dependsOn` 要素は `{id: "...", provenances: ["convention"]}` 形式である
2. **Given** annotation 由来のエッジ（旧仕様では除外されていた）が lock に乗っている, **When** `.trace.lock` を読む, **Then** `dependsOn` 要素として `{id: "...", provenances: ["annotation"]}` が含まれる
3. **Given** 2 回連続で scan を実行, **When** 2 回目の lock を 1 回目と比較, **Then** バイト単位で一致する（`dependsOn` の id 昇順 + 各 provenances 昇順）
4. **Given** 注釈を追記しただけ（req の本文と contentHash は不変）, **When** `artgraph check --gate` を実行, **Then** drift 判定は contentHash 比較なので gate は通る（lock の `dependsOn` 変動は gate 失敗を引き起こさない）

---

### User Story 4 - rename で lock の dependsOn 要素も追従する (Priority: P2)

開発者が `artgraph rename AUTH-001 AUTH-100` を実行したとき、lock の `dependsOn` 配列の各要素のうち `id === "AUTH-001"` のものが `id === "AUTH-100"` に書き換わり、各要素の `provenances` 配列は破壊されずに維持される。

**Why this priority**: US1/2/3 完成後の使用感に直結する。これが無いと rename 後に lock が手で直せず、結果として「scan で生成された lock と rename で書換えた lock の差」を生み出す。

**Independent Test**: `{id: "AUTH-001", provenances: ["frontmatter"]}` を含む lock を作成 → `artgraph rename AUTH-001 AUTH-100` 実行 → 該当要素が `{id: "AUTH-100", provenances: ["frontmatter"]}` になっていることを確認。

**Acceptance Scenarios**:

1. **Given** lock の `dependsOn` に `{id: "AUTH-001", provenances: ["frontmatter"]}` が含まれる, **When** `artgraph rename AUTH-001 AUTH-100` を実行, **Then** 要素は `{id: "AUTH-100", provenances: ["frontmatter"]}` に書き換わる
2. **Given** 同じ rename を実行, **When** `provenances` を確認, **Then** rename 前後で `provenances` 配列の中身は完全に同一（順序含む）

---

### Edge Cases

- **不正な provenance 値が入力に混入**: 既知 8 値以外（型を bypass した外部 JSON、forward-incompatible payload 等）が `format.ts` のシリアライズ層に到達した場合、当該値だけを配列から除外する。残りの provenances が空配列になる場合は、エッジごと JSON 出力から除外する（NonEmptyArray invariant を守る）。
- **空 `provenances` の混入**: 型レベル（NonEmptyArray tuple）で防止する。仮に外部入力で混入した場合は format.ts でエッジを drop する。
- **同 `@impl(FR-001)` が同ファイル内で 2 回**: dedup で 1 本に統合され、`provenances` は `["code-tag"]` のみ（重複しない）。
- **3 経路 (frontmatter+convention+inline-link) で同一エッジ**: 現アーキでは `builder.ts` の `explicitPairs` ロジックにより inline-link は frontmatter/convention が存在する場合 suppress されるため発生しない。本仕様では「2 経路まで合流する」を保証する（3 経路は仕様の対象外）。
- **`autoConventions: false` 設定下**: convention 由来エッジは生成されないので、`provenances` に `"convention"` を含むエッジはグラフに現れない。frontmatter で同じエッジが宣言されていれば `provenances: ["frontmatter"]` のみで残る。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST グラフ内の全 `GraphEdge` に対し、由来情報を保持する `provenances` フィールドを必ず 1 要素以上で持たせる。
- **FR-002**: System MUST 由来情報の値域として 8 種類を提供する: `annotation` / `frontmatter` / `convention` / `code-tag` / `task-tag` / `inline-link` / `ts-import` / `structural`。
- **FR-003**: System MUST `provenances` フィールドの型を非空配列（`NonEmptyArray<EdgeProvenance>`）として、空配列状態を型レベルで禁止する。
- **FR-004**: System MUST 同一 `(source, target, kind)` のエッジが複数経路から生成された場合、それらを 1 本のエッジに統合し、`provenances` を集合 union で保持する（同じ provenance 値は重複しない）。
- **FR-005**: System MUST `provenances` 配列の最終的な順序を実装順序非依存（決定的、昇順 sort）にする。
- **FR-006**: System MUST 旧 `provenance` 単数オプショナルフィールドへの依存を src/tests から完全に除去する（未リリースのため後方互換シムは設けない）。
- **FR-007**: System MUST `artgraph graph --format json` の edge 出力で `provenance` 単数フィールドを廃止し、`provenances` 配列フィールドのみを出力する。
- **FR-008**: System MUST `artgraph graph` の text 出力で各エッジに provenance を併記する（例: `└─[derives_from {convention,frontmatter}]─`）。
- **FR-009**: System MUST `.trace.lock` の `LockEntry.dependsOn` を `Array<{id: string; provenances: EdgeProvenance[]}>` 構造で書き出す。
- **FR-010**: System MUST lock 書き出し時に `dependsOn` の各要素を `id` 昇順 sort し、各要素の `provenances` も昇順 sort する（決定性確保）。
- **FR-011**: System MUST `buildLockFromGraph` から旧 `provenance !== "annotation"` フィルタを撤去し、annotation 由来エッジも lock に書き出す。
- **FR-012**: System MUST `impl` / `tests` フィールドは現状の `string[]` 形式を維持する（実運用で provenances が事実上 `["code-tag"]` のみのため構造化のコストに見合わない）。
- **FR-013**: System MUST `artgraph rename OLD NEW` 実行時、lock の `dependsOn` 配列の各要素について `id === OLD` のものを `id === NEW` に書き換え、`provenances` を破壊しない。
- **FR-014**: System MUST `format.ts` の JSON 出力レイヤで、`provenances` 配列の各要素を既知の `EDGE_PROVENANCE_VALUES` 集合でフィルタする。フィルタ後 0 件となった場合、当該エッジ自体を出力から除外する（NonEmptyArray invariant 維持）。
- **FR-015**: System MUST 全 8 種類の provenance 値ごとに、その値が付与される対象エッジ生成箇所を厳密に定義する（マッピング表は [data-model.md](./data-model.md) §「エンティティ関係図」および [contracts/edge-provenance-type.md](./contracts/edge-provenance-type.md) §「provenance 値の意味」を normative source とする）。
- **FR-016**: System MUST `EDGE_PROVENANCE_VALUES` ランタイム集合を `EdgeProvenance` 型 union と完全同期で 8 要素にする。

### Key Entities

- **EdgeProvenance**: エッジ生成経路を表す列挙値。値域は 8 要素: `annotation` / `frontmatter` / `convention` / `code-tag` / `task-tag` / `inline-link` / `ts-import` / `structural`。
- **GraphEdge (改訂)**: 既存の `source` / `target` / `kind` に加え、必須の `provenances: NonEmptyArray<EdgeProvenance>` を持つ。
- **LockEntry (改訂)**: 既存の `contentHash` / `lastReconciled` / `specFile` / `impl` / `tests` に加え、`dependsOn?: Array<{id: string; provenances: EdgeProvenance[]}>` を持つ（従来の `dependsOn?: string[]` から構造変更）。
- **NonEmptyArray<T>**: 型エイリアス `readonly [T, ...T[]]`。「1 要素以上」を型レベルで保証する用途で `provenances` に使用。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 全 8 種類の provenance 値について、それぞれの値が付与される最小ケース fixture と単体テストが揃い、CI で 100% 検証される。
- **SC-002**: `artgraph graph --format json` の出力に対し、`provenance`（単数）フィールドが現れる箇所がゼロ件、`provenances`（複数）フィールドが全エッジで `length >= 1` を満たす。
- **SC-003**: `.trace.lock` を生成 → 同じ入力で再生成したとき、2 つのファイルがバイト単位で一致する（決定性）。
- **SC-004**: 既存の req 本文 / TS コード / Markdown 構造を一切変えない fixture セットに対し、provenance 化実装を入れる前後でグラフ上のエッジの `(source, target, kind)` 集合が変化しないこと（dedup union が edge 集合の意味を変えない）。
- **SC-005**: `artgraph rename OLD NEW` 実行後、lock の `dependsOn` 配列の各要素について、対象 ID が新値に書き換わり、`provenances` 配列の中身（順序含む）が rename 前と完全一致する。
- **SC-006**: `artgraph check --gate` の判定は依然として contentHash 比較のみに依存し、注釈追記（本文不変）だけでは gate 失敗を引き起こさない（lock の `dependsOn` は変動しうるが、それが gate 失敗の理由になってはならない）。
- **SC-007**: `buildGraph` の全テスト fixture を走査する 1 本の invariant テストが、生成された全エッジについて `provenances.length >= 1` を満たすことを確認する。
- **SC-008**: `EdgeProvenance` 型 union と `EDGE_PROVENANCE_VALUES` ランタイム集合の要素数が一致することを確認する型レベルテスト（コンパイル時 assertion）が CI に含まれる。

## Assumptions

- 本プロダクトは未リリースのため、`.trace.lock` フォーマットの後方互換性は維持しない。既存環境にある `.trace.lock` は新 schema で再生成される（migration スクリプトは提供しない）。
- 3 経路以上での同一エッジ生成は現アーキ（`builder.ts:explicitPairs` での inline-link suppression）では発生しないため、本仕様は「2 経路まで合流する」を保証範囲とする。3 経路同時 dedup の仕様化は将来別 issue で扱う。
- `artgraph graph --provenance` のような provenance ベースフィルタフラグの追加は本 feature のスコープ外。必要になれば別 issue を切る。
- `EdgeKind` 自体の変更は行わない。既存の `depends_on` / `derives_from` / `implements` / `verifies` / `imports` / `contains` を再利用する。
- `impl` / `tests` の構造化は cost-benefit 上見送る（事実上 `code-tag` のみで運用される。markdown task 由来は `lock.ts:64-69` で既に除外済み）。
- 注釈追記による lock churn は許容する（PR レビューでは目視されうるが、`check --gate` は contentHash 比較のため通る）。決定的 sort で churn の表現を最小化する。
- 先行 spec `specs/010-req-req-dependency/contracts/provenance-field.md` で言及された「#35 解決時の想定変更」は本 feature の作業範囲で正式化する。010 側の contract は historical record として保持し、本 spec への pointer を追記する。
