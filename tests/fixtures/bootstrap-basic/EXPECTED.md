# Expected "after" state — bootstrap-basic

Canonical target for the future `tests/e2e/bootstrap.e2e.test.ts`. After the
artgraph-bootstrap Skill's flow runs against this fixture, the tree should
match the state described below.

## Required outcomes

1. **Two REQs seeded** from `specs/auth.md`: `REQ-001` (sign-in with email and
   password) and `REQ-002` (rate-limited failed attempts). The bullets in
   `specs/auth.md` gain `REQ-001:` / `REQ-002:` prefixes.
2. **`src/auth.ts`** gains a `// @impl REQ-001` comment on the line above the
   `signIn` function.
3. **`tests/auth.test.ts`** gains a `[REQ-001]` prefix on the existing `it()`
   name, i.e. `it("[REQ-001] accepts non-empty credentials", …)`.
4. **`REQ-002` is intentionally left uncovered** even after bootstrap. There is
   no implementing file for rate-limiting, and the bootstrap flow MUST NOT
   synthesize a fake `@impl` for a REQ that has no real implementation site.
   This matches the behavior of `examples/basic`.

## Expected `artgraph check` result

Mirrors `examples/basic/README.md`:

```
UNCOVERED:
  REQ-002
COVERAGE:
  REQ-001: verified
  REQ-002: untagged
```

Exit code: **0**. Uncovered / untagged is a warning by default, not a failure.
Running `artgraph check --gate` would exit `2` — but the DoD for issue #123 is
that plain `artgraph check` exits cleanly, which is exit 0. (Confirmed against
`examples/basic/README.md`, which documents `--gate` as the flag that "exits 2
on drift / uncovered" — implying the non-`--gate` default does not.)
