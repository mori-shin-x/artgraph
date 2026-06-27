# Quickstart: Validation Scenarios

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)

各 User Story (US1–US8) を独立に検証する手動 / 半自動シナリオ。**実装担当者が PR を出す前と、レビュアーがマージ前に手動で 1 回**走らせる validation 手順。

E2E vitest は `tests/` 配下に自動化するが (FR-028)、本 quickstart は「人間が実際の体験を確認する」用途。

---

## 前提

すべてのシナリオは以下を前提とする:

- Node.js >= 22
- pnpm >= 9 (artgraph 自身の開発時、ユーザー側は npm でも可)
- git で初期化された一時的な検証用 repo (`mkdir /tmp/aw-test-XX && cd $_ && git init`)
- このリポジトリの artgraph を `pnpm link --global` または `pnpm build && npm install /path/to/skills-expansion -g` でローカル install しておく
- Claude Code v2 系最新 (Skills + Plugin GA 版)

---

## US1: 新規プロジェクトのエージェント自己駆動セットアップ

**実装後 (P0 + P1 完了時) に検証**

### Setup

```bash
mkdir -p /tmp/aw-us1 && cd /tmp/aw-us1
git init
echo '{"name":"aw-us1","type":"module","scripts":{"test":"vitest"}}' > package.json
mkdir -p specs src
echo '- REQ-001: Users can sign in.' > specs/auth.md
mkdir -p .specify/templates
touch .specify/feature.json
```

(Spec Kit / Kiro は意図的に **未** 導入のままにする)

### Test

Claude Code 起動 (`claude code`)、次のメッセージを送信:

```
このプロジェクトに artgraph をセットアップして
```

### Expected

1. エージェントが `artgraph-setup` Skill を発火 (Skill リストに `artgraph-setup` が表示される)
2. ユーザー同意 (Y) で `npm install -D artgraph` が走る
3. 続けて `npx artgraph init --with-skills --integrate=auto --with-hooks --with-agent-context` が走る
4. SDD ツール検出ゼロ報告 (`auto` が no-op で正常終了)
5. 完了報告: `.artgraph.json`, `.claude/skills/artgraph-*`, `.claude/settings.json`, `CLAUDE.md` が生成
6. **`artgraph check` を実行して exit 0** がエージェントから報告される

### Verification

```bash
ls -la .artgraph.json .claude/skills/ .claude/settings.json CLAUDE.md
npx artgraph check    # exit 0
cat .claude/settings.json | jq '.hooks.Stop'   # artgraph check --gate --diff が登録
grep "artgraph: BEGIN" CLAUDE.md   # マーカー存在
```

### Success criteria

- SC-001: ユーザー入力が同意 1 回のみで完結
- 期待結果すべてが満たされる

---

## US2: 既存リポへの SDD 統合の後付け

**実装後 (P0 完了時) に検証**

### Setup

```bash
mkdir -p /tmp/aw-us2 && cd /tmp/aw-us2
git init
echo '{"name":"aw-us2","type":"module"}' > package.json
mkdir -p specs && echo '- REQ-001: Test' > specs/test.md
npm install -D /path/to/skills-expansion   # artgraph 導入
npx artgraph init --with-skills

# Spec Kit を後から導入
mkdir -p .specify/templates
touch .specify/extensions.yml
```

### Test

Claude Code で:
```
Spec Kit と連携して
```

### Expected

1. `artgraph-integrate` Skill 発火
2. `artgraph integrate list` 実行、Spec Kit が `detected / not installed` で報告
3. 同意で `artgraph integrate speckit --gate` 実行
4. `.specify/extensions/artgraph/` 以下と `.specify/extensions.yml` 追記を確認

### Verification

```bash
test -f .specify/extensions/artgraph/extension.yml
grep -A3 "artgraph" .specify/extensions.yml
test -f .specify/extensions/artgraph/commands/artgraph.scan-reconcile.md
```

---

## US3: 開発中の自然な Skill 発火 (既存 4 Skill 改修)

**実装後 (P0 完了時) に検証**

