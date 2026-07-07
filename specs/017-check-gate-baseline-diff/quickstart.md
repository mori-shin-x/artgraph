# Quickstart / Validation: check --gate baseline 差分化

実装完了後、この feature が end-to-end で動くことを確認する手順。各シナリオは spec の Success Criteria (SC) と contract のテスト (C) に対応する。

## 前提

```bash
pnpm install && pnpm build   # dist/ を最新化
```

すべて git リポジトリ内で実行する (`--diff` は git 前提)。作業ツリーを汚さないよう、破壊的手順は最後に `git checkout --` で戻す。

---

## S1. pre-existing 債務でゲートが赤くならない (SC-001 / C1) — issue #174 本体

```bash
# clean 状態: 現状も新実装も exit 0
node dist/cli.js check --diff --gate; echo "exit=$?"   # 期待: exit=0

# 多数の REQ に波及するファイルへ意味を変えない編集
echo "" >> src/doctor.ts
node dist/cli.js check --diff --gate; echo "exit=$?"   # 期待: exit=0 (現状は exit=2)
git checkout -- src/doctor.ts
```

**期待**: text 出力は「No new issues introduced by this change.」+ 抑制した pre-existing 件数のみ。pre-existing の未タグ付け REQ 全件 (数百行) を列挙しない。

---

## S2. 新規に導入した問題は確実に捕まえる (SC-002 / C2)

一時 git repo か作業コピーで、3 種の新規問題をそれぞれ導入して確認 (自動テスト `check-baseline-diff.test.ts` が本体、以下は手動確認例)。

```bash
# 新規 orphan: 存在しない REQ を claim するタグを変更ファイルに追加
#   → check --diff --gate が exit=2、newIssues.orphans に該当行
# 新規 uncovered: 新 REQ を spec に追加し実装しない
#   → exit=2、newIssues.uncovered に該当 REQ
# 新規 drift: spec を編集し reconcile しない
#   → exit=2、newIssues.drifted に該当 nodeId
```

**期待**: いずれも exit 2。`--format json` の `newIssues` に該当 issue が入り、`pass:false`。pre-existing 債務は `suppressedCount` にのみ計上され合否に影響しない。

---

## S3. 副作用ゼロ (SC-003 / C3)

```bash
git status --porcelain > /tmp/before.txt
md5sum .trace.lock 2>/dev/null > /tmp/lock_before.txt
echo "" >> src/doctor.ts
node dist/cli.js check --diff --gate >/dev/null 2>&1     # baseline 算出 (worktree) が走る
git status --porcelain | grep -v doctor.ts > /tmp/after.txt
md5sum .trace.lock 2>/dev/null > /tmp/lock_after.txt
git checkout -- src/doctor.ts

diff /tmp/before.txt /tmp/after.txt && echo "worktree/index: 不変 OK"
diff /tmp/lock_before.txt /tmp/lock_after.txt && echo "lock: 不変 OK"
git worktree list   # 一時 worktree が残っていない (撤去済み) こと
```

**期待**: baseline 算出前後で作業ツリー・index・`.trace.lock` が不変。一時 worktree は撤去済み。

---

## S4. 大差分でも出力が読める (SC-004 / C4)

```bash
# src 配下の複数ファイルに意味を変えない編集をまとめて加える (リファクタ相当)
# → check --diff の text 出力が「新規ゼロ」の簡潔な数行に収まり、
#   pre-existing 全件 (現状 279 行規模) を吐かない
```

**期待**: 新規問題ゼロを示す簡潔な出力。`impact --diff` への誘導行あり。

---

## S5. 遅延評価 (SC-005 / C5)

```bash
# current が完全にクリーン (scoped issue ゼロ) のケースでは worktree を生成しない。
# baseline.test.ts で computeBaselineIssues が呼ばれないこと / baselineStatus==="skipped" を確認。
node dist/cli.js check --diff --gate --format json | jq '.baselineStatus'
# clean のとき: "skipped"
```

**期待**: current クリーン時 `baselineStatus:"skipped"`、worktree 未生成。

---

## S6. blast radius 温存 (SC-006)

```bash
echo "" >> src/doctor.ts
A=$(node dist/cli.js impact --diff --format json | jq '.summary')
git stash -q 2>/dev/null || git checkout -- src/doctor.ts   # 実装前後の比較は git 履歴で
echo "impact summary (この feature 前後で不変であること): $A"
git checkout -- src/doctor.ts 2>/dev/null
```

**期待**: `impact --diff` の影響 REQ / doc / file 件数がこの feature の前後で同一。ゲートの絞り込みが可視化に波及しない。

---

## S7. baseline 構築不能 → exit 1 (FR-010 / C6)

```bash
# 非 git ディレクトリ、または worktree 生成を強制失敗させた状況で
node dist/cli.js check --diff --gate; echo "exit=$?"   # 期待: exit=1 + ERROR メッセージ
```

**期待**: exit 1。判定不能を明示し、exit 2 (gate fail) とも exit 0 (pass) とも区別される。

---

## 自動テストで担保する範囲

| テスト | カバーする SC / C |
|--------|-------------------|
| `tests/check-baseline-diff.test.ts` | S1, S2 (C1/C2) |
| `tests/baseline.test.ts` | S3, S5, S7 (C3/C5/C6) |
| `tests/check-orphan-scope.test.ts` | FR-006 orphan 厳密化の回帰 |
| `tests/check-gate-output.test.ts` | S4 (C4/C7 出力・json) |
| 既存 `tests/check-gate-no-regression.test.ts` | FR-012 後段 (doctor 非依存) の維持 |

## dogfood 最終確認

```bash
pnpm test        # unit + e2e + perf 全通過
node dist/cli.js check --diff --gate   # 本 repo で exit 0 (pre-existing 債務で赤くならない)
```
