---
name: "artgraph-impact"
description: "Runs `artgraph impact` to surface which requirements, docs, and files a proposed file edit touches (forward: files → REQs). Use when the user explicitly names file paths or wants the impact of files staged in `git diff` / declared in `tasks.md` / `plan.md`."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(pnpm exec artgraph*)"
  - "Bash(bunx artgraph*)"
  - "Bash(deno run*)"
  - "Bash(artgraph *)"
  - "Bash(git diff*)"
  - "Bash(git status*)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Runs `artgraph impact` to compute **forward propagation from one or more source files**: which requirements, docs, and other files a proposed file edit touches. The CLI is file-only — it does not accept REQ-IDs or `doc:` prefixes. Use the output to make a file edit with explicit awareness of its affected scope and drift.

For detecting the **inverse** — REQs that are implicitly affected by files listed in `tasks.md` but never mentioned in spec/plan/tasks — use `artgraph-plan-coverage` instead.

## Input modes

Pick one based on what the user supplied:

| Mode | Trigger | Command |
| --- | --- | --- |
| (a) Diff | `git status` shows staged or unstaged changes | `artgraph impact --diff --format json` |
| (b) Explicit file source | User named file paths, or pointed at a tasks.md / plan.md | `artgraph impact <file...>` OR `artgraph impact --from-tasks <path>` OR `artgraph impact --from-plan <path>` |
| (c) Ask | Neither — no diff, no file paths, no tasks/plan path | Ask the user: "Which tasks.md / plan.md path, or which file(s) should I analyze?" then re-enter with mode (b) |

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

- Else if the user named file paths or pointed at a tasks.md / plan.md path, use mode (b). Pick the right form:

  ```bash
  # Explicit file paths (REQ-IDs are rejected — file paths only)
  artgraph impact src/auth.ts src/session.ts --format json

  # tasks.md as the source of starting files (FR-004)
  artgraph impact --from-tasks specs/<latest>/tasks.md --format json

  # plan.md as the source of starting files (FR-006)
  artgraph impact --from-plan  specs/<latest>/plan.md  --format json
  ```

- Else use mode (c): ask the user "Which tasks.md / plan.md path, or which file(s) should I analyze?", then re-enter with mode (b).

### 3. Parse the JSON output

See [output schema](../_shared/output-schema.md) for the field shapes of `artgraph impact`. The result has `affectedReqs`, `affectedDocs`, `affectedFiles`, `drifted`.

### 4. Inject into the response

Use the parsed output to:
- Cite each `affectedReqs` ID so changes to those requirements are explicit in the file edit.
- Flag any `drifted` entries — the spec for those IDs has changed but the lock has not been reconciled. Block the edit until the user runs `artgraph reconcile`.
- Cross-check that the edit does not silently change `affectedFiles` outside its declared scope.
