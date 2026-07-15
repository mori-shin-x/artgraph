# Quickstart / Validation: check --base <ref> — CI PR gating

実装完了後、この feature が end-to-end で動くことを確認する手順。各シナリオは spec の Success Criteria (SC) と contract のテスト (B) に対応する。

## 前提

```bash
pnpm install && pnpm build   # dist/ を最新化
```

---

## S1. GitHub Actions レシピ (SC-001 / B7) — 本 feature の主目的

PR に対して「その PR が新規に導入した drift / orphan / uncovered」だけでゲートする最小構成:

```yaml
name: artgraph-gate
on: pull_request

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # 必須 — shallow clone では merge-base が解決できず exit 1 (fail-closed)
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec artgraph check --diff --base "origin/${{ github.base_ref }}" --gate
```

**期待**:
- PR が新規問題を導入していなければ exit 0 (base 側の pre-existing 債務は suppress)。
- 新規 orphan / uncovered / drift があれば exit 2 + `newIssues` に該当のみ列挙。
- 従来の「作業ツリー diff が空 → 無言 exit 0」(CI 無言 no-op) は発生しない。`--base` 指定時は CI 警告も出ない。

---

## S2. ローカル: push 前に origin/main と比較 (US2)

```bash
git fetch origin main
node dist/cli.js check --diff --base origin/main --gate; echo "exit=$?"
```

**期待**: ブランチの全コミット + 作業ツリーの未コミット変更 (untracked 含む) の和集合で判定される。ブランチが main と同一 tip かつ clean なら「No changes detected in git diff.」exit 0。

---

## S3. moved-ahead base で誤爆しない (SC-002 / B3)

```bash
# 一時 repo で: base ブランチから feature を分岐 → base 側で branch point 時点の
# issue (未カバー REQ 等) を修正するコミットを積む → feature 側で無害な編集をコミット
node dist/cli.js check --diff --base <base> --gate; echo "exit=$?"   # 期待: exit=0
```

**期待**: baseline は merge-base (branch point) 時点で構築されるため、base の tip では消えている issue も pre-existing として suppress される。`<ref>` tip 比較なら exit 2 になる入力で exit 0 を確認 (自動テスト `tests/check-base-ref.test.ts` が本体)。

---

## S4. base range 内の削除・rename (SC-003 / SC-004 / B4 / B5)

```bash
# 削除: feature ブランチのコミットで sole @impl ファイルを git rm → REQ が uncovered 転落
#   → check --diff --base <base> --gate が exit=2 (fail-open しない)
# rename: pre-existing orphan を持つファイルを git mv してコミット (内容不変)
#   → exit=0 (orphan は pre-existing のまま suppress)
```

**期待**: どちらも作業ツリーは clean (変更はコミット済み) の状態で正しく判定される。

---

## S5. usage error: --base without --diff (B1)

```bash
node dist/cli.js check --base origin/main --gate; echo "exit=$?"   # 期待: exit=1 + ERROR (--diff を案内)
```

**期待**: 警告して続行しない。JSON は出力されない。

---

## S6. `--base` なしの回帰 (SC-005 / B2)

```bash
node dist/cli.js check --diff --gate; echo "exit=$?"    # 本 feature 前と byte-identical
node dist/cli.js check --gate --format json | head -c 200
```

**期待**: `--base` 未指定の全経路 (plain / --diff / --gate / json) の出力・exit code が導入前と一致。Stop hook (`check --gate --diff`) の挙動も不変。

---

## トラブルシューティング

### exit 1: "could not establish a baseline ... fetch-depth"

原因はほぼ shallow clone。`actions/checkout` は既定 `fetch-depth: 1` で、base ブランチも共通祖先も持っていない。

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

ローカルなら:

```bash
git fetch origin main          # base ref を取得
git fetch --unshallow          # shallow clone を解除 (必要なら)
```

### exit 1: base ref が解決しない

- `origin/main` の typo / 未 fetch を確認 (`git rev-parse --verify origin/main^{commit}`)。
- fork からの PR 等で base リモートが異なる場合は、対象 remote を明示的に fetch する。
- unrelated histories (共通祖先なし) は仕様上サポートしない — 判定不能として exit 1 (fail-open しない)。

### `trace.staleness: "gate"` で今まで出なかった exit 2 が出る

`--base` は作業ツリー diff より広い範囲 (PR 全体) を scope に入れるため、その範囲内の stale evidence が新たに gate 対象になる。これは仕様 (spec.md Assumptions) — テストを再実行して trace を更新するか、staleness を `warn` に下げる。

---

## 自動テストで担保する範囲

| テスト | カバーする SC / B |
|--------|-------------------|
| `tests/check-base-ref.test.ts` | S2〜S5 (B1/B3/B4/B5/B6/B7/B8/B9/B10) |
| `tests/diff.test.ts` (拡張) | FR-006 union / -z 化 / FR-008 / FR-009 の関数単位 |
| `tests/baseline.test.ts` (拡張) | `resolveMergeBase` / unborn 非 HEAD pin |
| 既存 `tests/check-baseline-diff.test.ts` (E1 拡張) | B7 (CI 警告の抑制) + `--base` なし回帰 (B2) |

## dogfood 最終確認

```bash
pnpm test                                              # unit + e2e + perf 全通過
node dist/cli.js check --diff --gate                   # 従来経路 exit 0 (回帰なし)
node dist/cli.js check --diff --base HEAD --gate       # merge-base(HEAD,HEAD)=HEAD → Phase 1 と同挙動で exit 0
git fetch origin main && node dist/cli.js check --diff --base origin/main --gate   # 本 repo でブランチ全体を gate
```
