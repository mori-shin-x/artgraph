# Research: ドキュメント間グラフ構造

## R1. contains エッジの双方向 BFS における爆発抑制

Decision: `--depth N` オプションで BFS の探索深さを制限する。デフォルトは無制限（既存動作を維持）

Rationale:
- contains エッジは doc→req の所属関係を表し、双方向 BFS では req から親 doc に遡り、さらに別の req に到達する「逆流」が発生する
- 逆流パスは「spec.md 内の FR-001 が変更された → spec.md 自体が影響範囲 → spec.md 内の FR-002 も影響範囲」という形で、意図せず大量のノードに到達する
- depth 制限により、ユーザーは `artgraph impact --depth 2 FR-001` のように直近の影響のみを確認できる
- 現在の `impact` 関数（`src/graph/traverse.ts` L4-59）は depth 追跡なしの単純な BFS。depth パラメータを追加し、各ノードの到達深さを記録する形に拡張する
- デフォルト無制限とすることで、既存の動作を壊さない

Alternatives considered:
- contains エッジを単方向（doc→req のみ）にする: req 起点で親 doc に到達できなくなり、「このファイルのどの要求が影響を受けるか」を表現できない
- contains エッジを BFS 対象外にする: doc グラフと req グラフが完全に分断され、一気通貫トレースの目的を達成できない
- 到達回数や重みベースの制限: 実装が複雑で、ユーザーにとって挙動が予測しにくい

Implementation:
- `impact` 関数のシグネチャに `maxDepth?: number` を追加
- BFS キューの各要素に depth カウンタを持たせる: `queue: Array<{ id: string; depth: number }>`
- `maxDepth` が指定されている場合、`depth >= maxDepth` のノードからは隣接ノードをキューに追加しない
- CLI の `--depth` オプションを `program.command("impact")` に追加（L52-87）

## R2. frontmatter A案（relation キーのフラット化）のパーサ実装方針

Decision: `artgraph` ブロック内で relation をキーとしてフラット記述する

現在の frontmatter パース（`src/parsers/markdown.ts` L40-64）:
```yaml
artgraph:
  node_id: "design-doc"
  depends_on:
    - id: "requirements.md"
      relation: "derives_from"
```

新しいフラット化された frontmatter:
```yaml
artgraph:
  node_id: "design-doc"
  derives_from:
    - requirements.md
  depends_on:
    - shared-types.md
```

Rationale:
- relation をキーにすることで、YAML としてより直感的に記述できる
- `depends_on` 配列内に `{ id, relation }` オブジェクトを入れる現行形式は、relation が derives_from なのに depends_on キーの中に入るという矛盾がある
- フラット化により、未知のキー（`extends` 等）を検出して `invalid-relation` 警告を出す処理が単純になる
- spec に明記されている 2 種類の relation（derives_from, depends_on）以外のキーは、`artgraph` ブロック内の予約キー（`node_id`）を除いて全て invalid-relation として警告する

Implementation:
- `parseMarkdown` の `artgraphMeta` 型定義を変更: `{ node_id?: string; derives_from?: string[]; depends_on?: string[]; [key: string]: unknown }`
- 予約キー `node_id` と有効な relation キー `derives_from`, `depends_on` 以外のキーを検出したら `invalid-relation` 情報を返す
- `parseMarkdown` の返り値に `warnings` フィールドを追加するか、または `buildGraph` 側で frontmatter をバリデーションする

Alternatives considered:
- 現行の `depends_on: [{ id, relation }]` 形式を維持: relation が depends_on の子にあるのは直感に反する。derives_from を表現するのに depends_on キーを使う矛盾
- frontmatter ではなくインラインリンク `[→ requirements.md]` で依存を表現: パース実装が複雑で、散文中のリンクとの区別が困難。v1 スコープ外（Assumption）

## R3. doc ノード自動採番の ID 形式と resolveStartIds の拡張

Decision: `doc:<specDir からの相対パス>` 形式で自動採番する。`resolveStartIds` にファイルパスから doc ノードへの解決を追加する

