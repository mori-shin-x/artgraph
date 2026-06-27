# artgraph JSON output schemas

Skills calling `artgraph <subcommand> --format json` can rely on the field shapes below. Field names and meanings are stable; new fields may be added but existing fields will not be renamed.

## artgraph impact

```json
{
  "affectedReqs": ["FR-001"],            // requirement IDs reachable from the change
  "affectedDocs": ["docs/spec.md"],      // doc files transitively impacted
  "affectedFiles": ["src/foo.ts"],       // source files transitively impacted
  "drifted": [                            // nodes whose hash differs from the lockfile
    { "id": "FR-001", "kind": "requirement" }
  ]
}
```

## artgraph check

```json
{
  "drift": [                              // nodes with mismatched hashes vs lockfile
    { "id": "FR-001", "kind": "requirement" }
  ],
  "orphans": [                            // tags pointing to unknown IDs
    { "tag": "FR-999", "file": "src/foo.ts", "line": 42 }
  ],
  "uncovered": ["FR-002"],                // requirement IDs with no impl/test tag
  "coverage": [                           // per-requirement coverage status
    { "reqId": "FR-001", "status": "verified" }
    // status: "verified" | "impl-only" | "untagged"
  ]
}
```

## artgraph coverage

```json
{
  "items": [                              // per-requirement coverage rows
    { "reqId": "FR-001", "status": "verified" }
    // status: "verified" | "impl-only" | "untagged"
  ],
  "summary": {
    "total": 10,
    "verified": 7,
    "implOnly": 2,
    "untagged": 1
  }
}
```

## artgraph rename

```json
{
  "changes": [                            // text edits applied to source/doc files
    { "file": "src/foo.ts", "line": 12, "before": "FR-001", "after": "FR-010" }
  ],
  "lockChanges": [                        // lockfile key rewrites
    { "key": "requirements.FR-001", "before": "FR-001", "after": "FR-010" }
  ]
}
```

On error, the payload is:

```json
{ "error": "human-readable message" }
```

## Exit codes

| code | meaning |
| ---- | ------- |
| 0    | success / clean |
| 1    | error |
| 2    | drift detected (only when `--gate` is set on `check`) |
