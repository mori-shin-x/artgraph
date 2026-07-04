# Split / merge lifecycle details

Reference for the follow-up work `artgraph rename` does NOT perform automatically.
Consult this after step 5 of the parent SKILL whenever the operation is a `--split`
or `--merge`. A plain `--from / --to` rename has no follow-up.

## Split (1 → many)

When `artgraph rename --split <old> --into <new1> <new2> ...` is applied:

- New IDs are created in `.trace.lock` with `contentHash` computed from the new spec text. The old ID's lock entry is removed.
- `@impl` tags are NOT auto-assigned. The old `@impl <old-id>` is stripped from every call site, but the agent must decide which new ID each previous implementation belongs to and add `@impl <new-id>` near the relevant symbol by hand.
- The CLI prints a list of candidate files that previously carried `@impl <old-id>`. Walk that list; for each file, open it, locate the symbol that implemented the old requirement, and reassign the tag to the appropriate new ID.
- Adjacent to each newly assigned `@impl`, scaffold a TODO line so the remaining work is trackable from the source:

  ```ts
  // TODO(REQ-101): describe split-off behavior
  // @impl REQ-101
  function newBehavior() { ... }
  ```

- If a single function legitimately covers two of the new IDs, attach both tags (`@impl REQ-101` and `@impl REQ-102`) — the lock supports multiple impl references per node.
- Until `@impl` is added for every new ID, those IDs surface as `uncovered` in `artgraph check`. Re-run `artgraph check` after each assignment to confirm coverage; do not commit while any of the new IDs are still `uncovered`.

### Worked split example

Splitting `REQ-001` (auth login) into `REQ-101` (password login) and `REQ-102` (OAuth login):

1. `artgraph rename --split REQ-001 --into REQ-101 REQ-102 --dry-run` reports edits to `specs/auth.md`, `src/auth.ts`, `tests/auth.spec.ts`, plus lock rewrites.
2. Apply without `--dry-run`. The lock now has `REQ-101` and `REQ-102`; `REQ-001` is gone.
3. CLI candidate list includes `src/auth.ts:42` (password path) and `src/auth.ts:88` (OAuth path). Add `@impl REQ-101` above the password function and `@impl REQ-102` above the OAuth function.
4. `artgraph check` reports both new IDs `verified` (tests inherited) and `impl-only` resolves once tags land.

## Merge (many → 1)

When `artgraph rename --merge <src1> <src2> ... --into <target>` is applied:

- The target ID inherits the union of the source IDs' `@impl` and `@verify` references — no edits at call sites are needed; the tags already in source files are rewritten in place to the target ID.
- Test `[ID]` / `req:` tags pointing at any of the source IDs are likewise rewritten to the target. Verification status carries over.
- Frontmatter `depends_on` / `derives_from` lists from the merged spec headings are unioned and de-duplicated under the target heading. Self-references that arise from the union (e.g. `depends_on: REQ-100` under heading `REQ-100`) are dropped automatically.
- Sub-bullets that were children of the merged headings remain in place under the (now-single) target heading. The agent should manually consolidate or remove duplicates if the merged bullets overlap in meaning — the CLI cannot judge semantic redundancy.
- `.trace.lock` keys for the source IDs are removed; one new key for the target is added with a fresh `contentHash` computed from the consolidated heading body.

### Worked merge example

Merging `REQ-010` and `REQ-011` (two near-duplicate session-handling requirements) into `REQ-100`:

1. `artgraph rename --merge REQ-010 REQ-011 --into REQ-100 --dry-run` reports lock removals for `REQ-010` / `REQ-011`, a new lock entry for `REQ-100`, and tag rewrites across `src/session.ts` and `tests/session.spec.ts`.
2. Apply without `--dry-run`. All existing `@impl REQ-010` / `@impl REQ-011` become `@impl REQ-100`; tests retag the same way.
3. Open `specs/session.md`: the heading is now `REQ-100`, but the original sub-bullets from both source headings are still present. Consolidate any duplicates by hand.
4. `artgraph check` passes immediately — no manual `@impl` reassignment was required.

## Edge cases

- **Target ID already exists.** `artgraph rename` exits with `{ "error": "target id <id> already exists" }`. Resolve by picking an unused ID or by first merging the existing target away.
- **Source ID not in the lock.** Exits with `{ "error": "source id <id> not found" }`. Run `artgraph reconcile` first if the spec was edited without reconciliation, otherwise verify the ID spelling.
- **Partial overlap on split.** If one of the `--into` targets is already a sibling that exists in the lock, the CLI errors before writing anything. Remove the existing sibling from the `--into` list or merge it in separately afterward.
- **Mixed-form IDs.** Forms like `REQ-001a` or `REQ-COMBINED` are rejected up-front because they cannot be re-scanned. Normalize the spec to the supported forms (`REQ-001`, `auth/FR-2`, `doc:xxx`) before invoking rename.
- **Dirty working tree.** Even at this layer, a non-empty `git status --porcelain` aborts the run. Commit or stash first; never bypass with `--force` (no such flag exists by design).
