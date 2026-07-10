# Tasks: impact BFS の contains 辺方向制約

**Input**: [spec.md](./spec.md) / [plan.md](./plan.md)

## 進め方 (TDD: Red ⇒ Green ⇒ 追随 ⇒ Polish)

コア変更は `src/graph/traverse.ts` の 1 関数に閉じるため、まず US1 の失敗テストを書き (Red)、方向制約 + 帰属アトリビューションで Green にし、その後 US2 / US3 の波及を観測点として固定、最後に既存テストの期待値反転とドキュメント追随を行う。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 他タスクと並行実行可能 (異なるファイル・依存なし)
- **[USn]**: 対応する spec.md の User Story

## Path Conventions

単一パッケージ。ソースは `src/`、単体テストは `tests/*.test.ts`、E2E は `tests/e2e/`。

## Phase 1: Red — US1 の失敗テスト

- [ ] T001 [US1] issue #215 最小再現 fixture の単体テストを `tests/traverse.test.ts` に追加: `fnA` (`@impl REQ-901`) / `fnB` (`@impl REQ-902`) 同居 spec.md 構成のグラフを組み、`impact()` が (a) 同一ファイル・依存なしで REQ-902 を含まない (AS1-1)、(b) 別ファイル・依存なしで REQ-902 / other.ts を含まない (AS1-2)、(c) 別 spec 分割時は従来どおり (AS1-5) を assert — 現行実装で **Red** になることを確認
- [ ] T002 [P] [US1] 追加の Red テスト: (a) fnA→fnB の `imports` 辺があるときは REQ-902 が正しく含まれる (AS1-3)、(b) 親 doc が `affectedDocs` に帰属として残り drift 時は `drifted` に doc entry が出る (AS1-4)、(c) `REQ-901 depends_on REQ-903` (別 spec) の req→req 到達は維持 (AS1-6)、(d) doc→task: task 経由で tasks.md の兄弟 task を巻き込まない (FR-003)、(e) 起点が spec パス (`resolveStartIds` filePath fallback) のとき全子 REQ に到達 (Edge Case)

## Phase 2: Green — traverse.ts コア変更

- [ ] T003 [US1] `impact()` の BFS エッジ展開に contains 方向制約を実装 (FR-001〜003): 逆方向展開 (`edge.target === id`) を `edge.kind !== "contains"` のときのみ行う。順方向展開・file→symbol 展開・他 5 辺種の双方向性は不変
- [ ] T004 [US1] 帰属アトリビューションを実装 (FR-004〜006): BFS 後、visited の req / task を target とする contains 辺の source doc を `affectedDocs` へ union (dedup)、attributed doc も lock 比較で `drifted` 判定。attributed doc からの再展開はしない。T001 / T002 が **Green** になることを確認
- [ ] T005 [US1] `src/graph/traverse.ts` 冒頭の設計コメントを spec 019 準拠に書き換え (FR-012): 「bidirectional は意図」「maxDepth で contains の広がりを抑える」の記述を削除し、contains 順方向限定 + 帰属アトリビューションのセマンティクスを spec 019 参照付きで記述

## Phase 3: 波及の固定 — US2 / US3

- [ ] T006 [P] [US2] plan-coverage の観測点テスト (FR-010): 同一 spec.md に REQ-001/005/009、`src/auth.ts` の 3 symbol が各々を claim する fixture で、`Files: src/auth.ts:validateToken` の per-entry `impactReqs` が REQ-001 のみ (AS2-1)、`depends_on REQ-007` 追加時は `[REQ-001, REQ-007]` (AS2-2) — `tests/plan-coverage*.test.ts` に追加
- [ ] T007 [P] [US3] check --diff のスコープテスト (FR-011): 同一 spec.md の REQ-A (実装あり) / REQ-B (実装なし) fixture で、(a) コードのみ diff → scoped `uncovered` に REQ-B なし (AS3-1)、(b) spec.md が diff に入る → REQ-B が `uncovered` に入る (AS3-2)、(c) 新 REQ 追記+実装の SDD ループ無退行 (AS3-3) — `tests/check*.test.ts` に追加
- [ ] T008 [US1] issue #215 再現手順の CLI E2E (SC-001): `tests/impact-cli.test.ts` に最小再現 fixture の `impact <file>:<symbol> --format json` を追加し、手順 1/2 非再現・手順 3 不変を assert

## Phase 4: 既存テストの期待値反転

- [ ] T009 既存テストスイートを実行し、兄弟 REQ / 兄弟 task / doc 経由到達を expect して落ちるテストを列挙 → 各々を新セマンティクスの期待値に書き換える。**書き換えた全テストを PR 本文に列挙する** (spec 前提: 削除ではなく期待値の反転としてレビュー可能にする)
- [ ] T010 tag-zero brownfield E2E (#122 系) が**無変更で** green であることを確認 (SC-003)。spec 016 系の二軸テスト (originReqs) が green のまま維持されることを確認 (SC-002)

## Phase 5: Polish — ドキュメント・最終確認

- [ ] T011 [P] [US5] README / docs/skills-guide.md の impact 説明を新セマンティクスに更新 (FR-013): 「同一 spec 同居は blast radius に入らない」「feature 文脈は affectedDocs の spec を読む」。旧挙動を前提にした記述 (1 spec 複数 REQ の制約回避策等) があれば削除
- [ ] T012 [P] [US5] `artgraph-impact` / `artgraph-plan-coverage` Skill テンプレートに旧セマンティクス前提の記述があれば更新し、dogfood テンプレート 5 agent path の byte-identical 同期テスト green を維持 (該当記述がなければ「変更不要」と PR に明記)
- [ ] T013 全 suite green 確認: `pnpm typecheck && pnpm test:unit && pnpm test:e2e && pnpm knip` (SC-004)
- [ ] T014 dogfooding 確認 (SC-005): ビルド済み CLI (`node dist/cli.js`) を `~/artgraph-dogfooding` (specs 001〜004 + src/todo.ts) に対して read-only 実行し、`impact src/todo.ts:<symbol>` が当該 symbol の claim + コード依存由来の REQ のみ返すことを確認、結果を PR 本文に記載

## Dependencies (完了順)

```
T001, T002 (Red)
  └─> T003 → T004 (Green) → T005
        └─> T006, T007, T008 (並行可)
              └─> T009 → T010
                    └─> T011, T012 (並行可) → T013 → T014
```

## Implementation Strategy

- コア (T003/T004) は 10 行前後の差分に収まる見込み。大半の工数は fixture 作成と既存テストの期待値反転 (T009)。
- `ImpactResult` の型・JSON スキーマは不変のため、スキーマ系スナップショット / contract テストは原則影響を受けない。落ちる場合は到達集合の値変化によるものなので、期待値のみ更新する。
- コミットは論理単位の日本語 conventional commits: (1) Red テスト、(2) traverse コア + コメント、(3) 波及テスト、(4) 既存テスト反転、(5) docs。CHANGELOG / version は触らない (release-please)。
