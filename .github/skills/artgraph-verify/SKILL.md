---
name: "artgraph-verify"
description: "Runs `artgraph check --diff` to self-check spec/code/test consistency. Use when implementation is complete or before code review. Make sure to use this skill whenever the user reports implementation completion or asks for a consistency check."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(bunx --no-install artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(git diff*)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

The agent runs `artgraph check --diff` to self-check spec/impl/test consistency before code review or the Stop hook. Catching drift, orphans, and uncovered requirements early reduces rework cost.

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check. If artgraph is not installed, stop and invoke the `artgraph-setup` Skill instead.

> `<PM-exec>` is the project's package runner: `npx` (npm), `pnpm exec`, `bunx`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

### 2. Run the consistency check

```bash
<PM-exec> check --diff --format json
```

- `--diff` scopes the check to files changed by git diff.
- Do NOT add `--gate` — that exits 2 on issues, which is for hook use only. We want the result for inspection.

### 3. Interpret the JSON output

See [output schema](../_shared/output-schema.md) for the shape of `artgraph check`. The scoped arrays (`drifted`, `orphans`, `uncovered`, `coverage`, `testFailures`) list everything in the change's blast radius. `newIssues` is the subset this change actually introduced relative to the baseline (base ref); `suppressedCount` counts pre-existing debt that was in range but not introduced here. `pass` is true only when `newIssues` is empty, and `baselineStatus` is `computed` / `empty` / `skipped` / `unavailable`.

Focus the report on `newIssues` — what this change broke. Because `pass` now means "no NEW issue", the scoped arrays can be non-empty (all pre-existing) while `pass` is still true; report that debt as a count, not a list.

Report each new-issue category:
- **drift**: nodes whose hash differs from the lock — spec changed but impl/lock not yet reconciled. Action: align impl with spec then `artgraph reconcile`.
- **orphans**: `@impl` / `@verify` tags pointing to unknown IDs. Action: remove the stale tag or add the missing spec.
- **uncovered**: requirement IDs with no `@impl` tag. Action: add `@impl <id>` near the implementing symbol.
- **coverage**: per-requirement status (`verified` / `impl-only` / `untagged`). Display-only — not part of the gate. Summarize counts.

If `baselineStatus` is `unavailable`, the baseline could not be built: treat the result as undetermined (do NOT report "passed") and investigate git / worktree state.

### 4. Conclude

- If `pass` is true (no new issues): report "check passed — safe to proceed", noting any suppressed pre-existing debt count.
- Otherwise: list the specific `newIssues` and the actions needed before re-running.
