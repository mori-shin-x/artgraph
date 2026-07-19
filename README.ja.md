<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/logo-light.svg">
    <img src="./assets/logo-light.svg" alt="artgraph" width="360">
  </picture>
</h1>

<p align="center"><a href="./README.md">English</a> | <strong>日本語</strong></p>

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
npx artgraph init --agents=claude   # brownfield 対応・仕様書不要
# ... ファイルを編集 ...
npx artgraph impact --diff          # → TS の import グラフから影響ファイルを出力
```

> 別のパッケージマネージャを使っている場合は、以降の `npx artgraph` を
> `pnpm dlx artgraph` (インストール済みなら `pnpm exec`)、`bunx artgraph`、
> `deno run -A npm:artgraph/cli` に読み替えてください — [クイックスタート](#クイックスタート) 参照。

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
- **変更単位のコンテキストルーティング** — `artgraph impact --diff` は、その変更が触れる仕様書・ドキュメント・テストだけを返します。コンテキストファイルを丸ごと渡すのではなく、*この差分に関わる範囲だけ*をエージェントに渡せます。これは 1 つの `spec.md` に複数の要件を書く構成 (Spec Kit / Kiro の標準) でも成り立ちます — 同じファイルに書かれているだけでコード依存のない兄弟要件は巻き込まれません。クラス内部でも同様です (1 クラス・複数メソッド・各メソッドが別要件を実装する OOP 標準形): symbol mode ではインライン export されたクラスの各メソッドが独立したグラフノードになるため、1 メソッドの編集が兄弟メソッドの要件を引き連れることはありません。
- **CI ゲートとしてのドリフト検出** — `artgraph check --gate` は、仕様が変わったのにコード / テストが追従していないときにビルドを落とします。実行するたびにバイト単位で同一の出力になります。
- **要件 ID がプライマリキー** — 仕様書にリストされ、エージェントが `@impl` に書き、テストが角括弧で囲む — この同じ `REQ-001` という文字列こそが単一のキーとなり、4 層のグラフを結合可能にしています。

コードグラフ MCP が答えるのは *「これはどこで使われている？」*。artgraph が答えるのは *「これはどの要件を満たしているのか、そしていまも満たせているのか？」* です。

<details>
<summary><strong>目次</strong></summary>

- [タグゼロで 30 秒スタート](#タグゼロで-30-秒スタート)
- [既存プロジェクトのブートストラップ](#既存プロジェクトのブートストラップ)
- [artgraph が必要な理由](#artgraph-が必要な理由)
- [クイックスタート](#クイックスタート)
- [エージェントループの動作](#エージェントループの動作)
  - [Pull Request の CI ゲート](#pull-request-の-ci-ゲート)
  - [Pull Request の CI テスト選択](#pull-request-の-ci-テスト選択)
- [エンドツーエンド: 仕様 → @impl → check](#エンドツーエンド-仕様--impl--check)
- [グラフを見る](#グラフを見る)
- [カバレッジ由来のトレーサビリティ](#カバレッジ由来のトレーサビリティ)
- [Spec Kit + artgraph でのターンの例](#spec-kit--artgraph-でのターンの例)
- [Skills](#skills)
- [SDD ツール統合](#sdd-ツール統合)
- [参照の書き方](#参照の書き方)
- [コマンド](#コマンド)
- [ドキュメント](#ドキュメント)
- [動作要件](#動作要件)
- [ライセンス](#ライセンス)

</details>

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

**Claude Code をお使いで、配布済み Skills がコミット済みのリポジトリに参加する場合:** 手動インストールをスキップできます — `/artgraph-setup` と打つと、Skill がパッケージマネージャを検出し、確認を挟んで artgraph をインストールし、セットアップを検証します。`init` が走るのはコミット済みの `.artgraph.json` がまだ無いプロジェクトの場合のみで、artgraph がインストール済みの場合は現在のセットアップ状態をレポートします。チーム最初の 1 人は上記の手動インストールを実行し、配布済み Skills をコミットしてください — [Committing distributed Skills](./docs/getting-started.md#committing-distributed-skills) を参照。

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

### Pull Request の CI ゲート

CI のチェックアウトでは作業ツリーがコミットと完全に一致するため、素の `check --diff` には比較対象がありません。`--base <ref>` を渡すと PR のコミット範囲をゲートできます: 判定は `git merge-base <ref> HEAD` を基準に行われるため、**その PR が新規に導入した問題だけ**がゲートを落とし、base ブランチ側の既存債務は suppress されます。

以下のレシピは npm を使っています — pnpm の場合は `npm ci` を
`pnpm install --frozen-lockfile` (+ `pnpm/action-setup`) に、`npx` を
`pnpm exec` に、`npm test` を `pnpm test` に読み替えてください (Bun / Deno も同様)。

```yaml
name: artgraph-gate
on: pull_request

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # 必須 — shallow clone では merge-base が解決できず、ゲートは fail-closed (exit 1) になります
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx artgraph check --diff --base "origin/${{ github.base_ref }}" --gate
```

exit code: `0` = 新規問題なし、`2` = PR がドリフト / 孤立タグ / 未カバー REQ を導入、`1` = ゲート判定不能 (shallow clone など — fail-closed であり、無言で pass することはありません)。ローカルの Stop フックは従来どおり素の `check --gate --diff` (作業ツリー diff) を使います。`--base` はコミット範囲のゲート用です。

### Pull Request の CI テスト選択

trace shards がある場合 (`artgraph/vitest` runner)、`impact --diff --base <ref> --tests` は PR のコミット範囲に実行証拠が到達するテストだけを選択します — 上のゲートと同じ merge-base 意味論なので、CI の clean な作業ツリーでも機能します。`impact --tests` は**最適化**であり、ゲートはあくまで `check --diff --base --gate` 側です: exit `1` (解決できない ref / shallow clone / 変更 path がグラフ未解決) のときや選択結果が疑わしいときは full suite に fallback してください。

```yaml
      - name: Select and run tests (exit 1 なら full suite に fallback)
        run: |
          set +e
          out=$(npx artgraph impact --diff --base "origin/${{ github.base_ref }}" --tests --format json)
          status=$?
          set -e
          if [ "$status" -ne 0 ]; then
            echo "impact exited $status — falling back to the full suite"
            npm test; exit $?
          fi
          files=$(echo "$out" | jq -r '[.testsToRun[]?.testFile] | unique | .[]')
          # PR が削除したテストファイルを除外 — 存在しないパスを渡すと vitest が exit 1 になる
          files=$(for f in $files; do [ -f "$f" ] && echo "$f"; done)
          if [ -z "$files" ]; then
            npm test   # 空選択 — 安全側に倒して全部走らせる
          else
            echo "$files" | xargs npx vitest run
          fi
