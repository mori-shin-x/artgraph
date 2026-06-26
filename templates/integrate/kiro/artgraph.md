# artgraph — Kiro integration

This steering file tells the Kiro agent how to use artgraph to keep code, specs, and tests in sync.

## When to run artgraph

- **Before implementation** — run `artgraph impact <path>` to see which requirements/docs are affected.
- **After implementation** — run `artgraph check --diff` to verify coverage / orphan / drift.
- **On drift detection** — run `artgraph reconcile` to refresh the lock baseline (only after human review of the drift).

## Commands

| Command                  | Use                                                   |
| ------------------------ | ----------------------------------------------------- |
| `artgraph impact <file>` | List affected REQs/docs/files for a given path        |
| `artgraph check --diff`  | Validate the current git diff against the trace graph |
| `artgraph reconcile`     | Update `.trace.lock` to current graph (use with care) |
| `artgraph coverage`      | Inspect per-requirement coverage status               |
