# Implementation Plan: impact BFS の contains 辺方向制約

**Branch**: `feat/impact-doc-containment` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: Issue [#215](https://github.com/mori-shin-x/artgraph/issues/215) / spec 019

## Summary

`impact()` の BFS で `contains` 辺を順方向 (doc → req|task) 限定にし、逆方向 (req|task → 親 doc) 経由の同一 spec 兄弟 REQ 巻き込みを根絶する。親 doc は BFS 完了後の帰属アトリビューション (到達 req/task → 親 doc の 1-hop 解決) で `affectedDocs` と drift 判定に温存する。US4 (`sameSpecReqs`) の deferral により **`ImpactResult` の型・JSON スキーマは完全に不変** — 変わるのは到達集合の中身だけで、変更は `src/graph/traverse.ts` の `impact()` 1 関数に閉じる。呼び出し元 3 箇所 (impact CLI / check --diff / plan-coverage) はコード変更なしで自動的に浄化され、その波及をテストで固定する。

## Technical Context

- **Language/Runtime**: TypeScript strict / Node.js。pnpm。テストは vitest (unit: `tests/*.test.ts`、e2e: `tests/e2e/`)。lint は oxlint / oxfmt (lefthook pre-commit)、未使用検出は knip。
- **変更の中心**: `src/graph/traverse.ts` の `impact()`:
  - BFS のエッジ展開ループ (現行 51-58 行): `edge.target === id` 側 (逆方向) の展開に `edge.kind !== "contains"` 条件を追加。順方向 (`edge.source === id`) は全辺種そのまま。
  - BFS 完了後: visited 中の req / task ノードを target とする `contains` 辺の source doc を収集し、`affectedDocs` へ union (dedup)。attributed doc も lock との contentHash 比較で `drifted` 判定に含める。attributed doc からの再展開はしない。
  - 冒頭の設計コメント (spec 014/016 由来の「bidirectional は意図」宣言、maxDepth 回避策) を spec 019 準拠に全面書き換え。
- **呼び出し元は不変**: `src/commands/impact.ts` / `src/commands/check.ts` / `src/plan-coverage/index.ts` はコード変更不要。check のスコープ集合は `impactResult.affectedDocs` を既に取り込んでいるため、attribution 経由の doc もそのままスコープに入る。
- **既存テストの書き換え**: 兄弟 REQ / 兄弟 task 到達を expect している既存テスト (`tests/traverse.test.ts` / check 系 / plan-coverage 系) は新セマンティクスへ期待値を反転し、PR 上で列挙する (spec 前提)。

### 解決した設計判断 (詳細は spec.md の Alternatives Considered / US4 裁定注記)

1. **方向制約 + 事後アトリビューション** — 経路依存 BFS (reverse contains で到達した doc を非展開マーク) は決定性の検証コストが上がるため不採用。BFS は辺種で一律に判定し、帰属は到達集合への決定的な後処理とする。
2. **`sameSpecReqs` は Deferred** — 出力スキーマ不変という大きな単純化を得る。feature 文脈が必要な consumer は `affectedDocs` の spec を読む。
3. **doc→task にも一律適用** — tasks.md が第 2 の(より強力な)兄弟増幅ハブであるため、修正の成立条件 (spec FR-003)。
4. **`@impl` タグ削除境界は #229 に切り出し** — 現行でも確実には検出されておらず、本 spec の退行ではない。

## Constitution Check

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ BFS の決定性は維持 (visited set / queue 順序不変)。方向制約は辺種による静的条件で、訪問順に依存しない。帰属アトリビューションは到達集合に対する決定的後処理。出力順序契約 (INV-S2) 不変。
- **II. 単一型付き4層グラフ**: ✅ ノード / エッジ型・グラフ生成 (builder) は一切変更しない。消費側 (traverse) のセマンティクスのみ。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ✅ 影響なし。
- **IV. SDD ツール ID 直接利用**: ✅ 影響なし。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ 影響なし。むしろ「blast radius = 構造的到達」の近似精度が上がる。

### Engineering Hygiene Gates

- `pnpm typecheck` / `pnpm test:unit` / `pnpm test:e2e` / `pnpm knip` green。
- CHANGELOG / version は触らない (release-please 管理)。
- dogfood テンプレート 5 agent path の byte-identical 同期テスト green (FR-013 の Skill 更新時)。

## Project Structure

### Documentation (this feature)

```
specs/019-impact-doc-containment/
├── spec.md      # 設計判断の SSOT (レビュー済み)
├── plan.md      # 本ファイル
└── tasks.md     # TDD タスク分解
```

### Source Code (repository root)

```
src/graph/traverse.ts            # 唯一のロジック変更点 (FR-001〜006, FR-012)
tests/traverse.test.ts           # 単体: 方向制約・帰属・US1 シナリオ (追加 + 期待値反転)
tests/impact-cli.test.ts         # CLI E2E: issue #215 最小再現 fixture (SC-001)
tests/plan-coverage*.test.ts     # US2: 同一 spec 複数 REQ の二軸浄化 (FR-010)
tests/check*.test.ts             # US3: スコープ浄化 + spec 変更経路維持 (FR-011)
README.md / docs/skills-guide.md # FR-013 (impact セマンティクス説明の更新)
templates/**(skills)             # FR-013 (該当記述がある場合のみ、5 path 同期)
```

## Complexity Tracking

なし。単一関数の局所変更で、新規モジュール・新規依存・スキーマ変更を伴わない。

## Follow-up

- [#229](https://github.com/mori-shin-x/artgraph/issues/229) — `@impl` タグ削除の検出 (baseline 側グラフ辺のスコープ計算併用)。
- [#218](https://github.com/mori-shin-x/artgraph/issues/218) — クラスメソッド粒度。本 spec 解決後に効果が観測可能になる次の支配的過剰検知源。
- `sameSpecReqs` (spec 019 US4 スケッチ) — ドッグフーディングで実需が観測されたら再起票。
- 「1 task に大量 REQ 列挙」パターン (Spec Kit convergence phase) のノイズ観測 (spec Edge Cases の watch item)。
