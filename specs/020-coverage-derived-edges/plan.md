# Implementation Plan: カバレッジ由来トレーサビリティ (`exercises` エッジ)

**Branch**: `feat/coverage-derived-edges` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: spec 020 / 設計セッション 2026-07-10(PoC 検証済み — [research.md](./research.md) R1)

## Summary

`[REQ-NNN]` タグ付きテストを per-test 精密カバレッジ付きで実行し(Vitest カスタムランナー)、REQ ごとの実行シンボル集合から `exercises` エッジ(第 3 の認識論的クラス「実行証拠」)を決定的に導出する。trace 成果物を scan の**入力アーティファクト**として形式化し(`graph = f(files, trace)`、spec 006 と同型)、(a) タグゼロ・トレーサビリティ、(b) `@impl` 監査(UNEXERCISED CLAIM / SUGGESTED IMPL)、(c) `impact --tests` テスト選択、(d) オプトイン `exercised` 充足、(e) contentHash 照合による staleness 管理を実現する。実装は Phase A(採取+レポート、グラフ非改変)→ B(scan/lock 統合)→ C(check/impact/Skills)の 3 段で、各段が独立レビュー・独立リリース可能。

**Constitution 改訂が前提**(原則 I / III の MINOR 改訂 → v1.2.0)。改訂 PR 文面は [constitution-amendment.md](./constitution-amendment.md) に用意済みで、**Phase B 着手前の承認・マージが必須**。Phase A はグラフ・lock・判定を一切変更しないため改訂前に着手可能。

## Technical Context

- **Language/Runtime**: TypeScript strict / Node.js >= 22(既存)。pnpm。vitest(unit / e2e / perf)。oxlint / oxfmt / knip。
- **新規配布面**: `package.json#exports` に `./vitest` を追加(`artgraph/vitest` = カスタムランナー + 推奨 config ラッパー)。vitest は **optional peerDependency**(`>=3 <5`、Runner API `onBeforeRunTask`/`onAfterRunTask` は experimental — CI で 3.x / 4.x のマトリクステストを張る)。CLI 本体は vitest 非依存を維持(runner モジュールのみが `vitest/runners` を import)。
- **カバレッジ取得**: ワーカー内 `node:inspector` Session + `Profiler.startPreciseCoverage({callCount: true, detailed: false})` + テスト前後の `takePreciseCoverage`(カウンタリセット仕様を利用した per-test 差分)。forks / threads 両プール対応(PoC 済み)。`detailed: false` で block 粒度を落としオーバーヘッドを削る(必要なのは関数粒度の実行有無のみ)。
- **trace 成果物**: `.artgraph/trace/*.jsonl`(ワーカーごとに独立ファイル — 書込み競合を設計で排除)。scan/ingest が読み込み時に決定的に正規化(boolean 化・ソート・和集合)。世代管理は run 開始時の旧シャード削除(config ラッパーが仕込む globalSetup で実施)。
- **シンボル join**: 「相対パス × 関数名」。scan 時に `extractSymbols`(`src/parsers/typescript.ts`)から**名前表**(export 名 → symbol id、クラスは member 名 → クラス symbol id)を構築して照合。同一ファイル内で名前が曖昧・V8 合成名が不一致 → file 粒度フォールバック(spec 018 の fail-safe 規範)。source-map 復元は不採用([research.md](./research.md) D3)。
- **変更の中心**:
  - 新規: `src/vitest/runner.ts`(配布 runner)、`src/trace/`(shard 読込・正規化・REQ join・名前表 join)、`src/commands/trace.ts`(`trace report` / `trace status`)
  - 拡張: `src/types.ts`(edge kind `exercises`、provenance `coverage`、config `trace.*`、status `exercised`)、`src/graph/builder.ts`(trace 由来エッジのマージ)、`src/lock.ts`(`exercises?: string[]` — `impl` と同じ byte-stable 規約)、`src/check.ts` / `src/coverage.ts`(所見 3 種 + `exercised`)、`src/graph/traverse.ts`(exercises 到達 + `--tests` 逆引き)、`src/rename-lock.ts` 系(trace 内 ID 書換え)
  - Skills: `templates/**` の bootstrap / verify / impact(5 agent path 同期)

