# Phase 1 Data Model: check --base <ref> — CI PR gating

spec の Key Entities を型・関数シグネチャに落とす。**新しい型・新しい CheckResult フィールドは追加しない** (FR-012) — 本 feature は既存関数の base ref パラメータ化と、merge-base 解決ヘルパーの新設のみ。

---

## 1. 既存型 — 変更なし

### 1.1 `CheckResult` (src/types.ts) — 不変

`newIssues` / `suppressedCount` / `baselineStatus` / `baselineError` は spec 017 のまま。`--base` の全異常系は既存の `baselineStatus: "unavailable"` (+ `baselineError`) で表現する (FR-012)。JSON 出力へのフィールド追加ゼロ = 完全後方互換。

- `"unavailable"` の発生条件が広がる: (017) 非 git / worktree 失敗 / scan 例外 に加え、(023) `--base <ref>` 解決不能 / `git merge-base` 失敗。
- `"skipped"` / `"empty"` / `"computed"` / `"not_applicable"` の意味論は不変。`--base` + merged diff 空は `"skipped"` shape の既存 E4 ショートサーキット (No changes) に乗る。

### 1.2 `BaselineIssues` (src/baseline.ts) — 不変

`computeBaselineIssues(rootDir, baseRef, currentLock, config)` は 017/FR-012 で既に base ref パラメータ化済み。本 feature は呼び出し側が `"HEAD"` の代わりに **merge-base SHA** を渡すだけで、関数本体の契約 (副作用ゼロ / status 3 値 / graph 返却) は変更しない。

> **注意**: `computeBaselineIssues` に渡すのは `<ref>` そのものではなく解決済み SHA (§3)。`classifyBaseRef` は SHA に対しても `"resolved"` を返すため内部の再検証は自然に通る。unborn 分岐 (FR-014) は `baseRef === "HEAD"` のときだけ成立し、`--base` 経路では SHA を渡すため到達しない (`isUnbornHead` の非 HEAD early return, src/baseline.ts:381)。

---

## 2. `src/diff.ts` — 既存関数の base ref パラメータ化

optional 引数 (省略時 = 現行挙動) でシグネチャ拡張する。contracts/baseline-diff.md §2 (017) がスケッチした `getGitDiffFilesFrom(rootDir, baseRef)` の別関数案は採らず、**同一関数の optional 引数** にする — 呼び出し側 (commands/check.ts) の分岐が「baseSha を渡すか否か」の 1 点に収まり、union 定義 (FR-006) が 1 箇所で読めるため。

```ts
// FR-006 — merged diff files。baseSha 省略時は現行の three-way union と
// byte-identical (FR-003)。baseSha 指定時はコミット間差分を union に追加:
//   git -c core.quotePath=false diff --name-only -M -z <baseSha> HEAD
// 既存の staged / unstaged / untracked 3 呼び出しも -z + core.quotePath=false
// に変換し (parseDiffFiles → parseNulSeparated)、path 表記を統一する。
export function getGitDiffFiles(rootDir: string, baseSha?: string): string[];

// FR-008 — rename 検出の比較基準。省略時 "HEAD" (現行)。baseSha 指定時は
//   git -c core.quotePath=false diff -M -z --name-status <baseSha>
// で committed rename + working-tree rename の両方を 1 回で取得。
export function getGitRenameMap(rootDir: string, baseSha?: string): Map<string, string>;

// FR-009 — tracked-path probe の一般化。省略時 HEAD tree のみ (現行)。
// baseSha 指定時は HEAD tree ∪ <baseSha> tree の和集合で「tracked」判定
// (どちらかの tree に存在すれば baseline-resolvable 候補)。probe 失敗時の
// conservative fallback (batch を tracked 扱い) は両 tree に適用。
export function getHeadTrackedPaths(
  rootDir: string,
  paths: string[],
  baseSha?: string,
): Set<string>;
```

