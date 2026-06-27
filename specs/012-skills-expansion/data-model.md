# Phase 1: Data Model

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)

本 feature は配布物・integration 層を扱うため、データモデルは「永続化される構造化エンティティ」というよりも「ファイルとして配布される宣言的成果物の型」として記述する。

各エンティティは [contracts/](./contracts/) 内の対応する schema 文書で構文を厳密化する。

---

## E1. Skill (Claude Code Skill)

**役割**: ユーザー発話に対する Claude Code エージェントの動作手順書。description マッチで自動発火 (model invocation) されるか、`/skill-name` で明示発火される。

**配置**: `templates/skills/<slug>/SKILL.md` (ディレクトリ形式)。npm 配布時は `init --with-skills` で `.claude/skills/<slug>/SKILL.md` にコピー、Plugin 配布時は `.claude-plugin/plugin.json#skills` から repo 内 path 参照される。

**フィールド (YAML frontmatter)**:

| field | type | required | 用途 |
|-------|------|----------|------|
| `name` | string (kebab-case) | yes | Skill ID (例: `artgraph-setup`)。ディレクトリ名と一致 |
| `description` | string (≤ 1024 chars) | yes | model invocation triggering の唯一信号。R10 の "third person + what + when + push" 規約に準拠 |
| `allowed-tools` | string[] | optional | Bash 等の pre-approve。例: `["Bash(npx artgraph *)", "Bash(artgraph *)"]`。setup Skill のみ `Bash(npm install*)` を追加 |
| `user-invocable` | boolean | optional | デフォルト true。明示的に `false` にしない限り `/skill-name` 発火可 |
| `disable-model-invocation` | boolean | optional | デフォルト false。description マッチ発火を禁止する場合のみ true |

**本文 (markdown body)**: 100 行以下。共通 install 確認は `_shared/install-check.md` への markdown link で誘導し、各 Skill 固有の手順のみ記述。複雑な手順 (例: `artgraph-rename` の split/merge) は `references/<topic>.md` に切り出して progressive disclosure する。

**バリエーション** (全 Skill **英語で記述** — FR-029):

| Skill | 説明 |
|-------|------|
| `artgraph-setup` | 新規プロジェクトに artgraph + Skills + Hooks + 統合を一括配備。Package manager 検出ロジック (E6) を持つ |
| `artgraph-integrate` | 既存 artgraph 環境に SDD ツール統合を後付け |
| `artgraph-detect` | artgraph の導入状況・統合状況・skill 状況を要約 |
| `artgraph-impact` | (`artgraph-plan` から rename) Impact 分析を 3 入力モード (diff / 明示 target / 確認質問) で実行 — FR-025 |
| `artgraph-verify` | 実装完了時に `artgraph check --diff` を呼ぶ (既存改修) |
| `artgraph-coverage` | 進捗確認時に `artgraph coverage` を呼ぶ (既存改修) |
| `artgraph-rename` | ID リネーム/分割/統合を `artgraph rename` で行う (既存改修) |

**詳細 schema**: [contracts/skill-frontmatter.md](./contracts/skill-frontmatter.md)

---

## E2. Integration Provider

**役割**: 1 つの SDD ツール (Spec Kit / Kiro / OpenSpec) に対する artgraph 統合の配備ロジックを提供する。

**配置**: `src/integrate/providers/<tool>.ts` (TS モジュール)。`src/integrate/index.ts` の `registerBuiltinProviders()` で登録される。

**インターフェース (既存 `src/integrate/providers/types.ts` 等で定義済)**:

| method | 戻り値 | 用途 |
|--------|--------|------|
| `detect()` | `Promise<boolean>` | プロジェクトルートで対象 SDD ツールが導入されているか (`.specify/` / `.kiro/` / `openspec/` の存在チェック) |
| `install(options)` | `Promise<InstallResult>` | 配備物を repo にコピー / merge する。`options.gate`, `options.force` を尊重 |
| `isInstalled()` | `Promise<boolean>` | 配備物が既に存在し schema に合致しているか |
| `uninstall()` | `Promise<UninstallResult>` | 配備物を撤去する |

**実装一覧**:

| Provider | 配備物 (install で配置されるもの) |
|----------|-----------------------------------|
| `SpecKitProvider` (既存) | `.specify/extensions/artgraph/extension.yml` + `commands/artgraph.*.md` + `README.md` (5 ファイル) + `.specify/extensions.yml` への追記 |
| `KiroProvider` (既存 + P1/P3 改修) | `.kiro/steering/artgraph.md` (frontmatter `inclusion: auto`)、`--with-hooks` 指定時 `.kiro/hooks/artgraph-verify.json` も配置 |

