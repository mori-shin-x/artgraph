# SDD tool integration

`artgraph integrate` wires the scan / reconcile / check loop into the SDD tool you
already use, so spec ↔ code drift is caught at the right workflow checkpoint
instead of relying on a manual call.

| Command                           | Purpose                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artgraph integrate speckit`      | Generate `.specify/extensions/artgraph/` and register Spec Kit hooks (`after_tasks` / `after_implement`, optional `before_implement` via `--gate`)                 |
| `artgraph integrate kiro`         | Write `.kiro/steering/artgraph.md` so the Kiro agent learns when to call `impact / check --diff / reconcile`                                                       |
| `artgraph integrate list`         | Show every supported integration with detect / installed status                                                                                                     |

`artgraph init` auto-integrates every detected SDD tool by default (Spec Kit gets the `before_implement` gate hook; pass `--no-integrate` to skip the stage). Use the standalone `artgraph integrate <tool>` command when you want to pick a specific tool or control the gate afterwards.

```bash
# Inside a repo that already has .specify/
artgraph integrate speckit              # idempotent
artgraph integrate speckit --gate       # also add before_implement gate
artgraph integrate speckit --no-gate    # remove only artgraph's before_implement hook
artgraph integrate speckit --uninstall  # remove the extension dir + every artgraph hook entry

# Kiro
artgraph integrate kiro                 # writes .kiro/steering/artgraph.md
artgraph integrate kiro --force         # overwrite a hand-edited steering file

# Discover what's available
artgraph integrate list                 # detected / installed flags per tool
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
  [specs/009-sdd-integration/spec.md](../specs/009-sdd-integration/spec.md);
  the end-to-end walkthrough (every scenario the E2E tests cover) is in
  [specs/009-sdd-integration/quickstart.md](../specs/009-sdd-integration/quickstart.md).

## Worked examples

- **Spec Kit** — [`examples/speckit-integration/`](../examples/speckit-integration):
  `after_tasks` / `after_implement` hooks and the opt-in `before_implement` gate.
- **Kiro** — [`examples/kiro-integration/`](../examples/kiro-integration):
  steering file that teaches the Kiro agent when to call `impact` / `check --diff` / `reconcile`.
