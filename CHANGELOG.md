# Changelog

All notable changes to artgraph are documented here. The project is pre-release
(npm 未 publish) — versions below are commit-anchored, not tagged.

## Unreleased

### Fixed

- **symbol-mode fail-open through named / barrel re-exports** (#177 / PR #180).
  Two independent defects caused symbol-mode `impact` / `check --gate` to miss
  REQs reached through named imports:
  - A `// @impl REQ` written on the line **above** `export …` — the idiomatic
    placement `bootstrap` emits — bound to the FILE, not the symbol, so a
    named-import edge targeting `symbol:x#name` dead-ended.
  - A barrel `export { x } from "./origin"` discarded the imported name and
    never materialized `symbol:barrel#x`, leaving the consumer's import edge
    pointing at a phantom node.

  Both now resolve per-symbol; `export *` is closed at file grain via a
  fail-safe repair (see #179 for per-symbol precision).

### Migration notes (existing symbol-mode projects)

If you were running `mode: "symbol"` before PR #180, the first run after
upgrade shows expected differences:

1. **Gate may fire for REQs that were previously fail-open.** Consumers that
   reach an origin's REQ through a named barrel now correctly trigger the
   gate. If a task's `Files:` block doesn't mention that REQ, `plan-coverage
   --gate` will flag it as implicit. This is the intended new signal.
2. **`.trace.lock` `impl` prefix changes `file:` → `symbol:` for barrel
   consumers.** The first `reconcile` after upgrade will show a diff even for
   files whose source text did not change — it reflects the new symbol-level
   attribution. Commit the diff once, then subsequent runs are stable.
3. **`SCHEMA_VERSION` 1 → 2 cold-invalidates the parse cache.** The first
   scan is cold (slower); warm runs return to normal speed. Delete
   `node_modules/.cache/artgraph/parse-cache.json` if a partial upgrade left
   the cache in an odd state.

### Known limitations still open

- `export *` per-symbol precision — tracked in #179 (currently file-grain
  fail-safe).
- `export default <ImportedName>` / `import { x } from "./m"; export { x }`
  per-symbol precision — tracked in #188 (file-grain fail-safe reaches REQs;
  attribution loses symbol grain).
- `import = require()` / `export =` (CJS-style TS) — file-grain edge added
  in #187; per-symbol not attempted.
- Silent skips in the parser (`unresolved-reexport`) — tracked in #189
  (partial: `phantom-import-repaired` / `dangling-import` builder warnings
  are exposed in `scan --format json`).