## Constitution Check

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ⚠️ **要改訂(手当済み)** — 現行の導出元列挙(frontmatter / ID タグ / TS AST)に trace が含まれない。改訂 v1.2.0([constitution-amendment.md](./constitution-amendment.md))で「正規化済みテスト実行トレース成果物」を第 4 の導出元として追加。決定性の実体は維持: LLM ゼロ、`graph = f(files, trace)`、同一入力 → byte-identical(spec FR-010/011、SC-002/007)。
- **II. 単一型付き4層グラフ**: ✅ ノード型は不変。エッジ型 `exercises` を 1 種追加するが、`implements`(意図の主張)への写像は**意味論が異なるため不可**(証拠が黙って主張に化けると原則 III の信頼境界が壊れる)— Complexity Tracking で正当化。トラバーサルは既存 BFS の辺種追加で賄い、独自スキーマの並走はしない。
- **III. Spec が ID を所有、コードが claim (NON-NEGOTIABLE)**: ⚠️ **要改訂(手当済み)** — 三段階カバレッジに第 4 状態 `exercised`(オプトイン時のみ)を追加。ID 所有権は不変(trace は spec 発行の ID を参照するだけ)。証拠は claim を**監査**する方向であり、「タグだけで安心する」を防ぐ非対称信頼境界はむしろ強化される。
- **IV. SDD ツール ID 直接利用**: ✅ trace 内 ID は既存 `reqPatterns` / `extractReqTags` の規則をそのまま使う。独自 ID 層なし。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ 「実行された」は観測可能な構造的事実。UNEXERCISED CLAIM は「エッジが存在しない」の報告であり意味判定ではない。SUGGESTED IMPL は**提案**として出力し、グラフ/lock への自動コミットはしない(承認は人間/エージェントのタグ追記経由 — Skill 側で運用)。

**Gate 裁定**: 原則 I / III への抵触は Constitution 改訂 v1.2.0 の承認を **Phase B の着手条件**とすることで解消する。改訂承認前に Phase B 以降へ進んではならない。Phase A(runner + trace + `trace report`)はグラフ・lock・check 判定を変更しないため原則抵触がなく、先行着手可。

### Engineering Hygiene Gates

- [x] **前提検証 (Cat6)**: spec 006(test-results 取込)/ spec 011(provenance 2 箇所同期 + SC-008)/ lock の byte-stable 規約 / テストノード file 粒度、を実コードで裏取り済み(research.md R4)。PoC で V8 側の挙動(カウンタリセット・関数名・オフセットずれ)も実測済み(R1)。
- [x] **ID 衝突 (Cat6)**: 本 spec は新規 REQ-ID を発行しない(FR/SC は spec 020 名前空間)。
- [x] **SSOT ペア (Cat2)**: (a) provenance union ↔ runtime Set(既存 SC-008 テストを `coverage` 込みで更新)、(b) runner が書く shard スキーマ ↔ ingest のパーサ(スキーマバージョンフィールド + 等価性テストをタスク化)、(c) Skills 5 path 同期(既存 dogfood テスト)。
- [x] **CLI 規約 (Cat5)**: `trace report|status` / `impact --tests` は `--format json|text`、`.choices()`(`staleness` 3 値)、trace 不在時の対称なエラー挙動(FR-018: exit 1 + 導入ガイダンス)、共有 ID regex を踏襲。
- [x] **走査仕様 (Cat7)**: `exercises` 辺は req → symbol|file の**順方向のみ**生成。impact の逆引き(code → req)は既存 BFS の逆方向走査に辺種を追加(spec 019 の contains 方向制約と干渉しないことをテストで固定)。dedup key は (reqId, nodeId)。stale 辺の走査可否は `staleness` 設定で分岐(FR-017)。

## Project Structure

### Documentation (this feature)

