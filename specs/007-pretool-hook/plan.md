# Implementation Plan: PreToolUse Hook (hook-pretool サブコマンド)

Branch: `007-pretool-hook` | Date: 2026-06-21 | Spec: [spec.md](./spec.md)

Input: Feature specification from `specs/007-pretool-hook/spec.md`

## Summary

`artgraph hook-pretool` サブコマンドを新規に追加する。Claude Code の PreToolUse hook として
Edit/Write/MultiEdit の実行前に発火し、stdin から受け取った hook JSON の tool_input.file_path を
抽出して artgraph impact を内部的に実行し、影響を受ける仕様ノード（FR-001 等）や
ドキュメントノード（doc:api-design 等）を hookSpecificOutput の additionalContext として
stdout に出力する。これにより、Claude Code エージェントはファイル変更前に影響範囲を自動的に把握できる。

v1 では常に exit 0 で返し、permissionDecision は返さない（情報提供のみ）。
artgraph 未導入環境では graceful degradation として影響なしを返す。

## Technical Context

Language/Version: TypeScript 5.x（Node.js ランタイム）

Primary Dependencies: commander, ts-morph, remark (unified), glob, gray-matter

Storage: `.trace.lock`（JSON ファイル）、`.artgraph.json`（設定ファイル）

Testing: Vitest

Target Platform: Node.js CLI（npm 配布）

Project Type: CLI ツール / ライブラリ

Performance Goals: 小規模プロジェクト（< 100 ファイル）で hook 応答が 3 秒以内。大規模プロジェクトでの
レイテンシ問題は P3 のデーモン化で対応する想定。

Constraints: Node.js 起動 + ts-morph 初期化のレイテンシ（1-3 秒想定）。PreToolUse hook は
ツール実行のたびに呼ばれるため、できるだけ軽量に保つ。5 秒超過の場合は P3 で対処。

Scale/Scope: SDD プロジェクト（10-100 spec ファイル、100-10000 ソースファイル）

## Constitution Check

GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Integrity | Pass | 全処理は決定的。impact は BFS グラフ走査で到達ノードを計算。LLM 不使用 |
| II. Declarative Links — SDD ツール ID 直接使用 | Pass | impact 結果の ID（FR-001 等）をそのまま additionalContext に含める |
| III. JS/TS Native | Pass | Node.js CLI として実装。ts-morph + remark を継続使用 |
| IV. CLI-First Interface | Pass | `artgraph hook-pretool` サブコマンドとして公開。stdin/stdout のテキスト入出力プロトコルに従う |
| V. Incremental Adoption | Pass | hook 設定は任意。未設定・未導入でもエラーにならない。段階的に導入可能 |

## Project Structure

### Documentation (this feature)

```text
specs/007-pretool-hook/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── hook-pretool.md
├── quickstart.md        # Phase 1 output
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
src/
├── cli.ts               # 変更: hook-pretool サブコマンド追加
├── hook-pretool.ts      # 新規: hook-pretool コマンドのメインロジック
│                        #   stdin 読み取り → JSON パース → file_path 抽出
│                        #   → loadConfig → scan → resolveStartIds → impact
│                        #   → hookSpecificOutput 生成 → stdout 出力
├── config.ts            # 変更なし
├── scan.ts              # 変更なし（内部で呼び出すのみ）
├── graph/
│   ├── builder.ts       # 変更なし
│   └── traverse.ts      # 変更なし（impact, resolveStartIds を利用）
├── parsers/
│   ├── markdown.ts      # 変更なし
│   └── typescript.ts    # 変更なし
├── types.ts             # 変更なし（ImpactResult を利用）
├── lock.ts              # 変更なし（readLock を利用）
├── check.ts             # 変更なし
├── coverage.ts          # 変更なし
└── diff.ts              # 変更なし

tests/
├── hook-pretool.test.ts # 新規: hook-pretool のユニットテスト
│                        #   - stdin パース（Edit/Write/MultiEdit）
│                        #   - file_path 抽出
│                        #   - 絶対パス→相対パス変換
│                        #   - hookSpecificOutput 生成
│                        #   - graceful degradation（設定なし、エラー時）
└── fixtures/
    └── hooks/           # 新規: hook テスト用フィクスチャ
        ├── edit-input.json
        ├── write-input.json
        └── multiedit-input.json
```

Structure Decision: 既存の single project 構造を維持。新規ファイルは `src/hook-pretool.ts` と
テストファイル・フィクスチャのみ。CLI エントリポイント（`src/cli.ts`）に commander サブコマンドを
1 つ追加し、実ロジックは `src/hook-pretool.ts` に分離する。

## Complexity Tracking

> 違反なし。Constitution Check 全項目パス。
