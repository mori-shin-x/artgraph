# Quickstart: GraphEdge / Lock provenance 機能の動作確認

Plan: [plan.md](./plan.md) | Spec: [spec.md](./spec.md) | Issue: [#35](https://github.com/ShintaroMorimoto/artgraph/issues/35)

本 quickstart は実装完了後、本 feature が end-to-end で機能していることを確認するための validation 手順を示す。

## 前提

- リポジトリルートで `pnpm install` 済み。
- `packages/artgraph` のビルドが通る（`pnpm -C packages/artgraph build`）。
- 本 feature の実装（`/speckit-implement` 完了後）が main 互換ブランチに乗っている。

## シナリオ 1: 全 8 provenance 値が付与されることを確認

`tests/fixtures/edge-provenance/all-eight/` 配下に、8 種類すべての provenance を 1 度ずつ生成する最小 fixture を用意する。

| ファイル | 役割 | 生成される provenance |
|---|---|---|
| `specs/design.md` （frontmatter `artgraph.derives_from`） | frontmatter | `"frontmatter"` |
| `specs/design.md` + `specs/requirements.md`（同ディレクトリ） | convention | `"convention"` |
| `specs/spec.md` の req に `(depends_on: AUTH-001)` 注釈 | annotation | `"annotation"` |
| `specs/tasks.md` の `- T001: ... [REQ-001]` | task-tag | `"task-tag"` |
| `src/auth.ts` の `// @impl AUTH-001` | code-tag | `"code-tag"` |
| `src/auth.ts` の `import { db } from "./db"` | ts-import | `"ts-import"` |
| `specs/spec.md` の本文中 `[design](./design.md)` インラインリンク | inline-link | `"inline-link"` |
| `specs/spec.md` の AUTH-001 を auto contains | structural | `"structural"` |

**実行**:
```sh
cd packages/artgraph
pnpm artgraph scan --root tests/fixtures/edge-provenance/all-eight
pnpm artgraph graph --root tests/fixtures/edge-provenance/all-eight --format json | jq '.edges[].provenances'
```

**期待**: 出力された `provenances` 配列の和集合が以下と一致:
```json
["annotation","code-tag","convention","frontmatter","inline-link","structural","task-tag","ts-import"]
```

各 edge は `provenances.length >= 1` を満たす（NonEmpty invariant: [contracts/edge-provenance-type.md](./contracts/edge-provenance-type.md) §INV-T1）。

## シナリオ 2: 2 経路 dedup union

`tests/fixtures/edge-provenance/two-paths/` 配下に、frontmatter と convention が同じ `(source, target, derives_from)` を生成する fixture を用意する。

```
specs/feature-a/
├── design.md          ← frontmatter: artgraph.derives_from: [doc:specs/feature-a/requirements.md]
└── requirements.md
```

frontmatter による明示宣言とフォルダ規約（kiro `design→requirements`）が両方マッチする。

**実行**:
```sh
pnpm artgraph graph --root tests/fixtures/edge-provenance/two-paths --format json \
  | jq '.edges[] | select(.source == "doc:specs/feature-a/design.md") | .provenances'
```

**期待**:
```json
["convention","frontmatter"]
```

- 1 本に統合される（複数 edge にならない）。
- 順序は昇順 sort で決定的（INV-T3）。

## シナリオ 3: lock の決定性

```sh
pnpm artgraph reconcile --root tests/fixtures/edge-provenance/all-eight
cp tests/fixtures/edge-provenance/all-eight/.trace.lock /tmp/lock1.json
pnpm artgraph reconcile --root tests/fixtures/edge-provenance/all-eight
diff /tmp/lock1.json tests/fixtures/edge-provenance/all-eight/.trace.lock
```

**期待**: diff の出力ゼロ（バイト一致、SC-003 / INV-L4）。

## シナリオ 4: lock の `dependsOn` が `{id, provenances}` 形式

```sh
jq '."doc:specs/spec.md".dependsOn' tests/fixtures/edge-provenance/all-eight/.trace.lock
```

**期待**:
```json
[
  { "id": "AUTH-001", "provenances": ["annotation"] },
  { "id": "doc:specs/design.md", "provenances": ["frontmatter", "inline-link"] }
]
```

- 各要素が `{id: string, provenances: EdgeProvenance[]}` 構造。
- 配列内 `id` 昇順、`provenances` も昇順（INV-L1, L2）。

## シナリオ 5: 注釈追記による gate 動作

`all-eight/` fixture には annotation 由来エッジが含まれている。これを元に「注釈をもう 1 つ追記しても gate が通る」ことを確認する。

```sh
# fixture から temp ディレクトリへコピーして破壊を避ける
TMP=$(mktemp -d) && cp -r tests/fixtures/edge-provenance/all-eight/* "$TMP/"
pnpm artgraph reconcile --root "$TMP"

# 既存 req 行末尾に注釈を追記（本文 hash が変わらないよう annotation の括弧のみ追加）
# fixture には list-item 形式の req 行があるので、そのうち 1 行末尾に追記する想定:
#   `- AUTH-002: セッション` → `- AUTH-002: セッション (depends_on: AUTH-001)`
# T007 で作成する all-eight/ にこの形の行を最低 1 つ含めること。
sed -i 's|^\(- AUTH-002: セッション\)$|\1 (depends_on: AUTH-001)|' "$TMP/specs/spec.md"

pnpm artgraph check --root "$TMP" --gate
echo "exit=$?"
```

**期待**:
- `exit=0`（gate 通る）。
- `.trace.lock` の `dependsOn` は変動しうるが、`contentHash` 比較に基づく drift 判定では gate 失敗しない（SC-006）。

## シナリオ 6: rename 後の provenance 維持

既存の `tests/fixtures/rename/` を使う（T021 で schema を新形式に書換済）。

```sh
# fixture を temp にコピーして破壊を避ける
TMP=$(mktemp -d) && cp -r tests/fixtures/rename/* "$TMP/"

# AUTH-001 を AUTH-100 に rename
pnpm artgraph rename --root "$TMP" AUTH-001 AUTH-100

# rename 後の lock を確認（fixture の構造に合わせて該当 key を選択）
jq '."AUTH-002".dependsOn // .[].dependsOn' "$TMP/.trace.lock"
```

**期待**:
```json
[ { "id": "AUTH-100", "provenances": ["annotation"] } ]
```

- `id` のみ書換、`provenances` は完全一致で維持（SC-005）。

## シナリオ 7: 不正値の配列内フィルタ

```sh
# 不正な provenance を含むエッジを手で混入させた JSON を持つ独自プログラムで再現
node -e '
const { formatGraphJSON } = require("./dist/graph/format.js");
const graph = { nodes: new Map(), edges: [
  { source: "a", target: "b", kind: "depends_on", provenances: ["annotation", "bogus"] },
  { source: "c", target: "d", kind: "depends_on", provenances: ["bogus"] },
]};
const out = JSON.parse(formatGraphJSON(graph));
console.log(JSON.stringify(out.edges, null, 2));
'
```

**期待**:
```json
[
  { "source": "a", "target": "b", "kind": "depends_on", "provenances": ["annotation"] }
]
```

- `"bogus"` は配列要素単位で除去される（[contracts/cli-output-format.md](./contracts/cli-output-format.md) §ランタイムバリデーション）。
- 全要素が無効になった 2 つ目の edge は出力配列から除外（INV-O3 維持）。

## シナリオ 8: text 出力での provenance 表記

```sh
pnpm artgraph graph --root tests/fixtures/edge-provenance/two-paths
```

**期待**: 各 edge 行に `{...}` で provenance が併記される（例: `└─[derives_from {convention,frontmatter}]─ doc:...`）。

## シナリオ 9: dedup 前後で edge 集合が不変 (SC-004)

provenance 化が edge を不正に作り消ししないことを確認する。

```sh
# 旧 fixture（例えば既存の tests/fixtures/conventions/）に対して、scan して
# (source, target, kind) の三つ組集合を抽出
pnpm artgraph graph --root tests/fixtures/conventions --format json \
  | jq -S '.edges | map({source, target, kind}) | unique' > /tmp/edges-new.json

# baseline は同じ fixture を旧コード (provenance 化前のリビジョン) で scan して保存しておく
diff /tmp/edges-baseline.json /tmp/edges-new.json
```

**期待**: diff の出力ゼロ（provenance フィールド以外で edge 集合が変化していない）。
baseline は実装着手時に旧 main の commit でキャプチャしておく（T013 の invariant
テストで自動化することを推奨）。

## 検証チェックリスト

- [X] シナリオ 1: 8 値の和集合一致 — 手動確認 OK（`tests/fixtures/edge-provenance/all-eight/`）
- [X] シナリオ 2: dedup union `["convention","frontmatter"]` — 手動確認 OK + `builder.test.ts > dedup union`
- [~] シナリオ 3: 2 回 reconcile のバイト一致 — `lastReconciled` フィールドだけ差分（その他はバイト一致）。INV-L4 自体は `lock.test.ts > byte-identical JSON` で frozen time 下に担保。フォローアップ: CLI レベルで「dependsOn 構造が一致するか」のサブ assertion を別途追加する余地あり。
- [X] シナリオ 4: lock の `dependsOn` が `{id, provenances}` 形式 — 手動確認 OK
- [~] シナリオ 5: 注釈追記で gate=0 — fixture `all-eight/` は uncovered req を含むため CLI gate がもとから fail する設計。SC-006 不変条件自体は `check.test.ts > SC-006` の単体テストで担保済（drift 判定が contentHash のみで dependsOn を見ない）。フォローアップ: SC-006 専用に「fully covered + annotation 追記」fixture を別途追加する余地あり。
- [X] シナリオ 6: rename 後の `provenances` 維持 — `rename.test.ts > SC-005` で担保
- [X] シナリオ 7: 不正値の配列要素単位フィルタ — `req-req-invariants.test.ts` の format フィルタテストで担保
- [X] シナリオ 8: text 出力に `{...}` 表記 — 手動確認 OK（出力例: `└─[derives_from {convention,frontmatter}]─ doc:feature-a/design.md`）
- [X] シナリオ 9: provenance 化前後で `(source,target,kind)` 集合が変化しない (SC-004) — `builder.test.ts > SC-004 edge-set baseline invariance` で `tests/__snapshots__/edge-set-baseline.json` と比較

すべて pass すれば feature が SC-001..SC-008 を満たしていることを確認できる。

## 注意

- 上記 fixture（`tests/fixtures/edge-provenance/{all-eight,two-paths}`）は本 feature の `/speckit-tasks` でタスク化し、`/speckit-implement` で生成される。`tests/fixtures/rename/` は既存 fixture で `.trace.lock` の schema のみ T021 で書換える。
- 本 quickstart はあくまで end-to-end の検証手順であり、単体テスト（vitest）の代替ではない。詳細な assertion は `tests/*` 配下のテストファイルが担う。
