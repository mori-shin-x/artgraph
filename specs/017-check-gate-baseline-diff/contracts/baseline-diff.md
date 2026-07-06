# Contract: baseline 算出の内部契約 (`src/baseline.ts`)

`check --diff` から呼ばれる baseline 算出層の内部 API 契約。Phase 2 (`--base <ref>` CLI 露出) を見据えた base ref パラメータ化 (FR-012) を含む。

## 1. `computeBaselineIssues`

```ts
function computeBaselineIssues(
  rootDir: string,
  baseRef: string,           // Phase 1 呼び出しは "HEAD"。Phase 2 で任意 ref (merge-base 等)
  currentLock: LockFile,     // 現在の lock (FR-011)。base 版 lock は使わない
  config: ArtgraphConfig,
): BaselineIssues;

interface BaselineIssues { keys: Set<string>; status: "computed" | "empty" | "unavailable"; }
```

### 1.1 事後条件 (副作用ゼロ, FR-004 / SC-003)

- 呼び出し前後で `rootDir` の作業ツリー・git index・`.trace.lock` の内容が **byte 一致** する。
- 一時 worktree は関数終了時 (正常・異常問わず) に必ず撤去される (`finally` で `git worktree remove --force`、失敗時 `git worktree prune`)。
- parse-cache (`<rootDir>/node_modules/.cache/artgraph/`) を変更しない (worktree に `node_modules` が無いため cold path、R2)。

### 1.2 status の決定

| status | 条件 |
|--------|------|
| `empty` | `git rev-parse --verify <baseRef>` が失敗 (HEAD 無し初回コミット前など) |
| `computed` | worktree 展開 + scan + issue 算出 が成功 |
| `unavailable` | 非 git / `git worktree add` 失敗 / scan 例外 |

### 1.3 キー集合の内容 (global, R1)

base graph 全体に対し以下を算出し、R4 のキー関数で `keys` に集約:
- drift: base graph の req/doc ノード × `currentLock` の contentHash 比較 (R3)
- orphan: `findOrphans(baseGraph)` (source が task の orphan は既存どおり除外)
- uncovered: `findUncovered(baseGraph)`
- test failure: `testResults` 指定時のみ (base 側では通常評価しない — current の testFailures は current の test 実行結果に依存するため、baseline には test failure を含めない ⇒ testfail は常に new 判定になる)

> **注記 (test failure の扱い)**: test 実行結果は「今回のテスト実行」に紐づき base ref の静的状態からは再現できない。したがって baseline に testfail キーは入れず、current の testFailures は常に new とみなす。これは「テストが落ちているなら変更起因かに関わらずゲートで止める」現行の安全側挙動を維持する (spec の scope 外の副次論点、tasks で確認)。

## 2. `getGitDiffFiles` の base ref 化 (`src/diff.ts`, FR-012)

現状 HEAD 固定の変更ファイル取得を、内部的に base ref を受け取れる形へ (CLI 露出は Phase 2)。

```ts
// Phase 1: 既存シグネチャ互換のまま、内部で HEAD 相当を使う。
function getGitDiffFiles(rootDir: string): string[];               // 現状維持 (staged+unstaged+untracked)

// Phase 2 準備: base ref 指定版 (本 feature では未露出、内部関数として用意可)
// git diff <merge-base(baseRef,HEAD)>...HEAD の name-only + untracked
// function getGitDiffFilesFrom(rootDir: string, baseRef: string): string[];
```

**Phase 1 の要件**: `computeBaselineIssues` の `baseRef` 引数化まで行い、`check` からは `"HEAD"` を渡す。`getGitDiffFiles` の base ref 化は「内部構造として受け取れる形」に留め、CLI フラグ (`--base`) は追加しない (plan / spec Assumptions)。

## 3. 不変条件

- `computeBaselineIssues` は純粋な読み取り + 一時領域操作のみ。グラフ・lock への書き込みをしない。
- `status !== "computed"` のとき `keys` は空集合。
- 同一 `(rootDir, baseRef, currentLock, config)` に対し決定的 (Constitution 原則 I): 同じ base ref なら同じ `keys`。
