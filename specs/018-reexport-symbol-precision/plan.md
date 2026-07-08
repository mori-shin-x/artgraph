# Implementation Plan: re-export の per-symbol 精度

**Branch**: `feat/issue-179-188` | **Date**: 2026-07-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/018-reexport-symbol-precision/spec.md`

## Summary

`export *` (S1) / `export * as ns from` (S2) / imported identifier の re-export (S3) を per-symbol で解決する。#177 (PR #180) が named / aliased / type / default-as re-export に導入した per-symbol synth node パスを、残る 3 構文へ additive に拡張する。fail-safe (`phantom-import-repaired`) は最終防衛線として残す (spec.md REQ-018-009)。

技術アプローチ:

- **S1 (`export * from`)** — builder レベルで ES 仕様の `GetExportedNames` / `ResolveExport` に沿った再帰展開を実装。展開は phantom-repair パスの**前**に走らせ、実体化された node が「dangling 判定」から自然に外れる仕組みにする (design §5)。
- **S2 (`export * as ns from`)** — parser レベルで `symbol:B#ns` 単一シンボル + `symbol:B#ns → file:O` edge を materialize (star 展開しない, design §6)。
- **S3 (imported identifier re-export)** — parser の `importBindings` map で 1 pass 前処理し、source-null `ExportNamedDeclaration` (C4) と `ExportDefaultDeclaration` (Identifier, C3) を `symbol:B#exported` で per-symbol 材化 (design §6)。
- **fragment 純粋性の側チャネル** — `ParsedTS` / `TsFragment` に `starExports?: string[]` を追加し、builder が全 fragment の `starExports` を集約して `starMap` を構築 (design §3)。

新規 EdgeKind / EdgeProvenance は追加しない (`"ts-import"` に集約, REQ-018-009)。

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js >= 20, ESM)

**Primary Dependencies**: oxc-parser (TS 抽出、staticImports / staticExports)、既存の internal modules (`src/parsers/typescript.ts`, `src/parse-cache.ts`, `src/graph/builder.ts`)。新規外部依存なし。

**Storage**: `.trace.lock` (gitignore 済み)、parse-cache は `node_modules/.cache/artgraph/parse-cache.json`。SCHEMA_VERSION を 3 → 4 に bump し旧 cache を cold invalidate (REQ-018-010)。

**Testing**: vitest (unit / e2e / perf)。既存 `tests/barrel-reexport.test.ts` に節を追加、`tests/star-expansion.test.ts` を新規作成、`tests/typescript-oxc-regression.test.ts` にレビュー指摘対応の regression。

**Target Platform**: 開発者ローカルおよび CI (Node 22)。symbol mode のみ有効 (spec.md Assumptions)。

**Project Type**: single project CLI (`src/` 単一パッケージ)

**Performance Goals**: 展開はメモ化により O(ファイル数 × 名前数 × star out-degree) の多項式。真の循環に触れた query だけ再計算になるが循環成分のサイズで有界 (design §5)。dogfood レベル (node 約 1,000 / edge 約 1,300) で追加コストは無視できる。

