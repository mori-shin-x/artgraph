---
name: "artgraph-impact"
description: "Runs `artgraph impact` to inject change-impact context for planning, designing, or scoping work. Supports three input modes: (a) when git has changes, uses `--diff`; (b) when the user mentions REQ-IDs or file paths, calls `artgraph impact` with those targets; (c) when neither, asks the user which requirement or file to analyze. Use when the user is about to plan, design, scope, or analyze the impact of any change. Make sure to use this skill whenever the user enters planning mode, asks for impact analysis, or mentions designing changes."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(artgraph *)"
  - "Bash(git diff*)"
  - "Bash(git status*)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Runs `artgraph impact` to surface which requirements, docs, and files a proposed change touches. Use the output to plan with explicit awareness of affected scope and drift.

## Input modes

Pick one based on what the user supplied:

| Mode | Trigger | Command |
| --- | --- | --- |
| (a) Diff | `git status` shows staged or unstaged changes | `artgraph impact --diff --format json` |
| (b) Explicit targets | User mentioned a REQ-ID (e.g. `FR-001`) or file path | `artgraph impact FR-001 src/auth.ts --format json` |
| (c) Ask | Neither — no diff and no targets given | Ask the user: "Which requirement ID or file should I analyze the impact of?" then re-enter with mode (b) |

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check.

### 2. Pick a mode and run

Detect which mode applies, then run the corresponding command.

```bash
# Detect diff
git status --porcelain
```

- If output is non-empty, use mode (a):

  ```bash
  artgraph impact --diff --format json
  ```

- Else if the user's message contains a REQ-ID (e.g. `FR-001`) or a file path, use mode (b):

  ```bash
  # Replace the arguments with the REQ-IDs or file paths the user named.
  # Example:
  #   artgraph impact FR-001 src/auth.ts --format json
  artgraph impact FR-001 --format json
  ```

- Else use mode (c): ask the user which requirement ID or file to analyze, then re-enter with mode (b).

### 3. Parse the JSON output

See [output schema](../_shared/output-schema.md) for the field shapes of `artgraph impact`. The result has `affectedReqs`, `affectedDocs`, `affectedFiles`, `drifted`.

### 4. Inject into the plan

Use the parsed output to:
- Cite each `affectedReqs` ID in the plan so changes to those requirements are explicit.
- Flag any `drifted` entries — the spec for those IDs has changed but the lock has not been reconciled. Block the plan until the user runs `artgraph reconcile`.
- Cross-check the plan does not silently change `affectedFiles` outside its declared scope.
