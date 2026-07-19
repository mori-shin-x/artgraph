<!-- artgraph:begin -->
<!-- artgraph: generated for packageManager=pnpm. If you switch package managers, re-run `pnpm exec artgraph init --force` to regenerate this block. -->
## artgraph — Cross-agent traceability

artgraph manages the trace lock and provides 6 Skills for spec ↔ code ↔ test traceability.

### Available Skills

- `artgraph-setup` — install artgraph in this project (also reports install state and wires late-added SDD tools)
- `artgraph-bootstrap` — bootstrap spec/@impl/test tags in an existing project (LLM proposes, artgraph check verifies)
- `artgraph-impact` — file/symbol → REQs impact
- `artgraph-plan-coverage` — reverse audit of tasks.md / plan.md
- `artgraph-verify` — `pnpm exec artgraph check --diff` self-check
- `artgraph-rename` — safe rename / split / merge of REQ IDs

See `<agent_skills_path>/<skill-name>/SKILL.md` for each Skill's full description (where `<agent_skills_path>` is `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.kiro/skills/` depending on your agent).

### Common workflows

- After editing `tasks.md` / `plan.md`: run **artgraph-plan-coverage** to catch implicit REQ impacts.
- Before review: run **artgraph-verify** (`pnpm exec artgraph check --diff`).
- CI gate for PRs: `pnpm exec artgraph check --diff --base origin/<base> --gate` judges only what the PR's commit range introduced (needs `fetch-depth: 0`; fail-closed exit 1 on a shallow clone).
- When proposing a code change: invoke **artgraph-impact** with `path:symbol`.
- With trace shards present (`artgraph/vitest` runner): `pnpm exec artgraph impact --diff --tests` selects only the tests exercising a change (in CI add `--base origin/<base>` to select from the PR's commit range; exit 1 → fall back to the full suite); `pnpm exec artgraph trace report` cross-checks `@impl` claims against execution evidence.

### Quickstart

```bash
pnpm exec artgraph init --agents=<list>   # provision Skills + agent-context
pnpm exec artgraph doctor                 # diagnose distribution health
```

For full CLI reference, run `pnpm exec artgraph --help` or see https://github.com/mori-shin-x/artgraph.
<!-- artgraph:end -->

## Internal dev process (artgraph contributors only)

このセクションは artgraph リポジトリ自体を開発するコントリビュータ向け。下流プロジェクトには配布されない。

### Step 0-pre: graph-core 変更時の shift-left インパクト調査 (#301)

`src/graph/traverse.ts` / `src/graph/builder.ts`、エッジ意味論、または `impact()` / `check()` / `buildGraph()` などの graph-core 関数を変更する issue/PR では、設計 (Step 0) の**前に** [`.claude/skills/artgraph-graph-primitive-impact/SKILL.md`](./.claude/skills/artgraph-graph-primitive-impact/SKILL.md) のチェックリスト調査を実行する (チェック数は skill 側が正)。調査は**クリーンな Sonnet 5 (`claude-sonnet-5`) サブエージェント**に委譲する (brief テンプレは SKILL.md 内)。

この skill は一般配布 (`templates/skills/`) には含まれないリポジトリ内部専用 skill で、canonical コピーは `.claude/skills/` 配下のみ。`artgraph doctor` / `artgraph init --force` は canonical 外のディレクトリに触れないため共存できる。

### 10 ステップ issue 対応ループ (#302)

issue 対応の 10 ステップ・ループ本体は [`.claude/skills/issue-loop/SKILL.md`](./.claude/skills/issue-loop/SKILL.md)、Step 9 (振り返り) 単体は [`.claude/skills/issue-retro/SKILL.md`](./.claude/skills/issue-retro/SKILL.md) を使う。loop の Step 0-pre で graph-core を触る場合は上記 Step 0-pre セクションに従うこと。

この 2 つは artgraph のドメイン外の汎用 dev process のため、**canonical はメンテナの個人環境 (dotfiles リポジトリ) 側**にあり、リモートセッション (クラウド実行環境はユーザーレベル `~/.claude/skills/` を読み込まない) でも使えるよう本リポジトリに内部コピーを同梱している。編集する場合は dotfiles 側を先に更新し、同内容をここへ同期すること。graph-primitive-impact 同様、一般配布 (`templates/skills/`) には含めない。

Step 9 (振り返り) で「事前に検出可能だった finding」が特定された場合は、その検出条件を `artgraph-graph-primitive-impact` のチェックリストに追加する PR を出す (フィードバックループ)。
