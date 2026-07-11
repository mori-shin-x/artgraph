# Quickstart: カバレッジ由来トレーサビリティの E2E 検証(spec 020)

実装後に feature が端から端まで動くことを証明する検証手順。Phase ごとに独立して実行できる。fixture は `tests/` の既存 E2E 慣行(temp dir に最小プロジェクトを合成)に従う。

## 前提

- Node >= 22 / pnpm / vitest がインストールされた検証用プロジェクト
- 最小 fixture: `src/auth.ts`(`signIn` / `resetPassword`)、`src/util.ts`(`validateEmail` — 共有ヘルパ)、`src/billing.ts`(`charge`)、各 REQ のタグ付きテスト 3 本(`[REQ-001]`〜`[REQ-003]`)、`specs/app.md` に REQ-001〜003 を定義。**`@impl` タグはゼロ**

## Phase A: trace 採取 + 突き合わせレポート

```bash
# 1. runner を 1 行追加して普通にテストを回す
echo "runner: 'artgraph/vitest'" # vitest.config.ts の test 節に追加
pnpm vitest run
ls .artgraph/trace/*.jsonl            # 期待: ワーカー数分の shard が生成

# 2. レポート(グラフ非改変)
pnpm exec artgraph trace status        # 期待: shard 件数・診断 0
pnpm exec artgraph trace report --format json
# 期待: suggestedImpls に (REQ-001, signIn) (REQ-002, resetPassword) (REQ-003, charge)
#       infrastructure に validateEmail (reqCount: 3)
#       unexercisedClaims は空(@impl ゼロのため)

# 3. 監査の成立確認: 偽の @impl を植えて再実行
sed -i 's|export function signIn|// @impl REQ-003\nexport function signIn|' src/auth.ts
pnpm exec artgraph trace report --format json
# 期待: unexercisedClaims に (REQ-003, symbol:src/auth.ts#signIn)  ← SC-003
```

## Phase B: scan / lock 統合(タグゼロ・トレーサビリティ = SC-001)

```bash
pnpm exec artgraph scan --format json | jq '[.edges[] | select(.kind=="exercises")]'
# 期待: REQ-001→signIn / REQ-002→resetPassword / REQ-003→charge(交差なし、US1-1)
#       validateEmail への exercises エッジは REQ 3 つ分あるが sharedThreshold で提案対象外

pnpm exec artgraph scan --format json > a.json && pnpm exec artgraph scan --format json > b.json
diff a.json b.json                     # 期待: 差分なし(byte-identical、SC-002)

rm -rf .artgraph/trace && pnpm exec artgraph scan --format json
# 期待: exercises エッジ 0 本・導入前と同一出力(FR-010 / SC-007)

pnpm exec artgraph reconcile && grep -A2 'REQ-001' .trace.lock
# 期待: lock の req エントリに exercises: [...](ソート済み)
```

## Phase C: check / impact / staleness

```bash
# exercised 充足(オプトイン、US4)
pnpm exec artgraph check --format json | jq '.coverage'          # 期待: REQ-001..003 = uncovered(既定 off)
# .artgraph.json に "trace": {"acceptExercises": true} を設定
pnpm exec artgraph check --format json | jq '.coverage'          # 期待: exercised(uncovered から消える)

# staleness(US5)
sed -i 's/bad amount/invalid amount/' src/billing.ts             # charge を編集
pnpm exec artgraph check --format json | jq '.staleEvidence'     # 期待: REQ-003 + charge が stale(warn / exit 0)
pnpm vitest run && pnpm exec artgraph check --format json | jq '.staleEvidence'  # 期待: 空(世代置換で解消)

# テスト選択(US3)
git diff --stat                                                   # charge のみ変更の状態を作る
pnpm exec artgraph impact --diff --tests --format json
# 期待: testsToRun = [REQ-003 のテスト 1 件のみ]
rm -rf .artgraph/trace && pnpm exec artgraph impact --diff --tests
# 期待: exit 1 + runner 導入ガイダンス(FR-018)
```

## 回帰・品質ゲート(全 Phase 共通)

```bash
pnpm typecheck && pnpm test:unit && pnpm test:e2e && pnpm knip
# vitest 3.x / 4.x マトリクス E2E(runner 互換、plan.md D8)
# オーバーヘッド perf テスト: 507 テスト級 fixture で増加率 <= 50%(SC-005)
```

## ドッグフーディング(受け入れの最終確認)

artgraph 自身のリポジトリで runner を有効化し、`trace report` を実行する。既存の `@impl` 23 ファイル分の宣言に対して unexercisedClaims / corroborated の内訳が出ること、および `artgraph check --diff` が green のままであること(Stop hook 互換)を確認する。
