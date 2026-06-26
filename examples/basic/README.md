# examples/basic — Minimal artgraph sample

A two-requirement project showing every link artgraph cares about: one spec, one
implementation file with an `@impl` tag, and one test with a `[REQ-…]` tag.
`REQ-001` is fully covered; `REQ-002` is intentionally left **uncovered** so the
example also demonstrates what `artgraph check` reports.

## Layout

```
examples/basic/
├── .artgraph.json        # config (scoped to this dir)
├── specs/auth.md         # REQ-001 (covered) / REQ-002 (uncovered)
├── src/auth.ts           # `// @impl REQ-001`
└── tests/auth.test.ts    # `it("[REQ-001] …")`
```

## Try it

From the repo root (after `pnpm build`):

```bash
cd examples/basic
node ../../dist/cli.js scan
node ../../dist/cli.js check
```

…or after `npm install -D artgraph` in your own project, swap the `node ../../dist/cli.js`
calls for `npx artgraph`.

### Expected `scan` output

```
Nodes: 5  Edges: 5
  req: 2  doc: 1  file: 1  test: 1
```

### Expected `check` output

```
UNCOVERED:
  REQ-002
COVERAGE:
  REQ-001: verified
  REQ-002: untagged
```

## See drift detection

```bash
node ../../dist/cli.js reconcile         # snapshot the current state
# Edit specs/auth.md to change the REQ-001 wording, then:
node ../../dist/cli.js check
```

`check` now reports `DRIFT: REQ-001 (req)` because the spec changed but the
`@impl REQ-001` site in `src/auth.ts` was not touched. Add `--gate` to exit
non-zero so this is gated in CI / pre-commit:

```bash
node ../../dist/cli.js check --gate      # exits 2 on drift / uncovered
```
