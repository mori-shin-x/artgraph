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
- When proposing a code change: invoke **artgraph-impact** with `path:symbol`.

### Quickstart

```bash
pnpm exec artgraph init --agents=<list>   # provision Skills + agent-context
pnpm exec artgraph doctor                 # diagnose distribution health
```

For full CLI reference, run `pnpm exec artgraph --help` or see https://github.com/mori-shin-x/artgraph.
<!-- artgraph:end -->
