# Implementation Plan: ドキュメント間グラフ構造

Branch: `008-document-graph` | Date: 2026-06-21 | Spec: [spec.md](./spec.md)

Input: Feature specification from `specs/008-document-graph/spec.md`

## Summary

SDD ツールが出力する Markdown ファイル群の依存関係をグラフとして管理し、ドキュメント→要求→実装の一気通貫トレーサビリティを実現する。主な変更は以下の通り:

1. 各 Markdown ファイルを frontmatter の有無に関わらず `doc` ノードとしてグラフに自動登録する（FR-001）
2. frontmatter の `spectrace` ブロックで doc→doc 依存（derives_from / depends_on）を宣言する（FR-002）
3. doc ノードとその中の req ノード間に `contains` エッジを自動生成し、ドキュメント階層→要求→実装の一気通貫トレースを可能にする（FR-003）
4. `spectrace graph` コマンドでドキュメント依存チェーンを可視化する（FR-004）
5. orphan-doc / invalid-relation / 予約プレフィクス衝突の警告を追加する（FR-005, FR-007）
6. `impact` 出力に到達ノード数の内訳を追加し、`--depth N` オプションで BFS 探索深さを制限する（FR-009, FR-010, FR-011）

技術アプローチ: 既存の `parseMarkdown` を拡張して doc ノードを常に生成し、frontmatter の `spectrace` ブロックから doc→doc エッジを抽出する。`buildGraph` で contains エッジを自動生成し、`impact` に depth 制限を追加する。新コマンド `spectrace graph` を CLI に追加する。

## Technical Context

Language/Version: TypeScript 5.x（Node.js ランタイム）

Primary Dependencies: ts-morph, remark (unified), gray-matter, commander, glob

Storage: `.trace.lock`（JSON ファイル）

Testing: Vitest

Target Platform: Node.js CLI（npm 配布）

Project Type: CLI ツール / ライブラリ

Performance Goals: 典型的プロジェクト（< 1000 ファイル）で scan が数秒以内に完了。doc ノード追加による計算量増は、ファイル数に比例する線形増のため問題なし

Constraints: contains エッジの双方向 BFS による影響範囲爆発を `--depth` オプションで制御する必要がある

Scale/Scope: SDD プロジェクト（10-100 spec ファイル、100-10000 ソースファイル）。doc ノードは spec ファイル数と同数（10-100 個）程度

## Constitution Check

GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Integrity | Pass | doc ノード生成はファイル走査、contains エッジは AST パース、frontmatter 依存は YAML パースで全て決定的。LLM 不使用 |
| II. Declarative Links — SDD ツール ID 直接使用 | Pass | doc ノード ID は frontmatter `spectrace.node_id` または `doc:<相対パス>` の自動採番。doc→doc 依存は frontmatter `spectrace.derives_from` / `spectrace.depends_on` で宣言 |
| III. JS/TS Native | Pass | remark + gray-matter で Markdown/frontmatter をパース。既存の TS/JS エコシステム内で完結 |
| IV. CLI-First Interface | Pass | `spectrace graph` を新コマンドとして追加。`--format json|text`、`--kind` オプション対応 |
| V. Incremental Adoption | Pass | doc ノードの自動生成と contains エッジはそれぞれ設定で無効化可能。frontmatter 無しでも動作 |

## Project Structure

### Documentation (this feature)

```text
specs/008-document-graph/
├── spec.md
├── plan.md                       # This file
├── research.md                   # Phase 0 output
├── data-model.md                 # Phase 1 output
├── contracts/                    # Phase 1 output
│   ├── graph-command.md          # spectrace graph コマンドスキーマ
│   ├── frontmatter-schema.md    # frontmatter の新しいスキーマ
│   └── warning-types.md         # 新しい warning type のスキーマ
├── quickstart.md                 # Phase 1 output
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
src/
├── types.ts             # EdgeKind に "contains" 追加（L2）、SpectraceConfig に docGraph 設定追加（L64-69）、ImpactResult に内訳カウント追加（L38-42）
├── parsers/
│   └── markdown.ts      # doc ノード常時生成（L19-64 の parseMarkdown を拡張）、frontmatter の derives_from/depends_on フラット化対応、doc ID 自動採番
├── graph/
│   ├── builder.ts       # contains エッジの自動生成（L20-165 の buildGraph を拡張）、orphan-doc/invalid-relation/reserved-prefix の BuildWarning 追加（L7-10）、エッジデデュープ（FR-006）
│   ├── traverse.ts      # impact 関数に depth 制限追加（L4-22 の BFS ループに maxDepth パラメータ）、resolveStartIds に doc: プレフィクス対応追加（L90-113）
│   └── format.ts        # 新規: graph コマンドの text/JSON フォーマッタ
├── config.ts            # docGraph 設定の読み込み追加（L7-26 の loadConfig を拡張）
├── check.ts             # 変更なし（orphan-doc は BuildWarning として builder から報告され、check とは別経路で表示）
├── scan.ts              # 変更なし（buildGraph の出力を透過的に扱う）
├── cli.ts               # graph コマンド追加（L89 付近に新コマンド）、impact に --depth オプション追加（L55）、impact 出力に到達内訳追加（L153-170 の printImpactText を拡張）
├── lock.ts              # 変更なし（doc ノードは既に lock 対象、L24-59 の buildLockFromGraph が doc kind を処理済み）
├── coverage.ts          # 変更なし
└── diff.ts              # 変更なし

tests/
├── markdown.test.ts     # doc ノード生成テスト追加、frontmatter 依存テスト追加
├── builder.test.ts      # contains エッジ生成テスト追加、エッジデデュープテスト追加、警告テスト追加
├── traverse.test.ts     # depth 制限テスト追加、resolveStartIds doc: プレフィクステスト追加、impact 到達内訳テスト追加
├── cli.test.ts          # graph コマンドの統合テスト追加
├── config.test.ts       # docGraph 設定テスト追加
├── graph-format.test.ts # 新規: graph フォーマッタの単体テスト
└── fixtures/
    └── specs/
        ├── prose-only.md         # 新規: frontmatter なし散文のみ
        ├── doc-chain/            # 新規: derives_from チェーンフィクスチャ
        │   ├── requirements.md
        │   ├── design.md
        │   └── tasks.md
        └── doc-with-reqs.md      # 新規: doc + req 混在フィクスチャ
```

Structure Decision: 既存の single project 構造を維持。新規ファイルは `src/graph/format.ts`（graph コマンドのフォーマッタ）とテストフィクスチャのみ。変更対象は src 5ファイル + 新規 1ファイル、テスト 5ファイル + 新規 1ファイル + フィクスチャ。

## Complexity Tracking

> 違反なし。Constitution Check 全項目パス。
