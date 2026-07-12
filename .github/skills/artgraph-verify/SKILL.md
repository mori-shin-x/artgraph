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

See [output schema](../_shared/output-schema.md) for the shape of `artgraph check`. The scoped arrays (`drifted`, `orphans`, `uncovered`, `coverage`, `testFailures`) list everything in the change's blast radius. `newIssues` is the subset this change actually introduced relative to the baseline (base ref); `suppressedCount` counts pre-existing debt that was in range but not introduced here. `pass` is true only when `newIssues` is empty, and `baselineStatus` is one of `computed` / `empty` / `skipped` / `not_applicable` / `unavailable`.

Focus the report on `newIssues` — what this change broke. Because `pass` now means "no NEW issue", the scoped arrays can be non-empty (all pre-existing) while `pass` is still true; report that debt as a count, not a list.

`newIssues` is not a uniform shape: `newIssues.drifted` is an array of `{nodeId, kind, lockedHash, currentHash}` objects — same shape as top-level `drifted` — while `newIssues.orphans` / `newIssues.uncovered` / `newIssues.testFailures` stay `string[]`. Do not call string methods (e.g. `.startsWith`) on `newIssues.drifted` entries; use `.nodeId`.

Report each new-issue category:
- **drift**: nodes whose hash differs from the lock — spec changed but impl/lock not yet reconciled. Action: align impl with spec then `artgraph reconcile`.
- **orphans**: `@impl` / `@verify` tags pointing to unknown IDs. Action: remove the stale tag or add the missing spec.
- **uncovered**: requirement IDs with no `@impl` tag. Action: add `@impl <id>` near the implementing symbol — unless the REQ also appears in `exercisableUncovered` (or `check`'s text output prints a `HINT:` about `trace.acceptExercises`, issue #284), in which case the intended fix is setting `"trace": {"acceptExercises": true}` in `.artgraph.json` (test-tag / tag-zero projects), not adding an `@impl` tag.
- **coverage**: per-requirement status (`verified` / `impl-only` / `untagged`, plus `exercised` when `trace.acceptExercises` is on). Display-only — not part of the gate. Summarize counts.

### 3a. Evidence findings (spec 020, trace present only)

When a trace exists, `check --format json` additionally carries `unexercisedClaims` / `suggestedImpls` / `staleEvidence` / `exercisableUncovered`. These are absent entirely when no trace artifact is configured (FR-010) — do not report on them in that case.

- **UNEXERCISED CLAIM** (`unexercisedClaims: {reqId, node}[]`) — an `@impl` claim whose REQ's tagged tests never actually ran that symbol. Read the REQ's spec text and decide: (a) the `@impl` tag is simply wrong (the symbol doesn't implement that REQ) — remove or retarget it; (b) the tag is right but coverage is missing — write the missing test and tag it `[REQ-NNN]`. If the spec text is ambiguous about which symbol should satisfy the REQ, do not guess — ask the user which fix applies before changing anything.
- **SUGGESTED IMPL** (`suggestedImpls: {reqId, node}[]`) — a symbol exclusively exercised by one REQ's tests but not `@impl`-tagged. Propose adding `// @impl REQ-NNN` above the symbol as a diff and ask for approval; never write it automatically — accepting a suggestion is a semantic judgment about correctness, and Principle V (Boundary of Determinism) forbids auto-committing semantic conclusions to code or the lock. `infrastructure` entries (shared by `sharedThreshold`+ REQs) are excluded by design — do not propose `@impl` for those.
- **STALE EVIDENCE** (`staleEvidence: {reqId, symbols, tracedAt}[]`) — the traced symbols changed since the trace was captured. Ask the user to re-run the test suite (regenerates `.artgraph/trace/` as a fresh generation, not an accumulating diff) to refresh the evidence; if re-running isn't possible right now, note the staleness explicitly in your report rather than treating the stale entries as either confirmed or refuted. `trace.staleness` changes how much this matters: `warn` (default) only reports it; `exclude` drops stale edges from every evidence judgment; `gate` fails `check --diff --gate` (exit 2) until refreshed.
- **`exercisableUncovered`** (`string[]`, issue #284) — display-only hint: `uncovered` REQ ids that would flip to `exercised` if `trace.acceptExercises` were turned on. See the `uncovered` bullet above for the corresponding action.

`baselineStatus` values:
- `computed` / `empty` / `skipped`: a real (possibly trivial) baseline diff was applied — `newIssues` reflects genuinely new problems. Proceed to step 4 normally.
- `not_applicable`: no baseline diff was attempted at all — step 2's command was run without `--diff`. This should not happen when step 2 is followed as written; if you see it, re-run with `--diff` before reporting anything.
- `unavailable`: the baseline could not be built. `baselineError` carries the reason (a git failure, a `scan()` exception, etc.) — treat the result as undetermined (do NOT report "passed") and investigate git / worktree state using that message.

### 4. Conclude

Check `baselineStatus` *before* `pass` — `pass` is forced `false` when the baseline could not be built, so it alone cannot distinguish "gate fail" from "undetermined":

```text
if baselineStatus === "unavailable":
  report "gate undetermined — <baselineError>" and stop
else if pass:
  report "check passed — safe to proceed"
else:
  list newIssues, ask user for guidance
```

- **`baselineStatus === "unavailable"`**: the result is undetermined, not a pass or a fail. Report "gate undetermined — " followed by the `baselineError` message, then stop — do not report "passed" or continue to the branches below.
- **Otherwise, `pass` is true**: report "check passed — safe to proceed", noting any suppressed pre-existing debt count (`suppressedCount`).
- **Otherwise** (`pass` is false and the baseline was determined): list the specific `newIssues` and the actions needed, then ask the user for guidance before re-running.
