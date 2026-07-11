# Tasks: symbol mode のクラスメソッド粒度

**Input**: [spec.md](./spec.md) / [plan.md](./plan.md)

## 進め方 (TDD: Red ⇒ Green ⇒ 7観点で固める ⇒ 追随 ⇒ Polish)

コア変更は `src/parsers/typescript.ts` に閉じる。まず US1/US2 の失敗テストで Red を確認し、パーサ実装で Green にし、その後 **7 観点のテストマトリクス** (下表) で漏れなく固め、既存テストの期待値反転とドキュメント追随で仕上げる。

## 7 観点 → タスク対応表 (レビュー観点の網羅証明)

| 観点 | タスク |
|------|--------|
| 1. 境界条件 | T010 (1行クラス/同一行開始/遡上下限/tie)、T011 (空クラス・メンバー0・最終メンバー後タグ)、T012 (maxDepth hop 増加) |
| 2. 条件分岐の組み合わせ | T013 (export 形態 × メンバー種別マトリクス)、T014 (同名収束の組み合わせ: get+set / static+instance / オーバーロード / 三種混合) |
| 3. 不正な状態遷移 | T015 (旧 lock → 新 scan → check/reconcile の遷移)、T016 (warm parse-cache の旧 fragment と SCHEMA_VERSION) |
| 4. 例外系・失敗時の挙動 | T017 (構文エラー時の fatal-syntax fallback)、T018 (unresolvedSymbol / file mode 入力 / barrel 経由指定) |
| 5. 実運用で起きやすい事故 | T019 (メソッド編集→クラス+メソッド両 drift と check --diff baseline)、T020 (文字列 export 衝突 warning / 二重 export)、T021 (クラス rename 後のメソッドタグ orphan) |
| 6. エッジケース | T022 (デコレータ / JSDoc + leading-trivia / 浮きタグ次メンバー帰属)、T023 (computed / private / データプロパティのクラス帰属フォールバック) |
| 7. 考慮漏れ (変更外ファイル) | T024 (oxc-regression 期待値反転 + ts-morph contract コメント)、T025 (renderer / doctor / graph diff / lock byte-stability の無退行)、T026 (spec 016/018/019 系テスト + tag-zero E2E の無変更 green)、T030-T032 (docs/Skills/spec 019 追記) |

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 直前フェーズ完了後、同フェーズ内で並行実行可能 (異なるテストファイル・依存なし)
- **[USn]**: spec.md の User Story 対応

## Path Conventions

単一パッケージ。ソースは `src/`、単体テストは `tests/*.test.ts`、E2E は `tests/e2e/`。

## Phase 1: Red — コア失敗テスト

- [X] T001 [US1] issue #218 再現 fixture の単体テストを `tests/typescript.test.ts` に追加: `standaloneFn` (`@impl REQ-901`) + `class Sample { methodA (@impl REQ-902) / methodB (@impl REQ-903) }` を symbol mode でパースし、(a) `symbol:...#Sample.methodA` / `#Sample.methodB` ノードが存在、(b) implements 辺が各メソッドシンボル起点、(c) クラスシンボル `#Sample` も併存 (クラス全体スパン)、(d) class→method の contains 辺 (provenance structural) — 現行実装で **Red** を確認
- [X] T002 [P] [US1] 帰属の Red テスト (`tests/typescript.test.ts`): (a) クラス直上タグ→クラス (AS1-2)、(b) メソッド本文内タグ→メソッド (AS1-3)、(c) JSDoc 越しの leading-trivia (AS1-4)、(d) 非 export クラス→ファイル帰属のまま (AS1-6)
- [X] T003 [P] [US2] traverse fixture の Red テスト (`tests/traverse.test.ts`): 手組みグラフ (class symbol + method symbols + contains + implements) で (a) メソッド起点 `impactReqs` = 自 claim のみ (US2-1)、(b) クラス起点 = 全メンバー REQ (US2-2)、(c) consumer file→imports→class 起点で全メンバー REQ 到達 (US2-3)、(d) メソッド起点の `affectedFiles` に consumer 非包含 (US2-7)、(e) メソッドの親クラスが `affectedDocs` に混入しない (FR-008)、(f) `resolveStartIds` がメソッド entry (`{path, symbol: "Sample.methodA"}`) で親クラス・親 file ノードを `startIds` に seed しない (FR-010 — spec 016 R-006 テストの延長) — ※ (a)-(f) は spec 019/016 実装済みセマンティクスの検証なので手組みグラフでは Green になるはず。パーサ統合後の E2E (T028) で実コードから Red→Green を確認する

