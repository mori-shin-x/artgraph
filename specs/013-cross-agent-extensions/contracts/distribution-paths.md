# Contract: Distribution Paths

**Date**: 2026-06-29 | **Spec**: [../spec.md](../spec.md)

Tier 1 5 エージェント × canonical Skills パス × agent-context パスの確定対応表。`src/agents/descriptors.ts` の table に 1:1 で対応する。

---

## 5 エージェント 配布パス table

| `--agents` 値 | エージェント | Skills 配布先 | agent-context (canonical) | wrapper file (artgraph 管理 block を持つ) |
|---|---|---|---|---|
| `claude` | Claude Code | `.claude/skills/` | `AGENTS.md` | `CLAUDE.md` |
| `codex` | Codex CLI (OpenAI) | `.agents/skills/` | `AGENTS.md` | — (ラッパーなし、AGENTS.md ネイティブ) |
| `cursor` | Cursor | `.cursor/skills/` | `AGENTS.md` | — (ラッパーなし、AGENTS.md ネイティブ) |
| `copilot` | GitHub Copilot (IDE / CLI / Coding Agent 共通) | `.github/skills/` | `AGENTS.md` | `.github/copilot-instructions.md` |
| `kiro` | Kiro | `.kiro/skills/` | `AGENTS.md` | — (ラッパーなし、AGENTS.md ネイティブ。`.kiro/steering/artgraph.md` は **別責務** = `--integrations=kiro` 担当) |

---

## 配布ファイル構造 (1 エージェントあたり)

```text
<agent_skills_path>/                       ← 例: .claude/skills/ or .agents/skills/
├── _shared/                               ← R1 の決定: 配布対象に含める
│   ├── install-check.md
│   ├── output-schema.md
│   └── package-manager.md
├── artgraph-coverage/
│   └── SKILL.md
├── artgraph-detect/
│   └── SKILL.md
├── artgraph-impact/
│   └── SKILL.md
├── artgraph-integrate/
│   └── SKILL.md
├── artgraph-plan-coverage/
│   └── SKILL.md
├── artgraph-rename/
│   └── SKILL.md
├── artgraph-setup/
│   └── SKILL.md
└── artgraph-verify/
    └── SKILL.md
```

5 エージェント分配布した場合の repo 内構造 (`--agents=claude,codex,cursor,copilot,kiro` 実行後):

```text
<repo_root>/
├── AGENTS.md                              ← canonical agent-context (artgraph セクション + ユーザー本文)
├── CLAUDE.md                              ← claude wrapper (@AGENTS.md 取り込み)
├── .claude/skills/                        ← claude Skills
├── .agents/skills/                        ← codex Skills
├── .cursor/skills/                        ← cursor Skills
├── .github/
│   ├── copilot-instructions.md            ← copilot wrapper (@AGENTS.md 取り込み)
│   └── skills/                            ← copilot Skills
└── .kiro/
    └── skills/                            ← kiro Skills
    (.kiro/steering/ は --integrations=kiro が担当、本 spec では触らない)
```

---

## ソースとの 1:1 対応 (FR-003)

`templates/skills/<rel_path>` ↔ `<agent_skills_path>/<rel_path>` がバイト一致 (sha256 等価)。すべての Tier 1 エージェントで `<rel_path>` の値は同一。

| canonical 元 | claude 配布先 | codex 配布先 | (他エージェント同様) |
|---|---|---|---|
| `templates/skills/_shared/install-check.md` | `.claude/skills/_shared/install-check.md` | `.agents/skills/_shared/install-check.md` | ... |
| `templates/skills/artgraph-impact/SKILL.md` | `.claude/skills/artgraph-impact/SKILL.md` | `.agents/skills/artgraph-impact/SKILL.md` | ... |
| (他 7 Skill + 2 shared ファイル同様) | | | |

合計 11 ファイル/エージェント (= 8 Skill SKILL.md + 3 `_shared/` 部品) → 5 エージェントで最大 55 ファイル配布。

---

## 配布対象**外** (明示)

| パス | 理由 |
|---|---|
| MCP サーバ起動 / 設定 | FR-014 で明示的にスコープ外 |
| `.claude-plugin/marketplace.json` ほか各種 plugin manifest | FR-014 で明示的にスコープ外 |
| Codex `.codex/hooks.json` / Cursor `.cursor/hooks.json` / Kiro agent hooks | FR-014 で明示的にスコープ外 |
| Claude Code `.claude/settings.json` の `hooks` ブロック (Stop / PostToolUse) | spec 012 P1 の責務 (本 spec では追加・変更しない) |
| Cursor `.cursor/rules/` / Cursor `.cursor/mcp.json` | 本 spec では生成しない (Cursor は `.cursor/skills/` + AGENTS.md で動作前提) |
| Kiro `.kiro/steering/artgraph.md` | spec 009 `KiroProvider` の責務、`--integrations=kiro` で配布 |
| Spec Kit `.specify/extensions/artgraph/` | spec 009 `SpecKitProvider` の責務、`--integrations=speckit` で配布 |
