# Tasks: re-export の per-symbol 精度 (`export *` / `export * as ns` / imported identifier)

**Feature**: `specs/018-reexport-symbol-precision/` | **Branch**: `feat/issue-179-188`

**Input**: design.md / spec.md / plan.md

## 進め方 (as-built)

本 spec は **実装後に as-built で記述** している (Phase 1 = 306c69d、Phase 2 = 3056dc2、formerly PR #201 が force-push で superseded)。全 task は既に完了状態 `[X]`、`Files:` breadcrumb は実 commit で touch したファイルを反映。各 task は `[REQ-018-NNN]` marker で spec.md の Requirements と紐付ける。

## Format: `[ID] [P?] [Story] Description [REQ-018-NNN]`

## Path Conventions

単一パッケージ CLI。実装は `src/`、テストは `tests/`、docs は `docs/` / `CHANGELOG.md` / `specs/018-reexport-symbol-precision/`。

---

## Phase 1: Design & 敵対的レビュー反映 (完了)

- [X] **T1** design doc 追加: #179 と #188 を単一設計に統合。§1 背景 / §2 ゴール / §3 layer 割り当て / §4 contentHash SSOT / §5 S1 展開アルゴリズム / §6 S2/S3 parser 実装 / §7 shadowing・曖昧性・fail-safe / §8 キャッシュ・lock 不変条件 / §9 下流影響 / §10 既知の制限 / §11 テスト計画 / §12 変更ファイル一覧。
  Files: `specs/018-reexport-symbol-precision/design.md`
  Commit: `392768b` — docs(specs): #179+#188 統合設計 (re-export per-symbol 精度) の design doc を追加
  [REQ-018-001, REQ-018-002, REQ-018-003, REQ-018-004, REQ-018-005, REQ-018-006, REQ-018-007, REQ-018-008, REQ-018-009, REQ-018-010]

- [X] **T2** 敵対的レビュー major 4 件を design.md に反映: (a) starMap dedup を §5 冒頭に明記 + T18 追加、(b) 条件付きメモ化を必須化 (§5 末尾 + T20 追加)、(c) S3 bare specifier ガード (§6 の「実体化の前提ガード」+ T19)、(d) T17 refactor 等価性 (§4 pin)。
  Files: `specs/018-reexport-symbol-precision/design.md`
  Commit: `0f2c801` — docs(specs): 018 design に敵対的レビュー findings を反映
  [REQ-018-005, REQ-018-006, REQ-018-007]

---

## Phase 2: SSOT hash helper (完了)

- [X] **T3** `synthReexportHash(targetRel, originBinding, exportedName)` を parser 側の SSOT ヘルパーとして導入。#177 の既存 named re-export 生成箇所を helper 呼び出しに置き換え、S1/S2/S3 の合成 node がすべて同じ関数で hash を生成することを保証 (design §4)。既存 lock hash bytes は不変 (`hash([targetRel, originBinding, exportedName].join("\0"))` の入力は同じ)。
  Files: `src/parsers/typescript.ts`
  Commit: `1dbb016` — feat(parser): synthReexportHash SSOT helper を追加 (specs/018 §4)
  [REQ-018-007]

---

## Phase 3: Parser + parse-cache + star-expansion pure module (完了 — MVP)

- [X] **T4** parser に `importBindings` 1 pass 前処理を追加。`ImportDeclaration` の specifier 種別から `Map<localName, { specifier, binding: "default" | "*" | { name } }>` を組み立てる (design §6 冒頭)。`import type` も同扱い (D5)。
  Files: `src/parsers/typescript.ts`
  [REQ-018-003, REQ-018-004]

- [X] **T5** [US2] S2 実体化: `ExportAllDeclaration` で `exported` 非 null (`export * as ns`) のとき、既存 file-grain edge に**加えて** `symbol:B#ns` node + `symbol:B#ns → file:O` edge を実体化 (design §6)。`exportKind: "type"` の場合、`moduleExportName` の string literal も同扱い (T14)。
  Files: `src/parsers/typescript.ts`
  [REQ-018-002, REQ-018-007]

- [X] **T6** [US1] `starExports?: string[]` side-channel を parser で emit: plain `export *` (`exported` null) のとき解決済み rootDir-relative ターゲットを宣言順で `ParsedTS` / `TsFragment` に添付。空なら省略 (design §3 の "S1 の情報伝搬" ブロック)。symbol mode の非 test ファイルのみ記録。
  Files: `src/parsers/typescript.ts`
  [REQ-018-001, REQ-018-008]

- [X] **T7** [US2] S3-C4 (source-null `ExportNamedDeclaration`): specifier の local 名が local decl に無く (`localSymbolIds` に `symbol:B#exported` が無く) `importBindings` にヒットする場合、design §4 表どおり実体化 (aliased / namespace / default 全 6 行)。**実体化の前提ガード** — specifier が相対 (`"."` 始まり) + `resolveRelativeImport` 解決成功のみ (bare specifier / 解決失敗は skip、T19)。
  Files: `src/parsers/typescript.ts`
  [REQ-018-004, REQ-018-007]

- [X] **T8** [US2] S3-C3 (`ExportDefaultDeclaration`, Identifier): declaration が Identifier で local decl lookup がミスし `importBindings` にヒットする場合、`symbol:B#default` を実体化。前提ガードは T7 と同じ。`extractSymbols` 側 (L484-488 の skip) は変更しない (解決コンテキストを持つ `extractImports` に集約, design §6)。
  Files: `src/parsers/typescript.ts`
  [REQ-018-003, REQ-018-007]

- [X] **T9** parse-cache: `TsFragment.starExports?: string[]` を型に追加。`SCHEMA_VERSION` を 3 → 4 に bump し、旧 cache を cold invalidate (design §8)。`importTargetsExist` は変更不要 (S3 edge の `symbol:m#x` target は既存 rel 抽出ロジックがそのまま効く、plain `export *` は file-grain edge が fragment に残るので O 削除は既存 existsSync 検証で fragment 無効化)。
  Files: `src/parse-cache.ts`
  [REQ-018-008, REQ-018-010]

- [X] **T10** [US1] `src/graph/star-expansion.ts` を pure module として新規実装: `expandStarReexports(nodes, starMap)` を export。ES 仕様 `GetExportedNames` / `ResolveExport` に沿った再帰 (design §5 の pseudo-code)。手順: (1) `resolve(F, name, stack)` — default 除外 / ownNames 優先 / 循環カット / providers dedup / ambiguous 伝播 / 単一 provider 決定、(2) `exportedNames(F, visited)` — ownNames + starMap 再帰の union (default 除外)、(3) barrel を rel path 昇順・name 昇順で走査し `exportedNames \ ownNames` を実体化。**条件付きメモ化** — (F, name) 単位、循環カットに触れなかった結果のみキャッシュ (diamond DAG の O(2^k) 爆発防止)。
  Files: `src/graph/star-expansion.ts`
  [REQ-018-001, REQ-018-005, REQ-018-006]

- [X] **T11** [P] [US1] `tests/star-expansion.test.ts` を新規作成: pure module の直接 unit test (循環 A↔B、diamond DAG 積層、ambiguous drop、多段チェーン、default 除外、shadowing、starMap dedup)。決定的 fixture で生成 (T20)。
  Files: `tests/star-expansion.test.ts`
  [REQ-018-005, REQ-018-006]

- [X] **T12** [P] [US1,US2] `tests/barrel-reexport.test.ts` に §11 T1〜T19 の該当節を追加: T1 (S1 基本) / T2 (多段) / T3 (循環) / T4 (default 除外) / T5 (shadowing) / T6 (named prevail over star) / T7 (ambiguous) / T8 (S2) / T9 (S3-C3) / T10 (S3-C4 refactor 等価性) / T11 (S3 各行) / T14 (`export type * ` / string literal) / T15 (fatal syntax) / T16 (warm 更新) / T17 (S1 refactor 等価性) / T18 (targetRel dedup) / T19 (S3 bare specifier)。
  Files: `tests/barrel-reexport.test.ts`
  [REQ-018-001, REQ-018-002, REQ-018-003, REQ-018-004, REQ-018-005, REQ-018-006, REQ-018-007]

**Commit (Phase 3 = MVP)**: `5f5ce51` — feat(parser,builder): re-export の per-symbol 精度 Phase 1 (specs/018)

**Checkpoint**: S2 / S3 (parser 側) + starExports side-channel + star-expansion pure module (単体 build 可能) + regression テストが実装済。builder 結線は Phase 4 で。

---

## Phase 4: Builder 結線 + 統合テスト + docs (完了)

- [X] **T13** [US1] `src/graph/builder.ts` に star expansion パスを結線: 全 fragment の `starExports` を集約して `starMap` (targetRel で dedup、初出順保持) を構築、TS edge 取り込み (現 L371-395) の**直後** / phantom-repair パス (現 L409) の**前**に `expandStarReexports(nodes, starMap)` を呼ぶ。展開で実体化された node は repair の「dangling 判定」から自然に外れる (design §5 挿入位置)。
  Files: `src/graph/builder.ts`
  [REQ-018-001, REQ-018-008, REQ-018-009]

- [X] **T14** [US1,US2] `docs/architecture.md` に §11 (or 該当節) の説明追加: S1/S2/S3 の layer 割り当て (parser / builder)、`synthReexportHash` SSOT、fragment 純粋性から一意に決まる展開層の分割。#177 との連続性を明示。
  Files: `docs/architecture.md`
  [REQ-018-001, REQ-018-002, REQ-018-003, REQ-018-004, REQ-018-007]

- [X] **T15** [US1,US2] `docs/skills-guide.md` の barrel 越し drift 追跡セクションを更新: post-018 で consumer の `import { x } from barrel` が origin symbol に per-symbol 直結すること、`Files: src/barrel.ts:x` の drift 計算 (`impactReqs \ originReqs`) が symmetric に閉じること (spec.md US1)。
  Files: `docs/skills-guide.md`
  [REQ-018-001, REQ-018-004]

- [X] **T16** [US1,US2] `CHANGELOG.md` Unreleased 節を更新: Added に「Per-symbol precision for `export *` chains」「namespace re-exports」「imported-identifier re-exports」の 3 項目追加。Migration notes §1〜§6 で reconcile diff / SCHEMA_VERSION / plan-coverage 発火 / phantom-repair 減少 / attribution shift / drift 挙動を周知。Known limitations still open に ambiguous star / diamond / `export =` / fatal syntax / out-of-scope origin / `// @impl` above star / parser-side unresolved-reexport / wrapped default を明記。
  Files: `CHANGELOG.md`
  [REQ-018-006, REQ-018-009, REQ-018-010]

**Commit (Phase 4)**: `cde5d00` — feat(builder): re-export の per-symbol 精度 Phase 2 (specs/018)

**Checkpoint**: builder 結線完了、統合テスト全 pass (unit 1560 / e2e 41 実測)。docs / CHANGELOG に as-built で反映。

---

## Phase 5: 敵対的レビュー指摘対応 + SDD trio 追加 (this PR 追加 commit)

- [X] **T17** レビュー指摘に基づく docs / test 補強: (a) `CHANGELOG.md` Migration notes §5 (out-of-scope origin attribution shift) と §6 (path:symbol drift 挙動) を追加、(b) `docs/architecture.md` / `docs/skills-guide.md` を post-018 の per-symbol 精度に合わせて追記、(c) `.claude/skills/artgraph-impact/SKILL.md` / `.claude/skills/artgraph-plan-coverage/SKILL.md` に barrel 越し drift 解釈を追記、(d) `tests/barrel-reexport.test.ts` / `tests/typescript-oxc-regression.test.ts` に境界ケース回帰 (S3 bare specifier / warm-cold identity / ambiguous 経路)。
  Files:
  - `CHANGELOG.md`
  - `docs/architecture.md`
  - `docs/skills-guide.md`
  - `specs/018-reexport-symbol-precision/design.md`
  - `.claude/skills/artgraph-impact/SKILL.md`
  - `.claude/skills/artgraph-plan-coverage/SKILL.md`
  - `tests/barrel-reexport.test.ts`
  - `tests/typescript-oxc-regression.test.ts`
  [REQ-018-006, REQ-018-009]

- [X] **T18** SDD trio (spec.md / plan.md / tasks.md) を specs/018 に追加。CONTRIBUTING.md L102-107 の Spec Kit layout (`spec.md` → `plan.md` → `tasks.md`) 要求を満たす。as-built で REQ-018-001..010 / SC-018-001..006 を確定し、Task 1..5 を commit 単位で列挙。他 spec (013, 014, 015, 016, 017) と敬体 / 用語を揃える (日本語ベース)。
  Files:
  - `specs/018-reexport-symbol-precision/spec.md`
  - `specs/018-reexport-symbol-precision/plan.md`
  - `specs/018-reexport-symbol-precision/tasks.md`
  [REQ-018-001, REQ-018-002, REQ-018-003, REQ-018-004, REQ-018-005, REQ-018-006, REQ-018-007, REQ-018-008, REQ-018-009, REQ-018-010]

**Checkpoint**: SDD trio 完備、CHANGELOG / docs / skills の敵対的レビュー指摘が反映済。

---

## Dependencies (完了順)

```
Phase 1 (design)  T1 → T2
   └─► Phase 2 (SSOT hash)  T3
          └─► Phase 3 (parser + parse-cache + star-expansion pure module = MVP)
                 T4 (importBindings) → T5/T6/T7/T8 (S2/S3/starExports) — 並列可
                 T9 (parse-cache SCHEMA_VERSION) — T5/T6 完了後
                 T10 (star-expansion pure module) — 独立で並列可
                 T11 / T12 (tests) — 実装完了後に pin
                    └─► Phase 4 (builder 結線 + docs + CHANGELOG)
                           T13 (builder) → T14/T15/T16 (docs, 並列可)
                              └─► Phase 5 (as-built SDD trio + レビュー指摘対応)
                                     T17 (docs/skills/tests 補強) → T18 (SDD trio)
```

## Parallel Opportunities

- Phase 3: T5 / T6 / T7 / T8 は parser 内の別領域 (S2 / starExports / S3-C4 / S3-C3) で並列実装可 (実際は同一 commit `5f5ce51` に集約)。
- Phase 4: T14 / T15 / T16 (docs / CHANGELOG) は別ファイルで並列可 (実際は同一 commit `cde5d00` に集約)。
- Phase 5: T17 / T18 は別ファイルで並列可 (this PR 追加 commit)。

## Implementation Strategy

- **MVP = Phase 1 + 2 + 3** (design → SSOT → parser & star-expansion module): parse ができ pure module が unit test で通る時点で「per-symbol 精度の基礎」は成立。
- **Phase 4 で全 US 完成**: builder 結線が実質「配線」だけなので分離可能。統合テストは実装完了後に全 pass 確認。
- **Phase 5 で SDD 補完 + レビュー反映**: as-built で SDD trio を後追いで整備、レビュー指摘に基づく docs / skills / test 補強を同じ commit で反映。

## Definition of Done (as-built 検証)

- [X] 全テスト green (unit 1560 / e2e 41 実測)。
- [X] `synthReexportHash` SSOT が #177 と S1/S2/S3 で単一関数 (Cat2)。
- [X] `expandStarReexports` の走査方向 (starMap forward)、dedup key (`resolvedTargetRel`)、条件付きメモ化が実装と一致 (Cat7)。
- [X] SCHEMA_VERSION 3 → 4 で旧 cache は cold invalidate。
- [X] warm/cold の lock byte-identity (INV-L4) を parse-cache.test.ts の既存検証で pass (SC-018-005)。
- [X] `#177` 既存 lock hash bytes は不変、追加のみが reconcile diff に現れる (SC-018-003)。
- [X] CHANGELOG Migration notes §1〜§6 に既存ユーザー向け周知が揃っている。
- [X] Known limitations still open が spec.md Out of scope および CHANGELOG に対称に記載されている。
- [X] SDD trio (spec.md / plan.md / tasks.md) が CONTRIBUTING.md L102-107 の Spec Kit layout を満たす。