## Phase 2: Green — パーサ実装 (直列、typescript.ts の同一領域を触るため 1 レーン)

- [X] T004 [US1] `src/parsers/typescript.ts`: インライン export クラス (named / default) のメンバー走査を実装。対象メンバー判定 (FR-001/FR-004 の包含・除外リスト)、`ClassName.memberName` 命名 (default は `default.`)、メンバースパン (デコレータ含む) の contentHash — T001 の (a)〜(c) を Green に
- [X] T005 [US1] 同名メンバー収束 (FR-003): 名前ごとに出現を集約し、1 シンボル + 全出現テキストの `\0` 連結 hash + 各出現への attribution range。tie/順序: SymbolRange はクラス → メンバーの順に登録 (FR-002)
- [X] T006 [US1] attribution range の遡上制約 (FR-002): メンバーの leading-trivia 遡上に下限 (クラス宣言開始行を越えない) を実装 — T002 を Green に
- [X] T007 [US1] class→method `contains` 辺の emit (FR-006) — T001(d) を Green に。既存シンボル名との ID 衝突はメンバー優先 + build warning (FR-001)
- [X] T008 `src/parse-cache.ts`: `SCHEMA_VERSION` bump (理由コメント付き、既存慣行どおり)
- [X] T009 `pnpm typecheck && pnpm test:unit` を実行し、Phase 1 の Red がすべて Green、既存テストの fail を列挙 (この時点では修正しない — T024/T026 の入力にする)

## Phase 3: 7観点テストマトリクス (T009 完了後、すべて [P] — テストファイル単位で分担可)

