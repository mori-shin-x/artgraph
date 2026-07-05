---
name: "artgraph-bootstrap"
description: "Bootstraps spec ↔ code ↔ test traceability tags in an existing project by proposing spec entries, `@impl REQ-NNN` tags on code, and `[REQ-NNN]` markers on tests as a reviewable diff, then verifying deterministically with `artgraph scan && artgraph check`. Use when the user asks to bootstrap / cold-start / seed traceability / add initial REQs to an untagged or partially-tagged project. Make sure to use this skill whenever the user mentions bootstrap / cold-start / initial REQ seeding for artgraph."
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

Cold-starts traceability on a project that has few or no REQ tags today. The agent (probabilistically) reads the existing spec and source and proposes an initial set of `- REQ-NNN:` spec entries, `// @impl REQ-NNN` code tags, and `[REQ-NNN]` test markers as a single reviewable diff; then artgraph (deterministically) verifies the result with `scan`, `reconcile`, and `check`. This split — LLM proposes, CLI verifies — is the **determinism boundary**: link generation may be probabilistic, but link verification must be reproducible without an LLM in the loop. The Skill never writes trace tags without first showing a diff and getting explicit user approval.

## Preconditions

Committed clean working tree recommended: uncommitted changes cannot be cleanly rolled back with `git reset` if the user approves apply.

## Steps

Every Bash tool call is a **fresh shell** — variables do not persist across calls; carry the detected PM and any per-step counts forward as plain text in your reasoning, not shell variables. `<PM-exec>` is the project's package runner — `npx artgraph`, `pnpm exec artgraph`, `bunx artgraph`, or `deno run -A npm:artgraph/cli` — substitute the one detected by `_shared/package-manager.md` (or `.artgraph.json#packageManager`).

### 1. Confirm artgraph is installed

See [install-check](../_shared/install-check.md) for the standard pre-flight check. For this Skill the probe is expected to **succeed** — if it fails, tell the user "artgraph is not installed; run the `artgraph-setup` Skill first" and stop. Do not attempt to install it inline; setup owns package-manager detection and the full init flow.

### 2. Snapshot current graph state

Scan the graph, noting node counts (`req`, `doc`, `file`, `test`):

```
<PM-exec> scan --format json
```

Then, using your host's search tooling, count how many source files in the project already carry an `@impl REQ-` marker — search text files matching the project's source extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.py`, `.go`, `.rs`, `.java`), excluding `node_modules/`, `dist/`, and `.git/`, for the literal string `@impl REQ-`. Silence "permission denied" / "no matches" noise; you only need the count of files with at least one match. Compose the search with whatever tool fits your environment (POSIX `grep -rl`, ripgrep, PowerShell `Select-String`, or your file-search API).

Silently decide the path — **do not expose this as a mode flag**: **cold path** (`req == 0`, no `@impl REQ-` matches) proposes fresh IDs from `REQ-001`; **augment path** (REQs or `@impl` tags already present) allocates new IDs from `max(existing REQ-ID) + 1` — read the current spec first (Step 4) to preserve its existing sequence.

### 3. Scope gating

The user may narrow scope with an argument such as `src/auth/`; otherwise use `.artgraph.json`'s `include` globs. Count candidate source files under that scope, then the existing spec files under `.artgraph.json#specDirs` (default `specs/`) — Step 4 reads every spec file regardless of the source scope gate.

Using your host's file-listing tooling, count:

- source files under `<scope>` matching the project's source extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.py`, `.go`, `.rs`, `.java`), excluding `node_modules/`, `dist/`, and `.git/`.
- spec files under `<specDir>` matching `*.md` (recursive).

Report both counts. If either count is > 50, do **not** proceed. Tell the user verbatim: "The scope is too broad for reliable single-pass estimation ({N} source files / {M} spec files); ask me again with a narrower target such as `src/<subdir>/`," naming the specific offending count, and stop. Do **not** attempt auto-partitioning in v1.

### 4. Read & propose

Read the sources needed to draft a coherent proposal:

