# artgraph Claude Code Skills ガイド

## 概要

artgraph は仕様・実装・テストの整合性を追跡するツールで、8 つの Claude Code Skills を通じてエージェントのワークフローへネイティブ統合されます。SKILL.md 本体は cross-agent 対応と Claude Skills ベストプラクティスに従い英語で記述されていますが、本ドキュメントは人間の読者向けに日本語で維持しています。

各 Skill は in-flight (会話中) での早期検出を担い、Stop hook (コミット時) と補完しあって整合性を担保します。

## クイックスタート

### Claude Code エージェント経由 (推奨)

artgraph 未導入のプロジェクトで「artgraph をセットアップしてほしい」と依頼すると、`artgraph-setup` Skill が起動し、以下を 1 ターンで完結させます:

1. パッケージマネージャ自動検出 (npm / pnpm / Bun / Deno; Yarn は npm 経由で警告付きフォールバック)
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
- Skills install (`.claude/skills/<name>/SKILL.md` 配置)
- integrate-auto (検出された SDD ツール: Spec Kit / Kiro)
- Stop hook (P1)
- agent context snippet 注入 (P1)

| フラグ | 挙動 |
| --- | --- |
| (なし) | full setup |
| `--minimal` | bare config のみ。他 stage はすべて off |
| `--no-skills` / `--no-integrate` / `--no-hooks` / `--no-agent-context` | full setup から個別 stage を opt-out |
| `--minimal --with-skills` 等 | minimal を起点に個別 stage を opt-in |
| `--integrations <csv>` | 一回限りの SDD ツール統合指定 (旧 `--integrate` から rename。`--no-integrate` との commander 衝突回避) |

詳細は `artgraph init --help` を参照してください。

## Skills 一覧 (全 8 種)

### artgraph-setup

- トリガー: artgraph 未導入のプロジェクトで「artgraph を入れて」「セットアップして」と依頼された時
- 動作: package manager 検出 (npm / pnpm / Bun / Deno、Yarn は npm fallback + 警告) → install → `artgraph init` (full setup) → `artgraph check`
- 参照: `templates/skills/artgraph-setup/SKILL.md`

### artgraph-integrate

- トリガー: artgraph 導入済みプロジェクトで SDD ツール統合を頼まれた時
- 動作: `artgraph integrate list` で Spec Kit / Kiro を detect → ユーザー同意を取得 → `artgraph integrate <tool>` を実行
- 参照: `templates/skills/artgraph-integrate/SKILL.md`

### artgraph-detect

- トリガー: 「artgraph 入ってる？」「何が available？」と聞かれた時
- 動作: 読み取り専用。CLI 有無 / `.artgraph.json` 有無 / SDD ツール統合状態 / Skills 設置状況を一覧
- 参照: `templates/skills/artgraph-detect/SKILL.md`

### artgraph-impact (旧 artgraph-plan)

- トリガー: file 起点で forward 影響範囲(波及する REQ / doc / file)を確認したいとき
- 動作: 入力経路は file path のみで、次の 3 モードに整理されている
  - (a) git に変更あり → `artgraph impact --diff`
  - (b) ユーザーが file path を明示 / または `--from-tasks <path>` / `--from-plan <path>` で SDD 文書から file 群を抽出 → `artgraph impact <files>` 等
  - (c) どちらもなし → 「どの tasks.md / plan.md path、または file(s) を分析しますか？」とユーザーに確認
- **REQ-ID 起点入力は spec 014 で撤去**: `artgraph impact REQ-001` のような REQ-ID / `doc:` prefix 入力は専用エラーで終了し、次の 4 経路を案内する:
  - `artgraph impact <file>...` (file path 直指定)
  - `artgraph impact --from-tasks <path>` (tasks.md から抽出)
  - `artgraph impact --from-plan <path>` (plan.md から抽出)
  - `artgraph impact --diff` (git diff から抽出)
