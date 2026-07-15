# Quickstart / Validation: impact --diff --base <ref> — CI テスト選択

実装完了後、この feature が end-to-end で動くことを確認する手順。各シナリオは spec の Success Criteria (SC) と contract のテスト (I) に対応する。

## 前提

```bash
pnpm install && pnpm build   # dist/ を最新化
```

`--tests` を使うシナリオは trace shards (`.artgraph/trace/*.jsonl` — `artgraph/vitest` runner で生成) が存在すること。

---

## S1. GitHub Actions レシピ (SC-001 / I3) — 本 feature の主目的

PR に対して「その PR のコミット範囲 (+ 作業ツリー) が触るテストだけ」を選択実行する構成。**consumer rule (spec FR-009 / D-5) を織り込むこと**: `impact --tests` は最適化であり、exit 1 では必ず full suite に fallback する。正しさのゲートは別ステップの `check --diff --base --gate` (spec 023) が担う。

```yaml
name: artgraph-test-selection
on: pull_request

jobs:
  selected-tests:
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
      # (trace shards を base ブランチの実行からキャッシュ復元するステップは省略 —
      #  shards ゼロなら --tests は exit 1 で full suite に fallback する)
      - name: Select and run tests (fall back to full suite on exit 1)
        run: |
          set +e
          out=$(pnpm exec artgraph impact --diff --base "origin/${{ github.base_ref }}" --tests --format json)
          status=$?
          set -e
          if [ "$status" -ne 0 ]; then
            echo "impact exited $status — falling back to the full suite (consumer rule)"
            pnpm test
            exit $?
          fi
          if [ "$(echo "$out" | jq -r '.message // empty')" = "No changes detected in git diff." ]; then
            echo "No changes against the base — nothing to select."
            exit 0
          fi
          files=$(echo "$out" | jq -r '[.testsToRun[].testFile] | unique | .[]')
          if [ -z "$files" ]; then
            echo "Empty selection — running the full suite to stay safe (consumer rule)"
            pnpm test
          else
            echo "$files" | xargs pnpm vitest run
          fi
```

**期待**:

- 作業ツリー clean (CI の常態) でも、PR のコミット範囲の変更から `testsToRun` が返る — 現状の「No changes detected → 空選択」無言空振りが消える。
- 削除された / グラフ未追跡の変更ファイルは選択に寄与しない (spec D-1 — 宣言された選択限界)。それらの正しさは同じ CI の `check --diff --base --gate` ステップが exit 2 で捕まえる。
- 環境失敗 (shallow / 未 fetch / typo) は exit 1 + stderr 診断のみ (stdout に JSON なし) → 上記スクリプトは full suite に fallback する。

---

## S2. ローカル: push 前にブランチ全体のテスト選択 (US2)

```bash
git fetch origin main
node dist/cli.js impact --diff --base origin/main --tests; echo "exit=$?"
```

**期待**: ブランチの全コミット + 作業ツリーの未コミット変更 (untracked 含む) の和集合から選択される (I9)。ブランチが main と同一 tip かつ clean なら「No changes detected in git diff.」exit 0 (I8)。`--base HEAD` は `--base` なしの `--diff` と同一結果 (I10)。

---

## S3. check との分業を確認する (SC-002 / SC-003 / I4 / I5)

```bash
# 一時 repo で: feature ブランチのコミットで sole @impl ファイルを git rm した状態を作る
node dist/cli.js impact --diff --base <base> --tests --format json   # 削除ファイル由来の選択は含まれない (silent)
node dist/cli.js check  --diff --base <base> --gate; echo "exit=$?"  # 期待: exit=2 — uncovered 転落を gate が捕まえる
```

**期待**: impact は選択 (最適化)、check は判定 (正しさ) — check-scope ⊇ impact-reach。同一 `<ref>` に対する両者の merged changed-file set 自体は一致する (agreement (i) — 自動テスト `tests/check-baseline-diff.test.ts` US4 拡張が本体)。

---

## S4. fail-closed エラー系 (SC-004 / I1 / I6 / I11 / I13)

```bash
node dist/cli.js impact src/cli.ts --base origin/main; echo "exit=$?"      # 期待: exit=1 "--base requires --diff" (排他エラーではない)
node dist/cli.js impact --diff --base nosuchref --format json; echo "exit=$?"
#   期待: exit=1、stderr に `error: base ref "nosuchref" does not resolve` + fetch-depth ヒント、stdout は空 (JSON なし)
node dist/cli.js impact --diff --base "" ; echo "exit=$?"                  # 期待: exit=1 (parse 時値ガード)
node dist/cli.js impact --diff --format yaml; echo "exit=$?"               # 期待: exit=1 (.choices() — 従来は silent text fallback)
```

---

## S5. `--base` なしの回帰 (SC-005 / I2)

```bash
node dist/cli.js impact --diff --format json | head -c 200    # 本 feature 前と byte-identical
node dist/cli.js impact src/cli.ts                            # targets 経路も不変
node dist/cli.js impact REQ-001; echo "exit=$?"               # rejection 文言不変 (--base は列挙に現れない)
```

**期待**: `--base` 未指定の全経路の出力・exit code が導入前と一致。唯一の例外は `--format` bogus 値 (S4 最終行) で、それは新挙動として独立に pin される。

---

## トラブルシューティング

### exit 1: "does not resolve ... fetch-depth"

原因はほぼ shallow clone。`actions/checkout` は既定 `fetch-depth: 1` で、base ブランチも共通祖先も持っていない。

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

ローカルなら `git fetch origin main` / `git fetch --unshallow`。unrelated histories (共通祖先なし) はサポートしない — exit 1 (fail-open しない)。

### exit 1: "No matching nodes found"

merged diff の全ファイルがグラフ外 (docs のみの PR、削除のみの PR 等)。仕様どおりの fail-closed シグナル (spec D-4) — CI は full suite に fallback する (S1 のスクリプトは自動で行う)。

### 選択が「少なすぎる」— `trace.staleness: "exclude"` の警告が出ている

`--tests` + `--base` + `staleness: "exclude"` の組み合わせは、PR が変更したコードの evidence をちょうど stale として除外し、そのテストを選択から落とす (spec D-9 — 実行時 WARNING が出る)。CI のテスト選択では `staleness: "warn"` を使うか、full suite に fallback する。

### testsToRun が空 (exit 0)

「変更が evidence 到達のある REQ に触れていない」正当な結果でもあるが、削除・グラフ未追跡ファイル (D-1) の可能性もある。不確かなら consumer rule どおり full suite を実行する (S1 のスクリプトは空選択で full suite に倒している)。

---

## 自動テストで担保する範囲

| テスト | カバーする SC / I |
|--------|-------------------|
| `tests/impact-base-ref.test.ts` (新規) | I1/I2/I3/I5/I6/I7/I8/I9/I10/I11/I12/I13 |
| `tests/check-baseline-diff.test.ts` US4 拡張 | I4 (agreement — SC-002/SC-003) |

## dogfood 最終確認

```bash
pnpm test                                                        # unit + e2e + perf 全通過
node dist/cli.js impact --diff --format json | head -c 200       # 従来経路の回帰なし
node dist/cli.js impact --diff --base HEAD --format json | head -c 200   # 退化ケース
git fetch origin main && node dist/cli.js impact --diff --base origin/main --tests   # 本 repo でブランチ全体のテスト選択
```