- Every existing spec file under `.artgraph.json#specDirs` (default `specs/`).
- `README.md` (and `docs/` if present) for domain vocabulary and phrasing.
- Every source file under the gated scope from Step 3. In augment mode, also skim **the whole project** — the same project-wide scope as Step 2's grep, not the Step 3 scope gate — for files already carrying `@impl` tags, so proposed IDs stay disjoint; this catches orphaned `@impl REQ-NNN` tags whose spec entry was manually deleted, which would otherwise silently collide with newly-allocated IDs.

Draft, for each intended REQ, all three sides of the traceability closure:

1. **Spec entry** — a `- REQ-NNN: <one-sentence requirement>` line appended to an appropriate `specs/*.md` file (prefer an existing one; if none exists, propose creating `specs/main.md` and note it in the diff header). If the project uses a different ID prefix convention (e.g. `AUTH-`, `FR-`, or Kiro's `### Requirement N:` heading style — see `src/req-id.ts` for the accepted grammar `[A-Z][A-Za-z]*-\d+|Requirement-\d+`), match that instead of defaulting to `REQ-`, and follow the spec's structural convention (bullets stay bullets, `### Requirement N: Title` headings stay headings — see `examples/kiro-integration/.kiro/specs/auth/requirements.md` for the Kiro pattern).
2. **Impl tag** — a `// @impl REQ-NNN` line on the implementing function/class/module, one per REQ per symbol, using the target language's comment syntax.
3. **Test marker** — a `[REQ-NNN]` prefix on the covering `it()`/`describe()` name; if no test exists, mark the REQ **test-missing** in the summary rather than fabricating one.

Present the whole proposal as a unified diff-style preview, grouped by REQ (spec entry, then code tag(s), then test marker(s)), prefixed with a summary line — "Proposing {K} REQs, {J} `@impl` tags, {M} test markers. Cold-path: fresh IDs from REQ-001. (Or: Augment-path: adding REQ-{next}..REQ-{last}.)" — and call out any **test-missing** REQ so the user knows the closure is incomplete for that ID.

### 5. User approval

Wait for **explicit** user approval before writing anything. Support three responses:

- **"apply all"** — write every proposed edit as shown.
- **"apply only REQ-001 and REQ-003"** (any subset) — write only the named IDs; drop the rest silently.
- **"edit"** — the user rewrites the proposal and hands it back; treat the returned text as the new source of truth and re-enter Step 5 with the revised diff.

If the user rejects outright, stop cleanly without writing. Never apply on ambiguous responses ("looks good", "sure") without a confirming keyword — ask once more.

### 6. Deterministic verification

After writing the approved edits, run the three CLI calls that establish the determinism boundary. `scan` and `check` alone never write `.trace.lock` — only `reconcile` does, so it must run between them:

```bash
<PM-exec> scan
<PM-exec> reconcile
<PM-exec> check
```

Report the outcome. A clean `check` exit is the success condition — `reconcile` is what wrote the trace lock, and `check` verifies the project now has a consistent, real traceability graph. This invocation runs without `--gate`, so exit 0 does not guarantee a clean graph — read the stdout categories (`drift`, `uncovered`, `orphan`, `duplicate-id`, `impl-only`) rather than relying on the exit code alone. If any are reported, offer to re-propose fixes scoped to just those gaps (return to Step 4 with the gap list as the new target set):

- `duplicate-id` — the same REQ ID was claimed in more than one place; resolve by renaming one of the collisions (see the `artgraph-rename` Skill) before re-running `check`.
- `impl-only` — this is how the **test-missing** REQs from Step 4 resurface after verification: the code tag exists but no test covers it yet. Non-fatal, but worth following up.

Do not silently re-scan and re-apply — every write goes through user approval.

## When to stop

- `check` exits 0 with no `drift` / `uncovered` / `orphan` / `duplicate-id` (`impl-only` alone is non-fatal) → **done**; hand off to the user.
- User rejects the proposal in Step 5 → **done**; stop cleanly with no writes.
- Scope from Step 3 is too broad (> 50 files) → **done**; ask for a narrower target and re-enter from Step 1 on the next invocation.
- Two revision rounds through Step 4 → Step 5 still fail to produce an approvable proposal → **done**; hand off for manual editing.
