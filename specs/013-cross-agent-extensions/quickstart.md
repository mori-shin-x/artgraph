# Quickstart — Cross-Agent Extensions

**Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

本 quickstart は **spec 013 が実装された artgraph** の動作確認手順。

- **§1 配布契約検証 (CI で自動化)** — 5 エージェント分の配布契約が満たされていることをコマンド出力で確認
- **§2 実機 smoke (人手、Tier 1 各エージェントごと)** — 各エージェントを実環境で起動し、description-trigger で artgraph Skill が発火することを確認
- **§3 doctor 動作確認** — 健全プロジェクトと意図的 drift プロジェクトの両方で doctor を実行

---

## 前提

- Node.js 20 以上 / 任意の package manager (npm / pnpm / Bun / Deno)
- `artgraph` CLI が `npx artgraph` 等で起動可能 (spec 015 で PM 非依存化済)
- 動作確認したいエージェント (任意): Claude Code / Codex CLI / Cursor / GitHub Copilot / Kiro

---

## §1. 配布契約検証 (CI 自動化対象)

### 1-1. Fresh プロジェクトに 1 エージェント配布

```bash
mkdir /tmp/artgraph-q1 && cd /tmp/artgraph-q1
npx artgraph init --agents=claude
```

**期待結果**:
- `.claude/skills/` 配下に 8 Skill ディレクトリ (`artgraph-coverage` 〜 `artgraph-verify`) + `_shared/` (3 ファイル) が出現
- `AGENTS.md` 末尾に `<!-- artgraph:begin -->` 〜 `<!-- artgraph:end -->` block (artgraph セクション)
- `CLAUDE.md` に同形式の block (artgraph セクション、`@AGENTS.md` literal を含む)
- 終了コード 0

**自動検証コマンド** (CI で実行):

```bash
test -d .claude/skills/artgraph-impact
test -f .claude/skills/_shared/install-check.md
diff -q .claude/skills/artgraph-impact/SKILL.md ../artgraph/templates/skills/artgraph-impact/SKILL.md  # ※ artgraph repo に対する path
grep -q '<!-- artgraph:begin -->' AGENTS.md
grep -q '<!-- artgraph:end -->' AGENTS.md
grep -q '@AGENTS.md' CLAUDE.md
```

### 1-2. 5 エージェント同時配布

```bash
cd /tmp/artgraph-q1
npx artgraph init --agents=claude,codex,cursor,copilot,kiro --force
```

