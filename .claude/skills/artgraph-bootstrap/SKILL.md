---
name: "artgraph-bootstrap"
description: "Bootstraps spec ↔ code ↔ test traceability tags in an existing project by proposing spec entries and `[REQ-NNN]` markers on covering test titles as a reviewable diff (code-side `@impl REQ-NNN` tags only where no test exists), then verifying deterministically with `artgraph scan && artgraph check` and, when tests ran with the artgraph/vitest runner, `artgraph trace report`. Use when the user asks to bootstrap / cold-start / seed traceability / add initial REQs to an untagged or partially-tagged project. Make sure to use this skill whenever the user mentions bootstrap / cold-start / initial REQ seeding for artgraph."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(bunx --no-install artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(ls *)"
  - "Bash(git diff *)"
  - "Bash(test *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Cold-starts traceability on a project that has few or no REQ tags today. Where a covering test already exists for a candidate requirement, the agent (probabilistically) proposes ONLY the test-side closure — a `- REQ-NNN:` spec entry plus a `[REQ-NNN]` marker on the covering test title — and does NOT touch implementation code; once the user approves and the tests run, the coverage-derived `exercises` edge corroborates (or contradicts) the tag mechanically, no LLM needed. Only in areas with no test to tag at all does the agent fall back to the older code-side proposal (spec entry + `// @impl REQ-NNN`), and the proposal must say so explicitly. This split — LLM proposes, artgraph verifies deterministically — is the **determinism boundary**: link generation may be probabilistic, but link verification must be reproducible without an LLM in the loop. The Skill never writes trace tags without first showing a diff and getting explicit user approval.

## Preconditions

Committed clean working tree recommended: uncommitted changes cannot be cleanly rolled back with `git reset` if the user approves apply.

## Steps

Every Bash tool call is a **fresh shell** — variables do not persist across calls; carry the detected PM and any per-step counts forward as plain text in your reasoning, not shell variables. `<PM-exec>` is the project's package runner — `npx artgraph`, `pnpm exec artgraph`, `bunx artgraph`, or `deno run -A npm:artgraph/cli` — substitute the one detected by `_shared/package-manager.md` (or `.artgraph.json#packageManager`).

### 1. Confirm artgraph is installed

See [install-check](../_shared/install-check.md) for the standard pre-flight check. For this Skill the probe is expected to **succeed** — if it fails, tell the user "artgraph is not installed; run the `artgraph-setup` Skill first" and stop. Do not attempt to install it inline; setup owns package-manager detection and the full init flow.

### 2. Snapshot current graph state

Scan the graph, noting node counts (`req`, `doc`, `file`, `test`): `<PM-exec> scan --format json`. Then, using your host's search tooling, count how many source files already carry an `@impl REQ-` marker (search the project's source extensions, excluding `node_modules/`, `dist/`, `.git/`, for the literal string `@impl REQ-`) — silence "permission denied" / "no matches" noise, you only need the count of files with at least one match. Silently decide the ID-numbering path — **do not expose this as a mode flag**: **cold path** (`req == 0`, no `@impl REQ-` matches) proposes fresh IDs from `REQ-001`; **augment path** (REQs or `@impl` tags already present) allocates new IDs from `max(existing REQ-ID) + 1` — read the current spec first (Step 4) to preserve its existing sequence.

### 3. Scope gating

