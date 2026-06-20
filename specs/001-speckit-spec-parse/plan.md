# Implementation Plan: Spec Kit spec.md パース対応

Branch: `001-speckit-spec-parse` | Date: 2026-06-20 | Spec: [spec.md](./spec.md)

Input: Feature specification from `specs/001-speckit-spec-parse/spec.md`

## Summary

spectrace の Markdown パーサーを根本的に見直し、SDD ツールの主要な仕様記法
（Spec Kit / BMAD のリスト項目 PREFIX-NNN、Kiro の見出し Requirement N）を
ネイティブに認識できるようにする。これに伴い、TypeScript パーサーの @impl / テストタグの
ID パターンも更新する。既存の check / impact / coverage ロジックは ID 形式に
依存しないため、変更は不要。

## Technical Context

Language/Version: TypeScript 5.x（Node.js ランタイム）

Primary Dependencies: ts-morph, remark (unified), gray-matter, commander, glob

Storage: `.trace.lock`（JSON ファイル）

Testing: Vitest

Target Platform: Node.js CLI（npm 配布）

Project Type: CLI ツール / ライブラリ

Performance Goals: 典型的プロジェクト（< 1000 ファイル）で scan が数秒以内に完了

Constraints: PreToolUse Hook のレイテンシ予算（デーモンモードで償却）

Scale/Scope: SDD プロジェクト（10-100 spec ファイル、100-10000 ソースファイル）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Integrity | ✅ Pass | 全変更は決定的（正規表現マッチング、ハッシュ計算）。LLM 不使用 |
| II. Declarative Links — SDD ツール ID 直接使用 | ✅ Pass | 本機能の主目的。design.md D2 更新済み |
| III. JS/TS Native | ✅ Pass | remark + ts-morph を継続使用 |
| IV. CLI-First Interface | ✅ Pass | scan / check / impact の CLI 出力は ID 形式に依存しない |
| V. Incremental Adoption | ✅ Pass | @impl タグ無しでも import グラフは動作。新 ID パターンも段階的に導入可能 |

## Project Structure

### Documentation (this feature)

```text
specs/001-speckit-spec-parse/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── id-patterns.md
├── quickstart.md        # Phase 1 output
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
src/
├── parsers/
│   ├── markdown.ts      # 主要変更: remark AST で listItem・heading を走査、ID パターン認識
│   └── typescript.ts    # @impl / テストタグの ID パターン更新（PREFIX-NNN, Requirement-N）
├── types.ts             # GraphNode から slug 削除、LockEntry に specFile 追加・slug 削除、CheckResult から slug 削除
├── config.ts            # reqPatterns の読み込み
├── graph/
│   ├── builder.ts       # 2パスビルド（収集→衝突検出→登録）、@impl の ID 解決
│   └── traverse.ts      # 変更なし（ID 形式非依存）
├── coverage.ts          # CoverageEntry から slug 削除
├── check.ts             # coverage 出力から slug 削除
├── lock.ts              # slug 書き出し削除、specFile 書き出し追加
├── scan.ts              # 変更なし
├── diff.ts              # 変更なし
└── cli.ts               # printCheckText の slug 表示削除

tests/
├── markdown.test.ts     # テストケース追加・既存ケース更新
├── typescript.test.ts   # テストケース追加・既存ケース更新
├── fixtures/
│   ├── specs/
│   │   ├── auth.md              # 既存フィクスチャ（新 ID 形式に更新）
│   │   ├── speckit-style.md     # 新規: Spec Kit リスト項目形式
│   │   └── kiro-style.md        # 新規: Kiro 見出し形式
│   └── ...
└── ...                  # check/coverage テストも slug 削除を反映
```

Structure Decision: 既存の single project 構造を維持。新規ファイルはテストフィクスチャのみ。変更対象は10ファイル（パーサー2、型定義1、設定1、ビルダー1、カバレッジ1、チェック1、ロック1、CLI 1、テスト2+）。

## Complexity Tracking

> 違反なし。Constitution Check 全項目パス。