**期待結果**:
- 5 つの canonical Skills パスすべてに同一内容で配布:
  - `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, `.kiro/skills/`
- `AGENTS.md` の artgraph block は 1 つのみ (重複なし、冪等)
- `CLAUDE.md`, `.github/copilot-instructions.md` の 2 wrapper のみ生成 (Codex/Cursor/Kiro はラッパー不要)

**自動検証**:

```bash
diff -rq .claude/skills/ .agents/skills/      # 差分ゼロ期待
diff -rq .claude/skills/ .cursor/skills/      # 差分ゼロ期待
diff -rq .claude/skills/ .github/skills/      # 差分ゼロ期待
diff -rq .claude/skills/ .kiro/skills/        # 差分ゼロ期待
test ! -f .cursor/copilot-instructions.md      # ラッパー不要のエージェントには生成しない
test -f .github/copilot-instructions.md
```

### 1-3. `--agents` 必須エラー

```bash
mkdir /tmp/artgraph-q2 && cd /tmp/artgraph-q2
npx artgraph init
```

**期待結果**:
- 非 0 終了
- stderr に 3 つの対処法 (`--agents=<list>` 指定 / `--no-skills --no-agent-context` で当該 stage off / `--minimal`) が含まれる

**自動検証**:

```bash
npx artgraph init 2> stderr.txt; echo $?    # 非 0 期待
grep -q "artgraph init --agents" stderr.txt
grep -q "no-skills" stderr.txt
grep -q "minimal" stderr.txt
```

### 1-4. 未知エージェント値エラー

```bash
cd /tmp/artgraph-q2
npx artgraph init --agents=windsurf 2> stderr.txt; echo $?    # 非 0 期待
grep -q "windsurf" stderr.txt
grep -q "claude" stderr.txt    # サポート値一覧の提示
```

### 1-5. 冪等性確認

```bash
cd /tmp/artgraph-q1
npx artgraph init --agents=claude,codex
sha1=$(find .claude .agents AGENTS.md CLAUDE.md -type f -exec cat {} \; | sha1sum)
# 2 回目は `.artgraph.json` の存在ガードを回避するため `--force` を付ける。
# canonical と一致していれば distribute() / agent-context writer は no-op
# になり、配布物の内容は変化しない (= 冪等)。
npx artgraph init --agents=claude,codex --force
sha2=$(find .claude .agents AGENTS.md CLAUDE.md -type f -exec cat {} \; | sha1sum)
test "$sha1" = "$sha2"    # 2 回目 (--force) でも内容に変化が無いこと (冪等)
```

### 1-6. `--minimal` + `--agents` 警告

```bash
cd /tmp/artgraph-q2
npx artgraph init --minimal --agents=claude 2> stderr.txt
grep -q "WARNING" stderr.txt
grep -q "minimal" stderr.txt
test ! -d .claude/skills    # 配布されないこと
```

---

## §2. 実機 smoke (人手、Tier 1 各エージェントごと)

### 2-1. Claude Code (基準エージェント、artgraph repo 内で実施)

1. artgraph repo 内で `npx artgraph init --agents=claude --force` を実行 (ドッグフーディング)。
2. Claude Code を起動。
3. 以下を順に試す:
   - "What's the impact of changing `src/init.ts:installSkills`?" → `artgraph-impact` Skill が選択され実行されることを確認
   - "Run a self-check on this branch" → `artgraph-verify` Skill が選択されることを確認
4. **合格基準**: 各プロンプトで description-trigger により対応 Skill が選ばれる (Claude Code Skills UI で確認可能)。

### 2-2. Codex CLI

1. Codex CLI を持つ環境で、別 fixture プロジェクト (`mkdir /tmp/codex-smoke && cd $_`) を作成。
2. `npx artgraph init --agents=codex` を実行。
3. Codex CLI を起動 (例: `codex`)。
4. プロンプト: `What artgraph skills are available?` → Skill list に `artgraph-impact` 等が表示されること。
5. プロンプト: `Show coverage for FR-001` → `artgraph-coverage` Skill が起動すること。
6. **合格基準**: Codex CLI が `.agents/skills/<name>/SKILL.md` を発見し、description-trigger で適切な Skill を選択する。

### 2-3. Cursor

1. Cursor IDE を持つ環境で fixture プロジェクトを作成。
2. `artgraph init --agents=cursor` を実行。
3. Cursor を起動、AI Chat または Agent モードを開く。
4. プロンプト: `Use artgraph to find requirements impacted by editing src/X.ts` → `artgraph-impact` が選択されること。
5. **合格基準**: Cursor が `.cursor/skills/` を発見し、Skills として認識する。

### 2-4. GitHub Copilot (3 surface)

#### 2-4a. Copilot IDE (VS Code)

1. fixture プロジェクトで `artgraph init --agents=copilot` を実行。
2. VS Code で開き、Copilot Chat を起動。
3. プロンプト: `What artgraph skills are configured for this repo?` → `.github/skills/` の Skills が発見されること。
4. プロンプト: `Run impact analysis` → `artgraph-impact` が選ばれること。

#### 2-4b. Copilot CLI

1. `gh copilot` または `copilot` CLI で fixture プロジェクト内から起動。
2. `What's the artgraph workflow?` → `.github/copilot-instructions.md` + AGENTS.md が読み込まれていること。

#### 2-4c. Copilot Coding Agent (cloud)

1. fixture を push し、GitHub Issue を Copilot に assign。
2. 生成された draft PR で `AGENTS.md` の artgraph セクションが context として参照されたか確認 (PR の Copilot ログ)。

**合格基準 (2-4 全体)**: 3 surface のいずれでも artgraph Skills と AGENTS.md が読み込まれる。

### 2-5. Kiro

1. Kiro IDE を持つ環境で fixture プロジェクトを作成。
2. `artgraph init --agents=kiro` を実行。
3. Kiro を起動、Skills パネルで `artgraph-*` が表示されることを確認。
4. プロンプト: `Find requirements impacted by this file` → `artgraph-impact` が description-trigger で選ばれること。
5. **合格基準**: Kiro が `.kiro/skills/` を発見し、description-trigger で artgraph Skill を選ぶ。

---

## §3. `artgraph doctor` 動作確認

### 3-1. 健全プロジェクト

```bash
cd /tmp/artgraph-q1
npx artgraph init --agents=claude,codex --force
npx artgraph doctor
echo $?    # 0 期待
```

