# Configuration

`.artgraph.json` at the repo root controls how the graph is built. All blocks
below are optional — the defaults produce the graph shown in the top-level
README's end-to-end example. This page documents the blocks users typically
touch: `reqPatterns`, `ignoreIdPrefixes`, `docGraph`, `taskConventions`, and
how edge provenance is surfaced.

## `include` / `testPatterns` — code and test file globs <a id="include--testpatterns"></a>

Both are lists of [fast-glob](https://github.com/mrmlnc/fast-glob) patterns
resolved relative to the repo root (defaults: `include: ["src/**/*.ts",
"src/**/*.tsx", "!**/node_modules/**"]`, `testPatterns: ["**/*.test.ts",
"**/*.spec.ts", "**/*.test.tsx", "**/*.spec.tsx", "!**/node_modules/**"]`).
A leading `!` marks a pattern as an exclusion (e.g. `"!src/generated/**"`),
matching fast-glob's own negative-pattern convention.

**`include` and `testPatterns` are two independent glob pools (issue
#350).** Each pool is globbed on its own — a `!`-prefixed pattern in one
list applies ONLY to that list's own positive patterns, never to the
other's. The discovered code-file set is the *union* of both pools'
positive matches. Concretely:

- A negative pattern in `testPatterns` narrows which matched files are
  treated as tests (see "`testPatterns` is the sole source of truth for
  `isTest`" below) but does **not** remove a file from the graph if
  `include` still matches it — the file simply survives at `kind: "file"`
  instead of `kind: "test"`.
- A negative pattern in `include` narrows the code-file set the same way,
  but does not by itself narrow test classification if `testPatterns`
  still matches the file.
- **To exclude a path from the graph entirely, add the same negative
  pattern to BOTH `include` and `testPatterns`.** Neither list alone is
  enough once the two pools are independent.

A list made up entirely of exclusions matches zero files for that pool
(it never widens the *other* pool). Excluded files (from both pools) are
dropped from `artgraph rename`'s rewrite scope too — `rename` enumerates
its rewrite candidates through the exact same `discoverCodeFiles` helper
`scan`/`check`/`impact` build the graph from, so the two are structurally
guaranteed to agree on scope; a file discoverable by scan can never be
silently skipped by rename, or vice versa.

Before pool separation (PR #349, issue #350), `include` and `testPatterns`
were globbed together as one merged pool, so a `!`-prefixed `testPatterns`
entry silently excluded matching files from the *whole* scan — exactly as
if it had been written under `include`. Projects that relied on that
(likely accidental) behavior need to add the same negative pattern to
`include` now to keep those files out of the graph.

**`testPatterns` is the sole source of truth for whether a file is a
"test" (issue #323).** Independent of which pool(s) discovered it, a file
that matches `testPatterns` gets: (1) graph node kind `"test"` (vs
`"file"`), and (2) `[REQ-x]`-style tags in its test titles extracted into
`verifies` edges. There is no separate hardcoded filename heuristic — a
file matches `testPatterns` or it does not, and every downstream decision
follows from that one answer. A file that falls out of `testPatterns`
stops being treated as a test even if its filename still looks like one
(e.g. `foo.test.ts`) — but, per pool separation above, it does not
disappear from the graph unless `include` excludes it too.

**node_modules is excluded by default (issue #287, extended by #350).**
`artgraph init` generates configs whose `include` **and** `testPatterns`
both end with `"!**/node_modules/**"` (as shown above) — both pools need
the negation now that they are independent, since fast-glob does not
exclude node_modules on its own. Without it, a broad pattern like
`"**/*.ts"` (the `include` config `init` produces when no `src/` directory
is detected) would ingest thousands of vendored `.ts` files into the graph
on the very first scan, and a similarly broad `testPatterns` pool could
separately ingest vendored `*.test.ts`/`*.spec.ts` files even with
`include`'s own negation in place. Projects created before this version
can add `"!**/node_modules/**"` to their own `include` and `testPatterns`
to opt in. `artgraph scan` emits a `node-modules-in-scan` warning whenever
the matched file set still contains files under a node_modules directory;
the warning's remediation text names whichever of `"include"` /
`"testPatterns"` (or both) actually matched the offending files, so the
fix it suggests is always the pool(s) that need the exclusion.

Configs that omit both `include` and `testPatterns` entirely pick up the
new defaults automatically on upgrade, with no action needed — but any
previously-scanned files under a node_modules path silently leave the
graph on the next scan, since they are now excluded rather than detected,
so no `node-modules-in-scan` warning fires for them. Only configs with an
explicit `include` or `testPatterns` need the manual opt-in described
above. A config that deliberately includes node_modules — for checked-in
vendored code, say — will instead see the `node-modules-in-scan` warning
on every run; it is informational only and never affects exit codes.

Degenerate patterns behave as inert rather than as errors: a doubled
negation (`"!!foo/**"`), a bare `"!"`, and an empty string (`""`) are all
accepted without complaint and simply do not produce a working exclusion.

**Asymmetric / broken protection (issue #356, judgment updated by PR #359).**
`node-modules-in-scan` above only fires once a matched file is actually under
node_modules. Separately, `artgraph scan` also runs a purely structural,
config-shape-only check, and `artgraph doctor` reports the identical result
as an advisory `config-pool-protection-asymmetry` finding (severity `pass`,
never affects doctor's exit code, and scoped to projects with at least one
Tier 1 agent already detected) — both surfaces render through the same
judge and the same message-generation function, so they can never disagree
or say different things about the same config.

The judge does **not** just look for the literal substring/segment
`node_modules` in a negative pattern — that used to false-positive on
`!node_modules/**` (no `**/` prefix: only ever excludes a repo-ROOT
`node_modules/`, leaving `packages/foo/node_modules/**` completely
unprotected) and false-negative on a working pattern like
`!**/*node_modules*/**` (protects every depth, but the old segment-equality
check didn't recognize the wildcarded segment as "node_modules"). Instead, a
pool is judged **protected** only if its negative patterns, matched with
[picomatch](https://github.com/micromatch/picomatch) using the exact option
set `fast-glob` itself uses for ignore-pattern evaluation, cover THREE
representative synthetic paths at increasing nesting depth
(`node_modules/x.ts`, `a/node_modules/x.ts`, `a/b/node_modules/x.ts`). This
stays purely structural and filesystem-free (no real files are touched or
even need to exist) — it is real glob matching against fixed synthetic
inputs, not a heuristic proxy for it.

Two categories are reported:

- **Unprotected (asymmetry)** — one pool is protected by the check above and
  the other isn't; the unprotected pool is named.
- **Broken exclusion** — a pool's negative pattern clearly *mentions*
  node_modules (the old segment check) but the real matcher says it still
  isn't protected at every depth (e.g. the `!node_modules/**` example
  above). This fires **regardless of the other pool's state** — a broken
  exclusion attempt is never ambiguous with a deliberate symmetric choice
  the way silence is, so it is reported even when both pools end up
  "unprotected" by the matcher.

A pool with no positive pattern at all (empty array, or every entry
negated — per issue #266 such a pool can never match a file) is excluded
from both categories entirely: it structurally cannot ingest node_modules,
so judging its protection would be reporting on a hypothetical that can't
happen. A config where BOTH remaining (non-degenerate) pools lack any
node_modules-related pattern is still not reported by either surface — it
remains indistinguishable from a deliberate, symmetric choice (e.g.
intentionally scanning vendored code, as described above). Whichever
category fires, the remediation text always names the canonical
`"!**/node_modules/**"` form (protects every nesting depth) as the fix.

## `specDirs` — spec/doc file enumeration

Every markdown file under a configured `specDirs` entry is enumerated with
`<specDir>/**/*.md`. As of this version that enumeration is done with the
same [fast-glob](https://github.com/mrmlnc/fast-glob)-based wrapper
`include`/`testPatterns` use (previously it went through a different glob
library) — matches are `onlyFiles`, `dot: false`, `followSymbolicLinks:
true`, and sorted before the graph is built. This closed a gap where a
scan that ran out of file descriptors (EMFILE/ENFILE) while listing a
specDir could silently produce an empty match list with no warning at all —
every REQ/task/doc that directory defines would vanish from the graph
without a trace. It now surfaces a `system-resource-exhausted` warning
(same as an `include`/`testPatterns` glob hitting the same condition) and
continues scanning every other specDir.

Three intentional, backward-incompatible behavior changes come with this:

- **Multi-hop symlink chains and symlink loops are now followed further.**
  PR #339 meta-review — corrects an earlier, too-broad claim on this page:
  the previous glob library was NOT blind to symlinks. A single-hop
  symlinked spec subdirectory (or a symlinked `.md` file) was already
  descended into — `**` expansion's bash-mimicking spec unconditionally
  allows the first symlink hop regardless of the library's `follow` default.
  What actually changed is narrower: (a) a symlink **chain of two or more
  hops** — previously enumeration stopped descending after the first hop;
  now every hop is tracked, so a spec subtree reachable only through a
  multi-hop chain is ingested where it previously was not, and (b) a
  symlink **loop** — previously enumeration converged after one hop; now it
  descends until the OS's own loop boundary (Linux `ELOOP`, `MAXSYMLINKS` =
  40), which does not hang (measured ~17ms for a looped fixture) but does
  produce more `duplicate-id` warning noise than before, since the same
  files are revisited through more of the loop before the OS cuts it off.
- **A directory literally named `something.md/` is now silently excluded**
  (`onlyFiles: true` never matches it). Previously it would match the glob
  pattern and then fail at read time with `EISDIR`, surfacing an
  `unreadable-file` warning; now it is simply not enumerated in the first
  place, with no warning.
- **Enumeration order is deterministic (sorted)**, not OS-`readdir`-order-
  dependent. This applies to `specDirs`' markdown enumeration AND to
  `include`/`testPatterns`' code/test-file enumeration alike — both route
  through the same shared, sorted wrapper (`src/glob-utils.ts`). In the rare
  case of a genuine spec collision this sorted order is now what decides
  tie-breaks that used to depend on filesystem/platform traversal order —
  e.g. which of two same-id definitions "wins" a `duplicate-id` collision,
  or which file a convention-inferred edge's stem-collision resolves against
  (see `docGraph.autoConventions` below). The outcome for any *specific*
  collision may differ from a pre-upgrade scan, but it is now the same on
  every machine and every run.

### What `artgraph init` seeds (issue #422)

`init` writes `specDirs` from what it finds on disk: `specs/` and `docs/` when
those directories exist, plus the spec directory of any detected SDD tool —
`.kiro/specs` for Kiro, `.specify/specs` for Spec Kit. It falls back to
`["specs", "docs"]` when none of the four exist.

The SDD entry is **appended**, not substituted: a Kiro project that also keeps
a `docs/` tree gets `["docs", ".kiro/specs"]`, and both are scanned. All four
candidates are siblings of one another — never parent/child — so none of them
is dropped by the redundant-descendant filtering `loadConfig` applies to
`specDirs` (issue #234).

Three limits worth knowing:

- The probe is for the tool's **specs directory** (`.kiro/specs`), not for its
  marker directory (`.kiro`). `init --agents=kiro` creates `.kiro/skills/` and
  `.kiro/hooks/` itself, so `.kiro/` alone proves only that artgraph has run
  before. Putting `.kiro` in `specDirs` would additionally pull artgraph's own
  distributed `SKILL.md` files into the graph as `doc` nodes, so every artgraph
  upgrade that edits a Skill would register as lock drift.
- `init --force` over an existing `.artgraph.json` **merges** your config and
  does not re-derive `specDirs` (that is what preserves hand-edited values).
  A project that ran `init` before this version therefore keeps its old
  `specDirs`; add the entry by hand. `artgraph doctor` reports the gap as a
  `config-specdir-missing-sdd-tool` NOTICE (advisory — it does not change the
  exit code).
- The probe answers "is this a directory?", not "does this path exist?".
  A regular file named `.kiro/specs` is skipped: a `specDirs` entry pointing at
  a file makes markdown enumeration fail with `ENOTDIR`, which would abort
  `init` before it wrote `.artgraph.json` at all. An empty `.kiro/specs`
  directory is seeded normally.

Adding the entry by hand to an existing project makes requirements visible that
were not in the graph before, and they arrive `uncovered` — the same shape as
the grammar widening below, with the same consequences per gate. See
[Behavior change on upgrade](#kiro-headings--the-title-after-the-number-is-optional)
for which of them that reaches.

### Kiro numbers requirements per spec, so a second spec qualifies every ID

This is a property of Kiro's own output, not of any artgraph version. Kiro
starts each spec's `requirements.md` at `Requirement 1`, so the moment a
project has two of them the same ID is defined twice:

```text
.kiro/specs/auth/requirements.md      ### Requirement 1
.kiro/specs/billing/requirements.md   ### Requirement 1
```

artgraph resolves that collision by qualifying each ID with its spec
directory — `auth/Requirement-1` and `billing/Requirement-1` — the same
namespacing it applies to any ID defined in more than one spec (see
[architecture.md](./architecture.md)). An unqualified `// @impl Requirement-1`
then matches both, so it is **ambiguous and the edge is dropped**, with a
`WARNING: ambiguous ID "Requirement-1" (candidates: auth, billing)` naming the
candidates. The requirements themselves are reported `uncovered`.

The same qualification applies to a task's `_Requirements:` list (issue #435):
`_Requirements: 1.1_` in `.kiro/specs/auth/tasks.md` binds to
`auth/Requirement-1`, because the resolver prefers a match in the *same* spec
directory. You do not have to qualify anything by hand there — but a spec
directory that holds a `tasks.md` and **no `requirements.md`** (a cross-cutting
planning spec) has no same-directory match, so its `_Requirements:` entries are
ambiguous and their edges are dropped with the same warning.

The fix is on the annotation side: qualify each tag with the spec directory
its requirement lives in.

```ts
// @impl auth/Requirement-1
```

Do this with an editor, not with `rename`: by the time the second spec exists
there is no `Requirement-1` node left to rename, so
`rename --from Requirement-1 --to auth/Requirement-1` exits 1 with `ID
"Requirement-1" does not exist in the project`.

`artgraph reconcile` does not resolve it either — reconcile updates the lock to
match the graph, and an ambiguous tag leaves the requirement genuinely
untagged, so a plain `check --gate` stays at exit `2` until the tags carry the
prefix. Once every tag is qualified, `check` reports each requirement covered
and the gate goes back to exit `0` (measured on a two-spec fixture).

This is not a rare shape: of 26 surveyed repositories with `.kiro/specs/`
committed, 9 had two or more specs, and every one of those started every spec
at `Requirement 1`.

## `reqPatterns` — requirement ID grammar

By default artgraph recognizes `REQ-001`, `auth/FR-2`, and `Requirement-3`.
To accept a custom grammar (e.g. `FEAT-`, `US-`, `#123`), extend
`reqPatterns`:

```jsonc
// .artgraph.json
{
  "reqPatterns": [
    "REQ-\\d+",
    "FEAT-\\d+",
    "US-\\d+"
  ]
}
```

Each pattern is validated: ≤ 200 chars, no nested quantifiers, must match a
capture group, must be a valid JavaScript regex. Patterns are OR-ed together
at match time.

### ID prefixes are free-form

The default ID grammar is `[A-Z][A-Za-z]*-\d+` — the prefix carries no special
meaning, so `REQ-001`, `FR-001`, `AUTH-2`, and `US-12` all work with **zero
configuration**. In particular, Spec Kit's spec-template generates `FR-NNN`
(Functional Requirements) by default: keep them as-is; there is no need to
rename them to the `REQ-` prefix used in this documentation's examples.

### Kiro headings — the title after the number is optional

A markdown heading whose text reads `Requirement <n>` defines the requirement
`Requirement-<n>`. Both spellings Kiro emits are recognized, at any heading
level:

```md
### Requirement 1: Federated authentication
### Requirement 2
```

What ends the match is either a `:` after the number (spaces allowed in
between) or the end of the heading text — nothing else. A heading that carries
on into prose defines nothing:

```md
### Requirement 1 is important
```

`artgraph rename Requirement-1 Requirement-9` rewrites both spellings when the
heading is an unadorned ATX line — one to six `#`s, no indentation, and the
requirement text starting right after them. A trailing ATX closing sequence
(`### Requirement 1 ###`) is fine and is preserved. `rename`, `rename --split`
and `rename --merge` all read the raw line through the same normalization, so
what one of them rewrites the others delete and scaffold.

Recognition is looser than that, because it reads the parsed heading rather
than the line: an indented, blockquoted or list-nested `###`, a setext heading
(`Requirement 1` over `---`), an emphasis-wrapped title (`### **Requirement
1**`) and an HTML entity or comment inside the `Requirement <n>` part itself
are all requirements to `scan` / `check`, but `rename` will not rewrite them.
(An entity later in the *title* — `### Requirement 1: Caf&eacute; login` — is
rewritten normally; only the ID part matters.)

What `rename` does when it skips one depends on where else the ID appears. If
the ID also has `@impl` tags in code, the run exits 0 having rewritten those
and left the definition behind, which turns the requirement into an orphan. If
the ID exists only in the spec, there is nothing left to rewrite and the run
exits 1 (`… was not found in any of the N files matched by …`).

None of these shapes occurred in the 62-file, 549-heading corpus behind the
percentages above; if you write one by hand, edit it and its `@impl` tags
together.

> **Behavior change on upgrade.** Only the `:` spelling used to be recognized.
> Upgrading a repository whose `requirements.md` uses the bare form adds req
> nodes that were not in the graph before, and those reqs start out
> `uncovered`. Where that surfaces:
>
> - **`artgraph reconcile`, or a first `artgraph init`** — the new reqs enter
>   the lock, and `artgraph check` lists the uncovered ones.
> - **plain `artgraph check --gate`** (no `--diff`) — judges the whole graph
>   against the lock, so newly recognized uncovered reqs can turn it into an
>   exit `2`.
> - **`--diff` gates** — not affected the same way. `check --diff` builds its
>   baseline by scanning the base ref with the *current* binary and the
>   *current* config, so the base side is re-read under the new grammar too
>   and the newly recognized reqs do not appear in `newIssues`. Both wirings
>   `init` installs by default — the Stop hook (`check --gate --diff`) and the
>   CI recipe (`check --diff --base origin/<base> --gate`) — are `--diff`
>   gates, so this upgrade does not by itself turn them non-zero. A `--diff`
>   gate that cannot establish a baseline at all still fails closed with exit
>   `1` (not a git repository, or a shallow clone without the base ref) — that
>   is unrelated to the grammar change and is unchanged by it.

## `ignoreIdPrefixes` — exclude specific ID prefixes from tracking

Sometimes a spec contains IDs that share the requirement-ID grammar but are
*not* implementation-trackable requirements. The canonical case is Spec Kit's
mandatory `## Success Criteria` section (`SC-001`, `SC-002`, …): success
criteria are measurable, technology-agnostic *outcomes* — usually several
requirements and tests contribute to one — so tagging them individually with
`@impl` rarely makes sense, and by default each `SC-NNN` becomes a req node
that `artgraph check` reports as permanently UNCOVERED.

`ignoreIdPrefixes` removes such IDs from the graph entirely:

```jsonc
// .artgraph.json
{
  "ignoreIdPrefixes": ["SC"]
}
```

With `"SC"` listed:

- spec-side `SC-NNN` list items / headings no longer become `req` nodes, so
  `check` stops reporting them as UNCOVERED;
- code-side `@impl SC-NNN` tags, test markers (`[SC-NNN]` / `req: "SC-NNN"`),
  task tags, and inline annotations referencing an ignored ID emit no edges —
  including namespaced forms like `013-foo/SC-001` — so they never surface as
  orphan warnings either.

Rules:

- **Default is empty** — nothing is ignored; existing behavior is unchanged.
- Each entry must be a bare prefix matching `[A-Z][A-Za-z]*` (e.g. `"SC"`,
  not `"SC-"`).
- Matching is exact-shape: an ID is ignored only when its bare token is
  `<prefix>-<digits>`, so `"SC"` ignores `SC-001` but not `SCX-001` or a doc
  named `SC-overview.md`.
- Whether to ignore `SC-` is a per-project decision: some projects (artgraph
  itself included — see issue #134) deliberately claim SC tags from code, which
  is why nothing is excluded by default and `artgraph integrate speckit` does
  not write this setting for you.

## Code tags — where an `@impl` counts <a id="code-tags-where-an-impl-counts"></a>

**An `@impl` is a tag only when it opens a line comment (issue #387).** The
comment may start with any number of slashes and the tag may be preceded by
in-line whitespace, so all of these register:

```ts
// @impl REQ-001
//@impl REQ-002
/// @impl REQ-003
  // @impl REQ-004      ← indentation is fine; it is outside the comment
```

Everything else that merely *contains* the same characters does not:

```ts
const doc = "// @impl REQ-900";                  // string / template / JSX text
/* @impl REQ-901 */                              // block & JSDoc comments
// Issue #214: `// @impl A, B` used to drop B    // prose quoting the syntax
// TODO: @impl REQ-902                           // tag not at the comment start
```

The reasoning is that a tag is a *claim about this file*, while a sentence
that quotes the notation is *documentation about the notation*. Without the
distinction, every code comment, test fixture, and doc snippet that spells out
the syntax silently became a claim.

This rule can only be applied where artgraph actually has comment spans, and
there are two ways it ends up without any. A file that is never handed to the
parser (`pathological-bracket-nesting`, which is skipped deliberately) and a
file whose parse throws both fall back to the plain text scan, so their tags
register as they did before. That is a documented **fail-open**, not a
guarantee.

The opposite case exists too and predates this rule: for a few inputs the
parser returns successfully but reports *no comments at all* — an unterminated
block comment, string, or template literal, or a tag sharing its line with a
hashbang. An empty comment list is still a list, so the rule does run, finds no
comment to open, and every tag in that file is rejected. That **fail-closed**
behaviour is unchanged by the rule above (it is the same before and after) and
is tracked separately.

### Upgrade note

A tag that used to be picked up out of the *middle* of a comment no longer is.
Concretely, that means a comment that opens with prose and then quotes the
notation:

```diff
-// see below // @impl REQ-001
+// @impl REQ-001
+// see below
```

(A tag merely preceded by prose with no second `//` — `// TODO: @impl REQ-001`
— is unaffected, because it never registered: `@impl` is recognized only
immediately after a `//`.)

How loudly a lost claim surfaces depends on whether the requirement had
another one. If it was the requirement's **only** claim, the requirement turns
up in `artgraph check`'s `UNCOVERED:` list and a plain `artgraph check --gate`
— the blocking Spec Kit `before_implement` hook, if you opted into it — goes
red. If the requirement is claimed somewhere else too, `check` reports nothing
at all: coverage still says `impl-only`, the lock does not drift, and the only
visible trace is that `artgraph impact <file>` on the file that lost the tag no
longer reaches that requirement.

Note also that the gates `artgraph init` wires up by default stay green either
way: the agent Stop hook (`check --gate --diff`) and the CI recipe
(`check --diff --base origin/<base> --gate`) both exclude pre-existing debt
from the verdict, and a claim lost to this upgrade is pre-existing debt
relative to the change being judged.

So do not rely on a gate to find these. Grep for the shape directly — a
comment with a second `//` before the tag is the only one affected:

```console
$ git grep -nE '//.*//[^\S\n]*@impl'
```

then run a plain `artgraph check` to see which of the requirements involved
lost their last claim.

## `docGraph` — doc nodes and their relations

Doc nodes (one per markdown file under `specDirs`) and their relations can be
generated four ways. All are enabled by default and can be turned off
individually via the `docGraph` block:

| Key                | Default | What it does                                                                                                                                                            |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoNodes`        | `true`  | Register every `*.md` under `specDirs` as a `doc` node, even without frontmatter.                                                                                       |
| `autoContains`     | `true`  | Emit `contains` edges from each doc node to req nodes defined in the same file.                                                                                         |
| `autoConventions`  | `true`  | Emit `derives_from` edges by matching kiro / spec-kit file-name conventions within the same directory (see table below). Frontmatter-declared edges are deduped against these. |
| `inlineLinks`      | `true`  | Emit `depends_on` edges from inline markdown links between spec/doc files. Frontmatter-declared edges on the same `(source, target)` pair always win. |

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

### Doc drift and task-list checkbox state

A doc node's `contentHash` covers the whole file, so any prose edit drifts it.
One thing is deliberately excluded: the state character of a GFM task-list
checkbox is canonicalized to `[ ]` before hashing, so ticking a box is not a
document change. Unticking one is not either — clearing a signed-off review
checklist is as invisible to `check` as filling it in. This is a property of the
file's shape, not of `taskConventions`: it applies to `- [x]` list items in any
file under `specDirs`, whether that is a `tasks.md` task or a review checklist,
and there is no key that turns it off. The text after the box is still content:
reword the task and the doc drifts as usual.

Two limits are worth knowing:

- **A leading byte-order mark disables it.** A `U+FEFF` at the very start of the
  file shifts every parsed offset by one, and the canonicalization becomes a
  no-op for that whole file — a tick drifts the doc the way it did before this
  behaviour existed. Write spec markdown without a BOM.
- **Nothing else records the state.** A checklist with no task IDs in it (e.g.
  `specs/<feature>/checklists/requirements.md` under Spec Kit) produces only a
  doc node, and the lock stores `req` / `doc` / `symbol` entries only — so for
  such a file the checkbox state is not tracked anywhere in the graph. Where a
  `tasks.md` task ID *is* present, the task node still hashes its own checkbox
  verbatim (that is what makes `- [ ] T001` → `- [x] T001` a change to the
  task), but task nodes are not written to the lock either, so no `check`
  verdict consumes it.

#### Upgrade note

Docs that already contain a ticked box hash to a new value once, so the first
`artgraph check` after upgrading reports them as drifted. `check --diff --gate`
(the Stop hook / CI PR gate) is not affected — it is scoped to the diff, and a
doc that does land in the diff hashes identically on both sides of the
comparison and is suppressed as pre-existing. Only an unscoped `check --gate`
surfaces it — including the Spec Kit `before_implement` gate, if you enabled
blocking gates via `artgraph integrate speckit --gate`.

Run `artgraph check` first and confirm the drifted list contains only docs whose
tick state you expect to have changed, then `artgraph reconcile` to refresh the
lock baseline. `reconcile` rebuilds the whole lock, so it also approves any
unrelated drift that happened to be pending.

### Opting out

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

## `taskConventions` — task graph presets

artgraph extracts **task nodes** from Spec Kit / Kiro `plan.md` and `tasks.md`
files, then converts each SDD tool's cross-link tags into edges. **Tag syntax
is preset-supplied** — every SDD tool can define its own ID format and tag
regexes; there is no global `@impl` / `[REQ-]` convention baked into the parser.

### Built-in presets

| Preset       | files (stem)        | task ID                          | `implements` tag        | `verifies` tag                                  | `verifies` target space |
| ------------ | ------------------- | -------------------------------- | ----------------------- | ----------------------------------------------- | ----------------------- |
| **spec-kit** | `plan`, `tasks`     | `T\d+` (e.g. `T001`)             | `@impl(target-id)`      | `[REQ-FR-001]` / `[FR-001]` / `[Requirement-3]` | `task` (capture verbatim) |
| **kiro**     | `tasks`             | `\d+(\.\d+)*` (e.g. `1`, `1.1`)  | *(not used by Kiro)*    | `- _Requirements: 1.1, 2.3, 3.1_` (italic list) | `requirement` (`1.1` → `Requirement-1`) |

Notes:

- `doc → contains → task` edges are emitted under `docGraph.autoContains` (the
  same flag that drives `doc → req`).
- **Kiro's `_Requirements:` entries are acceptance-criterion numbers, and
  artgraph maps them to the requirement they belong to** — `1.1` and `1.2` both
  name `Requirement-1`, so they produce ONE `task → verifies → Requirement-1`
  edge, not two. Which criterion a task cited is not represented in the graph;
  it stays in the `tasks.md` doc node's content hash. See
  [Which `_Requirements:` entries resolve](#which-_requirements-entries-resolve-issue-435)
  for the three shapes where the mapping produces an ID that matches no
  requirement.
- Kiro's `tasks.md` requires the `[ ]`/`[x]` checkbox on each task line — bare
  numbered lists like `- 1 release shipped` are not treated as tasks. See
  [Kiro `tasks.md` without checkboxes](#kiro-tasksmd-without-checkboxes-issue-419)
  for the override, and for what the override cannot reach.
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

There is a fourth, optional field: `verifiesTargetSpace`.

| value | meaning |
| ----- | ------- |
| `"task"` (default) | `verifiesTagRe`'s capture **is** the target ID, verbatim. |
| `"requirement"` | The capture is a Kiro-style `<requirement>.<criterion>` number; the part before the first `.` is mapped to `Requirement-<n>`. A capture whose leading segment is not a bare number is left verbatim. |

Leave it out unless your tool numbers its cross-links the way Kiro does. It is
rejected at config-load time with
`Invalid taskConventions[N].verifiesTargetSpace: must be one of task, requirement`
for any other value.

### Kiro `tasks.md` without checkboxes (issue #419) <a id="kiro-tasksmd-without-checkboxes-issue-419"></a>

Kiro sometimes emits a `tasks.md` whose task lines carry no `[ ]`/`[x]`
checkbox. The built-in `kiro` preset requires one, so those lines produce no
task nodes. Add a second preset alongside it — built-ins stay active, so
checkbox-prefixed lines keep working through the built-in and the new preset
picks up the bare ones:

```jsonc
// .artgraph.json
{
  "taskConventions": [
    {
      "name": "kiro-no-checkbox",
      "fileStems": ["tasks"],
      "taskIdRe": "^(\\d+|\\d+\\.\\d+|\\d+\\.\\d+\\.\\d+)\\.?[\\s\\u00A0]",
      "verifiesTagRe": "(?<=Requirements:[\\s\\d.,]*)(\\d+\\.\\d+|\\d+)",
      "verifiesTargetSpace": "requirement"
    }
  ]
}
```

Five things about that snippet are easy to get wrong:

- **`verifiesTargetSpace: "requirement"` is not optional here (issue #435).**
  Without it your preset's `_Requirements: 1.1_` captures stay in the *task* ID
  space while the built-in `kiro` preset's resolve to `Requirement-1` — and
  because both presets apply to the same `tasks.md`, you get **two ID spaces
  inside one file**: the checkbox-less lines point at `1.1` (a task number, or
  nothing at all) and the checkbox lines point at `Requirement-1`. Measured on a
  mixed fixture, that is `1 -> 1.1` next to `2.1 -> Requirement-2`.
  Pinned by `issue #435 ⑤ the docs kiro-no-checkbox recipe` in
  `tests/issue-435-kiro-requirements-space.test.ts` (both halves: with and
  without the field).
- **You need `verifiesTagRe` too, not just `taskIdRe`.** Tag regexes are
  per-preset: a task discovered by your preset is scanned with *your* preset's
  tags, so leaving `verifiesTagRe` out gives the checkbox-less lines task nodes
  with no `_Requirements:` edges of their own (measured on an all-checkbox-less
  fixture: task nodes appear, zero `verifies` edges). In a file that mixes both
  spellings the checkbox lines still get their edges from the built-in preset,
  so the count is not zero — it is missing exactly the lines your preset
  discovered.
- **You cannot copy the built-in `kiro` values and delete the checkbox part.**
  Both built-in patterns spell the hierarchical number as `(\d+(?:\.\d+)*)`,
  and `loadConfig`'s nested-quantifier guard rejects that shape in a
  user-supplied preset — for `taskIdRe` *and* for `verifiesTagRe`. The
  enumerated alternation above (`\d+|\d+\.\d+|\d+\.\d+\.\d+`, longest-first in
  the `verifiesTagRe` case) passes the guard and covers up to three levels.
- **Prefer the enumerated alternation over `[\d.]+`.** A character class also
  passes validation but matches non-numbers: on a fixture holding
  `- . lone dot`, `- 1.. double dot` and `- 1.2.3.4 deep numeric`, `[\d.]+`
  created a task node for each of the three; the alternation above created
  none of them. Neither form can tell `- 3 workers were provisioned` from a
  real task — that false positive is exactly what the built-in preset's
  checkbox requirement was buying you, and dropping the checkbox gives it up.

**What no override can reach.** When the number is followed by `.` or `)` and a
space, CommonMark consumes it as an *ordered-list marker* rather than as text,
so by the time `taskIdRe` runs the ID is not in the string at all. Measured on
one fixture: `- 3. Ordered-list dot form`, `- 4) Paren form` and a top-level
`5. Ordered list` produced no task node under any of the patterns tried, while
`- 1 Set up`, `- 1.1 Nested numeric` and the checkbox forms did. Only the
checkbox spelling (`- [x] 3. Something`) survives the marker rule, because the
`[x]` comes first.

### Which `_Requirements:` entries resolve (issue #435) <a id="which-_requirements-entries-resolve-issue-435"></a>

Do not read "Kiro's `_Requirements:` points at a requirement" as unconditional.
The mapping is `<major>` → `Requirement-<major>`, applied verbatim, and three
real shapes come out of it pointing at nothing. All three are **silent**: a
`verifies` edge whose *source* is a task is excluded from orphan reporting
(`findOrphans`), so a broken reference shows up in neither `check` nor `scan`
warnings. That gap is tracked in issue #415.

| `requirements.md` heading | `tasks.md` entry | resolves to | outcome |
| ------------------------- | ---------------- | ----------- | ------- |
| `### Requirement 2`       | `_Requirements: 2_`     | `Requirement-2`  | resolves |
| `### Requirement 2`       | `_Requirements: 2.1_`   | `Requirement-2`  | resolves |
| `### Requirement 2`       | `_Requirements: 2.1.1_` | `Requirement-2`  | resolves (major grain) |
| `### Requirement 10`      | `_Requirements: 10.2_`  | `Requirement-10` | resolves |
| `### Requirement 01`      | `_Requirements: 1.1_`   | `Requirement-1`  | **dangles** — zero padding is not normalized on either side |
| `### Requirement 0.1`     | `_Requirements: 0.1_`   | `Requirement-0`  | **dangles** — the heading is not a requirement node at all (issue #431) |
| `### 要件 1`               | `_Requirements: 1.1_`   | `Requirement-1`  | **dangles** — a non-English heading mints no requirement node (issue #431) |

On an `### 要件 N` project the whole feature is a complete no-op *and*
completely silent: `check --format json` is byte-identical to what it produced
before this change. Pinned by `issue #435 ② ### 要件 N headings` and
`issue #435 ⑥ numeric variants` in
`tests/issue-435-kiro-requirements-space.test.ts`.

`rename` cannot repair any of these for you. It rewrites the `### Requirement N`
heading and the `@impl` tags but **not** the `_Requirements:` lines, so renaming
a requirement a task references prints
`WARNING: "<id>" is still referenced by a task's _Requirements: list in <file>`
and exits **1** — the rewrite is applied (the files on disk are already changed),
the exit code is telling you the job is not finished. Edit the `_Requirements:`
lines by hand and re-run `artgraph reconcile`. Pinned by `issue #435 D2` in the
same file.

### Upgrade note

Built-in presets activate automatically on upgrade. Existing projects whose
`tasks.md` already contains `T###` (Spec Kit) or checkbox-prefixed numerics
(Kiro) will see new `task` nodes — and `doc → task` `contains` edges, plus
`task → verifies → Requirement-N` edges for Kiro `_Requirements:` lists — on
the next `artgraph scan`. Run `artgraph reconcile` to refresh the lock baseline.

### Upgrade note — Kiro `_Requirements:` now names requirements (issue #435)

Before this change a Kiro `_Requirements: 1.1_` produced an edge whose target
was the literal `1.1`, which collides with the *task* numbering in the same
file: the edges came out as self-loops or pointed at nothing. They now resolve
to `Requirement-1`, qualified by spec directory (`auth/Requirement-1`) exactly
like any other ID defined in more than one spec.

`artgraph reconcile` refreshes the lock baseline afterwards, but note what it
does **not** absorb — the blast radius reaches beyond the lock:

- **`plan-coverage --gate` can flip green → red.** A requirement co-referenced
  by a task that also references a requirement your change touches now lands in
  that task's impact set, and `plan-coverage`'s mention detector matches IDs
  *literally* — neither `### Requirement 2` (no hyphen) nor `_Requirements: 2.1_`
  matches `Requirement-2` — so the new arrival is reported as an *implicit*
  impact and the gate exits 1. Measured: a one-task fixture went from
  `{totalAffected: 1, mentioned: 1, implicit: 0}` / exit 0 to
  `{totalAffected: 2, mentioned: 1, implicit: 1}` / exit 1. Write the
  requirement ID (`Requirement-2`) into `tasks.md` / `plan.md` prose, or pass
  `--ignore`.
- **`check --diff` reports more.** The widened impact scope pulls the
  `tasks.md` doc node — and requirements reached through it — into scope, so
  `drifted`, `uncovered` and `suppressedCount` grow. Measured on a
  single-spec fixture: `drifted: []` → `drifted: [doc:auth/tasks.md]` and
  `suppressedCount: 0 → 1`. The **exit code did not change** in any measured
  scenario (`check --gate`, `check --diff --gate`, and
  `check --diff --base <ref> --gate` were all identical before and after) —
  what grows is the payload, in the fail-closed direction.
- **A spec directory whose `tasks.md` has no sibling `requirements.md`** (a
  cross-cutting planning spec) now emits
  `WARNING: ambiguous ID "Requirement-1"` and drops the edge, because
  `Requirement-1` exists in two other spec directories and nothing disambiguates
  it. See [Kiro numbers requirements per spec](#kiro-numbers-requirements-per-spec-so-a-second-spec-qualifies-every-id).
- **`rename` now exits 1** when the requirement it renamed is referenced from a
  `_Requirements:` list (see the section above). **`--dry-run` exits 1 for the
  same reason**, even though it writes nothing: the preview is what you read
  before committing to the rewrite, so it reports the same incompleteness the
  real run would. `--dry-run` could already exit 1 on a validation error (an
  unknown `--from` id, say), but that path prints an error envelope instead of
  a preview; this is the first condition under which it prints its **normal
  output** and still exits non-zero. A script that treats `--dry-run`'s exit
  code as "the rename is safe to run" should read the `warnings` array instead,
  which carries `unrewritten-task-requirement-ref` with the exact `tasks.md`
  paths.

Unchanged, and verified byte-for-byte on nine fixtures: `check`'s `coverage`,
`uncovered`, `orphans` and `pass`; the `.trace.lock` contents; and every
spec-kit project's output, down to the byte. A Kiro task's `verifies` edge has
never counted toward coverage and still does not.

## `trace` — coverage-derived traceability (spec 020) <a id="trace--coverage-derived-traceability"></a>

Opt-in: `req → code` `exercises` edges derived from **test-execution
evidence** (per-test coverage) instead of, or in addition to, `@impl`
claims. Requires the Vitest runner (`artgraph/vitest` /
`artgraph/vitest/config`; see the top-level
[README](../README.md#coverage-derived-traceability)) to populate
`.artgraph/trace/` — every field below is inert on a project with no trace
shards (FR-010: output stays byte-identical to before the feature existed).

```jsonc
// .artgraph.json
{
  "trace": {
    "artifacts": [".artgraph/trace/*.jsonl"], // glob(s); default shown
    "acceptExercises": false, // opt-in `exercised` coverage status
    "staleness": "warn", // "warn" | "exclude" | "gate"
    "sharedThreshold": 3 // symbols exercised by >= N REQs are "infrastructure"
  }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `artifacts` | `[".artgraph/trace/*.jsonl"]` | Glob(s) matched against trace shard files (same shape as `testResultPaths`, spec 006). |
| `acceptExercises` | `false` | When `true`, an untagged REQ backed by exclusive exercises evidence gets coverage status `exercised` instead of `uncovered`. Declared REQs (`impl-only` / `verified`) are never affected — evidence audits claims, it never substitutes for one. When left `false`, `check` still surfaces the eligible REQs — a `HINT:` in text output and the `exercisableUncovered` field in `--format json` — so a project that only tagged test titles (no code-side `@impl`) doesn't get silently stuck at `untagged`/`uncovered` forever (issue #284). |
| `staleness` | `"warn"` | How `check` treats exercises evidence whose recorded content hash no longer matches the current graph. `"warn"` reports `staleEvidence` only (exit code unchanged); `"exclude"` drops stale evidence from every judgment (UNEXERCISED CLAIM / SUGGESTED IMPL / `exercised`) while the underlying `exercises` edge stays in the graph for `impact`; `"gate"` makes `check --gate` exit `2` when any stale evidence is present, independent of the spec 017 baseline-diff gate. |
| `sharedThreshold` | `3` | A symbol exercised by this many or more distinct REQs' tests is classified as shared infrastructure, not a candidate `@impl`. |

> **Runner setup: prefer `withTrace()` over a bare `test.runner`.** Trace
> evidence is generation-replaced, not appended — each run supersedes the
> last. `withTrace()` enforces that by also wiring a `globalSetup` that
> deletes the previous run's `*.jsonl` shards before the run starts. Setting
> `test.runner: "artgraph/vitest"` directly skips that cleanup, so shards
> accumulate across runs (including interrupted ones) and outdated evidence
> keeps matching `artifacts` and feeding the graph. If you can't use the
> wrapper, wire the cleanup yourself via
> `test.globalSetup: ["artgraph/vitest/config"]` or clean the trace dir in CI.

### Trace capture engine: `instrument` (default) vs `cdp`

`withTrace()` takes an optional second argument that selects how trace
evidence is captured:

```ts
import { withTrace } from 'artgraph/vitest/config';
export default defineConfig(withTrace({ test: { ... } }, { engine: 'instrument' }));
```

| Engine | What it does |
| --- | --- |
| `instrument` (default) | Build-time static instrumentation: a Vite plugin marks each project-source function's entry point at transform time, and the runner reads those marks per test. Per-test capture cost no longer depends on how many modules are loaded. |
| `cdp` | The original per-test `Profiler.takePreciseCoverage` capture (inspector-based). Kept as a fallback. |

The environment variable `ARTGRAPH_TRACE_ENGINE` (`instrument` \| `cdp`)
overrides the `withTrace()` option and takes priority over it. An invalid
value fails fast — at `withTrace()` call time for the option, at runner
startup for the environment variable — rather than silently falling back to
a default.

Choose `cdp` when your source doesn't cleanly pass through vitest's
transform pipeline for the instrumentation plugin to see — for example, a
custom transformer positioned so the plugin can't run against the original
source, or code generated dynamically at runtime. Both engines are
differential-tested to produce equivalent shard output, so switching engines
does not change `check` / `trace report` / `impact` results.

See
[specs/022-instrumented-trace-engine/contracts/config-surface.md](../specs/022-instrumented-trace-engine/contracts/config-surface.md)
for the full `withTrace()` options contract.

### Exclusivity / silent / infrastructure

`suggestedImpls` (and the `exercised` coverage status) only fire for symbols
exercised **exclusively** by one REQ's tests. Between exclusive and
`sharedThreshold`, there is a third, deliberately quiet bucket:

| Distinct REQs exercising the symbol | Classification | Surfaced where |
| --- | --- | --- |
| exactly 1 | exclusive | `suggestedImpls` (or `exercised` coverage if `acceptExercises`) |
| 2 .. `sharedThreshold` − 1 | **silent** | nowhere in `check` / `trace report` — the `exercises` edge still exists and is still walked by `impact` |
| ≥ `sharedThreshold` | infrastructure | `trace report`'s `infrastructure` bucket only |

The silent middle band exists so a symbol touched by a handful of REQs is
flagged as neither a missing `@impl` nor noise-worthy shared code — it stays
usable for `impact` reachability without polluting `check` / `trace report`
output.

### `.gitignore` recommendation

Raw trace shards are a regenerable, per-run input artifact (analogous to a
coverage report), not something the graph or `.trace.lock` depend on being
present — only the derived `exercises` edges get persisted (into the lock's
`exercises` field on `reconcile`). `artgraph init` proposes (does not force)
adding `.artgraph/trace/` to `.gitignore`; whether you commit shards or treat
them as a CI artifact is a per-project call. See
[data-model.md](../specs/020-coverage-derived-edges/data-model.md) for the
full shard/lock lifecycle.

See [docs/commands.md#artgraph-trace](./commands.md#artgraph-trace) and
[docs/commands.md#artgraph-check](./commands.md#artgraph-check) for the CLI
reference (`trace status` / `trace report` / `check`'s new findings) and
[docs/commands.md](./commands.md#impact---diff---tests--test-selection-from-evidence-spec-020)
for `impact --diff --tests`.

## Edge provenance

Every edge in the graph carries a `provenances: EdgeProvenance[]` array
explaining where it came from. The nine values cover all generation sites:

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
| `coverage`    | normalized test-execution trace shards (`.artgraph/trace/`, spec 020) — `exercises` edges, or appended to `implements` when a claim and evidence corroborate the same `(req, symbol)` |

When the same `(source, target, kind)` is produced by multiple paths, the
arrays are union-merged and sorted (e.g. `["convention", "frontmatter"]`). The
`.trace.lock` mirrors this by storing each `dependsOn` element as
`{id, provenances}`.

> **Note on lock `dependsOn` consumers.** The structured `dependsOn` field in
> `.trace.lock` is currently not consumed by runtime code paths: `artgraph
> check` decides drift purely from `contentHash`, and coverage computation /
> `impact` / `traverse` walk `graph.edges` directly. Its present value is (a) a
> presentational diff target when reviewers read `git diff .trace.lock`, and
> (b) the input that `artgraph rename` rewrites when an ID changes. A
> first-class consumer (e.g. an `artgraph diff` subcommand surfacing
> dependency churn) is future work — the `diff` CLI does not exist yet.

The formalisation lives in [specs/011-edge-provenance/](../specs/011-edge-provenance/).
