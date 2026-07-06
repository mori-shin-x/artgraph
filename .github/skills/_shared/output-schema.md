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
  "testFailures": ["REQ-003"],                         // REQs whose tests ran and failed (only when --test-results supplied)
  "pass": true,                                        // spec 017: true iff `newIssues` is empty (NO issue is new vs the baseline). The scoped arrays above may still be non-empty (all pre-existing debt).
  "newIssues": {                                       // spec 017 (FR-009): the `current \ baseline` subset that decides the gate. Same shapes as the scoped arrays.
    "drifted": [],
    "orphans": [],
    "uncovered": [],
    "testFailures": []
  },
  "suppressedCount": 155,                              // count of scoped issues suppressed as pre-existing (in blast radius but not newly introduced)
  "baselineStatus": "computed",                        // "computed" | "empty" (unborn HEAD → all current is new) | "skipped" (clean scope, no baseline built) | "unavailable" (could not establish a baseline → gate undetermined)
  "warnings": [                                        // BuildWarning[] from scan (always present, may be empty)
    {
      "type": "duplicate-id",                          // see "Warning types" table below
      "id": "REQ-001",
      "files": ["specs/foo.md", "specs/bar.md"],
      "message": "optional human-readable detail"     // optional
    }
  ]
}
```

An issue is **new** (introduced by this change) iff it appears in `newIssues`; anything only in the scoped arrays is pre-existing. When `baselineStatus` is `"unavailable"`, `newIssues` is empty and `pass` is forced `false` — read `baselineStatus`, not `pass` alone, to tell "gate fail" (`--gate` → exit 2) from "undetermined" (`--gate` → exit 1).

`warnings[].type` is one of: `"duplicate-id" | "ambiguous-id" | "orphan-doc" | "orphan-edge" | "invalid-relation" | "reserved-prefix" | "unresolved-link" | "out-of-scope-link" | "invalid-annotation-id" | "empty-annotation" | "self-reference-annotation"`.

## artgraph impact

```json
{
  "affectedFiles": ["src/foo.ts"],                     // source file paths transitively impacted
  "affectedDocs": ["doc:012-skills-expansion/spec.md"],// doc node IDs (prefixed "doc:")
  "affectedReqs": ["FR-001", "012-skills-expansion/FR-002"],
  "affectedTasks": ["012-skills-expansion/T001"],      // task node IDs (may be empty)
  "drifted": [                                         // same DriftEntry shape as check
    {
      "nodeId": "FR-001",
      "kind": "req",
      "lockedHash": "abc123…",
      "currentHash": "def456…"
    }
  ],
  "summary": {                                         // optional — present when impact() returns one
    "docs": 12,
    "reqs": 39,
    "files": 0,
    "tasks": 52
  }
}
```

## artgraph coverage

```json
{
  "items": [                                           // per-requirement coverage rows
    { "reqId": "FR-001", "status": "verified" }        // status: "verified" | "impl-only" | "untagged"
  ],
  "summary": {
    "total": 10,
    "verified": 7,
    "implOnly": 2,                                     // camelCase, not "impl-only"
    "untagged": 1
  }
}
```

## artgraph rename

The same shape is emitted for `--from/--to`, `--split/--into`, and `--merge/--into` (see `RenameResult` in `src/rename-executor.ts`). Which structural fields are populated depends on `operation`.

```json
{
  "operation": "rename",                               // "rename" | "split" | "merge"
  "from": "REQ-001",                                   // rename/split: source ID; absent on merge
  "to": "REQ-100",                                     // rename/merge: target ID; absent on split
  "sourceIds": ["REQ-001", "REQ-002"],                 // split: [splitId]; merge: all source IDs; absent on rename
  "intoIds": ["REQ-100", "REQ-101"],                   // split: new IDs; merge: [intoId]; absent on rename
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
| 1    | error (invalid input, I/O, validation); for `check --diff --gate`, also "baseline could not be established" (spec 017, gate undetermined) |
| 2    | `check --gate`: a NEW issue (drift / orphan / uncovered / test-failure) was introduced by the change. With `--diff`, pre-existing debt in the blast radius is excluded from the gate (spec 017 / issue #174) |
