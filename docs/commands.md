# Command reference

Full CLI reference. For the summary table and the agent-native workflow, see
the top-level [README](../README.md). Run `artgraph --help` for the
authoritative flag list.

## Fatal errors: stdout/stderr contract (issue #279)

This is the contract every command's **fatal** errors (a thrown exception
that aborts the command outright — usage errors, environment failures like a
broken oxc-parser native binding, unrecoverable validation failures) follow,
across every command that has a `--format` option:

- **text** (default, and every command with no `--format` at all, e.g.
  `reconcile`): a human-readable message on **stderr**, exit `1`.
- **json** (`--format json`): a `{"error": "<message>"}` envelope on
  **stderr**, exit `1`. Never mixed into stdout — a `--format json`
  consumer piping stdout to `jq` never has to guard against invalid JSON or
  a truncated/partial payload, and stdout is reserved exclusively for a
  **successful** result's structured payload.

This applies uniformly to: a command's own usage/validation errors, a
rejected `LockSchemaVersionError` (a `.trace.lock` written by a newer
artgraph), a rejected `ReconcileResourceExhaustedError` (`reconcile()`
refusing to write the lock because the scan hit file-descriptor exhaustion —
issue #335; see [`artgraph reconcile`](#artgraph-reconcile) below —
`.trace.lock` is left completely untouched), `rename`'s validation/safety-valve
failures (`RenameValidationError`, issue #273), a malformed `.artgraph.json`
(`loadConfig()`'s `Failed to parse ...`, issue #336), an `AgentsParseError`
from `--agents=<list>` (issue #336), and `OxcLoadError` (oxc-parser's native
binding missing/broken, issue #263) —
every command whose action reaches `loadConfig()` and/or `scan()`/
`buildGraph()` (`scan`, `check`, `impact`, `plan-coverage`, `reconcile`,
`trace status`, `trace report`, `rename`, `init`, `doctor`) surfaces every
one of these through this same stderr/exit-1 contract instead of a raw,
format-blind stack trace (`commands/shared.ts#withFatalErrors`, issue #336 —
a superset of the original issue #279 `OxcLoadError`-only guard).

**Declared exceptions to this contract** (deliberately not touched by this
section, or by issue #279):

- **`impact --diff --base <ref>`'s environment errors** (unresolvable ref,
  uncomputable merge-base) already have their own stricter contract — **zero
  bytes of stdout**, even under `--format json` — documented under
  [`impact --diff --base <ref>`](#impact---diff---base-ref--commit-range-selection-in-ci-spec-024)
  below. That contract predates this section and is unchanged; it is
  stricter than (a subset of) the general rule above, not a conflict with
  it.
- **`rename`'s text-mode success path splits its two warning kinds across
  streams**: `RenameWarning`s (`manual-assignment-needed`,
  `unknown-trace-schema`, `unreadable-file`) print to **stdout** as part of
  the rename summary, while `BuildWarning`s (`buildWarnings`,
  `postWriteWarnings`) print to **stderr** via `printWarnings`. This is an
  existing, current-behavior split (Step 0-pre M3), documented here as-is —
  changing it is out of this section's scope; file a separate issue if it
  should be unified.

## `artgraph init`

Full agent-native setup in one command: `.artgraph.json` config + initial scan

- cross-agent Skills distribution + Stop hook + `AGENTS.md` snippet +
  auto-integrate of detected SDD tools.

```bash
artgraph init --agents=claude              # required for the Skills / agent-context stages
artgraph init --agents=claude,codex,cursor,copilot,kiro
artgraph init --minimal                    # bare config only (no Skills / hooks / integrate)
artgraph init --no-skills                  # skip only the Skills distribution
artgraph init --no-agent-context           # skip AGENTS.md snippet + wrapper files
artgraph init --no-integrate               # skip detected SDD tool auto-integration
artgraph init --no-hooks                   # skip .claude/settings.json Stop hook
artgraph init --force                      # overwrite existing distributed files
```

`--agents=<list>` is **required** whenever a stage that writes agent-specific
files runs. Supported values: `claude`, `codex`, `cursor`, `copilot`, `kiro`
(lowercase, comma-separated). Pass `--agents=<list>` alongside any of the
opt-out flags so at least the remaining stages know where to write.

The generated Stop hook `command` string is package-manager-specific
(`pnpm exec artgraph …` under pnpm, `bunx artgraph …` under bun,
`npx artgraph …` under npm, `deno run -A npm:artgraph/cli …` under Deno). If
team members use different package managers, standardize on one or add
`.claude/settings.json` to `.gitignore` so each developer runs `artgraph init`
locally.

**Resource exhaustion during the initial scan (issue #335).** If the scan
stage hits file-descriptor exhaustion, `reconcile()` refuses to write
`.trace.lock` from what may be an incomplete graph — but `init` does NOT
abort: every other stage (Skills distribution, SDD-tool auto-integration,
the Stop hook, `AGENTS.md`/wrapper injection, and the final `.artgraph.json`
write) still runs to completion. Text/json output reports the skipped lock
write and points at `artgraph reconcile` as the follow-up once your
environment has recovered. Every OTHER reason `reconcile()` can refuse a
write (e.g. a `.trace.lock` written by a newer artgraph) is unchanged —
still aborts the whole `init`.

## `artgraph scan`

Build the artifact graph. Default output is a text summary of node/edge
counts; `--format json` emits the full req/doc/code/test graph for machine
consumption. `--serve` and `--output` render that graph as an interactive
HTML page (see below).

When trace shards exist under `trace.artifacts` (see
[Configuration](./configuration.md)), `scan` also ingests them and merges
coverage-derived `exercises` edges into the graph — evidence-only pairs
become `exercises` edges, and pairs matching an existing `@impl` claim gain
the `coverage` provenance on the `implements` edge. With no shards present,
output is byte-identical to a trace-less project. See
[`artgraph trace`](#artgraph-trace) for the audit report over the same data.

```bash
artgraph scan                              # text count summary
artgraph scan --format json                # full graph as JSON
```

### `artgraph scan --serve` — interactive visualization

`--serve` and `--output` render the graph as an interactive Cytoscape.js page,
with node border color/style encoding `drift` / `orphan` / `uncovered` state
so you can spot problem areas without reading `check` output line by line.

```bash
artgraph scan --serve                                   # 127.0.0.1:3737
artgraph scan --serve --port 4000 --host 0.0.0.0
artgraph scan --output ./graph-out                      # static HTML export
```

Binding to `0.0.0.0` (or an equivalent IPv6 "all interfaces" address, e.g.
`::`) is an intentional opt-in to expose the server beyond localhost to your
LAN; `artgraph` prints a `warning: binding to 0.0.0.0 exposes the graph to
your network` line on stderr when it does, since the server has no
authentication.

`--serve` and `--output` are mutually exclusive. Both read `.trace.lock` when
present to color drift/orphan/uncovered nodes; a missing lock just renders
without that extra state.

`--output` only ever writes `index.html`, `app.js`, `vendor/cytoscape.min.js`,
and `vendor/cytoscape.LICENSE` (the bundled library's MIT notice)
into the target directory, and refuses to run if it finds anything else there
(e.g. you pointed `--output` at a GitHub Pages `docs/` dir or the repo root by
mistake) — pass `--force` to overwrite anyway. The `vendor/` subdirectory is
always wiped and rewritten from scratch, so stale artifacts from a previous
`artgraph` version never accumulate across repeated `--output` runs. The write
itself is not atomic — a crash mid-export can leave a partial `outputDir` — the
same trade-off other static-site generators (VitePress, TypeDoc, Sphinx) make.

## `artgraph check`

Report drift / orphans / uncovered against `.trace.lock`. `--gate` exits
non-zero when any finding is present, suitable for CI or pre-commit hooks.

```bash
artgraph check                             # text output
artgraph check --gate                      # exit non-zero on findings
artgraph check --diff                      # only report items changed since the lock
artgraph check --format json               # per-requirement rows + counts
artgraph check --diff --base origin/main --gate   # CI: gate the PR's commit range
```

### `--gate` exit codes: pass / undeterminable / fail

`check --gate` distinguishes three outcomes, never collapsing "we couldn't
tell" into either a pass or a fail:

- **`0`** — pass. No new issue (or, without `--diff`, no issue at all).
- **`1`** — **undeterminable**. The verdict cannot be trusted either way, so
  it is never reported as a pass. Two causes land here:
  - the `--diff --base <ref>` baseline could not be established
    (unresolvable ref, shallow clone with no merge-base, worktree failure —
    spec 017 FR-010 / spec 023);
  - this scan hit file-descriptor exhaustion (`system-resource-exhausted` —
    EMFILE/ENFILE while enumerating spec or code files) and the graph it
    built may be missing entire spec/code trees (issue #335). Retry once the
    environment has recovered (e.g. a higher `ulimit -n`). A plain `check`
    (no `--gate`) does not exit `1` for this — the warning is still shown,
    but the command otherwise behaves exactly as before.
- **`2`** — fail. A genuine new (or, without `--diff`, any) issue was found.

### `--base <ref>` — commit-range gating for CI (spec 023)

In CI the checked-out working tree matches the commit exactly, so the plain
`--diff` set (staged + unstaged + untracked) is empty on every run.
`--base <ref>` extends the changed-file set with the committed range and
re-bases the baseline:

- **Merge-base semantics** — everything is judged against
  `git merge-base <ref> HEAD` (the branch point), never `<ref>`'s tip, so a
  base branch that moved ahead after the branch point can't cause false
  failures or mask the PR's own issues. The changed-file set is the
  working-tree union PLUS the committed `mergeBase..HEAD` range — untracked
  local edits still count.
- **Requires `--diff`** — `--base` without `--diff` is a usage error
  (exit `1`); it is never silently ignored.
- **Exit codes** — `0` gate pass (including a genuinely empty merged diff),
  `2` the change range introduced new drift / orphans / uncovered / test
  failures, `1` the baseline could not be established (unresolvable ref,
  shallow clone with no merge-base, worktree failure) — fail-closed, with a
  `fetch-depth: 0` hint in the error message.
- **CI recipe** — `actions/checkout@v4` with `fetch-depth: 0`, then
  `artgraph check --diff --base "origin/${{ github.base_ref }}" --gate`.

### Evidence-aware findings (spec 020)

When trace shards exist under `.artgraph/trace/`, `check` gains three
additional findings — the same "declared vs. exercised" cross-check as
[`artgraph trace report`](#artgraph-trace), plus a freshness check. On a
trace-absent project none of this appears; output is byte-identical to
before the feature shipped.

| Finding           | Text heading         | `--format json` field | Meaning                                                                                                    |
| ----------------- | -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Unexercised claim | `UNEXERCISED CLAIM:` | `unexercisedClaims`   | `@impl REQ-001` exists but REQ-001's tagged green tests never execute that symbol                          |
| Suggested impl    | `SUGGESTED IMPL:`    | `suggestedImpls`      | No `@impl`, but the symbol is exercised exclusively by one REQ's tests                                     |
| Stale evidence    | `STALE EVIDENCE:`    | `staleEvidence`       | The symbol's content hash changed since its trace evidence was captured (`{ reqId, symbols[], tracedAt }`) |

`trace.staleness` (`.artgraph.json`, default `"warn"`) controls how stale
evidence is treated: `"warn"` reports it only; `"exclude"` drops stale
`exercises` edges from every judgment above (they still exist in the graph
for `impact`); `"gate"` makes `check --gate` exit `2` when any stale evidence
is present — independent of the spec 017 baseline-diff gate. See
[docs/configuration.md#trace--coverage-derived-traceability-spec-020](./configuration.md#trace--coverage-derived-traceability-spec-020)
for the full `trace.*` config reference.

### `exercised` coverage status

`--format json`'s `coverage` rows normally report `untagged` / `impl-only` /
`verified`. When `.artgraph.json` sets `trace.acceptExercises: true`, an
untagged REQ backed by exclusive exercises evidence reports `exercised`
instead of `uncovered`. Declared REQs (`impl-only` / `verified`) are never
affected — evidence audits claims, it never substitutes for a declared one.

### `exercisableUncovered` — the `acceptExercises` hint (issue #284)

When trace shards exist but `trace.acceptExercises` is `false` (the
default), `--format json` also includes `exercisableUncovered`: a `string[]`
of `uncovered` REQ ids that already have exclusive exercises evidence
(stale evidence is excluded only under `trace.staleness: "exclude"`; under
the default `"warn"` stale evidence still counts, exactly as it would for
the real `exercised` status) and would flip to `exercised` — leaving
`uncovered` — the moment `acceptExercises` is turned on. The eligible REQs
largely coincide with the ones `suggestedImpls` names: `suggestedImpls`
suppresses a REQ once **that REQ itself** already has a code-claim
(`@impl`/`implements`) anywhere in the graph (issue #285 — REQ-scoped, not
tied to the specific node its exclusive evidence lands on; task-sourced
`implements` edges don't count as a claim, matching `check`'s own
`uncovered`/`exercised` rule) — and every REQ `exercisableUncovered` lists is
by definition already claim-free (it only ever considers `uncovered` REQs),
so this particular suppression never removes one of them. The two can still
diverge on `suggestedImpls`'s `contains`-hierarchy suppression: an
ancestor/descendant node already claiming the SAME reqId holds back a
redundant nested suggestion (e.g. a class-level `@impl` already "found" a
method's requirement) — `exercisableUncovered`'s `exercised` counterfactual
has no such hierarchy awareness. It is purely informational: it never
affects `pass`,
`newIssues`, or any gate/exit-code decision, and is always `[]` once
`acceptExercises` is already `true` (anything it would rescue has already
left `uncovered`). Text output (`printCheckText`) surfaces the same
information as a `HINT:` line right after the `UNCOVERED:` section, naming
the eligible REQ ids and the exact `.artgraph.json` snippet to add. This is
the escape hatch for
projects bootstrapped with the [`artgraph-bootstrap`](../templates/skills/artgraph-bootstrap/SKILL.md)
Skill's test-tag path (test-title `[REQ-NNN]` tags only, no code-side
`@impl`) — those REQs are `verifies`-only and stay `untagged`/`uncovered`
forever without this flag.

### `staleLockEntries` — lock keys with no graph node (issue #244)

`.trace.lock` can end up with keys that no longer resolve to any node in the
current graph — most commonly a rename/refactor that changed a symbol's id,
but the same thing can happen with no rename at all: a `.artgraph.json`
`mode`/`include`/`exclude`/`ignoreIdPrefixes` change can stop a previously
tracked id from resolving. Because such an id is by definition absent from
the graph, the normal drift/orphan/uncovered checks can never see it — it
was previously invisible until `artgraph reconcile` silently dropped it.
`--format json` now reports these ids directly as `staleLockEntries`, a
sorted `string[]`, present ONLY when non-empty (omitted entirely otherwise,
same optional-omit convention as the spec 020 fields above). This is
unrelated to `staleEvidence`/`staleGate` above — those track trace-evidence
freshness against the graph, while `staleLockEntries` tracks whether a lock
key itself still exists in the graph at all. It is purely informational: it
never affects `pass`, `newIssues`, or any gate/exit-code decision. Resolve
it by running `artgraph reconcile`.

Caveat: under `--diff`, an early-return path (no changed files, or changed
files outside the graph) skips `check()` entirely, so `staleLockEntries` is
not emitted on that run either. To reliably see the full lock/graph
reconciliation state, run `artgraph check --format json` without `--diff`.

## `artgraph impact`

Forward impact analysis: files/symbols → REQs / docs / tests.

```bash
artgraph impact src/auth.ts                # explicit file
artgraph impact src/auth.ts:validateToken  # symbol (requires "mode": "symbol")
artgraph impact src/auth.ts:Sample.methodA # class-method unit (in-file precision; consumers not included)
artgraph impact --diff                     # everything in git diff
artgraph impact --diff --format json
```

`--diff` walks the deterministic TypeScript import graph even in a fresh repo
with no `@impl` tags or `.trace.lock`, so it works from day one. Requirement
IDs are rejected as inputs — see the [rename note](#rename-does-not-reassign-impl-tags)
if you need to trace the other direction.

### Traversal semantics: declared edges are transitive, observed edges are collect-terminal (issue #361)

Not every edge kind propagates the same way. **Declared** edges — `implements`,
`verifies`, `contains` (doc → req|task, forward only), and `depends_on`/
`derives_from` carrying an explicit declaration (frontmatter or an inline
`(depends_on: ...)` annotation) — are strong: `impact` follows them
transitively, hop after hop. **Observed** edges — `exercises` (req ↔ code,
derived from test-execution coverage, [`artgraph trace`](#artgraph-trace))
and a `depends_on`/`derives_from` edge whose provenance is inline-link-only
(an author happened to write a markdown link, not a declared dependency) —
are weak: `impact` still *collects* whatever they reach (it lands in the
output), but never re-opens it for a further hop. A REQ reached only through
someone else's incidental test coverage, or a doc reached only through
someone else's markdown link, cannot itself become a bridge to a THIRD,
unrelated node. A later declared (strong) path to the same node still
upgrades it to fully transitive.

This is why, for example, changing a symbol that an unrelated REQ's test
happens to call no longer pulls that REQ's own other dependencies into the
impact set, and why a single markdown link from a hub doc no longer fans out
to everything the linked doc itself links to. See
[`specs/020-coverage-derived-edges/spec.md` FR-017](../specs/020-coverage-derived-edges/spec.md)
and `src/graph/traverse.ts`'s file-header comment for the full edge-kind ×
direction classification table.

A restricted test hub's own `verifies` to an evidence-only REQ additionally
requires that REQ's own `exercises` evidence to reach back to the walk's
origin (the "matching predicate") — **except** in a project that has never
ingested a trace shard, where the graph has zero `exercises` edges anywhere
and the predicate can never be satisfied by construction; `impact` fails open
in that one case (bare hub membership is enough, as it was pre-#361) so a
trace-absent project's evidence-only REQs still surface instead of being
silently dropped from `impactReqs` / `check --diff --gate` scope (issue
#363). The moment the graph has even one `exercises` edge anywhere, the
predicate is mandatory again project-wide.

### `impact --diff --tests` — test selection from evidence (spec 020) <a id="impact---diff---tests--test-selection-from-evidence-spec-020"></a>

`--tests` (only valid alongside `--diff`) lists exactly the `[REQ-NNN]`-tagged
tests whose test-execution evidence reaches the changed nodes, instead of the
full suite — test-impact-analysis as a byproduct of the `exercises` edges
described in [`artgraph trace`](#artgraph-trace) below.

```bash
artgraph impact --diff --tests --format json
```

```json
{
  "testsToRun": [
    {
      "testFile": "tests/billing.test.ts",
      "testName": "[REQ-003] charge bills a positive amount",
      "reqId": "REQ-003"
    }
  ]
}
```

When the graph has any `exercises` edges at all, `impact`'s regular JSON
output gains a `reqProvenance` array — `{ reqId, provenance: ("static" |
"evidence")[] }` per reached REQ — so a consumer can tell whether a REQ was
reached via a static path (`@impl` / `imports`) or via `exercises` evidence
(or both).

**Exit codes**: normal impact exit codes apply, plus — trace-absent and
`--tests` is passed → exit `1` with the same runner-setup guidance as
`artgraph trace report` (below).

### `impact --diff --base <ref>` — commit-range selection in CI (spec 024) <a id="impact---diff---base-ref--commit-range-selection-in-ci-spec-024"></a>

In CI the checked-out working tree matches the commit exactly, so plain
`impact --diff --tests` sees an empty diff and returns "No changes detected"
on every run — test selection silently never selects anything. `--base <ref>`
widens the changed-file set to the merged diff:

```bash
artgraph impact --diff --base "origin/${{ github.base_ref }}" --tests --format json
```

- **Merge-base semantics** — the committed range is
  `git merge-base <ref> HEAD`..`HEAD` (the branch point), never `<ref>`'s
  tip. The changed-file set is the working-tree union (staged + unstaged +
  untracked) PLUS that committed range — `--base` adds the range, it never
  shrinks the local diff. It is the same set, from the same implementation,
  that `check --diff --base <ref>` judges (the two commands cannot disagree
  on what changed).
- **Requires `--diff`** — `--base` without `--diff` is a usage error
  (exit `1`, no JSON); it is never silently ignored. `--base` is a `--diff`
  modifier, not a start source.
- **Fail-closed environment errors** — an unresolvable ref (typo, unfetched
  branch) or an uncomputable merge-base (shallow clone, unrelated histories)
  exits `1` with a `fetch-depth: 0` hint on stderr and **zero bytes of
  stdout, even under `--format json`** — an environment failure is not a
  verdict, and an empty-`testsToRun` payload would misread as "nothing to
  run". There is no fallback to a working-tree-only diff.
- **Selection limits (declared)** — startIds resolve against the _current_
  graph only: a file **deleted** by a commit in the range, or a changed file
  the graph does not track, contributes no start ids — silently, exactly
  like graph-external files always have under `--diff`. `impact` takes no
  baseline worktree and no rename map (a base-range rename is folded to its
  new path, which is the correct current-graph input). A file **renamed**
  in the range is in the same boat with respect to _stale evidence_: its
  start ids resolve under the new path, but trace shards cached from the
  base branch record evidence under the old path, so the `--tests` join
  misses and its tests silently drop from the selection.
- **Consumer rule** — deleted, renamed (w.r.t. stale pre-rename evidence),
  or graph-untracked changed files contribute nothing to the selection.
  Treat `impact --tests` as an **optimization** — fall back to
  the full suite on exit `1` or whenever unsure. The correctness gate
  remains `check --diff --base --gate` (which _does_ resolve deletions
  against the baseline and fails the PR on the resulting uncovered REQs).
  Also filter the selected test files for existence before handing them to
  the runner — a PR that deletes a test file can yield a selection of
  nonexistent paths, and `vitest run` exits `1` on those (red CI on a
  legitimate PR).
- **`trace.staleness: "exclude"` interaction** — in CI the trace shards
  necessarily predate the change (e.g. cached from the base branch), so the
  changed code's evidence is stale _by construction_ and `"exclude"` drops
  exactly the tests most related to the change. Combining `--tests`,
  `--base` and `staleness: "exclude"` emits a non-fatal stderr warning; use
  `staleness: "warn"` for CI test selection, or fall back to the full suite.

| exit code | meaning                                                                              | CI consumer action                                                                 |
| --------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `0`       | valid selection — including the legitimate "No changes detected" empty merged diff   | use `testsToRun` (treat an empty selection with suspicion — see the consumer rule) |
| `1`       | usage error, unresolvable ref / merge-base, or no changed path resolved in the graph | **fall back to the full suite**                                                    |

### Resource exhaustion (issue #351)

Unlike `check --gate` (which distinguishes pass / undeterminable / fail
across three exit codes), `impact` has always had a simple pass/fail exit
contract — so a scan that hit file-descriptor exhaustion
(`system-resource-exhausted` — EMFILE/ENFILE while enumerating spec or code
files, or while re-parsing the trace-shard symbol table for `--tests`) is
folded into the same **exit `1`** every other undeterminable/fail-closed
condition in this section already uses, with a dedicated stderr message
explaining why. This applies **unconditionally, in every mode** (explicit
targets, `--diff`, `--tests`) and to every early-exit path (including the
legitimate "No changes detected" empty-diff case) — the graph this scan built
may be missing entire spec/code trees, so no result from it can be trusted,
regardless of which path produced it. The JSON/text payload each path already
produces is always fully preserved; the resource-exhaustion check only adds
the stderr diagnostic and forces the exit code. Retry once the environment
has recovered (e.g. a higher `ulimit -n`) — this is exactly the "fall back to
the full suite" signal the table above already documents for exit `1`, it
just has one more cause now.

## `artgraph trace` <a id="artgraph-trace"></a>

Coverage-derived traceability (spec 020): cross-checks `@impl` claims
against test-execution evidence captured by the
[Vitest runner](../README.md#coverage-derived-traceability) into
`.artgraph/trace/`. Both subcommands are **read-only** — neither touches the
graph or `.trace.lock`.

```bash
artgraph trace status                      # shard counts, diagnostics, staleness rate
artgraph trace status --format json
artgraph trace report                      # @impl-vs-evidence cross-check
artgraph trace report --format json
```

### `artgraph trace status`

Reports how much evidence is on disk and how fresh it is.

```json
{
  "shardCount": 4,
  "testCount": 12,
  "skippedCount": 1,
  "diagnostics": {
    "dangling": 0,
    "corrupted": 0,
    "offGraph": 0,
    "unknownSchema": 0,
    "skipped": 1,
    "stale": 2
  },
  "staleRate": 0.15
}
```

### `artgraph trace report`

The "declared vs. exercised" audit. Classifies every `(req, symbol)` pair
touched by either an `@impl` claim or exercises evidence into four buckets:

```json
{
  "corroborated": [{ "reqId": "REQ-001", "node": "symbol:src/auth.ts#signIn" }],
  "unexercisedClaims": [{ "reqId": "REQ-001", "node": "symbol:src/legacy.ts#oldSignIn" }],
  "suggestedImpls": [{ "reqId": "REQ-002", "node": "symbol:src/auth.ts#resetPassword" }],
  "infrastructure": [{ "node": "symbol:src/util.ts#validateEmail", "reqCount": 3 }],
  "diagnostics": {
    "dangling": 0,
    "corrupted": 0,
    "offGraph": 0,
    "unknownSchema": 0,
    "skipped": 1,
    "stale": 0
  }
}
```

- `corroborated` — an `@impl` claim backed by exercises evidence for the
  same `(req, symbol)` pair.
- `unexercisedClaims` — `@impl REQ-001` exists, but REQ-001's tagged green
  tests never execute that symbol. The anti-fabrication signal: a claim with
  no evidence behind it.
- `suggestedImpls` — a symbol with no `@impl` that is exercised exclusively
  by exactly one REQ's tests (a candidate `@impl` you might be missing).
- `infrastructure` — a symbol exercised by `trace.sharedThreshold` (default
  `3`) or more distinct REQs; demoted out of `suggestedImpls` as shared code,
  and not surfaced anywhere else (see the exclusivity/silent/infrastructure
  table in
  [docs/configuration.md](./configuration.md#trace--coverage-derived-traceability-spec-020)).

**Exit codes**: `0` on a normal report. **`1`** when zero trace shards are
found — the report's entire premise is evidence to cross-check against, so
a trace-absent project gets an error with runner-setup guidance instead of
four silently-empty arrays. Same guidance text as `impact --diff --tests`
above.

### Resource exhaustion (issue #351)

Both `status` and `report` build their graph (and, when shards exist,
re-parse the trace-shard symbol table) the same way every other command
does — a scan that hits file-descriptor exhaustion
(`system-resource-exhausted`) no longer crashes either subcommand. `warnings`
in the `--format json` payload carries the usual `system-resource-exhausted`
entry, and a dedicated one-line notice is also printed to stderr (in every
`--format`) pointing out that the shard counts / classification above may be
incomplete. **Exit codes are unchanged**: `status` still always exits `0`
(it is a diagnostic read, not a hard requirement), and `report` keeps its
existing `0` / `1` (zero-shards) contract — resource exhaustion does not add
a new exit path to either subcommand.

## `artgraph plan-coverage`

Reverse audit: REQs reachable from `tasks.md` `Files:` blocks that are not
mentioned in `tasks.md` / `plan.md` / `spec.md`.

```bash
artgraph plan-coverage                     # audit current SDD feature directory
artgraph plan-coverage --format json
```

Typically fired by the `artgraph-plan-coverage` Skill after `/speckit-tasks`
or after editing `.kiro/specs/<name>/tasks.md`. Manual invocation is fine
during troubleshooting.

Mentioning a REQ-ID anywhere in `tasks.md` / `plan.md` / `spec.md` drops it
from `implicitImpacts` — but the match is a literal per-ID word-boundary
match, not a range parser: `REQ-001 through REQ-032` (or `..`-style
equivalents) only mentions the two endpoint IDs, leaving the IDs in between
still implicit. Spell out each ID individually to cover a range.

### Resource exhaustion (issue #351)

`--gate`'s exit condition now also trips on `system-resource-exhausted` in
the scan's `warnings`, in addition to a non-empty `implicitImpacts` /
`diagnostics`: a scan that hit file-descriptor exhaustion (e.g. one
`specDirs` entry failed to enumerate) can leave `implicitImpacts` /
`diagnostics` genuinely empty even though the scan was demonstrably
incomplete — an entire spec directory's REQs may simply never have existed
in the graph to be flagged. Without this, `--gate` reported a false-green
`exit 0` in exactly that case. **Known asymmetry**: unlike `check --gate`
(which has a separate exit `1` for "undeterminable" vs. exit `2` for a
genuine gate failure), `plan-coverage` has only one non-zero exit code, so a
resource-exhausted run and a genuine gate-fail run are **both exit `1`**
here. Tell them apart via the dedicated stderr message (`--gate` only) or
via `warnings[]` in `--format json`. A non-`--gate` run is unaffected:
`warnings` is already printed via the normal warning path and the command
stays exit `0`.

## `artgraph reconcile` <a id="artgraph-reconcile"></a>

Rebuild `.trace.lock` from the current graph. Run after intentional spec/code/
test edits when `artgraph check` reports drift you accept.

```bash
artgraph reconcile
```

`rename` runs this automatically after a non-preview rename.

**Lock schema version**: `.trace.lock` carries a `_meta.schemaVersion` stamp.
If the on-disk lock was written by a _newer_ artgraph than the one running
`reconcile` (or `rename`, or `init`'s initial scan), the write is refused with
a clear error — rebuilding it here would silently discard information the
newer CLI understood. `--force` overwrites it anyway (a "Downgrading lock
schema vN -> vM" notice is printed, and newer entries may be lost). If this
happens because **CI is pinned to an older artgraph version**, update CI's
artgraph instead of reaching for `--force` there — `--force` on every CI run
just repeatedly discards whatever the newer local CLI wrote.

**Resource exhaustion (issue #335)**: if this scan hit file-descriptor
exhaustion (`system-resource-exhausted` — EMFILE/ENFILE while enumerating
spec or code files), `reconcile` refuses to write the lock — the graph it
built may be missing entire spec/code trees, and writing it would silently
coarsen or drop real entries. `.trace.lock` is left completely untouched
(existing content, if any, is unmodified). Exits `1` with a clear message on
stderr (same [Fatal errors](#fatal-errors-stdoutstderr-contract-issue-279)
contract as every other rejected write here). There is no `--force` escape
hatch for this one — unlike a lock-schema-version mismatch, there is nothing
principled to force past; retry once your environment has recovered (e.g. a
higher `ulimit -n`).

## `artgraph rename`

Renames, splits or merges a requirement ID and rewrites **every** reference to it
(spec list items / headings, `@impl` tags, test tags, frontmatter
`depends_on` / `derives_from`, and `.trace.lock` keys) in one pass, limited to
the files `.artgraph.json` puts in scan scope (`specDirs` markdown plus
`include` / `testPatterns` code and tests). Git tracking state is irrelevant:
uncommitted and untracked files are rewritten too.

- **Rewrite scope always matches scan scope (issue #350).** `rename`
  enumerates its code/test rewrite candidates through the exact same
  `discoverCodeFiles` pool-separated discovery helper `scan`/`check`/
  `impact` use to build the graph (see
  [`include` / `testPatterns`](configuration.md#include--testpatterns)),
  instead of a separately-written equivalent. A file the graph discovers is
  therefore always a file `rename` rewrites, and vice versa — a
  `testPatterns`-only negative pattern can no longer leave a renamed ID
  stale in a file the next `scan` picks back up (which would have
  surfaced as a surprise `orphan-edge`/`uncovered` finding).

```bash
artgraph rename --from REQ-001 --to REQ-100
artgraph rename --split REQ-001 --into REQ-101 REQ-102
artgraph rename --merge REQ-001 REQ-002 --into REQ-100
artgraph rename --from REQ-001 --to REQ-100 --dry-run
artgraph rename --from REQ-001 --to REQ-100 --format json
```

Notes:

- **Always commit first** — rename writes files in place (untracked ones
  included). Use `--dry-run` to preview.
- **Target IDs are validated**: they must match the requirement-ID grammar
  (`REQ-001`, `auth/FR-2`, `Requirement-3`) or the `doc:` prefix, so the
  renamed ID is guaranteed to be re-discoverable by the next scan.
- After a non-preview run the lock is automatically reconciled, so
  `artgraph check` passes immediately for `rename` and `merge`.
- **Lock schema version**: like `reconcile`, a non-preview `rename` refuses to
  touch a `.trace.lock` written by a newer artgraph unless `--force` is given
  (see the note under [`artgraph reconcile`](#artgraph-reconcile) above).
  `--dry-run` also warns on a newer-schema lock (it never writes, so it isn't
  rejected) — the same "update CI's artgraph, don't `--force` it" guidance
  applies.
- **`postWriteWarnings` (issue #273-2)**: after a non-preview run whose
  post-write scan found a `.trace.lock` to reconcile against, the JSON result
  carries `postWriteWarnings` — the SET DIFFERENCE of that post-write scan's
  `buildGraph()` warnings against the pre-write scan's `buildWarnings`
  (structurally keyed by type+id+sorted-files+message; `system-resource-exhausted`
  keys on type alone — issue #336 F3/F4). It is therefore only ever NEW
  warnings this specific run's post-write scan produced that the pre-write
  scan did not already have — a pre-existing, rename-unrelated warning never
  reappears here. `postWriteWarnings` is `undefined` (omitted from the JSON
  payload) when no post-write scan ran at all — either `--dry-run` (which
  never writes or reconciles) or no `.trace.lock` file existed to reconcile
  against — versus `[]` when the post-write scan DID run and found nothing
  new. Callers must not conflate the two: `undefined` is "no data", `[]` is a
  real, positive "ran and found nothing new" signal. A non-empty
  `postWriteWarnings` is a signal to INVESTIGATE, not necessarily proof the
  rename itself is the cause — the underlying condition (e.g. an
  environment-wide `system-resource-exhausted`) can coincide with, rather
  than be caused by, this rename.
- **Resource exhaustion on the post-write scan (issue #335)**: if THAT
  post-write scan (not the pre-write one) hits file-descriptor exhaustion,
  `reconcile()` refuses to update the lock — but the file rewrites
  themselves are NOT rolled back; they already happened. This surfaces
  through `postWriteWarnings` as a `system-resource-exhausted` entry whose
  message explicitly says the files were rewritten but the lock was not,
  and points at `artgraph reconcile` as the follow-up once the environment
  has recovered.
- **Fatal-error envelope's optional `warnings` field**: when a non-preview
  rename fails validation (`RenameValidationError`, issue #273) AFTER the
  pre-write scan already ran, the `--format json` error envelope described in
  ["Fatal errors"](#fatal-errors-stdoutstderr-contract-issue-279) above gains
  an optional `warnings` field carrying that pre-write scan's `BuildWarning[]`
  (e.g. `{"error": "...", "warnings": [...]}`) — omitted entirely when there
  are none, never an empty array. Text mode prints the same warnings via
  `printWarnings` (stderr) before the `Error: ...` line instead.
- **Pre-write resource-exhaustion gate (issue #351)**: `rename` / `split` /
  `merge` all refuse outright — exit `1`, via the same `RenameValidationError`
  envelope as any other pre-write validation failure — when the pre-write
  scan's `warnings` carries `system-resource-exhausted`. The scan that
  resolves "does this ID already exist" (`existingIds`) may be missing an
  entire spec/code subtree, so a real ID collision could go undetected and
  get written as a silent duplicate. **This applies to `--dry-run` too** —
  fail-closed by design, since a preview built from a degraded scan would be
  actively misleading. There is no `--force` escape hatch for this one (same
  reasoning as `reconcile`'s equivalent refusal above); retry once the
  environment has recovered (e.g. a higher `ulimit -n`). The post-write
  `ReconcileResourceExhaustedError` protection (documented above, under
  `postWriteWarnings`) is unchanged and unrelated — that one guards the LOCK
  write after files are already rewritten; this one guards the file rewrites
  themselves from ever starting.

### rename does not reassign `@impl` tags <a id="rename-does-not-reassign-impl-tags"></a>

**split** intentionally does **not** re-assign `@impl` tags (the mapping is
ambiguous); the new IDs are reported as `uncovered` until you assign them and
fill in their scaffolded spec lines. `check` will flag this until done. IDs
inside fenced code blocks are treated as examples and left untouched.

## `artgraph integrate`

Wire the scan / reconcile / check loop into a supported SDD tool. See
[docs/sdd-integration.md](./sdd-integration.md) for the full workflow.

```bash
artgraph integrate speckit                 # idempotent; before_implement gets a non-blocking check --diff preview
artgraph integrate speckit --gate          # upgrade before_implement to a blocking gate (check --gate)
artgraph integrate speckit --no-gate       # remove artgraph's before_implement hook
artgraph integrate speckit --uninstall     # remove the extension dir + every artgraph hook entry
artgraph integrate kiro                    # writes .kiro/steering/artgraph.md
artgraph integrate kiro --force            # overwrite a hand-edited steering file
artgraph integrate list                    # detected / installed status per tool
```

Note: the opt-in `--gate` wires `artgraph check --gate`, an absolute check
over every REQ — on a brand-new spec it always exits 2 before the first
implementation lands (expected; see issue #178 for the gating-policy work).

## `artgraph doctor`

Diagnose Tier 1 cross-agent distributions: byte-equality of every distributed
SKILL.md against `templates/skills/`, `AGENTS.md` marker block integrity, and
per-agent wrapper files still importing `@AGENTS.md`.

```bash
artgraph doctor                            # every detected agent, text output
artgraph doctor --agents=claude,codex      # restrict scope
artgraph doctor --format json              # machine-readable
```

`doctor` also runs one config-only diagnostic, scoped to projects where at
least one Tier 1 agent distribution is already detected (same gate as the
`agents`-field advisory findings): `config-pool-protection-asymmetry`
(issue #356, judgment updated by PR #359) — advisory (severity `pass`, never
affects the exit code) — fires when `.artgraph.json`'s `include` and
`testPatterns` disagree on whether they effectively exclude node_modules at
every nesting depth (checked via real glob matching against representative
synthetic paths, not a string heuristic), or when a pool's negative pattern
mentions node_modules but doesn't actually cover every depth (a "broken
exclusion", reported independent of the other pool's state). See
`docs/configuration.md`'s node_modules section for the full rationale,
including the synthetic-path matching approach, why pools with no positive
pattern are excluded from judgment, and why a config where both remaining
pools lack any node_modules-related pattern is not reported.

Exit code is `0` when every finding is `pass` (or no Tier 1 distribution
exists yet), non-zero when at least one finding is `fail` (drift / missing /
wrapper missing the import / extraneous file). Example text output:

```text
[claude] .claude/skills/      11 pass
[codex]  .agents/skills/      10 pass
AGENTS.md: ✓ marker block intact

Summary: 22 pass, 0 fail
```
