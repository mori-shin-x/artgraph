# examples/speckit-integration — Spec Kit + artgraph

Shows how `artgraph integrate speckit` wires drift detection into the Spec Kit
workflow. Running the integration hooks artgraph into two Spec Kit checkpoints:

| Checkpoint         | Hook                | What it does                                  |
| ------------------ | ------------------- | --------------------------------------------- |
| `after_tasks`      | `scan && reconcile` | Snapshots the new baseline                    |
| `after_implement`  | `check --diff`      | Reports drift / orphans / uncovered           |
| `before_implement` | `check --gate`      | Blocks `/speckit-implement` on drift (opt-in) |

## Layout

```
examples/speckit-integration/
├── .artgraph.json
└── .specify/
    ├── extensions.yml        # starting state — empty installed list
    └── specs/001-auth/
        ├── spec.md           # FR-001 / FR-002
        └── tasks.md          # T001 / T002 with `@impl(FR-…)`
```

The auto-generated `.specify/extensions/spectrace/` directory is intentionally
**not** committed — running `artgraph integrate speckit` creates it.

## Try it

```bash
cd examples/speckit-integration
node ../../dist/cli.js integrate speckit
```

Expected output:

```
✓ Integrated: speckit (Spec Kit)

Created (5):
  .specify/extensions/spectrace/extension.yml
  .specify/extensions/spectrace/README.md
  .specify/extensions/spectrace/commands/artgraph.scan-reconcile.md
  .specify/extensions/spectrace/commands/artgraph.check-diff.md
  .specify/extensions/spectrace/commands/artgraph.check-gate.md

Modified (1):
  .specify/extensions.yml
```

`.specify/extensions.yml` now lists `spectrace` under `installed:` and registers
the `after_tasks` / `after_implement` hooks. The integration is **idempotent** —
running the command again reports `Already integrated … — no changes`.

## Add the gate

To block `/speckit-implement` when there is drift or uncovered work:

```bash
node ../../dist/cli.js integrate speckit --gate    # add before_implement gate
node ../../dist/cli.js integrate speckit --no-gate # remove it again
```

## Uninstall

```bash
node ../../dist/cli.js integrate speckit --uninstall
```

This removes `.specify/extensions/spectrace/` and every `spectrace` entry from
`.specify/extensions.yml`, leaving other extensions' hooks untouched.

## See also

- [`examples/basic/`](../basic) — the spec → `@impl` → `check` loop without Spec Kit.
- [Top-level README — SDD tool integration](../../README.md#sdd-tool-integration).
