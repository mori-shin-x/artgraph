# artgraph Claude Code Skills ガイド

## 概要

artgraph は仕様・実装・テストの整合性を追跡するツールで、6 つの Claude Code Skills を通じてエージェントのワークフローへネイティブ統合されます。SKILL.md 本体は cross-agent 対応と Claude Skills ベストプラクティスに従い英語で記述されていますが、本ドキュメントは人間の読者向けに日本語で維持しています。

各 Skill は in-flight (会話中) での早期検出を担い、Stop hook (コミット時) と補完しあって整合性を担保します。

## クイックスタート

### Claude Code エージェント経由 (推奨)

artgraph 未導入のプロジェクトで「artgraph をセットアップしてほしい」と依頼すると、`artgraph-setup` Skill が起動し、以下を 1 ターンで完結させます:

1. パッケージマネージャ自動検出 (npm / pnpm / Bun / Deno; シグナル無し時のデフォルトと Yarn フォールバックは pnpm)
2. devDependency として install
3. `artgraph init` (full agent-native setup)
4. `artgraph check` でセルフチェック

### CLI 経由 (任意の package manager)

```bash
# npm
npm install -D artgraph
npx artgraph init                       # full agent-native setup
npx artgraph init --minimal             # bare config のみ

# pnpm
pnpm add -D artgraph
pnpm exec artgraph init

# Bun
bun add -d artgraph
bunx artgraph init

# Deno
deno add npm:artgraph
deno run -A npm:artgraph/cli init
```

## `init` のデフォルト挙動

`artgraph init` はデフォルトで full agent-native setup を実行し、以下の stage をまとめて適用します:

- config (`.artgraph.json` 生成)
- scan (初回 spec/impl/test 索引化)
- Skills install (`--agents=<list>` で選択したエージェントの canonical skills path `<agent_skills_path>/<name>/SKILL.md` へ配置。`<agent_skills_path>` は agent id ごとに固定 — 5 canonical path 一覧は README の [Tier 1 cross-agent distribution](../README.md#tier-1-cross-agent-distribution) 参照)
- integrate-auto (検出された SDD ツール: Spec Kit / Kiro)
- Stop hook
- agent context snippet 注入 (AGENTS.md canonical + CLAUDE.md / copilot wrapper。コマンド例は init 時に検出した PM の exec prefix でレンダリング)

| フラグ | 挙動 |
| --- | --- |
| (なし) | full setup |
| `--minimal` | bare config のみ。他 stage はすべて off |
| `--no-skills` / `--no-integrate` / `--no-hooks` / `--no-agent-context` | full setup から個別 stage を opt-out |

詳細は `artgraph init --help` を参照してください。

## Skills 一覧 (全 6 種)

> **#135 での統廃合**: 旧 `artgraph-detect` (導入状態レポート) と旧 `artgraph-integrate` (SDD ツール後付け統合) は `artgraph-setup` に吸収されました。旧 `artgraph-coverage` は `coverage` CLI コマンドの削除に伴い廃止 — 進捗・残作業の確認は `artgraph check` の出力 (`--format json` に per-requirement coverage rows を含む) で行います。

### artgraph-setup

- トリガー: artgraph 未導入のプロジェクトで「artgraph を入れて」「セットアップして」と依頼された時。導入済みプロジェクトで「artgraph 入ってる？」「何が available？」と聞かれた時や、後から入れた SDD ツール (Spec Kit / Kiro) の統合依頼にも対応
- 動作: package manager 検出 (npm / pnpm / Bun / Deno、デフォルト と Yarn フォールバックは pnpm + 警告) → install → `artgraph init` (full setup) → `artgraph check`。導入済みの場合は読み取り専用の state レポート (CLI 有無 / `.artgraph.json` / SDD 統合状態 / Skills 設置状況) を返し、未統合の SDD ツールがあれば `artgraph integrate <tool>` を案内する
- 参照: `templates/skills/artgraph-setup/SKILL.md`

### artgraph-bootstrap

タグゼロ (または部分的にしかタグが無い) 既存リポジトリで、spec 追記 + `@impl REQ-NNN` + テストの `[REQ-NNN]` マーカーを Claude が一括提案し、ユーザー承認後に `artgraph scan && artgraph check` で決定的に検証する。生成は確率的、検証は決定的という役割分担で `docs/architecture.md` §4 D5 と両立する。

- トリガー: 「artgraph をブートストラップして」「既存リポに REQ を撒いて」「タグゼロから始めたい」等
- 前提: `artgraph` インストール済み (未インストールなら `artgraph-setup` を先に案内)
- 参照: `templates/skills/artgraph-bootstrap/SKILL.md`

### artgraph-impact (旧 artgraph-plan)

- トリガー: file 起点で forward 影響範囲(波及する REQ / doc / file)を確認したいとき
- 動作: 入力経路は file path のみで、次の 3 モードに整理されている
  - (a) git に変更あり → `artgraph impact --diff`
  - (b) ユーザーが file path / `path:symbol` を明示 → `artgraph impact <files>`
  - (c) どちらもなし → 「どの file(s) を分析しますか？」とユーザーに確認
- **REQ-ID 起点入力は spec 014 で撤去**: `artgraph impact REQ-001` のような REQ-ID / `doc:` prefix 入力は専用エラーで終了し、次の経路を案内する:
  - `artgraph impact <file>...` (file path 直指定)
  - `artgraph impact --diff` (git diff から抽出)
  - tasks.md / plan.md 分析は `artgraph plan-coverage` へ
- リネーム理由: 旧名「plan」は "変更前の設計" を連想させたが `--diff` は変更後を見るため矛盾していた。3 モード化で diff の有無を問わず利用可能になり、spec 014 で file-only に絞ったことで CLI の mental model が「file → 波及」一方向に揃った
- 使用例:

```bash
# 明示 file 起点
artgraph impact src/auth.ts src/session.ts

# git diff 起点 (既存)
artgraph impact --diff

# tasks.md / plan.md 起点の分析は plan-coverage へ
artgraph plan-coverage
```

- 参照: `templates/skills/artgraph-impact/SKILL.md`

### artgraph-plan-coverage

- トリガー: `/speckit-tasks` の直後 (tasks.md が更新された後の自然な検証ポイント)、または `/speckit-implement` の直前 (実装着手前の最終チェック)。「tasks の波及確認」「暗黙波及」「漏れチェック」等のキーワードでも発火 (SKILL.md description は EN — picker は description 全文から semantic match する)
- 動作: `tasks.md` の `Files:` セクション起点で内部 `impact()` を呼び、得た `affectedReqs` から `tasks.md` / `plan.md` / `spec.md` のテキスト全体に出現する REQ-ID mention を引いた差分 = **暗黙波及 (implicit impacts)** を報告する。新規 REQ を実装するとき、既存仕様への波及を見落とさないためのガード
- 役割分担: `artgraph-impact` (file 起点 forward 波及) と `artgraph-check` (実装 vs spec drift) では捉えられない「人間が tasks.md を書いたとき、既存仕様への暗黙波及を見落としていないか」を埋める唯一の Skill
- 入力経路 (spec dir 解決):
  - **自動検出** (Spec Kit canonical lookup order): (1) `SPECIFY_FEATURE_DIRECTORY` 環境変数、(2) `.specify/feature.json#feature_directory`
  - **明示** `--spec <dir>`: Kiro 利用時は canonical な current spec 指標が存在しないため必須
- 出力 (dual view、同一データの 2 軸表現):
  - `implicitImpacts` (by-sourceFile 軸): 「この file を触ると何が波及するか」 — `[{ sourceFile, reqs: [{ reqId, kind }] }]`
  - `implicitImpactsByReq` (by-FR 軸): 「この FR はどの file 経由で来ているか」 — `[{ reqId, sourceFiles: [string] }]`(spec 014 amendment で追加、既存 file を修正する task のユースケース向け)
  - `summary`, `diagnostics`, `ignored` も併せて返す。詳細スキーマは `specs/014-reinvent-impact-cli/contracts/plan-coverage-json.md` 参照
- **検知後の 3 経路** (Skill の中心的価値):
  1. **言及追加** (推奨): tasks.md / plan.md / spec.md のいずれかで該当 REQ-ID を mention する。**ラベル無依存** — `Considered: REQ-003 — no impact` でも `Affected: REQ-003` でも `[REQ-003]` でもプレーン `REQ-003` でも、境界マッチ (`\bREQ-003\b`) すれば全て「言及」とみなされる。次の実行から `implicitImpacts` から消える
  2. **`--ignore REQ-003,REQ-007`**: one-shot suppression。当該実行限定で抑止し、**設定ファイルに永続化しない**。CI を一時的に通す緊急回避用
  3. **(将来) strict mode**: ラベル keyword (`Considered:` / `Affected:`) 強制。本 spec 014 ではスコープ外、spec 015 候補 [#105](https://github.com/mori-shin-x/artgraph/issues/105) で扱う
- exit code: デフォルト exit 0 + report (informational)。`--gate` 付きで `implicitImpacts` 非空 or `diagnostics` 非空のとき exit 1
- `requireFilesSection`: opt-in 厳格モード。tasks.md の各 task block に `Files:` セクションが無いものを `diagnostics[]` に `{ kind: "missingFilesSection", taskId, line }` 形で報告する。`.artgraph.json` の `{ "planCoverage": { "requireFilesSection": true } }` で有効化する。デフォルト OFF なので既存プロジェクトを壊さない
- 使用例:

```bash
# 自動検出 (Spec Kit canonical)
artgraph plan-coverage

# 明示 (Kiro — 必須)
artgraph plan-coverage --spec .kiro/specs/auth-2fa/

# CI gating
artgraph plan-coverage --gate --format json

# 一時的に suppress (one-shot)
artgraph plan-coverage --gate --ignore REQ-003,REQ-007

# Files: セクション強制は .artgraph.json で opt-in:
#   { "planCoverage": { "requireFilesSection": true } }
```

- 参照: `templates/skills/artgraph-plan-coverage/SKILL.md`

### artgraph-verify

- トリガー: 実装完了報告 / コードレビュー直前
- 動作: `artgraph check --diff` を実行し drift / orphan / uncovered / coverage 不足をセルフチェック。Stop hook (`artgraph check --gate`) でブロックされる前の手戻り削減を目的とする
- 参照: `templates/skills/artgraph-verify/SKILL.md`

### artgraph-rename

- トリガー: 仕様 ID のリネーム / split / merge 依頼時
- 動作: `artgraph rename` 系で spec 本文・`@impl` タグ・テストの `[ID]` / `req:` タグ・frontmatter (`depends_on` / `derives_from`) ・`.trace.lock` を一括書き換え。破壊的操作のため `--dry-run` で必ず影響範囲を確認
- 参照: `templates/skills/artgraph-rename/SKILL.md`

## File mode vs Symbol mode

`artgraph impact` / `artgraph plan-coverage` の入力粒度には **file mode** (デフォルト) と **symbol mode** (opt-in) の 2 つがあります。`Files: src/auth.ts` のように file path だけを書けば file mode、`Files: src/auth.ts:validateToken` のように `path:symbol` の形で書けば symbol mode です。symbol mode は同一 file の他 symbol 経由の REQ を排除して過剰検知を抑制できる代わりに、graph に symbol node が必要になります。

### Trade-off 表

| 項目 | file mode | symbol mode |
| --- | --- | --- |
| 起動コスト (scan latency) | 低 — file 単位の content-hash | やや高 — `oxc-parser` で export 抽出 |
| `Files:` syntax | `src/auth.ts` | `src/auth.ts:validateToken` (file 単位も混在 OK) |
| 想定ユーザー | 新規実装 / 大規模 refactor | 既存関数 1 個だけ修正する保守ケース |
| 必要な scan 設定 | デフォルト (`mode: "file"`) | `.artgraph.json` で `"mode": "symbol"` |
| barrel / re-export | OK 対応 | 静的 named/aliased re-export (`export { x } from` / `export { x as y } from` / `export type {} from`)、`export * as ns from` (S2 namespace re-export、specs/018)、`export * from` チェーン (specs/018 §5、多段 barrel も 1 hop ずつ実体化)、source なし local re-export (`import { x } from "./m"; export { x }` / `export default X`、specs/018 §6 S3) はすべて per-symbol 解決。namespace import (`import * as`) / dynamic import (`import()`) / (a) 曖昧 star / (b) diamond 束縛同一性 / (c) `export = X` origin / (d) fatal syntax file / (e) exclude glob origin / (f) `@impl` を star statement 直上に配置 / (g) parser silent skip on unresolved re-exports は file-level fallback (詳細は `docs/architecture.md` §11 と `CHANGELOG.md`) |
| 過剰検知の傾向 | 同 file 内の全 symbol を巻き込む | 当該 symbol からの forward 波及のみ |

### `.artgraph.json` の `mode` 設定例

```jsonc
// file mode (デフォルト) — 何も書かなければこれ
{
  "mode": "file"
}

// symbol mode (opt-in) — 既存関数 1 個だけ修正するワークフロー向け
{
  "mode": "symbol"
}
```

設定変更後は `artgraph scan` を再実行してください (`mode: "symbol"` で初めて scan すると `symbol:<path>#<name>` ノードが graph に登録されます)。`mode: "file"` のまま `Files: src/auth.ts:validateToken` のような symbol 入力を渡すと、`artgraph plan-coverage` は `unresolvedSymbol` diagnostic を立て、`artgraph impact` は exit 1 で「symbol-level input requires a symbol-mode graph」のガイダンスを返します。

`artgraph init` が生成する `.artgraph.json` には `mode: "symbol"` が含まれます。`mode` を省略した既存 config のデフォルトは `mode: "file"` のままです。

### 二軸出力 (`impactReqs` / `originReqs`) によるドリフト追跡

`artgraph impact` / `artgraph plan-coverage` は JSON / text の両方で次の二軸を返します(symbol mode / file mode どちらでも有効)。

- **`impactReqs`** — startId (file または symbol node) からの forward BFS で到達した REQ 集合。「この変更が実際に手を伸ばす範囲」。
- **`originReqs`** — startId の `@impl` claim を `implements` edge で **1-hop** 逆向きに辿った REQ 集合。「この変更が本来 claim している REQ」。symbol 起点の場合、barrel 経由の re-export は `imports` edge を transitively 辿ってから 1-hop `implements` を適用するため、多段 barrel（`index.ts → sub.ts → origin.ts`）でも origin の `@impl` に到達します（issue #191、`plan-coverage` と `artgraph impact` 双方で有効）。`export * from` チェーンも specs/018 §5 の builder 展開で `symbol:B#name → symbol:O#name` エッジが張られるため、star 経由の多段 barrel でも同じ symbol→symbol BFS で origin の `@impl` に到達します。

二軸を比較してドリフトを判定します。

| 状態 | 解釈 | 推奨対応 |
| --- | --- | --- |
| `impactReqs == originReqs` | ドリフトなし — claim と波及が一致 | そのまま実装 |
| `impactReqs \ originReqs` 非空 | **ドリフト候補** — claim していない REQ に波及している | spec を見直して `depends_on` を追加するか、symbol を再分割する。CLI text 出力では `Drift candidates (impact \ origin):` セクションで表示 |
| `originReqs \ impactReqs` 非空 | orphan claim — claim している REQ に到達できない | `artgraph check --gate` の領分 (Stop hook がブロック) |

JSON consumer は `impactReqs \ originReqs` をクライアント側で計算してドリフト候補を抽出できます。

```bash
artgraph impact src/auth.ts:validateToken --format json |
  jq '.impactReqs as $i | .originReqs as $o | $i - $o'
```

典型ワークフロー例 — `Files: src/auth.ts:validateToken` を tasks.md に書いた後、spec.md で `REQ-001 depends_on REQ-007` を追加すると、次の `artgraph plan-coverage` 実行で `impactReqs = ["REQ-001", "REQ-007"]` / `originReqs = ["REQ-001"]` となり、`REQ-007` がドリフト候補として可視化されます。

### 同一 spec.md 内の兄弟 REQ は blast radius に入らない (spec 019)

Spec Kit / Kiro の標準構成は「1 feature = 1 spec.md に複数 REQ」です。`artgraph impact` / `artgraph plan-coverage` の `impactReqs` は、対象の file / symbol が実際にコードで到達する REQ (`@impl` / `imports` 経由) と、spec 側で明示された依存 (`depends_on` / `derives_from`) の到達先だけを含みます。**同じ spec.md に定義されているだけの兄弟 REQ は、コード上の依存が無ければ `impactReqs` / `affectedFiles` / `drifted` に混入しません。**

一方、到達した REQ の親 spec doc は帰属情報として `affectedDocs` に残り続け、**doc 自体は drift 判定の対象のまま**です — spec ファイルの contentHash が lock とずれていれば `drifted` に doc エントリとして現れます(`plan-coverage` にはこの帰属フィールドはありません)。その feature 全体の文脈が必要な場合は、`affectedDocs` に載っている spec ファイルを開いて読んでください — 兄弟 REQ を `impactReqs` に混ぜて渡すのではなく、必要な時に agent 自身が spec を読みに行く設計です。

### `Files:` syntax 例(symbol 含む)

```markdown
## T010 ユーザー認証 strict mode 対応

Files: src/auth.ts:validateToken, src/session.ts:createSession, docs/auth.md
```

- `path:symbol` 形式 — symbol 単位で forward BFS を絞り込み(symbol mode 必須)
- `path` 形式 — file 全体の symbol を巻き込んだ forward BFS(file mode / symbol mode どちらでも可)
- 同一 tasks.md / plan.md 内で混在 OK(parser は per-entry に解決する)
- 詳細な regex とエッジケースは `specs/016-impact-plan-symbol-level/contracts/sdd-files-parser.md` 参照

## Skills と Stop Hook の関係

Skills と Stop hook は同じ `artgraph` CLI を共有しつつ、異なるタイミングで動作する補完関係にあります:

1. plan / 設計時: `artgraph-impact` が file 起点の forward 影響分析を注入
2. tasks 確定後 / 実装着手前: `artgraph-plan-coverage` が暗黙波及(言及されていない既存 REQ への波及)を検出
3. 実装中: 開発者がコードを書く
4. 実装完了時: `artgraph-verify` がセルフチェックを実行
5. コミット時: Stop hook (`artgraph check --gate`) がゲーティング

Skills が in-flight の早期検出、Stop hook がコミット時の最終ゲートを担います。両方導入することで効果が最大化しますが、それぞれ独立して使用することも可能です。

## Skills 配置場所

| パス | 用途 |
| --- | --- |
| `templates/skills/<name>/SKILL.md` | source of truth (本リポジトリに同梱) |
| `<agent_skills_path>/<name>/SKILL.md` (`<agent_skills_path>` は agent id で決まる — 5 canonical path 一覧は README 参照) | `artgraph init` (default) の配備先、per-project |
| `~/.claude/plugins/cache/.../skills/<name>/SKILL.md` | Plugin install の配備先、user-global (P2 で追加予定) |

共有断片は `templates/skills/_shared/` 配下に集約されています:

- `_shared/install-check.md` — CLI 存在チェック手順
- `_shared/output-schema.md` — 共通出力フォーマット
- `_shared/package-manager.md` — npm/pnpm/Bun/Deno 検出ロジック

> **Note (host agent 対応状況)**: 現時点で実運用検証済みの host agent は **Claude Code** のみ。Codex CLI / Cursor / Copilot / Kiro については spec 013 の distribution 契約 (`.agents/`, `.cursor/`, `.github/`, `.kiro/` の canonical skills path × byte-identical SKILL.md) は満たしているが、prose 化した SKILL.md を各 host が Claude 同等に解釈することを保証する Skill 発火 E2E テストは別 issue で追跡している (2026-07 時点)。

## カスタマイズ

- SKILL.md は cross-agent 対応のため英語前提ですが、自プロジェクト内で上書きする場合は任意の言語に書き換えて構いません
- `--no-*` opt-out を組み合わせれば必要な stage のみ導入する構成も可能 (Skills のみ再インストールする場合は `init --force --agents=<list> --no-scan --no-integrate --no-hooks --no-agent-context`)
- トリガー条件は SKILL.md frontmatter の `description` を編集して調整できます
- 実行コマンドのオプション (`--diff` の有無など) もプロジェクトの要件に応じて変更可能です