### Setup

US1 完了状態の repo を流用。または:

```bash
mkdir -p /tmp/aw-us3 && cd /tmp/aw-us3
# (US1 と同じ setup)
# 簡略化のため: setup 済みと仮定
echo '// @impl REQ-001' >> src/auth.ts
echo 'export function signIn() {}' >> src/auth.ts
git add . && git commit -m 'baseline'
# 意図的な drift を作る
echo '- REQ-001: Users can sign in with email and password.' > specs/auth.md
```

### Test 1: artgraph-plan の発火

Claude Code:
```
この diff の plan を立てて
```

### Expected 1

- `artgraph-plan` Skill が発火し、`artgraph impact --diff --format json` を実行
- 影響範囲 (REQ-001 / src/auth.ts) がエージェントの context に注入されて plan に反映

### Test 2: artgraph-verify の発火

Claude Code (同じ session):
```
整合性チェックして
```

### Expected 2

- `artgraph-verify` Skill 発火
- `artgraph check --diff --format text` が走り、drift (`REQ-001` の spec hash 変更) を検出
- エージェントが drift を報告し、対処案を提示

### Test 3: 既存 Skill の DRY 化検証 (静的)

```bash
wc -l templates/skills/artgraph-{plan,verify,coverage,rename}/SKILL.md
# 各 100 行以下

grep -l "_shared/install-check" templates/skills/*/SKILL.md
# 7 件 (全 Skill が共通参照を持つ)

# 共通参照ファイルの存在
test -f templates/skills/_shared/install-check.md
```

### Success criteria

- SC-002: 既存 4 Skill が 100 行以下、install-check 重複ゼロ
- SC-003: Skill description が R10 規約に準拠 (peer review)

---

## US4: セットアップ時の検証ゲート設置

**実装後 (P1 完了時) に検証**

### Setup A: 既存 settings.json なし

```bash
mkdir -p /tmp/aw-us4a && cd /tmp/aw-us4a
git init
echo '{"name":"aw-us4a","type":"module"}' > package.json
npm install -D /path/to/skills-expansion
npx artgraph init --with-hooks
```

### Expected A

```bash
cat .claude/settings.json
# {
#   "hooks": {
#     "Stop": [{ "hooks": [{ "type": "command", "command": "npx artgraph check --gate --diff" }] }]
#   }
# }
```

### Setup B: 既存 settings.json に他 hook あり (Case C in settings-merge.md)

```bash
mkdir -p /tmp/aw-us4b && cd /tmp/aw-us4b
git init
echo '{"name":"aw-us4b","type":"module"}' > package.json
mkdir -p .claude
cat > .claude/settings.json <<'EOF'
{ "hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "echo before" }] }] } }
EOF
npm install -D /path/to/skills-expansion
npx artgraph init --with-hooks
```

### Expected B

```bash
cat .claude/settings.json | jq '.hooks | keys'
# ["PreToolUse", "Stop"]
# PreToolUse は保持、Stop が追加
```

### Setup C: 既存 Stop hook あり (衝突)

```bash
mkdir -p /tmp/aw-us4c && cd /tmp/aw-us4c
git init
echo '{"name":"aw-us4c","type":"module"}' > package.json
mkdir -p .claude
cat > .claude/settings.json <<'EOF'
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo custom-stop" }] }] } }
EOF
npm install -D /path/to/skills-expansion
npx artgraph init --with-hooks ; echo "exit: $?"
```

### Expected C

- stderr に警告 (`[WARN] .claude/settings.json already has a Stop hook configured...`)
- exit code: **1**
- settings.json は **無変更** (既存 custom-stop が残る)

### Setup D: CLAUDE.md 注入

```bash
mkdir -p /tmp/aw-us4d && cd /tmp/aw-us4d
git init && echo '{"name":"aw-us4d","type":"module"}' > package.json
cat > CLAUDE.md <<'EOF'
# Project notes

These notes are managed by humans.
EOF
npm install -D /path/to/skills-expansion
npx artgraph init --with-agent-context
```

### Expected D

