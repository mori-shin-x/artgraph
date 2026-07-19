{{PM_NOTICE}}
## artgraph — Cross-agent traceability

artgraph manages the trace lock and provides 6 Skills for spec ↔ code ↔ test traceability.

### Available Skills

- `artgraph-setup` — install artgraph in this project (also reports install state and wires late-added SDD tools)
- `artgraph-bootstrap` — bootstrap spec/@impl/test tags in an existing project (LLM proposes, artgraph check verifies)
- `artgraph-impact` — file/symbol → REQs impact
- `artgraph-plan-coverage` — reverse audit of tasks.md / plan.md
- `artgraph-verify` — `{{ARTGRAPH_EXEC}} check --diff` self-check
- `artgraph-rename` — safe rename / split / merge of REQ IDs

See `<agent_skills_path>/<skill-name>/SKILL.md` for each Skill's full description (where `<agent_skills_path>` is `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.kiro/skills/` depending on your agent).

### Common workflows

- After editing `tasks.md` / `plan.md`: run **artgraph-plan-coverage** to catch implicit REQ impacts.
- Before review: run **artgraph-verify** (`{{ARTGRAPH_EXEC}} check --diff`).
- CI gate for PRs: `{{ARTGRAPH_EXEC}} check --diff --base origin/<base> --gate` judges only what the PR's commit range introduced (needs `fetch-depth: 0`; fail-closed exit 1 on a shallow clone).
- When proposing a code change: invoke **artgraph-impact** with `path:symbol`.
- With trace shards present (`artgraph/vitest` runner): `{{ARTGRAPH_EXEC}} impact --diff --tests` selects only the tests exercising a change (in CI add `--base origin/<base>` to select from the PR's commit range; exit 1 → fall back to the full suite); `{{ARTGRAPH_EXEC}} trace report` cross-checks `@impl` claims against execution evidence.

`artgraph init` also wires up an automatic gate hook for agents that support one (Claude Code / Codex CLI Stop hook, Kiro IDE agent-stop hook): it runs `{{ARTGRAPH_EXEC}} check --gate --diff` after each turn so drift surfaces immediately, without waiting for CI.

### Quickstart

```bash
{{ARTGRAPH_EXEC}} init --agents=<list>   # provision Skills + agent-context
{{ARTGRAPH_EXEC}} doctor                 # diagnose distribution health
```

For full CLI reference, run `{{ARTGRAPH_EXEC}} --help` or see https://github.com/mori-shin-x/artgraph.