ID 形式の例:
- `specs/requirements.md` → `doc:requirements.md`（specDir が `specs` の場合）
- `specs/001-auth/spec.md` → `doc:001-auth/spec.md`
- `docs/design.md` → `doc:design.md`（specDir が `docs` の場合）

resolveStartIds の現状（`src/graph/traverse.ts` L90-113）:
1. `graph.nodes.has(input)` → 直接マッチ
2. `file:${input}` → file ノードとしてマッチ
3. `node.filePath === input` → filePath が一致するノードを全て返す

拡張:
4. `doc:${input}` → doc ノードとしてマッチ（新規）

Rationale:
- `doc:` プレフィクスは既存の `file:` プレフィクスと対称的で、ユーザーにとって自然
- specDir からの相対パスを使うことで、プロジェクト構造を反映した一意な ID になる
- frontmatter `artgraph.node_id` でカスタム ID を指定できるため、自動採番 ID が不都合な場合はオーバーライド可能
- resolveStartIds のステップ 3（filePath 一致）で、ファイルパスを指定すると対応する doc ノードと req ノードの両方が起点になる。FR-010 の要件を自然に満たす

Alternatives considered:
- ファイルパスそのものを ID にする: `file:` ノードと ID 形式が衝突する
- ハッシュベースの ID: ファイル内容変更のたびに ID が変わり、lock ファイルとの紐づけが壊れる
- ファイル名のみ（パスなし）: 異なるディレクトリに同名ファイルがある場合に衝突する

## R4. `artgraph graph` コマンドの出力フォーマット設計

Decision: text 形式ではインデント付きツリー表示、JSON 形式では `{ nodes: [...], edges: [...] }` を出力する

text 形式の出力例:
```
doc:requirements.md
  └─[derives_from]─ doc:design.md
    └─[derives_from]─ doc:tasks.md
  └─[contains]─ FR-001
    └─[implements]─ file:src/auth/login.ts
  └─[contains]─ FR-002
```

JSON 形式の出力例:
```json
{
  "nodes": [
    { "id": "doc:requirements.md", "kind": "doc", "filePath": "specs/requirements.md" },
    { "id": "doc:design.md", "kind": "doc", "filePath": "specs/design.md" },
    { "id": "FR-001", "kind": "req", "filePath": "specs/requirements.md" }
  ],
  "edges": [
    { "source": "doc:design.md", "target": "doc:requirements.md", "kind": "derives_from" },
    { "source": "doc:requirements.md", "target": "FR-001", "kind": "contains" }
  ]
}
```

`--kind` オプション:
- `--kind doc` → doc ノードと doc 間エッジのみ表示
- `--kind req` → req ノードとその関連エッジのみ表示
- 省略時は全ノード種別を表示

Rationale:
- text 形式はターミナルでの人間の確認用途に適する。ルートノード（他のノードの target になっていないノード）からの深さ優先走査で生成
- JSON 形式は他ツールとの連携やスクリプト処理に適する。グラフの全ノード・全エッジをそのまま出力
- `--kind` フィルタはノードの `kind` フィールドでフィルタし、エッジは source と target の両方がフィルタを通過した場合のみ出力

Alternatives considered:
- DOT / Mermaid 形式: v1 スコープ外（Assumption）。テキストとしての可読性が低い
- 隣接リスト形式: ノードのメタデータ（kind, filePath）が表現しにくい
- テーブル形式: ツリー構造の表現に不向き

Implementation:
- `src/graph/format.ts` を新規作成
- `formatGraphText(graph, kindFilter?)` と `formatGraphJSON(graph, kindFilter?)` を export
- CLI の `program.command("graph")` で `--format` と `--kind` オプションを受け取り、フォーマッタを呼び出す

## R5. EdgeKind に `contains` を追加した場合の既存テストへの影響

Decision: EdgeKind union に `"contains"` を追加する。既存テストへの影響は限定的

現状の EdgeKind（`src/types.ts` L3）:
```ts
export type EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports";
```

変更後:
```ts
export type EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports" | "contains";
```

