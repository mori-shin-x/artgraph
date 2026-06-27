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

**実装後 (P0 + P1 完了時) に検証** — 5 package manager 全部で動作確認

### Setup A: npm 環境 (`package-lock.json`)

```bash
mkdir -p /tmp/aw-us1-npm && cd /tmp/aw-us1-npm
git init
echo '{"name":"aw-us1","type":"module","scripts":{"test":"vitest"}}' > package.json
npm install   # package-lock.json を生成
mkdir -p specs src
echo '- REQ-001: Users can sign in.' > specs/auth.md
```

(Spec Kit / Kiro は意図的に **未** 導入のままにする)

### Test

Claude Code 起動 (`claude code`)、次のメッセージを送信:

```
このプロジェクトに artgraph をセットアップして
```

### Expected (npm 環境)

1. エージェントが `artgraph-setup` Skill を発火 (Skill リストに `artgraph-setup` が表示される)
2. **package manager 検出: npm** (`package-lock.json` あり)
3. ユーザー同意 (Y) で `npm install -D artgraph` が走る
4. 続けて `npx artgraph init` が走る (default で full setup)
5. SDD ツール検出ゼロ報告 (`init` の default `--integrate=auto` が no-op で正常終了)
6. 完了報告: `.artgraph.json`, `.claude/skills/artgraph-*`, `.claude/settings.json`, `CLAUDE.md` が生成
7. **`artgraph check` を実行して exit 0** がエージェントから報告される

### Verification

```bash
ls -la .artgraph.json .claude/skills/ .claude/settings.json CLAUDE.md
npx artgraph check    # exit 0
cat .claude/settings.json | jq '.hooks.Stop'   # artgraph check --gate --diff が登録
grep "artgraph: BEGIN" CLAUDE.md   # マーカー存在
```

### Setup B: Bun 環境 (`bun.lockb`)

```bash
mkdir -p /tmp/aw-us1-bun && cd /tmp/aw-us1-bun
git init
echo '{"name":"aw-us1-bun","type":"module"}' > package.json
bun install   # bun.lockb を生成
# (specs / src は省略)
```

Claude Code で同じ依頼 → エージェントが **Bun を検出**して `bun install -D artgraph` + `bunx artgraph init` を実行することを目視確認。

### Setup C, D (pnpm / Deno)

同様に `pnpm install` / `deno init` でそれぞれの lockfile を作成し、エージェントが各 package manager 対応コマンドを構築することを確認。

### Setup E (Yarn — 除外動作の確認)

`yarn install` で `yarn.lock` を作成し、エージェントが「Yarn 検出、本 spec では npm fallback します」と警告して npm 経由でセットアップを進めることを確認。

### Success criteria

- SC-001: ユーザー入力が同意 1 回のみで完結 (5 package manager 全部で)
- SC-010: 5 package manager 全部で `artgraph-setup` Skill が正常完了
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

## US3: 開発中の自然な Skill 発火 (既存 4 Skill 改修 + impact rename)

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

### Test 1: artgraph-impact の発火 (mode (a) diff)

Claude Code:
```
この変更の影響範囲を見て
```

### Expected 1

- `artgraph-impact` Skill (`artgraph-plan` から rename) が発火し、git diff があるので mode (a) `artgraph impact --diff --format json` を実行
- 影響範囲 (REQ-001 / src/auth.ts) がエージェントの context に注入される

### Test 1b: artgraph-impact の発火 (mode (b) explicit target)

diff を一旦 commit してから:

Claude Code:
```
REQ-001 を変更しようと思うんだけど、何に影響する?
```

### Expected 1b

- `artgraph-impact` Skill が発火し、ユーザー発話から `REQ-001` を抽出して mode (b) `artgraph impact REQ-001 --format json` を実行
- 影響範囲が返る (真の Plan 段階 — diff 不要)

### Test 1c: artgraph-impact の発火 (mode (c) ask)

diff も無く、target も明示されていない状態:

Claude Code:
```
impact 出して
```

### Expected 1c

- `artgraph-impact` Skill が mode (c) に入り、「どの requirement / file を起点に分析しますか?」と確認質問を返す (空振り終了しない)

### Test 2: artgraph-verify の発火

Claude Code (同じ session):
```
整合性チェックして
```

### Expected 2

- `artgraph-verify` Skill 発火
- `artgraph check --diff --format text` が走り、drift (`REQ-001` の spec hash 変更) を検出
- エージェントが drift を報告し、対処案を提示

### Test 3: 既存 Skill の DRY 化検証 + 英語化 (静的)

```bash
wc -l templates/skills/artgraph-{impact,verify,coverage,rename}/SKILL.md
# 各 100 行以下

grep -l "_shared/install-check" templates/skills/*/SKILL.md
# 7 件 (全 Skill が共通参照を持つ)

# 共通参照ファイルの存在
test -f templates/skills/_shared/install-check.md
test -f templates/skills/_shared/package-manager.md

# 英語化検証 (FR-029): 日本語特有 Unicode block を含まないこと
! grep -rPl "[\\x{3040}-\\x{309F}\\x{30A0}-\\x{30FF}\\x{4E00}-\\x{9FFF}]" templates/skills/
# (出力なしで exit 0 = OK、何か検出されたら exit 1)
```

### Success criteria

- SC-002: 既存 4 Skill が 100 行以下、install-check 重複ゼロ
- SC-003: Skill description が R10 規約に準拠 (peer review)
- FR-029: 全 Skill ファイルが英語

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
specify init --here --ai claude  # Spec Kit ≥ v0.11.0 (実測時は最新 v0.11.9 を使用)
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

## US8: Kiro Smart Hook

**実装後 (P3 完了時) に検証**

> **OpenSpec 統合は本 spec 対象外** — [issue #25](https://github.com/ShintaroMorimoto/artgraph/issues/25) ベースの別 spec (`013-openspec-support` 等) で進める。

### Test: Kiro Smart Hook 配備

```bash
mkdir -p /tmp/aw-us8 && cd /tmp/aw-us8
git init && echo '{"name":"aw-us8","type":"module"}' > package.json
mkdir -p .kiro/steering
npm install -D /path/to/skills-expansion
npx artgraph integrate kiro --with-hooks
```

### Expected

```bash
test -f .kiro/hooks/artgraph-verify.json
cat .kiro/hooks/artgraph-verify.json
# Smart Hook config (after_save → npx artgraph verify --diff)
```

### Kiro IDE での動作確認

Kiro IDE を起動し、artgraph 関連のファイル (`@impl REQ-001` を含む src/*.ts 等) を編集して保存 → Kiro エージェントの context に `artgraph verify --diff` の結果が自動注入されることを目視確認。

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
| US1 | ✓ (init default = full setup + Skills + pkg mgr 検出) | ✓ (--with-hooks --with-agent-context は default ON で確認) | — | — |
| US2 | ✓ | — | — | — |
| US3 | ✓ (impact rename + 3 mode + 英語化) | — | — | — |
| US4 | — | ✓ | — | — |
| US5 | — | ✓ | — | — |
| US6 | — | — | ✓ | — |
| US7 | — | — | — | ✓ |
| US8 | — | — | — | ✓ (Kiro Smart Hook のみ、OpenSpec は別 spec) |

各 PR を出す前に該当 phase の US の検証を上から下まで通すこと。