**`OpenSpecProvider` は本 spec 対象外** ([issue #25](https://github.com/ShintaroMorimoto/artgraph/issues/25) で別 spec として進める。理由: parser / ID 派生 / changes lifecycle 等の CLI コア改修が必要)。

**バリデーション**: 各 provider の `isInstalled()` が schema 検証 (YAML parse → 必須フィールド確認) を含む。schema 不一致は `install --force` での再配備を促す。

---

## E3. Hook Template

**役割**: Claude Code および Kiro の hooks 設定 (`.claude/settings.json` / `.kiro/hooks/*.json`) に追加される構造を再利用可能なテンプレファイルとして配置する。

**配置**:

| パス | 用途 |
|------|------|
| `templates/hooks/settings.json.template` | Claude Code 用 Stop hook (`init --with-hooks` で `.claude/settings.json` に merge) |
| `templates/hooks/pre-commit.sh.template` | husky/lefthook 利用者向け pre-commit 雛形 (任意) |
| `templates/integrate/kiro/hooks/artgraph-verify.json` | Kiro Smart Hook テンプレ (`integrate kiro --with-hooks` で `.kiro/hooks/` に配置) |

**Claude Code Stop hook の構造** (`templates/hooks/settings.json.template`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "npx artgraph check --gate --diff" }
      ]}
    ]
  }
}
```

**マージ規則** (詳細: [contracts/settings-merge.md](./contracts/settings-merge.md)):

- 既存 `.claude/settings.json` が **無い** → このテンプレで新規作成
- 既存 `settings.json` に `hooks.Stop` が **無い** → `hooks.Stop` のみ追記、他フィールドは保持
- 既存 `hooks.Stop` が **既に何か登録済** → 上書きせず警告して終了 (ユーザーに手動マージを促す)

---

## E4. Plugin Manifest

**役割**: Claude Code Plugin として artgraph を配布するためのメタデータ。

**配置**: repo root の `.claude-plugin/` ディレクトリ。

| ファイル | 用途 |
|----------|------|
| `.claude-plugin/marketplace.json` | repo 自体を marketplace として公開 (`/plugin marketplace add ShintaroMorimoto/artgraph` を可能にする) |
| `.claude-plugin/plugin.json` | plugin 単体のメタデータ。`skills` フィールドが `./templates/skills/` を指して single source of truth を維持 |
| `hooks/hooks.json` | plugin install ユーザー向けの Stop hook 同梱物 |

**スキーマ詳細**: [contracts/plugin-manifest.md](./contracts/plugin-manifest.md)

**Key constraint**: `.claude-plugin/plugin.json` の `skills` は `templates/skills/` を直接参照する (`"skills": "./templates/skills/"`)。これにより:
- npm 配布 (`init --with-skills`) は `templates/skills/*` を `.claude/skills/` にコピー
- Plugin 配布 (`/plugin install`) は Claude Code が `templates/skills/*` を `~/.claude/plugins/cache/.../skills/` にコピー
- **両配布物の skill content は同一ファイルから派生** (二重管理ゼロ)

---

## E5. Agent Context Snippet

**役割**: CLAUDE.md / AGENTS.md に注入される artgraph の使い方説明 (30 行以内)。AI エージェントが常時 context として読むため、`@impl` 文法・主要 CLI 呼出時点・Skill 配置場所を簡潔に伝える。

**配置**: `templates/agent-context/`

| ファイル | 注入先 | 用途 |
|----------|--------|------|
| `claude-md-snippet.md` | `CLAUDE.md` | Claude Code 用。Skills と Hooks の組み合わせ前提を述べる |
| `agents-md-snippet.md` | `AGENTS.md` | OpenSpec / Kiro / 他エージェント共通プロトコル |

**境界マーカー** (R3 採用):
```
<!-- artgraph: BEGIN agent context -->
... (30 行以内のスニペット) ...
<!-- artgraph: END agent context -->
```

**注入挙動 (FR-014, FR-015)**:

- ターゲットファイルが **無い** → スニペット内容で新規作成
- ターゲットに **マーカーが無い** → ファイル末尾にマーカー込みで追記
- ターゲットに **マーカーが既存** → マーカー間の内容を最新スニペットで上書き (idempotent)

---

## E6. Package Manager Detector

**役割**: `artgraph-setup` Skill が install / exec コマンドを構築する際の判定ロジック (FR-026)。Bun / Deno / pnpm / npm の 4 種を区別する (Yarn は本 spec のサポート対象外、検出時は npm fallback + 警告)。

**配置**: `templates/skills/_shared/package-manager.md` (共通参照ファイル、英語) — Skill 本文から markdown link で誘導。Skill 内に bash 検出スクリプトのサンプルも含める。

**検出順序 (高優先 → 低優先)**:

| 優先 | 検出ソース | 判定 | install / exec コマンド |
|------|-----------|------|------------------------|
| 1 | `package.json#packageManager` フィールド | semver-spec 文字列から抽出 | フィールド指定に従う (`pnpm@9.0.0` → pnpm)。Yarn 指定時は npm フォールバック |
| 2 | `bun.lockb` | Bun | `bun install -D artgraph` / `bunx artgraph` |
| 3 | `deno.json` または `deno.lock` | Deno | `deno add npm:artgraph` / `deno run -A npm:artgraph/cli` |
| 4 | `pnpm-lock.yaml` | pnpm | `pnpm add -D artgraph` / `pnpm exec artgraph` |
| 5 | `package-lock.json` | npm | `npm install -D artgraph` / `npx artgraph` |
| 6 | `yarn.lock` | **npm フォールバック + 警告** (Yarn は本 spec のサポート対象外) | `npm install -D artgraph` / `npx artgraph` + 「Yarn 検出されましたが本 spec はサポート対象外のため npm で実行します」と user に通知 |
| 7 (fallback) | lockfile なし | npm デフォルト | 同上 |

**スコープ境界**:

- 本 spec で扱う: `artgraph-setup` Skill 内の検出ロジック (最小実装)
- **スコープ外 (フォローアップ issue)**: Stop hook テンプレ / Skill 本文サンプル / README / Plugin hook の `npx artgraph` 表記の全面 generic 化

---

## エンティティ間の関係

```
┌─────────────────────────────────────────────────────────────────┐
│  Skill (E1)         ←─── 参照 (markdown link) ───→             │
│  _shared/install-check.md  output-schema.md                     │
│                                                                  │
│  ↑ 配布物                                                        │
│                                                                  │
│  templates/skills/                                              │
│       ↑                              ↑                          │
│       │ init --with-skills           │ plugin.json#skills       │
│       │ (npm 配布、ファイルコピー)    │ (Plugin 配布、cache copy) │
│       │                              │                          │
│  .claude/skills/                ~/.claude/plugins/cache/.../    │
│  (user project)                 (user global)                   │
│                                                                  │
│  Integration Provider (E2)                                       │
│       ↓ install()                                                │
│  .specify/extensions/artgraph/  .kiro/steering/artgraph.md       │
│  openspec/schemas/artgraph/                                      │
│                                                                  │
│  Hook Template (E3) ─────→ .claude/settings.json (merge)        │
│                       ─────→ .kiro/hooks/artgraph-verify.json    │
│                                                                  │
│  Plugin Manifest (E4) ────→ .claude-plugin/ (repo root)         │
│                                                                  │
│  Agent Context Snippet (E5) ─→ CLAUDE.md (marker section)       │
│                              ─→ AGENTS.md (marker section)      │
└─────────────────────────────────────────────────────────────────┘
```

**メタテスト** (Phase 1 で追加する `tests/skills-templates.test.ts` 等で検証):

- 各 Skill SKILL.md の YAML frontmatter は schema を満たす (name, description 必須等)
- SKILL.md は 100 行以下
- 共通 `_shared/install-check.md` が存在しすべての Skill から markdown link で参照されている (`grep -l "_shared/install-check" templates/skills/*/SKILL.md` が全 7 件)
- **`templates/skills/**/*.md` のすべてのファイルが英語であること** (検出: 非 ASCII 比率が threshold 以下、または明示的に日本語特有文字 (ひらがな・カタカナ・漢字 unicode block) を含まないこと) — FR-029
- Plugin Manifest の `skills` パスが repo 内に実在する
- Hook Template の JSON が parse 可能・既存 settings.json と merge 互換
- Agent Context Snippet が 30 行以下、HTML マーカーペアが対称
- Package Manager Detector が 4 fixture (npm/pnpm/bun/deno) すべてで正しい install/exec コマンド文字列を返す。追加 fixture `yarn` で npm フォールバック + 警告を返すことも確認

これらのメタテストは Phase 0 で resolve した設計判断 (R2 共通参照、R5/R6 Plugin path、R3 境界マーカー、R13 impact rename、R14 pkg mgr、R16 英語化) と直接対応する。
