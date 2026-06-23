# Quickstart: SDD ツールワークフロー統合 — Validation Guide

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-06-23

本機能の実装が完了したことを E2E で検証する手順。E2E テスト（`packages/artgraph/tests/integrate-cli.test.ts`）はこのシナリオをそのまま `tmpdir` ベースで自動化する。

---

## 前提

- `pnpm install` 済み（`yaml` 依存が追加されている）
- `pnpm -C packages/artgraph build` 済み（`dist/cli.js` が生成済み）
- 作業用 tmpdir を確保: `WORK=$(mktemp -d)`

---

## シナリオ 1: Spec Kit リポジトリへの統合（一連の冪等性確認）

```bash
# Setup: 空の .specify を持つ repo を模擬
cd $WORK
mkdir -p .specify
cat > .specify/extensions.yml <<'EOF'
installed:
- agent-context
settings:
  auto_execute_hooks: true
hooks:
  after_specify:
  - extension: agent-context
    command: speckit.agent-context.update
    enabled: true
    optional: true
    priority: 10
    prompt: Execute speckit.agent-context.update?
    description: Refresh agent context after specification
    condition: null
EOF

# Step 1: 統合を実行
artgraph integrate speckit

# 期待:
#   exit 0
#   stdout に "✓ Integrated: speckit (Spec Kit)"
#   .specify/extensions/spectrace/ が生成 (extension.yml, README.md, commands/*.md)
#   .specify/extensions.yml に installed: [spectrace] と hooks: { after_tasks, after_implement } が追記
#   既存 after_specify の agent-context entry は不変

# Step 2: 冪等性確認 — 同じコマンドを再実行
artgraph integrate speckit

# 期待:
#   exit 0
#   stdout に "✓ Already integrated: speckit (Spec Kit) — no changes"
#   disk に変化なし（git diff 等で確認）

# Step 3: --gate モードを追加
artgraph integrate speckit --gate

# 期待:
#   exit 0
#   stdout に "Modified (1): .specify/extensions.yml"
#   extensions.yml に before_implement: [{...artgraph.check-gate...}] が追加

# Step 4: --no-gate で削除
artgraph integrate speckit --no-gate

# 期待:
#   exit 0
#   extensions.yml の before_implement の spectrace entry が削除
#   他 hook trigger は不変

# Step 5: アンインストール
artgraph integrate speckit --uninstall

# 期待:
#   exit 0
#   .specify/extensions/spectrace/ が削除
#   .specify/extensions.yml の installed リストから spectrace 削除
#   spectrace 由来の hook entry がすべて削除
#   agent-context の entry は不変
```

**判定**: 全 step が期待通りなら spec FR-001〜FR-007 / FR-015〜FR-017 が満たされている。

---

## シナリオ 2: Kiro リポジトリへの統合

```bash
# Setup
cd $WORK
rm -rf .specify
mkdir -p .kiro/steering

# Step 1: 統合
artgraph integrate kiro

# 期待:
#   exit 0
#   .kiro/steering/spectrace.md が生成
#   stdout に "Created (1): .kiro/steering/spectrace.md"

# Step 2: 冪等性
artgraph integrate kiro

# 期待:
#   exit 0、"Already integrated"、disk 不変

# Step 3: --force での再生成
artgraph integrate kiro --force

# 期待:
#   既存ファイルを上書き、stdout に "Modified (1): .kiro/steering/spectrace.md"

# Step 4: 統合済みリポジトリで Kiro なし
rm -rf .kiro
artgraph integrate kiro
# 期待: exit 1、stderr に "Kiro not detected"、disk 不変
```

**判定**: spec FR-008〜FR-011 が満たされている。

---

## シナリオ 3: `integrate list`

```bash
# Setup: 両方検出 + 片方のみ導入
cd $WORK
rm -rf .specify .kiro
mkdir .specify .kiro
artgraph integrate speckit

artgraph integrate list
# 期待 (text):
#   speckit  Spec Kit  [ detected: yes, installed: yes ]
#   kiro     Kiro      [ detected: yes, installed: no  ] → run: artgraph integrate kiro

artgraph integrate list --format=json
# 期待: JSON が data-model.md §3 の IntegrationStatus 配列に整合
```

**判定**: ユーザー指定の `list` サブコマンドが機能。

---

## シナリオ 4: `init --integrate=all`

```bash
# Setup: 何もない repo
cd $WORK
rm -rf .specify .kiro .artgraph.json
mkdir .specify .kiro
echo '{}' > .kiro/dummy.json    # detection 用ダミー

artgraph init --integrate=all --no-scan

# 期待:
#   exit 0
#   stdout に SDD ツール検出メッセージ + integrate 完了メッセージ
#   "=== Integration: speckit ===" と "=== Integration: kiro ===" の 2 セクション
#   .specify/extensions/spectrace/ と .kiro/steering/spectrace.md が両方生成
```

未検出ツール指定の挙動：

```bash
rm -rf .kiro
artgraph init --integrate=kiro --no-scan

# 期待:
#   exit 0 (init 全体は成功)
#   stdout に "WARNING: Kiro not detected, skipping integration"
#   init 自体は完了
```

`--integrate-gate` の透過：

```bash
mkdir -p .specify
artgraph init --integrate=speckit --integrate-gate --no-scan

# 期待:
#   speckit に --gate が適用
#   .specify/extensions.yml に before_implement entry が含まれる
```

**判定**: spec FR-022〜FR-024 と SC-007 が満たされている。

---

## シナリオ 5: `init` 案内表示（FR-012/013）

```bash
# Setup: Spec Kit 未導入
cd $WORK
rm -rf .specify .kiro .artgraph.json
mkdir .specify

artgraph init --no-scan

# 期待:
#   stdout 末尾に "Tip: Spec Kit detected. Run \"artgraph integrate speckit\" ..." が表示

# Setup: 統合済み
artgraph integrate speckit
artgraph init --force --no-scan

# 期待:
#   stdout 末尾に "Tip:" 行が表示されない（導入済みなので案内不要）
```

**判定**: spec FR-012〜FR-014 と SC-005 が満たされている。

---

## シナリオ 6: 部分失敗時の rollback（edge case）

これは手動再現が難しい（途中で disk full を起こす必要がある）ため、unit テスト（`atomic-write.test.ts` の `fails partway through` ケース）で擬似的に検証する：

```typescript
// テスト内で fs.renameSync を mock → 1 ファイル目は成功、2 ファイル目で throw
// 期待: install() throws、1 ファイル目も巻き戻されて削除済み、disk が install 前と一致
```

**判定**: spec edge case「途中失敗時に部分適用を残さない」が満たされている。

---

## 全シナリオ完走後の状態

- `spec.md` のすべての FR (FR-001〜FR-024) に対応するシナリオが少なくとも 1 つ実行されている
- `spec.md` の SC-001〜SC-007 が観察可能な形で達成されている
- E2E テスト `integrate-cli.test.ts` は本ドキュメントのシナリオを `tmpdir` ベースで再現し、CI で常時実行される
