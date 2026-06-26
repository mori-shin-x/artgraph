# artgraph

[![CI](https://github.com/ShintaroMorimoto/artgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/ShintaroMorimoto/artgraph/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/artgraph.svg)](https://www.npmjs.com/package/artgraph)
[![npm downloads](https://img.shields.io/npm/dm/artgraph.svg)](https://www.npmjs.com/package/artgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Typed artifact graph for TS/JS — trace specs, docs, code, and tests bidirectionally.

artgraph builds a graph that links requirement IDs in your specs to the code that
implements them (`@impl` tags) and the tests that verify them (`[ID]` / `req:` tags),
then detects **drift** (spec changed but code/tests didn't), **orphans**, and
**uncovered** requirements.

## Quickstart

```bash
npm install -D artgraph
npx artgraph init      # writes .artgraph.json
```

### End-to-end: spec → `@impl` → `check`

```bash
# 1. Write a requirement
mkdir -p specs && cat > specs/auth.md <<'EOF'
- REQ-001: Users can sign in with email and password.
EOF

# 2. Tag the implementation
cat > src/auth.ts <<'EOF'
// @impl REQ-001
export function signIn(email: string, password: string) { /* … */ }
EOF

# 3. Tag the test
cat > tests/auth.test.ts <<'EOF'
import { describe, it } from "vitest";
describe("auth", () => {
  it("[REQ-001] accepts non-empty credentials", () => { /* … */ });
});
EOF

# 4. Snapshot the baseline, then change the spec to see drift surface
npx artgraph reconcile
sed -i 's/email and password\./email, password, and TOTP./' specs/auth.md
npx artgraph check
```

```
DRIFT:
  REQ-001 (req)
  doc:auth.md (doc)
COVERAGE:
  REQ-001: verified
```

Add `--gate` (`npx artgraph check --gate`) to a CI step or pre-commit hook to
exit non-zero whenever drift, orphans, or uncovered requirements are present.

A runnable copy of this flow lives in [`examples/basic/`](./examples/basic).

### Using an SDD tool?

artgraph wires into Spec Kit and Kiro via [`artgraph integrate`](#sdd-tool-integration),
so drift detection runs at the right workflow checkpoint instead of relying on
a manual `check` call. Each example below installs the integration, walks the
full workflow, and shows the exact diff against `extensions.yml` / steering:

- **Spec Kit** — [`examples/speckit-integration/`](./examples/speckit-integration):
  `after_tasks` / `after_implement` hooks and the opt-in `before_implement` gate.
- **Kiro** — [`examples/kiro-integration/`](./examples/kiro-integration):
  steering file that teaches the Kiro agent when to call `impact` / `check --diff` / `reconcile`.

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

| Convention | Files (same dir)                                | Edges generated (`derives_from`)                 |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| kiro       | `requirements.md`, `design.md`, `tasks.md`      | `design → requirements`, `tasks → design`        |
| spec-kit   | `spec.md`, `plan.md`, `tasks.md`, `research.md` | `plan → spec`, `tasks → plan`, `research → spec` |

Notes:

- An edge is emitted only when _both_ endpoints exist in the same directory, so
  partial sets never produce `orphan-doc` warnings.
- Matching is case-insensitive (`Design.md` works).
- A directory containing both kiro and spec-kit files (e.g. `design.md` and
  `plan.md` together) gets `tasks` linked to _both_ `design` and `plan` —
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


## Task graph (`taskConventions` config)

artgraph extracts **task nodes** from Spec Kit / Kiro `plan.md` and `tasks.md`
files, then converts each SDD tool's cross-link tags into edges. **Tag syntax
is preset-supplied** — every SDD tool can define its own ID format and tag
regexes; there is no global `@impl` / `[REQ-]` convention baked into the parser.

### Built-in presets

| Preset       | files (stem)        | task ID                          | `implements` tag        | `verifies` tag                                  |
| ------------ | ------------------- | -------------------------------- | ----------------------- | ----------------------------------------------- |
| **spec-kit** | `plan`, `tasks`     | `T\d+` (e.g. `T001`)             | `@impl(target-id)`      | `[REQ-FR-001]` / `[FR-001]` / `[Requirement-3]` |
| **kiro**     | `tasks`             | `\d+(\.\d+)*` (e.g. `1`, `1.1`)  | *(not used by Kiro)*    | `- _Requirements: 1.1, 2.3, 3.1_` (italic list) |

Notes:
- `doc → contains → task` edges are emitted under `docGraph.autoContains` (the
  same flag that drives `doc → req`).
- Kiro's `tasks.md` requires the `[ ]`/`[x]` checkbox on each task line — bare
  numbered lists like `- 1 release shipped` are not treated as tasks.
- For nested Kiro tasks (`- [x] 1.1 ...` indented under `- [x] 1. ...`), each
  level's `_Requirements:` lists attach to its own task only; parents do not
  inherit child requirements.

### Adding a custom SDD tool (OpenSpec, etc.)

Append a preset to `taskConventions` — built-ins remain active. Each preset
chooses its own tag syntax via optional `implementsTagRe` / `verifiesTagRe`
(capture group 1 = target ID, applied with `/g` semantics):

```jsonc
// .artgraph.json
{
  "taskConventions": [
    {
      "name": "openspec",
      "fileStems": ["tasks"],
      "taskIdRe": "^(?:\\[[xX ]\\]\\s+)?(OS-\\d+)\\b",
      "implementsTagRe": "@impl\\(([^)\\n]+)\\)",
      "verifiesTagRe": "→\\s*(REQ-[\\w-]+)"
    }
  ]
}
```

All three regex fields are validated the same way `reqPatterns` is
(≤ 200 chars, nested-quantifier rejection, capture-group required, valid regex).
Omit `implementsTagRe` or `verifiesTagRe` if your tool doesn't have that edge
kind (Kiro omits `implementsTagRe`).

### Upgrade note

Built-in presets activate automatically on upgrade. Existing projects whose
`tasks.md` already contains `T###` (Spec Kit) or checkbox-prefixed numerics
(Kiro) will see new `task` nodes — and `doc → task` `contains` edges, plus
`task → verifies → ...` edges for Kiro `_Requirements:` lists — on the next
`artgraph scan`. Run `artgraph reconcile` to refresh the lock baseline.


## Edge provenance

Every edge in the graph carries a `provenances: EdgeProvenance[]` array
explaining where it came from. The eight values cover all generation sites:

| Value         | Source                                              |
| ------------- | --------------------------------------------------- |
| `annotation`  | inline `(depends_on: …)` / `(derives_from: …)` notes |
| `frontmatter` | YAML `artgraph.depends_on` / `derives_from`         |
| `convention`  | folder/file-stem conventions (kiro / spec-kit presets) |
| `code-tag`    | `// @impl` / `// @verifies` / `req:` in TS code     |
| `task-tag`    | task preset `_Requirements:` / `[REQ-…]` brackets   |
| `inline-link` | markdown inline `[text](path)` links between docs   |
| `ts-import`   | `import` statements                                 |
| `structural`  | doc → req / task auto-`contains` within the same file |

When the same `(source, target, kind)` is produced by multiple paths, the
arrays are union-merged and sorted (e.g. `["convention", "frontmatter"]`). The
`.trace.lock` mirrors this by storing each `dependsOn` element as
`{id, provenances}`. See [specs/011-edge-provenance/](specs/011-edge-provenance/)
for the formalisation.

## Commands

| Command              | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `artgraph scan`      | Build the artifact graph and report counts                   |
| `artgraph check`     | Report drift / orphans / uncovered (`--gate` to fail a hook) |
| `artgraph coverage`  | Per-requirement coverage status                              |
| `artgraph impact`    | Impact analysis (`--diff` scopes to the git diff)            |
| `artgraph reconcile` | Rebuild `.trace.lock` from the current graph                 |
| `artgraph graph`     | Emit the graph (dot / json)                                  |
| `artgraph rename`    | Rename / split / merge requirement IDs (see below)           |

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

## SDD tool integration

`artgraph integrate` wires the scan / reconcile / check loop into the SDD tool you
already use, so spec ↔ code drift is caught at the right workflow checkpoint
instead of relying on a manual call.

| Command                           | Purpose                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artgraph integrate speckit`      | Generate `.specify/extensions/spectrace/` and register Spec Kit hooks (`after_tasks` / `after_implement`, optional `before_implement` via `--gate`)                 |
| `artgraph integrate kiro`         | Write `.kiro/steering/spectrace.md` so the Kiro agent learns when to call `impact / check --diff / reconcile`                                                       |
| `artgraph integrate list`         | Show every supported integration with detect / installed status                                                                                                     |
| `artgraph init --integrate=<ids>` | One-shot: run `init` _and_ integrate the named tools (`speckit`, `kiro`, `all`); pass `--integrate-gate` to add Spec Kit's `before_implement` hook in the same call |

```bash
# Inside a repo that already has .specify/
artgraph integrate speckit              # idempotent
artgraph integrate speckit --gate       # also add before_implement gate
artgraph integrate speckit --no-gate    # remove only spectrace's before_implement hook
artgraph integrate speckit --uninstall  # remove the extension dir + every spectrace hook entry

# Kiro
artgraph integrate kiro                 # writes .kiro/steering/spectrace.md
artgraph integrate kiro --force         # overwrite a hand-edited steering file

# Discover what's available
artgraph integrate list                 # detected / installed flags per tool

# Bootstrap + integrate in one shot
artgraph init --integrate=all --integrate-gate
```

Notes:

- All write paths are **atomic** and roll back the entire `install` call if any
  file fails to write, so a partial Spec Kit / Kiro layout never lands on disk.
- Re-running an `integrate` command is always safe: the second invocation
  reports `Already integrated: ... — no changes` and leaves the disk byte-for-byte
  identical.
- `--gate` is _declarative_: `--gate` sets the hook to present, `--no-gate`
  removes it, and omitting the flag leaves the current state untouched. Other
  extensions' hooks in `extensions.yml` are never touched.
- The full design lives in
  [specs/009-sdd-integration/spec.md](./specs/009-sdd-integration/spec.md);
  the end-to-end walkthrough (every scenario the E2E tests cover) is in
  [specs/009-sdd-integration/quickstart.md](./specs/009-sdd-integration/quickstart.md).

## Claude Code skills

artgraph ships Claude Code skills (`artgraph-plan`, `artgraph-verify`,
`artgraph-coverage`, `artgraph-rename`). See [docs/skills-guide.md](docs/skills-guide.md).