```

削除された、またはグラフ未追跡の変更ファイルは選択の入力に寄与しません。また PR のコミット範囲内で rename されたファイルは、旧パスで記録された trace evidence と join しなくなるため、そのテストは選択から無言で落ちます (宣言された限界 — その正しさは `check --diff --base --gate` ステップが捕まえます)。`trace.staleness: "exclude"` では変更コードの evidence が構造的に stale になるため、CI のテスト選択では `"warn"` を使ってください (この組み合わせでは実行時警告が出ます)。

## エンドツーエンド: 仕様 → `@impl` → `check` <a id="エンドツーエンド-仕様--impl--check"></a>

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

ただし、デフォルトでは `artgraph check` はこれらの REQ を依然として `uncovered` / `untagged` と報告します — `exercised` カバレッジステータスはオプトインであり、自動では有効になりません。実行証拠をカバレッジとして扱うには `.artgraph.json` に `"trace": {"acceptExercises": true}` を追加してください(該当する場合、`check` はこのことを `HINT:` として出力します)。

`artgraph trace report` は「捏造できない」ことの核となる機能です。`@impl` の主張を実行証拠と突き合わせ、REQ-001 のテストが一度も実行していないシンボルに `@impl REQ-001` が付いていれば **UNEXERCISED CLAIM**(宣言はあるが証拠がない)として検出します。逆に、`@impl` は無いが REQ のテストだけが排他的に実行しているシンボルは **SUGGESTED IMPL** として提案されます。

```bash
npx artgraph trace status               # shard 件数・鮮度率
npx artgraph trace report --format json # 宣言 vs 証拠の突き合わせレポート
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

`file + symbol` の Skills は、`src/auth.ts` (ファイル単位)、`src/auth.ts:validateToken` (シンボル単位)、`src/auth.ts:Sample.methodA` (クラスメソッド単位 — インライン export されたクラスのメソッドは独立したシンボルになるため、そのメソッドの REQ だけが返り兄弟メソッドの REQ は含まれません) を受け付けます。メソッド単位はファイル内精度のクエリで、クラスを import する依存元ファイルは含みません — 依存元まで含む爆風が必要な場合はクラス単位 (`src/auth.ts:Sample`)、ファイル単位、または `--diff` を使ってください。シンボル単位の入力を使う場合は、`.artgraph.json` の `"mode"` を `"symbol"` に設定したうえでグラフを再スキャンする必要があります — トレードオフや `impactReqs` / `originReqs` の二軸ドリフトガイドについては [docs/skills-guide.md#file-mode-vs-symbol-mode](./docs/skills-guide.md#file-mode-vs-symbol-mode) を参照。

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

なお、`reconcile` は現在のグラフから `.trace.lock` を**完全に再構築**します。シンボル抽出の粒度が変わるバージョンへアップグレードした後は、次回の `reconcile` で lock のシンボルエントリと `@impl` の帰属が書き換わることがあります。0.x 系では移行ツールを提供しないため、`.trace.lock` の差分を確認してからコミットしてください。

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
