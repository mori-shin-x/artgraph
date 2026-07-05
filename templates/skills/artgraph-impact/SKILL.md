---
name: "artgraph-impact"
description: "Runs `artgraph impact` to surface which requirements, docs, and files a proposed file or symbol edit touches (forward: files/symbols → REQs). Use when the user explicitly names file paths or `path:symbol` pairs, or wants the impact of files staged in `git diff` / declared in `tasks.md` / `plan.md`."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(bunx --no-install artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(git diff*)"
  - "Bash(git status*)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Runs `artgraph impact` to compute **forward propagation from one or more source files or specific exported symbols**: which requirements, docs, and other files a proposed edit touches. The CLI accepts file paths and `path:symbol` pairs — REQ-IDs and `doc:` prefixes are rejected. Use the output to make an edit with explicit awareness of its affected scope and drift.

For detecting the **inverse** — REQs that are implicitly affected by files listed in `tasks.md` but never mentioned in spec/plan/tasks — use `artgraph-plan-coverage` instead.

## Input modes

Pick one based on what the user supplied:

| Mode | Trigger | Command |
| --- | --- | --- |
| (a) Diff | `git status` shows staged or unstaged changes | `<PM-exec> impact --diff --format json` |
| (b) Explicit file or symbol source | User named file paths, `path:symbol` pairs, or pointed at a tasks.md / plan.md | `<PM-exec> impact <file_or_symbol...>` OR `<PM-exec> impact --from-tasks <path>` OR `<PM-exec> impact --from-plan <path>` |
| (c) Ask | Neither — no diff, no file paths, no tasks/plan path | Ask: "Which tasks.md / plan.md path, file(s), or `path:symbol` pair should I analyze?" then re-enter with mode (b) |

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check. If artgraph is not installed, stop and invoke the `artgraph-setup` Skill instead.

> `<PM-exec>` is the project's package runner: `npx` (npm), `pnpm exec`, `bunx`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

**Symbol-level input** (`src/auth.ts:validateToken`) additionally requires the graph to have been scanned with symbol nodes enabled — set `"mode": "symbol"` in `.artgraph.json` and re-run `<PM-exec> scan`. Without symbol nodes the CLI exits 1 with `symbol-level input requires \`artgraph scan --mode symbol\``. See [Skills Guide — file vs symbol mode](../../../docs/skills-guide.md#file-mode-vs-symbol-mode) for the trade-off and config example.

### 2. Pick a mode and run

Detect which mode applies, then run the corresponding command.

```bash
# Detect diff
git status --porcelain
```

- If output is non-empty, use mode (a):

  ```bash
  <PM-exec> impact --diff --format json
  ```

- Else if the user named file paths, `path:symbol` pairs, or pointed at a tasks.md / plan.md path, use mode (b). Pick the right form:

  ```bash
  # Explicit file paths (REQ-IDs are rejected — file paths only)
  <PM-exec> impact src/auth.ts src/session.ts --format json

  # Symbol-level input — limits forward BFS to one export
  <PM-exec> impact src/auth.ts:validateToken --format json

  # tasks.md as the source of starting entries (`path:symbol` syntax inherited)
  <PM-exec> impact --from-tasks specs/<latest>/tasks.md --format json

  # plan.md as the source of starting entries
  <PM-exec> impact --from-plan  specs/<latest>/plan.md  --format json
  ```

- Else use mode (c): ask the user, then re-enter with mode (b).

### 3. Parse the JSON output

The result carries the **dual-axis impact view** plus drift:

| field | meaning |
| --- | --- |
| `impactReqs` | REQs reached by forward BFS from the start ids (file or symbol nodes) |
| `originReqs` | REQs the start ids `@impl`-claim directly (1-hop reverse `implements` edge) |
| `affectedFiles` / `affectedDocs` / `affectedTasks` | other node kinds reached by the same BFS |
| `drifted` | lockfile drift on any of the above |

See [output schema](../_shared/output-schema.md) for the full field shapes.

### 4. Inject into the response

Use the parsed output to:
- Cite each `impactReqs` ID so changes to those requirements are explicit in the edit.
- Flag **Drift candidates** = `impactReqs \ originReqs`. In text output they appear under `Drift candidates:`; in JSON, compute the set difference yourself. A non-empty difference means either (a) the symbol has grown to reach a REQ it should now `@impl`-claim, or (b) the spec graph added a `depends_on` the symbol has not caught up to. Treat both as a prompt to update `@impl` tags or the spec.
- Flag any `drifted` entries — block the edit until the user runs `artgraph reconcile`.
- Cross-check that the edit does not silently change `affectedFiles` outside its declared scope.
