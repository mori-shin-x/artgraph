# Phase 1 Data Model: check --gate baseline 差分化

spec の Key Entities を型・関数シグネチャに落とす。既存型 (`src/types.ts`) との差分を明示。

---

## 1. 既存型と拡張

### 1.1 `CheckResult` の拡張 (src/types.ts)

```ts
export interface CheckResult {
  // ── 既存フィールド (scoped 全 issue、後方互換で維持) ──
  drifted: DriftEntry[];
  orphans: string[];        // "source -> target (kind)" 形式
  uncovered: string[];
  coverage: { reqId: string; status: CoverageStatus }[];
  testFailures: string[];

  // ── 意味変更 ──
  pass: boolean;            // 【変更】旧: 全 issue ゼロ → 新: new issue ゼロ (= gate 合否)

  // ── 追加フィールド (baseline 差分) ──
  newIssues: NewIssues;     // current \ baseline。ゲート合否を決める唯一の集合
  suppressedCount: number;  // pre-existing として抑制した scoped issue 件数
  baselineStatus: BaselineStatus;
}

export interface NewIssues {
  drifted: DriftEntry[];
  orphans: string[];        // 同じく "source -> target (kind)" 形式
  uncovered: string[];
  testFailures: string[];
}

export type BaselineStatus =
  | "computed"      // worktree で base graph を算出し差分を取った
  | "empty"         // HEAD 無し初回コミット前 — baseline 空、全 current が new (FR-014)
  | "skipped"       // 遅延評価: current issue ゼロで baseline 未算出 (new もゼロ)
  | "unavailable";  // 構築不能な異常系 (--gate 時は exit 1 の原因、FR-010)
```

**不変条件**:
- `newIssues.*` は対応する既存 `drifted/orphans/uncovered/testFailures` の部分集合 (キー一致で包含)。
- `baselineStatus === "skipped"` のとき `newIssues` は全空 かつ 既存配列も全空 (current がゼロ)。
- `baselineStatus === "empty"` のとき `newIssues` == 既存配列 (全 current が new)。
- `pass === (newIssues の全配列が空)`。
- `coverage` は表示専用で gate 合否・new 判定に関与しない (従来どおり scoped 全 REQ の status)。

### 1.2 `DriftEntry` (変更なし)

```ts
export interface DriftEntry { nodeId: string; kind: NodeKind; lockedHash: string; currentHash: string; }
```

---

## 2. 新規: Orphan の構造化 (src/graph/traverse.ts, FR-006)

`findOrphans` を文字列返しから構造化に変更し、表示用文字列化を分離する。

```ts
export interface OrphanEdge {
  source: string;   // "file:src/foo.ts" 等の node id
  target: string;   // 解決しなかった REQ id
  kind: "implements" | "verifies";
}

export function findOrphans(graph: ArtifactGraph): OrphanEdge[];   // 【変更】旧 string[]

// 表示・キー用の正準文字列 (SSOT: 文字列表現はこの 1 関数のみ)
export function formatOrphan(o: OrphanEdge): string;               // `${source} -> ${target} (${kind})`
```

**移行**: 既存呼び出し元 (`src/check.ts`, presenter, tests) は `formatOrphan` 経由で従来文字列を得る。`CheckResult.orphans` / `NewIssues.orphans` は引き続き `string[]` (= `formatOrphan` 適用済み) を保持し外部互換を守る。

---

## 3. 新規モジュール: baseline 算出 (src/baseline.ts)

```ts
export interface BaselineIssues {
  keys: Set<string>;          // 全 issue の同一性キー集合 (R4)
  status: BaselineStatus;     // "computed" | "empty" | "unavailable"
}

// base ref の状態を worktree で展開し scan して global な issue キー集合を返す。
// 副作用ゼロ (FR-004): ユーザーの作業ツリー・index・lock を変更しない。
// lock は引数の currentLock (現在の lock) を使う (FR-011)。
export function computeBaselineIssues(
  rootDir: string,
  baseRef: string,            // Phase 1 は "HEAD" 固定で呼ぶ (FR-002/FR-012 でパラメータ化)
  currentLock: LockFile,
  config: ArtgraphConfig,
): BaselineIssues;
```

