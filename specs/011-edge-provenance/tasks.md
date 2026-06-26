---

description: "Implementation tasks for GraphEdge / Lock provenance first-class (Issue #35)"
---

# Tasks: GraphEdge / Lock の provenance を first-class に持たせる

**Input**: Design documents from `specs/011-edge-provenance/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 本 feature では仕様 (SC-001..SC-008 / FR-014) でテスト生成が **明示要求** されている。各 user story にテストタスクを含める。

**Organization**: タスクは user story 単位で整理し、各 story が独立で完成・テスト可能になることを優先する。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 別ファイル・依存無しで並列実行可
- **[Story]**: `[US1]` ... `[US4]` で対応する user story を示す
- ファイルパスは `packages/artgraph/` 相対で記述

## Path Conventions

- Source code: `packages/artgraph/src/`
- Tests: `packages/artgraph/tests/`
- Test fixtures: `packages/artgraph/tests/fixtures/`
- Specs / contracts: `specs/011-edge-provenance/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 作業用ブランチを切る。新規依存・ビルド設定は不要。

- [X] T001 Create feature branch `feat/edge-provenance-issue35` (base: `main`) and switch via git checkout — **作業中の既存ブランチ `feat/provenance-to-graphedge` を流用（実質的に同等の作業範囲）。新規ブランチ作成は不要**

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 型システムの根幹を切替。これが完了するまで他全 Phase は着手できない（コンパイル不能のため）。

**⚠️ CRITICAL**: T002 完了まで他の Phase 着手不可。

- [X] T002 Update type definitions in `packages/artgraph/src/types.ts` per [contracts/edge-provenance-type.md](./contracts/edge-provenance-type.md) and [contracts/lock-schema-v2.md](./contracts/lock-schema-v2.md): (a) add `NonEmptyArray<T>` alias, (b) expand `EdgeProvenance` to 8 values `"annotation"|"frontmatter"|"convention"|"code-tag"|"task-tag"|"inline-link"|"ts-import"|"structural"`, (c) sync `EDGE_PROVENANCE_VALUES` Set, (d) replace `GraphEdge.provenance?: EdgeProvenance` with required `provenances: NonEmptyArray<EdgeProvenance>`, (e) replace `LockEntry.dependsOn?: string[]` with `dependsOn?: Array<{id: string; provenances: EdgeProvenance[]}>`.

**Checkpoint**: 型定義変更後、`pnpm -C packages/artgraph build` は当然エラーになる（全 caller が未対応）。Phase 3 以降で各ファイルを直していくことで段階的にコンパイルが通る状態に戻す。

---

## Phase 3: User Story 1 - 全 8 種類の provenance 値が付与される (Priority: P1) 🎯 MVP

**Goal**: 全 edge 生成サイトに provenances を付与し、CLI 出力で 8 種類の由来情報が露出する。

**Independent Test**: [quickstart.md](./quickstart.md) シナリオ 1（fixture `tests/fixtures/edge-provenance/all-eight/` を `artgraph graph --format json` で出力し、edge `provenances` の和集合が 8 値全部）。シナリオ 8（text 出力に `{...}` 表記）。

### Implementation for User Story 1

