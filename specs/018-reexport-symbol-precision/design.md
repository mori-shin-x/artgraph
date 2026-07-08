# 018 — re-export の per-symbol 精度 (`export *` / imported-identifier)

Issues: #179 (`export *` per-symbol), #188 (`export default <ImportedName>` / source なし local re-export)
Status: **design** (実装前レビュー用)
関連: #177 / PR #180 (named / barrel re-export の per-symbol 化), specs/016 (impact / plan-coverage symbol-level)

## 1. 背景と現状

#177 で named / aliased / type / default-as の re-export
(`export { x } from "./origin"` 系) は per-symbol 化済み。残る file 粒度
fail-safe (fail-open ではない) は次の 3 構文:

| # | 構文 | 現状 | 対象 issue |
|---|------|------|-----------|
| S1 | `export * from "./o"` | `file:B → file:O` edge のみ。consumer の `import { x }` は phantom → builder repair で file 粒度 | #179 |
| S2 | `export * as ns from "./o"` | S1 と同じ扱い (named: []) | #179 (展開対象外と明記) |
| S3 | `import X from "./a"; export default X;` / `import { x } from "./m"; export { x };` | lookup が local decl のみ参照するため symbol node 不成立 → file 粒度 | #188 (C3/C4) |

いずれも REQ 到達自体は builder の phantom-repair (fail-safe) で保たれて
いるが、origin file の**全 REQ** を巻き込む precision loss がある。

## 2. ゴール / 非ゴール

**ゴール**
- G1: S1 経由の named import を per-symbol 解決する (`symbol:B#x → symbol:O#x`)。
- G2: S2 を単一シンボル `symbol:B#ns` として実体化する (star 展開はしない)。
- G3: S3 の両形を per-symbol 実体化する。
- G4: `.trace.lock` の INV-L4 (warm/cold byte-identity, OS 非依存) を維持する。
- G5: 新しい EdgeKind / EdgeProvenance を追加しない (types.ts の
  `EDGE_PROVENANCE_VALUES` 不変条件と format.ts のフィルタを壊さない)。
- G6: すべて既存動作への**追加** (additive) とし、fail-safe (phantom-repair)
  は最終防衛線としてそのまま残す。

