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
