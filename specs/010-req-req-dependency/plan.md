# Implementation Plan: 要求 ⇔ 要求 (req→req) の依存をインライン注釈で表現する

Branch: `feat/req-req-dependency-issue13` | Date: 2026-06-24 | Spec: [spec.md](./spec.md)

Input: Feature specification from `specs/010-req-req-dependency/spec.md`

関連 Issue: #13 / 関連オープン: #35 (GraphEdge provenance)

## Summary

要求 ID を構造化して書く運用のプロジェクト（Spec Kit / Kiro / BMAD 等）向けに、
要求の箇条書き／見出し行へインライン注釈（例: `(depends_on: AUTH-001)` /
`(derives_from: AUTH-001, AUTH-002)`）で req→req の依存を表現できるようにする。
注釈の追加・変更で req の content-hash が変動しないよう、ハッシュ計算前に注釈
相当部分を本文から除去する。

技術アプローチ:

1. `packages/artgraph/src/parsers/markdown.ts` を拡張し、list-item / heading 形式
   req それぞれに対し注釈抽出ロジックを追加する。注釈はキーワード
   `depends_on` / `derives_from` のみ受理し、カンマ区切り複数 ID、`**BOLD**`、
   空白バリエーションに対応する。注釈除去後の文字列で req の `contentHash` を計算する。
2. `packages/artgraph/src/types.ts` の `GraphEdge` に `provenance` 任意フィールド
   を追加し、注釈由来エッジには値 `"annotation"` を付与する（Issue #35 解決時に
   フィールド名・値を共通化）。
3. `packages/artgraph/src/graph/builder.ts` の既存 `remapId` ／衝突 ID 解決ロジック
   を req→req エッジにも適用する（doc→req と同一処理）。
4. `packages/artgraph/src/rename.ts` を拡張し、注釈括弧内の依存先 ID も rename
   対象に含める。fenced code block スキップは既存規約 F6 を踏襲。
5. fixture と vitest テストを追加（10 件以上の許容／誤検出パターン）。

## Technical Context

Language/Version: TypeScript 5.x（Node.js >= 20、ESM `"type": "module"`）

Primary Dependencies: unified + remark-parse, mdast-util-to-string, eemeli/yaml
（既存）。新規依存は追加しない。

Storage: `.trace.lock`（JSON）— req の `contentHash`（注釈除去後）と
`dependsOn`（注釈由来エッジを含む）が記録される。

Testing: vitest（既存）。新規追加するのは
`packages/artgraph/tests/markdown.test.ts` への注釈系ケース、
`packages/artgraph/tests/rename.test.ts` への注釈 rename ケース、
`packages/artgraph/tests/builder.test.ts` への衝突解決ケース、および
`packages/artgraph/tests/fixtures/req-req-annotations/` 配下の Markdown fixture。

Target Platform: Node.js CLI（`packages/artgraph` の `bin/artgraph`）

Project Type: monorepo CLI（pnpm workspace）

Performance Goals: 既存 scan の処理時間に対し +10% 以内（注釈正規表現マッチを
list-item / heading 直下段落の冒頭・末尾のみに限定）。

Constraints: 散文中の `(depends on ...)`（アンダースコア無し）を誤検出しないこと。
fenced code block 内は対象外。

Scale/Scope: 既存スケール（10-100 spec ファイル、各ファイル数十 req）。1 req に
複数注釈・各注釈に複数 ID（典型 1-5 個）を想定。

## Constitution Check

GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.

| Principle | Status | Notes |
|-----------|--------|-------|
| I. 決定的グラフ第一 | Pass | 注釈抽出は正規表現＋AST のみ。LLM 不使用。注釈除去ハッシュも純粋関数。 |
| II. 単一型付き4層グラフ | Pass | 既存 `depends_on` / `derives_from` エッジ kind を再利用。`GraphEdge` への `provenance` 追加は型拡張だが、Issue #35 で別途扱う provenance 一般化と整合性を保つ形（Phase 0 で確定）。 |
| III. Spec が ID を所有 | Pass | 注釈で参照する ID は spec ファイル内で既に発行済みの req ID。新 ID を発行しない。 |
| IV. SDD ツール ID 直接利用 | Pass | 注釈内 ID 正規表現は config `reqPatterns.codeId` を流用。独自プレフィクスを追加しない。 |
| V. 構造整合のみ保証 | Pass | 注釈は構造的にエッジへ写像するのみ。「要求 A が本当に B に依存しているか」は判定しない。 |

違反なし。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/010-req-req-dependency/
├── spec.md
├── plan.md                       # This file
├── research.md                   # Phase 0 output
├── data-model.md                 # Phase 1 output
├── contracts/                    # Phase 1 output
│   ├── annotation-grammar.md     # 注釈の正規表現・許容／非許容パターン
│   ├── provenance-field.md       # GraphEdge provenance フィールド契約
│   └── rename-behavior.md        # rename での注釈書換契約
├── quickstart.md                 # Phase 1 output
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
packages/artgraph/
├── src/
│   ├── types.ts                  # GraphEdge に provenance 任意フィールド追加（L20-24）
│   ├── parsers/
│   │   └── markdown.ts           # 注釈抽出関数 (extractAnnotations) 追加、list-item と heading 直下段落で呼び出し、注釈除去後文字列で contentHash 計算
│   ├── graph/
│   │   └── builder.ts            # req→req エッジに対する remap 適用（既存 doc→req と同パス、L192 付近）
│   └── rename.ts                 # rewriteAnnotationIds 追加、rewriteSpecListItem の隣に配置。fenced code block スキップは fencedLineSet を流用
└── tests/
    ├── markdown.test.ts          # 注釈系 10+ ケース追加（許容／誤検出／空白／**BOLD**／複数 ID）
    ├── rename.test.ts            # 注釈 rename ケース追加（複数 ID 中の特定 ID 置換、fenced block スキップ）
    ├── builder.test.ts           # req→req エッジ remap ケース追加（specDir/REQ 衝突解決）
    └── fixtures/
        └── req-req-annotations/  # 新規 fixture
            ├── list-item.md
            ├── heading-kiro.md
            ├── multi-id.md
            └── collision/
                ├── 010-a/spec.md
                └── 010-b/spec.md
```

Structure Decision: 既存 monorepo の `packages/artgraph` 配下に追加する。新規
ソースファイルは作らず、4 つの既存ファイル（types / markdown / builder / rename）
への拡張に留める。テストは 3 つの既存ファイルへの追加 + 1 つの fixture ディレクトリ。

## Complexity Tracking

> 違反なし。Constitution Check 全項目パス。
