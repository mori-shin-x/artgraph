# Phase 0: Research & Decisions — Edge Provenance First-Class

Date: 2026-06-26
Plan: [plan.md](./plan.md) | Spec: [spec.md](./spec.md)

本 feature は仕様策定段階で論点を全て解消済み（`[NEEDS CLARIFICATION]` ゼロ）。
本文書では「決定したこと」「却下した代替案」「根拠」を 6 つの設計判断について整理する。

---

## R1: EdgeProvenance の値域

**Decision**: 8 値の string literal union

```ts
type EdgeProvenance =
  | "annotation"   // markdown インライン (depends_on:)/(derives_from:) 注釈
  | "frontmatter"  // YAML artgraph.{depends_on,derives_from}
  | "convention"   // フォルダ規約推論 (kiro / spec-kit のファイル名 stem)
  | "code-tag"     // TS の @impl(...) / @verifies(...) / req: タグ
  | "task-tag"     // markdown タスク preset の implementsTagRe / verifiesTagRe
  | "inline-link"  // markdown インラインリンク [text](path) 由来 depends_on
  | "ts-import"    // TS import 文由来 imports
  | "structural";  // doc → 子 req/task auto contains
```

**Rationale**:
- `code-tag` / `task-tag` 分割: 両者は発生媒体（TS コード vs Markdown task リスト）・lifecycle（コード変更 vs spec/plan 改訂）・誤検出時の修正手段が異なる。`"tag"` 単一だと CLI で `--filter=provenance=tag` フィルタしたとき切り分け不能になる。
- `ts-import` (not `"import"`): `EdgeKind` に `"imports"` が既存する。`"import"` だと `e.kind === "import"` の typo が TS narrowing を抜ける silent failure 源になる。語彙レベルで kind と provenance を分離。
- `structural` (not `"contains"` / `"auto-contains"`): doc → 子 req/task の自動接続は「source ファイルの構造的事実」が edge の根拠。kind と同名にすると概念を区別しづらい。

**Alternatives rejected**:
- 4 値（annotation / frontmatter / convention / tag のみ）: issue 本文の最小範囲だが、`autoContains` / inline-link / TS import 経路で provenances が空になる。「全 edge に provenance」要件を満たせない。
- 7 値（"tag" を統合）: debugging で TS と markdown task の区別が不可能、上記の通り却下。
- 8 値以上（"yaml-config" / "user-override" など）: 現アーキでそれらを生成する経路が存在せず YAGNI。将来必要になれば追加可能（後方互換性を考えなくて済む未リリース）。

## R2: GraphEdge.provenances を required NonEmptyArray にする

**Decision**:

```ts
type NonEmptyArray<T> = readonly [T, ...T[]];
interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  provenances: NonEmptyArray<EdgeProvenance>;
}
```

**Rationale**:
- TS の tuple 型で「最低 1 要素」を **型レベルで静的保証**できる。runtime assert に頼ると、`.filter()` / `Array.from(set)` / spread のような後付けロジックが空配列を作る経路が将来生まれたとき silent regression する。
- optional の単数 `provenance?: EdgeProvenance` を残すと、「ある edge は provenance 未設定」のケースが残り、CLI 出力で「undefined を含む集合」に対するハンドリングを書き続けなければならない。
- readonly tuple は immutability も同時に表現できる。

**Alternatives rejected**:
- `provenances: EdgeProvenance[]` + runtime assert: 型安全性が一段落ち、上記の silent regression リスク。
- `provenance: EdgeProvenance` を残し「複数値は別 edge にする」: dedup 統合の意味論が崩れ、edge 数が膨張。CLI 出力や lock サイズで現実的でない。
- discriminated union (`{provenance: "annotation"} | {provenance: "convention"}` 等): 値域 8 種で boilerplate が爆発、provenance 統合時に union を扱えない。

## R3: dedup 時の複数 provenance マージ方式

**Decision**: 同一 `(source, target, kind)` の edge は 1 本に集約、`provenances` を **集合 union** で統合する。

```ts
// builder.ts での dedup ロジック (擬似コード)
const seen = new Map<string, GraphEdge>();
for (const edge of edges) {
  const key = `${edge.source}|${edge.target}|${edge.kind}`;
  const existing = seen.get(key);
  if (!existing) {
    seen.set(key, edge);
  } else {
    const merged = Array.from(new Set([...existing.provenances, ...edge.provenances]));
    merged.sort();  // 決定的順序
    existing.provenances = merged as NonEmptyArray<EdgeProvenance>;
  }
}
```

**Rationale**:
- 同一 edge を複数本残すと CLI 出力で「同じ source/target/kind が 2 回現れる」混乱が生じる。
- `Set` 経由で「同じ provenance 値の重複」（例: 同ファイル内 `@impl(FR-001)` 2 回）を自然に排除。
- 最終 `sort()` で出力決定性を確保（実装順序・push 順序に依存しない）。

