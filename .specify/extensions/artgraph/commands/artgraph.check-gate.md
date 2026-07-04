---
description: "Gate implementation on artgraph check (--gate mode)"
---

# artgraph: check --gate

## Behavior

Hard-fails the workflow if drift/orphan/uncovered exist (exit 2). Use before `/speckit-implement` when you want a strict gate.

## Execution

- **Bash**: `artgraph check --gate`
