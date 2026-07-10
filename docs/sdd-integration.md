# SDD tool integration

`artgraph integrate` wires the scan / reconcile / check loop into the SDD tool you
already use, so spec ↔ code drift is caught at the right workflow checkpoint
instead of relying on a manual call.

| Command                           | Purpose                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artgraph integrate speckit`      | Generate `.specify/extensions/artgraph/` and register Spec Kit hooks (`after_tasks` / `after_implement` / non-blocking `before_implement` preview; blocking gate opt-in via `--gate`) |
| `artgraph integrate kiro`         | Write `.kiro/steering/artgraph.md` so the Kiro agent learns when to call `impact / check --diff / reconcile`                                                       |
| `artgraph integrate list`         | Show every supported integration with detect / installed status                                                                                                     |

`artgraph init` auto-integrates every detected SDD tool by default (Spec Kit gets the **non-blocking** `before_implement` preview — `artgraph check --diff`, informational only; pass `--no-integrate` to skip the stage). Use the standalone `artgraph integrate <tool>` command when you want to pick a specific tool or control the gate afterwards.

```bash
# Inside a repo that already has .specify/
artgraph integrate speckit              # idempotent
artgraph integrate speckit --gate       # upgrade before_implement to a blocking gate (check --gate)
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
- `--gate` is _declarative_: `--gate` replaces artgraph's `before_implement`
  entry with the blocking `check --gate` variant, `--no-gate` removes the
  entry, and omitting the flag preserves whatever variant is already wired
  (it only adds the non-blocking `check --diff` preview when artgraph has no
  `before_implement` entry yet). Other extensions' hooks in `extensions.yml`
  are never touched.
- **`--gate` always fails on a brand-new spec** (issue #217): `check --gate`
  is an absolute check over every REQ, so right before the *first*
  `/speckit-implement` of a new spec every REQ is still uncovered and the
  gate exits 2. This is expected — proceed anyway, or stay on the default
  non-blocking preview. The gating policy for in-progress work (per-status
  gates, one-shot suppression, …) is tracked in
  [#178](https://github.com/mori-shin-x/artgraph/issues/178).
- The full design lives in
  [specs/009-sdd-integration/spec.md](../specs/009-sdd-integration/spec.md);
  the end-to-end walkthrough (every scenario the E2E tests cover) is in
  [specs/009-sdd-integration/quickstart.md](../specs/009-sdd-integration/quickstart.md).

## Worked examples

- **Spec Kit** — [`examples/speckit-integration/`](../examples/speckit-integration):
  `after_tasks` / `after_implement` hooks and the opt-in `before_implement` gate.
- **Kiro** — [`examples/kiro-integration/`](../examples/kiro-integration):
  steering file that teaches the Kiro agent when to call `impact` / `check --diff` / `reconcile`.