- [X] T003 [US1] Update `packages/artgraph/src/parsers/markdown.ts`: add `provenances: ["frontmatter"]` to frontmatter `artgraph.depends_on`/`derives_from` edges (existing lines ~217 / ~230); convert existing `provenance: "annotation"` annotation edges (~407 / ~494) to `provenances: ["annotation"]`; add `provenances: ["task-tag"]` to task preset `implementsTagRe` / `verifiesTagRe` edges (~346 / ~355).
- [X] T004 [P] [US1] Update `packages/artgraph/src/parsers/typescript.ts`: add `provenances: ["ts-import"]` to all 4 import edge sites (~170-201); add `provenances: ["code-tag"]` to `@impl` / `@verifies` / `req:` edges (~247 / ~255 / ~260).
- [X] T005 [P] [US1] Update `packages/artgraph/src/graph/builder.ts` US1 portion (excluding dedup logic): add `provenances: ["structural"]` to auto `contains` edges (~305-309); add `provenances: ["inline-link"]` to inline-link `depends_on` edges (~458-462); add `provenances: ["convention"]` to `inferConventionEdges` return (~543); ensure all edge **propagation** sites (spread/re-push at ~233, ~252, ~289, ~291) preserve `provenances` unchanged.
- [X] T006 [P] [US1] Update `packages/artgraph/src/graph/format.ts`: JSON output emits `provenances: EdgeProvenance[]` array (drop legacy `provenance` field) with element-level filter via `EDGE_PROVENANCE_VALUES`; if filtered array becomes length 0 drop the edge entirely from output. Text output: append `{provs,...}` label after kind, e.g. `└─[derives_from {convention,frontmatter}]─ <target>`. Use `[...provenances].sort()` for output determinism.
- [X] T007 [P] [US1] Create fixture `packages/artgraph/tests/fixtures/edge-provenance/all-eight/` exhibiting all 8 provenance values (per [quickstart.md](./quickstart.md) §シナリオ1 table): markdown specs + TS src + frontmatter + folder convention + task preset list + annotation + inline link + auto contains. Add minimal `.artgraph.json`. **加えて、quickstart.md §シナリオ 5 で sed が match できるよう、req の list-item 行を 1 行は `- AUTH-002: セッション` の形式（注釈なしの裸 list-item）にしておくこと**。これにより「注釈追記による gate=0」シナリオが fixture をコピー後に再現できる。

### Tests for User Story 1

- [X] T008 [P] [US1] Add tests in `packages/artgraph/tests/markdown.test.ts` for frontmatter (`["frontmatter"]`), annotation (`["annotation"]`, replacing existing single-form assertions at L1174 / L1185 / L1191 / L1197 / L1212 / L1224 / L1231 / L1237 / L1243 / L1249), task-tag (`["task-tag"]`) provenance generation. Also update any literal `GraphEdge` constructions in this file (~L600-617 / L657-662) to include `provenances: [...]`.
- [X] T009 [P] [US1] Add tests in `packages/artgraph/tests/typescript.test.ts` for code-tag (`["code-tag"]`) and ts-import (`["ts-import"]`) provenance generation. Update any literal `GraphEdge` constructions (~L168-213) to include `provenances`.
- [X] T010 [P] [US1] Add tests in `packages/artgraph/tests/builder.test.ts` for convention (`["convention"]`), structural (`["structural"]`), inline-link (`["inline-link"]`) provenance generation. Update existing annotation assertions (L927 / L933 / L940 / L983) to array form, and all literal `GraphEdge` constructions (~L711-712 / L738 / L783-785 / L893-898) to include `provenances`.
- [X] T011 [P] [US1] Add tests in `packages/artgraph/tests/graph-format.test.ts`: text output `{prov,...}` label present (INV-O1, INV-O2); JSON output emits `provenances` array length>=1 for every edge (INV-O3); legacy `provenance` field absent (INV-O4). Update literal `GraphEdge` constructions (~L70-71 / L153-155) to include `provenances`.
- [X] T012 [P] [US1] Update `packages/artgraph/tests/req-req-invariants.test.ts:235-291` (旧「provenance が不正な単一値ならば JSON 出力で省略される」): rewrite to test the **array-element-level** filter — `provenances: ["annotation", "bogus"]` becomes `["annotation"]`, while `provenances: ["bogus"]` (all invalid) drops the edge entirely. Update other assertions (L44, L60, L70, L80, L118, L138, L264, L270, L276, L282, L289, L291, L303, L314) from `e.provenance === "annotation"` to `e.provenances.includes("annotation")`.
- [X] T013 [P] [US1] Add invariant test (1 it block) in `packages/artgraph/tests/req-req-invariants.test.ts` (or new test file `provenance-invariants.test.ts`) that walks all spec/fixture-driven `buildGraph` outputs and asserts `provenances.length >= 1` for every edge (SC-007 / INV-T1 runtime check).
- [X] T014 [US1] Update remaining literal `GraphEdge` constructions in `packages/artgraph/tests/check.test.ts` (~L107-108), `packages/artgraph/tests/coverage.test.ts` (~L29-31 helper / L99-345 throughout), `packages/artgraph/tests/traverse.test.ts` (~L184-186 / L206-208 / L257-260), and `packages/artgraph/tests/helpers.ts` to include `provenances: [...]`. Pick the appropriate provenance value per edge `kind` (refer to [contracts/edge-provenance-type.md](./contracts/edge-provenance-type.md) §provenance 値の意味).
- [X] T015 [P] [US1] Add type-only assertion test — runtime size assert added as part of T013 block (SC-008/INV-T4) in `packages/artgraph/tests/req-req-invariants.test.ts` (or new `types.test-d.ts`) verifying `EdgeProvenance` union element count equals `EDGE_PROVENANCE_VALUES.size === 8` (INV-T4 / SC-008) at compile time.

