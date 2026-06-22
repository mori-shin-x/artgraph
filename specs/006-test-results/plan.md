# Implementation Plan: テスト結果取り込み

Branch: `006-test-results` | Date: 2026-06-22 | Spec: [spec.md](./spec.md)

Input: Feature specification from `specs/006-test-results/spec.md`

## Summary

`artgraph check`、`artgraph coverage`、`artgraph scan` の各コマンドに `--test-results <path>` オプションを追加し、
Vitest JSON レポーターおよび JUnit XML 形式のテスト結果ファイルを取り込む。テスト名や describe ブロック名に含まれる
`[REQ-xxxx]` タグを抽出し、テストの pass/fail 状態を coverage 判定に反映する。

`verifies` エッジが存在し、かつ対応する全テストが pass している場合にのみ `verified` とし、テストが fail・skip・
結果不明の場合は `impl-only` に降格する。`--test-results` オプション未指定時は従来通り `verifies` エッジの有無のみで判定する（後方互換）。

## Technical Context

Language/Version: TypeScript 5.x（Node.js ランタイム）

Primary Dependencies: commander, ts-morph, remark (unified), glob, gray-matter

New Dependencies: なし（XML パースは Node.js 標準のテキスト処理で対応。軽量な SAX パーサーは不要 — JUnit XML はフラットな構造で正規表現ベースのパースで十分）

Storage: `.trace.lock`（JSON ファイル）、`.artgraph.json`（設定ファイル）

Testing: Vitest

Target Platform: Node.js CLI（npm 配布）

Performance Goals: テスト結果ファイル 1000 テストケース以下で追加レイテンシ 100ms 以内

Constraints: 既存の `computeCoverage()` のシグネチャ変更は下位互換を考慮して省略可能な引数で対応

## Constitution Check

GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Integrity | Pass | テスト結果ファイルは決定的入力。同一ファイルに対して常に同一の判定を返す。LLM 不使用 |
| II. Declarative Links — SDD ツール ID 直接使用 | Pass | `[REQ-xxxx]` タグでテスト名と REQ を紐づけ。テスト結果と REQ の join は ID ベース |
| III. JS/TS Native | Pass | Node.js CLI として実装。新規外部依存なし |
| IV. CLI-First Interface | Pass | `--test-results <path>` オプションで CLI から利用。設定ファイルでも指定可能 |
| V. Incremental Adoption | Pass | `--test-results` はオプショナル。未指定時は従来動作を完全に維持 |

## Project Structure

### Documentation (this feature)

```text
specs/006-test-results/
├── spec.md
├── plan.md              # This file
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase output
```

### Source Code (repository root)

```text
src/
├── cli.ts               # 変更: --test-results オプションを check, coverage, scan に追加
├── test-results.ts      # 新規: テスト結果パーサーと REQ タグ抽出
│                        #   parseVitestJson() — Vitest JSON レポーターのパース
│                        #   parseJUnitXml() — JUnit XML のパース
│                        #   parseTestResults() — フォーマット自動判別の統合関数
│                        #   extractReqTags() — テスト名から [REQ-xxxx] を抽出
│                        #   loadTestResults() — ファイル読み込み + パース + 統合
├── coverage.ts          # 変更: computeCoverage() にオプショナルなテスト結果引数を追加
├── check.ts             # 変更: check() にテスト結果を渡す
├── config.ts            # 変更: testResultPaths フィールドの読み込み
├── types.ts             # 変更: TestResultRecord 型、ArtgraphConfig.testResultPaths 追加
├── scan.ts              # 変更なし（テスト結果はグラフ構築後に独立して読み込む）
├── hook-pretool.ts      # 変更なし
├── init.ts              # 変更なし
├── lock.ts              # 変更なし
├── diff.ts              # 変更なし
├── graph/
│   ├── builder.ts       # 変更なし
│   └── traverse.ts      # 変更なし
└── parsers/
    ├── markdown.ts      # 変更なし
    └── typescript.ts    # 変更なし

tests/
├── test-results.test.ts # 新規: テスト結果パーサーのユニットテスト
├── coverage.test.ts     # 新規: テスト結果反映後の coverage 判定テスト
├── cli.test.ts          # 変更: --test-results オプションの CLI 統合テスト追加
└── fixtures/
    └── test-results/    # 新規: テスト結果ファイルのフィクスチャ
        ├── vitest-pass.json
        ├── vitest-fail.json
        ├── vitest-mixed.json
        ├── vitest-describe-inherit.json
        ├── vitest-skip.json
        ├── vitest-multi-req.json
        ├── vitest-namespaced.json
        ├── junit-pass.xml
        ├── junit-fail.xml
        ├── junit-suite-inherit.xml
        └── invalid-format.txt
```

Structure Decision: テスト結果パーサーを `src/test-results.ts` に集約する。Vitest JSON と JUnit XML の
パースは同一ファイル内の独立関数として実装し、フォーマット自動判別も同ファイルで行う。
`src/parsers/` に配置しない理由: 既存の parsers はグラフ構築時のソースコード解析用であり、
テスト結果ファイルのパースはグラフ構築とは独立したフェーズで実行される。

## Key Design Decisions

### 1. computeCoverage() のシグネチャ拡張

現在:
```typescript
function computeCoverage(graph: ArtifactGraph): CoverageEntry[]
```

変更後:
```typescript
function computeCoverage(graph: ArtifactGraph, testResults?: TestResultMap): CoverageEntry[]
```

`testResults` が undefined の場合は従来動作（`verifies` エッジの有無のみ）を維持。
`testResults` が渡された場合、`verifies` エッジが存在する REQ に対してテスト pass/fail を追加で確認する。

### 2. TestResultMap のデータ構造

```typescript
type TestResultMap = Map<string, TestResultRecord[]>
// key: REQ ID（例: "FR-001", "001-auth/FR-001"）
// value: その REQ に紐づくテスト結果の配列
```

REQ ID → テスト結果の逆引きマップを事前構築し、coverage 判定時の lookup を O(1) にする。

### 3. REQ タグ抽出パターン

テスト名・describe 名から `[REQ-xxxx]` パターンを抽出する正規表現:
```
/\[(?:([^\]/]+)\/)?([A-Z]+-\d+)\]/g
```
- `[FR-001]` → REQ ID: `FR-001`
- `[001-auth/FR-001]` → 名前空間付き REQ ID: `001-auth/FR-001`
- `[REQ-001][REQ-002]` → 複数マッチ: `REQ-001`, `REQ-002`

### 4. JUnit XML パース戦略

外部 XML パーサーライブラリを追加せず、正規表現ベースでパースする。理由:
- JUnit XML はフラットな `<testsuite>/<testcase>` 構造で、ネストは浅い
- 必要な情報は `name` 属性と `<failure>` / `<error>` / `<skipped>` 子要素の有無のみ
- 依存の追加を避けることで Constitution III（JS/TS Native）に沿う

### 5. フォーマット自動判別

ファイル拡張子ではなく内容ベースで判別する（FR-007）:
- 先頭が `{` または `[` → JSON としてパースを試行
- 先頭が `<` または `<?xml` → XML としてパースを試行
- いずれでもない → 警告を出力してスキップ

## Complexity Tracking

> 違反なし。Constitution Check 全項目パス。JUnit XML の正規表現パースは
> 構造がフラットなため妥当。複雑なネスト対応が必要になった場合は外部パーサー追加を検討する。
