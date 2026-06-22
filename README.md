# spectrace

Typed artifact graph for TS/JS — trace specs, docs, code, and tests bidirectionally.

spectrace builds a graph that links requirement IDs in your specs to the code that
implements them (`@impl` tags) and the tests that verify them (`[ID]` / `req:` tags),
then detects **drift** (spec changed but code/tests didn't), **orphans**, and
**uncovered** requirements.

## Install

```bash
npm install -D spectrace
npx spectrace init      # writes .spectrace.json
```

## How references are expressed

| Artifact            | Reference form                                  |
| ------------------- | ----------------------------------------------- |
| Spec list item      | `- REQ-001: description`                        |
| Spec heading (Kiro) | `### Requirement 1: description`                |
| Implementation      | `// @impl REQ-001`                              |
| Test                | `it("[REQ-001] …")` or `// req: "REQ-001"`      |
| Doc relations       | frontmatter `spectrace.depends_on` / `derives_from` |

Custom grammars are configurable via `reqPatterns` in `.spectrace.json`.

## Commands

| Command               | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `spectrace scan`      | Build the artifact graph and report counts                     |
| `spectrace check`     | Report drift / orphans / uncovered (`--gate` to fail a hook)   |
| `spectrace coverage`  | Per-requirement coverage status                                |
| `spectrace impact`    | Impact analysis (`--diff` scopes to the git diff)              |
| `spectrace reconcile` | Rebuild `.trace.lock` from the current graph                   |
| `spectrace graph`     | Emit the graph (dot / json)                                    |
| `spectrace rename`    | Rename / split / merge requirement IDs (see below)             |

## `spectrace rename` — ID lifecycle

Renames, splits or merges a requirement ID and rewrites **every** reference to it
(spec list items / headings, `@impl` tags, test tags, frontmatter
`depends_on` / `derives_from`, and `.trace.lock` keys) in one pass, limited to
git-tracked files.

```bash
# Rename one ID
spectrace rename --from REQ-001 --to REQ-100

# Split one ID into several (code @impl tags are flagged for manual re-assignment)
spectrace rename --split REQ-001 --into REQ-101 REQ-102

# Merge several IDs into one
spectrace rename --merge REQ-001 REQ-002 --into REQ-100

# Preview without writing
spectrace rename --from REQ-001 --to REQ-100 --dry-run

# Machine-readable output (errors are emitted as JSON too)
spectrace rename --from REQ-001 --to REQ-100 --format json
```

Notes:

- **Always commit first** — rename writes to tracked files in place. Use `--dry-run`
  to preview.
- **Target IDs are validated**: they must match the requirement-ID grammar
  (`REQ-001`, `auth/FR-2`, `Requirement-3`) or the `doc:` prefix, so the renamed ID
  is guaranteed to be re-discoverable by the next scan.
- After a non-preview run the lock is automatically reconciled, so `spectrace check`
  passes immediately for `rename` and `merge`.
- **split** intentionally does **not** re-assign `@impl` tags (the mapping is
  ambiguous); the new IDs are reported as `uncovered` until you assign them and fill
  in their scaffolded spec lines. `check` will flag this until done.
- IDs inside fenced code blocks are treated as examples and left untouched.

## Claude Code skills

spectrace ships Claude Code skills (`spectrace-plan`, `spectrace-verify`,
`spectrace-coverage`, `spectrace-rename`). See [docs/skills-guide.md](docs/skills-guide.md).
