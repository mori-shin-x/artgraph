---
description: "Verify coverage/orphan/drift on the current diff"
---

# artgraph: check --diff

## Behavior

Runs `artgraph check --diff` scoped to the current git diff. Reports orphan `@impl` tags, drifted nodes, and uncovered claimed REQs. Use after `/speckit-implement`.

## Execution

- **Bash**: `artgraph check --diff`
