---
name: "artgraph-rename"
description: "Performs a safe rename / split / merge of requirement IDs across spec, code, tests, and lock. Use when the user asks to rename a REQ ID, split one ID into multiple, or merge multiple IDs into one. Make sure to use this skill whenever requirement IDs are being restructured."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(bunx --no-install artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(git status*)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

The agent runs `artgraph rename` (or its `--split` / `--merge` variants) to safely rewrite a requirement ID across spec lists/headings, `@impl` tags, test `[ID]` tags, frontmatter `depends_on` / `derives_from`, and `.trace.lock`. The operation is destructive and writes directly to tracked files — always run `--dry-run` first.

## Preconditions

- Working tree must be committed — `artgraph rename` writes directly to tracked files, and an uncommitted state makes the change irreversible.
- Target IDs must be in a form artgraph re-scans: `REQ-001`, `auth/FR-2`, `doc:xxx`. Forms like `REQ-COMBINED` or `REQ-001a` are rejected.

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check.

> `<PM-exec>` is the project's package runner: `npx` (npm), `pnpm exec`, `bunx`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

### 2. Confirm git is clean

```bash
git status --porcelain
```

The output must be empty. If anything is listed, instruct the user to commit (or stash) before continuing — rename mutates tracked files in place and a dirty tree mixes manual edits with the rewrite.

### 3. Dry-run the rewrite

Pick the command shape that matches the user's intent and add `--dry-run`:

```bash
# rename
<PM-exec> rename --from REQ-001 --to REQ-100 --dry-run
# split (1 → many)
<PM-exec> rename --split REQ-001 --into REQ-101 REQ-102 --dry-run
# merge (many → 1)
<PM-exec> rename --merge REQ-001 REQ-002 --into REQ-100 --dry-run
```

The dry-run prints the files, lines, and lock keys that will change. Show the diff summary to the user and get explicit confirmation before applying.

### 4. Apply

Re-run the same command without `--dry-run`. The lock is auto-reconciled — `contentHash`, references, and `specFile` for the rewritten nodes are refreshed in `.trace.lock`.

### 5. Follow-up

For **split** and **merge**, additional manual work is required (new `@impl` assignments, scaffold TODO lines, leftover sub-bullets from old headings). See [lifecycle-flows](./references/lifecycle-flows.md) for the full handling.

For a plain **rename**, no follow-up edits are needed.

### 6. Re-check

```bash
<PM-exec> check
```

- **rename** and **merge** should pass immediately.
- **split** leaves the new IDs as `uncovered` until `@impl` is added at the candidate files. Re-run `<PM-exec> check` after assigning the tags.

## Output format

Pass `--format json` for scripted use; on error the payload is `{ "error": "..." }`. See [output schema](../_shared/output-schema.md) for the success shape of `artgraph rename`.
