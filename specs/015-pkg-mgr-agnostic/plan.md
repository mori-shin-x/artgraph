# Implementation Plan: package manager 非依存化の基盤 + 既存配布物の PM 非依存化 + Bun/Deno smoke test

> **Superseded reference notice (post PR #151 / issue #141)**: 本ドキュメント内で「`_shared/package-manager.md` の bash スニペット」または「bash 検出順」等と参照している箇所は、issue #141 で shell 非依存の **prose ルール表** (`## Detection rules`) に置き換え済みです。SC-007 の同期契約はルールレベル (prose ↔ TS: 同じ優先順位・同じ結果・同じ warning/error 文言) で維持されており、`tests/package-manager-detection.test.ts` の prose↔TS meta-test が verbatim ワーディングを含めて検証します。詳細は [`contracts/package-manager.md`](contracts/package-manager.md) の "Note (issue #141)" ブロック参照。本文中の「bash」語は spec 015 起草時点の呼称としてそのまま保持しています (歴史的経緯の可読性のため)。

**Branch**: `claude/artgraph-issue-102-1dn27j` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/015-pkg-mgr-agnostic/spec.md`

## Summary

artgraph の配布物・docs に残る `npx artgraph` 前提の表記を一掃し、**package manager 非依存**にする。中核は **PM 検出ロジックを `src/` に一本化し `.artgraph.json` に記録する基盤** であり、これを切り出した別 issue (#109 hooks / #110 agent-context / #111 plugin) が consume して最初から PM 非依存で実装する (= 二度手間回避)。本 spec のスコープは:

1. **基盤**: `src/package-manager.ts` 新規 — `_shared/package-manager.md` の bash 検出を TS へ逐語移植 + exec/install コマンド組み立てヘルパ。`ArtgraphConfig.packageManager` を追加し `init` 時に記録 (US1)
2. **既存配布物の PM 非依存化**: 既存 Skill (`templates/skills/*/SKILL.md`) の `allowed-tools` / 本文、`_shared/package-manager.md` bash の SSOT 追従、README / `docs/skills-guide.md` (US2, US3)
3. **Bun / Deno smoke test + CI matrix**: npm/pnpm/bun/deno で `init` → `check` を完走確認。`ts-morph` の Deno 互換性を可視化 (US4)

**デフォルト PM は pnpm に統一**: 未リリースで後方互換不要のため、シグナル無し時のデフォルト・Yarn fallback・真の検出不能時の後続フォールバックを**すべて pnpm に寄せる**。明示シグナル (`package-lock.json` / `packageManager: npm@x`) がある場合のみ npm を返す (= 検出結果として尊重)。

**アプローチの核**: グラフ生成・traverse・check 等の既存ロジックには**一切触れない**。本 spec は (a) 決定的な PM 検出という新しい変換層を 1 つ追加し、(b) その出力を config に記録し、(c) 配布物のコマンド表記をプレースホルダ化するだけ。CLI の機能挙動 (scan/check/impact 等) は不変。

## Technical Context

**Language/Version**: Node.js >= 22, TypeScript `"type": "module"` ESM (既存)。Bun (Node-compat) / Deno (npm specifier) を追加ターゲットに含む。

**Primary Dependencies**: `commander` / `vitest` のみ。**新規依存なし**。PM 検出は `node:fs` の lockfile/`package.json` 読み取りと文字列処理で完結 (bash スニペットと同等のロジック)。

**Storage**: ファイルベース。`.artgraph.json` に `packageManager?: "npm" | "pnpm" | "bun" | "deno"` フィールドを追加する (optional)。新規ストアなし。

**Testing**: vitest (unit / e2e)。検出ロジックは純関数なので unit で全分岐を覆う (`tests/package-manager-detection.test.ts`)。`init` の記録は既存 `tests/init.test.ts` パターンを継承。Bun/Deno の実ランタイム smoke は CI job として実行 (vitest 内ではなく shell ステップ)。

**Target Platform**: Linux / macOS / Windows (Node 22)。CI は GitHub Actions Ubuntu。Bun / Deno は CI の専用 job で検証。

**Project Type**: CLI ツール (単一 Node パッケージ + Skills/Templates 配布物)。Constitution「Package layout: 単一パッケージ」を厳守。

**Performance Goals**: PM 検出は lockfile の `existsSync` 数回 + `package.json` 1 read のみ。`init` 全体への追加コストは無視できる (< 1ms オーダー)。記録により後続機能 (#109/#110) の再 sniff を回避するのが目的。

**Constraints**:
- 既存 CLI 機能 (scan/check/impact/coverage/...) の挙動を**変えない**。本 spec の差分は init の config 出力に `packageManager` が増えることと、配布物テキストの表記のみ。
- **検出順は `_shared/package-manager.md` の bash と完全一致** (FR-001/012, SC-007)。bash スニペットは `artgraph-setup` Skill が **artgraph 未インストール時に bootstrap で動く**ため独立して存在する必然があり、TS と二重管理になる。両者を SSOT として揃える。
- ユーザー作成ファイルを破壊しない。検出は読み取りのみ。
- Constitution v1.1.0 準拠 (後述)。

**Scale/Scope**:
- 新規 `src/` ファイル 1 件 (`package-manager.ts`)
- 改修 `src/` ファイル 3 件 (`types.ts`, `init.ts`, `config.ts`)
- 改修配布物: `_shared/package-manager.md` + 既存 Skill 群の SKILL.md (frontmatter/本文) + README + `docs/skills-guide.md`
- 改修 `.github/workflows/ci.yml` (PM matrix 追加) + 必要なら `package.json` の `exports` に `"./cli"` 追加 (Deno 対応, research で確定)
- 新規 / 改修テスト ~3 件 + CI smoke job
- LOC 合計 ~300–500 (うち tests 半分)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本 feature への該当 | 判定 | 根拠 |
|---|---|---|---|
| **I. 決定的グラフ第一 (NON-NEGOTIABLE)** | PM 検出は lockfile / `package.json#packageManager` の決定的読み取りのみ。LLM・統計推定を使わない | ✅ PASS | 検出順は固定。同じ入力ファイル群に対し常に同じ PM を返す純関数 |
| **II. 単一型付き4層グラフ** | ノード型 / エッジ型の追加なし。グラフに一切触れない | ✅ PASS | `packageManager` は graph ではなく config メタデータ |
| **III. Spec が ID を所有 (NON-NEGOTIABLE)** | REQ-ID / `@impl` / lock に関与しない | ✅ PASS | config 追記と配布物表記のみ。ID 派生なし |
| **IV. SDD ツール ID 直接利用** | 該当なし (ID を扱わない) | ✅ PASS | — |
| **V. 構造整合のみ保証 (NON-NEGOTIABLE)** | drift/orphan/uncovered 判定ロジックを変えない | ✅ PASS | check の挙動不変。PM 検出は判定に影響しない |

**Gate**: ✅ All NON-NEGOTIABLE principles pass without justified deviations.

**Complexity Tracking**: 空 (justify する逸脱なし)。`src/package-manager.ts` 1 ファイル追加は既存 `src/config.ts` / `src/init.ts` と同列の単一パッケージ内モジュール追加で、layout 原則に整合。

## Project Structure

### Documentation (this feature)

```text
specs/015-pkg-mgr-agnostic/
├── spec.md              # 完了 (この PR で先行作成済)
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0: Deno での ts-morph 互換性 + `npm:artgraph/cli` export 解決 + Bun Node-compat の確認 / 失敗時の CI 方針
├── contracts/
│   └── package-manager.md   # Phase 1: 検出真理値表 (入力ファイル → PM) + exec/install マッピング + config schema。テスト (SC-001/003/007) の参照 SSOT
└── tasks.md             # Phase 2 output (/speckit-tasks 出力 — このコマンドでは作成しない)
```

> data-model.md は作らない: 新エンティティは `ArtgraphConfig.packageManager` (単一 enum フィールド) のみで、contracts/package-manager.md の schema 節に内包できるため。

### Source Code (repository root)

```text
# 新規追加
src/
└── package-manager.ts                  # detectPackageManager(rootDir) + buildExecCommand(pm, sub) + buildInstallCommand(pm)。検出順は _shared/package-manager.md の bash と逐語一致

# 既存 (改修対象)
src/
├── types.ts                            # ArtgraphConfig に packageManager?: PackageManager を追加。PackageManager union を export
├── init.ts                             # runInit: detectPackageManager を呼び、検出できた場合のみ config.packageManager にセットしてから書き出す
└── config.ts                           # loadConfig: raw.packageManager を validate (enum) して passthrough

# 配布物 (改修)
templates/
└── skills/
    ├── _shared/package-manager.md      # bash スニペット: step 3 デフォルト + Yarn fallback を npm → pnpm に追従 (SSOT)
    ├── artgraph-coverage/SKILL.md      # allowed-tools に 4 PM exec を pre-approve / 本文の npx artgraph をプレースホルダ化
    ├── artgraph-impact/SKILL.md        # 同上
    ├── artgraph-integrate/SKILL.md     # 同上
    ├── artgraph-plan-coverage/SKILL.md # 同上
    ├── artgraph-rename/SKILL.md        # 同上
    ├── artgraph-verify/SKILL.md        # 同上
    ├── artgraph-detect/SKILL.md        # 本文は <PM-exec> 採用済。allowed-tools のみ点検
    └── artgraph-setup/SKILL.md         # PM 対応表は維持 (退行なし)。allowed-tools 点検

# ドキュメント
docs/
└── skills-guide.md                     # npx artgraph 例を PM 非依存表現に

README.md                               # 本文の artgraph 実行例を PM 非依存表現に (Quickstart の 4 PM 列挙は維持)

# パッケージ / CI
package.json                            # (research 後) exports に "./cli": "./dist/cli.js" を追加 — Deno の `npm:artgraph/cli` 解決用
.github/workflows/ci.yml                # PM matrix (npm/pnpm/bun/deno) の smoke job を追加

# テスト
tests/
├── package-manager-detection.test.ts   # 新規: detect 全分岐 + buildExec/buildInstall 出力 + 検出不能 sentinel
├── init.test.ts                         # 改修: .artgraph.json への packageManager 記録 (4 PM + 検出不能)
└── skills-templates.test.ts             # 改修: 本文に裸の `npx artgraph <sub>` が 0 件 / allowed-tools に 4 PM exec
```

**Structure Decision**: 単一プロジェクト (`src/` + `tests/` + `templates/` + `docs/`)。新規 `src/package-manager.ts` は既存 `src/config.ts` / `src/id.ts` と同列の root レベルモジュール (機能が config・init をまたぐ横断ユーティリティのため、特定サブディレクトリに置かず root に置く)。検出ロジックの bash (`_shared/package-manager.md`) と TS (`src/package-manager.ts`) は SSOT として検出順を一致させ、`contracts/package-manager.md` の真理値表を両者の正解とする。

**Skills 言語ポリシー** (spec 012 FR-029 継承): `templates/skills/*/SKILL.md` は英語のまま。README / `docs/skills-guide.md` への追記は現行言語 (日本語) を維持。

## 設計判断 (詳細は research.md / contracts で確定)

- **検出関数のシグネチャ**: `detectPackageManager(rootDir: string): PackageManager | null`。`null` = 真の検出不能 (`package.json` も lockfile も deno も無い)。呼び出し側 (`runInit`) は `null` 時に `packageManager` を記録せず警告のみ。
- **exec マッピング**: npm→`npx artgraph <sub>` / pnpm→`pnpm exec artgraph <sub>` / bun→`bunx artgraph <sub>` / deno→`deno run -A npm:artgraph/cli <sub>`。`contracts/package-manager.md` を SSOT とし、`_shared/package-manager.md` の Command mapping 表と完全一致させる。
- **config 検証**: `loadConfig` は `raw.packageManager` が 4 値 union 以外なら無視 (or エラー) する。既存の validate パターン (`validatePlanCoverage` 等) を踏襲。`generateConfig` は detection を持たないため、記録は `runInit` 側で `config.packageManager` をセットする (generateConfig は純粋な include/specDirs 生成に留める)。
- **Skill allowed-tools 方針**: 全 Skill に `Bash(artgraph *)` (bare bin) + 4 PM の exec 形を pre-approve。bare `artgraph` だけでは `pnpm exec artgraph ...` 等の runner-prefixed コマンドにマッチしないため、4 PM exec を明示列挙する。
- **Deno の `npm:artgraph/cli` 解決** (research R3 で確定): 現 `exports` (`./package.json` のみ) では `artgraph/cli` が `ERR_PACKAGE_PATH_NOT_EXPORTED` で解決不可。`"./cli": "./dist/cli.js"` を追加すれば解決する (Node resolve 代理検証済)。→ `exports` 追加は**必須**。
- **Deno の ts-morph 互換性** (research R2 で確定): Deno 2.9.0 で `scan` (ts-morph 経由) が動作。**懸念は杞憂で Deno は正式サポート**。best-effort 降格・CI skip は不要。
- **artgraph 未公開** (research R4): CI の Deno 実行は `npm:artgraph/cli` ではなくビルド成果物 `./dist/cli.js` を直接使う。`npm:` 経路は exports 追加 + Node resolve 代理で担保し公開後に本 E2E。

## Phasing

本 spec は単一 PR で出す (基盤 + Skills + docs + smoke)。基盤は #109/#110/#111 より先にマージされる必要がある。PR 内部の作業順は以下を推奨 (レビュー容易性のため)。

| Phase | 内容 | 対象 FR |
|---|---|---|
| 0. research | ✅ **完了** ([research.md](./research.md)): Bun/Deno 実測。Deno は ts-morph 動作で正式サポート。`exports` に `./cli` 追加が必須。未公開のため CI Deno は `./dist/cli.js` 直接実行 | FR-016, FR-017 の前提 |
| 1. 基盤 (検出 + ヘルパ) | `src/package-manager.ts` 新規 + `tests/package-manager-detection.test.ts`。`contracts/package-manager.md` の真理値表を正解に | FR-001〜005, SC-001/003 |
| 2. config 配線 | `src/types.ts` (packageManager 追加) + `src/config.ts` (validate/passthrough) + `src/init.ts` (記録) + `tests/init.test.ts` 改修 | FR-006〜008, SC-002 |
| 3. bash SSOT 追従 | `_shared/package-manager.md` の step 3 デフォルト + Yarn fallback を npm→pnpm | FR-012, SC-007 |
| 4. Skills PM 非依存化 | 既存 SKILL.md の allowed-tools + 本文 + `tests/skills-templates.test.ts` 改修 | FR-009〜011, SC-004 |
| 5. docs | README + `docs/skills-guide.md` | FR-013/014, SC-005 |
| 6. Bun/Deno smoke + CI | `.github/workflows/ci.yml` に PM matrix job + 必要なら `package.json` exports 追加 | FR-015〜017, SC-006 |

各 phase は前 phase に依存 (1 → 2 → 3 が SSOT の直列依存)。commit を分けて履歴追跡しやすくする (squash merge 時は 1 commit に潰す)。

## Complexity Tracking

> 空 — Constitution 原則の逸脱なし。

(該当なし)
