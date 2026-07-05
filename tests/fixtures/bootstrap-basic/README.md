# Bootstrap-basic fixture — tag-stripped copy of examples/basic

This fixture is the "before" state for the bootstrap end-to-end flow tracked by
issue #123. It mirrors `examples/basic/` but with every traceability marker
removed:

- `specs/auth.md` has no `REQ-NNN:` prefixes on its bullets.
- `src/auth.ts` has no `// @impl REQ-…` annotation.
- `tests/auth.test.ts` has no `[REQ-…]` prefix on its `it()` name.
- No `.trace.lock` is committed — the fixture is pre-scan.

## Purpose

`tests/e2e/bootstrap.e2e.test.ts` copies this tree into a scratch dir, runs the
artgraph-bootstrap Skill's flow against it, and asserts the resulting state
matches `EXPECTED.md`.

## Warning

The fixture is intentionally in a state where `artgraph check` reports
`UNCOVERED` / untagged results. That is the whole point: the bootstrap flow is
what turns this "before" tree into the tagged "after" tree. Do not "fix" the
missing tags.
