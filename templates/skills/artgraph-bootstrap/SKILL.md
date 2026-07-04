---
name: "artgraph-bootstrap"
description: "Bootstraps spec ↔ code ↔ test traceability tags in an existing project by proposing spec entries, `@impl REQ-NNN` tags on code, and `[REQ-NNN]` markers on tests as a reviewable diff, then verifying deterministically with `artgraph scan && artgraph check`. Use when the user asks to bootstrap / cold-start / seed traceability / add initial REQs to an untagged or partially-tagged project. Make sure to use this skill whenever the user mentions bootstrap / cold-start / initial REQ seeding for artgraph."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(ls *)"
  - "Bash(cat *)"
  - "Bash(find *)"
  - "Bash(wc *)"
  - "Bash(git diff *)"
  - "Bash(command *)"
  - "Bash(test *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Cold-starts traceability on a project that has few or no REQ tags today. The agent (probabilistically) reads the existing spec and source and proposes an initial set of `- REQ-NNN:` spec entries, `// @impl REQ-NNN` code tags, and `[REQ-NNN]` test markers as a single reviewable diff; then artgraph (deterministically) verifies the result with `scan` and `check`. This split — LLM proposes, CLI verifies — is the **determinism boundary**: link generation may be probabilistic, but link verification must be reproducible without an LLM in the loop. The Skill never writes trace tags without first showing a diff and getting explicit user approval.

## Steps

Every Bash tool call is a **fresh shell** — variables do not persist across calls. Each step below is one self-contained Bash invocation; carry the detected PM and any per-step counts across steps as plain text in your reasoning, not as shell variables.

> `<PM-exec>` is the project's package runner: `npx artgraph`, `pnpm exec artgraph`, `bunx artgraph`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

### 1. Confirm artgraph is installed

See [install-check](../_shared/install-check.md) for the standard pre-flight check. For this Skill the probe is expected to **succeed** — if it fails, tell the user "artgraph is not installed; run the `artgraph-setup` Skill first" and stop. Do not attempt to install it inline; setup owns package-manager detection and the full init flow.

### 2. Snapshot current graph state

Run one Bash call to scan the graph and one to grep for existing `@impl` claims:

```bash
<PM-exec> scan --format json
```

Parse the JSON and note the node counts (`req`, `doc`, `file`, `test`). Then in a second call:

```bash
find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' \) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' -exec grep -l '@impl REQ-' {} + 2>/dev/null | wc -l
```

Silently decide the path — **do not expose this as a mode flag**:

- **Cold path** — `req == 0` and no files carry `@impl REQ-`: propose fresh IDs starting from `REQ-001`.
- **Augment path** — REQs or `@impl` tags already present: propose additions to the existing spec, allocating new IDs starting from `max(existing REQ-ID) + 1`. Read the current spec first (Step 4) to preserve the existing ID sequence.

### 3. Scope gating

The user may narrow the scope with an argument such as `src/auth/`; otherwise use the `include` globs from `.artgraph.json`. Count the candidate source files under that scope:

```bash
find <scope> -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' \) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' | wc -l
```

If the count is > 50, do **not** proceed. Tell the user verbatim: "The scope is too broad for reliable single-pass estimation ({N} files); ask me again with a narrower target such as `src/<subdir>/`." and stop. Do **not** attempt auto-partitioning in v1.

### 4. Read & propose

Read the sources needed to draft a coherent proposal:

- Every existing spec file under `.artgraph.json#specDirs` (default `specs/`). Preserve their existing `- REQ-NNN:` sequence in augment mode.
- `README.md` (and `docs/` if present) for domain vocabulary and phrasing.
- Every source file under the gated scope from Step 3. In augment mode, also skim files that already carry `@impl` tags so proposed IDs stay disjoint.

Draft, for each intended REQ, all three sides of the traceability closure:

1. **Spec entry** — a `- REQ-NNN: <one-sentence requirement>` line appended to an appropriate `specs/*.md` file. Prefer an existing spec file; if none exists, propose creating `specs/main.md` and note it explicitly in the diff header.
2. **Impl tag** — a `// @impl REQ-NNN` line placed on the implementing function, class, or module in code. One `@impl` line per REQ per implementing symbol; use the comment syntax matching the target language.
3. **Test marker** — a `[REQ-NNN]` marker prefixing the relevant `it()` or `describe()` name in the covering test. If no test exists, mark the REQ as **test-missing** in the summary rather than fabricating one.

Present the whole proposal as a unified diff-style preview, grouped by REQ (spec entry, then code tag(s), then test marker(s) for that ID). Prefix with a summary line:

> Proposing {K} REQs, {J} `@impl` tags, {M} test markers. Cold-path: fresh IDs from REQ-001. (Or: Augment-path: adding REQ-{next}..REQ-{last}.)

Call out any REQ with **test-missing** so the user knows the closure is not complete for that ID.

### 5. User approval

Wait for **explicit** user approval before writing anything. Support three responses:

- **"apply all"** — write every proposed edit as shown.
- **"apply only REQ-001 and REQ-003"** (any subset) — write only the entries for the named IDs; drop the rest silently.
- **"edit"** — the user rewrites the proposal and hands it back; treat the returned text as the new source of truth and re-enter Step 5 with the revised diff.

If the user rejects outright, stop cleanly without writing. Never apply on ambiguous responses ("looks good", "sure") without a confirming keyword — ask once more.

### 6. Deterministic verification

After writing the approved edits, run the two CLI calls that establish the determinism boundary:

```bash
<PM-exec> scan
```

```bash
<PM-exec> check
```

Report the outcome. A clean `check` exit is the success condition — the trace lock is now consistent and the project has a real traceability graph. If `check` reports `drift`, `uncovered`, or `orphan` entries, list each one and offer to re-propose fixes scoped to just those gaps (return to Step 4 with the gap list as the new target set). Do not silently re-scan and re-apply — every write goes through user approval.

## When to stop

- `<PM-exec> check` exits 0 → **done**. The bootstrap succeeded; hand off to the user.
- User rejects the proposal in Step 5 → **done**. Stop cleanly; no writes.
- Scope from Step 3 is too broad (> 50 files) → **done**. Ask the user for a narrower target and re-enter from Step 1 on the next invocation.
- Two revision rounds through Step 4 → Step 5 still fail to produce an approvable proposal → **done**. Hand off to the user for manual editing; the LLM has exhausted its useful pass on this scope.
