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
  // Critical fix B1 (issue #182 レビュー) — baselineStatus === "unavailable"
  // のときだけ設定される、baseline 構築失敗の原因メッセージ (git rev-parse
  // エラー、`git worktree add` 失敗、scan() 例外、mkdtemp エラー等の catch し
  // た例外の message)。空でない文字列。他の baselineStatus では unset。
  baselineError?: string;
}

export interface NewIssues {
  drifted: DriftEntry[];
  orphans: string[];        // 同じく "source -> target (kind)" 形式
  uncovered: string[];
  testFailures: string[];
}

export type BaselineStatus =
  | "computed"        // worktree で base graph を算出し差分を取った
  | "empty"           // HEAD 無し初回コミット前 — baseline 空、全 current が new (FR-014)
  | "skipped"         // 遅延評価: `--diff` あり + scope の current issue がゼロで baseline 未算出 (new もゼロ、R6)
  | "not_applicable"  // Critical fix B6/D2 (issue #182 レビュー) — `--diff` フラグなしのプレーン `check` 実行。baseline 差分という概念自体が適用されない
  | "unavailable";    // 構築不能な異常系 (--gate 時は exit 1 の原因、FR-010)
```

**不変条件**:
- `newIssues.*` は対応する既存 `drifted/orphans/uncovered/testFailures` の部分集合 (キー一致で包含)。
- `baselineStatus === "skipped"` のとき `newIssues` は全空 かつ 既存配列も全空 (current がゼロ)。これは `--diff` ありの lazy eval (R6) で、scope の current issue が最初からゼロだったから成り立つ (check() 側で特別扱いした結果ではない)。
- `baselineStatus === "not_applicable"` のとき `newIssues` は既存配列 (scoped 配列) と同一 (= 全 scoped issue がそのまま new 扱い)。`--diff` 自体が無いため pre-existing / new の区別が発生せず、`pass` は pre-spec-017 の「全 issue クリア」判定と一致する (R8 back-compat)。`skipped` と異なり scoped 配列が空とは限らない — **`skipped` は「scope が既にクリーン」、`not_applicable` は「そもそも diff を試みていない」であり、`newIssues` が (たまたま) 空かどうかで両者を区別してはならない**。
- `baselineStatus === "empty"` のとき `newIssues` == 既存配列 (全 current が new)。
- `baselineError` は `baselineStatus === "unavailable"` のときのみ設定 (非空文字列)。他の全 status で unset。
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
  status: BaselineStatus;     // "computed" | "empty" | "unavailable" (この 3 値のみ。"skipped" / "not_applicable" は
                              // computeBaselineIssues を呼ばない上位層でのみ発生する。contracts/baseline-diff.md §1 参照)
  // Critical fix B1 (issue #182 レビュー) — status === "unavailable" のときのみ設定される診断メッセージ (非空文字列)。
  // check() が CheckResult.baselineError へそのまま転記する。詳細は contracts/baseline-diff.md §1.2。
  error?: string;
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
- `newIssues.X = scoped X のうち キーが baseline.keys に無いもの`。`baseline` 引数が示す 5 パターン (`baselineStatus` への対応、§1.1):
  - `baseline === undefined` かつ `--diff` 自体が要求されていない (プレーン `check`) → `baselineStatus = "not_applicable"`、`newIssues` = 全 scoped issue (back-compat, R8)。
  - `baseline === undefined` かつ `--diff` 要求あり (`commands/check.ts` の lazy eval で scope の current issue がゼロだったため `computeBaselineIssues` を呼ばなかった、R6) → `baselineStatus = "skipped"`、`newIssues` は全空 (scoped 自体が空なので自明)。
  - `baseline.status === "empty"` → `baselineStatus = "empty"`、`newIssues` = 全 scoped issue。
  - `baseline.status === "computed"` → `baselineStatus = "computed"`、`newIssues` = キー差分。
  - `baseline.status === "unavailable"` → `baselineStatus = "unavailable"`、`newIssues` は全空、`baselineError` に `baseline` 側で捕捉した原因メッセージを転記。
- **実装上の注意 (Critical fix B6/D2)**: 現状の `check()` シグネチャ (`baseline?: BaselineIssues`) だけでは「プレーン `check`」と「`--diff` の lazy-eval skip」を区別する情報が無い (どちらも `baseline === undefined` になり、`status ?? "skipped"` で誤って同一の `"skipped"` に丸められる — issue #182 レビュー B6/D2)。この 2 パターンを区別する信号を `check()` に追加すること (例: `diffRequested?: boolean` 引数を追加する、または呼び出し側で `baselineStatus` を確定させる)。いずれの実装でも **`check()` を唯一の `baselineStatus` 決定者に保つ** (本 doc §6 SSOT 原則) ことを推奨する。
- `pass = newIssues 全空`。

---

## 5. コマンドフロー (src/commands/check.ts)

```
0. `--diff` が無い (プレーン `check` / `check --gate`): scope なしで `check(graph, lock, undefined, testResults)` を呼ぶ。
   baseline 計算は一切行わない。`baselineStatus = "not_applicable"` (Critical fix B6/D2)。手順 1–4 は `--diff` ありの場合のみ。
1. scan → current graph、readLock → 現在 lock
2. diff files → scopedNodeIds (既存 impact() BFS、blast radius 温存)
3. check(graph, lock, scope, testResults) で scoped CheckResult(暫定, baseline 未適用)
4. --diff かつ current issue 非空 (遅延評価 R6。baseline 算出自体は --gate の有無を問わない — --gate は下記 6 の exit code のみを左右する。issue #182 レビュー訂正):
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
| `baselineStatus` の `not_applicable` vs `skipped` 判別 | `check()` (`--diff` 要求の有無を受け取って決定、§4 参照) | `src/commands/check.ts` (呼び出し方で信号を渡す側)、`_shared/output-schema.md` |
| `baselineError` の値 | `src/baseline.ts` の `computeBaselineIssues` が捕捉した例外 `.message` | `check()` が `CheckResult.baselineError` へ転記、`templates/skills/artgraph-verify/SKILL.md` (+5 複製)、`_shared/output-schema.md` |

---

## 7. 状態遷移 (baselineStatus)

```
--diff なし (プレーン check / check --gate) ──► not_applicable ─► (newIssues == 全 scoped、legacy pass 判定、R8)

--diff あり
   └─ current issue ゼロ ────────────────────► skipped ─► (new 空, exit 0)
   └─ current issue 非空
        └─ HEAD 未存在 ─────────────────────► empty    ─► (全 current が new)
        └─ worktree/scan 成功 ──────────────► computed ─► (差分で new 算出)
        └─ 非 git / worktree 失敗 ───────────► unavailable (baselineError に原因メッセージ)
                                                  ├─ --gate     → exit 1 (FR-010)
                                                  └─ --gate なし → 警告 + 全表示 exit 0
```
