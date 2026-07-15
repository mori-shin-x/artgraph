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
- With trace shards present (`artgraph/vitest` runner): `pnpm exec artgraph impact --diff --tests` selects only the tests exercising a change; `pnpm exec artgraph trace report` cross-checks `@impl` claims against execution evidence.

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

`src/graph/traverse.ts` / `src/graph/builder.ts`、エッジ意味論、または `impact()` / `check()` / `buildGraph()` などの graph-core 関数を変更する issue/PR では、設計 (Step 0) の**前に** [`.claude/skills/artgraph-graph-primitive-impact/SKILL.md`](./.claude/skills/artgraph-graph-primitive-impact/SKILL.md) の 9 チェック調査を実行する。調査は**クリーンな Sonnet 5 (`claude-sonnet-5`) サブエージェント**に委譲する (brief テンプレは SKILL.md 内)。

この skill は一般配布 (`templates/skills/`) には含まれないリポジトリ内部専用 skill で、canonical コピーは `.claude/skills/` 配下のみ。`artgraph doctor` / `artgraph init --force` は canonical 外のディレクトリに触れないため共存できる。

### 10 ステップ issue 対応ループ (#302)

issue 対応の 10 ステップ・ループ本体 (issue-loop / retro skill) は artgraph のドメイン外の汎用 dev process として、メンテナの個人環境 (dotfiles リポジトリ) 側で管理される。artgraph 側の接続点は上記 Step 0-pre のみ: loop の Step 0-pre で graph-core を触る場合は本セクションに従うこと。

Step 9 (振り返り) で「事前に検出可能だった finding」が特定された場合は、その検出条件を `artgraph-graph-primitive-impact` のチェックリストに追加する PR を出す (フィードバックループ)。
