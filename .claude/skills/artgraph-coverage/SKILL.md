---
name: "artgraph-coverage"
description: "Runs `artgraph coverage` to show per-requirement coverage status. Use when the user asks for progress, remaining work, or what's left to test. Make sure to use this skill whenever the user is reviewing progress against a spec."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(artgraph *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

The agent runs `artgraph coverage` to surface per-requirement coverage status — verified, impl-only, or untagged — so the user can see what remains. Use this to answer progress and remaining-work questions against the current spec.

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check.

### 2. Pull coverage status

```bash
artgraph coverage --format json
```

### 3. Interpret the JSON output

See [output schema](../_shared/output-schema.md) for the shape of `artgraph coverage`. The result has `items[]` (per-requirement rows) and `summary` (totals).

Each `items[]` row has `reqId` and `status` ∈ `verified | impl-only | untagged`:
- **verified**: requirement has both `@impl` and a passing test reference.
- **impl-only**: requirement has `@impl` but no test reference yet.
- **untagged**: requirement has neither `@impl` nor a test reference.

### 4. Report progress

Print a 3-line summary using `summary.{total, verified, implOnly, untagged}`. Then:

- If `untagged > 0`: list those IDs first — these are the highest-priority next-work items.
- If `implOnly > 0`: list those IDs second — these need tests.
- If everything is `verified`: report "All requirements verified".

Optionally suggest which untagged IDs to pick up next based on the spec's stated priorities (the agent already knows the project's spec at this point).