The user may narrow scope with an argument such as `src/auth/`; otherwise use `.artgraph.json`'s `include` globs. Using your host's file-listing tooling, count source files under `<scope>` (project's source extensions, excluding `node_modules/`, `dist/`, `.git/`) and spec files under `<specDir>` (default `specs/`) matching `*.md` recursively — Step 4 reads every spec file regardless of the source scope gate. Report both counts. If either count is > 50, do **not** proceed: tell the user verbatim "The scope is too broad for reliable single-pass estimation ({N} source files / {M} spec files); ask me again with a narrower target such as `src/<subdir>/`," naming the specific offending count, and stop. Do **not** attempt auto-partitioning in v1.

### 4. Read & propose

Read every existing spec file under `.artgraph.json#specDirs`, `README.md` (and `docs/` if present) for domain vocabulary, and every source file plus every test file under the gated scope; in augment mode also skim the whole project (same scope as Step 2's grep) for orphaned `@impl` tags so proposed IDs stay disjoint. For **each** candidate requirement, decide its path independently — this is a per-REQ decision, not a project-wide mode:

- **Test-tag path (default, FR-019)** — a covering test exists (or a near-miss `it()`/`describe()` clearly exercises the behavior but lacks the marker): propose only (1) a `- REQ-NNN: <one-sentence requirement>` spec entry (match the project's ID prefix / structural convention — see `src/grammar/tokens.ts` and `examples/kiro-integration/`) and (2) a `[REQ-NNN]` prefix on that test's name. Propose **no code edit** for this REQ.
- **Impl-fallback path (only when no test exists to tag)** — propose the spec entry plus a `// @impl REQ-NNN` line directly **above** the exported declaration (or above its JSDoc) in the target language's comment syntax; state in the proposal that this REQ is falling back because no test covers it. Do NOT place the tag trailing after the declaration or inside a `/** */` block (silently binds to the file or the next symbol), and one tag does not cover a run of consecutive exports. For TypeScript classes exported inline (`export class` / `export default class`), prefer tagging directly **above the individual member** when different methods implement different REQs — methods, getters/setters, `constructor`, static members, and arrow-function class properties each get their own `ClassName.methodName` symbol, so a per-member tag binds at method grain; a tag above the `class` declaration claims the class contract as a whole, and members that are not symbolized (computed names, private `#members`, plain data properties) fall back to the class symbol.

Present the whole proposal as a unified diff-style preview grouped by REQ, each line labeled `[test-tag]` or `[impl-fallback: no test]`, prefixed with a summary — "Proposing {K} REQs: {T} test-tag, {F} impl-fallback. Cold-path: fresh IDs from REQ-001. (Or: Augment-path: adding REQ-{next}..REQ-{last}.)".

### 5. User approval

Wait for **explicit** user approval before writing anything. Support three responses:

- **"apply all"** — write every proposed edit as shown.
- **"apply only REQ-001 and REQ-003"** (any subset) — write only the named IDs; drop the rest silently.
- **"edit"** — the user rewrites the proposal and hands it back; treat the returned text as the new source of truth and re-enter Step 5 with the revised diff.

If the user rejects outright, stop cleanly without writing. Never apply on ambiguous responses ("looks good", "sure") without a confirming keyword — ask once more.

### 6. Deterministic verification

Write the approved edits. If the project has `vitest.config.ts` configured with the `artgraph/vitest` runner (`runner: 'artgraph/vitest'` or `withTrace(...)`), ask the user to run the test suite (or run it yourself if already permitted) so a trace shard lands under `.artgraph/trace/`, then run `<PM-exec> trace report --format json` to cross-check the newly-tagged tests against execution evidence *before* touching the graph: a `suggestedImpls` entry whose symbol plausibly matches the REQ's spec text corroborates the tag; an `unexercisedClaims` entry or a nonzero `diagnostics.dangling` pointing at a newly tagged test means the tag doesn't reach the code it claims — propose a concrete fix (retag, move the assertion, or reword the spec) and return to Step 5 instead of silently accepting.

Still under the runner-configured case: if **any** approved REQ used the test-tag path, check `.artgraph.json` for `"trace": {"acceptExercises": true}` **before** running the graph-side commands below. Test-tag REQs only ever produce a `verifies` edge (the test title marker), never an `implements` edge — `check`'s `exercised` coverage status is opt-in and defaults to `false` (see `docs/configuration.md`), so without this flag every test-tag REQ reports `untagged`/`uncovered` **forever**, even once `trace report`'s `suggestedImpls` has corroborated it above. `check` itself now flags this: read its stdout for a `HINT:` line (or the `exercisableUncovered` field in `--format json`) naming exactly the REQs this affects. If `trace.acceptExercises` is absent, fold adding it into the same approval flow as Step 5 — propose the `.artgraph.json` diff alongside the tag edits (this Skill's rule that every write goes through user approval applies to config edits too) — then write it once approved, before running the commands below. If the setting is already present (`true` or an explicit `false` the user has chosen to keep), leave it alone.

If no runner is configured, trace shards stay empty (trace is opt-in, FR-010) — skip straight to the graph-side commands below; note that any test-tag REQs will report `uncovered` there until the `artgraph/vitest` runner is wired up and the suite has run (`acceptExercises` alone cannot rescue them without execution evidence — propose runner setup, not the flag, if the user wants those REQs covered).

```bash
<PM-exec> scan
<PM-exec> reconcile
<PM-exec> check
```

Report the outcome. A clean `check` exit is the success condition — `reconcile` is what wrote the trace lock, and `check` verifies the project now has a consistent, real traceability graph. This runs without `--gate`, so exit 0 does not guarantee a clean graph — read the stdout categories (`drift`, `uncovered`, `orphan`, `duplicate-id`, `impl-only`, and, once a trace exists, `unexercisedClaims` / `suggestedImpls` / `staleEvidence` / the `acceptExercises` `HINT:`) rather than relying on the exit code alone. If any are reported, offer to re-propose fixes scoped to just those gaps (return to Step 4 with the gap list as the new target set):

- `duplicate-id` — the same REQ ID was claimed in more than one place; resolve by renaming one of the collisions (see the `artgraph-rename` Skill) before re-running `check`.
- `impl-only` — how the impl-fallback REQs from Step 4 resurface after verification: the code tag exists but no test covers it yet. Non-fatal, but worth following up.
- `uncovered` REQs that went the test-tag path — before proposing anything else, check whether the `HINT:` explains it (missing `trace.acceptExercises`) or whether the runner was never configured (no execution evidence at all); either way that's the fix, not a re-propose.

Do not silently re-scan and re-apply — every write goes through user approval.

## When to stop

- `check` exits 0 with no `drift` / `uncovered` / `orphan` / `duplicate-id` (`impl-only` alone is non-fatal) → **done**; hand off to the user. If `uncovered` REQs remain and they all went the test-tag path, verify the `trace.acceptExercises` / runner setup question was addressed per Step 6 before treating this as a real gap.
- User rejects the proposal in Step 5 → **done**; stop cleanly with no writes.
- Scope from Step 3 is too broad (> 50 files) → **done**; ask for a narrower target and re-enter from Step 1 on the next invocation.
- Two revision rounds through Step 4 → Step 5 still fail to produce an approvable proposal → **done**; hand off for manual editing.