影響分析:
- `src/graph/traverse.ts`: `impact` 関数は EdgeKind に依存しない（全エッジを双方向に辿る）。影響なし
- `src/graph/traverse.ts`: `findOrphans` は `implements` / `verifies` のみチェック（L62-69）。contains は対象外。影響なし
- `src/graph/traverse.ts`: `findUncovered` は `implements` のみチェック（L78-82）。影響なし
- `src/graph/builder.ts`: `buildGraph` は EdgeKind を直接操作しない。影響なし
- `src/lock.ts`: `buildLockFromGraph` は `implements` / `verifies` / `depends_on` / `derives_from` をフィルタ（L38-55）。contains は lock に含まれない（spec の Assumption: contains は永続化しない）。影響なし
- `src/coverage.ts`: `implements` / `verifies` のみ（L16-17）。影響なし

既存テストへの影響:
- `tests/traverse.test.ts`: impact テストは全エッジを辿るため、contains エッジが追加されると到達ノードが増える可能性がある。ただしフィクスチャに contains エッジを含めなければ既存テストは変わらない
- `tests/builder.test.ts`: doc ノードの自動生成により、既存フィクスチャから新たに doc ノードが生成される。nodeCount アサーションの更新が必要になる可能性がある
- 結論: contains エッジは `buildGraph` 内で doc ノードの生成後に新規ロジックとして追加するため、既存テストのフィクスチャに doc ノードが追加される影響のみ。`docGraph.autoNodes: false` をテスト設定で指定すれば既存テストを変更せずに済む

Alternatives considered:
- contains を EdgeKind に追加せず別の型にする: グラフモデルの一貫性が崩れる。ArtifactGraph.edges に混在できない
- contains を別の配列で管理: traverse 関数で 2 つの配列を走査する必要があり、コードが複雑化する

## R6. orphan-doc / invalid-relation 警告の BuildWarning 拡張

Decision: 既存の `BuildWarning` type union に `orphan-doc`, `invalid-relation`, `reserved-prefix` を追加する

現状の BuildWarning（`src/graph/builder.ts` L7-10）:
```ts
export interface BuildWarning {
  type: "duplicate-id" | "ambiguous-id";
  id: string;
  files: string[];
}
```

変更後:
```ts
export interface BuildWarning {
  type: "duplicate-id" | "ambiguous-id" | "orphan-doc" | "invalid-relation" | "reserved-prefix";
  id: string;
  files: string[];
  message?: string;
}
```

各警告の発生条件:
- `orphan-doc`: frontmatter の依存先（derives_from / depends_on の値）に対応するノードがグラフに存在しない場合。`id` に依存先の ID、`files` にソースファイルを格納
- `invalid-relation`: frontmatter の `artgraph` ブロックに `node_id` / `derives_from` / `depends_on` 以外のキーがある場合。`id` にキー名、`files` にソースファイルを格納
- `reserved-prefix`: req ID が `doc:` / `file:` / `test:` / `symbol:` プレフィクスを使用している場合。`id` に req ID、`files` にソースファイルを格納

check --gate との関係:
- spec FR-005 で「check --gate 実行時は warning として報告するが gate を fail させない」と明記されている
- BuildWarning は現在も gate を fail させない（check 結果の `pass` フラグとは独立）。この挙動を維持する

Rationale:
- 既存の BuildWarning インターフェースを拡張することで、CLI の警告表示ロジック（`src/cli.ts` L42-49, L127-135）を自然に拡張できる
- `message` フィールドを追加することで、各警告に固有の説明テキストを付与できる（例: "relation 'extends' is not supported. Use 'derives_from' or 'depends_on'"）
- 既存の `duplicate-id` / `ambiguous-id` の処理パスはそのまま維持

Alternatives considered:
- 警告を別の型で管理: CLI の表示ロジックが分岐し、コードの重複が増える
- 警告をエラーにする: ユーザーの漸進的導入を阻害する（Constitution V. Incremental Adoption に違反）
- 警告を check 結果に含める: orphan-doc はグラフ構築時に検出されるため、builder の責務
