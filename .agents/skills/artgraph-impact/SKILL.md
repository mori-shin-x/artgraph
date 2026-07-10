---
name: "artgraph-impact"
description: "Runs `artgraph impact` to surface which requirements, docs, and files a proposed file or symbol edit touches (forward: files/symbols → REQs). Use when the user explicitly names file paths or `path:symbol` pairs, or wants the impact of files staged in `git diff`."
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

For detecting the **inverse** — REQs that are implicitly affected by files listed in `tasks.md` but never mentioned in spec/plan/tasks — and for any tasks.md / plan.md driven analysis, use `artgraph-plan-coverage` instead.

## Input modes

Pick one based on what the user supplied:

| Mode | Trigger | Command |
| --- | --- | --- |
| (a) Diff | `git status` shows staged or unstaged changes | `<PM-exec> impact --diff --format json` |
| (b) Explicit file or symbol source | User named file paths or `path:symbol` pairs | `<PM-exec> impact <file_or_symbol...>` |
| (c) Ask | Neither — no diff, no file paths | Ask: "Which file(s) or `path:symbol` pair should I analyze?" then re-enter with mode (b) |

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check. If artgraph is not installed, stop and invoke the `artgraph-setup` Skill instead.

> `<PM-exec>` is the project's package runner: `npx` (npm), `pnpm exec`, `bunx`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

**Symbol-level input** (`src/auth.ts:validateToken`) additionally requires the graph to have been scanned with symbol nodes enabled — set `"mode": "symbol"` in `.artgraph.json` and re-run `<PM-exec> scan`. Without symbol nodes the CLI exits 1 with `symbol-level input requires a symbol-mode graph`. See [Skills Guide — file vs symbol mode](../../../docs/skills-guide.md#file-mode-vs-symbol-mode) for the trade-off and config example.

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

- Else if the user named file paths or `path:symbol` pairs, use mode (b). Pick the right form:

  ```bash
  # Explicit file paths (REQ-IDs are rejected — file paths only)
  <PM-exec> impact src/auth.ts src/session.ts --format json

  # Symbol-level input — limits forward BFS to one export
  <PM-exec> impact src/auth.ts:validateToken --format json
  ```

  For tasks.md / plan.md driven analysis, hand off to `artgraph-plan-coverage`.

- Else use mode (c): ask the user, then re-enter with mode (b).

### 3. Parse the JSON output

The result carries the **dual-axis impact view** plus drift:

| field | meaning |
| --- | --- |
| `impactReqs` | REQs reached by forward BFS from the start ids (file or symbol nodes) |
| `originReqs` | REQs the start ids `@impl`-claim directly (1-hop reverse `implements` edge) |
| `affectedFiles` / `affectedTasks` | other node kinds reached by the same BFS |
| `affectedDocs` | parent spec doc(s) of every reached REQ/task, attached as **context**, not BFS reach (see below) |
| `drifted` | lockfile drift on any of the above (`affectedDocs` entries included) |

See [output schema](../_shared/output-schema.md) for the full field shapes.

**Same-spec siblings are not blast radius.** `impactReqs` only contains REQs the edit actually reaches — through code (`@impl`, `imports`) or explicit spec relations (`depends_on` / `derives_from`). A REQ that merely lives in the same `spec.md` as a reached REQ, with no code or dependency link of its own, does **not** appear in `impactReqs` / `affectedFiles` / `drifted`, even under the common Spec Kit / Kiro layout of "one spec.md, many REQs". Its parent spec doc still shows up in `affectedDocs` so you can open that file for full feature context, but don't treat every REQ inside it as touched by this edit — cite only the REQs actually listed in `impactReqs`.

### 4. Inject into the response

Use the parsed output to:
- Cite each `impactReqs` ID so changes to those requirements are explicit in the edit.
- Flag **Drift candidates** = `impactReqs \ originReqs`. In text output they appear under `Drift candidates:`; in JSON, compute the set difference yourself. A non-empty difference means either (a) the symbol has grown to reach a REQ it should now `@impl`-claim, or (b) the spec graph added a `depends_on` the symbol has not caught up to. Treat both as a prompt to update `@impl` tags or the spec. **Exception (c) — the entry is a barrel-side namespace re-export**: `barrel.ts:ns` where `ns` is defined by `export * as ns from "./o"` (S2) or `import * as ns from "./m"; export { ns }` (S3-namespace). In this case `entryOriginIds` cannot follow the `symbol:barrel#ns → file:O` file-grain edge, so `originReqs` is empty and every reached REQ appears as a drift candidate. **This is expected and does not require `@impl` on the barrel — the barrel is a re-export shim, not an implementation site.** If you see this pattern, either (i) switch the entry to file-level (`barrel.ts`) to include all origin REQs, or (ii) target the underlying origin directly (`o.ts:actualSymbol`).
- Flag any `drifted` entries — block the edit until the user runs `artgraph reconcile`.
- Cross-check that the edit does not silently change `affectedFiles` outside its declared scope.
