# Changelog

All notable changes to artgraph are documented here. The project is pre-release
(npm 未 publish) — versions below are commit-anchored, not tagged.

## Unreleased

### Added

- **Per-symbol precision for `export *` chains** (#179, specs/018 §5). Plain
  `export * from "./o"` — including multi-hop chains
  (`top → mid → leaf`), `export type * from`, `export * as ns from`
  (materialised as `symbol:B#ns` per §6 S2), and diamond DAGs (memoised
  expansion — polynomial in file × name × star out-degree) — now emits
  `symbol:B#x` synth nodes that point at the direct provider one hop
  upstream. Consumers' `import { x } from "./barrel"` reaches the origin
  symbol per-symbol, so sibling REQs stay out of the blast radius.
  `entryOriginIds` (`artgraph impact` / `plan-coverage`) walks the symbol
  chain, so a `Files: src/barrel.ts:x` entry reaches origin's `@impl` and
  drift comparisons stay symmetric. `resolveStartIds` no longer errors on
  a star-barrel `path:symbol` input.
- **Per-symbol precision for imported-identifier re-exports** (#188,
  specs/018 §6 S3). Source-null local re-exports —
  `import { x } from "./m"; export { x };`, `import X from "./m"; export
  default X;`, `import * as ns from "./m"; export { ns };`, and every
  aliased / namespace / default combination in the §4 table — are
  materialised in the parser (`extractImports`) with the same SSOT hash
  (`hash([resolvedTargetRel, originBinding, exportedName].join("\0"))`) as
  the #177 named re-export path. Consequence: `import { x } from "./m";
  export { x };` produces a lock byte-identical to `export { x } from
  "./m";` — freely-refactored barrels no longer churn `.trace.lock`.
- **Observability warnings for the symbol-mode fail-safe path** (#189, partial).
  `phantom-import-repaired` fires when a `symbol:M#name` import target has
  no matching node but `file:M` exists and is degraded to file grain.
  `dangling-import` fires when even the file target is out of scan scope.
  Both surface in `scan --format json`'s `warnings[]`; the default stderr
  presenter suppresses them so repos with lots of `export *` re-exports do
  not get noisy. Parser-side `unresolved-reexport` still deferred to a
  follow-up (needs parser plumbing + `SCHEMA_VERSION` bump).

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

  Both now resolve per-symbol; `export *` chains follow via specs/018 §5
  builder-side star expansion (see the Added section above).
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
   `SCHEMA_VERSION` bumped 1 → 2 in PR #180, 2 → 3 in #187, and 3 → 4 in
   specs/018 (parser now emits S2/S3 nodes and carries a `starExports`
   side-channel; the builder consumes both). The first scan after upgrade
   is cold; warm runs return to normal speed. Delete
   `node_modules/.cache/artgraph/parse-cache.json` if a partial upgrade
   left the cache in an odd state.
4. **First `reconcile` after upgrading to specs/018 adds new `symbol:`
   lock entries** on star-barrel and imported-identifier re-export files.
   The #177 named re-export hash bytes are UNCHANGED — §4 refactor
   equivalence is byte-level — so the lock diff is strictly additions.
   Combined with the `export * ⇔ export { x } from` refactor equivalence,
   users can freely rewrite barrels between star and enumerated forms
   without triggering lock churn on the surviving specifiers.

### Known limitations still open

- **Ambiguous `export *`** (specs/018 §7 D3): when two distinct star
  sources both supply the same name, the barrel's synth is dropped and
  consumer imports fall back to the file-grain `phantom-import-repaired`
  path — REQ reach preserved (no fail-open), per-symbol precision lost.
- **Diamond 束縛同一性の非比較** (specs/018 §7 D4): the ES spec would
  treat `A → {B, C} → D, D.x` as unambiguous when both branches ultimately
  resolve to the same origin binding. artgraph drops when two distinct
  direct providers exist regardless of ultimate identity; escalate the
  precision only if reports show it hurting real repos.
- **`export = require(...)` origin** (#187): file-grain lock entry only —
  `export =` binds no export name, so per-symbol precision is not
  possible without re-modelling.
- **Fatal syntax errors inside a star barrel**: file stays file-grain
  (specs/018 §10, same principle as #180 for other export shapes).
- **Star target outside the scan scope** (excluded by glob): file-grain
  edge dead-ends silently at the barrel; consumers' named imports degrade
  via `phantom-import-repaired`.
- **`// @impl REQ` directly above `export * from …`**: star statements
  have no symbolRange, so the tag stays file-attributed (specs/018 §10).
- **Parser-side silent skip on unresolved re-exports**
  (`export { x } from "./missing"`) — remaining sub-item of #189.
  `phantom-import-repaired` / `dangling-import` cover the builder side;
  the parser side still drops the re-export silently.
