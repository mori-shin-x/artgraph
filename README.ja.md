# artgraph

[English](./README.md) | **日本語**

[![CI](https://github.com/mori-shin-x/artgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/mori-shin-x/artgraph/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/artgraph.svg)](https://www.npmjs.com/package/artgraph)
[![npm downloads](https://img.shields.io/npm/dm/artgraph.svg)](https://www.npmjs.com/package/artgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**AI コーディングエージェント向けの決定的な spec-to-code コンテキスト — 要件・ドキュメント・コード・テストを一つのグラフでつなぐ。**

artgraph は、仕様書の要件 ID を、それを実装するコード（`@impl` タグ）と、それを検証するテストに結びつけるグラフを構築します。そのうえで、**ドリフト**（仕様は変わったのにコード/テストが追従していない）、**孤立**、**未カバー**の要件を検出します。エージェントの会話中に Skills が発火し、エージェントのターン終了時に Stop フックが発火し、Spec Kit / Kiro のワークフローチェックポイントで SDD ツールフックが発火します — ドリフトは人間があとから `check` を回すのではなく、エージェント自身が検知します。

## 30秒で試すタグゼロスタート

既存の TypeScript リポジトリがありますか？ **仕様書も `@impl` タグも設定ファイルも不要**で、3コマンドでインパクト解析を試せます:

<!-- Regenerate with: pnpm demo (build + demo:record + demo:svg) — see scripts/record-tag-zero-demo.mjs -->
<p align="center">
  <img src="./docs/demo/tag-zero.svg" alt="30秒タグゼロデモ: brownfield TS リポジトリで artgraph init のあとに artgraph impact --diff" />
</p>

```bash
pnpm dlx artgraph init             # brownfield 対応・仕様書不要
# ... ファイルを編集 ...
pnpm dlx artgraph impact --diff    # → TS の import グラフから影響ファイルを出力
```

`impact --diff` は決定的な TypeScript の import グラフをたどるので、どんな TS リポジトリでも初日から動きます。仕様書、`@impl` タグ、ドリフト検出はオプトインで、プロジェクトのトレーサビリティ要求が高まるにつれて段階的に追加できます。

## 既存プロジェクトのブートストラップ

コードはあるが REQ がまだ？ artgraph を理解するエージェントに頼みましょう:

```
you> src/auth 配下のトレーサビリティをブートストラップしてください。
```

`artgraph-bootstrap` Skill が `specs/auth.md` を新しい `REQ-NNN` エントリつきで提案し、対応する実装コードに `@impl REQ-NNN` タグを追加し、カバーするテストに `[REQ-NNN]` を付与します。そして `artgraph scan && artgraph check` で結果を検証します — 全部レビュー可能な単一の diff として。あなたはレビューして、調整して、コミットするだけ。

## artgraph が必要な理由

あなたのリポジトリには既にコードグラフ MCP が入っているかもしれません。それはコードを知っています。でも仕様は知りません。

コードグラフ MCP — codegraph、GitNexus、Sourcegraph MCP、その他多数 — は AI コーディングエージェントにコードベースのシンボルレベルのマップを提供します。有用ですが、マップはコードで止まります。エージェントが `signIn` を書き換えたとき、`specs/auth.md` の `REQ-001` に「email と password」と書いてあることも、`docs/auth.md` が古くなったことも、テストがまだ旧仕様を主張していることも、何も教えてくれません。

artgraph はコードの*上*のレイヤーを追加します:

- **要件・ドキュメント・コード・テストにまたがる型付きグラフ** — すべてのエッジは決定的で、AST から見えるタグ (`@impl`、`[REQ-ID]`、`req:`)、Markdown リンク、YAML フロントマター、SDD ツールの規約、TypeScript の import から得られます。グラフの中に LLM はいません。埋め込みも RAG もありません。
- **変更単位のコンテキストルーティング** — `artgraph impact --diff` は、その変更が触れる仕様書・ドキュメント・テストだけを返します。コンテキストファイル丸ごとではなく、*それ*をエージェントに渡してください。
- **CI ゲートとしてのドリフト検出** — `artgraph check --gate` は、仕様が変わったのにコード/テストが変わっていない場合にビルドを落とします。実行ごとにバイト単位で同じ出力。
- **要件 ID がプライマリキー** — 同じ `REQ-001` という文字列が、仕様書にリストされ、エージェントが `@impl` に書き、テストが角括弧で囲むもの。この単一のキーが4層グラフを結合可能にしています。

コードグラフ MCP は *「これはどこで使われている？」* に答えます。artgraph は *「これはどの要件を満たしているのか、そしていまも満たしているのか？」* に答えます。

## クイックスタート

> **対応プラットフォーム:** macOS と Linux — Windows 上の **WSL2** を含む。ネイティブ Windows (PowerShell / cmd) は非対応です。[Windows に関する注記](#windows-に関する注記)を参照してください。

```bash
# パッケージマネージャは好きなものを選択可 (npm / pnpm / Bun / Deno 対応。Yarn は pnpm にフォールバック)
npm install -D artgraph && npx artgraph init --agents=claude       # エージェントを選択
# pnpm add -D artgraph && pnpm exec artgraph init --agents=claude,codex
# bun add -d artgraph && bunx artgraph init --agents=claude
# deno add npm:artgraph && deno run -A npm:artgraph/cli init --agents=claude
```

`artgraph init` は完全なセットアップを実行します: `.artgraph.json` の設定 + 初回スキャン + クロスエージェント Skills 配布 + 検出された SDD ツールの自動統合 + Stop フック + `AGENTS.md` スニペット。設定ファイルだけが欲しい場合は `--minimal`、特定の段階をスキップしたい場合は `--no-skills` / `--no-agent-context` / `--no-integrate` / `--no-hooks` のいずれかを指定してください。フラグの完全なリストは [docs/commands.md#artgraph-init](./docs/commands.md#artgraph-init) を参照。

**Claude Code をお使いなら:** 手動インストールは丸ごとスキップできます — `/artgraph-setup` と打てば、Skill があなたのパッケージマネージャを検出し、artgraph をインストールし、`init` まで1ターンで済ませます。

### Tier 1 クロスエージェント配布

`--agents=<list>` は、同一の canonical な SKILL.md セット (6 個の Skills + 3 個の `_shared/` フラグメント) を、各エージェントのネイティブな検出パスに配布します。`AGENTS.md` が canonical なエージェントコンテキスト本文であり、エージェントごとのラッパは `@AGENTS.md` の import 行だけを含みます。

| `--agents` の値 | エージェント | Skills パス | ラッパファイル |
| --- | --- | --- | --- |
| `claude`   | Claude Code | `.claude/skills/`  | `CLAUDE.md` |
| `codex`    | Codex CLI (OpenAI) | `.agents/skills/`  | — (AGENTS.md ネイティブ) |
| `cursor`   | Cursor | `.cursor/skills/`  | — (AGENTS.md ネイティブ) |
| `copilot`  | GitHub Copilot | `.github/skills/`  | `.github/copilot-instructions.md` |
| `kiro`     | Kiro | `.kiro/skills/`    | — (`artgraph integrate kiro` 経由で `.kiro/steering/artgraph.md`) |

> 上記5つのエージェントがサポート範囲の全体です — artgraph は v0.x では Tier 1 を超えて拡張する予定はありません。[docs/architecture.md §8 Support Scope](./docs/architecture.md#8-support-scope) を参照。

### Windows に関する注記

ネイティブ Windows (PowerShell / cmd) は非対応です。artgraph は **WSL2** 内で実行してください — サポートされているすべてのパッケージマネージャと Tier 1 エージェントが動作します。Git Bash は未検証です。ネイティブ Windows でチームメイトがリポジトリをチェックアウトする際の CRLF / `.gitattributes` の詳細は [docs/getting-started.md#windows](./docs/getting-started.md#windows) を参照してください。

## エージェントループの動作

インストール後、artgraph は3つのポイントでエージェントのランタイムに接続され、あなたが `artgraph check` を自分で打つことはほぼなくなります:

1. **編集中 (Skills)** — エージェントが編集している最中に、`artgraph-impact` と `artgraph-plan-coverage` がエージェントの判断で発火し、提案された変更がどの REQ に触れるかを *変更が着地する前に* 明らかにします。
2. **ターン完了時 (Stop フック)** — Claude Code が `Stop` に達すると、`.claude/settings.json` のフックが `artgraph check --diff` を実行し、ドリフトが検出されればターンをブロックします。他の Tier 1 エージェントも、ランタイムがサポートする範囲で同様のフック形状が存在します。
3. **SDD チェックポイント** — Spec Kit または Kiro がインストールされている場合、`artgraph integrate` が `after_tasks` / `after_implement` (およびオプトインの `before_implement --gate`) を SDD ワークフローに接続します。`tasks.md` / `plan.md` の変更が、あとでまとめてではなく、適切なタイミングでチェックされます。

すべてのフックは同じグラフに対する `artgraph check` に帰着し、`--diff` は `.trace.lock` と比較します。ループの中に LLM はいません。

## エンドツーエンド: 仕様 → `@impl` → `check`

```bash
# 1. 要件を書く
mkdir -p specs && cat > specs/auth.md <<'EOF'
- REQ-001: Users can sign in with email and password.
EOF

# 2. 実装にタグを打つ
cat > src/auth.ts <<'EOF'
// @impl REQ-001
export function signIn(email: string, password: string) { /* … */ }
EOF

# 3. テストにタグを打つ
cat > tests/auth.test.ts <<'EOF'
import { describe, it } from "vitest";
describe("auth", () => {
  it("[REQ-001] accepts non-empty credentials", () => { /* … */ });
});
EOF

# 4. ベースラインをスナップショットし、仕様書を変えてドリフトを浮かび上がらせる
artgraph reconcile
sed -i 's/email and password\./email, password, and TOTP./' specs/auth.md
artgraph check
```

```
DRIFT:
  REQ-001 (req)
  doc:auth.md (doc)
COVERAGE:
  REQ-001: verified
```

このフローを実際に動かせるコピーが [`examples/basic/`](./examples/basic) にあります。

## Spec Kit + artgraph でのターンの例

`artgraph-plan-coverage` Skill が組み込まれた状態で、`/speckit-tasks` のターンがどう見えるか:

```
you> /speckit-tasks

<Spec Kit が T001, T002 で REQ-003, REQ-004 を指す tasks.md を生成>
<Stop → フックが artgraph check --diff を実行 → クリーン>
<tasks.md が変わったので artgraph-plan-coverage が発火>

agent> tasks.md には Files: src/auth.ts が列挙されていますが、このファイルは
       REQ-001 と REQ-002 も実装しており、どちらも tasks.md / plan.md /
       spec.md からは参照されていません。次のどれにしますか？
       (a) REQ-001/002 のタスクを追加、(b) src/auth.ts のスコープから除外、
       (c) 受け入れてそのまま進む
```

*どの* REQ が言及されていないか、*なぜ* 到達可能だったかは、変更ファイルに対する `artgraph plan-coverage` の出力から来ます。グラフそのものについて LLM は推論していません — CLI の決定的な出力だけです。

## Skills

artgraph は CLI をエージェントのワークフローに接続する 6 つの Skills を同梱しています。`--agents=<list>` で選ばれたすべてのエージェントに配布されます。

| Skill                    | 入力モード    | 発火するタイミング                                                                                                     |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `artgraph-setup`         | n/a           | ユーザーが artgraph をインストール/セットアップしたい、または artgraph のあとに追加された SDD ツールを組み込みたいとき |
| `artgraph-bootstrap`     | n/a           | ユーザーが既存の未タグ (または部分的にタグ済み) プロジェクトにブートストラップ/コールドスタート/初期 REQ 投入をしたいとき |
| `artgraph-impact`        | file + symbol | エージェントが変更を提案し、それが触れる REQ / ドキュメント / テストを知る必要があるとき (ファイルパスまたは `path:symbol`) |
| `artgraph-plan-coverage` | file + symbol | `tasks.md` / `plan.md` が変わった。`Files:` から到達可能だが言及されていない REQ を逆監査                          |
| `artgraph-verify`        | n/a           | 実装完了。コードレビュー前に `artgraph check --diff` で自己検証                                                     |
| `artgraph-rename`        | n/a           | ユーザーが REQ ID をリネーム/分割/マージしたいとき                                                                  |

`file + symbol` の Skills は、`src/auth.ts` (ファイル単位) または `src/auth.ts:validateToken` (シンボル単位) のいずれかを受け付けます。シンボル単位の入力には、`.artgraph.json` を `"mode": "symbol"` に設定し、グラフを再スキャンする必要があります — トレードオフと `impactReqs` / `originReqs` の二軸ドリフトガイドについては [docs/skills-guide.md#file-mode-vs-symbol-mode](./docs/skills-guide.md#file-mode-vs-symbol-mode) を参照。

## SDD ツール統合

`artgraph integrate` は scan / reconcile / check のループを、あなたが既に使っている SDD ツールに接続します。組み込みの対象は Spec Kit (`.specify/extensions/artgraph/` に `after_tasks` / `after_implement` + オプションの `before_implement --gate`) と Kiro (`.kiro/steering/artgraph.md`) です。

```bash
artgraph integrate speckit          # べき等 — .specify/ にフック
artgraph integrate speckit --gate   # before_implement ゲートを追加
artgraph integrate kiro             # .kiro/steering/artgraph.md を書く
artgraph integrate list             # ツールごとの検出/インストール状況
```

`artgraph init` は検出されたすべての SDD ツールをデフォルトで自動統合します (Spec Kit には `before_implement` ゲートフックが入ります。スキップしたい場合は `--no-integrate` を渡してください)。動く例は [`examples/speckit-integration/`](./examples/speckit-integration) と [`examples/kiro-integration/`](./examples/kiro-integration) にあります。詳細は [docs/sdd-integration.md](./docs/sdd-integration.md) を参照。

## 参照の書き方

| アーティファクト        | 参照の形式                                       |
| ----------------------- | ----------------------------------------------- |
| 仕様書のリスト項目      | `- REQ-001: description`                        |
| 仕様書の見出し (Kiro)   | `### Requirement 1: description`                |
| 実装                    | `// @impl REQ-001`                              |
| テスト                  | `it("[REQ-001] …")` または `// req: "REQ-001"`  |
| ドキュメントの関連      | フロントマター `artgraph.depends_on` / `derives_from`、kiro / spec-kit のファイル名規約から推論、またはインラインの `[text](./other.md)` リンク |

カスタム文法は `.artgraph.json` の `reqPatterns` で設定可能です — [docs/configuration.md](./docs/configuration.md) を参照。

## コマンド

| コマンド                 | 目的                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `artgraph init`          | agent-native な完全セットアップ: 設定 + スキャン + Skills + SDD 統合 + Stop フック + エージェントコンテキスト |
| `artgraph scan`          | グラフを構築し件数を出力 (`--serve` / `--output` でインタラクティブ HTML としてレンダリング)   |
| `artgraph check`         | ドリフト / 孤立 / 未カバーを報告 (`--gate` でフックを落とせる)                                 |
| `artgraph impact`        | ファイル単位の順方向インパクト (ファイルパス / `--diff`)                                       |
| `artgraph plan-coverage` | `tasks.md` の `Files:` から暗黙の REQ インパクトを検出                                         |
| `artgraph reconcile`     | 現在のグラフから `.trace.lock` を再構築                                                        |
| `artgraph rename`        | REQ ID のリネーム / 分割 / マージ                                                              |
| `artgraph integrate`     | artgraph を既存の SDD ツール (Spec Kit / Kiro) に接続                                          |
| `artgraph doctor`        | Tier 1 クロスエージェント配布を診断                                                            |

すべてのフラグの詳細リファレンス、`scan --serve`、`doctor` の finding 分類、`rename` の split/merge の注意点については [docs/commands.md](./docs/commands.md) を参照してください。

## ドキュメント

- [Getting Started](./docs/getting-started.md) — Windows CRLF、Skills のコミット、Stop フックのトラブルシューティング
- [Configuration](./docs/configuration.md) — `reqPatterns`、`docGraph`、`taskConventions`、エッジ provenance
- [Commands](./docs/commands.md) — CLI の完全リファレンス
- [SDD Tool Integration](./docs/sdd-integration.md) — Spec Kit / Kiro の詳細
- [Skills Guide](./docs/skills-guide.md) — file モード vs symbol モード、Skill のカスタマイズ
- [Architecture](./docs/architecture.md) — 設計判断とポジショニング

リポジトリ: <https://github.com/mori-shin-x/artgraph>。artgraph 自体の開発については [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。リリース履歴は [CHANGELOG.md](./CHANGELOG.md) にあります。

## 動作要件

- Node.js ≥ 22
- macOS または Linux (Windows の場合は WSL2)
- 1 つ以上の Tier 1 エージェント: Claude Code、Codex CLI、Cursor、GitHub Copilot、または Kiro

## ライセンス

MIT

---

> **注記**: このドキュメントは英語版 [README.md](./README.md) の翻訳です。最新の情報や不整合がある場合は英語版が正となります。翻訳の改善提案は Issue や Pull Request で歓迎します。