**不変条件**:
- `baseSha === undefined` のとき、3 関数とも現行と同一の git 呼び出し列・同一の戻り値 (SC-005 の回帰テストで固定)。ただし `getGitDiffFiles` の `-z` 化により、非 ASCII path の **表記** のみ octal-escape → verbatim に変わる (`getGitTrackedFiles` と同じ方式に統一。R3 参照 — グラフ側 path と一致する方向の修正であり、ASCII-only repo では byte-identical)。
- `getGitDiffFiles` の戻り値は重複なし (Set 経由)。base range の rename (R レコード) は **new path のみ** が集合に入る (実測 T001d: `--name-only -M` は old path を出力しない)。old path は `getGitRenameMap(rootDir, baseSha)` の inverse map 経由で baseline 側 startId 解決に回復される (作業ツリー rename の既存経路と同型)。
- `getGitRenameMap(rootDir, baseSha)` の map は `src/commands/check.ts` の inverse-rename (:136) と `computeBaselineIssues` → `normalizeOrphanSource` (src/baseline.ts:229 経由) の **両方** に同一インスタンスとして渡る (二重解決禁止 — §5 SSOT)。

---

## 3. 新規ヘルパー: merge-base 解決 (src/baseline.ts)

`classifyBaseRef` / `extractErrorMessage` / `debugLog` が既にある `src/baseline.ts` に置く (git ref 分類の同族)。

```ts
// FR-005 — <ref> と HEAD の merge-base を 1 回だけ解決する。
//   git merge-base <ref> HEAD
// 成功: { sha } (full SHA)。失敗 (shallow clone で共通祖先欠落 /
// unrelated histories / git 実行エラー): { error } — extractErrorMessage の
// 診断文字列 + FETCH_DEPTH_HINT を連結した非空文字列。
export function resolveMergeBase(
  rootDir: string,
  ref: string,
): { sha: string } | { error: string };

// FR-004/FR-005 — shallow-clone 対処ヒントの単一定数 (SSOT)。ref 解決失敗
// (classifyBaseRef → "error") と merge-base 失敗の両方が同じ文言を共有する。
// 例: `hint: if this is a shallow clone, fetch full history
//      (actions/checkout: fetch-depth: 0) or fetch the base ref first.`
export const FETCH_DEPTH_HINT: string;
```

**呼び出し前提**: `resolveMergeBase` の前に `classifyBaseRef(rootDir, ref)` で ref 自体の解決を確認する (contracts/cli-check-base.md §2 の検証順)。`classifyBaseRef` が `"resolved"` 以外を返した時点で `unavailable` 化するので、`resolveMergeBase` は解決済み ref に対してのみ呼ばれる — それでも merge-base は独立に失敗しうる (shallow で祖先が無い / unrelated histories)。

---

## 4. コマンドフロー (src/commands/check.ts)

```
0. option 定義: .option("--base <ref>", "Gate against merge-base(<ref>, HEAD) instead of the working tree only")
1. usage 検証 (FR-002): opts.base && !opts.diff → stderr にエラー + `--diff` 追加の案内 → exit 1。
   (--format json でも同じ: usage error は JSON を出さず stderr + exit 1 — contracts §3)
2. --diff 分岐内、diff 取得の前に base 解決 (--base があるときのみ):
     a. classifyBaseRef(rootDir, opts.base)
        - "resolved" 以外 (named ref は "unborn" になり得ない — isUnbornHead 非 HEAD early return):
          baseline = { keys:∅, status:"unavailable", error: `base ref "<ref>" does not resolve` + FETCH_DEPTH_HINT }
          → 通常の check() フローに合流 (baselineStatus:"unavailable" → --gate なら exit 1)
     b. resolveMergeBase(rootDir, opts.base)
        - { error } → 同上 unavailable 合流 (error + FETCH_DEPTH_HINT)
        - { sha }   → baseSha = sha (以後この 1 変数だけが基準点)
3. diffFiles = getGitDiffFiles(rootDir, baseSha)          // FR-006 union
4. diffFiles 空:
     - --base あり → CI 警告を出さない (FR-010)。既存 E4 shape の "No changes" exit 0。
     - --base なし → 現行どおり (CI 警告 — 文言は FR-011 で更新: 「--base <ref> を渡すこと」)
