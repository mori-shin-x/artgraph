# Quickstart: trace capture engine v2 — 検証手順

実装後に feature が end-to-end で成立していることを確認する手順。前提: `pnpm install` 済み・Node >= 22。

## 0. ビルド

```bash
pnpm build   # perf / e2e は dist/ の成果物を測る(既存 perf 規約)
```

## 1. 変換 unit(Phase B)

```bash
pnpm vitest run tests/vitest-plugin.test.ts tests/hash-equivalence.test.ts
```

期待: 命名規則([research.md](./research.md) V4 の全種別)・挿入の行構造不変・除外規則・parse 不能 fail-soft・hash SSOT 等価ピンがすべて green。

## 2. differential パリティ E2E(Phase C / SC-004)

```bash
pnpm vitest run --config vitest.e2e.config.ts tests/e2e/engine-parity.e2e.test.ts
```

期待: 命名種別網羅 fixture を `instrument` / `cdp` 両エンジンで実行し、shard → ingest 通過後の正規化エッジ集合が一致。

## 3. 既存 runner E2E の両エンジン化(Phase C / FR-014)

```bash
pnpm test:e2e
```

期待: vitest 3.x / 4.x マトリクス(CI)× forks / threads × 両エンジンで、shard 生成・部分 shard 耐性・世代管理の既存シナリオが green。

## 4. perf バジェット(Phase A / D — SC-002 / SC-003)

```bash
pnpm test:perf
```

期待: 純関数 500 テスト fixture と import 重 fixture の両方で、withRunner/baseline 比の median がバジェット(Phase D 後は 1.2)以内。実測比はテストログに毎回出力される。

## 5. dogfooding 計測(SC-001 — 手動・PR 記録用)

自スイート(1,800 テスト級)での実測。CI assert ではなく PR の Testing 節に記録する([research.md](./research.md) V9)。

```bash
# baseline(採取なし)
time pnpm vitest run

# v2 エンジン(vitest.config.ts が withTrace 済みであること。engine 未指定 = instrument)
time pnpm vitest run   # ← withTrace 有効の設定で

# 比較用: cdp fallback
ARTGRAPH_TRACE_ENGINE=cdp time pnpm vitest run
```

期待: v2 / baseline の比が **1.15 以下**(現行 cdp は ≈1.7)。3 回程度の中央値で判断し、実測値を PR に記録する。

## 6. 下流の不変性(SC-005)

```bash
# v2 で生成した shard に対して下流が無変更で動くこと
pnpm exec artgraph trace report
pnpm exec artgraph scan --format json | sha256sum   # 同一入力で 2 回実行し一致を確認
pnpm exec artgraph check --diff
```

期待: `trace report` が v2 shard を読める・scan 出力が byte-identical・check green。trace 不在時の出力が導入前と一致することは既存回帰テスト(spec 020 SC-007 系)がカバー。

## 7. 導入 UX の確認(FR-001 / config-surface)

```bash
# ユーザー視点: 設定は従来どおり 1 行(オプションなし)
# export default defineConfig(withTrace({ test: { ... } }));
# → instrument 既定で動作。engine 切替は withTrace({...}, { engine: 'cdp' }) または env。
ARTGRAPH_TRACE_ENGINE=bogus pnpm vitest run   # → 明確なエラーで fail-fast(silent fallback しない)
```
