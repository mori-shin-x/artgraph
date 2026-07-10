// TODO(T006, spec 020 Phase A): implement the distributed Vitest custom
// runner (`artgraph/vitest`) — per-test precise coverage via `node:inspector`
// + TraceShard JSONL emission. See
// specs/020-coverage-derived-edges/contracts/trace-artifact.md for the wire
// contract and research.md D1/D2 for the `Profiler.takePreciseCoverage`
// approach.
//
// This file is a typed placeholder so `package.json#exports["./vitest"]`,
// the `vitest` peerDependency wiring, and `tsc`/`knip` stay green ahead of
// the runner implementation. It deliberately does not import from `vitest`
// yet — only `src/vitest/**` is allowed to (plan.md Structure Decision).
export {};
