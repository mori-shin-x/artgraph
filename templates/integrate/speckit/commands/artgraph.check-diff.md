---
description: "Verify coverage/orphan/drift on the current diff"
---

# artgraph: check --diff

## Behavior

Runs `artgraph check --diff` scoped to the current git diff. Reports orphan `@impl` tags, drifted nodes, and uncovered claimed REQs. **Non-blocking**: exits 0 even when issues are reported (informational only — `--gate` is not passed).

Used in two places:

- **after_implement** — verify traceability after `/speckit-implement`.
- **before_implement** (default wiring) — preview the current traceability state before implementing. It never halts the workflow; unimplemented REQs of a fresh spec are expected here and are display-only.

## Execution

- **Bash**: `artgraph check --diff`

> CI note (spec 023): in a CI pipeline the working tree is clean, so gate the PR's commit range instead with `artgraph check --diff --base origin/<base-branch> --gate` (requires a `fetch-depth: 0` checkout).