**非ゴール**
- `export =` origin の per-symbol 化 (#187 で file 粒度と確定済み)。
- parser 側 `unresolved-reexport` warning (#189 残項目、別 issue)。
- fatal syntax error ファイル内の star / re-export の名前回復 (#180 と同じ
  「壊れたファイルは直るまで file 粒度」原則を維持)。

## 3. アーキテクチャ: どの層で実体化するか

**制約 (parse-cache の fragment 純粋性)**: `TsFragment` は「そのファイル自身の
内容 (+ tsconfig / file-set env key) だけの関数」でなければならない。warm build
は fragment を再利用し、graph 組み立てだけを再実行することで cold と構造同一に
なる (INV-L4 の成立機構)。

この制約から層の割当ては一意に決まる:

- **S3 / S2 → parser レベル** (`src/parsers/typescript.ts` `extractImports`)。
  必要な情報 (import 束縛と export 文) はファイル自身のテキストに閉じている。
  #177 の barrel materialization と同じ場所・同じパターンの拡張。
- **S1 → builder レベル** (`src/graph/builder.ts` に新パス)。origin の export
  名集合は**別ファイル**に住むため、parser レベルで展開すると fragment が
  他ファイル内容に依存し、warm cache が silent stale になる。builder で毎
  build 再計算すれば、origin 側の変更は origin 自身の fragment 更新として
  流れ込み、barrel の cache は温存されたまま展開結果だけ追随する。
- **S1 の情報伝搬 → fragment side-channel**。`export *` の存在は現状
  `file:B → file:O` edge としてしか残らず、namespace import / side-effect
  import と区別が付かない。issue #179 の想定どおり provenance / EdgeKind は
  増やさず、`ParsedTS` / `TsFragment` に side-channel フィールドを追加する:

  ```ts
  // ParsedTS / TsFragment に追加
  starExports?: string[];  // `export * from` の解決済み rootDir-relative
                           // ターゲット。宣言順。symbol mode の非 test
                           // ファイルのみ記録。空なら省略。
  ```

  `export * as ns` は名前がローカルに書かれているので side-channel には
  **入れない** (parser レベルで完結)。

## 4. 合成 node の contentHash — 単一規約 (D1)

#177 が導入した規約 `hash([targetRel, local, exported].join("\0"))` を
そのまま一般化し、**全**合成 re-export node に適用する:

```
contentHash = hash([resolvedTargetRel, originBinding, exportedName].join("\0"))
  originBinding ∈ { origin 側 export 名, "default", "*" ("*" = モジュール全体束縛) }
```

| 構文 | node | hash 入力 | edge target |
|------|------|-----------|-------------|
| `export { x as y } from "./m"` (#177 既存) | `symbol:B#y` | `[m, "x", "y"]` | `symbol:m#x` |
| star 展開で x を供給 (S1) | `symbol:B#x` | `[T, "x", "x"]` (T = 直近 star 供給元) | `symbol:T#x` |
| `export * as ns from "./m"` (S2) | `symbol:B#ns` | `[m, "*", "ns"]` | `file:m` |
| `import { x } from "./m"; export { x as y }` (S3-C4) | `symbol:B#y` | `[m, "x", "y"]` | `symbol:m#x` |
| `import X from "./m"; export { X }` (S3-C4) | `symbol:B#X` | `[m, "default", "X"]` | `symbol:m#default` |
| `import * as ns from "./m"; export { ns }` (S3-C4) | `symbol:B#ns` | `[m, "*", "ns"]` | `file:m` |
| `import X from "./m"; export default X` (S3-C3) | `symbol:B#default` | `[m, "default", "default"]` | `symbol:m#default` |
| `import { x } from "./m"; export default x` (S3-C3) | `symbol:B#default` | `[m, "x", "default"]` | `symbol:m#x` |
| `import * as ns from "./m"; export default ns` (S3-C3) | `symbol:B#default` | `[m, "*", "default"]` | `file:m` |

**性質 (テストで pin する)**:
- 決定性: 入力は解決済み rel path と名前のみ。ファイル走査順・OS 非依存。
- リファクタ等価性: `import { x } from "./m"; export { x };` ⇔
  `export { x } from "./m"`、star 展開 ⇔ 明示的
  `export { x } from "./T"` が **lock byte 等価**。`export *` を明示列挙に
  書き換えても reconcile diff が出ない。
- 既存 hash 不変: #177 の named re-export の hash 入力は変更しない
  (既存 lock エントリのバイト列は不変、diff は**追加**のみ)。

実装は 1 ヘルパー関数に集約 (SSOT)。

## 5. S1: builder の star 展開アルゴリズム

issue #179 は「新規 node が増えなくなるまで反復 (fixpoint)」を想定していたが、
反復中の曖昧性 drop が単調性を壊し、収束・順序非依存の証明が面倒になる。
代わりに **ECMAScript 仕様の `GetExportedNames` / `ResolveExport` をそのまま
実装する** (D2)。これは module graph の純関数であり、再帰 + visited スタックで
決定性・停止性が仕様レベルで保証される (fixpoint の意図を満たす上位互換)。

```
入力:
  nodes: 組み立て済み全 fragment の node Map
  starMap: Map<fileRel, targetRel[]>   // fragment の starExports を集約

ownNames(F) = { name | nodes に symbol:F#name が存在 }
  // #177 の named re-export 合成 node、S2/S3 の parser 合成 node を自然に含む

resolve(F, name, stack) → "local" | { provider: rel } | "ambiguous" | "none"
  1. name === "default" → "none"          // export * は default を再輸出しない
  2. symbol:F#name が存在 → "local"       // local decl / named re-export / S3 が star に勝つ
  3. (F, name) ∈ stack → "none"           // 循環カット (仕様の resolveSet 相当)
  4. providers = { T ∈ starMap[F] | resolve(T, name, stack ∪ {(F,name)}) ∉ {"none"} }
  5. |providers| = 0 → "none"
  6. |providers| ≥ 2 → "ambiguous"        // 曖昧 star (D3)
  7. |providers| = 1:
       resolve(T, …) が "ambiguous" → "ambiguous"   // 曖昧性は上流へ伝播
       それ以外 → { provider: T }

exportedNames(F, visited) =
  ownNames(F) ∪ ⋃_{T ∈ starMap[F], F ∉ visited} (exportedNames(T, visited∪{F}) \ {"default"})

展開 (barrel B ∈ starMap を rel path 昇順、name を昇順で):
  for name ∈ exportedNames(B) \ ownNames(B):
    r = resolve(B, name, ∅)
    r = { provider: T } のとき:
      node  symbol:B#name (kind: "symbol", filePath: B,
            contentHash = hash([T, name, name].join("\0")))
      edge  symbol:B#name --imports--> symbol:T#name (provenances: ["ts-import"])
    r = "ambiguous" / "none" のとき: 実体化しない (§7 fail-safe に委譲)
```

**多段チェーン** `A: export * from B; B: export * from C; C: x` は node レベルの
反復なしで閉じる: `exportedNames(A)` の再帰が名前を運び、A の edge は
`symbol:B#x` (B 自身の展開で必ず実体化される id) を指す。実行順に依存しない。

**循環** `A ↔ B` は visited / stack カットで停止。片側にしかない名前は
正しく双方向に伝播する (ES 仕様と同じ)。

**edge target は「直近の star 供給元」(D4)**: 究極 origin まで畳まず 1 hop ずつ
繋ぐ。§4 のリファクタ等価性が保て、`entryOriginIds` (BFS) / `impact` (BFS)
はどちらも推移的に辿るので到達性は変わらない。

**挿入位置**: builder.ts の TS edge 取り込み (現 L371-395) の直後、
phantom-repair パス (現 L409) の**前**。展開で実体化された node は repair の
「dangling 判定」から自然に外れる。

**メモ化**: (F, name) 単位のメモ化は循環カット越しの結果を汚染しうるので、
完走した (stack カットに触れなかった) 結果のみキャッシュするか、素の再帰の
まま実装する (規模: 名前数 × star edge 数で十分小さい)。正しさ優先。

## 6. S2 / S3: parser の実装点

`extractImports` (typescript.ts) に閉じる。前段で 1 pass、import 束縛表を作る:

```
importBindings: Map<localName, { specifier, binding: "default" | "*" | { name } }>
  // ImportDeclaration の specifier 種別から。import type も同扱い (D5)
```

- **S2**: `ExportAllDeclaration` で `exported` 非 null (`export * as ns`) の
  とき、既存の file-grain edge (`file:B → file:O`) に**加えて**
  `symbol:B#ns` node + `symbol:B#ns → file:O` edge を実体化
  (localSymbolIds shadowing ガードは既存 barrel 実装と共通)。
  `exported` が null (plain `export *`) のときは従来どおり file-grain edge +
  `starExports` side-channel への記録のみ。
- **S3-C4**: source なし `ExportNamedDeclaration` の specifier で、local 名が
  local decl に無く (`localSymbolIds` に `symbol:B#exported` が無く)
  `importBindings` にヒットする場合、§4 の表どおり実体化。
- **S3-C3**: `ExportDefaultDeclaration` で declaration が `Identifier`、
  local decl lookup がミスし `importBindings` にヒットする場合、
  `symbol:B#default` を実体化。extractSymbols 側 (L484-488 の skip) は
  変更しない — 実体化は解決コンテキスト (ctx) を持つ extractImports に集約。
- 未宣言・未 import の identifier は従来どおり skip (挙動不変)。

consumer 側 import edge (`file:consumer → symbol:B#…`) の生成は一切変更しない。

## 7. shadowing / 曖昧性 / fail-safe (D3)

優先順位 (ES / TS の解決順に一致):

1. **local 宣言 / named re-export / S2 / S3 合成** — `ownNames` が star に勝つ。
   parser 内は既存 `localSymbolIds` ガード、builder 展開は
   `exportedNames \ ownNames` で除外。
2. **star 同士の衝突** — 複数の star 宣言が同名を供給 → "ambiguous" として
   drop。上流 barrel へも伝播 (§5 手順 7)。
3. **drop / none の帰結** — consumer の `import { x }` edge は phantom のまま
   残り、既存 phantom-repair が `file:B` に降格 + `phantom-import-repaired`
   warning (silent, JSON のみ)。**現状と同じ file 粒度 fail-safe に自然に
   落ちる**ので、fail-open は発生しない。新 warning type は追加しない —
   barrel 側で warning を出すと consumer 不在でも鳴る noise になり、消費点
   での観測は既存 warning が既に担っている。

**仕様からの意図的逸脱 (D4 系)**: ES 仕様では「複数 star 経由でも究極の束縛が
同一なら曖昧でない」(diamond: A→{B,C}→D, D.x)。本設計は直近供給元が 2 つ
あった時点で drop する (束縛同一性の比較を実装しない)。理由: (a) 供給元
identity の比較は edge 設計 (直近 1 hop) と噛み合わない、(b) drop しても
file 粒度 fail-safe で REQ 到達は保たれる (fail-open にならない)、(c) 発生
パターンが限定的。実リポジトリで問題になったら束縛同一性比較で精緻化する
余地を known limitation として明記する。

## 8. キャッシュ / lock / 不変条件

- **SCHEMA_VERSION 3 → 4** (parse-cache.ts)。理由は 2 つ独立に存在:
  (a) `TsFragment` に `starExports` が増える — 旧 cache の fragment には
  無いため、warm だけ展開されず cold と分岐する (INV-L4 違反) のを
  cold-invalidate で遮断。(b) parser 出力自体が変わる (S2/S3 の node/edge)。
- **`importTargetsExist` は変更不要**: plain `export *` は file-grain edge
  (`file:B → file:O`) が fragment に残るので、O の削除は既存の existsSync
  検証で fragment 無効化 → 再 parse で side-channel も消える。S3 の edge は
  `symbol:m#x` target で既存の rel 抽出ロジックがそのまま効く。
- **lock**: 合成 node (builder 展開含む) は `buildLockFromGraph` が symbol
  node として素通しで拾う (コード変更不要)。warm/cold とも毎 build 同じ
  展開が走るので byte-identity 成立。**migration**: 初回 reconcile で
  star barrel / S3 ファイルに新規 `symbol:` エントリが**追加**される
  (既存エントリの hash は不変 — §4)。CHANGELOG に #180 と同形式で記載。
- **edge/node 順序**: builder 展開の emit 順は `dedupEdges` の post-dedup
  sort と `sortNodesById` が吸収する (canonical.ts 既存保証)。とはいえ
  展開自体も rel path / name 昇順で走らせ、順序依存を作らない。
- **provenance**: 全合成 edge は既存 `"ts-import"`。EdgeKind / provenance
  追加なし (G5)。

## 9. 下流への影響

| 消費側 | 影響 |
|--------|------|
| `impact` (BFS) | consumer named import が origin symbol へ直結 → blast radius から origin の無関係 REQ が消える (精度向上)。file-unit 入力は file-grain edge を残すため到達集合は実質不変 |
| `entryOriginIds` (#191 BFS) | `symbol:B#x` が実在するようになり、star barrel 越しでも origin の `@impl` に到達。S2/S3 の `→ file:m` edge は symbol→symbol フィルタで無視 (保守的、現状維持) |
| `resolveStartIds` | **star barrel の `path:symbol` 入力が「No matching symbol found」エラーにならず解決するようになる** (ユーザー可視の改善、#179 の副次効果) |
| `check` / gate | implements / verifies edge の生成規則は不変。orphan 判定も不変 |
| phantom-repair / #189 warnings | 展開が効いた分 `phantom-import-repaired` の発火が減る (意図どおり)。型・presenter 変更なし |
| file mode | 一切不変 (useSymbol ガード + builder 展開は symbol mode 限定) |

## 10. 既知の制限 (実装後も残るもの)

- fatal syntax error ファイル: staticExports fallback は名前も star 区別も
  回復しない → 従来どおり file 粒度 (#180 原則)。
- 曖昧 star (§7) と diamond-同一束縛 (D4): file 粒度 fail-safe。
- star ターゲットがスキャン範囲外 (exclude glob 等): 展開不可 → 従来どおり
  `dangling-import` / repair。
- `// @impl REQ` を `export * from …` の直上に書いた場合: star 文は
  symbolRange を持たないため file 帰属のまま (従来どおり)。
- `export =` origin (#187): file 粒度のまま。
- parser 側 unresolved-reexport の silent skip (#189 残項目): 対象外。

## 11. テスト計画

tests/barrel-reexport.test.ts に節を追加 + parse-cache / integration:

| # | ケース | 期待 |
|---|--------|------|
| T1 | S1 基本: O(x:@impl REQ-X, y:@impl REQ-Y), B: `export * from O`, C: `import { x } from B` | C の impact に REQ-X のみ (REQ-Y が入らない)。`symbol:B#x → symbol:O#x` edge 存在 |
| T2 | 多段: A→B→C チェーン + consumer | leaf REQ のみ到達。`symbol:A#x → symbol:B#x → symbol:C#x` |
| T3 | 循環 A↔B (各自 local 1 export) | 停止し、相互の名前が双方向に実体化。自己名は重複しない |
| T4 | `#default` 除外: O が default export を持つ, B: `export * from O`, C: `import d from B` | `symbol:B#default` 非実体化 → repair で file 粒度 (fail-open しない) |
| T5 | shadowing: B が local x + `export * from O` (O も x) | `symbol:B#x` は local 宣言 node。star edge 不生成。origin REQ が consumer に混入しない |
| T6 | named re-export が star に勝つ: B: `export { x } from o1` + `export * from o2` (o2 も x) | edge は o1 のみ |
| T7 | 曖昧: B: `export * from o1` + `export * from o2` (両方 x) | `symbol:B#x` 非実体化 → repair + `phantom-import-repaired` |
| T8 | S2: `export * as ns from O` | `symbol:B#ns → file:O`。O の中身は展開されない。file edge も残存 |
| T9 | S3-C3: `import X from a; export default X` + consumer default import | `symbol:B#default → symbol:a#default`、per-symbol 到達 |
| T10 | S3-C4 等価性: `import {x} from m; export {x}` の lock bytes ≡ `export {x} from m` の lock bytes | byte 等価 (§4 リファクタ等価性) |
| T11 | S3 named-alias / default-import / namespace の各行 (§4 表) | 表どおりの edge target |
| T12 | INV-L4: star barrel を含む fixture で warm/cold の lock byte-identity (parse-cache.test.ts) | 一致。SCHEMA_VERSION 不一致の旧 cache は cold 落ち |
| T13 | integration: `plan-coverage` / `impact` の `barrel.ts:x` 入力 (star barrel) | unresolvedSymbol エラーにならず originReqs が origin の REQ を含む (drift 誤検知なし) |
| T14 | `export type * from` | 値 star と同様に展開 (`export type { } from` の既存前例と整合) |
| T15 | 壊れたファイル (fatal error) 内 star | file 粒度のまま、クラッシュしない |
| T16 | star + origin 追加 export の warm 更新: O に export 追加 → O のみ再 parse でも B の展開が追随 | warm build に新 symbol が現れ cold と一致 |

## 12. 変更ファイル一覧 (実装フェーズ)

| ファイル | 変更 |
|----------|------|
| `src/parsers/typescript.ts` | importBindings pass、S2/S3 実体化、`starExports` side-channel、hash ヘルパー SSOT 化 |
| `src/parse-cache.ts` | `TsFragment.starExports?`、SCHEMA_VERSION 3→4 |
| `src/graph/builder.ts` | star 展開パス (§5) を phantom-repair の前に追加 |
| `tests/barrel-reexport.test.ts` ほか | §11 |
| `docs/architecture.md` §11 / `docs/skills-guide.md` / `CHANGELOG.md` / specs/016 data-model §3.2 注記 | 挙動更新 + migration 記載 |

PR は 1 本 (feat)。コミットは S3/S2 (parser) → S1 (builder) → docs の順に分割。
