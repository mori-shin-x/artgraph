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

Add `--tests` to mode (a) (`<PM-exec> impact --diff --tests --format json`, spec 020 FR-018) when the user wants to know **which tests to re-run** after the change, instead of just which REQs are touched — it lists the tagged tests of REQs that exclusively exercise a changed symbol (`testsToRun`), so you can run only those instead of the whole suite. It requires a trace: with zero trace shards it exits 1 with install/runner guidance (same wording as `trace report`'s zero-shard error) — treat that as "no coverage-derived evidence yet", not a real failure, and fall back to a full test run.

**In CI, add `--base <ref>`** (spec 024): a CI checkout's working tree matches the commit exactly, so plain `--diff` sees an empty diff and the selection silently comes back "No changes detected". `<PM-exec> impact --diff --base origin/<default-branch> --tests --format json` widens the changed-file set to the merged diff (working tree ∪ `git merge-base <ref> HEAD`..HEAD commit range — the same set `check --diff --base` judges). `--base` requires `--diff` (usage error exit 1 otherwise), and environment failures (unresolvable ref, shallow clone with no merge-base — use `fetch-depth: 0`) exit 1 with **no JSON on stdout**. Consumer rule: deleted, renamed, or graph-untracked changed files contribute nothing to the selection (impact resolves against the current graph only — no baseline, no rename map; a file renamed in the commit range resolves under its new path but no longer joins trace evidence recorded under the old path, so its tests silently drop); treat `impact --tests` as an **optimization** and fall back to the full suite on exit 1 or whenever unsure — the correctness gate remains `check --diff --base --gate`. When scripting the runner invocation, filter the selected test files for existence first (e.g. `[ -f "$f" ]`) — a PR that deletes a test file can select only nonexistent paths, and `vitest run` exits 1 on those. Caution: combining `--tests`, `--base`, and `trace.staleness: "exclude"` drops the changed code's (stale-by-construction) evidence and with it exactly the tests the selection exists to find — a runtime stderr WARNING fires on that combination; use `staleness: "warn"` for CI selection.

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check. If artgraph is not installed, stop and invoke the `artgraph-setup` Skill instead.

> `<PM-exec>` is the project's package runner: `npx` (npm), `pnpm exec`, `bunx`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

**Symbol-level input** (`src/auth.ts:validateToken`, or class-method grain `src/auth.ts:Sample.methodA`) additionally requires the graph to have been scanned with symbol nodes enabled — set `"mode": "symbol"` in `.artgraph.json` and re-run `<PM-exec> scan`. Without symbol nodes the CLI exits 1 with `symbol-level input requires a symbol-mode graph`. See [Skills Guide — file vs symbol mode](../../../docs/skills-guide.md#file-mode-vs-symbol-mode) for the trade-off and config example.

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

  # Class-method grain — methods of inline-exported classes are symbols too
  <PM-exec> impact src/auth.ts:Sample.methodA --format json

  # Test-selection: only the tests worth re-running for this diff
  <PM-exec> impact --diff --tests --format json

  # CI test-selection: include the PR's commit range (clean checkout — spec 024)
  <PM-exec> impact --diff --base origin/<default-branch> --tests --format json
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
| `reqProvenance` | (trace present only) per-REQ `{reqId, provenance}` where `provenance` is `["static"]`, `["evidence"]`, or both — see below |
| `testsToRun` | (`--tests` only) `{testFile, testName, reqId}[]` — the tagged tests worth re-running |

See [output schema](../_shared/output-schema.md) for the full field shapes.

**Static vs evidence provenance (spec 020 FR-017).** `impactReqs` now includes REQs reached two ways: **static** (an `@impl` declaration or a structural edge like `imports`/`contains` — a claim or a mechanical fact) and **evidence** (a coverage-derived `exercises` edge — a REQ's tagged tests were observed actually running the changed code). `reqProvenance` tells you which; a REQ can carry both if a declared `@impl` is also corroborated by evidence. Both fields — and `testsToRun` — are omitted entirely when no trace artifact is configured (FR-010, byte-identical pre-spec-020 output); do not expect them on a trace-less project. A stale `exercises` edge (source changed since the trace was captured) is excluded from `reqProvenance` under `trace.staleness: "exclude"`, so evidence-only REQs can silently drop out after an edit — re-run tests to refresh if that looks wrong.

**Same-spec siblings are not blast radius.** `impactReqs` only contains REQs the edit actually reaches — through code (`@impl`, `imports`) or explicit spec relations (`depends_on` / `derives_from`). A REQ that merely lives in the same `spec.md` as a reached REQ, with no code or dependency link of its own, does **not** appear in `impactReqs` / `affectedFiles` / `drifted`, even under the common Spec Kit / Kiro layout of "one spec.md, many REQs". Its parent spec doc still shows up in `affectedDocs` so you can open that file for full feature context, but don't treat every REQ inside it as touched by this edit — cite only the REQs actually listed in `impactReqs`.

**Method units are in-file precision queries.** A `path:ClassName.methodName` start id (`src/auth.ts:Sample.methodA`; `default.methodName` for a default-export class) resolves to that method's own symbol. Its `impactReqs` contains only the REQs the method itself claims or reaches — **not** sibling methods' REQs and **not** a REQ claimed directly above the `class` declaration (that is the class-contract claim). Its `affectedFiles` does **not** include consumer files that import the class: the intentional trade is precision inside the file. When the user needs the consumer-side blast radius, use the class unit (`src/auth.ts:Sample`), the file unit, or `--diff` — the class unit expands forward through class→method containment to every method's REQs. Two caveats: consumers bounding the traversal depth (the programmatic `maxDepth` option) need one extra hop — class→method→REQ is 2 hops instead of the pre-method-grain 1; and method symbols exist only on their origin file, so `barrel.ts:Sample.methodA` fails with `unresolvedSymbol` — target the origin file directly.

### 4. Inject into the response

Use the parsed output to:
- Cite each `impactReqs` ID so changes to those requirements are explicit in the edit.
- Flag **Drift candidates** = `impactReqs \ originReqs`. In text output they appear under `Drift candidates:`; in JSON, compute the set difference yourself. A non-empty difference means either (a) the symbol has grown to reach a REQ it should now `@impl`-claim, or (b) the spec graph added a `depends_on` the symbol has not caught up to. Treat both as a prompt to update `@impl` tags or the spec. **Exception (c) — the entry is a barrel-side namespace re-export**: `barrel.ts:ns` where `ns` is defined by `export * as ns from "./o"` (S2) or `import * as ns from "./m"; export { ns }` (S3-namespace). In this case `entryOriginIds` cannot follow the `symbol:barrel#ns → file:O` file-grain edge, so `originReqs` is empty and every reached REQ appears as a drift candidate. **This is expected and does not require `@impl` on the barrel — the barrel is a re-export shim, not an implementation site.** If you see this pattern, either (i) switch the entry to file-level (`barrel.ts`) to include all origin REQs, or (ii) target the underlying origin directly (`o.ts:actualSymbol`).
- Flag any `drifted` entries — block the edit until the user runs `artgraph reconcile`.
- Cross-check that the edit does not silently change `affectedFiles` outside its declared scope.
