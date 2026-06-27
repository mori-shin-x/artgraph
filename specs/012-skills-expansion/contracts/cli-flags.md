# Contract: CLI Flag Surface

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27 (revised)

本 feature で再設計される `artgraph` CLI フラグの最終形を定義する。**未リリース前提のため後方互換は意識しない**。`init` の default 挙動を agent-native 寄りに大幅変更する。

---

## `artgraph init` (重要な default 変更)

> **Note**: `--no-integrate` is the opt-out flag (independent attribute). The explicit-list form uses `--integrations <tools>` (renamed from `--integrate`) to avoid a Commander attribute collision.

### Default behavior (本 feature の核心)

`artgraph init` (フラグなし) は **full agent-native setup** を実行する:

1. `.artgraph.json` 設定生成 (既存)
2. `scan` + `reconcile` で baseline lock 作成 (既存、`--no-scan` で opt-out)
3. `templates/skills/**/SKILL.md` を `.claude/skills/` にコピー (= 旧 `--with-skills` 相当)
4. 検出された全 SDD ツール (`.specify/` → Spec Kit, `.kiro/` → Kiro) に integrate を順次実行 (= 旧 `--integrate=auto` 相当、新フラグでは `--integrations=all`)
5. `.claude/settings.json` に Stop hook (`<pkg-mgr-exec> artgraph check --gate --diff`) を merge (= 旧 `--with-hooks` 相当)
6. CLAUDE.md / AGENTS.md に artgraph スニペットを HTML マーカー境界で注入 (= 旧 `--with-agent-context` 相当)

### Opt-out フラグ

| flag | 意味 |
|------|------|
| `--minimal` | **すべての追加配備をスキップ**。`.artgraph.json` のみ生成 (旧 default 相当)。bare CLI 用途 |
| `--no-scan` | 初期 scan + reconcile をスキップ (既存) |
| `--no-skills` | Skills コピーをスキップ |
| `--no-integrate` | SDD ツール統合をスキップ |
| `--no-hooks` | `.claude/settings.json` merge をスキップ |
| `--no-agent-context` | CLAUDE.md / AGENTS.md 注入をスキップ |

### Opt-in フラグ (`--minimal` 後の部分配備用)

| flag | 意味 |
|------|------|
| `--with-skills` | `--minimal` モードに Skills コピーを追加 |
| `--with-integrate` (または `--integrations <csv>`) | SDD 統合を追加 (csv で個別指定可) |
| `--with-hooks` | Stop hook merge を追加 |
| `--with-agent-context` | agent context スニペット注入を追加 |
| `--integrations=all` | 検出全 SDD ツール統合 (sentinel `all`; default モードで既に実行されるが、`--minimal --with-integrate` 時に明示する場合に使用) |

### その他既存フラグ (変更なし)

| flag | type | default | 説明 |
|------|------|---------|------|
| `--force` | boolean | false | 既存 `.artgraph.json` を上書き |
| `--integrate-gate` / `--no-integrate-gate` | boolean | true | 統合配備で `--gate` モードを有効化するか |
| `--format <json\|text>` | string | text | 出力形式 |

### Examples

```bash
# default: agent-native full setup
artgraph init

# bare config only
artgraph init --minimal

# default minus hooks (= 既存 settings.json を触りたくない)
artgraph init --no-hooks

# bare + skills のみ
artgraph init --minimal --with-skills

# scan しない以外は default
artgraph init --no-scan
```

### `artgraph-setup` Skill が組み立てる典型コマンド

```bash
# Skill 内で package manager を検出して構築
# (npm の例)
npm install -D artgraph
npx artgraph init

# (pnpm の例)
pnpm add -D artgraph
pnpm exec artgraph init

# (bun の例)
bun install -D artgraph
bunx artgraph init

# (deno の例)
deno add npm:artgraph
deno run -A npm:artgraph/cli init
```

`init` 単独で full setup が走るため、Skill は install + `init` の 2 コマンド (実質 1 行) で完結する。

### exit code

| 状況 | exit code |
|------|-----------|
| 正常 (full setup 成功 / `--minimal` 成功) | 0 |
| 一般エラー (引数不正、書込失敗等) | 1 |
| Stop hook 衝突 (既存 hook あり) | 1 (警告 + 手動マージ手順 stderr 出力、ユーザーデータ保護) |
| いずれかの statement step が失敗 (例: integrate 配備失敗、agent-context 注入失敗) | 1 (失敗したステップ以降は skip、stderr に詳細) |

---

## `artgraph integrate`

### 既存サブコマンド (変更なし)

| invocation | 説明 |
|------------|------|
| `artgraph integrate list` | 利用可能 provider 一覧と detect/installed 状況を出力 |
| `artgraph integrate <tool>` | 指定 tool 用配備物を配置 |
| `artgraph integrate <tool> --gate` | `--gate` モード (Spec Kit の before_implement hook 等、ゲート用配備物を含めて配置) |
| `artgraph integrate <tool> --force` | 既存配備物を上書きして再配置 |
| `artgraph integrate <tool> --uninstall` | 配備物を撤去 |
| `artgraph integrate <tool> --format <json\|text>` | 出力形式 |

### 利用可能 tool 値

| tool | 状態 |
|------|------|
| `speckit` | 既存サポート |
| `kiro` | 既存サポート |
| ~~`openspec`~~ | **本 spec 対象外** ([issue #25](https://github.com/ShintaroMorimoto/artgraph/issues/25) で別 spec) |

### Provider 別の新規 オプション

| flag | provider 対象 | 説明 | Phase |
|------|---------------|------|-------|
| `--with-hooks` | `kiro` のみ | `.kiro/hooks/artgraph-verify.json` Smart Hook テンプレを配備 (`after_save` で `artgraph verify --diff`) | **P3** (FR-024) |

### `--gate` の意味 (provider 別)

| provider | `--gate` で配備される追加物 |
|----------|----------------------------|
| `speckit` | `commands/artgraph.check-gate.md` + `extension.yml` の `hooks.before_implement` |
| `kiro` | (現状特になし。steering 本文に gate 案内を含むのみ) |

### `artgraph integrate list` 出力

text 形式:
```text
Available integrations:
  speckit    [detected] [not installed]
  kiro       [detected] [installed]
```

JSON 形式:
```json
{
  "providers": [
    { "id": "speckit", "detected": true, "installed": false },
    { "id": "kiro", "detected": true, "installed": true }
  ]
}
```

### exit code

| 状況 | exit code |
|------|-----------|
| 正常 (配備成功 / no-op の auto integrate) | 0 |
| 一般エラー (引数不正、tool 名不正、書込失敗等) | 1 |
| 既存ファイルとの衝突 (`--force` なしで `isInstalled()` true) | 1 (再実行は `--force` を促す) |

---

## 検証

| 検証項目 | テストファイル | Phase |
|----------|----------------|-------|
| `init` (フラグなし) で全 default 配備が動く | `tests/init.test.ts` | P0 |
| `init --minimal` が bare config のみ生成 | `tests/init.test.ts` | P0 |
| 個別 `--no-*` フラグの opt-out 動作 | `tests/init.test.ts` | P0 |
| `--minimal --with-skills` 等の部分 opt-in | `tests/init.test.ts` | P0 |
| `init` の Stop hook merge が `settings-merge.md` 規約に従う | `tests/hooks-merge.test.ts` | P1 |
| `init` の agent-context 注入がべき等 | `tests/agent-context-injection.test.ts` | P1 |
| `integrate kiro --with-hooks` で Smart Hook 配備 | `tests/integrate-cli.test.ts` | P3 |
