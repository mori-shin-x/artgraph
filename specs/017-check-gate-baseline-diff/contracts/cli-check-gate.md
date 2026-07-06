# Contract: `artgraph check --diff [--gate] [--format json|text]`

本 feature が確定する `check --diff` の外部契約。exit code・JSON スキーマ・text 出力の最終形。

## 1. 起動と対象

- `--diff`: 変更ファイル集合 = 現在の git 差分 (staged + unstaged + untracked の和集合)。現状の定義を維持 (FR-003)。
- 影響範囲 (blast radius) の計算は既存の `impact()` BFS を不変で流用 (FR-007、blast radius 温存)。
- `--gate`: new issue が 1 件でもあれば exit 2。指定なしなら合否判定せず表示のみ (exit 0)。

## 2. Exit code (SSOT: `src/commands/check.ts`)

| code | 条件 | 意味 |
|------|------|------|
| `0` | new issue ゼロ、または `--gate` なし | gate pass / 表示のみ |
| `2` | `--gate` かつ new issue が 1 件以上 | gate fail (変更が新規に導入した問題あり) |
| `1` | `--gate` かつ baseline 構築不能 (非 git / worktree 失敗) | 判定不能エラー (FR-010)。縮退判定しない |

- `--gate` なしで baseline 構築不能: 警告を stderr に出し、current issue を全表示して exit 0 (new マークなし)。
- HEAD 無し初回コミット前は `1` ではなく、baseline 空として全 current を new 扱い (FR-014)。`--gate` かつ new あれば `2`。

## 3. `--format json` スキーマ

既存フィールドは維持し、フィールド **追加のみ** (後方互換、R8)。

```jsonc
{
  // ── 既存 (scoped 全 issue、後方互換) ──
  "drifted":   [{ "nodeId": "...", "kind": "...", "lockedHash": "...", "currentHash": "..." }],
  "orphans":   ["file:src/foo.ts -> REQ-999 (implements)"],
  "uncovered": ["016-.../FR-001"],
  "coverage":  [{ "reqId": "...", "status": "untagged|impl-only|verified" }],
  "testFailures": ["..."],
  "warnings":  [ /* 既存 BuildWarning[] */ ],

  // ── 意味変更 ──
  "pass": true,               // new issue がゼロか (旧: 全 issue ゼロ)

  // ── 追加 ──
  "newIssues": {              // current \ baseline。ゲート合否を決める集合
    "drifted": [], "orphans": [], "uncovered": [], "testFailures": []
  },
  "suppressedCount": 155,     // pre-existing として抑制した scoped issue 件数
  "baselineStatus": "computed" // computed | empty | skipped | unavailable
}
```

- 新規判定 (FR-009): ある issue が `newIssues` に含まれれば new、含まれなければ pre-existing。
- no-diff (空 git diff) の既存ショートサーキット出力も、`newIssues: {..空..}` / `suppressedCount: 0` / `baselineStatus: "skipped"` を含める形に更新 (既存の E4 挙動を維持しつつ拡張)。
- **`baselineStatus: "unavailable"` のとき (json)**: stdout に JSON を出す (CI が `jq` で解釈できるように)。既存 issue フィールドは scoped 全 issue を保持、`newIssues` は全空 (判定不能なので new を確定できない)、`pass: false` (安全側 — 判定不能を pass にしない)。消費者は `pass:false` 単独ではなく `baselineStatus:"unavailable"` を見て「gate fail ではなく判定不能」と区別する。`--gate` 時は JSON 出力後に exit 1、`--gate` なしは exit 0 + stderr 警告。

## 4. `--format text` 出力 (FR-008)

### 4.1 new issue あり

```text
check --diff --gate

  2 new issues introduced by this change:
    UNCOVERED (1):
      014-reinvent-impact-cli/FR-007
    ORPHANS (1):
      src/auth.ts -> REQ-999 (implements)

  155 pre-existing issues in blast radius were suppressed.
  Run `artgraph impact --diff` to see full propagation.
```
exit 2 (`--gate`)。

### 4.2 new issue なし (pre-existing 抑制)

```text
check --diff --gate

  No new issues introduced by this change.
  (155 pre-existing issues in blast radius were suppressed.)
```
exit 0。**pre-existing 債務の全件は列挙しない** (SC-004)。

### 4.3 baseline skipped (current 完全クリーン)

```text
check --diff --gate

  No new issues introduced by this change.
```
exit 0。worktree 未生成 (SC-005)。

### 4.4 baseline unavailable (`--gate`)

```text
check --diff --gate

  ERROR: could not establish a baseline (git worktree unavailable).
         gate result is undetermined; not treating as pass.
```
exit 1。

### 4.5 baseline unavailable (`--gate` なし = 表示のみ)

```text
check --diff

  WARNING: could not establish a baseline; showing all issues without
           new/pre-existing distinction.
  ORPHANS:
    ...
  UNCOVERED:
    ...
```
警告を stderr に出し、scoped 全 issue を従来形式で表示。new/pre-existing の区別マークは付けない。exit 0 (`--gate` なしは合否判定しない)。

## 5. 契約テスト (quickstart と対応)

| # | 契約 | 検証 |
|---|------|------|
| C1 | pre-existing のみ → exit 0 | SC-001 |
| C2 | 新規 orphan/uncovered/drift → exit 2 + newIssues に該当 | SC-002 |
| C3 | baseline 前後で git status / lock 不変 | SC-003 |
| C4 | 大差分リファクタ → text が新規ゼロの簡潔出力 | SC-004 |
| C5 | current クリーン → worktree 未生成 (baselineStatus=skipped) | SC-005 |
| C6 | baseline unavailable + --gate → exit 1 | FR-010 |
| C7 | json 既存フィールド維持 + newIssues/suppressedCount/baselineStatus 追加 | R8 / FR-009 |
