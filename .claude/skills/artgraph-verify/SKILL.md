---
name: "artgraph-verify"
description: "Runs `artgraph check --diff` to self-check spec/code/test consistency. Use when implementation is complete or before code review. Make sure to use this skill whenever the user reports implementation completion or asks for a consistency check."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(artgraph *)"
  - "Bash(git diff*)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

The agent runs `artgraph check --diff` to self-check spec/impl/test consistency before code review or the Stop hook. Catching drift, orphans, and uncovered requirements early reduces rework cost.

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check.

### 2. Run the consistency check

```bash
artgraph check --diff --format json
```

- `--diff` scopes the check to files changed by git diff.
- Do NOT add `--gate` — that exits 2 on issues, which is for hook use only. We want the result for inspection.

### 3. Interpret the JSON output

See [output schema](../_shared/output-schema.md) for the shape of `artgraph check`. The result has `drift`, `orphans`, `uncovered`, `coverage`.

Report each category:
- **drift**: nodes whose hash differs from the lock — spec changed but impl/lock not yet reconciled. Action: align impl with spec then `artgraph reconcile`.
- **orphans**: `@impl` / `@verify` tags pointing to unknown IDs. Action: remove the stale tag or add the missing spec.
- **uncovered**: requirement IDs with no `@impl` tag. Action: add `@impl <id>` near the implementing symbol.
- **coverage**: per-requirement status (`verified` / `impl-only` / `untagged`). Summarize counts.

### 4. Conclude

- If all four categories are clean: report "check passed — safe to proceed".
- Otherwise: list the specific actions needed before re-running.
