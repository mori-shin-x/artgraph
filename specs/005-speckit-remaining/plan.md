# Implementation Plan: plan.md / tasks.md タスクノード化 + タグエッジ抽出 (Issue #28 / FR-009 / FR-010 / FR-012)

**Branch**: `feat/issue-28` | **Date**: 2026-06-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-speckit-remaining/spec.md`（005 内の FR-009 / FR-010 と Clarifications Session 2026-06-24 で追加した FR-012 を対象）

## Summary

Spec Kit の `plan.md` / `tasks.md`、および Kiro の `tasks.md` 等から **task ノード** を抽出し、`@impl(target-id)` タグから `task → implements → target` エッジを、`[REQ-xxxx]` タグから `task → verifies → target` エッジを生成する。タスク ID パターンは**規約プリセット** (`TaskConventionPreset`) で抽象化し、Built-in に `spec-kit` (`T\d+`) と `kiro` (`\d+(?:\.\d+)*`) を提供する。OpenSpec 等の追加対応は `.artgraph.json` の `taskConventions` フィールドにプリセットを 1 件足すだけで完結する設計とする。

エッジ target は**自由形式 ID** として無条件に生成し、解決は builder 段の既存ロジック (`orphan-doc` 系警告) に委ねる。`[REQ-XXX]` の prefix は剥がさず、現行 TS パーサ (`typescript.ts:254`) と一貫した ID 形式で扱う。

## Technical Context

**Language/Version**: TypeScript (Node.js >= 20, ESM `"type": "module"`)

**Primary Dependencies**:
- `unified` + `remark-parse`（既存 markdown AST、`packages/artgraph/src/parsers/markdown.ts:5`）
- `mdast-util-to-string`, `unist-util-visit`（既存）
- 新規依存追加なし。`yaml` は PR #43 マージ後の状態を前提（前提条件参照）

**Storage**: 既存と同様、ファイルシステム上の `.trace.lock` と spec/code 直接スキャン。

**Testing**: vitest（`packages/artgraph/tests/`、既存 565 件のテストフィクスチャパターンを踏襲）

**Target Platform**: Node.js CLI（Linux/macOS/Windows、`relative()`/`dirname()` は既存のパス正規化を踏襲）

**Project Type**: pnpm workspace モノレポ、`packages/artgraph` が単一 CLI。

**Performance Goals**:
- 既存 `parseMarkdown` 関数内に regex マッチを追加するのみ。1 ファイルあたり追加コストはタスク行数 × 数十 ns 程度。
- FR-012 のプリセット適用は file-stem 一致時のみのため、通常の spec.md/design.md/requirements.md には影響なし（O(0) 追加）。
- NFR-002（既存 5% パフォーマンス劣化上限）に準拠。

**Constraints**:
- Constitution Principle I (Determinism First): 抽出はすべて regex / AST のみ。LLM 不使用。
- Constitution Principle V: 構造整合のみ生成。`@impl(X)` の X 存在チェックは parser では行わず builder に委ねる。
- 既存 565 件のテストを破壊しない（後方互換）。`taskConventions` 未設定でデフォルトプリセットが動くと既存 fixture の `tasks.md`（空に近い）から task ノードが新規生成されることに注意 → fixture 検査の必要あり（Phase 0 で確認）。

**Scale/Scope**:
- 想定: 1 リポジトリあたり spec ディレクトリ 10–50 個、各タスクファイル 10–200 行。
- 影響ファイル: `types.ts`、`config.ts`、`parsers/markdown.ts`、`graph/builder.ts`、`scan.ts`、`coverage.ts`(判断要)、`graph/format.ts`、`graph/traverse.ts`(`task` の取扱)。
- 新規テスト: 規約プリセット別 × タグ別 × エッジケースで概算 15–25 件。

## Constitution Check

*GATE: Phase 0 research の前に必須通過。Phase 1 設計後に再評価する。*

| Principle | 関連性 | 判定 | 根拠 |
|---|---|---|---|
| I. 決定的グラフ第一 (Determinism First) — NON-NEGOTIABLE | 高 | **PASS** | タスク抽出は file-stem 一致 + regex のみ。タグ抽出 (`@impl`, `[REQ-]`) も regex。LLM 推定なし。同入力 → 同出力。 |
| II. 単一型付き4層グラフ (Single Typed Four-Layer Graph) | 高 | **要 justify** | 新規 `task` NodeKind を導入する（既存 4 型 `req/doc/code/test` への写像を検討した結果、req 流用は edge 方向矛盾を生むため棄却）。Complexity Tracking で正当化。 |
| III. Spec が ID を所有、コードが claim — NON-NEGOTIABLE | 中 | **PASS** | task ID は Spec Kit / Kiro が発行（T001, 1.1 等）。artgraph 側で新規 ID を発行しない。 |
| IV. SDD ツール ID 直接利用 | 中 | **PASS** | T001 / 1.1 等を**そのまま** task ノード ID として採用。独自レイヤーなし。`taskConventions` は SDD ツール側 ID の認識規約に過ぎず、artgraph 独自 ID ではない。 |
| V. 構造整合のみ保証 — NON-NEGOTIABLE | 中 | **PASS** | `@impl(X)` の X 妥当性検証 / `[REQ-]` の target 解決は構造的（既存ノードと突合）。意味判定（タスクが本当に実装を表すか等）は行わない。orphan は警告のみ。 |

→ Principle II は Complexity Tracking で正当化（下記）。他は PASS。

## Project Structure

### Documentation (this feature)

```text
specs/005-speckit-remaining/
├── spec.md                  # 既存（Clarifications Session 2026-06-24 追記済）
├── plan.md                  # 本ファイル
├── research.md              # Phase 0: 規約プリセット詳細・edge 競合分析
├── data-model.md            # Phase 1: TaskNode / TaskConventionPreset 設計
├── quickstart.md            # Phase 1: 動作検証手順
├── contracts/
│   ├── parser-api.md        # parseMarkdown シグネチャ拡張
│   └── config-schema.md     # .artgraph.json taskConventions スキーマ
├── checklists/
│   └── requirements.md      # 既存（FR-009/010 を本クラリフィケーションで checked）
└── tasks.md                 # Phase 2 出力 (/speckit-tasks 後続)
```

### Source Code (repository root)

実体は monorepo の `packages/artgraph/` 配下のみ。Issue #28 で触れるファイルを ▶ で示す。

```text
packages/artgraph/
├── src/
│   ├── types.ts                    ▶ NodeKind に "task" 追加 / TaskConventionPreset / ArtgraphConfig.taskConventions
│   ├── config.ts                   ▶ taskConventions のロード + バリデーション
│   ├── parsers/
│   │   ├── markdown.ts             ▶ task 抽出 + @impl(...) / [REQ-...] タグ抽出を追加
│   │   └── typescript.ts           （変更なし。@impl 哲学を踏襲）
│   ├── graph/
│   │   ├── builder.ts              ▶ task ノード登録、contains エッジ拡張 (doc→task)、ID 名前空間衝突解決の対象拡張
│   │   ├── format.ts               ▶ NodeKind union 更新による型整合（output 表示は既存ルール踏襲）
│   │   └── traverse.ts             ▶ task を traversal の出発点として認める（lock 連動は判断後）
│   ├── coverage.ts                 ▶ task が impl/verify の **source** であるため、coverage 集計には含めない（既存 `kind !== "req"` フィルタを維持）
│   ├── scan.ts                     ▶ ScanSummary に taskCount を追加
│   ├── cli.ts                      ▶ `graph` サブコマンドの `--kind` フィルタ拡張（型のみ）
│   └── ...（既存ファイル群、変更なし）
├── tests/
│   ├── fixtures/
│   │   ├── conventions/specs/speckit-feature/
│   │   │   ├── plan.md             ▶ @impl(...) タグ入り T001/T002 を追加
│   │   │   └── tasks.md            ▶ [REQ-...] タグ入り T010/T011 を追加
│   │   └── conventions/specs/kiro-feature/
│   │       └── tasks.md            ▶ 階層数字 1 / 1.1 / 1.1.1 に @impl(...), [REQ-...] を追加
│   ├── parsers/
│   │   └── markdown.test.ts        ▶ task 抽出 / @impl エッジ / [REQ-] エッジのユニットテスト
│   └── builder.test.ts             ▶ contains (doc→task) / 衝突解決 / mixed-tool プリセット並列適用の統合テスト
└── package.json
```

**Structure Decision**: `packages/artgraph/src/parsers/markdown.ts` 内で task 抽出と全タグ抽出を完結させる（パーサ責務）。builder 側は task を req と同様の名前空間管理に組み込む（id 衝突解決対象に追加）。新規ファイル作成は不要。`graph/conventions.ts` への分割は YAGNI（プリセット定数は 2–3 件のみ）。

## Complexity Tracking

> Constitution Check の Principle II 違反（新規 `task` NodeKind 追加）の正当化。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| 新規 `task` NodeKind の追加（現行 5 NodeKind → 6 NodeKind、Constitution Principle II の 4 抽象層宣言は不変） | (a) FR-009 の `task → implements → target` は task が edge の **source** となるが、現行 `req` は `implements`/`verifies` の **target** のみ。同じ `req` 型に source/target 両方の役割を担わせると、coverage 集計 (`kind === "req"` でフィルタ) と衝突。<br>(b) Spec Kit の T001 と spec.md の FR-001 はライフサイクル・所有者・粒度が異なる（HOW vs WHAT）。区別を失うと impact 分析の精度低下。<br>(c) Constitution Principle III「Spec が ID を所有」の "Spec" はトップレベル要件であり、`tasks.md` の T001 は実装段のラベル。同一視は原則 III の境界を曖昧化する。 | **Alt-1**: `req` 流用 — 上記 (a) のとおり edge 方向矛盾と coverage 集計汚染を生む。<br>**Alt-2**: `doc` 粒度に集約（個別 task ノードを作らず `doc → target` エッジのみ） — plan.md 内の複数タスクが 1 ノードに集約され、precise impact 分析ができない（user story 3 の「spec → plan → code 完全トレース」を満たせない）。<br>**Alt-3**: edge 方向を逆向き (`target → implements → task`) に再定義 — FR-009 spec 文「タスクノードから実装先への」と矛盾し、既存 `implements` の語義（"X is implementation of Y"）に反する。 |

逸脱の許容根拠: Constitution「逸脱の扱い」より、Principle II は non-negotiable ではなく Complexity Tracking で justify した場合に limited deviation が許容される。

**ガードレール** (spec.md Clarifications §CV1 / 2026-06-24): 本 PR の 5 ノード型化は **本 feature 内での限定的逸脱** として扱い、Constitution 本文（4 ノード型宣言）は本 PR では変更しない。将来さらに NodeKind を追加する PR は同様に Complexity Tracking で個別 justify を要求し、「5 ノード型が事実上の新基準」として黙認されない運用を維持する。累積 3 件目の NodeKind 追加時には Constitution 改訂を検討する。

## Post-Design Constitution Re-check

Phase 1 設計 (data-model.md / contracts/ / quickstart.md) 完了後の再評価:

| Principle | Phase 0 判定 | Phase 1 後判定 | 差分 |
|---|---|---|---|
| I. 決定的グラフ第一 | PASS | **PASS** | 設計は regex / file-stem 一致のみ。LLM 不使用を確認。 |
| II. 単一型付き4層グラフ | 要 justify | **要 justify (Complexity Tracking 記載済)** | `task` NodeKind 追加は data-model.md §1 で詳細化、波及範囲 ~150 行に収束（接合点最小化を確認）。 |
| III. Spec が ID を所有 | PASS | **PASS** | data-model.md §1 で task ID は SDD ツール発行と明記。 |
| IV. SDD ツール ID 直接利用 | PASS | **PASS** | contracts/config-schema.md §既定値 builtin で T### / 階層数字を直接利用。 |
| V. 構造整合のみ保証 | PASS | **PASS** | data-model.md §5 §6 で自由形式 target は構造的に edge 生成し、解決は builder/警告に委譲（意味判定しない）。 |

Phase 1 設計に新たな違反は導入されず、Phase 0 の justify が継続有効。

## Phase 0 Research — Resolved Items

Phase 0 で挙げた研究項目はすべて [research.md](./research.md) で解消済（Status: Closed）。本セクションは参照テーブルのみを保持する:

| # | 元の問い | 解決先 |
|---|---|---|
| 1 | Kiro の `tasks.md` 実フォーマット | [research.md §R1](./research.md) — 階層数字 `\d+(?:\.\d+)*` を採用、`.artgraph.json` で上書き可。実 Kiro リポジトリでの再確認は PR レビュー側に残課題として明記 |
| 2 | 既存 fixture への影響 | [research.md §R2](./research.md) — `grep -RnE '...'` で 0 件確認、tasks.md T014.5 に再現可能 inventory step を組み込み |
| 3 | `@impl` / `[REQ-]` のファイル別認識スコープ | [research.md §R3](./research.md) + [spec.md Clarifications U1](./spec.md#clarifications) — preset 適用ファイル全てで symmetric 認識 |
| 4 | C-3 convention edges との競合 | [research.md §R4](./research.md) — edge kind が異なるため衝突なし |
| 5 | `contains` を `doc → task` に拡張するか | [research.md §R5](./research.md) — 拡張する（tasks.md T019）|

Phase 1 設計後の追加課題（実 Kiro 形式の確認、累積 NodeKind 件数追跡など）は [tasks.md T030 PR 本文](./tasks.md) で明示的にハンドリング。
