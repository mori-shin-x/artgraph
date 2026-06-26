# Contributing to artgraph

Thanks for your interest in artgraph. This document covers the development setup, conventions, and review process for contributions.

## Prerequisites

- **Node.js** 22 or later (`engines.node` is set to `>=22`)
- **pnpm** 11.x — pinned via `packageManager` in `package.json`, so Corepack will install the matching version automatically

## Setup

```bash
git clone https://github.com/ShintaroMorimoto/artgraph.git
cd artgraph
pnpm install --frozen-lockfile
```

The repository name is `artgraph`, matching the npm package and the CLI binary.

## Common commands

| Command           | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `pnpm build`      | Type-check and compile to `dist/`               |
| `pnpm test`       | Run the vitest suite once                       |
| `pnpm test:watch` | Run vitest in watch mode                        |
| `pnpm knip`       | Detect unused exports / files / dependencies    |
| `pnpm artgraph …` | Invoke the locally built CLI (after `pnpm build`) |

Before opening a pull request, run `pnpm build && pnpm test && pnpm knip` locally — CI gates on the same three commands.

## Commit messages

We follow a Conventional-Commits-lite style:

```
<type>(<scope>): <summary>
```

Common types:

- `feat` — user-visible new functionality
- `fix` — bug fix
- `refactor` — internal change without behavior shift
- `docs` — documentation only
- `chore` — toolchain, dependencies, repo housekeeping
- `test` — tests only

`<scope>` is optional but encouraged. Scopes seen in the history include `artgraph`, `graph`, `deps`, `oss-ci`, `oss-publish`. When a commit closes an issue, append `(#NN)` to the summary or write `Closes #NN` in the body.

## Branch naming

Branches follow `<type>/<short-slug>`:

- `feat/<slug>`
- `fix/<slug>` (or `fix/issue-<number>`)
- `chore/<slug>`
- `docs/<slug>`

Keep slugs short, lowercase, and hyphen-separated (e.g. `docs/oss-standards`).

## Pull requests

1. Branch off `main` using the naming convention above.
2. Keep commits focused and follow the message style above.
3. Run `pnpm build && pnpm test && pnpm knip` locally.
4. Open a PR and fill in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md):
   - Summary and linked issue
   - Change-type checkbox
   - Testing notes
   - Breaking-change flag
5. Wait for CI (build / knip / test on Node 22) to pass.

Add new tests whenever you change behavior. Bug fixes should include a regression test.

## Adding specs and docs

artgraph is developed spec-first. Non-trivial features live under `specs/<NNN>-<slug>/`:

- Three-digit numeric prefix followed by a kebab-case slug (e.g. `010-req-req-dependency`).
- Inside, follow the Spec Kit layout (`spec.md` → `plan.md` → `tasks.md`, with optional `research.md`). The `speckit-*` skills shipped with the repository scaffold these for you.
- Cross-cutting design notes or reference material that doesn't belong to a single feature go directly under `docs/`.

## Reporting issues

- **Bugs** and **feature requests** — open a GitHub issue using the templates in `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities** — do not open a public issue; see [`SECURITY.md`](./SECURITY.md).
- **Code of Conduct concerns** — see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