**Checkpoint**: `pnpm -C packages/artgraph build` and `pnpm -C packages/artgraph test` should pass. All 8 provenance values appear in graph output. User Story 1 deliverable.

---

## Phase 4: User Story 2 - dedup 時に複数経路の由来を union 保持 (Priority: P1)

**Goal**: 同一 `(source, target, kind)` の edge が複数経路から生成されたとき、`provenances` を集合 union で統合・sort し、edge 1 本に集約する。

**Independent Test**: [quickstart.md](./quickstart.md) シナリオ 2（fixture `tests/fixtures/edge-provenance/two-paths/` で frontmatter と convention が同じ derives_from を生成 → JSON 出力に `provenances: ["convention","frontmatter"]` が現れる）。

### Implementation for User Story 2

- [X] T016 [US2] Update dedup loop in `packages/artgraph/src/graph/builder.ts` (~L495-505): replace first-seen retention with `Map`-keyed dedup that, on collision, merges `provenances` via `Array.from(new Set([...existing, ...incoming])).sort()` and reassigns to the kept edge. Maintain stable iteration over `edges` array for source-order independence (INV-T3).

### Tests for User Story 2

- [X] T017 [P] [US2] Create fixture `packages/artgraph/tests/fixtures/edge-provenance/two-paths/` per [quickstart.md](./quickstart.md) §シナリオ2: same-dir `design.md` + `requirements.md` (triggers convention) plus `design.md` frontmatter `artgraph.derives_from: [doc:specs/feature-a/requirements.md]` (triggers frontmatter). Expected `provenances: ["convention","frontmatter"]`.
- [X] T018 [P] [US2] Add tests in `packages/artgraph/tests/builder.test.ts`: (a) two-path dedup yields one edge with sorted union `["convention","frontmatter"]`; (b) repeated same-value injection (e.g. duplicate `@impl(FR-001)` in same TS file) results in `provenances: ["code-tag"]` (no duplicates, INV-T2); (c) different push-order produces identical sorted result (INV-T3). **Note**: 3 経路以上の同時 dedup は本 spec のスコープ外（[spec.md](./spec.md) §Edge Cases / §Assumptions 参照）。テストは「2 経路まで」を保証範囲とすること。
- [X] T018a [P] [US2] Add SC-004 assertion test in `packages/artgraph/tests/builder.test.ts` (or new `tests/edge-set-invariance.test.ts`): スナップショットファイル `tests/__snapshots__/edge-set-baseline.json` (旧 main の `pnpm artgraph graph --root tests/fixtures/conventions --format json` 出力から `edges.map(({source,target,kind}) => ...)` で生成) と現実装の出力を比較し、provenance フィールドを除いた `(source, target, kind)` 集合が完全一致することを assert する。baseline は実装開始時の main コミットで `node -e 'const j=require("./out.json"); console.log(JSON.stringify(j.edges.map(e=>({source:e.source,target:e.target,kind:e.kind})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))), null, 2))'` で生成する。

