# Command reference

Full CLI reference. For the summary table and the agent-native workflow, see
the top-level [README](../README.md). Run `artgraph --help` for the
authoritative flag list.

## `artgraph init`

Full agent-native setup in one command: `.artgraph.json` config + initial scan
+ cross-agent Skills distribution + Stop hook + `AGENTS.md` snippet +
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

`--serve` and `--output` are mutually exclusive. Both read `.trace.lock` when
present to color drift/orphan/uncovered nodes; a missing lock just renders
without that extra state.

`--output` only ever writes `index.html`, `app.js`, and `vendor/cytoscape.min.js`
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
```

### Evidence-aware findings (spec 020)

When trace shards exist under `.artgraph/trace/`, `check` gains three
additional findings — the same "declared vs. exercised" cross-check as
[`artgraph trace report`](#artgraph-trace), plus a freshness check. On a
trace-absent project none of this appears; output is byte-identical to
before the feature shipped.

| Finding | Text heading | `--format json` field | Meaning |
| --- | --- | --- | --- |
| Unexercised claim | `UNEXERCISED CLAIM:` | `unexercisedClaims` | `@impl REQ-001` exists but REQ-001's tagged green tests never execute that symbol |
| Suggested impl | `SUGGESTED IMPL:` | `suggestedImpls` | No `@impl`, but the symbol is exercised exclusively by one REQ's tests |
| Stale evidence | `STALE EVIDENCE:` | `staleEvidence` | The symbol's content hash changed since its trace evidence was captured (`{ reqId, symbols[], tracedAt }`) |

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
`uncovered` — the moment `acceptExercises` is turned on. The eligible nodes
usually coincide with the ones `suggestedImpls` names, but the two can
diverge: `suggestedImpls` skips a node already claimed by another REQ's
`@impl` (it exists to reduce report noise), while the `exercised`
counterfactual behind `exercisableUncovered` does not — a REQ can be
`exercisableUncovered` even when its exclusive evidence node is claimed by a
different REQ. It is purely informational: it never affects `pass`,
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

### `impact --diff --tests` — test selection from evidence (spec 020) <a id="impact---diff---tests--test-selection-from-evidence-spec-020"></a>

`--tests` (only valid alongside `--diff`) lists exactly the `[REQ-NNN]`-tagged
tests whose test-execution evidence reaches the changed nodes, instead of the
full suite — test-impact-analysis as a byproduct of the `exercises` edges
described in [`artgraph trace`](#artgraph-trace) below.

```bash
artgraph impact --diff --tests --format json
```

```json
{ "testsToRun": [{ "testFile": "tests/billing.test.ts", "testName": "[REQ-003] charge bills a positive amount", "reqId": "REQ-003" }] }
```

When the graph has any `exercises` edges at all, `impact`'s regular JSON
output gains a `reqProvenance` array — `{ reqId, provenance: ("static" |
"evidence")[] }` per reached REQ — so a consumer can tell whether a REQ was
reached via a static path (`@impl` / `imports`) or via `exercises` evidence
(or both).

**Exit codes**: normal impact exit codes apply, plus — trace-absent and
`--tests` is passed → exit `1` with the same runner-setup guidance as
`artgraph trace report` (below).

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
  "diagnostics": { "dangling": 0, "corrupted": 0, "unknownSchema": 0, "skipped": 1, "stale": 2 },
  "staleRate": 0.15
}
```

### `artgraph trace report`

The "declared vs. exercised" audit. Classifies every `(req, symbol)` pair
touched by either an `@impl` claim or exercises evidence into four buckets:

```json
{
  "corroborated":      [{ "reqId": "REQ-001", "node": "symbol:src/auth.ts#signIn" }],
  "unexercisedClaims": [{ "reqId": "REQ-001", "node": "symbol:src/legacy.ts#oldSignIn" }],
  "suggestedImpls":    [{ "reqId": "REQ-002", "node": "symbol:src/auth.ts#resetPassword" }],
  "infrastructure":    [{ "node": "symbol:src/util.ts#validateEmail", "reqCount": 3 }],
  "diagnostics":       { "dangling": 0, "corrupted": 0, "unknownSchema": 0, "skipped": 1, "stale": 0 }
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

## `artgraph reconcile` <a id="artgraph-reconcile"></a>

Rebuild `.trace.lock` from the current graph. Run after intentional spec/code/
test edits when `artgraph check` reports drift you accept.

```bash
artgraph reconcile
```

`rename` runs this automatically after a non-preview rename.

**Lock schema version**: `.trace.lock` carries a `_meta.schemaVersion` stamp.
If the on-disk lock was written by a *newer* artgraph than the one running
`reconcile` (or `rename`, or `init`'s initial scan), the write is refused with
a clear error — rebuilding it here would silently discard information the
newer CLI understood. `--force` overwrites it anyway (a "Downgrading lock
schema vN -> vM" notice is printed, and newer entries may be lost). If this
happens because **CI is pinned to an older artgraph version**, update CI's
artgraph instead of reaching for `--force` there — `--force` on every CI run
just repeatedly discards whatever the newer local CLI wrote.

## `artgraph rename`

Renames, splits or merges a requirement ID and rewrites **every** reference to it
(spec list items / headings, `@impl` tags, test tags, frontmatter
`depends_on` / `derives_from`, and `.trace.lock` keys) in one pass, limited to
the files `.artgraph.json` puts in scan scope (`specDirs` markdown plus
`include` / `testPatterns` code and tests). Git tracking state is irrelevant:
uncommitted and untracked files are rewritten too.

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

Exit code is `0` when every finding is `pass` (or no Tier 1 distribution
exists yet), non-zero when at least one finding is `fail` (drift / missing /
wrapper missing the import / extraneous file). Example text output:

```text
[claude] .claude/skills/      11 pass
[codex]  .agents/skills/      10 pass
AGENTS.md: ✓ marker block intact

Summary: 22 pass, 0 fail
```