**期待出力 (text)**:
```text
artgraph doctor — Tier 1 distribution health check
[claude] .claude/skills/      14 pass
[codex]  .agents/skills/      14 pass
AGENTS.md  ✓ marker block intact
Summary: 28 pass, 0 fail
```

### 3-2. JSON 出力

```bash
npx artgraph doctor --format json | jq '.summary'
# 期待: {"totalFindings": N, "passCount": N, "failCount": 0, "agents": ["claude","codex"]}
```

### 3-3. drift を作って FAIL を確認

```bash
echo "// tampered" >> .agents/skills/artgraph-verify/SKILL.md
npx artgraph doctor; echo $?
# 期待: 非 0 終了、出力に "skill-file-drift" と該当 path
```

```bash
npx artgraph doctor --format json | jq '.findings[] | select(.severity=="fail")'
# 期待: kind=skill-file-drift, path=.agents/skills/artgraph-verify/SKILL.md, expected/actual に sha256 が入る
```

### 3-4. wrapper の `@AGENTS.md` 削除を検出

```bash
# CLAUDE.md の artgraph block から @AGENTS.md 行を削除して保存
sed -i '/@AGENTS.md/d' CLAUDE.md
npx artgraph doctor; echo $?
# 期待: 非 0 終了、wrapper-no-import finding
```

### 3-5. 配布が 1 件もないプロジェクト

```bash
mkdir /tmp/artgraph-q3 && cd /tmp/artgraph-q3
npx artgraph doctor
echo $?    # 0 期待 (異常扱いしない)
# 出力: "No Tier 1 distribution detected. Run `artgraph init --agents=<list>` to set up."
```

### 3-6. 余計なファイル (extraneous-file) を検出

```bash
cd /tmp/artgraph-q1
# canonical な artgraph Skill dir (例: artgraph-impact/) の内側に
# canonical に無いファイルがあれば extraneous-file として報告される。
echo "leftover from older artgraph version" > .claude/skills/artgraph-impact/leftover.md
npx artgraph doctor; echo $?
# 期待: 非 0 終了、extraneous-file finding、path=.claude/skills/artgraph-impact/leftover.md
```

**スコープ補足 (FR-011 (d))**:
doctor の `extraneous-file` 判定は **artgraph が canonical で書き出す top-level dir
(例: `artgraph-impact/`, `_shared/`) の配下** に限定される。`<agent_skills_path>/`
直下に置かれた非 artgraph 由来の dir (例: `.claude/skills/speckit-implement/SKILL.md`
のような他ツールの Skills) は対象外で、警告も出さない。

---

## §4. 受け入れシナリオ vs spec の対応

| Quickstart 節 | spec User Story Acceptance Scenario | spec FR / SC |
|---|---|---|
| 1-1 | US1 A-1, A-5 | FR-003, SC-001 |
| 1-2 | US1 A-1〜A-5, US2 | FR-003, SC-002 |
| 1-3 | Edge Case `--agents` 未指定 | FR-002, SC-006 |
| 1-4 | Edge Case 未知エージェント | FR-001 |
| 1-5 | US2 Acceptance 3 | FR-009, SC-004 |
| 1-6 | Edge Case `--minimal` + `--agents` 併用 | FR-013 |
| 2-1〜2-5 | US1 Acceptance B (実機 smoke) | SC-008 (ドッグフーディング, claude 限定) |
| 3-1, 3-2 | US4 Acceptance 1 | FR-011, SC-005 |
| 3-3 | US4 Acceptance 2 | FR-011, FR-012, SC-005 |
| 3-4 | US4 Acceptance 3 | FR-011, SC-005 |
| 3-5 | US4 Acceptance 4 + Edge Case "doctor 実行前に init 未実施" | FR-011 |
| 3-6 | FR-011 (d) extraneous-file 検出 | FR-011 |

---

## §5. Phase 2 (tasks.md) 着手前の Plan 段階確認事項

- [x] Phase 0 research.md 完了 (NEEDS CLARIFICATION 0 件)
- [x] data-model.md 完了 (エンティティ 5 件 + 不変条件)
- [x] contracts/ 完了 (cli-flags, distribution-paths, agent-context-format, doctor-output)
- [x] quickstart.md 完了 (本ファイル)
- [x] Constitution Check Phase 1 後再評価 → 違反なし (plan.md 参照)
- [ ] `/speckit-tasks` で Phase 2 を生成 (next step)
