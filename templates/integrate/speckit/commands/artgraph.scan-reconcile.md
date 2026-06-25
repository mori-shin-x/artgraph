---
description: "Refresh artgraph baseline (scan && reconcile)"
---

# artgraph: scan && reconcile

## Behavior

Rebuilds the artifact graph and refreshes `.trace.lock` to establish a clean baseline after `/speckit-tasks` completes. Run on the host shell.

## Execution

- **Bash**: `artgraph scan && artgraph reconcile`