**Alternatives rejected**:
- edge を分離保持 (`[{prov: "frontmatter"}, {prov: "convention"}]`): edge 数膨張、dedup の概念が崩れる、CLI の表示重複。
- 優先順位ルールで単数維持: 「frontmatter が convention に勝つ」等のルールを設けても、`autoConventions: false` の意味論を表現できない（「両方の由来があった」事実を消す）。

## R4: lock スキーマの構造化範囲

**Decision**: `LockEntry.dependsOn` のみを構造化する。`impl` / `tests` は `string[]` 据置。

```ts
interface LockEntry {
  contentHash: string;
  lastReconciled: string;
  specFile?: string;
  dependsOn?: Array<{ id: string; provenances: EdgeProvenance[] }>;  // ← 構造化
  impl?: string[];   // 据置
  tests?: string[];  // 据置
}
```

**Rationale**:
- `impl` / `tests` は実運用で provenances が事実上 `["code-tag"]` のみ（markdown task 由来は `lock.ts:64-69` の `isTaskSource` フィルタで除外済み）。構造化すると「情報量ゼロのメタデータ」を全エントリで書き続けることになり、lock サイズが冗長に膨らむ。
- `dependsOn` のみ frontmatter / convention / inline-link / annotation が混在しうるので構造化に意味がある。

**Alternatives rejected**:
- 全 3 フィールド構造化: 上記のとおり情報量が無い。lock の可読性も落ちる。
- 別 side table（`provenancesById: {id: provenances}`）: rename 時に 2 箇所の整合更新が必要、broken-window リスク（id 側だけ書換えて provenances 側を忘れる）。inline 構造のほうが正規化失敗時の被害が小さい。

## R5: annotation edge を lock に乗せる

**Decision**: `lock.ts:81-91` の `provenance !== "annotation"` フィルタを撤去し、annotation 由来 edge も `dependsOn` に書き出す。`buildLockFromGraph` 末尾で `dependsOn[]` を `id` 昇順 sort、各 `provenances[]` も sort。

**Rationale**:
- ユーザー方針「全 edge に provenance」と「lock にも書き出す」は両立する必要がある。annotation だけ除外すると spec/impl の対称性が崩れる。
- 注釈追記による lock churn は許容: `check --gate` の drift 判定は `contentHash` 比較のみ（`check.ts:8-20`）なので、`dependsOn` 変動は gate 失敗を引き起こさない。
- sort で「同じ入力から同じ lock を生成」を保証（バイト一致 SC-003）。

**Alternatives rejected**:
- annotation を除外し続ける: spec を強行すると整合性が崩れる。
- lock を全く書き出さない方針: `artgraph check` の drift 検出・PR レビュー時の参照価値が失われる。
- annotation を別フィールド `annotationDeps` に分離: lock schema の複雑化、CLI の表示ロジックも分岐が増える。

## R6: 既存 spec/contract のハンドリング

**Decision**: `specs/010-req-req-dependency/contracts/provenance-field.md` は historical record として保持し、末尾に「#35 で正式化された → specs/011-edge-provenance/ を参照」の pointer を追記する。010 spec 自体の文章は書き換えない。

**Rationale**:
- 010 spec は別 feature（req→req dependency annotation）のもので、本 spec のスコープ外。
- contract 文書は「ある時点での決定の記録」であり、後から書き換えると `010` の git history 上で読まれたときに混乱を生む。
- pointer 追記は最小侵襲。

**Alternatives rejected**:
- 010 spec 内に直接追記 / 構造変更: 010 の責務超過。
- 010 spec を新しく書き直す: rebase 風の操作で history を汚す。
- 011 spec に 010 の内容をコピー: 重複ドキュメント、同期コスト。

---

## まとめ

| 論点 | 決定 | 主な代替案 |
|---|---|---|
| R1: provenance 値域 | 8 値 (`code-tag`/`task-tag` 分割, `ts-import` で kind と分離) | 4 値 / 7 値 / 9 値以上 |
| R2: provenances 型 | required `NonEmptyArray<EdgeProvenance>` | optional 単数 / `[]` allow + runtime assert |
| R3: dedup 方式 | 集合 union + sort | edge 分離保持 / 優先順位ルールで単数 |
| R4: lock 構造化 | `dependsOn` のみ `{id, provenances}` | 全 3 フィールド / 別 side table |
| R5: annotation in lock | 乗せる + sort で決定性 | 除外継続 / 別フィールド分離 |
| R6: 010 spec の扱い | pointer 追記のみ | 010 を書換 / 011 にコピー |

すべての論点で「実装の最も簡素な選択」と「将来の拡張余地」の trade-off を `Constitution 原則 I（決定的グラフ第一）` と `原則 II（単一型付き4層グラフ）` で評価し、両立する案を採択した。