**Constraints**: fragment 純粋性 (`TsFragment` = そのファイル自身の内容 + tsconfig / file-set env key の関数)。warm/cold build の lock byte-identity (INV-L4, SC-018-005)。`export = X` origin (#187) と competing しない (別コードパス)。

**Scale/Scope**: 変更ファイル 4 系統 — parser / parse-cache / builder / tests + docs (design §12)。実測 diff は約 1500 行 (実装 + tests + fixture)。

### 解決した設計判断 (design.md §3 要約)

- **S1 → builder レベル**: 展開先の export 名集合は**別ファイル**に住むため、parser レベルで展開すると fragment が他ファイル内容に依存し warm cache が silent stale になる。builder で毎 build 再計算すれば、origin 側の変更は origin 自身の fragment 更新として流れ込み、barrel の cache は温存されたまま展開結果だけ追随する。
- **S2 / S3 → parser レベル**: origin 参照が specifier だけで済むため self-contained、fragment 純粋性を壊さない。#177 の barrel 実体化と同じ場所・同じパターンの拡張。
- **contentHash SSOT** = `synthReexportHash(targetRel, originBinding, exportedName)` — 全合成 node で単一関数、`originBinding ∈ { origin export 名, "default", "*" }`。#177 の named re-export の hash 入力バイト列は不変 (追加は additive)。
- **展開アルゴリズム = ES 仕様 `GetExportedNames` / `ResolveExport`** — issue #179 の当初想定「新規 node が増えなくなるまで反復 (fixpoint)」の上位互換。仕様レベルで決定性・停止性が保証される。
- **edge target = 直近 star 供給元 (1 hop)** — 究極 origin まで畳まず 1 hop ずつ繋ぐ。§4 refactor equivalence が保て、`entryOriginIds` (BFS) / `impact` (BFS) は推移的に辿るので到達性は変わらない。
- **shadowing 順**: local decl / named re-export / S2 / S3 合成 > star 展開 (ES / TS の解決順に一致、design §7)。star は default を伝播しない (T4)。

## Constitution Check

*GATE: Must pass. Re-checked after Phase 1 design and again after implementation (as-built)。*

### 原則との整合

- **I. 決定的グラフ第一 (NON-NEGOTIABLE)**: ✅ 展開は module graph の純関数。ファイル走査順・OS 非依存 (rel path / name 昇順で走らせる)。LLM 推定なし。
- **II. 単一型付き4層グラフ**: ✅ 新規 node / edge 型を追加しない。既存 `symbol` node と `"ts-import"` edge を再利用 (spec.md REQ-018-009)。合成 node は既存 `buildLockFromGraph` が symbol node として素通しで拾う。
- **III. Spec が ID を所有 / コードが claim (NON-NEGOTIABLE)**: ✅ REQ 発行・タグ付けロジックは変更しない。star 展開は「synth node が別 REQ を claim する」ような機構を導入していない (単に「元 REQ を claim している symbol への per-symbol edge」を材化するだけ)。
- **IV. SDD ツール ID 直接利用**: ✅ 影響なし。
- **V. 構造整合のみ保証 (NON-NEGOTIABLE)**: ✅ 展開は module graph の構造から決定的に導出。意味的判定なし。ambiguous drop も「複数供給元」という構造的事実の帰結。

**違反なし**。

### Engineering Hygiene Gates

- [x] **前提検証 (Cat6)**: `#177` (PR #180) の synth node パスと `synthReexportHash` の存在を実コードで確認済 (`src/parsers/typescript.ts`)。design.md で敵対的レビュー major 4 件 (starMap dedup / 条件付きメモ化必須化 / S3 bare specifier ガード / T17 追加) を採用済み。
- [x] **ID 衝突 (Cat6)**: 新規 spec 番号 018 は既存と衝突なし。REQ-018-001..010 は `018-reexport-symbol-precision/REQ-018-NNN` に qualified 化される。
- [x] **SSOT ペア (Cat2)**: contentHash 生成は `synthReexportHash(targetRel, originBinding, exportedName)` に単一化 (design §4)。#177 の named re-export と S1/S2/S3 で **同一関数**。等価性テストは T17 (S1 refactor 等価性) + T10 (S3 refactor 等価性) で pin。
- [x] **CLI 規約 (Cat5)**: 本 feature は CLI フラグ追加なし (`scan` / `impact` / `plan-coverage` / `check` の signature 不変)。`format json|text` も維持。
- [x] **走査仕様 (Cat7)**: builder 展開は starMap を再帰トラバース、(F, name) 単位の条件付きメモ化で有界 (design §5)。`exportedNames` も同じ規則。dedup key = `resolvedTargetRel`。edge 生成順は rel path / name 昇順で決定的。

## Project Structure

### Documentation (this feature)

```text
specs/018-reexport-symbol-precision/
├── design.md         # 実装意図の技術詳細 (§1〜§12) — 敵対的レビュー反映済み
├── spec.md           # (this PR で追加) as-built spec — REQ-018-NNN / SC-018-NNN / user stories
├── plan.md           # (this PR で追加、this file) — 技術判断 / layer 割り当て / risk
└── tasks.md          # (this PR で追加) as-built task ordering (commit 単位)
```

### Source Code (repository root)

design.md §12 のとおり:

```text
src/
├── parsers/typescript.ts     # [変更] importBindings pass、S2/S3 実体化、synthReexportHash SSOT
├── parse-cache.ts            # [変更] TsFragment.starExports?、SCHEMA_VERSION 3 → 4
├── graph/
│   ├── star-expansion.ts     # [新規] builder-side star expansion — pure module (recursion + 条件付きメモ化)
│   └── builder.ts            # [変更] star 展開を phantom-repair の直前に結線
tests/
├── barrel-reexport.test.ts   # [変更] §11 T1〜T19 の該当節を追加
├── star-expansion.test.ts    # [新規] star-expansion pure module の直接 unit test (循環 / diamond / ambiguous)
└── typescript-oxc-regression.test.ts  # [変更] レビュー指摘 (S3 bare specifier ガード / warm-cold identity 等) の回帰
docs / CHANGELOG:
├── docs/architecture.md      # [変更] §11 に S1/S2/S3 の説明と layer 割り当てを追記
├── docs/skills-guide.md      # [変更] barrel 越し drift 追跡の解釈更新
└── CHANGELOG.md              # [変更] Unreleased Added / Migration notes / Known limitations 節を追記
```

**Structure Decision**: 既存 single-project CLI レイアウトを踏襲。builder 側の star expansion は独立責務のため `src/graph/star-expansion.ts` に pure module として切り出し (テスト容易性)、`src/graph/builder.ts` からは新パスを呼ぶだけ。parser 側 (S2/S3) は #177 の barrel materialize と同じ場所 (`extractImports`) を拡張。

## Dependencies

- **依存**: `#177` (PR #180) の named re-export barrel 実体化。本 spec は #177 の synth node パスと SSOT hash を additive に拡張する。#177 の既存 lock hash entry の bytes は不変 (SC-018-003)。
- **競合しない**: `#187` の `export = require()` fail-open 修正 — `export =` は名前を束縛しないため per-symbol 化不可、file 粒度確定で competing しない。
- **協調**: `#189` の `phantom-import-repaired` / `dangling-import` warning — 展開が効いた分 `phantom-import-repaired` の発火が減る (意図どおり)。`dangling-import` は builder repair の既存分岐そのままで、S3 の実体化が effect を上流に押し上げるケースあり (out-of-scope origin 経由の barrel、CHANGELOG migration notes §6 参照)。

## Risks

CHANGELOG "Migration notes" §1〜§6 と対応する:

1. **`.trace.lock` diff (初回 reconcile)**: star barrel / S3 ファイルに新規 `symbol:` エントリが**追加** される。既存エントリの hash は不変 (§4 追加のみ)。既存ユーザーは初回 reconcile 後 1 コミットで安定。
2. **SCHEMA_VERSION 3 → 4 (parse-cache)**: 旧 cache は cold invalidate。異なる artgraph バージョンで reconcile が走ると v3 が v4 の synth entries を削除する `.trace.lock` diff war が発生しうる (post-cutover 期のみ) — チーム全員で同じバージョンを `package.json` / lockfile に pin することを推奨。
3. **plan-coverage `--gate` の発火**: barrel 越しで origin の REQ が blast radius に per-symbol で入るようになるため、`Files:` に origin REQ の言及がないと implicit として plan-coverage `--gate` が発火する。これは意図した新シグナル (PR #180 と同種)。
4. **`phantom-import-repaired` 件数の減少**: 従来 fail-safe 経由で file 粒度に降格していた named import が star expansion / S3 材化により per-symbol で解決するようになり、`scan --format json` の `warnings[].filter(w => w.type === "phantom-import-repaired")` が既存 baseline から減少する。CI で warning count を pinning している場合は要 baseline 再取得。
5. **out-of-scope origin 経由の barrel の warning attribution shift**: `barrel.ts` が `import { x } from "./vendor/lib"; export { x }` (vendor が include glob 外) を持つ場合、pre-018 は consumer 側で `phantom-import-repaired` (files=[consumer]) が発火。post-018 は S3-C4 材化により consumer edge が解決し、代わりに barrel 側で `dangling-import` (files=[barrel]) が発火する。warning type と files attribution が変わるため、`warnings[].files[0]` を hotspot key として集計している dashboard / tooling は再調整が必要。
6. **path:symbol (S2 / S3-namespace) の drift 挙動**: pre-018 の hard error (`resolveStartIds` unresolvedSymbol) → post-018 の silent false-positive drift (spec.md Out of scope 参照)。file → same-file symbols expansion は別 issue。

## 代替検討 (§7 敵対的レビュー major 4 件、いずれも採用)

design.md §7 の敵対的レビュー結果を受けて、以下 4 件を採用済み:

1. **starMap dedup**: 同一モジュールへの重複 star (`export * from "./o"` ×2、または別スペシファイアが同一ファイルに解決) を targetRel で dedup し、|providers| ≥ 2 の誤 ambiguous 判定を回避 (design §5 冒頭、T18)。
2. **条件付きメモ化を必須化**: 素の再帰は diamond DAG で O(2^k) 爆発、無条件メモ化は循環カットで path 依存の結果を汚染。両方を回避する条件付きメモ化 (循環カットに触れなかった結果のみキャッシュ) を必須化 (design §5、T20)。
3. **S3 bare specifier ガード**: bare specifier (`import X from "react"; export default X;`) の実体化を skip (相対 + `resolveRelativeImport` 成功のみ実体化) — §4 の hash 入力を「解決済み rootDir-relative path」に統一するガード (design §6、T19)。
4. **T17 refactor equivalence 追加**: `B: export * from O` の lock bytes ≡ B を明示列挙 `export { x } from O` に書き換えた lock bytes を byte-identical で pin (design §4、T17)。

## Complexity Tracking

> Constitution Check に違反なし。記載不要。

## Follow-up

- **`path:symbol` (S2 / S3-namespace) の drift 計算改善**: `entryOriginIds` の file → same-file symbols expansion (spec.md Out of scope) — 別 issue で追跡。
- **fatal-syntax file の per-symbol 精度向上**: oxc `importName.kind` 抽出を追加すれば `isPlainStar` / `nsName` を復元可能 (design §10) — 別 issue で追跡。
- **parser-side `unresolved-reexport` warning**: `export { x } from "./missing"` の parser silent skip は #189 残項目、parser plumbing + SCHEMA_VERSION bump が必要なため follow-up。
- **wrapped default (`satisfies` / `as` / `!` / `<T>` / `(...)`) の unwrap**: Identifier 限定 S3-C3 の対象外、CHANGELOG に既知記載 — 別 issue で追跡。
- **ambiguous star / diamond 束縛同一性の精緻化**: 実リポジトリで問題になれば束縛同一性比較で精緻化する余地あり (design §7 D3/D4)。