**Checkpoint**: dedup union が機能、INV-T2/T3 が runtime テストで確認される。SC-004（edge 集合不変）も baseline 比較で担保。

---

## Phase 5: User Story 3 - lock の dependsOn が `{id, provenances}` 構造 (Priority: P1)

**Goal**: `.trace.lock` の `dependsOn` を構造化し annotation 由来も書き出す。決定性確保（id 昇順、provenances 昇順、バイト一致）。

**Independent Test**: [quickstart.md](./quickstart.md) シナリオ 3 (2 回 reconcile のバイト一致), シナリオ 4 (`dependsOn[i].provenances` 形式), シナリオ 5 (注釈追記で `check --gate` exit=0).

### Implementation for User Story 3

- [X] T019 [US3] Update `packages/artgraph/src/lock.ts:buildLockFromGraph` (~L41-100): remove `provenance !== "annotation"` filter (~L80-91); change `dependsOn` construction to `Array<{id, provenances}>` where `provenances = [...edge.provenances].sort()`; sort `dependsOn` array by `id` ascending (INV-L1/L2/L3/L4). Update doc comment to remove obsolete `"#35 will redesign"` note and add pointer to [contracts/lock-schema-v2.md](./contracts/lock-schema-v2.md).

### Tests for User Story 3

- [X] T020 [P] [US3] Update `packages/artgraph/tests/lock.test.ts` (~L49-87) for new schema: literal `GraphEdge` constructions include `provenances`; assertions on `entry.dependsOn` change from `string[]` to `{id, provenances}[]`; add round-trip determinism test (build → JSON.stringify → build again → assert identical, SC-003 / INV-L4); add tests asserting annotation-only `dependsOn` requirements (no longer excluded).
- [X] T021 [P] [US3] Update existing `.trace.lock` fixtures to the new schema. **対象 fixture（事前に `grep -rl '"dependsOn"' packages/artgraph/tests/fixtures/` で確認、本 commit 時点で該当するもののみ）**: 既存の `packages/artgraph/tests/fixtures/rename/.trace.lock`（`"dependsOn": ["REQ-001"]` → `"dependsOn": [{"id":"REQ-001","provenances":["frontmatter"]}]`）。`tests/fixtures/all-verified/` や `tests/fixtures/conventions/` 等の他 fixture は **`.trace.lock` を含まないため対象外**（reconcile を実行することで動的に生成されるテストのみ）。grep で他に hit したものがあれば追加で対応。 provenance の値は当該 edge が **本来生成される経路**（先行 spec で frontmatter 由来として定義されているか、convention 由来か）に従って選択する — 元 fixture のテスト意図と矛盾しないよう commit 前に元のテストファイル `tests/rename*.test.ts` の期待値で確認。
- [X] T022 [P] [US3] Update `packages/artgraph/tests/check.test.ts` (~L33-108): assertions on lock structure use new schema; add a test that asserts注釈追記による lock churn は `contentHash` 比較に影響せず `check --gate` が exit=0 を返す (SC-006).
- [X] T023 [P] [US3] Update `packages/artgraph/tests/coverage.test.ts` assertions (any direct lock structure inspection) for new schema; literal `GraphEdge` constructions for `provenances` are already covered by T014 but verify nothing slipped through.
- [X] T024 [P] [US3] Update `packages/artgraph/tests/traverse.test.ts` (~L69 / L183-260): the lock-reading code path uses only `contentHash` so behavior is unchanged, but verify literal edge constructions all include `provenances`.

**Checkpoint**: lock schema が新形式で書き出され、annotation も含まれ、2 回 reconcile でバイト一致が取れる。

---

## Phase 6: User Story 4 - rename 後も `dependsOn` の `provenances` が維持される (Priority: P2)

**Goal**: `artgraph rename OLD NEW` が lock の `dependsOn` 配列内の `id` のみ書換、`provenances` 配列は破壊しない。

