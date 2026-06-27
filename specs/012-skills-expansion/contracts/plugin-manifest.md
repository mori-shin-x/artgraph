# Contract: Plugin Manifest

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27

Claude Code Plugin として artgraph を配布するための manifest の schema を定義する。

参考: [Plugins reference 公式](https://code.claude.com/docs/en/plugins-reference) / [Plugin marketplaces 公式](https://code.claude.com/docs/en/plugin-marketplaces)

---

## `.claude-plugin/plugin.json`

### Schema

```json
{
  "name": "artgraph",
  "version": "<package.json と同期>",
  "description": "Typed artifact graph for TS/JS — trace specs, docs, code, and tests bidirectionally.",
  "author": {
    "name": "ShintaroMorimoto"
  },
  "license": "MIT",
  "repository": "https://github.com/ShintaroMorimoto/artgraph",
  "skills": "./templates/skills/",
  "hooks": "./hooks/hooks.json"
}
```

### Fields

| field | required | 値 |
|-------|----------|-----|
| `name` | yes | `"artgraph"` (固定) |
| `version` | recommended | semver。`package.json#version` と同期 (CI で検証) |
| `description` | recommended | npm package description と同一 (重複ソースを許容) |
| `author` | recommended | `{ name }` のみで可 |
| `license` | recommended | `"MIT"` |
| `repository` | recommended | GitHub URL |
| `skills` | **yes (本 feature の核)** | `"./templates/skills/"` 固定。single source of truth (R6) |
| `hooks` | yes (P2 以降) | `"./hooks/hooks.json"` |

### Constraint

- `skills` は repo 内 path を直接指す (R6)。symlink は使用不可 (Claude Code の plugin cache が repo を丸ごとコピーするため)
- `name` の重複回避: Claude Code は plugin install 時に既存 plugin と name 衝突をチェックする。`artgraph` 名は npm パッケージ名と同じく予約済の扱いで、他ユーザーが marketplace で同名 plugin を配布できない (npm の name resolve と同様)

---

## `.claude-plugin/marketplace.json`

### Schema

```json
{
  "name": "artgraph-marketplace",
  "owner": {
    "name": "ShintaroMorimoto"
  },
  "plugins": [
    {
      "name": "artgraph",
      "source": "./",
      "description": "Typed artifact graph for TS/JS",
      "version": "<plugin.json と同期>"
    }
  ]
}
```

### Fields

| field | required | 値 |
|-------|----------|-----|
| `name` | yes | `"artgraph-marketplace"` (固定)。`/plugin install artgraph@artgraph-marketplace` の右辺となる |
| `owner.name` | yes | `"ShintaroMorimoto"` |
| `plugins[].name` | yes | `"artgraph"` (plugin.json と一致) |
| `plugins[].source` | yes | `"./"` (この repo 自体が plugin) |
| `plugins[].description` | recommended | 同上 |
| `plugins[].version` | recommended | plugin.json と同期 |

### Usage (ユーザー視点)

```bash
# 1. marketplace 登録
/plugin marketplace add ShintaroMorimoto/artgraph

# 2. plugin install
/plugin install artgraph@artgraph-marketplace
```

これで `~/.claude/plugins/cache/<hash>/.claude-plugin/` に repo 全体がコピーされ、`templates/skills/*` が `~/.claude/plugins/cache/<hash>/skills/` 相当として登録され、`hooks/hooks.json` の Stop hook が有効化される。

---

## `hooks/hooks.json`

### Schema

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "npx artgraph check --gate --diff" }
        ]
      }
    ]
  }
}
```

### Constraint

- `command` は `npx artgraph` で起動 (Plugin にバイナリを bundle しない)。Plugin install ユーザーは別途 `npm install -D artgraph` を実行する必要がある
  - Plugin install の前段で `artgraph-setup` Skill が `npm install` を案内する設計でカバー
  - 将来的に `bin` セクションで bundle する選択肢もあるが、本 feature では採用しない (Plugin サイズ最小化優先)
- `${CLAUDE_PLUGIN_ROOT}` 環境変数は使用しない (npm 経由 CLI を呼ぶため、plugin 内 path 参照は不要)

---

## CI 検証

P2 で追加する `tests/plugin-manifest.test.ts`:

1. `.claude-plugin/plugin.json` が valid JSON
2. `plugin.json.name === "artgraph"`
3. `plugin.json.version === package.json の version` (同期検証)
4. `plugin.json.skills` パスが repo 内に実在 (`./templates/skills/` の物理確認)
5. `plugin.json.hooks` パスが repo 内に実在 (`./hooks/hooks.json`)
6. `.claude-plugin/marketplace.json` が valid JSON
7. `marketplace.json.plugins[0].name === "artgraph"`
8. `hooks/hooks.json` の Stop hook command が `npx artgraph` で始まる
9. `.claude-plugin/plugin.json` と `marketplace.json` の version が一致

加えて GitHub Actions で **`claude plugin validate .`** (公式 validator) を実行 (FR-020):
- Plugin schema 完全性
- 安全性自動 screening (community marketplace submission 前提)

---

## Release プロセス

`package.json#version` と `plugin.json#version` / `marketplace.json#plugins[0].version` を同期する。release script (将来追加) は以下を自動化:

1. `package.json` の version bump (semver)
2. `plugin.json` と `marketplace.json` の version を `jq` で書き込み
3. `pnpm test` (vitest + plugin manifest meta test)
4. `npm publish`
5. git tag + push (marketplace 側は git tag 経由で version pinning される — 本 feature では未実装、P5 で検討)

---

## community marketplace への submission (将来 / 本 spec スコープ外)

(P5) `anthropics/claude-plugins-community` に submission する場合の手順:
1. https://claude.ai/admin-settings/directory/submissions/plugins/new から application
2. `claude plugin validate .` の通過確認
3. 安全性 screening 通過 (Anthropic 自動)
4. dailly sync で community marketplace.json に追加される

本 spec ではここまでは扱わない (artgraph repo 自身が marketplace として機能する経路のみ確立する)。
