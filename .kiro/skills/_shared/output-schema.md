# artgraph JSON output schemas

Skills calling `artgraph <subcommand> --format json` can rely on the field shapes below. Each example is derived directly from the CLI's emitted JSON (see `src/check.ts`, `src/coverage.ts`, `src/rename-executor.ts`, `src/rename-lock.ts`, `src/integrate/index.ts`, `src/types.ts`). Field names are stable; new fields may be added but existing fields will not be renamed.

## artgraph check

The CLI prints `JSON.stringify({ ...CheckResult, warnings })` (see `src/cli.ts`).

```json
{
  "drifted": [                                         // DriftEntry[] — nodes whose hash differs from the lockfile
    {
      "nodeId": "REQ-001",                             // graph node ID (NOT "id")
      "kind": "req",                                   // NodeKind: "req" | "doc" | "file" | "symbol" | "test" | "task"
      "lockedHash": "abc123…",
      "currentHash": "def456…"
    }
  ],
  "orphans": [                                         // string[] — preformatted "<source> -> <target> (<edgeKind>)" lines
    "file:src/foo.ts -> REQ-999 (implements)"
  ],
  "uncovered": ["REQ-002"],                            // requirement IDs with no impl/test edge
  "coverage": [                                        // per-requirement coverage rows
    { "reqId": "REQ-001", "status": "verified" }       // status: "verified" | "impl-only" | "untagged"
  ],
  "testFailures": ["REQ-003"],                         // REQs whose tests ran and failed (only when `testResultPaths` is configured)
  "pass": true,                                        // spec 017: true iff `newIssues` is empty (NO issue is new vs the baseline). DANGER: forced `false` when baselineStatus is "unavailable" — NEVER read `pass` alone, see the table below.
  "newIssues": {                                       // spec 017 (FR-009): the `current \ baseline` subset that decides the gate.
    "drifted": [                                       // ⚠ DriftEntry[] (object) — NOT string[]. The only asymmetric field here.
      { "nodeId": "REQ-100", "kind": "req", "lockedHash": "abc123…", "currentHash": "def456…" }
    ],
    "orphans": ["file:src/auth.ts -> REQ-999 (implements)"], // string[] — same "<source> -> <target> (<kind>)" format as top-level `orphans`
    "uncovered": ["REQ-002"],                          // string[] — REQ ids, same as top-level `uncovered`
    "testFailures": ["REQ-003"]                        // string[] — REQ ids, same as top-level `testFailures`
  },
  "suppressedCount": 155,                              // count of scoped issues suppressed as pre-existing (in blast radius but not newly introduced)
  "baselineStatus": "computed",                        // "computed" | "empty" | "skipped" | "not_applicable" | "unavailable" — see the table below before trusting `pass`
  "warnings": [                                        // BuildWarning[] from scan (always present, may be empty)
    {
      "type": "duplicate-id",                          // see "Warning types" table below
      "id": "REQ-001",
      "files": ["specs/foo.md", "specs/bar.md"],
      "message": "optional human-readable detail"     // optional
    }
  ],
  // ── spec 020: present ONLY when a trace was ingested; omitted entirely
  // (not `[]`) when no trace artifact is configured (FR-010 byte-identical) ──
  "unexercisedClaims": [                               // {reqId, node}[] — @impl claim, but that REQ's evidence never reaches it (FR-012)
    { "reqId": "REQ-001", "node": "symbol:src/legacy.ts#oldSignIn" }
  ],
  "suggestedImpls": [                                  // {reqId, node}[] — no @impl claim, exactly one REQ's evidence reaches it (FR-013)
    { "reqId": "REQ-002", "node": "symbol:src/auth.ts#resetPassword" }
  ],
  "staleEvidence": [                                   // {reqId, symbols}[] — traced symbols whose hash changed since capture (FR-015)
    { "reqId": "REQ-003", "symbols": ["symbol:src/billing.ts#charge"] }
  ],
  "staleGate": false,                                  // true only under trace.staleness:"gate" AND staleEvidence non-empty AND --gate
  "exercisableUncovered": ["REQ-004"],                 // string[] — uncovered REQs whose exclusive evidence would flip them to `exercised` if trace.acceptExercises were on; display-only, always [] once the flag is on (issue #284)
  // ── issue #244: present ONLY when at least one lock key has no matching
  // graph node; omitted entirely (not `[]`) otherwise ──
  "staleLockEntries": ["symbol:src/old.ts#oldFn"]      // string[], sorted — lock keys with no node in the CURRENT graph (rename/refactor, or a mode/include/exclude/ignoreIdPrefixes config change — not rename-only). Unrelated to staleEvidence/staleGate above (those track trace-evidence freshness; this tracks lock-key existence in the graph). Display-only, never affects pass/newIssues/gate. Resolve with `artgraph reconcile`.
}
```