**Independent Test**: [quickstart.md](./quickstart.md) シナリオ 6 (`AUTH-001 → AUTH-100` 後、`provenances: ["annotation"]` が完全維持される).

### Implementation for User Story 4

- [X] T025 [US4] Update `packages/artgraph/src/rename-lock.ts:updateReferences` (~L40-67): rewrite `updated.dependsOn = updated.dependsOn.map(ref => ref === oldId ? newId : ref)` to operate on `{id, provenances}` objects (only `id` field is rewritten when matched). Apply id-ascending sort at the end (INV-L1).
- [X] T026 [US4] Update `packages/artgraph/src/rename-lock.ts:mergeLockKeys` (~L174-197): the union of `dependsOn` arrays during key merge must union by `id` and union `provenances` within colliding `id`s (use Set semantics + sort). Update related helpers (`expandReferences` ~L62-66) for new schema.

### Tests for User Story 4

- [X] T027 [P] [US4] Add tests in `packages/artgraph/tests/rename.test.ts` (~L401-634 update + new ones): (a) single rename preserves `provenances` array exactly (order, contents); (b) `mergeLockKeys` unions `provenances` correctly; (c) re-run scan after rename produces identical `.trace.lock` (no churn from rename).
- [X] T028 [P] [US4] Update `packages/artgraph/tests/rename-cli.test.ts` (~L125 / L244 / L330): existing assertions on `JSON.parse(...).dependsOn` change to handle new `{id, provenances}` shape.

**Checkpoint**: rename 後の lock が新 schema を保持し、`provenances` が破壊されない。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: ドキュメント整合・既存 spec の pointer 追記・最終 quickstart 検証。