```
specs/020-coverage-derived-edges/
├── spec.md                     # 要求の SSOT
├── plan.md                     # 本ファイル
├── research.md                 # PoC / 先行事例 / Phase 0 設計判断 (D1〜D8)
├── data-model.md               # trace / エッジ / lock / status のデータモデル
├── contracts/
│   ├── trace-artifact.md       # shard JSONL スキーマ (runner ↔ ingest の契約)
│   └── cli-surface.md          # CLI / config / JSON 出力の契約
├── quickstart.md               # E2E 検証手順 (Phase A/B/C 別)
├── constitution-amendment.md   # 憲法 v1.2.0 改訂 PR 文面 (別 PR で提出)
├── checklists/requirements.md
└── tasks.md                    # /speckit-tasks (未生成)
```

### Source Code (repository root)

```
src/vitest/runner.ts          # Phase A: 配布 runner (vitest optional peer)
src/vitest/setup.ts           # Phase A: globalSetup (旧シャード削除) + withTrace() config ラッパー
src/trace/schema.ts           # Phase A: shard スキーマ + バージョン + 正規化
src/trace/ingest.ts           # Phase A: shard 読込 → REQ join → 名前表 join → 正規化 trace
src/commands/trace.ts         # Phase A: trace report / trace status
src/types.ts                  # Phase B: exercises / coverage / trace config / exercised
src/graph/builder.ts          # Phase B: trace エッジのグラフ合流 (FR-006〜008)
src/lock.ts                   # Phase B: exercises?: string[] (byte-stable)
src/rename-lock.ts ほか        # Phase B: trace 内 REQ ID 書換え (FR-016)
src/check.ts / src/coverage.ts # Phase C: 所見 3 種 + exercised + staleness (FR-012〜015)
src/graph/traverse.ts          # Phase C: exercises 到達 + --tests (FR-017〜018)
src/commands/impact.ts         # Phase C: --tests フラグ
templates/**(skills)           # Phase C: bootstrap / verify / impact (FR-019〜020, 5 path 同期)
tests/vitest-runner.e2e.ts     # runner を実 vitest で回す E2E (3.x/4.x マトリクス)
tests/trace-*.test.ts          # ingest / join / 正規化 / 決定性 / fail-safe
tests/check-evidence.test.ts   # UNEXERCISED CLAIM / SUGGESTED IMPL / exercised / stale
```

**Structure Decision**: 単一パッケージを維持(憲法 技術基盤)。runner は `src/vitest/` に隔離し、CLI 本体から `vitest/runners` への import が漏れないことを knip + 依存テストで固定する。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| エッジ型 `exercises` の追加(原則 II「既存型に写像できる限り追加しない」への逸脱) | 「実行された」(観測)と「実装している」(主張)は真理条件が異なり、突き合わせ(UNEXERCISED CLAIM)は両者が**別のエッジ**であって初めて表現できる | `implements` + provenance `coverage` のみで表す案は、証拠のみの対が `implements` を名乗り uncovered を黙って充足してしまう(原則 III の信頼境界の破壊)。オプトイン `acceptExercises` の意味論も表現不能 |
| 原則 I / III の改訂(v1.2.0) | 導出元列挙とカバレッジ三段階が字義上 trace / `exercised` を許容しない | 「AST 由来」への強弁は Governance の趣旨に反する。改訂は MINOR(原則の削除・再定義ではなく拡張)で、決定性・信頼境界という原則の意図は維持・強化される |

## Follow-up

- Jest / Playwright / ブラウザ実行対応(将来 spec — trace shard スキーマはランナー非依存に設計済み)
- TF-IDF 連続信頼スコア(Phase C の排他性 boolean 格付けの後継、research.md R3)
- [#218](https://github.com/mori-shin-x/artgraph/issues/218) — 証拠側はメソッド粒度を持つため、`@impl` 側のメソッド粒度化と合流させる設計検討
- [#25](https://github.com/mori-shin-x/artgraph/issues/25) — OpenSpec 見出し駆動 ID との組合せ(slug 派生 ID × テストタグ)