```bash
cat CLAUDE.md
# # Project notes
#
# These notes are managed by humans.
#
# <!-- artgraph: BEGIN agent context -->
# ... (30 行以内のスニペット) ...
# <!-- artgraph: END agent context -->
```

#### Idempotency check

```bash
npx artgraph init --with-agent-context   # 2 回目
diff <(cat CLAUDE.md) <(cat CLAUDE.md)
# diff なし (べき等)
```

---

## US5: Kiro での semantic 発火

**実装後 (P1 完了時) に検証**

### Setup

```bash
mkdir -p /tmp/aw-us5 && cd /tmp/aw-us5
git init && echo '{"name":"aw-us5","type":"module"}' > package.json
mkdir -p .kiro/steering .kiro/specs/feature-x
echo '# Feature X requirements' > .kiro/specs/feature-x/requirements.md
npm install -D /path/to/skills-expansion
npx artgraph init --integrate=kiro
```

### Verification (static)

```bash
head -5 .kiro/steering/artgraph.md
# ---
# inclusion: auto
# description: "Use when checking drift between specs/design/tasks/code, ..."
# ---
```

### Verification (Kiro IDE)

Kiro IDE を起動し、artgraph と無関係なファイル (例: README.md) を開いて編集する → context にステアリングが入らないことを確認 (Kiro の context inspector で観察)。
次に「artgraph で check」と入力 → ステアリングが injection される。

### Success criteria

- SC-006: Kiro steering が無関連作業時に注入されない

---

## US6: Plugin としての並行配布

**実装後 (P2 完了時) に検証**

### Setup

```bash
# artgraph repo に .claude-plugin が配備済の状態
cd /path/to/skills-expansion
test -f .claude-plugin/marketplace.json
test -f .claude-plugin/plugin.json
test -f hooks/hooks.json

# 別ディレクトリで検証
mkdir -p /tmp/aw-us6-target && cd /tmp/aw-us6-target
git init
```

### Test (Claude Code)

```
/plugin marketplace add ShintaroMorimoto/artgraph
/plugin install artgraph@artgraph-marketplace
```

### Expected

```bash
ls -la ~/.claude/plugins/cache/*/skills/artgraph-*
# 7 skills が存在
ls -la ~/.claude/plugins/cache/*/hooks/hooks.json
# Stop hook 同梱
```

### Source-of-truth 検証 (SC-004)

```bash
cd /path/to/skills-expansion
# Skill description を 1 行編集
sed -i 's/Use when planning/Use when planning or scoping/' templates/skills/artgraph-plan/SKILL.md
git commit -am 'tweak description'

# Plugin 経由で update
# (Claude Code: /plugin update artgraph)
grep "Use when planning or scoping" ~/.claude/plugins/cache/*/skills/artgraph-plan/SKILL.md
# 反映あり

# npm 経由でも反映
cd /tmp/aw-us6-target
npm install -D /path/to/skills-expansion
rm -rf .claude/skills
npx artgraph init --with-skills
grep "Use when planning or scoping" .claude/skills/artgraph-plan/SKILL.md
# 反映あり
```

### CI 検証

```bash
cd /path/to/skills-expansion
claude plugin validate .   # 公式 validator pass
pnpm test                  # tests/plugin-manifest.test.ts pass
```

---

## US7: Spec Kit ワークフローへの組み込み

**実装後 (P3 完了時) に検証**

### Setup

```bash
mkdir -p /tmp/aw-us7 && cd /tmp/aw-us7
specify init --here --ai claude  # Spec Kit v0.11.9+ で実行
echo '{"name":"aw-us7","type":"module"}' > package.json
npm install -D /path/to/skills-expansion
npx artgraph init --with-skills --integrate=speckit
```

### Test (Claude Code)

通常の Spec Kit flow を回す:
```
/speckit.specify "Add login feature"
/speckit.plan
/speckit.tasks
```

### Expected

`/speckit.tasks` の完了時に **stdout に `ARTGRAPH: {"reconciled": N, "drift": M}` の行が表示される** ことを目視確認。

