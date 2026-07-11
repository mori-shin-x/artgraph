# artgraph

[English](./README.md) | **日本語**

[![CI](https://github.com/mori-shin-x/artgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/mori-shin-x/artgraph/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/artgraph.svg)](https://www.npmjs.com/package/artgraph)
[![npm downloads](https://img.shields.io/npm/dm/artgraph.svg)](https://www.npmjs.com/package/artgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**AI コーディングエージェント向けの決定的な spec-to-code コンテキスト — 要件・ドキュメント・コード・テストを一つのグラフでつなぐ。**

artgraph は、仕様書の要件 ID と、それを実装するコード（`@impl` タグ）、それを検証するテストを結びつけるグラフを構築します。そのうえで、**ドリフト**（仕様は変わったのにコード / テストが追従していない状態）、**孤立**した要件、**未カバー**の要件を検出します。エージェントの会話中には Skills が、ターン終了時には Stop フックが、Spec Kit / Kiro のワークフローのチェックポイントでは SDD ツール向けフックが発火します — 人間があとから `check` を回すのではなく、エージェント自身がドリフトに気づける仕組みです。

## タグゼロで 30 秒スタート

既存の TypeScript リポジトリさえあれば、**仕様書も `@impl` タグも設定ファイルもなし**で、3 コマンドでインパクト解析を試せます:

<!-- Regenerate with: pnpm demo (build + demo:record + demo:svg) — see scripts/record-tag-zero-demo.mjs -->
<p align="center">
  <img src="./docs/demo/tag-zero.svg" alt="30秒タグゼロデモ: brownfield TS リポジトリで artgraph init のあとに artgraph impact --diff" />
</p>

```bash
pnpm dlx artgraph init             # brownfield 対応・仕様書不要
# ... ファイルを編集 ...
pnpm dlx artgraph impact --diff    # → TS の import グラフから影響ファイルを出力
```

`impact --diff` は決定的な TypeScript の import グラフをたどるため、どんな TS リポジトリでも導入したその日から動きます。仕様書・`@impl` タグ・ドリフト検出はオプトインで、プロジェクトのトレーサビリティ要求が高まるにつれて段階的に追加していけます。

## 既存プロジェクトのブートストラップ

コードはあるけれど REQ はこれから、という場合は、artgraph を理解しているエージェントに任せてしまいましょう:

```
you> src/auth 配下のトレーサビリティをブートストラップしてください。
```

`artgraph-bootstrap` Skill が新しい `REQ-NNN` エントリつきの `specs/auth.md` を提案し、対応する実装コードに `@impl REQ-NNN` タグを付け、カバーするテストには `[REQ-NNN]` を付与します。仕上げに `artgraph scan && artgraph check` で結果を検証 — すべてがひとつのレビュー可能な diff にまとまるので、あとはレビューして、調整して、コミットするだけです。

## artgraph が必要な理由

お使いのリポジトリには、すでにコードグラフ MCP が導入されているかもしれません。それはコードのことは知っていますが、仕様のことは知りません。

コードグラフ MCP — codegraph、GitNexus、Sourcegraph MCP など — は、AI コーディングエージェントにコードベースのシンボルレベルのマップを提供します。有用ではありますが、そのマップの範囲はコードで途切れています。エージェントが `signIn` を書き換えたときに、`specs/auth.md` の `REQ-001` に「email と password」と書かれていることも、`docs/auth.md` が古くなっていることも、テストがまだ旧仕様に基づいていることも、何も教えてくれません。

artgraph は、そのコードの*上*にもう一段レイヤーを重ねます:

- **要件・ドキュメント・コード・テストをまたぐ型付きグラフ** — すべてのエッジは決定的で、AST から取れるタグ (`@impl`、`[REQ-ID]`、`req:`)、Markdown リンク、YAML フロントマター、SDD ツールの規約、TypeScript の import、または正規化済みテスト実行トレース成果物から生成されます。グラフの生成に LLM は介在しません。埋め込みも RAG もなしです。
- **変更単位のコンテキストルーティング** — `artgraph impact --diff` は、その変更が触れる仕様書・ドキュメント・テストだけを返します。コンテキストファイルを丸ごと渡すのではなく、*この差分に関わる範囲だけ*をエージェントに渡せます。
- **CI ゲートとしてのドリフト検出** — `artgraph check --gate` は、仕様が変わったのにコード / テストが追従していないときにビルドを落とします。実行するたびにバイト単位で同一の出力になります。
- **要件 ID がプライマリキー** — 仕様書にリストされ、エージェントが `@impl` に書き、テストが角括弧で囲む — この同じ `REQ-001` という文字列こそが単一のキーとなり、4 層のグラフを結合可能にしています。

コードグラフ MCP が答えるのは *「これはどこで使われている？」*。artgraph が答えるのは *「これはどの要件を満たしているのか、そしていまも満たせているのか？」* です。

## クイックスタート

> **対応プラットフォーム:** macOS と Linux — Windows 上の **WSL2** を含む。ネイティブ Windows (PowerShell / cmd) は非対応です。[Windows に関する注記](#windows-に関する注記)を参照してください。

```bash
# パッケージマネージャは好きなものを選択可 (npm / pnpm / Bun / Deno 対応。Yarn は pnpm にフォールバック)
npm install -D artgraph && npx artgraph init --agents=claude       # エージェントを選択
# pnpm add -D artgraph && pnpm exec artgraph init --agents=claude,codex
# bun add -d artgraph && bunx artgraph init --agents=claude
# deno add npm:artgraph && deno run -A npm:artgraph/cli init --agents=claude
```

`artgraph init` はセットアップをまとめて実行します: `.artgraph.json` の設定 + 初回スキャン + クロスエージェント Skills 配布 + 検出された SDD ツールとの自動統合 + Stop フック + `AGENTS.md` スニペット。設定ファイルだけを生成したい場合は `--minimal`、特定のステップだけスキップしたい場合は `--no-skills` / `--no-agent-context` / `--no-integrate` / `--no-hooks` を指定してください。フラグの完全なリストは [docs/commands.md#artgraph-init](./docs/commands.md#artgraph-init) を参照。

**Claude Code をお使いなら:** 手動インストールを丸ごとスキップできます — `/artgraph-setup` と打つだけで、Skill がパッケージマネージャを検出し、artgraph をインストールし、`init` までを 1 ターンで完了させます。

### Tier 1 クロスエージェント配布

`--agents=<list>` は、正となる同一の SKILL.md セット (6 個の Skills + 3 個の `_shared/` フラグメント) を、各エージェントが標準で参照するパスへ配布します。`AGENTS.md` がエージェントコンテキストの正本で、エージェントごとのラッパファイルには `@AGENTS.md` の import 行だけが入ります。

| `--agents` の値 | エージェント | Skills パス | ラッパファイル |
| --- | --- | --- | --- |
| `claude`   | Claude Code | `.claude/skills/`  | `CLAUDE.md` |
| `codex`    | Codex CLI (OpenAI) | `.agents/skills/`  | — (AGENTS.md ネイティブ) |
| `cursor`   | Cursor | `.cursor/skills/`  | — (AGENTS.md ネイティブ) |
| `copilot`  | GitHub Copilot | `.github/skills/`  | `.github/copilot-instructions.md` |
| `kiro`     | Kiro | `.kiro/skills/`    | — (`artgraph integrate kiro` 経由で `.kiro/steering/artgraph.md`) |

> サポート対象は上記 5 つのエージェントに限定しています — artgraph は v0.x の間、Tier 1 を超えて対象を広げる予定はありません。[docs/architecture.md §8 Support Scope](./docs/architecture.md#8-support-scope) を参照。

### Windows に関する注記

ネイティブ Windows (PowerShell / cmd) は非対応です。artgraph は **WSL2** 内で実行してください — サポート対象のパッケージマネージャと Tier 1 エージェントはすべて動作します。Git Bash は未検証です。ネイティブ Windows のチームメンバーがリポジトリをチェックアウトする場合の CRLF / `.gitattributes` の扱いについては [docs/getting-started.md#windows](./docs/getting-started.md#windows) を参照してください。

## エージェントループの動作

インストール後、artgraph は 3 つのタイミングでエージェントのランタイムに接続されます。おかげで `artgraph check` を自分で打つ機会はほぼなくなります:

1. **編集中 (Skills)** — エージェントが編集している最中に、`artgraph-impact` と `artgraph-plan-coverage` がエージェント自身の判断で発火し、提案された変更がどの REQ に触れるのかを *変更が適用される前に* 明らかにします。
2. **ターン完了時 (Stop フック)** — Claude Code が `Stop` に達すると、`.claude/settings.json` のフックが `artgraph check --diff` を実行し、ドリフトが検出されればそのターンをブロックします。他の Tier 1 エージェントにも、ランタイムが許す範囲で同等のフックが用意されています。
3. **SDD チェックポイント** — Spec Kit または Kiro が入っている場合、`artgraph integrate` が `after_tasks` / `after_implement` / 非ブロッキングの `before_implement` プレビュー (blocking ゲートは `--gate` でオプトイン) を SDD ワークフローに接続します。`tasks.md` / `plan.md` の変更は、あとでまとめてではなく、然るべきタイミングでチェックされます。

どのフックも最終的には同じグラフに対する `artgraph check` に集約され、`--diff` は `.trace.lock` と比較します。このループに LLM は介在しません。

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

# 4. ベースラインをスナップショットしたうえで仕様書を書き換え、ドリフトを浮かび上がらせる
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

このフローをそのまま動かせるサンプルが [`examples/basic/`](./examples/basic) にあります。

## グラフを見る

`artgraph scan --serve` を実行すると、req / doc / code / test の 4 層グラフが Cytoscape.js のインタラクティブな画面としてブラウザで開きます。ノードの枠線の色と線種が `drift` / `orphan` / `uncovered` を表すので、`check` の出力を 1 行ずつ追わなくても、問題箇所を目で押さえられます。

<p align="center">
  <img src="./docs/demo/scan-serve.png" alt="artgraph scan --serve の画面: req / doc / code / test を 4 層で表示し、ドリフトしているノードが強調される" width="820" />
</p>

```bash
artgraph scan --serve                            # http://127.0.0.1:3737/ で起動
artgraph scan --serve --port 4000 --host 0.0.0.0 # ポート / バインドアドレスを変更
artgraph scan --output ./graph-out               # 静的 HTML としてエクスポート
```

`.trace.lock` がある場合はドリフト / 孤立 / 未カバーが色分けされ、無い場合はグラフの構造だけをレンダリングします。詳細は [docs/commands.md](./docs/commands.md#artgraph-scan) を参照。

## カバレッジ由来のトレーサビリティ <a id="カバレッジ由来のトレーサビリティ"></a>

実装シンボル一つひとつに `@impl` を手打ちしたくない場合、artgraph は代わりに**テスト実行証拠**から `req → code` エッジを導出できます。Vitest 設定に runner を追加してください:

```ts
// vitest.config.ts
import { withTrace } from "artgraph/vitest/config";
export default defineConfig(withTrace({ test: { /* ...既存設定... */ } }));
```

`test.runner: "artgraph/vitest"` を直接指定しても動きますが、`withTrace()` を推奨します。`withTrace()` は前回実行分の shard を削除する `globalSetup` も合わせて設定するため、証拠は実行のたびに世代置き換えされます — 素の runner 指定だけでは過去の (中断された実行を含む) shard が蓄積し、古い証拠がグラフに流れ込み続けます。

あとはいつも通りテストを実行するだけ (`vitest run`) — artgraph が正規化された per-test 実行証拠を `.artgraph/trace/` に書き出します。次の `artgraph scan` で、`[REQ-NNN]` タグ付きテストの REQ から、そのテストが実際に実行したシンボルへの `exercises` エッジが埋まります。**コード側の `@impl` タグはゼロのまま** — タグゼロ・トレーサビリティです。

`artgraph trace report` は「捏造できない」ことの核となる機能です。`@impl` の主張を実行証拠と突き合わせ、REQ-001 のテストが一度も実行していないシンボルに `@impl REQ-001` が付いていれば **UNEXERCISED CLAIM**(宣言はあるが証拠がない)として検出します。逆に、`@impl` は無いが REQ のテストだけが排他的に実行しているシンボルは **SUGGESTED IMPL** として提案されます。

```bash
pnpm exec artgraph trace status               # shard 件数・鮮度率
pnpm exec artgraph trace report --format json # 宣言 vs 証拠の突き合わせレポート
```

`artgraph impact --diff --tests` は、インパクト解析にテスト選択を追加します。全テストを回す代わりに、変更したコードを実際に実行している REQ のタグ付きテストだけを一覧できます。オプトインの `exercised` カバレッジステータスや鮮度管理を含む full reference は
[docs/commands.md#artgraph-trace](./docs/commands.md#artgraph-trace) と
[docs/configuration.md](./docs/configuration.md#trace--coverage-derived-traceability-spec-020)
を参照してください。

## Spec Kit + artgraph でのターンの例

`artgraph-plan-coverage` Skill が組み込まれた状態で、`/speckit-tasks` のターンがどのように進むか:

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

*どの* REQ が言及されていないのか、*なぜ* 到達可能だったのか — その根拠は、変更ファイルに対する `artgraph plan-coverage` の出力に基づいています。グラフそのものについて LLM が推論しているわけではありません — 使っているのは CLI の決定的な出力だけです。

## Skills

artgraph には、CLI をエージェントのワークフローに接続する 6 つの Skills が同梱されています。`--agents=<list>` で選ばれたすべてのエージェントに配布されます。

| Skill                    | 入力モード    | 発火するタイミング                                                                                                     |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `artgraph-setup`         | n/a           | ユーザーが artgraph をインストール/セットアップしたい、または artgraph のあとに追加された SDD ツールを組み込みたいとき |
| `artgraph-bootstrap`     | n/a           | ユーザーが既存の未タグ (または部分的にタグ済み) プロジェクトにブートストラップ/コールドスタート/初期 REQ 投入をしたいとき |
| `artgraph-impact`        | file + symbol | エージェントが変更を提案し、それが触れる REQ / ドキュメント / テストを知る必要があるとき (ファイルパスまたは `path:symbol`) |
| `artgraph-plan-coverage` | file + symbol | `tasks.md` / `plan.md` が変わった。`Files:` から到達可能だが言及されていない REQ を逆監査                          |
| `artgraph-verify`        | n/a           | 実装完了。コードレビュー前に `artgraph check --diff` で自己検証                                                     |
| `artgraph-rename`        | n/a           | ユーザーが REQ ID をリネーム/分割/マージしたいとき                                                                  |

`file + symbol` の Skills は、`src/auth.ts` (ファイル単位) と `src/auth.ts:validateToken` (シンボル単位) のどちらでも受け付けます。シンボル単位の入力を使う場合は、`.artgraph.json` の `"mode"` を `"symbol"` に設定したうえでグラフを再スキャンする必要があります — トレードオフや `impactReqs` / `originReqs` の二軸ドリフトガイドについては [docs/skills-guide.md#file-mode-vs-symbol-mode](./docs/skills-guide.md#file-mode-vs-symbol-mode) を参照。

## SDD ツール統合

`artgraph integrate` は、scan / reconcile / check のループをすでに使っている SDD ツールに接続します。組み込みの対象は Spec Kit (`.specify/extensions/artgraph/` に `after_tasks` / `after_implement` + 非ブロッキングの `before_implement` プレビュー。blocking ゲートは `--gate` でオプトイン) と Kiro (`.kiro/steering/artgraph.md`) です。

```bash
artgraph integrate speckit          # べき等 — .specify/ にフック
artgraph integrate speckit --gate   # before_implement を blocking ゲートに昇格
artgraph integrate kiro             # .kiro/steering/artgraph.md を書く
artgraph integrate list             # ツールごとの検出/インストール状況
```

`artgraph init` は、検出されたすべての SDD ツールをデフォルトで自動統合します (Spec Kit には非ブロッキングの `before_implement` プレビューが入ります。スキップしたい場合は `--no-integrate` を渡してください)。オプトインの `--gate` は全 REQ の絶対チェックのため、新規 spec の**初回**実装直前では必ず失敗します (全 REQ 未実装のため) — これは想定内の挙動です。gating ポリシーの設計は [#178](https://github.com/mori-shin-x/artgraph/issues/178) で継続中。実際に動くサンプルは [`examples/speckit-integration/`](./examples/speckit-integration) と [`examples/kiro-integration/`](./examples/kiro-integration) にあります。詳細は [docs/sdd-integration.md](./docs/sdd-integration.md) を参照。

## 参照の書き方

| アーティファクト        | 参照の形式                                       |
| ----------------------- | ----------------------------------------------- |
| 仕様書のリスト項目      | `- REQ-001: description`                        |
| 仕様書の見出し (Kiro)   | `### Requirement 1: description`                |
| 実装                    | `// @impl REQ-001`                              |
| テスト                  | `it("[REQ-001] …")` または `// req: "REQ-001"`  |
| ドキュメントの関連      | フロントマター `artgraph.depends_on` / `derives_from`、kiro / spec-kit のファイル名規約から推論、またはインラインの `[text](./other.md)` リンク |

ID の prefix は自由です (`[A-Z][A-Za-z]*-\d+`): 上の例で使っている `REQ-` は単なる慣習で、`FR-001` / `AUTH-2` / `US-12` なども設定なしでそのまま動きます。Spec Kit を使っている場合は、テンプレート標準の `FR-NNN` をそのまま使ってください。特定の ID 系列を追跡対象から外したい場合 (例: Spec Kit の `SC-NNN` Success Criteria — 実装対象の要求ではなくアウトカムのため) は、`.artgraph.json` の `ignoreIdPrefixes` に prefix を列挙します — [docs/configuration.md](./docs/configuration.md#ignoreidprefixes--exclude-specific-id-prefixes-from-tracking) を参照。

独自のパターンは `.artgraph.json` の `reqPatterns` で設定できます — [docs/configuration.md](./docs/configuration.md) を参照。

## コマンド

| コマンド                 | 目的                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `artgraph init`          | agent-native な一括セットアップ: 設定 + スキャン + Skills + SDD 統合 + Stop フック + エージェントコンテキスト |
| `artgraph scan`          | グラフを構築して件数を出力 (`--serve` / `--output` でインタラクティブ HTML としてレンダリング) |
| `artgraph check`         | ドリフト / 孤立 / 未カバーを報告 (`--gate` でフックを失敗させられる)                           |
| `artgraph impact`        | ファイル単位の順方向インパクト (ファイルパス / `--diff`。`--tests` で再実行すべきタグ付きテストを選定) |
| `artgraph trace`         | カバレッジ由来のトレーサビリティ: `status` (shard の健全性) / `report` (`@impl` vs 証拠の突き合わせ) |
| `artgraph plan-coverage` | `tasks.md` の `Files:` から暗黙の REQ インパクトを検出                                         |
| `artgraph reconcile`     | 現在のグラフから `.trace.lock` を再構築                                                        |
| `artgraph rename`        | REQ ID のリネーム / 分割 / マージ                                                              |
| `artgraph integrate`     | artgraph を既存の SDD ツール (Spec Kit / Kiro) に接続                                          |
| `artgraph doctor`        | Tier 1 クロスエージェント配布状況を診断                                                        |

すべてのフラグの詳細リファレンス、`scan --serve`、`doctor` の finding 分類、`rename` の split / merge にまつわる注意点は [docs/commands.md](./docs/commands.md) を参照してください。

## ドキュメント

- [Getting Started](./docs/getting-started.md) — Windows CRLF、Skills のコミット、Stop フックのトラブルシューティング
- [Configuration](./docs/configuration.md) — `reqPatterns`、`ignoreIdPrefixes`、`docGraph`、`taskConventions`、エッジ provenance
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

> **注記**: このドキュメントは英語版 [README.md](./README.md) の翻訳です。最新情報や記述に不整合がある場合は、英語版が正となります。翻訳の改善提案は Issue / Pull Request で歓迎します。