**アルゴリズム**:
1. `baseRef` が解決するか確認 (`git rev-parse --verify <baseRef>`)。HEAD 未存在 (初回コミット前) → `{ keys: ∅, status: "empty" }`。
2. `mkdtemp` で OS tmpdir に一時パス生成 → `git worktree add --detach <tmp> <baseRef>`。
3. `try`: `scan(<tmp>, config)` で base graph 構築 → `findOrphans` / `findUncovered` / drift (base graph × `currentLock`) / testFailures を **global** に算出 → R4 のキー生成で `keys` に集約 → `{ keys, status: "computed" }`。
4. `finally`: `git worktree remove --force <tmp>` (+ 失敗時 `git worktree prune`)。
5. 上記いずれかの git/scan 失敗を捕捉 → `{ keys: ∅, status: "unavailable" }`。

**キー生成 (R4, SSOT)**: `src/baseline.ts` に単一の `issueKey()` 群を置き、current 側の差分計算も同じ関数を使う。

```ts
export const driftKey = (d: DriftEntry) => `drift:${d.nodeId}`;
export const orphanKey = (o: OrphanEdge) => `orphan:${formatOrphan(o)}`;
export const uncoveredKey = (id: string) => `uncovered:${id}`;
export const testfailKey = (id: string) => `testfail:${id}`;
```

---

## 4. 差分計算 (src/check.ts)

`check()` は従来どおり scoped な `CheckResult` を組み立てる。**追加**で、`baseRef` 由来の `BaselineIssues.keys` を受け取り `newIssues` を算出する。

```ts
export function check(
  graph: ArtifactGraph,
  lock: LockFile,
  scope?: Set<string>,
  testResults?: TestResultMap,
  baseline?: BaselineIssues,      // 【追加】未指定なら従来挙動 (全 scoped issue が new 扱い相当)
): CheckResult;
```

- orphan の scope 照合を厳密化 (FR-006): `orphan.source ∈ scope` (現状の `o.includes(s)` を廃止)。
- `newIssues.X = scoped X のうち キーが baseline.keys に無いもの`。`baseline` 未指定 or `status==="empty"` → 全 scoped issue が new。`status==="skipped"` は呼び出し側で current ゼロを保証済み。
- `pass = newIssues 全空`。

---

## 5. コマンドフロー (src/commands/check.ts)

```
1. scan → current graph、readLock → 現在 lock
2. diff files → scopedNodeIds (既存 impact() BFS、blast radius 温存)
3. check(graph, lock, scope, testResults) で scoped CheckResult(暫定, baseline 未適用)
4. --gate かつ current issue 非空 (遅延評価 R6):
     baseline = computeBaselineIssues(rootDir, "HEAD", 現在 lock, config)
     if baseline.status === "unavailable" && --gate:
         警告 + exit 1   ← FR-010
     newIssues 再計算 (check の baseline 引数経由)
   else (current issue ゼロ):
     baselineStatus = "skipped", newIssues 空
5. 出力 (format json | text)
6. --gate かつ newIssues 非空 → exit 2 / それ以外 → exit 0
```

**exit code (contract cli-check-gate.md と一致)**: `0` gate pass / `2` gate fail (`--gate` + new あり) / `1` baseline 構築不能 (`--gate` + `unavailable`)。

---

## 6. SSOT 台帳 (Cat2)

| 知識 | 真実源 | 従属 (等価性をテストで担保) |
|------|--------|------------------------------|
| issue 同一性キー生成 | `src/baseline.ts` の `*Key()` 群 | current 差分計算 (`check.ts`) が同じ関数を import |
| orphan の文字列表現 | `formatOrphan()` (`traverse.ts`) | `CheckResult.orphans` / キー生成 / presenter |
| exit code 定義 (0/1/2) | `src/commands/check.ts` の定数 or 共有定数 | `docs/architecture.md`、`templates/integrate/speckit/commands/artgraph.check-gate.md`、テスト |
| `pass` の意味 (new 基準) | `check()` | `templates/skills/artgraph-verify/SKILL.md` (+5 複製)、`_shared/output-schema.md` |

---

## 7. 状態遷移 (baselineStatus)

```
current issue ゼロ ──────────────► skipped ─► (new 空, exit 0)
current issue 非空
   └─ HEAD 未存在 ────────────────► empty   ─► (全 current が new)
   └─ worktree/scan 成功 ─────────► computed ─► (差分で new 算出)
   └─ 非 git / worktree 失敗 ─────► unavailable
                                       ├─ --gate     → exit 1 (FR-010)
                                       └─ --gate なし → 警告 + 全表示 exit 0
```