- [X] T010 [P] 境界条件 1 (`tests/typescript.test.ts`): (a) 1 行クラス `export class S { m() {} }` でクラス直上タグがクラスに帰属 (tie でクラス勝ち)、(b) `export class S { m() {` の同一行開始でクラス直上タグをメソッドが横取りしない (遡上下限)、(c) クラス宣言とメンバーの間 (開き括弧直後) のタグの帰属が決定的
- [X] T011 [P] 境界条件 2 (`tests/typescript.test.ts`): (a) 空クラス (メンバー 0) — メソッドシンボル 0・contains 0・クラスシンボルのみ、(b) 最終メンバー後〜閉じ括弧のタグ→クラス帰属、(c) メンバー 1 個だけのクラス
- [X] T012 [P] 境界条件 3 (`tests/traverse.test.ts` or `tests/impact-cli.test.ts`): `maxDepth` 指定時に class→method→REQ が 2 hop になることの固定 (maxDepth=1 でメソッド REQ に届かない、=2 で届く)
- [X] T013 [P] 分岐組み合わせ 1 (`tests/typescript.test.ts`): export 形態 × メンバー種別のマトリクス — {inline named, inline default, 分離 export (対象外), alias export (対象外), 非 export (対象外)} × {method, getter, setter, static method, arrow-fn property, data property (対象外), computed (対象外), private #m (対象外), `accessor` フィールド (対象外), abstract/declare (対象外), static block (対象外)} の代表格子。二重 export (inline default + 分離 named) で 1 セットのみ生成
- [X] T014 [P] 分岐組み合わせ 2 (`tests/typescript.test.ts`): 同名収束 — (a) get+set ペア (両出現へのタグがともに同一シンボル帰属、setter 編集で hash 変化 = `\0` 連結の検証)、(b) static+instance 同名、(c) オーバーロード宣言 2 + 実装 1 (実装本体の編集で hash 変化)、(d) get+set の間に別メンバーが挟まる場合 (間のメンバー編集で hash 不変)
- [X] T015 [P] 不正状態遷移 1 (`tests/check-baseline-diff.test.ts` or `tests/lock.test.ts`): 旧 lock (メソッドシンボルエントリなし) の状態で新パーサ scan → `check` — 新規シンボルは lock 不在で drift にならない (lock[id] 不在は skip)、`reconcile` 後に lock へ追加され byte-stable
- [X] T016 [P] 不正状態遷移 2 (`tests/parse-cache.test.ts`): SCHEMA_VERSION bump により旧 fragment が invalidate され、warm/cold の scan 結果が byte-identical
- [X] T017 [P] 例外系 1 (`tests/typescript.test.ts`): 構文エラーを含むファイルの fatal-syntax fallback 経路でクラスメンバー抽出がクラッシュせず、従来の fallback 挙動 (file 粒度) に落ちる
- [X] T018 [P] 例外系 2 (`tests/impact-cli.test.ts`): (a) `impact src/a.ts:Sample.doesNotExist` → unresolvedSymbol exit 1 + メソッド対応の hint 文言 (US3-2)、(b) file mode graph への `:Sample.methodA` 入力 → 既存ガイダンス exit 1 (US3-3)、(c) barrel 経由 `src/barrel.ts:Sample.methodA` → unresolvedSymbol (Edge Case)
- [X] T019 [P] 実運用事故 1 (`tests/check-baseline-diff.test.ts`): メソッド編集でメソッド+クラス両シンボルが drift する二重報告の固定と、`check --diff` の baseline (#237 の graph union 込み) で「編集していない側の pre-existing 負債」が新規扱いされないこと
- [X] T020 [P] 実運用事故 2 (`tests/typescript.test.ts` + `tests/builder.test.ts`): (a) `export { helper as "Sample.methodA" }` と `class Sample { methodA }` の同居 → メンバー優先 + warning (無言破棄しない)、(b) 衝突警告の決定性 (scan 2 回で同一出力)
- [X] T021 [P] 実運用事故 3 (`tests/rename-cli.test.ts` or `tests/typescript.test.ts`): クラス名 rename 後、旧 `Sample.methodA` 宛て `Files:` エントリが unresolvedSymbol 診断に乗る (無言で file 粒度に落ちない)
- [X] T022 [P] エッジケース 1 (`tests/typescript.test.ts`): (a) デコレータ付きメソッドの attribution がデコレータ上のコメントに届く、(b) メンバー間の浮きタグは**次メンバー**帰属 (FR-002b の実機構固定)、(c) 連続コメント + 空行の遡上
- [X] T023 [P] エッジケース 2 (`tests/typescript.test.ts`): computed name / private `#m` / データプロパティ / `accessor` フィールド直上のタグがクラスへフォールバック (FR-004)、constructor は `ClassName.constructor` でシンボル化
- [X] T024 [P] 考慮漏れ 1: `tests/typescript-oxc-regression.test.ts` の期待値反転 (「クラスはメンバーシンボルを持たない」前提の全ケース列挙 → 新セマンティクスへ) + `typescript.ts` 冒頭 ts-morph contract コメントの書き換え (SC-003)
- [X] T025 [P] 考慮漏れ 2: renderer (`tests/graph-render.test.ts`)・doctor・graph diff がメソッドシンボル/symbol→symbol contains でクラッシュ・誤動作しないことの確認 (必要ならテスト追加、問題なければ既存 green の確認記録)
- [X] T026 [P] 考慮漏れ 3: spec 016 二軸 / spec 018 re-export / spec 019 containment / tag-zero brownfield の各既存テストが**無変更で** green (SC-002 の確認記録)

## Phase 4: 波及の固定 — E2E (Phase 3 と並行可、実 CLI 経由)

- [X] T027 [US2] `tests/plan-coverage.test.ts`: `Files: src/auth.ts:Sample.methodA` の per-entry 二軸 (impactReqs = originReqs = メソッド claim のみ、US2-6)。クラス unit エントリの originReqs にメソッド claim 非継承 (Edge Case)
- [X] T028 [US1][US2] `tests/impact-cli.test.ts`: issue #218 再現手順の E2E (SC-001) — 実コード fixture を scan し、**2 つの CLI 呼び出し**で assert: (a) `impact <file>:Sample.methodA --format json` で US2-1 (自 claim のみ)・US2-7 (consumer 非包含)・US2-4 (`this.methodB()` 呼び出しが fixture にあっても REQ-903 非到達 — call-graph 非解決の固定)、(b) `impact <file>:Sample --format json` (クラス unit) で US2-2 (全メンバー REQ 包含)
- [X] T029 [US3] `tests/sdd-files-parser.test.ts` or 既存 suite: `Files: src/a.ts:Sample.methodA` の Stage A 抽出が文法変更なしで通る固定 (US3-1)

## Phase 5: ドキュメント / Skill (Phase 2 完了後いつでも並行可 — コードと独立)

- [X] T030 [P] [US4] README / docs/skills-guide.md: メソッド粒度の記法・使いどころ、「standalone function に分割」旧回避策の削除、メソッド起点 = ファイル内精度 (consumer 非包含) の裁定、maxDepth 注記 (FR-013)。更新後、旧制約記述 (「メソッド粒度を持たない」「standalone function に分割」等) の全文検索で残存ゼロを確認 (US4-1)
- [X] T031 [P] [US4] `templates/skills/artgraph-impact`・`artgraph-plan-coverage`・`artgraph-bootstrap` SKILL.md + `_shared/output-schema.md` (該当あれば): メソッド記法・bootstrap のクラスメンバータグ提案。5 agent path byte-identical 同期 (FR-013)
- [X] T032 [P] [US4] `specs/019-impact-doc-containment/spec.md` の Edge Case「autoContains: false なら contains 辺が存在しない」へ doc 系限定の追記 (FR-013c)

## Phase 6: Polish — 最終確認

- [X] T033 全 suite green: `pnpm typecheck && pnpm test:unit && pnpm test:e2e && pnpm knip` (SC-003/SC-005)。scan 2 回 byte-identical・reconcile 後 lock byte-stable の確認
- [X] T034 dogfooding 確認 (SC-004): `~/artgraph-dogfooding` に TodoStore クラス (メソッドごとに別 REQ) を**一時 fixture として scratchpad に**試作し、ビルド済み CLI で `impact` がメソッド単位の REQ を返すことを確認 (dogfooding リポは read-only、コミットしない)。結果を PR 本文に記載

## Dependencies (完了順) と並行委譲レーン

```
T001, T002, T003 (Red — [P] 3 ファイル別、並行可)
  └─> T004 → T005 → T006 → T007 → T008 → T009 (Green — typescript.ts 直列 1 レーン)
        ├─> T010..T026 (7観点マトリクス — すべて [P]。ただし typescript.test.ts に書く
        │    タスク同士 (T010/T011/T013/T014/T017/T020/T022/T023) は同一ファイル編集の
        │    ため 1 エージェントにまとめるか、ファイル分割を検討)
        ├─> T027, T028, T029 (E2E — [P])
        └─> T030, T031, T032 (docs — [P]、コードと独立)
              └─> T033 → T034 (最終確認 — 直列)
```

**サブエージェント並行委譲の推奨構成** (無理に分割しない — 各レーンは自己完結):

- **レーン A (コア、1 エージェント直列)**: T001〜T009。typescript.ts と typescript.test.ts を占有
- **レーン B (traverse/E2E 系)**: T003 (Red 時点)、T012 / T015 / T016 / T018 / T019 / T021 / T024 / T025 / T026 / T027 / T028 / T029 — typescript.test.ts 以外のテストファイル群。レーン A の T009 完了後に起動
- **レーン C (typescript.test.ts 観点群)**: T010 / T011 / T013 / T014 / T017 / T020 / T022 / T023 — レーン A と同一ファイルのため、レーン A 完了後に同一エージェント続投 or 別エージェント
- **レーン D (docs、完全独立)**: T030 / T031 / T032 — レーン A の設計が確定した時点 (T009 後) でいつでも
- 最後に統合エージェント (または親) が T033 / T034 とコンフリクト解消

## Implementation Strategy

- コミットは論理単位の日本語 conventional commits: (1) Red テスト、(2) パーサコア (T004-T008)、(3) 7観点テスト群、(4) 既存テスト反転、(5) E2E、(6) docs。CHANGELOG / version は触らない (release-please)。
- typescript.ts は既存の pass 1 / pass 2 構造・`push()` ヘルパー・attribution 機構を壊さないこと。メンバー走査は pass 2 の ClassDeclaration 分岐からの追加呼び出しとして実装し、既存経路の挙動 (クラスシンボル自体) をバイト単位で変えない。
- 期待値反転は削除ではなく反転として PR に列挙 (spec 019 と同じ運用)。