**`newIssues` is not a uniform shape.** `newIssues.drifted` is `DriftEntry[]` (an array of `{nodeId, kind, lockedHash, currentHash}` objects) — exactly like top-level `drifted`. `newIssues.orphans` / `newIssues.uncovered` / `newIssues.testFailures` stay `string[]`, exactly like their top-level counterparts. Code that does `newIssues.drifted.forEach(d => d.startsWith("REQ-"))` will throw at runtime — `d` is an object; use `d.nodeId`.

**Never read `pass` in isolation — always check `baselineStatus` first.** An issue is **new** (introduced by this change) iff it appears in `newIssues`; anything only in the scoped arrays is pre-existing. But whether that "new" determination is even meaningful depends entirely on `baselineStatus`:

| `baselineStatus` | when it occurs | `newIssues` contents | `pass` / gate meaning |
| --- | --- | --- | --- |
| `"computed"` | `--diff`, scope had issues, base ref resolved and scanned. With `--base <ref>` (spec 023, CI) the baseline is the `git merge-base <ref> HEAD` commit, and the diff set is working-tree ∪ committed `mergeBase..HEAD` range | real `current \ baseline` diff | spec-017 gate semantics (new issues only) |
| `"empty"` | `--diff`, unborn HEAD (repo's first commit, FR-014) | == scoped arrays (baseline is trivially empty, so everything counts as new) | spec-017 semantics; often `pass:false` on a non-trivial repo |
| `"skipped"` | `--diff`, but the scoped issue count was already zero (lazy eval, SC-005) — no baseline worktree was ever built. Also the "No changes detected" short-circuit, including an empty *merged* diff under `--base` (a legitimately clean run — no CI warning, spec 023 FR-010) | all empty (trivially, since scoped was already empty) | trivially `pass:true` |
| `"not_applicable"` | **no `--diff` at all** — a plain `check` / `check --gate` run. The current-vs-baseline distinction doesn't apply because there's no diff to compare against. | == scoped arrays verbatim (NOT a real "new" determination) | matches the pre-spec-017 "all scoped issues clear" meaning (back-compat, R8) |
| `"unavailable"` | `--diff`, baseline construction failed (non-git repo, `git worktree add` failure, `scan()` exception, mkdtemp error, …). With `--base <ref>` (spec 023) also: the ref does not resolve, or `git merge-base` fails — a shallow clone (`fetch-depth: 1`) is the classic CI cause; `baselineError` then carries a `fetch-depth: 0` remedy hint | forced empty — **means "undetermined"**, not "no issues" | `pass` forced `false` (safe default, never silently passes); see `baselineError` below |

**Do not confuse `"skipped"` with `"not_applicable"`.** Both can leave `newIssues` looking "uninteresting", but for different reasons: `"skipped"` only ever occurs when the scoped issue count is *already* zero (so an empty `newIssues` is trivially correct). `"not_applicable"` can carry a full, non-empty `newIssues` on a dirty repo — it means "this run never attempted a baseline diff", not "nothing is wrong".

`baselineError` (optional `string`): only present, and always non-empty, when `baselineStatus === "unavailable"`. It carries the underlying failure's message (a git command failure, a `scan()` exception, a temp-dir creation error, …) so a Skill/CI consumer can report *why* the gate is undetermined instead of a generic "baseline unavailable":

```json
{
  "baselineStatus": "unavailable",
  "baselineError": "git rev-parse --verify HEAD^{commit}: fatal: not a git repository",
  "newIssues": { "drifted": [], "orphans": [], "uncovered": [], "testFailures": [] },
  "pass": false
}
```
(other fields such as `drifted` / `orphans` / `coverage` are still populated with the full scoped listing — omitted above for brevity. `baselineError` is absent/undefined for every `baselineStatus` other than `"unavailable"`.)

`warnings[].type` is one of: `"duplicate-id" | "ambiguous-id" | "orphan-doc" | "orphan-edge" | "invalid-relation" | "reserved-prefix" | "unresolved-link" | "out-of-scope-link" | "invalid-annotation-id" | "empty-annotation" | "self-reference-annotation" | "phantom-import-repaired" | "dangling-import" | "class-member-collision" | "pathological-bracket-nesting" | "unreadable-file" | "system-resource-exhausted" | "node-modules-in-scan" | "unresolved-reexport" | "unresolved-import"`. This list may grow in future releases — a consumer should ignore any `type` value it does not recognize rather than treat it as an error.

`unresolved-reexport` / `unresolved-import` are per-edge, not per-specifier: an `import { x } from "./missing"; export { x };` statement pair on the same specifier fails both the import edge and the re-export edge, so it produces two separate warnings (one of each type) rather than one.

## artgraph impact

```json
{
  "affectedFiles": ["src/foo.ts"],                     // source file paths transitively impacted
  "affectedDocs": ["doc:012-skills-expansion/spec.md"],// parent spec doc(s) of reached REQs/tasks — attribution context, not BFS reach (spec 019)
  "impactReqs": ["FR-001", "012-skills-expansion/FR-002"], // REQ ids reached by the forward BFS
  "originReqs": ["FR-001"],                            // REQ ids the start ids @impl-claim directly (1-hop reverse implements)
  "affectedTasks": ["012-skills-expansion/T001"],      // task node IDs (may be empty)
  "drifted": [                                         // same DriftEntry shape as check; attributed affectedDocs entries participate too
    {
      "nodeId": "FR-001",
      "kind": "req",
      "lockedHash": "abc123…",
      "currentHash": "def456…"
    }
  ],
  "summary": {                                         // always present
    "docs": 12,
    "reqs": 39,
    "files": 0,
    "tasks": 52
  },
  // ── spec 020: present ONLY when a trace was ingested (FR-010 byte-identical
  // when no trace is configured — these keys are omitted entirely, not `[]`) ──
  "reqProvenance": [                                   // {reqId, provenance}[] — how each impactReqs entry was reached
    { "reqId": "FR-001", "provenance": ["static"] },    // @impl declaration and/or a structural edge (imports/contains)
    { "reqId": "FR-002", "provenance": ["evidence"] }   // a coverage-derived exercises edge only (a REQ's tests were observed running the code)
  ],
  "testsToRun": [                                       // {testFile, testName, reqId}[] — `--tests` only (FR-018)
    { "testFile": "tests/billing.test.ts", "testName": "[REQ-003] charge bills a positive amount", "reqId": "REQ-003" }
  ]
}
```

Array order is not part of the contract — treat every array as an unordered set. Same-spec sibling REQs with no code or dependency link of their own never appear in `impactReqs` (spec 019); when you need whole-feature context, open the spec file listed in `affectedDocs` instead.

With `--diff --base <ref>` (spec 024, CI test selection) the shape above is unchanged — no field is added. `testsToRun` (and every other array) is evaluated over the **merged** changed-file set: the working-tree union ∪ the committed `git merge-base <ref> HEAD`..HEAD range — the same set `check --diff --base <ref>` judges. Start ids still resolve against the *current* graph only, so a file deleted inside the commit range (or a graph-untracked change) contributes nothing, silently; a file *renamed* inside the range resolves under its new path but no longer joins trace evidence recorded under the old path, so its tests silently drop from the selection — treat `impact --tests` as an optimization and fall back to the full suite on exit `1`; the correctness gate remains `check --diff --base --gate`. A `--base` environment failure (unresolvable ref / no merge-base) exits `1` with **no JSON on stdout** — never parse an exit-1 run's output. Caution (spec 024 D-9): under `trace.staleness: "exclude"`, `--base --tests` in CI drops the changed code's stale-by-construction evidence — the tests the selection exists to find — and a stderr WARNING fires on that 3-way combination; use `staleness: "warn"` for CI selection.

## artgraph rename

The same shape is emitted for `--from/--to`, `--split/--into`, and `--merge/--into` (see `RenameResult` in `src/rename-executor.ts`). Which structural fields are populated depends on `operation`.

```json
{
  "operation": "rename",                               // "rename" | "split" | "merge"
  "from": "REQ-001",                                   // rename/split: source ID; absent on merge
  "to": "REQ-100",                                     // rename/merge: target ID; absent on split
  "sourceIds": ["REQ-001", "REQ-002"],                 // split: [splitId]; merge: all source IDs; absent on rename
  "intoIds": ["REQ-100", "REQ-101"],                   // split: new IDs; merge: [intoId]; absent on rename
  "filesScanned": 42,                                  // files enumerated from .artgraph.json include/specDirs/testPatterns and scanned for references
  "changes": [                                         // RewriteChange[] — text edits to source/doc files
    {
      "filePath": "src/foo.ts",                        // relative path (NOT "file")
      "line": 12,                                      // 1-based line number
      "kind": "impl-tag",                              // ReferenceKind: "spec-list-item" | "spec-heading" | "impl-tag" | "test-tag" | "frontmatter-depends-on" | "annotation-target" | "lock-key"
      "before": "// @impl REQ-001",
      "after":  "// @impl REQ-100"
    }
  ],
  "lockChanges": [                                     // LockChange[] — entries added/removed/renamed in the lock
    { "kind": "rename", "oldKey": "REQ-001", "newKey": "REQ-100" },
    { "kind": "delete", "oldKey": "REQ-001" },        // only oldKey present
    { "kind": "create", "newKey": "REQ-100" }         // only newKey present
  ],
  "warnings": [                                        // RenameWarning[] — manual follow-ups required
    {
      "type": "manual-assignment-needed",
      "filePath": "src/foo.ts",
      "oldId": "REQ-001",
      "newIds": ["REQ-100", "REQ-101"]
    }
  ],
  "applied": false                                     // true iff files were actually written (false on --dry-run)
}
```

On error, the CLI writes the following to stderr (NOT stdout) and exits 1:

```json
{ "error": "human-readable message" }
```

## artgraph integrate list

```json
{
  "providers": [
    {
      "id": "speckit",                                 // IntegrationProviderId ("speckit" | "kiro")
      "displayName": "Spec Kit",
      "marker": ".specify",                            // filesystem marker the provider looks for
      "detected": true,                                // marker exists in repo
      "installed": false                               // artgraph integration already applied
    }
  ]
}
```

## Exit codes

| code | meaning |
| ---- | ------- |
| 0    | success / clean (or `--gate` with no NEW issue) |
| 1    | error (invalid input, I/O, validation); for `check --diff --gate`, also "baseline could not be established" (spec 017, gate undetermined). `check --base <ref>` without `--diff` is a usage error → exit 1, no JSON emitted (spec 023 FR-002). `impact --base <ref>` fails the same way — without `--diff` (usage) or on an unresolvable ref / merge-base (environment): exit 1, no JSON; a CI consumer falls back to the full suite (spec 024). `check --gate` also exits 1 when the scan itself hit file-descriptor exhaustion (`system-resource-exhausted` in `warnings[]`, graph possibly incomplete) — this is INDEPENDENT of `--diff`/`--base` (issue #335, PR #339 F3); it can fire together with a baseline-unavailable condition, in which case both diagnostics print but the exit code is still 1 |
| 2    | `check --gate`: a NEW issue (drift / orphan / uncovered / test-failure) was introduced by the change. With `--diff`, pre-existing debt in the blast radius is excluded from the gate (spec 017 / issue #174). Note: with `--base <ref>` the wider commit-range scope can newly pull stale trace evidence into `trace.staleness:"gate"`'s independent exit-2 channel — semantically correct, the REQ really is in the change range (spec 023) |
