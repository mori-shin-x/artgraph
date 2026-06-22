# artgraph

Typed artifact graph for TS/JS — trace specs, docs, code, and tests bidirectionally.

artgraph builds a graph that links requirement IDs in your specs to the code that
implements them (`@impl` tags) and the tests that verify them (`[ID]` / `req:` tags),
then detects **drift** (spec changed but code/tests didn't), **orphans**, and
**uncovered** requirements.

## Install

```bash
npm install -D artgraph
npx artgraph init      # writes .artgraph.json
```

## How references are expressed

| Artifact            | Reference form                                  |
| ------------------- | ----------------------------------------------- |
| Spec list item      | `- REQ-001: description`                        |
| Spec heading (Kiro) | `### Requirement 1: description`                |
| Implementation      | `// @impl REQ-001`                              |
| Test                | `it("[REQ-001] …")` or `// req: "REQ-001"`      |
| Doc relations       | frontmatter `artgraph.depends_on` / `derives_from`, inferred from kiro / spec-kit file-name conventions, or inline `[text](./other.md)` links |

Custom grammars are configurable via `reqPatterns` in `.artgraph.json`.

## Doc graph (`docGraph` config)

Doc nodes (one per markdown file under `specDirs`) and their relations can be
generated four ways. All are enabled by default and can be turned off
individually via the `docGraph` block in `.artgraph.json`:

| Key                | Default | What it does                                                                                                                                                            |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoNodes`        | `true`  | Register every `*.md` under `specDirs` as a `doc` node, even without frontmatter.                                                                                       |
| `autoContains`     | `true`  | Emit `contains` edges from each doc node to req nodes defined in the same file.                                                                                         |
| `autoConventions`  | `true`  | Emit `derives_from` edges by matching kiro / spec-kit file-name conventions within the same directory (see table below). Frontmatter-declared edges are deduped against these. |
| `inlineLinks`      | `true`  | Emit `depends_on` edges from inline markdown links between spec/doc files (see "Inline links" below). Frontmatter-declared edges on the same `(source, target)` pair always win. |

### Conventions inferred by `autoConventions`

| Convention | Files (same dir)                              | Edges generated (`derives_from`)                              |
| ---------- | --------------------------------------------- | ------------------------------------------------------------- |
| kiro       | `requirements.md`, `design.md`, `tasks.md`    | `design → requirements`, `tasks → design`                     |
| spec-kit   | `spec.md`, `plan.md`, `tasks.md`, `research.md` | `plan → spec`, `tasks → plan`, `research → spec`              |

Notes:

- An edge is emitted only when *both* endpoints exist in the same directory, so
  partial sets never produce `orphan-doc` warnings.
- Matching is case-insensitive (`Design.md` works).
- A directory containing both kiro and spec-kit files (e.g. `design.md` and
  `plan.md` together) gets `tasks` linked to *both* `design` and `plan` —
  intentional for the mixed case, but downstream `dependsOn` will show both
  chains.
- **Cycles**: convention edges alone form a DAG, but combining them with a
  user-declared frontmatter edge pointing the opposite way (e.g. `requirements`
  declaring `derives_from: [design]`) can produce a silent cycle. artgraph does
  not run cycle detection — keep frontmatter edges aligned with the convention
  direction.

### Inline links extracted by `inlineLinks`

Inline markdown links between spec/doc files are picked up automatically and
emitted as `depends_on` edges (e.g. `design.md` with `See [requirements](./requirements.md)`
generates `doc:design.md --depends_on--> doc:requirements.md`). Direct, reference-style
(`[x][ref]` + `[ref]: ./...`), and shortcut forms are all supported; anchors and
queries are stripped; links inside code fences and inline code are ignored. A
frontmatter relation (`derives_from` / `depends_on`) on the same `(source, target)`
pair always wins over an inline link.

To opt out of any of the above:

```jsonc
// .artgraph.json
{
  "docGraph": {
    "autoConventions": false,        // default true — disable file-name convention inference
    "inlineLinks": true,             // default true — set false to disable inline-link extraction
    "linkWarnings": {
      "unresolved": true,            // default true — warn on links to missing .md
      "outOfScope": false            // default false — warn on .md outside specDirs
    }
  }
}
```

> **Behavior change on upgrade.** `inlineLinks` and `linkWarnings.unresolved`
> default to `true`, so an upgrade in place can both add `depends_on` edges to
> the graph and emit new `WARNING: unresolved-link` lines on stderr for inline
> links pointing at non-existent `.md` files. If you gate CI on stderr or on
> graph stability, opt out with `"docGraph": { "inlineLinks": false }` (and/or
> `"linkWarnings": { "unresolved": false }`) and migrate at your pace.


## Commands

| Command               | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `artgraph scan`      | Build the artifact graph and report counts                     |
| `artgraph check`     | Report drift / orphans / uncovered (`--gate` to fail a hook)   |
| `artgraph coverage`  | Per-requirement coverage status                                |
| `artgraph impact`    | Impact analysis (`--diff` scopes to the git diff)              |
| `artgraph reconcile` | Rebuild `.trace.lock` from the current graph                   |
| `artgraph graph`     | Emit the graph (dot / json)                                    |
| `artgraph rename`    | Rename / split / merge requirement IDs (see below)             |

## `artgraph rename` — ID lifecycle

Renames, splits or merges a requirement ID and rewrites **every** reference to it
(spec list items / headings, `@impl` tags, test tags, frontmatter
`depends_on` / `derives_from`, and `.trace.lock` keys) in one pass, limited to
git-tracked files.

```bash
# Rename one ID
artgraph rename --from REQ-001 --to REQ-100

# Split one ID into several (code @impl tags are flagged for manual re-assignment)
artgraph rename --split REQ-001 --into REQ-101 REQ-102

# Merge several IDs into one
artgraph rename --merge REQ-001 REQ-002 --into REQ-100

# Preview without writing
artgraph rename --from REQ-001 --to REQ-100 --dry-run

# Machine-readable output (errors are emitted as JSON too)
artgraph rename --from REQ-001 --to REQ-100 --format json
```

Notes:

- **Always commit first** — rename writes to tracked files in place. Use `--dry-run`
  to preview.
- **Target IDs are validated**: they must match the requirement-ID grammar
  (`REQ-001`, `auth/FR-2`, `Requirement-3`) or the `doc:` prefix, so the renamed ID
  is guaranteed to be re-discoverable by the next scan.
- After a non-preview run the lock is automatically reconciled, so `artgraph check`
  passes immediately for `rename` and `merge`.
- **split** intentionally does **not** re-assign `@impl` tags (the mapping is
  ambiguous); the new IDs are reported as `uncovered` until you assign them and fill
  in their scaffolded spec lines. `check` will flag this until done.
- IDs inside fenced code blocks are treated as examples and left untouched.

## Claude Code skills

artgraph ships Claude Code skills (`artgraph-plan`, `artgraph-verify`,
`artgraph-coverage`, `artgraph-rename`). See [docs/skills-guide.md](docs/skills-guide.md).
