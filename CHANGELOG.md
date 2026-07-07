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
- **Unicode-whitespace-only lines silently killed leading `@impl`
  attribution** (#190). `computeLineHasCode` treated U+3000 / U+00A0 / U+2028
  etc. as code, stopping the upward walk that binds a `// @impl` comment
  above a subsequent `export`. The tag then silently fell back to file
  attribution — common failure mode in JP locales after an IME mishap.
- **False-positive drift for barrel-symbol entries in both
  `plan-coverage` and `artgraph impact`** (#191). An entry pointing at a
  barrel symbol (`Files: src/index.ts:validateToken` where
  `src/index.ts` is `export { validateToken } from "./auth"`) reported
  `impactReqs \ originReqs` as a drift candidate because the barrel node
  carries no `implements` edge. `entryOriginIds` (now shared in
  `src/graph/traverse.ts`) walks `imports` transitively (BFS,
  symbol → symbol) so multi-hop barrel chains reach the origin's REQ
  authorship — applied to both commands so their origin attribution
  stays symmetric.
- **`import = require()` / `export import = require()` fail-open** (#187).
  `TSImportEqualsDeclaration` (both top-level and wrapped in
  `ExportNamedDeclaration`) produced no edges from `extractImports`;
  consumer BFS never reached the origin's REQ. Emits a file-grain import
  edge now. Per-symbol still deferred — `export =` origins bind no export
  name.

### Added

- **Observability warnings for the symbol-mode fail-safe path** (#189, partial).
  `phantom-import-repaired` fires when a `symbol:M#name` import target has
  no matching node but `file:M` exists and is degraded to file grain.
  `dangling-import` fires when even the file target is out of scan scope.
  Both surface in `scan --format json`'s `warnings[]`; the default stderr
  presenter suppresses them so repos with lots of `export *` re-exports do
  not get noisy. Parser-side `unresolved-reexport` still deferred to a
  follow-up (needs parser plumbing + `SCHEMA_VERSION` bump).

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
3. **Parse cache invalidated across the follow-up wave.**
   `SCHEMA_VERSION` bumped 1 → 2 in PR #180 and 2 → 3 in #187. The first
   scan after upgrade is cold; warm runs return to normal speed. Delete
   `node_modules/.cache/artgraph/parse-cache.json` if a partial upgrade
   left the cache in an odd state.

### Known limitations still open

- `export *` per-symbol precision — tracked in #179 (currently file-grain
  fail-safe).
- `export default <ImportedName>` / `import { x } from "./m"; export { x }`
  per-symbol precision — tracked in #188 (file-grain fail-safe reaches REQs;
  attribution loses symbol grain).
- Silent parser skips on unresolved re-exports (`export { x } from
  "./missing"`) — remaining sub-item of #189. `phantom-import-repaired` /
  `dangling-import` cover the builder side; the parser side still drops
  the re-export silently.
