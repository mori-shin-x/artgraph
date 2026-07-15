# Contract: `artgraph check --diff --base <ref> [--gate] [--format json|text]`

本 feature が確定する `--base <ref>` の外部契約。spec 017 の `check --diff` 契約 (`specs/017-check-gate-baseline-diff/contracts/cli-check-gate.md`) を **上書きせず拡張** する — `--base` 未指定時は 017 契約がそのまま成立する (byte-identical, FR-003)。

## 1. フラグ構文

```
artgraph check --diff --base <ref> [--gate] [--format json|text] [--ignore <csv>]
```

- `--base <ref>`: 値必須。`<ref>` は git が解決できる任意の参照 (ブランチ名 / `origin/main` 等のリモート追跡ブランチ / SHA / タグ)。range 構文 (`A..B` / `A...B`) は受理しない (単一 ref のみ — merge-base 計算は内部で行う)。
- 意味論: 変更ファイル集合とベースライン基準点を `mergeBase = git merge-base <ref> HEAD` に拡張する (D1)。`<ref>` の tip は判定に使われない。

## 2. 検証順 (SSOT: `src/commands/check.ts`)

| # | 検証 | 失敗時 |
|---|------|--------|
| 1 | commander の option パース (`--base` に値があるか) | commander 標準エラー、exit 1 |
| 2 | `--base` かつ `--diff` なし (FR-002) | stderr にエラー + 「`--diff` を併せて指定せよ」の案内、exit 1。**JSON を出力しない** (usage error は判定結果ではない)。警告して続行しない |
| 3 | `classifyBaseRef(rootDir, <ref>)` ≠ `"resolved"` (FR-004) | `baselineStatus:"unavailable"` に合流 (§5)。named ref は決して `"unborn"` にならない (`isUnbornHead` の非 HEAD early return を pin) |
| 4 | `git merge-base <ref> HEAD` 失敗 (FR-005) | 同上 `unavailable` 合流。shallow clone / unrelated histories がここに落ちる |

3 と 4 のエラーメッセージ (`baselineError`) は、git の実診断 + **共通の fetch-depth ヒント** (`FETCH_DEPTH_HINT` 定数 — data-model §3) を含む非空文字列。

## 3. Exit code (017 契約 §2 の拡張 — code の意味は不変)

| code | 条件 | 意味 |
|------|------|------|
| `0` | new issue ゼロ、または `--gate` なし。merged diff 空の「No changes」を含む | gate pass / 表示のみ |
| `2` | `--gate` かつ new issue が 1 件以上 | gate fail (base range + 作業ツリーの変更が新規に導入した問題あり) |
| `1` | (a) `--base` を `--diff` なしで指定 (usage error)、または (b) `--gate` かつ baseline 構築不能 — `<ref>` 解決不能 / merge-base 失敗 / worktree 失敗 | 判定不能・構成エラー (fail-closed)。gate 合否と区別される |

- `--gate` なし + `unavailable`: 017 契約どおり stderr 警告 + scoped 全 issue 表示 + exit 0 (`pass:false`, `baselineStatus:"unavailable"`)。
- 縮退判定 (merge-base 失敗時に `<ref>` tip や HEAD へフォールバック等) は行わない (research.md R6)。

## 4. 変更ファイル集合 (FR-006)

```
mergedDiff = (staged ∪ unstaged ∪ untracked)                            // 017/FR-003 の three-way union、不変
           ∪ git -c core.quotePath=false diff --name-only -M -z <mergeBase> HEAD   // --base 時のみ追加
```

- untracked は `--base` 指定時も引き続き含まれる (US2 AS1)。
- 全 git path 取得は `-z` (NUL 区切り) + `core.quotePath=false` に統一 — 既存の three-way 3 呼び出しも本 feature で変換する。非 ASCII path (例: `specs/日本語.md`) は base range 由来でも verbatim に扱われる (SC-007)。
- dedup は path 文字列一致 (表記統一が前提)。

## 5. baseline 側の不変条件 (FR-007/008/009)

- baseline worktree は **diff range と同一の merge-base SHA** で構築される: `computeBaselineIssues(rootDir, <mergeBaseSHA>, lock, config)`。
- rename 検出は `git diff -M <mergeBase>` — base..HEAD 内のコミット済み rename が (a) baseline 側 startId の inverse-rename 解決、(b) baseline orphan-key 正規化の両方に反映される。
- baseline-resolvable probe は HEAD tree ∪ merge-base tree — base..HEAD 内のコミットで削除されたファイルが「not tracked」早期 exit に化けない (fail-open 防止)。
- `--base` に起因する全異常系は `baselineStatus:"unavailable"` に集約される (FR-012)。**新しい exit code・新しい JSON フィールド・新しい baselineStatus 値は導入しない。**

