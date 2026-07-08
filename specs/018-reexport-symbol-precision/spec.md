# Feature Specification: re-export の per-symbol 精度 (`export *` / `export * as ns` / imported identifier)

**Feature Branch**: `feat/issue-179-188`

**Created**: 2026-07-08

**Status**: Implemented as-built — Phase 1 = 306c69d, Phase 2 = 3056dc2 (formerly PR #201, superseded by force-push during v0.1.0 release prep)

**Input**:

- issue [#179](https://github.com/ShintaroMorimoto/artgraph/issues/179) — `export *` チェーンおよび `export * as ns from` を per-symbol で解決する
- issue [#188](https://github.com/ShintaroMorimoto/artgraph/issues/188) — `import { x } from "./m"; export { x };` / `import X from "./m"; export default X;` などの imported identifier re-export を per-symbol で解決する

**Closes**: #179, #188

**Related**:

- PR [#180](https://github.com/ShintaroMorimoto/artgraph/pull/180) (#177) — named / aliased / type / default-as re-export の per-symbol 化 (本 spec の前提)
- specs/016 — `impact` / `plan-coverage` の symbol-level 入力経路 (本 spec の precision 向上が blast radius / drift 判定に直結)
- #187 — `export = require()` fail-open 修正 (本 spec と competing しない file 粒度確定)
- #189 — `phantom-import-repaired` / `dangling-import` warning (最終防衛線としての fail-safe 観測)

## 背景 / 問題

`#177` (PR #180) が named / aliased / type / default-as re-export を per-symbol 化した時点で、以下の 3 構文が **file 粒度 fail-safe** に降格したまま残っていた。REQ 到達自体は builder の `phantom-import-repaired` (fail-safe) で保たれていたが、consumer の named import が origin file の**全 REQ** を blast radius に巻き込む precision loss を生んでいた。

| # | 構文 | pre-018 の挙動 | 対象 issue |
|---|------|-----------|-----------|
| S1 | `export * from "./o"` | `file:B → file:O` edge のみ。consumer の `import { x }` は phantom → builder repair で file 粒度 | #179 |
| S2 | `export * as ns from "./o"` | S1 と同じ扱い (star 展開なし、単一シンボル `ns` も未実体化) | #179 |
| S3 | `import X from "./a"; export default X;` / `import { x } from "./m"; export { x };` | lookup が local decl のみ参照 → symbol node 不成立 → file 粒度 | #188 |

本 feature はこの precision gap を埋め、consumer の named import が origin symbol へ per-symbol で直結するようにする。fail-safe (`phantom-import-repaired`) は最終防衛線としてそのまま残す (additive design)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — `export *` barrel 越しの per-symbol impact 精度 (Priority: P1)

開発者が `barrel.ts: export * from "./origin"` の chain を持つプロジェクトで、consumer 側の `import { validateToken } from "./barrel"` を持つファイルを編集する。`origin.ts` には `validateToken (@impl REQ-A)` と `issueToken (@impl REQ-B)` の 2 export があり、consumer は `validateToken` しか使わない。

`artgraph impact` は per-symbol で origin symbol (`symbol:origin.ts#validateToken`) まで到達し、blast radius に REQ-B が混入しない。同じく `entryOriginIds` (`artgraph impact` / `plan-coverage`) は symbol chain (`symbol:barrel.ts#validateToken → symbol:origin.ts#validateToken`) を透過し、`Files: src/barrel.ts:validateToken` エントリでも drift 計算 (`impactReqs \ originReqs`) が symmetric に閉じる。

**Independent Test**: T1 (design.md §11) — origin に `x @impl REQ-X` と `y @impl REQ-Y`、barrel `export * from origin`、consumer `import { x } from barrel` を持つ fixture で `artgraph impact` を実行し、`impactReqs` に `REQ-X` のみが含まれ `REQ-Y` は含まれないこと。graph に `symbol:barrel#x → symbol:origin#x` edge が存在すること。

### User Story 2 — imported identifier re-export の per-symbol 直結 (Priority: P1)

barrel が `import { x } from "./m"; export { x };` のように imported identifier を再輸出する場合、および `import X from "./m"; export default X;` のように default で再輸出する場合、consumer の named import が origin symbol へ per-symbol で直結する。同一 lock 上、この barrel は `export { x } from "./m"` (source あり) と **byte-identical** に扱われる (refactor equivalence, design §4)。

**Independent Test**: T10 (design.md §11) — `import { x } from "./m"; export { x };` の lock bytes が `export { x } from "./m";` の lock bytes と byte-identical であること。および T9 — default import + default re-export で `symbol:barrel#default → symbol:m#default` が per-symbol に到達すること。

### User Story 3 — `export * as ns from` の namespace symbol 実体化 (Priority: P2)

barrel が `export * as ns from "./origin"` を持つ場合、`symbol:barrel#ns` が単一シンボルとして materialize され、`symbol:barrel#ns → file:origin` の file-grain edge を持つ。star 展開はしない (design §4 の hash: `[m, "*", "ns"]`)。consumer が `ns.x` にアクセスする API surface は本 spec の対象外だが、`resolveStartIds` が star barrel の `path:symbol` 入力を hard error にせず解決するようになる副次効果を持つ (下流影響 #191/#016)。

**Independent Test**: T8 (design.md §11) — `symbol:barrel#ns → file:origin` edge が実体化されること。origin の中身が展開されないこと。既存 file edge (`file:barrel → file:origin`) も残ること。

### Edge Cases

- **循環 `A ↔ B`**: visited / stack カットで停止、各 local 定義は双方向に per-symbol 伝播 (design §5 手順 3)。
- **多段チェーン `A → B → C`**: `exportedNames` の再帰で名前を運び、edge は 1 hop 単位 (`symbol:A#x → symbol:B#x → symbol:C#x`)。展開順に依存しない (design §5)。
- **diamond DAG (共有下流 barrel)**: (F, name) 単位の**条件付きメモ化** (循環カットに触れなかった結果のみキャッシュ) で O(2^k) 爆発を防ぐ (design §5, T20)。
- **ambiguous star (2 star が同名を供給)**: `symbol:barrel#x` を実体化せず drop → consumer の `import { x }` は phantom → `phantom-import-repaired` (file 粒度) にフォールバック。REQ 到達は保たれる (fail-open ではない, design §7 D3, T7)。
- **local decl / named re-export / S2 / S3 合成が star に勝つ**: shadowing 順序 (design §7)。star は default を伝播しない (T4)。
- **`export type * from` / `export type * as ns from` / `export * as "文字列名" from`**: 値 star と同様に実体化 (T14, design §6)。
- **同一ターゲット重複 star (`export * from "./o"` ×2)**: starMap dedup により曖昧扱いにならず単一供給元として通常展開 (design §5 冒頭, T18)。
- **S3 bare specifier (`import X from "react"; export default X;`)**: 実体化ガード (相対 specifier + `resolveRelativeImport` 成功) を満たさないため skip (design §6, T19)。
- **fatal syntax error 内 star**: parser fallback が `importName.kind` を捨てるため file 粒度維持 (T15, design §10)。
- **star origin が scan 範囲外 (exclude glob)**: 展開不可 → consumer は `phantom-import-repaired` (file 粒度) にフォールバック (design §10)。
- **`// @impl REQ` を `export * from …` の直上に書いた場合**: star 文は symbolRange を持たないため file 帰属のまま (design §10)。

## Requirements *(mandatory)*

### Functional Requirements

- **REQ-018-001** (S1 展開): System MUST `export * from "./o"` を per-symbol 展開し、`symbol:B#name` node と `symbol:B#name → symbol:T#name` edge (T = 直近 star 供給元) を materialize しなければならない。展開は builder レベルで phantom-repair パスの**前**に走る (design §5)。
- **REQ-018-002** (S2 実体化): System MUST `export * as ns from "./o"` を parser レベルで `symbol:B#ns` node + `symbol:B#ns → file:O` edge として materialize しなければならない。star 展開はしない (design §6, hash: `[m, "*", "ns"]`)。
- **REQ-018-003** (S3-C3 default re-export): System MUST `import X from "./m"; export default X;` / `import { x } from "./m"; export default x;` / `import * as ns from "./m"; export default ns;` を parser レベルで `symbol:B#default` node + 対応する edge として materialize しなければならない (design §4 表, §6)。
- **REQ-018-004** (S3-C4 source-null re-export): System MUST source なし `ExportNamedDeclaration` (`import { x } from "./m"; export { x };`, `import X from "./m"; export { X };`, `import * as ns from "./m"; export { ns };`) を per-symbol 材化しなければならない (design §4 表, §6)。
- **REQ-018-005** (循環 / diamond 収束): System MUST `export *` の再帰展開を、visited stack + 条件付きメモ化 ((F,name) 単位、循環カットに触れなかった結果のみキャッシュ) で決定性・停止性を保証しなければならない (design §5)。
- **REQ-018-006** (曖昧性 drop): System MUST 複数の直近 star 供給元 (dedup 後) が同名を供給する場合、`symbol:B#x` を実体化せず drop し、下流の `phantom-import-repaired` fail-safe に委譲しなければならない (design §7 D3)。
- **REQ-018-007** (SSOT hash): System MUST 全 re-export 合成 node の contentHash を単一ヘルパー `synthReexportHash(targetRel, originBinding, exportedName)` で生成しなければならない。#177 の named re-export hash 入力バイト列は不変であり、追加は additive でなければならない (design §4)。
- **REQ-018-008** (INV-L4 維持): System MUST 展開が fragment 純粋性を壊さないように、S1 (cross-file 情報要) は builder レベル、S2/S3 (self-contained) は parser レベルで実体化しなければならない。`starExports?: string[]` を `TsFragment` に side-channel として追加し、warm build と cold build の lock bytes が byte-identical であることを保証する (design §3, §8)。
- **REQ-018-009** (fail-safe 保持): System MUST 展開の drop / none / 実体化不可のケースで、下流 `phantom-import-repaired` (file 粒度) fail-safe をそのまま最終防衛線として保持し、REQ 到達を保たなければならない (design §7)。EdgeKind / EdgeProvenance を新規追加しない (`"ts-import"` に集約)。
- **REQ-018-010** (SCHEMA_VERSION bump): System MUST parse-cache の `SCHEMA_VERSION` を 3 → 4 に bump し、旧 cache を cold invalidate しなければならない (design §8)。

### Key Entities

- **`starExports`** (`TsFragment` side-channel): `string[]` — `export * from` の解決済み rootDir-relative ターゲット。宣言順、symbol mode の非 test ファイルのみ記録、空なら省略。fragment 内容から一意に決まる (fragment 純粋性維持)。
- **`starMap`** (builder-local): `Map<fileRel, targetRel[]>` — 全 fragment の `starExports` を集約したもの。集約時に解決済み targetRel で dedup + 初出順を保持 (同一モジュールへの重複 star を単一供給元に畳む)。
- **synth re-export node**: `symbol:B#name` (kind: `symbol`, filePath: B, contentHash = `synthReexportHash(resolvedTargetRel, originBinding, exportedName)`)。#177 既存分は input が完全に同じで hash bytes 不変。
- **`resolve(F, name)` 出力**: `"local" | { provider: rel } | "ambiguous" | "none"` — ES 仕様 `ResolveExport` 相当。手順の詳細は design §5。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-018-001** (regression 全 pass): unit / e2e / perf の全 test suite が本 spec 実装後に green で通過する (実測: unit 1560, e2e 41)。
- **SC-018-002** (T17 refactor equivalence): `B: export * from O` の lock bytes が、B を明示列挙 `export { x } from O` (O の全 export 分) に書き換えた lock bytes と **byte-identical** である (design §4 の refactor equivalence pin)。
- **SC-018-003** (#177 既存 hash 不変): #177 の named re-export に対する既存 lock entry (`impl:` prefix / `symbol:` prefix) の bytes が本 spec 実装で変化しない。追加のみが reconcile diff に現れる。
- **SC-018-004** (blast radius 精度向上): `import { x } from barrel` の consumer から `artgraph impact` を実行したとき、`export *` chain 越しで origin の**特定 symbol の REQ のみ** が blast radius に含まれ、無関係な兄弟 symbol の REQ は含まれない (design §9 "consumer named import が origin symbol へ直結")。
- **SC-018-005** (INV-L4 byte identity): warm build と cold build の lock bytes が star barrel を含む fixture でも byte-identical である (T12, parse-cache.test.ts の既存 INV-L4 検証を通過)。
- **SC-018-006** (SCHEMA_VERSION cold invalidate): SCHEMA_VERSION 不一致の旧 cache が cold path に落ち、v3 cache から v4 build へ upgrade したときの初回 build で新 `starExports` / S2/S3 node が正しく登場する。

## Out of scope (Known limitations still open)

以下は本 feature の対象外として明示的に defer した項目。CHANGELOG "Known limitations still open" 節と対応する:

- **`export = X` origin (#187 で確定)**: `export = require(...)` は export 名を束縛しないため per-symbol 化不可 (file 粒度確定)。file-grain lock entry のみ、design §10 参照。
- **fatal syntax error 内の star / ns 復元**: oxc-parser の `parsed.module.staticExports[].entries[].importName.kind` は `Name` / `All` / `AllButDefault` を区別可能で、原理的には `isPlainStar` / `nsName` を復元できる。しかし `parsers/typescript.ts:998-1008` の fallback はこの情報を捨てているため未実装 (fatal-syntax file は file 粒度維持で問題ないという設計判断による意図的単純化, design §10)。
- **`path:symbol` (S2 / S3-namespace) の drift 計算**: post-018 では `symbol:B#ns` は materialize されるが `entryOriginIds` (traverse.ts) の `edge.target.startsWith("symbol:")` フィルタで `symbol:B#ns → file:O` edge が skip され、`originReqs = []` → `impactReqs \ originReqs = impactReqs` が全件 drift 候補化する。**ユーザー可視には「pre-018 の hard error → post-018 の silent false-positive drift」への退化**。file → same-file symbols expansion は別 issue (design §9 の "path:symbol 入力 (S2 / S3-namespace)" 表参照)。
- **parser-side `unresolved-reexport` warning** (#189 partial 残項目): `export { x } from "./missing"` を parser 側で silent skip する既存挙動は残る。builder 側は `phantom-import-repaired` / `dangling-import` が発火する。parser plumbing + SCHEMA_VERSION bump が必要なため follow-up (design §10)。
- **wrapped default (`satisfies` / `as` / `!` / `<T>` / `(...)`)** の unwrap: `export default X satisfies T` / `export default X as T` / `export default X!` / `export default X<Foo>` / `export default (X)` は Identifier 限定 S3-C3 の対象外で、`symbol:B#default` を式テキストの hash で単発生成する (`typescript.ts:497-513` else 枝)。consumer は phantom-repair が阻害されるため file 到達性も落ちる (silent per-symbol precision loss)。回避: identifier のみで default 化するか `export { config as default }` に書き換える。frequency: Next.js / Vite / tRPC の `export default defineConfig({...}) satisfies X`。追跡は別 issue で。CHANGELOG "Known limitations still open" に記載済み。
- **ambiguous star / diamond 束縛同一性の非比較**: §7 D3/D4 の意図的逸脱。実リポジトリで問題になったら束縛同一性比較で精緻化する余地を known limitation として明示 (CHANGELOG)。

## Assumptions

- **前提: `#177` (PR #180) の named re-export barrel 実体化が完了している**。本 spec は #177 の synth node パスと `synthReexportHash` SSOT を拡張する。#177 の hash 入力バイト列は不変 (§4 refactor equivalence の byte 保証、SC-018-003)。
- **前提: symbol mode でのみ有効**。file mode は本 feature の対象外 (design §9 "file mode は一切不変")。`useSymbol` ガード + builder 展開の symbol mode 限定を維持。
- **前提: 参照解決は `resolveRelativeImport`**。S3 の実体化は specifier が相対 (`.` 始まり) かつ解決成功したときのみ (design §6 の「実体化の前提ガード」)。bare specifier / 解決失敗は skip (今日の挙動維持)。
- **前提: 展開層は builder / parser で一意に決まる**。S1 (cross-file 依存) は builder / S2 & S3 (self-contained) は parser。この分割は fragment 純粋性 (INV-L4) から**逆算で一意**に決まる (design §3)。
