# Contributing to artgraph

Thanks for your interest in artgraph. This document covers the development setup, conventions, and review process for contributions.

## Prerequisites

- **Node.js** 22 or later (`engines.node` is set to `>=22`)
- **pnpm** 11.x — pinned via `packageManager` in `package.json`, so Corepack will install the matching version automatically

## Setup

```bash
git clone https://github.com/mori-shin-x/artgraph.git
cd artgraph
pnpm install --frozen-lockfile
```

The repository name is `artgraph`, matching the npm package and the CLI binary.

`pnpm install` also installs [lefthook](https://github.com/evilmartians/lefthook) git hooks (`pre-commit`, `pre-push`) via the `prepare` script. See [Git hooks](#git-hooks) below.

### Non-pnpm package managers

If you install with Bun, Deno, or another manager that does not honor npm's `prepare` lifecycle, run `pnpm exec lefthook install` (or the equivalent) manually once after install.

## Common commands

| Command           | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `pnpm build`      | Type-check and compile to `dist/`               |
| `pnpm test`       | Run the vitest suite once                       |
| `pnpm test:watch` | Run vitest in watch mode                        |
| `pnpm knip`       | Detect unused exports / files / dependencies    |
| `pnpm artgraph …` | Invoke the locally built CLI (after `pnpm build`) |

Before opening a pull request, run `pnpm build && pnpm test && pnpm knip` locally — CI gates on the same three commands. The `pre-push` git hook runs `typecheck`, `knip`, `test:unit`, and `test:e2e` automatically; if you `git push` and everything passes, CI will almost certainly pass too.

## Git hooks

Enforced locally via [lefthook](https://github.com/evilmartians/lefthook). Installed automatically by `pnpm install` (`prepare` script). Config: [`lefthook.yml`](./lefthook.yml).

**`pre-commit`** — runs on staged `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.mjs` / `.cjs` files, in parallel:

- `oxfmt --write` on staged files. Formatted files are re-staged automatically (`stage_fixed: true`), so the commit reflects the formatted output.
- `oxlint` on staged files. Commit fails on any lint error.

**`pre-push`** — runs project-wide, serially, before push:

1. `pnpm typecheck` (`tsc --noEmit`)
2. `pnpm knip`
3. `pnpm test:unit`
4. `pnpm test:e2e`

Perf tests are excluded from `pre-push` — they are wall-clock sensitive and would produce flaky failures locally. CI still runs them (with `continue-on-error: true`) for signal.

**Bypassing hooks** — use `git commit --no-verify` or `git push --no-verify` sparingly (e.g. work-in-progress branches, emergency reverts). CI will still enforce all checks on the PR, so bypassing locally just defers the failure.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>
```

Common types (the ones surfaced in `CHANGELOG.md` are marked ★):

- ★ `feat` — user-visible new functionality
- ★ `fix` — bug fix
- ★ `perf` — performance improvement
- ★ `refactor` — internal change without behavior shift
- ★ `docs` — documentation only
- ★ `revert` — revert of a previous commit
- `chore` — toolchain, dependencies, repo housekeeping (hidden from CHANGELOG)
- `test` — tests only (hidden from CHANGELOG)
- `ci` / `build` — CI or build tooling only (hidden from CHANGELOG)
- `style` — formatting only (hidden from CHANGELOG)

`<scope>` is optional but encouraged. Scopes seen in the history include `artgraph`, `graph`, `deps`, `oss-ci`, `oss-publish`. When a commit closes an issue, append `(#NN)` to the summary or write `Closes #NN` in the body.

**Breaking changes** must be flagged either by appending `!` after the type/scope (`feat(cli)!: rename --serve to --preview`) or by a `BREAKING CHANGE:` footer in the body. This drives the semver major bump on release.

The type/scope prefix is machine-parsed by release-please to compute the next version and generate `CHANGELOG.md` — see [Releases](#releases) below.

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

## Releases

Releases are driven by [release-please](https://github.com/googleapis/release-please) on every push to `main`. As a contributor you don't touch `CHANGELOG.md`, `package.json` `version`, or tags directly — Conventional Commits do that for you.

The flow is:

1. **Merge Conventional Commits into `main`.** Every `feat` / `fix` / `perf` / `refactor` / `docs` / `revert` commit is a candidate line in the next release's changelog.
2. **release-please maintains a Release PR.** On each push to `main`, [`.github/workflows/release-please.yml`](./.github/workflows/release-please.yml) opens (or updates) a PR titled `chore(release): release X.Y.Z` that stages the next version bump in `package.json` and prepends a fresh section to `CHANGELOG.md`. `X.Y.Z` is computed from the accumulated commit types (feat → minor, fix → patch, `BREAKING CHANGE`/`!` → major).
3. **A maintainer reviews and merges the Release PR.** This is a normal PR — it is reviewed for changelog accuracy the same way any doc PR is. Merging pushes the version-bump commit and creates the `vX.Y.Z` git tag.
4. **A maintainer manually kicks the npm publish.** Go to Actions → `Publish to npm` → **Run workflow**, selecting the `vX.Y.Z` tag as the ref. This runs [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) with npm Trusted Publishing + provenance — no `NPM_TOKEN` secret is stored. The manual kick is intentional: it keeps the "actually publish to npm" step under human control even though everything upstream is automated.

Between releases the "Unreleased" section at the top of `CHANGELOG.md` is generated from unreleased commits by release-please; no need to edit it by hand.

## Reporting issues

- **Bugs** and **feature requests** — open a GitHub issue using the templates in `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities** — do not open a public issue; see [`SECURITY.md`](./SECURITY.md).
- **Code of Conduct concerns** — see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