## 6. `--format json` 不変条件

**フィールド追加ゼロ** — 017 契約 §3 のスキーマがそのまま成立する。`--base` の影響は値のみ:

- `baselineStatus`: `--base` 経路の失敗も既存の `"unavailable"`。`baselineError` に原因 + fetch-depth ヒントが入る。
  ```jsonc
  {
    "baselineStatus": "unavailable",
    "baselineError": "fatal: Not a valid object name origin/main\nhint: if this is a shallow clone, fetch full history (actions/checkout: fetch-depth: 0) or fetch the base ref first.",
    "newIssues": { "drifted": [], "orphans": [], "uncovered": [], "testFailures": [] },
    "pass": false
  }
  ```
- merged diff 空 + `--base`: 既存 E4 ショートサーキットの shape (`pass:true`, `baselineStatus:"skipped"`, `message:"No changes detected in git diff."`)。`warnings[]` に CI 警告を **含めない** (FR-010 — `--base` なし + CI のときだけ従来どおり含める)。
- usage error (§2 の 2): JSON を出力しない。stderr + exit 1 のみ (判定は行われていないため、`pass` を持つ JSON を出すとかえって誤読を招く)。

## 7. text 出力

- 正常系 (computed / skipped / gate fail) は 017 契約 §4.1–4.3 と同一フォーマット (new issue サマリ + 抑制件数 + `impact --diff` 誘導)。
- `unavailable` + `--gate` (017 §4.4 の拡張): ERROR 行に原因 (baselineError) と fetch-depth ヒントが含まれる。
  ```text
  check --diff --base origin/main --gate

    ERROR: could not establish a baseline (base ref "origin/main" unresolved or no merge-base).
           hint: if this is a shallow clone, fetch full history (actions/checkout: fetch-depth: 0)
           or fetch the base ref first.
           gate result is undetermined; not treating as pass.
  ```
  exit 1。
- usage error (FR-002):
  ```text
  ERROR: --base requires --diff (--base sets the base point of the git diff; without --diff there is nothing to compare).
         run: artgraph check --diff --base <ref> [--gate]
  ```
  exit 1。

## 8. フラグ相互作用表

| 組み合わせ | 挙動 |
|-----------|------|
| `--base` のみ (`--diff` なし) | usage error, exit 1 (FR-002)。`--gate` / `--format` の有無に関わらず同じ |
| `--diff --base <ref>` | merged diff で判定、表示のみ (exit 0)。`unavailable` は警告 + 全表示 exit 0 |
| `--diff --base <ref> --gate` | merged diff で gate 判定: new あり exit 2 / なし exit 0 / unavailable exit 1 |
| `--diff --gate` ( `--base` なし) | 017 契約そのまま (base ref = HEAD 固定)。byte-identical (FR-003) |
| `--diff --base <ref> --ignore <csv>` | `--ignore` は 017/#178 どおり `newIssues.uncovered` のみ間引く。`unavailable` 時は pass 再計算後も non-passing (FR-012 の集約が保証) |
| `--diff --base <ref> --format json` | §6。フィールド追加なし |
| `--base` + trace shards (`trace.staleness:"gate"`) | base range で広がった scope 内の stale evidence は独立の exit 2 チャネルとして従来どおり発火しうる (spec.md Assumptions — 意味的に正しい挙動として受容、docs に明記) |
| Stop hook (`check --gate --diff`) | 変更なし — テンプレートに `--base` を追加しない (FR-003) |

## 9. 契約テスト (quickstart / tasks と対応)

| # | 契約 | 検証 |
|---|------|------|
| B1 | `--base` w/o `--diff` → exit 1、JSON 非出力 | FR-002 / §2-2 |
| B2 | `--base` なし全実行の byte-identical 回帰 | FR-003 / SC-005 |
| B3 | moved-ahead base で修正済み issue が suppress (exit 0) | FR-005/007 / SC-002 |
| B4 | base..HEAD 内の削除で sole @impl 喪失 → exit 2 | FR-009 / SC-003 (A1) |
| B5 | base..HEAD 内の committed rename → pre-existing orphan suppress | FR-008 / SC-004 (A2) |
| B6 | 解決不能 ref / merge-base 失敗 → exit 1 + fetch-depth ヒント | FR-004/005 / SC-006 (A10) |
| B7 | 空 merged diff + `--base` → exit 0、CI 警告なし (stderr / warnings[]) | FR-010 |
| B8 | 非 ASCII path が base range のみに存在 → gate 判定に入る | FR-006 / SC-007 (A4) |
| B9 | untracked ファイルが `--base` 指定時も集合に入る | FR-006 / US2 AS1 |
| B10 | `isUnbornHead` 非 HEAD early-return の pin (named ref が empty 化しない) | FR-004 |