- 抽出戦略 (`--from-tasks` / `--from-plan` 共通): (1) `Files: src/a.ts, src/b.ts` 形のセクションを優先抽出、(2) 無ければ全文 regex で path 形を拾い `graph.nodes` / `fs.existsSync` で実在検証したものを採用。両方ゼロなら警告 + exit 1。**tasks.md / plan.md の各タスクに `Files:` セクションを書く**ことを SDD 統合テンプレ (`templates/integrate/speckit/README.md`, `templates/integrate/kiro/artgraph.md`) で推奨している
- リネーム理由: 旧名「plan」は "変更前の設計" を連想させたが `--diff` は変更後を見るため矛盾していた。3 モード化で diff の有無を問わず利用可能になり、spec 014 で file-only に絞ったことで CLI の mental model が「file → 波及」一方向に揃った
- 使用例:

```bash
# 明示 file 起点
artgraph impact src/auth.ts src/session.ts

# tasks.md 起点 (推奨 — SDD workflow 親和的)
artgraph impact --from-tasks specs/<latest>/tasks.md --format json

# plan.md 起点
artgraph impact --from-plan specs/<latest>/plan.md

# git diff 起点 (既存)
artgraph impact --diff --depth 3
```

- 参照: `templates/skills/artgraph-impact/SKILL.md`

### artgraph-plan-coverage

- トリガー: `/speckit-tasks` の直後 (tasks.md が更新された後の自然な検証ポイント)、または `/speckit-implement` の直前 (実装着手前の最終チェック)。「tasks の波及確認」「暗黙波及」「漏れチェック」等のキーワードでも発火
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
  3. **(将来) strict mode**: ラベル keyword (`Considered:` / `Affected:`) 強制。本 spec 014 ではスコープ外、spec 015 候補 [#105](https://github.com/ShintaroMorimoto/artgraph/issues/105) で扱う
- exit code: デフォルト exit 0 + report (informational)。`--gate` 付きで `implicitImpacts` 非空 or `diagnostics` 非空のとき exit 1
- `--require-files-section`: opt-in 厳格モード。tasks.md の各 task block に `Files:` セクションが無いものを `diagnostics[]` に `{ kind: "missingFilesSection", taskId, line }` 形で報告する。`.artgraph.json` の `{ "planCoverage": { "requireFilesSection": true } }` 経由でプロジェクト永続化も可能。デフォルト OFF なので既存プロジェクトを壊さない
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

# Files: セクション強制 (opt-in 厳格モード)
artgraph plan-coverage --require-files-section
```

- 参照: `templates/skills/artgraph-plan-coverage/SKILL.md`

### artgraph-verify

- トリガー: 実装完了報告 / コードレビュー直前
- 動作: `artgraph check --diff` を実行し drift / orphan / uncovered / coverage 不足をセルフチェック。Stop hook (`artgraph check --gate`) でブロックされる前の手戻り削減を目的とする
- 参照: `templates/skills/artgraph-verify/SKILL.md`

### artgraph-coverage

- トリガー: 進捗・残作業確認の依頼時
- 動作: `artgraph coverage` を実行し per-requirement の verified / impl-only / untagged 状態を集計
- 参照: `templates/skills/artgraph-coverage/SKILL.md`

### artgraph-rename

- トリガー: 仕様 ID のリネーム / split / merge 依頼時
- 動作: `artgraph rename` 系で spec 本文・`@impl` タグ・テストの `[ID]` / `req:` タグ・frontmatter (`depends_on` / `derives_from`) ・`.trace.lock` を一括書き換え。破壊的操作のため `--dry-run` で必ず影響範囲を確認
- 参照: `templates/skills/artgraph-rename/SKILL.md`

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
| `.claude/skills/<name>/SKILL.md` | `artgraph init` (default) の配備先、per-project |
| `~/.claude/plugins/cache/.../skills/<name>/SKILL.md` | Plugin install の配備先、user-global (P2 で追加予定) |

共有断片は `templates/skills/_shared/` 配下に集約されています:

- `_shared/install-check.md` — CLI 存在チェック手順
- `_shared/output-schema.md` — 共通出力フォーマット
- `_shared/package-manager.md` — npm/pnpm/Bun/Deno 検出ロジック

## カスタマイズ

- SKILL.md は cross-agent 対応のため英語前提ですが、自プロジェクト内で上書きする場合は任意の言語に書き換えて構いません
- `--minimal --with-skills` 等を組み合わせれば必要な stage のみ導入する構成も可能
- トリガー条件は SKILL.md frontmatter の `description` を編集して調整できます
- 実行コマンドのオプション (`--diff` の有無など) もプロジェクトの要件に応じて変更可能です