- [X] T029 [P] Append pointer to `specs/010-req-req-dependency/contracts/provenance-field.md` (after §「#35 解決時の想定変更」section): note that #35 is resolved in `specs/011-edge-provenance/`, link to this spec's `contracts/edge-provenance-type.md` / `contracts/lock-schema-v2.md`. Do not rewrite the 010 doc body.
- [X] T030 [P] Search-and-clean code comments in `packages/artgraph/src/lock.ts` (~L81-91 comment block was already touched in T019), `packages/artgraph/src/types.ts` (~L11-15 EdgeProvenance comment), `packages/artgraph/src/parsers/markdown.ts` if any comments still say `"#35 will redesign"` — replace with neutral pointers to `specs/011-edge-provenance/`.
- [X] T031 [P] Run the quickstart validation manually: execute all 8 scenarios in [quickstart.md](./quickstart.md) and tick the checklist; capture any deviation as a follow-up bug.
- [X] T032 Run full test suite (`pnpm -C packages/artgraph test`) and lint (`pnpm -C packages/artgraph lint`) end-to-end. Fix any regression. Confirm `pnpm -C packages/artgraph build` produces no warnings.
- [X] T033 [P] Update `README.md` (`docs/spectrace-design.md` if it documents provenance) with brief mention of the new `provenances` field and 8-value vocabulary, linking back to this spec.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし、即開始可
- **Foundational (Phase 2)**: Setup 完了後。**全 US の前提条件**
- **US1 (Phase 3)**: Foundational 完了後
- **US2 (Phase 4)**: Foundational 完了後（US1 と並列可能だが、US1 の builder.ts 変更 T005 と US2 の T016 は同ファイル）
- **US3 (Phase 5)**: Foundational 完了後（US1/US2 完了が望ましいが、独立着手可能 — provenances が populate されていなくても lock 形状テスト自体は可能）
- **US4 (Phase 6)**: US3 完了後（lock 新 schema が前提）
- **Polish (Phase 7)**: US1-US4 完了後

### User Story Dependencies

- **US1 (P1)**: Foundational 完了後すぐ
- **US2 (P1)**: Foundational 完了後すぐ。ただし T005 と T016 は同じ `builder.ts` を編集するため US1 の T005 を先に完了させること
- **US3 (P1)**: Foundational 完了後すぐ。US1/US2 が完了済だと「実際に annotation を含む lock」のテストがしやすくなる
- **US4 (P2)**: US3 完了が必須（新 lock schema が前提）

### Within Each User Story

- 実装タスク → テストタスクの順を推奨（実装が確認できてからテスト assert）
- 同じファイルを編集するタスクは順次（[P] マークなし）
- 別ファイル・別 fixture を扱うタスクは [P] 並列可

### Parallel Opportunities

- T002 単独で Phase 2 完了
- US1 内: T003 / T004 / T005 / T006 / T007 は別ファイル群なので並列可（[P] 付き）。T008-T013 / T015 のテストも別ファイル群で並列可。T014 は複数 test ファイルへの一括書換のため逐次。
- US2 内: T016 完了後 T017 / T018 は並列可
- US3 内: T019 完了後 T020 / T021 / T022 / T023 / T024 は並列可
- US4 内: T025 / T026 完了後 T027 / T028 並列可
- Polish 内: T029 / T030 / T031 / T033 並列可、T032 は最後

---

## Parallel Example: User Story 1

```bash
# T002 (Foundational) 完了後、以下を並列で進める:
Task: "T003 [US1] markdown parser に frontmatter/annotation/task-tag provenance 付与"
Task: "T004 [US1] typescript parser に code-tag/ts-import provenance 付与"
Task: "T005 [US1] builder の convention/structural/inline-link 付与"
Task: "T006 [US1] format.ts の出力 schema 変更"
Task: "T007 [US1] fixtures/edge-provenance/all-eight/ 作成"

# 実装完了後、テストを並列:
Task: "T008 [US1] markdown.test.ts 拡張"
Task: "T009 [US1] typescript.test.ts 拡張"
Task: "T010 [US1] builder.test.ts 拡張"
Task: "T011 [US1] graph-format.test.ts 拡張"
Task: "T012 [US1] req-req-invariants.test.ts 書換"
Task: "T013 [US1] NonEmptyArray invariant 追加"
Task: "T015 [US1] 型レベル assertion 追加"
```

---

## Implementation Strategy

### MVP First (User Story 1 のみ)

1. Phase 1 (Setup) 完了
2. Phase 2 (Foundational) 完了 — CRITICAL
3. Phase 3 (US1) 完了 → CLI が 8 種類の provenance を露出する状態
4. **STOP and VALIDATE**: [quickstart.md](./quickstart.md) §シナリオ1, 8 を手動実行
5. 単独でも価値が成立（debugging 体験改善）

### Incremental Delivery

1. Setup + Foundational → 型基盤
2. US1 → 全 8 provenance 露出 → Demo（MVP）
3. US2 → 複数経路 union → Demo
4. US3 → lock 構造化 → Demo
5. US4 → rename 追従 → Demo
6. Polish → 完了

### Parallel Team Strategy

複数開発者でも実質的に T002 は一人作業（types.ts 1 ファイル）。それ以降:

- Dev A: US1 (生成サイト＋format)
- Dev B: US2 (dedup union)
- Dev C: US3 (lock schema)
- 全員揃ったら US4 → Polish

US1 と US2 は `builder.ts` で衝突するため、片方が先行完了する想定。US3 は独立。

### Single-PR vs Multi-PR

未リリース・後方互換不要のため、全 Phase を **単一 PR** で提出可能。PR 規模を抑えたい場合は (a) Foundational + US1, (b) US2 + US3, (c) US4 + Polish の3分割が現実的。

---

## Notes

- **Tests are explicitly requested** (SC-001..SC-008, FR-014 相当)
- 同じファイル編集タスクは [P] を付けない
- 各 fixture は最小構成で `quickstart.md` のシナリオに対応させる
- Polish T032 で `pnpm test` / `pnpm lint` / `pnpm build` 全 green を担保
- 任意のチェックポイントで停止して story 単独で deliverable を出せる
