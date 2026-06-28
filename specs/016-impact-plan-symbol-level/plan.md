# Implementation Plan: impact / plan-coverage の symbol-level 入力対応

**Branch**: `feat/impact-plan-symbol-level` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/016-impact-plan-symbol-level/spec.md`

## Summary

`Files: src/auth.ts:validateToken` のような **`path:symbol` syntax** を sdd-files parser に導入し、`artgraph impact` / `artgraph plan-coverage` の入力経路と出力スキーマを symbol 起点で clean に再設計する。型 / 関数 / JSON schema は本 spec で確定する最終形をそのまま採用する。

二軸出力でドリフト追跡を可能にするのが本 spec の中核価値:

- **`impactReqs`**: startId からの forward BFS で到達した REQ 集合(spec 014 の `reqs` field を rename + 意味を明確化)。
- **`originReqs`**: startId ノード (file or symbol) の `@impl` claim を **1-hop** 辿って得た REQ 集合。
- JSON consumer は `impactReqs \ originReqs` をクライアント側で計算し、「symbol が宣言した FR」と「実際に手を伸ばす範囲」のドリフトを検知できる(SC-003 / SC-006)。

技術的アプローチ:

- **parser** (`src/parsers/sdd-files.ts`): Stage A の inline / bullet エントリ抽出を `SymbolEntry { path, symbol?, line }` 単位に統一し、返り値型を **`entries: SymbolEntry[]` 一本** にする。trailing annotation 剥がし → 最初の `:` で 1 回 split → `path` / `symbol?` を埋める。
- **traverse** (`src/graph/traverse.ts`): start id 解決を **`resolveStartIds(entries: SymbolEntry[])` 一本** に統一。`symbol` 有り → `symbol:<path>#<name>`、なし → `file:<path>` の id を生成。symbol mode の検出は graph 内 symbol node の存在で判定。`impact()` 本体 (BFS ロジック) は不変。
- **CLI** (`src/cli.ts`): `impact` の引数バリデーションで `:` パターンを検出した時点で `SymbolEntry` に正規化して `resolveStartIds()` に渡す。`--from-tasks` 経由は parser 出力をそのまま渡す。text 出力は `impactReqs` / `originReqs` / ドリフト候補の 3 セクション。
- **plan-coverage** (`src/plan-coverage/index.ts`): ImpactGroup を `{ sourceFile, sourceSymbol?, impactReqs, originReqs }` で発出。`originReqs` は startId ノードから `implements` edge を 1-hop 辿った REQ 集合(file 入力で file-top `@impl` タグ無し → `[]`)。by-Req axis は `implicitImpactsByReq[].sourceLocations: Array<{file, symbol?}>` 一本(`sourceFiles` 廃止)。dedup キーは `(sourceFile, sourceSymbol ?? null)`。`unresolvedSymbol` diagnostic を発出。
- **docs / Skills**: `docs/skills-guide.md` に file vs symbol trade-off 表 + 二軸出力ガイド、Skill 本文 2 種に symbol 例 + `originReqs` 解釈追加。各 SKILL.md は 100 行以下を維持。

graph 側は spec 012 時点で `symbol:<path>#<name>` node 生成と `@impl` claim → `implements` edge 化が完成しているため、本 spec は **scan 側 / graph builder を一切触らない**。`init` のデフォルトモードも変更しない (FR-024)。

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js >= 20, ESM)

**Primary Dependencies**: ts-morph (symbol 抽出は既存), commander, unified + remark-parse, eemeli/yaml

**Storage**: ファイルシステム — `.artgraph.json`, `<lockfile>.json`, `specs/<NNN>-*/tasks.md`

**Testing**: vitest (unit / integration), in-process CLI ハーネス (`tests/helpers.ts`)

**Target Platform**: Node.js >= 20 (Linux / macOS / Windows POSIX 互換)

**Project Type**: CLI ツール + Claude Code Skills 配布物 (単一パッケージ; `src/` + `templates/` + `bin/artgraph`)

**Performance Goals**: `artgraph impact src/auth.ts:validateToken` を **2 秒以内** にローカル返答 (SC-002)。symbol 入力 1 件あたりの BFS は file 入力と同等オーダー(`impact()` 本体は不変)。

**Constraints**:

- Symbol node から `implements` edge を 1-hop 辿って `originReqs` を populate する(grpah builder 側の追加実装は不要; 既存 edge を再利用)。
- `impact()` 本体 (forward BFS) は **不変**。差分は start id 解決と出力組み立てのみ。
- 出力 JSON schema は **clean に置き換え** (`reqs` → `impactReqs`、`sourceFiles` → `sourceLocations`、新規 `originReqs` / `sourceSymbol?` 追加)。
- Skill 本文 (SKILL.md) を **各 100 行以下** に保つ (SC-004 / FR-030)。
- LLM 推定 / 確率的判定の混入禁止 (Constitution I)。

