// TODO(T007, spec 020 Phase A): implement `withTrace()` (config wrapper that
// wires `test.runner: 'artgraph/vitest'`) + a `globalSetup` that deletes
// stale `.artgraph/trace/*.jsonl` shards before each run (world-crossing
// prevention — see contracts/cli-surface.md §1).
//
// This file is a typed placeholder so `package.json#exports["./vitest/config"]`
// is wired ahead of the setup implementation. It deliberately does not
// import from `vitest` yet — only `src/vitest/**` is allowed to
// (plan.md Structure Decision).
export {};
