# Implementation Plan: GraphEdge / Lock の provenance を first-class に持たせる

**Branch**: `feat/edge-provenance-issue35` | **Date**: 2026-06-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-edge-provenance/spec.md`

関連 Issue: #35 / 先行 spec: `specs/010-req-req-dependency/contracts/provenance-field.md`

## Summary

artgraph の `GraphEdge` に必須フィールド `provenances: NonEmptyArray<EdgeProvenance>` を導入し、グラフ内の全エッジ生成サイト（`packages/artgraph/src/{parsers,graph}/` 配下の `edges.push(...)` および convention 推論／auto contains 等。タスク T003-T005 が網羅）に由来情報を付ける。dedup で同一 `(source, target, kind)` が複数経路から生成された場合は集合 union で由来を保持する。`.trace.lock` の `dependsOn` を `Array<{id, provenances}>` 構造化し、annotation 経路も含めて全 provenance を書き出す（sort で決定性確保）。CLI 出力 (`artgraph graph` の text / json 双方) に provenance を露出させる。

技術アプローチ:

1. `packages/artgraph/src/types.ts` で `EdgeProvenance` を 8 値に拡張、`NonEmptyArray<T>` 型エイリアスを追加、`GraphEdge.provenances` を required に。`EDGE_PROVENANCE_VALUES` を同期。`LockEntry.dependsOn` の型を構造化。
2. 全 edge 生成サイト（`parsers/markdown.ts`, `parsers/typescript.ts`, `graph/builder.ts`）に provenance を付与。dedup を集合 union に書換。
3. `graph/format.ts` の JSON 出力を `provenances` 配列化、text 出力に provenance 表記追加。不正値フィルタを配列要素レベルに。
4. `lock.ts:buildLockFromGraph` の annotation フィルタ撤去、`dependsOn` を `{id, provenances}` で書き出し、sort で決定性確保。
5. `rename-lock.ts` を新 schema 対応（`{id, provenances}` 配列内の id 部分のみ書換）。
6. 全テスト書換（`tests/builder.test.ts`, `markdown.test.ts`, `typescript.test.ts`, `lock.test.ts`, `rename.test.ts`, `check.test.ts`, `coverage.test.ts`, `traverse.test.ts`, `graph-format.test.ts`, `req-req-invariants.test.ts`）と新規 fixture（`tests/fixtures/rename/.trace.lock` の schema 書換含む）。
7. 010 側 `contracts/provenance-field.md` の「#35 解決時の想定変更」を本 spec への pointer に更新。

## Technical Context

**Language/Version**: TypeScript 5.x（Node.js >= 20、ESM `"type": "module"`）

**Primary Dependencies**: unified + remark-parse、ts-morph、eemeli/yaml、mdast-util-to-string（既存）。新規依存は追加しない。

**Storage**: `.trace.lock`（JSON）— schema 変更を伴う（`dependsOn: string[]` → `Array<{id, provenances: EdgeProvenance[]}>`）。未リリースのため migration 不要。

**Testing**: vitest（既存）。新規 fixture は `packages/artgraph/tests/fixtures/edge-provenance/` 配下に集約。

**Target Platform**: Node.js CLI (`packages/artgraph/bin/artgraph`)

**Project Type**: monorepo CLI（pnpm workspace）

**Performance Goals**: 既存 scan 処理時間に対し +5% 以内（provenance 付与は単純なリテラル追加、dedup union は `Set` ベースで O(N)）。

**Constraints**: lock の決定性（バイト一致再現）を維持。`provenances` の sort と `dependsOn[].id` の sort で実装順序非依存にする。

**Scale/Scope**: 既存スケール（10-100 spec ファイル、各ファイル数十 req）。edge 数の典型 100-1000 本、provenance 値 8 種で配列長は最大 2-3 想定。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. 決定的グラフ第一 | Pass | provenance 付与は静的なリテラル決定。dedup union は Set + sort で順序決定的。LLM 不使用。`buildLockFromGraph` の出力は新たに sort 規約を導入してバイト一致を保証。 |
| II. 単一型付き4層グラフ | Pass | `EdgeKind` 不変。`GraphEdge` に provenances フィールドを追加するが「edge メタデータの直交拡張」であり、レイヤ数・kind 数は増えない。 |
| III. Spec が ID を所有 | Pass | provenance は edge メタデータで ID 発行に無関係。新 ID なし。rename 動作も「id 部分のみ書換、provenances 不変」で原則維持。 |
| IV. SDD ツール ID 直接利用 | Pass | provenance 値は内部メタデータで SDD ツールの ID とは無関係。 |
| V. 構造整合のみ保証 | Pass | provenance は構造的な「どの仕組みでこの edge が生まれたか」の事実情報。意味判定（依存が正しいか等）には踏み込まない。 |

違反なし。Complexity Tracking は空。

**Re-evaluation after Phase 1 (2026-06-26)**: data-model / 3 つの contracts / quickstart を生成後、設計が新たに Constitution 違反を導入していないことを確認:

- 原則 I: 新たに導入した不変条件（INV-L1..L5 / INV-O1..O4 / INV-T1..T4）はすべて決定的 sort と Set ベース dedup を要件化。LLM・統計推定の導入なし。
- 原則 II: contracts は型 union と既存 EdgeKind のみで構成。新カテゴリ（NonEmptyArray<T>）は型レベル補助であり、グラフ層数を増やさない。
- 原則 III, IV: provenance / lock 構造の変更は ID 発行・SDD ツール統合と直交。
- 原則 V: provenance 値は「どの仕組みで生成されたか」の事実情報のみ。意味判定なし。

設計フェーズ完了時点で違反なし。

## Project Structure

### Documentation (this feature)

```text
specs/011-edge-provenance/
├── plan.md                              # This file (/speckit-plan command output)
├── spec.md                              # /speckit-specify 出力（済）
├── research.md                          # Phase 0 output
├── data-model.md                        # Phase 1 output
├── quickstart.md                        # Phase 1 output
├── contracts/
│   ├── edge-provenance-type.md          # EdgeProvenance / GraphEdge 型契約
│   ├── lock-schema-v2.md                # LockEntry.dependsOn 構造化契約
│   └── cli-output-format.md             # artgraph graph の text/json 出力契約
├── checklists/
│   └── requirements.md                  # /speckit-specify 出力（済）
└── tasks.md                             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/artgraph/
├── src/
│   ├── types.ts                         # EdgeProvenance / NonEmptyArray / LockEntry 型拡張
│   ├── parsers/
│   │   ├── markdown.ts                  # frontmatter, annotation, task-tag, inline-link source
│   │   └── typescript.ts                # code-tag, ts-import source
│   ├── graph/
│   │   ├── builder.ts                   # convention, structural source ＋ dedup union
│   │   └── format.ts                    # text/json 出力に provenances 露出
│   ├── lock.ts                          # buildLockFromGraph: dependsOn を {id, provenances} で sort 書出
│   └── rename-lock.ts                   # {id, provenances} 配列内 id 書換
└── tests/
    ├── builder.test.ts                  # provenance 付与 ＋ dedup union テスト
    ├── markdown.test.ts                 # frontmatter/annotation/task-tag/inline-link 各 provenance
    ├── typescript.test.ts               # code-tag / ts-import
    ├── lock.test.ts                     # 新 schema round-trip ＋ 決定性
    ├── rename.test.ts                   # rename 後の provenances 維持
    ├── check.test.ts                    # gate が churn で誤発火しないこと
    ├── coverage.test.ts                 # 既存 literal edge を新型に追従
    ├── traverse.test.ts                 # 同上
    ├── graph-format.test.ts             # text/json 出力フォーマット
    ├── req-req-invariants.test.ts       # NonEmptyArray invariant + 不正値フィルタ
    └── fixtures/
        ├── edge-provenance/             # 新規: 8 provenance 各最小ケース + 2 経路 union
        └── rename/.trace.lock           # 既存: 新 schema に書換
```

**Structure Decision**: `packages/artgraph` 単一パッケージでの内部リファクタ＋テスト書換。新規パッケージ・新規 CLI コマンドは追加しない。

## Complexity Tracking

> Constitution 違反なし。空欄。