エージェントの応答内に「Reconciled N nodes, M drifts were resolved」相当の summary が含まれる。

```bash
# 静的検証
grep "ARTGRAPH:" .specify/extensions/artgraph/commands/artgraph.scan-reconcile.md
# emit 指示が含まれている

grep "Troubleshooting" .specify/extensions/artgraph/README.md
# fallback ドキュメントあり
```

### 20-trial smoke test (SC-005)

```bash
for i in $(seq 1 20); do
  # 簡略化された task 実行スクリプト
  bash scripts/smoke-speckit-tasks.sh && echo "trial $i: ok"
done | grep -c "ok"
# 期待: >= 19 (95% pass rate)
```

(`scripts/smoke-speckit-tasks.sh` は P3 で追加する E2E ヘルパー)

---

## US8: Kiro Smart Hook と OpenSpec 統合

**実装後 (P3 完了時) に検証**

### Test A: Kiro Smart Hook

```bash
mkdir -p /tmp/aw-us8a && cd /tmp/aw-us8a
git init && echo '{"name":"aw-us8a","type":"module"}' > package.json
mkdir -p .kiro/steering
npm install -D /path/to/skills-expansion
npx artgraph integrate kiro --with-hooks
```

### Expected A

```bash
test -f .kiro/hooks/artgraph-verify.json
cat .kiro/hooks/artgraph-verify.json
# Smart Hook config (after_save → npx artgraph verify --diff)
```

### Test B: OpenSpec 統合

```bash
mkdir -p /tmp/aw-us8b && cd /tmp/aw-us8b
git init && echo '{"name":"aw-us8b","type":"module"}' > package.json
mkdir -p openspec/specs openspec/changes openspec/schemas
echo '# Test spec' > openspec/specs/test.md
npm install -D /path/to/skills-expansion
npx artgraph init --with-skills
npx artgraph integrate openspec
```

### Expected B

```bash
test -f openspec/schemas/artgraph/schema.yaml
ls openspec/schemas/artgraph/templates/
# apply-verify.md 等が存在
```

### Test C: OpenSpec apply gate

```bash
cd /tmp/aw-us8b
# 意図的な drift を作る (実装なしで spec を追加)
echo '## Requirement: Login is required' >> openspec/specs/test.md
# /opsx:propose --schema artgraph (OpenSpec slash command)
# /opsx:apply の verify step で artgraph check が走り、drift で fail
```

### Verification

```bash
# OpenSpec apply は drift で exit non-zero になる
# (OpenSpec slash command 経由なので Claude Code で目視確認)
```

### Success criteria

- SC-007: `integrate openspec` 完了 + apply gate で drift 検出

---

## US 共通 / 統合シナリオ

### CI 全体 smoke

```bash
cd /path/to/skills-expansion
pnpm test                           # 全 vitest スイート pass
pnpm test:e2e                       # E2E スイート pass
pnpm typecheck                      # tsc --noEmit pass
claude plugin validate .            # plugin manifest validator pass
```

### 配布物の同期検証

```bash
# templates/skills/artgraph-plan/SKILL.md を 1 行変更
echo "<!-- test sync -->" >> templates/skills/artgraph-plan/SKILL.md
git diff templates/skills/artgraph-plan/SKILL.md

# Plugin 経由 / npm 経由両方で同じ変更が反映されることを E2E で確認
# (SC-004 と重複、CI 自動化対象)
```

---

## チェックリスト

| US | P0 検証 | P1 検証 | P2 検証 | P3 検証 |
|----|---------|---------|---------|---------|
| US1 | ✓ (Skills + setup) | ✓ (--with-hooks --with-agent-context 統合) | — | — |
| US2 | ✓ | — | — | — |
| US3 | ✓ | — | — | — |
| US4 | — | ✓ | — | — |
| US5 | — | ✓ | — | — |
| US6 | — | — | ✓ | — |
| US7 | — | — | — | ✓ |
| US8 | — | — | — | ✓ |

各 PR を出す前に該当 phase の US の検証を上から下まで通すこと。
