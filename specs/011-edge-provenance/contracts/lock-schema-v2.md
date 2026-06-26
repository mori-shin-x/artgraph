# Contract: `.trace.lock` schema v2 — dependsOn 構造化

Plan: [../plan.md](../plan.md) | Data Model: [../data-model.md](../data-model.md) | Related Issue: [#35](https://github.com/ShintaroMorimoto/artgraph/issues/35)

> **Note on consumers (Issue #35, 確認 2026-06-26)**: 本 schema の `dependsOn`
> フィールドは現状 runtime で参照されない。drift 判定 (`check.ts`) は
> `contentHash` のみ参照し、coverage / traverse / impact も `graph.edges` を
> 直接走査する。`dependsOn` の存在価値は (a) `git diff .trace.lock` で PR
> レビュー時に依存変化を可視化する presentational 用途、(b) `artgraph rename`
> 時の参照書き換え対象 (`rename-lock.ts` のみが `entry.dependsOn` を読む)、
> の 2 点のみ。**1st-class consumer (`artgraph diff` 等) は future work**。

## 型定義

`packages/artgraph/src/types.ts`:

```ts
export interface LockEntry {
  specFile?: string;
  contentHash: string;
  impl?: string[];                                                   // 据置
  tests?: string[];                                                  // 据置
  dependsOn?: Array<{ id: string; provenances: EdgeProvenance[] }>;  // ← 構造化
  lastReconciled: string;
}
export type LockFile = Record<string, LockEntry>;
```

## ディスク表現（JSON）

```jsonc
{
  "doc:specs/011-edge-provenance/spec.md": {
    "specFile": "specs/011-edge-provenance/spec.md",
    "contentHash": "abc123...",
    "dependsOn": [
      { "id": "doc:specs/010-req-req-dependency/spec.md", "provenances": ["frontmatter"] },
      { "id": "doc:specs/011-edge-provenance/research.md", "provenances": ["convention", "frontmatter"] }
    ],
    "lastReconciled": "2026-06-26T..."
  },
  "AUTH-002": {
    "specFile": "specs/auth/spec.md",
    "contentHash": "def456...",
    "dependsOn": [
      { "id": "AUTH-001", "provenances": ["annotation"] }
    ],
    "lastReconciled": "2026-06-26T..."
  }
}
```

## 不変条件（決定性）

- **INV-L1**: 任意のキー `id` について、`lock[id].dependsOn` が存在する場合、配列要素の `id` フィールドは昇順 sort 済み。
- **INV-L2**: 任意の `dependsOn[i].provenances` は内部で重複を含まず昇順 sort 済み。
- **INV-L3**: `dependsOn[i].provenances.length >= 1`（NonEmpty）。空配列要素は出力しない。
- **INV-L4**: 同じグラフ入力から `buildLockFromGraph` を 2 回実行した場合、`JSON.stringify(lock, null, 2) + "\n"` 出力はバイト単位で一致する。
- **INV-L5**: `dependsOn` の各要素 `id` はグラフ内の某ノード ID（req / doc / symbol）と一致するか、`orphan-edge` 警告対象として登録済み。

## buildLockFromGraph の責務

擬似コード（既存 `packages/artgraph/src/lock.ts` を改修）:

```ts
export function buildLockFromGraph(graph: ArtifactGraph): LockFile {
  const lock: LockFile = {};
  const now = new Date().toISOString();

  for (const [id, node] of graph.nodes) {
    if (node.kind !== "req" && node.kind !== "doc" && node.kind !== "symbol") continue;
    if (node.kind === "symbol") {
      lock[id] = { contentHash: node.contentHash, lastReconciled: now };
      continue;
    }

    const entry: LockEntry = { contentHash: node.contentHash, lastReconciled: now };
    if (node.filePath) entry.specFile = node.filePath;

    // impl / tests は据置（実運用で provenances が code-tag のみ）
    const isTaskSource = (s: string) => graph.nodes.get(s)?.kind === "task";

    const implTargets = graph.edges
      .filter((e) => e.kind === "implements" && e.target === id && !isTaskSource(e.source))
      .map((e) => e.source);
    if (implTargets.length > 0) entry.impl = implTargets;

    const testTargets = graph.edges
      .filter((e) => e.kind === "verifies" && e.target === id && !isTaskSource(e.source))
      .map((e) => e.source);
    if (testTargets.length > 0) entry.tests = testTargets;

    // dependsOn は構造化、annotation も含めて全 provenance を保持
    const depEdges = graph.edges.filter(
      (e) =>
        (e.kind === "depends_on" || e.kind === "derives_from") &&
        e.source === id,
    );
    if (depEdges.length > 0) {
      entry.dependsOn = depEdges
        .map((e) => ({
          id: e.target,
          provenances: [...e.provenances].sort(),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    lock[id] = entry;
  }
  return lock;
}
```

旧 `provenance !== "annotation"` フィルタは撤去する。

## rename 動作（rename-lock.ts への影響）

旧:
```ts
updated.dependsOn = updated.dependsOn.map((ref) => (ref === oldId ? newId : ref));
```

新:
```ts
updated.dependsOn = updated.dependsOn
  .map((ref) => (ref.id === oldId ? { id: newId, provenances: ref.provenances } : ref))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
```

- 要素単位の `id` 部分のみ書換、`provenances` は破壊しない（順序含めて維持）。
- 書換後に再度 `id` 昇順 sort をかけ INV-L1 を維持。
- `mergeLockKeys`（同 id への collapse）も `{id, provenances}` 形式で provenances を union するように更新。

## 移行（migration）

- 未リリースのため migration 不要。
- 既存環境にある `.trace.lock`（旧 `dependsOn: string[]` 形式）は `artgraph reconcile` で **全エントリを書き直し** 新 schema に上書きされる。
- 旧 schema を読む試みは行わない（読み込み時の型 narrowing は `dependsOn[0]` が `string` か `object` かでケース分岐するのではなく、新形式以外は **そのまま信用** = 旧形式が混入したら型エラーとなる）。

## CLI への影響

| コマンド | 影響 |
|---|---|
| `artgraph scan` | `buildLockFromGraph` 経由で新 schema を生成 |
| `artgraph reconcile` | 同上 |
| `artgraph check` | drift 判定は `contentHash` 比較のみ。`dependsOn` 変動は判定に使われない |
| `artgraph check --gate` | 同上。注釈追記による lock churn では gate 失敗しない |
| `artgraph impact` | グラフ走査ベース (`graph.edges` を直接読む)。`dependsOn` は参照しない |
| `artgraph rename` | `rename-lock.ts` のみが `entry.dependsOn` を読み、新 schema を維持して書き換える |

**Future work (out of scope of #35)**: `artgraph diff` を実装し dependsOn を
1st-class consumer に繋ぐ。現状の schema v2 `dependsOn` は `git diff .trace.lock`
で人間が読む presentational 用途 (+ rename 時の参照書き換え) のみで、runtime
コードからは参照されない。

## テスト要件（contracts として）

- INV-L1..L5 を `tests/lock.test.ts` で検証。
- 同入力 2 回 build → バイト一致テスト（SC-003 / INV-L4）。
- rename 後の `dependsOn` 要素が `provenances` を維持することを `tests/rename.test.ts` で検証（SC-005）。
- 既存 fixture `tests/fixtures/rename/.trace.lock` を新 schema に書換。

## 関連

- 値の語彙 / NonEmpty invariant は [./edge-provenance-type.md](./edge-provenance-type.md) と整合。
- dedup union と sort の根拠は [../research.md](../research.md) §R3, §R5。