**Scale/Scope**: artgraph 本体は単一パッケージ 5-10 kLOC 規模。本 spec の差分は parser / traverse / CLI / plan-coverage の 4 ファイル中心 + Skills 2 / docs 2 で、推定 1500 行前後の差分 (実装 + tests + fixture)。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 評価 | コメント |
|---|---|---|
| I. 決定的グラフ第一 (NON-NEGOTIABLE) | PASS | parser の `:` split も symbol node lookup も `implements` edge の 1-hop 辿りも決定的。LLM 推定なし。`originReqs` / `impactReqs` のドリフト判定はクライアント側の集合差分で、artgraph 内では二軸を populate するだけ。 |
| II. 単一型付き4層グラフ | PASS | 新規ノード型 / エッジ型は追加しない。既存 `symbol` ノードと `implements` / `imports` / `verifies` エッジを再利用。`originReqs` は既存 `implements` edge の 1-hop 集約に過ぎず、グラフモデルへの新フィールド追加なし。 |
| III. Spec が ID を所有 (NON-NEGOTIABLE) | PASS | symbol 名は code 側の export 識別子で、REQ-ID は依然 spec.md が発行。本 spec は ID 所有権を変更しない。`originReqs` も既存 `@impl` claim を集計するだけで新規 ID 体系を導入しない。 |
| IV. SDD ツール ID 直接利用 | PASS | tasks.md の `Files:` syntax 拡張のみで Spec Kit / Kiro の ID 体系には触れない。 |
| V. 構造整合のみ保証 (NON-NEGOTIABLE) | PASS | symbol 単位の forward 波及 (`impactReqs`) と `@impl` claim 集約 (`originReqs`) は graph 構造から決定的に導出。意味判定は導入しない。`unresolvedSymbol` も「symbol node が graph に存在しない」という構造的事実のみで発出。二軸の差分提示も「集合差分」という構造的事実の提示に留まり、ドリフトの是非判断は人間 / エージェントに委ねる。 |

**Gate 結果**: PASS (全 5 原則、Complexity Tracking への記録不要)。

## Project Structure

### Documentation (this feature)

```text
specs/016-impact-plan-symbol-level/
├── plan.md                              # This file
├── research.md                          # Phase 0 output
├── data-model.md                        # Phase 1 output (SymbolEntry / ImpactGroup / ImplicitImpactByReq)
├── quickstart.md                        # Phase 1 output (E2E 検証手順 + ドリフト fixture)
├── contracts/
│   ├── sdd-files-parser.md              # parser: ExtractResult { entries: SymbolEntry[] }
│   ├── cli-flags.md                     # impact CLI: symbol 直接入力 + 二軸 text 出力
│   └── plan-coverage-json.md            # 出力 JSON schema (clean redesign)
├── checklists/
│   └── requirements.md                  # 既存
└── tasks.md                             # Phase 2 (/speckit-tasks で生成)
```

### Source Code (repository root)

```text
src/
├── parsers/
│   └── sdd-files.ts          # ★ ExtractResult を { entries: SymbolEntry[] } 一本に
├── graph/
│   └── traverse.ts            # ★ resolveStartIds(entries) 一本化、@impl 1-hop helper 追加
├── plan-coverage/
│   └── index.ts               # ★ ImpactGroup を impactReqs/originReqs 二軸、sourceLocations 採用
└── cli.ts                     # ★ impact: symbol 検出 + 二軸出力 / ドリフトセクション

tests/
├── sdd-files-parser.test.ts   # ★ entries[] ベースに書き直し、path:symbol case 追加
├── impact-cli.test.ts          # ★ symbol 直接入力 + originReqs / ドリフト出力 case
├── plan-coverage.test.ts       # ★ 二軸 ImpactGroup / sourceLocations / unresolvedSymbol case
├── traverse.test.ts            # ★ resolveStartIds() unit test、@impl 1-hop helper test
└── fixtures/
    └── symbol-mode/            # ★ 新規 fixture: 1 file 3 symbol で各々別 REQ、ドリフト E2E 用

templates/
└── skills/
    ├── artgraph-impact/SKILL.md         # ★ symbol 入力例 + originReqs / drift 解釈 (100 行以下)
    └── artgraph-plan-coverage/SKILL.md  # ★ impactReqs/originReqs 解釈 + unresolvedSymbol (100 行以下)

docs/
└── skills-guide.md            # ★ file vs symbol trade-off 表 + 二軸ガイド

README.md                       # ★ Skills 表に mode 列追加
```

**Structure Decision**: 単一パッケージ (Constitution: `src/` のみ)。本 spec は新規ディレクトリを作らず、既存 4 ファイルへの clean な書き換え + Skills / docs / tests / fixture に絞る。contracts は parser / CLI / plan-coverage の 3 軸で最終形を記述する。

## Complexity Tracking

> Constitution Check が全 5 原則 PASS のため、本 spec では Complexity Tracking エントリなし。