5. renameMap = getGitRenameMap(rootDir, baseSha)          // FR-008 (inverse-rename にも baseline にも同一 map)
6. headTrackedPaths = getHeadTrackedPaths(rootDir, paths, baseSha)   // FR-009
7. anyBaselineResolvable 判定 (既存ロジック不変、入力が base 対応済みになるだけ)
8. baseline = computeBaselineIssues(rootDir, baseSha ?? "HEAD", lock, config)   // FR-007 — diff range と同一 SHA
9. 以降 (scope union / check() / --ignore / 出力 / exit code) は 017 のまま不変。
   step 2 の unavailable は step 8 相当の位置に合流し、既存の
   baselineStatus:"unavailable" ハンドリング (--gate: exit 1 / なし: 警告 + exit 0) に乗る。
```

**設計上の要点**:
- merge-base は step 2b で **1 回だけ** 解決され、以後は `baseSha` 変数 (string) が全関数に配布される。どの関数も ref から再解決しない (FR-005/FR-007 の構造的保証)。
- `check()` (src/check.ts) は無変更。`diffRequested` / `baseline` 引数の既存契約で足りる。
- step 2 の unavailable を early-exit にせず check() フローに合流させるのは、017 契約 §4.4/§4.5 (`--gate` なしは警告 + 全表示 exit 0、json は scoped 全 issue + `baselineError`) をそのまま満たすため。`--ignore` の pass 再計算 (:300-310) も `unavailable` を non-passing に保つ既存分岐が効く (FR-012)。

**exit code (017 契約と同一)**: `0` pass / `2` gate fail / `1` usage error (`--base` w/o `--diff`) または baseline unavailable (`--gate` 時)。

---

## 5. SSOT 台帳 (Cat2)

| 知識 | 真実源 | 従属 (等価性をテストで担保) |
|------|--------|------------------------------|
| merge-base SHA | `resolveMergeBase()` の戻り値 → `commands/check.ts` のローカル変数 `baseSha` | `getGitDiffFiles` / `getGitRenameMap` / `getHeadTrackedPaths` / `computeBaselineIssues` は引数で受けるのみ (再解決禁止) |
| fetch-depth ヒント文言 | `FETCH_DEPTH_HINT` 定数 (src/baseline.ts) | ref 解決失敗 / merge-base 失敗の両メッセージ、quickstart.md の troubleshooting、README レシピ注記 |
| 変更ファイル集合の定義 (union) | `getGitDiffFiles(rootDir, baseSha?)` 単一関数 | contracts/cli-check-base.md §4、docs/commands.md |
| rename map | `getGitRenameMap(rootDir, baseSha?)` の単一呼び出し結果 | inverse-rename startId 解決 (commands/check.ts:136) と baseline orphan-key 正規化 (baseline.ts:229) が同一 map を共有 |
| NUL 区切り path パース | 既存 `parseNulSeparated` (src/diff.ts) | 新設のコミット間差分 + `-z` 化する既存 3 呼び出しすべて |
| exit code / `baselineStatus` の意味 | spec 017 の既存 SSOT (src/commands/check.ts / src/baseline.ts) — 本 feature は不変 | `templates/skills/_shared/output-schema.md` の表に CI (--base) 行を追記 |

---

## 6. 状態遷移 (baselineStatus × --base)

017 data-model §7 の遷移図に `--base` 経路を重ねる。**新しい status は増えない**。

```
--diff なし
   └─ --base あり ────────────────────────────► usage error, exit 1 (FR-002。CheckResult を作らない)
   └─ --base なし ────────────────────────────► not_applicable (017 不変)

--diff あり + --base <ref>
   └─ <ref> 解決不能 (classifyBaseRef ≠ resolved) ─► unavailable (+ FETCH_DEPTH_HINT)
   └─ merge-base 失敗 (shallow / unrelated)     ─► unavailable (+ FETCH_DEPTH_HINT)
   └─ merged diff 空 ──────────────────────────► skipped 相当の "No changes" exit 0 (CI 警告なし, FR-010)
   └─ resolvable 判定 false ───────────────────► skipped ("not tracked" 早期 exit — probe は merge-base tree も見る)
   └─ worktree/scan 成功 (baseSha で構築) ──────► computed (diff range と同一コミット, FR-007)
   └─ worktree/scan 失敗 ──────────────────────► unavailable (017 不変)

unavailable 時の出力・exit code は 017 契約そのまま:
   ├─ --gate     → exit 1 (メッセージに baselineError = 原因 + ヒント)
   └─ --gate なし → 警告 + 全表示 exit 0 (pass:false)
```
