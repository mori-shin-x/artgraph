# Contract: SKILL.md Frontmatter

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27

artgraph が配布する全 7 Skill の `SKILL.md` の YAML frontmatter を統一する。

---

## Schema

```yaml
---
name: "<kebab-case slug>"                  # required, ディレクトリ名と一致
description: "<English one-paragraph>"     # required, ≤ 1024 chars, R10 規約
allowed-tools:                              # optional, Bash pre-approve
  - "Bash(npx artgraph *)"
  - "Bash(artgraph *)"
user-invocable: true                        # optional, default true
disable-model-invocation: false             # optional, default false
---
```

### Field constraints

| field | constraint | enforcement |
|-------|------------|-------------|
| `name` | `^[a-z][a-z0-9-]*$` (kebab-case)、ディレクトリ名と一致 | `tests/skills-templates.test.ts` (P0) |
| `description` | 英語、≤ 1024 文字、"third person + what + when + push" 規約 (R10) | meta test + code review |
| `allowed-tools` | 配列、各要素は `<ToolName>(...)` 形式 | yaml schema |
| `user-invocable` | boolean、default true | yaml schema |
| `disable-model-invocation` | boolean、default false | yaml schema |

### description テンプレート (R10)

```
<Third-person verb phrase describing what>. Use when <when>. Make sure to use this skill whenever <trigger phrasing>.
```

実例:

| Skill | description |
|-------|-------------|
| `artgraph-setup` | `Installs artgraph in the current project and wires up Skills, hooks, and any detected SDD-tool integration. Use when the user asks to install / set up / add artgraph. Make sure to use this skill whenever the user mentions artgraph for the first time and \`artgraph\` CLI is not yet available.` |
| `artgraph-integrate` | `Wires artgraph into an installed SDD tool (Spec Kit / Kiro / OpenSpec). Use when the user asks to integrate, hook up, or connect artgraph with an existing SDD tool. Make sure to use this skill whenever the user mentions integrating artgraph with a Spec Kit / Kiro / OpenSpec project that already has \`artgraph\` installed.` |
| `artgraph-detect` | `Reports the current artgraph installation, integration, and Skill availability in the project. Use when the user asks whether artgraph is set up, what's installed, or what's available. Make sure to use this skill whenever the user is uncertain about the project's artgraph state.` |
| `artgraph-plan` | `Runs \`artgraph impact --diff\` to inject change-impact context before plan or design. Use when the user is about to plan, design, or scope changes. Make sure to use this skill whenever the user enters Plan mode or asks for impact analysis on a diff.` |
| `artgraph-verify` | `Runs \`artgraph check --diff\` to self-check spec/code/test consistency. Use when implementation is complete or before code review. Make sure to use this skill whenever the user reports implementation completion or asks for a consistency check.` |
| `artgraph-coverage` | `Runs \`artgraph coverage\` to show per-requirement coverage status. Use when the user asks for progress, remaining work, or what's left to test. Make sure to use this skill whenever the user is reviewing progress against a spec.` |
| `artgraph-rename` | `Performs a safe rename / split / merge of requirement IDs across spec, code, tests, and lock. Use when the user asks to rename a REQ ID, split one ID into multiple, or merge multiple IDs into one. Make sure to use this skill whenever requirement IDs are being restructured.` |

---

## 本文 (markdown body) 構造規約

### 共通項目 (全 Skill)

```markdown
## 目的
(1–3 段落)

## 実行手順

### 1. 前提確認
詳細は [_shared/install-check.md](../_shared/install-check.md) を参照。

### 2. (Skill 固有の主要ステップ)
(具体的な bash コマンドと実行手順)

### 3. (結果の処理 / コンテキスト注入 / 報告)
```

### 行数制限

- SKILL.md は **100 行以下** (FR-009)
- 100 行を超える場合は **`references/<topic>.md`** に切り出して progressive disclosure
  - 例: `templates/skills/artgraph-rename/SKILL.md` (~70 行) + `references/lifecycle-flows.md` (split/merge の細かい手順)

### 共通参照ファイル

| パス | 内容 |
|------|------|
| `templates/skills/_shared/install-check.md` | artgraph CLI の存在確認手順 (R2 採用)。各 SKILL.md が markdown link で参照 |
| `templates/skills/_shared/output-schema.md` | `artgraph impact` / `check` / `coverage` の JSON 出力スキーマ参照 (任意で参照) |

---

## メタテスト (`tests/skills-templates.test.ts`)

P0 で追加するメタテストが以下を検証する:

1. **frontmatter 必須フィールド**: 全 SKILL.md で `name` と `description` が存在
2. **`name` 一致**: frontmatter の `name` がディレクトリ名と一致
3. **description 長さ**: ≤ 1024 文字
4. **行数制限**: SKILL.md は ≤ 100 行
5. **共通参照**: 既存 4 Skill (plan/verify/coverage/rename) が `_shared/install-check.md` への markdown link を含む
6. **YAML 妥当性**: frontmatter が valid YAML
7. **`allowed-tools` 形式**: 配列要素が `<Name>(...)` パターン
8. **重複 description 禁止**: 異なる Skill 間で description 重複なし (Claude が選別できなくなるリスク)

これらを `vitest` で repo 全体を walk して検証する。

---

## 配置と配布

| 配布ルート | Skill ディレクトリ位置 |
|------------|----------------------|
| npm `init --with-skills` 配備後 (user project) | `.claude/skills/<slug>/SKILL.md` |
| Plugin install 後 (user global) | `~/.claude/plugins/cache/.../skills/<slug>/SKILL.md` |
| repo (source of truth) | `templates/skills/<slug>/SKILL.md` |

`installSkills()` (P0 改修) は repo 内 `templates/skills/` 全体 (各 Skill ディレクトリ + `_shared/`) をユーザープロジェクトの `.claude/skills/` 配下にコピーする。Plugin install 時は Claude Code が `plugin.json#skills` で指定された path を cache にコピー (同じファイルセット)。
