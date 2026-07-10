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

## `artgraph impact`

Forward impact analysis: files/symbols → REQs / docs / tests.

```bash
artgraph impact src/auth.ts                # explicit file
artgraph impact src/auth.ts:validateToken  # symbol (requires "mode": "symbol")
artgraph impact --diff                     # everything in git diff
artgraph impact --diff --format json
```

`--diff` walks the deterministic TypeScript import graph even in a fresh repo
with no `@impl` tags or `.trace.lock`, so it works from day one. Requirement
IDs are rejected as inputs — see the [rename note](#rename-does-not-reassign-impl-tags)
if you need to trace the other direction.

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

## `artgraph reconcile`

Rebuild `.trace.lock` from the current graph. Run after intentional spec/code/
test edits when `artgraph check` reports drift you accept.

```bash
artgraph reconcile
```

`rename` runs this automatically after a non-preview rename.

## `artgraph rename`

Renames, splits or merges a requirement ID and rewrites **every** reference to it
(spec list items / headings, `@impl` tags, test tags, frontmatter
`depends_on` / `derives_from`, and `.trace.lock` keys) in one pass, limited to
git-tracked files.

```bash
artgraph rename --from REQ-001 --to REQ-100
artgraph rename --split REQ-001 --into REQ-101 REQ-102
artgraph rename --merge REQ-001 REQ-002 --into REQ-100
artgraph rename --from REQ-001 --to REQ-100 --dry-run
artgraph rename --from REQ-001 --to REQ-100 --format json
```

Notes:

- **Always commit first** — rename writes to tracked files in place. Use
  `--dry-run` to preview.
- **Target IDs are validated**: they must match the requirement-ID grammar
  (`REQ-001`, `auth/FR-2`, `Requirement-3`) or the `doc:` prefix, so the
  renamed ID is guaranteed to be re-discoverable by the next scan.
- After a non-preview run the lock is automatically reconciled, so
  `artgraph check` passes immediately for `rename` and `merge`.

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
