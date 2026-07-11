# Implementation Plan: symbol mode のクラスメソッド粒度

**Branch**: `feat/method-grain-symbols` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: Issue [#218](https://github.com/mori-shin-x/artgraph/issues/218) / spec 021 (敵対的設計レビュー F1-F16 反映済み、1d83b77)

## Summary

symbol mode の TypeScript パーサに、インライン export されたクラスの名前付きメンバーを `symbol:<path>#ClassName.methodName` としてシンボル化する能力を追加し、class→method の `contains` 辺 (順方向限定 — spec 019 のセマンティクスを再利用) で結ぶ。タグ帰属は既存の innermost-wins 機構にメンバーの attribution range を追加するだけで成立する。**traverse 層・lock スキーマ・入力構文 (`Files:` / CLI) は変更ゼロ** — 変更はパーサ (`src/parsers/typescript.ts`) と parse-cache の `SCHEMA_VERSION`、および周辺テスト・ドキュメントに閉じる。

## Technical Context

- **Language/Runtime**: TypeScript strict / Node.js。pnpm。oxc パーサ。テストは vitest (unit: `tests/*.test.ts`、e2e: `tests/e2e/`)、lint は oxlint/oxfmt (lefthook)、未使用検出は knip。
- **変更の中心**: `src/parsers/typescript.ts` (1700 行超、リポジトリ最大ファイル):
  - Pass 2 の `ClassDeclaration` 分岐 (インライン named / default export): クラスシンボル push 後にクラス body のメンバーを走査し、対象メンバー (spec FR-001/FR-004) ごとにメソッドシンボルを push。
  - 同名メンバー収束 (FR-003): メンバー名 → 出現リストを集め、1 シンボル + 全出現の attribution range + `\0` 連結ハッシュ (前例: `synthReexportHash`)。
  - attribution range: 遡上下限 = クラス宣言開始行 (FR-002)。SymbolRange の登録順はクラス → メンバー (同サイズ tie でクラス優先)。
  - class→method `contains` 辺の emit (FR-006、provenance `structural`)。
  - 既存シンボル名との ID 衝突 (文字列 export 名) はメンバー優先 + warning (FR-001)。
- **parse-cache**: パーサ出力が変わるため `SCHEMA_VERSION` bump (`src/parse-cache.ts` の慣行どおり理由コメント付き)。
- **変更しないもの**: `src/graph/traverse.ts` (spec 019 の方向制約がそのまま効く)、lock スキーマ (`buildLockFromGraph` は symbol を汎用処理)、`Files:`/CLI の正規表現 (ドット受理済み)、`resolveStartIds`/`entryOriginIds` (完全一致 lookup / imports 辺のみで自然に成立)、builder の contains 生成 (doc 系のみのまま)。
- **既存テストの書き換え**: `tests/typescript-oxc-regression.test.ts` の「クラスはメンバーシンボルを持たない」前提の期待値、メソッド内タグのクラス帰属を expect するテスト。`typescript.ts` 冒頭の ts-morph bit-for-bit contract コメントも書き換え (SC-003)。

### 解決した設計判断 (詳細は spec.md — 敵対的レビュー F1-F16 の裁定込み)

1. **ドット記法 ID + contains 順方向 + 事後の帰属なし** — traverse 変更ゼロ。辺なし案は consumer 爆風が現行 main より退化するため棄却 (Alternatives)。
2. **メソッド起点はファイル内精度のクエリ** (F1) — consumer ファイル非包含を意図的裁定として明文化。consumer 1-hop 付与は FR-014j のフォローアップ。
3. **private `#member` はシンボル化しない** (F4) — ID の `#` 分割が first/last 混在で check --diff の rename 正規化が壊れるため。
4. **同名メンバー hash は全出現 `\0` 連結** (F6)。
5. **帰属規則は実機構準拠** (F2/F3) — 浮きタグは次メンバー、遡上下限クラス宣言行、tie はクラス優先。
6. **インライン export のみ対象** (F7)、メンバー種別の境界は FR-004 の除外リスト (F8)。

## Constitution Check (v1.2.0)

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ メンバーシンボル・contains 辺はすべて TS AST から決定的に導出。同名収束のハッシュはソース順連結で決定的。文字列 export 衝突は「メンバー優先」の静的規則で解決 (push 順依存の先勝ちを排除)。scan 2 回の byte-identical を SC-005 で固定。
- **II. 単一型付き4層グラフ**: ✅ 新ノード型・新エッジ型なし。既存 `symbol` ノード型と `contains` 辺型への写像で表現 (原則の要求どおり「独自スキーマを追加しない」)。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ✅ REQ ID の所有権に変更なし。claim の帰属先が細粒度化するだけ。
- **IV. SDD ツール ID 直接利用**: ✅ 影響なし。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ `this.methodB()` の call-graph 解決をスコープ外とした判断 (FR-014a) はこの原則と整合 — 意味的な呼び出し解決に踏み込まず、構造 (AST メンバーシップ) のみを扱う。

### Engineering Hygiene Gates

- `pnpm typecheck` / `pnpm test:unit` / `pnpm test:e2e` / `pnpm knip` green。
- CHANGELOG / version は触らない (release-please)。
- dogfood テンプレート 5 agent path byte-identical 同期 (FR-013)。
- parse-cache `SCHEMA_VERSION` bump (warm/cold 乖離の防止 — 憲法 I の byte-identical 要件の実務面)。

## Project Structure

### Documentation (this feature)

```
specs/021-class-method-grain/
├── spec.md      # 設計 SSOT (敵対的レビュー反映済み)
├── plan.md      # 本ファイル
└── tasks.md     # TDD タスク分解 (7 観点マッピング付き)
```

### Source Code (repository root)

```
src/parsers/typescript.ts        # 唯一のロジック変更点 (FR-001〜006)
src/parse-cache.ts               # SCHEMA_VERSION bump のみ (FR-006)
tests/typescript.test.ts         # 単体: メンバー抽出・帰属・収束・衝突
tests/typescript-oxc-regression.test.ts  # 期待値反転 (SC-003)
tests/traverse.test.ts           # class→method contains の方向制約 fixture (FR-007/008)
tests/impact-cli.test.ts         # issue #218 再現 E2E (SC-001)、US2 シナリオ
tests/plan-coverage*.test.ts     # US2-6 (per-entry 二軸)
tests/check*.test.ts             # FR-012 (drift/スコープ)
tests/parse-cache.test.ts        # SCHEMA_VERSION / warm-cold 一致
README.md / docs/skills-guide.md / templates/skills/** / 5 agent paths  # FR-013
specs/019-impact-doc-containment/spec.md  # autoContains 記述の追記 (FR-013c)
```

## Complexity Tracking

なし。新規モジュール・新規依存・スキーマ変更を伴わない。最大の複雑性は typescript.ts の既存 pass 構造 (pass 1: 関数 hoisting / pass 2: その他 export) との統合と、同名収束の range/hash 管理。

## Follow-up

- FR-014h: `export namespace` 内関数の namespace 収束 (別 issue 起票候補)。
- FR-014i: private `#member` シンボル化 (`#` 分割 3 箇所監査が前提)。
- FR-014j: メソッド起点 impact への consumer 1-hop 付与 (実需観測後)。
- [#235](https://github.com/mori-shin-x/artgraph/issues/235): メソッド編集時のクラス drift 併発は本 spec で増える二重報告 — #235 の hash 粒度議論の材料になる。
