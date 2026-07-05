{{PM_NOTICE}}
## artgraph — Cross-agent traceability

artgraph manages the trace lock and provides 9 Skills for spec ↔ code ↔ test traceability.

### Available Skills

- `artgraph-setup` — install artgraph in this project
- `artgraph-bootstrap` — bootstrap spec/@impl/test tags in an existing project (LLM proposes, artgraph check verifies)
- `artgraph-detect` — report artgraph installation state
- `artgraph-integrate` — wire artgraph into Spec Kit / Kiro
- `artgraph-impact` — file/symbol → REQs impact
- `artgraph-plan-coverage` — reverse audit of tasks.md / plan.md
- `artgraph-coverage` — per-REQ coverage status
- `artgraph-verify` — `{{ARTGRAPH_EXEC}} check --diff` self-check
- `artgraph-rename` — safe rename / split / merge of REQ IDs

See `<agent_skills_path>/<skill-name>/SKILL.md` for each Skill's full description (where `<agent_skills_path>` is `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.kiro/skills/` depending on your agent).

### Common workflows

- After editing `tasks.md` / `plan.md`: run **artgraph-plan-coverage** to catch implicit REQ impacts.
- Before review: run **artgraph-verify** (`{{ARTGRAPH_EXEC}} check --diff`).
- When proposing a code change: invoke **artgraph-impact** with `path:symbol`.

### Quickstart

```bash
{{ARTGRAPH_EXEC}} init --agents=<list>   # provision Skills + agent-context
{{ARTGRAPH_EXEC}} doctor                 # diagnose distribution health
```

For full CLI reference, run `{{ARTGRAPH_EXEC}} --help` or see https://github.com/ShintaroMorimoto/artgraph.
