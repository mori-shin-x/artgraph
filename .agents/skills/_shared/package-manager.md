# Package manager detection

The `artgraph-setup` Skill uses the rules below to pick the right install / exec commands. Supported: npm, pnpm, Bun, Deno. **The default PM is pnpm**: the signal-less default and the Yarn fallback both resolve to pnpm. Only an explicit npm signal (`package-lock.json` / `packageManager: npm@x`) selects npm.

> **Sync contract (SC-007):** these rules are the prose form of `detectPackageManager()` in `src/package-manager.ts` (truth table: `specs/015-pkg-mgr-agnostic/contracts/package-manager.md` §1). The two MUST stay in sync at the rule level — same precedence, same outcomes, same warning/error semantics. This prose version exists because `artgraph-setup` runs during bootstrap, before artgraph itself is installed, so it cannot call the TS function.

## Detection rules

Inspect the project root and apply these rules in order — first match wins. Compose whatever file checks your shell needs; only **regular files** count (a directory or dangling symlink named like a lockfile is not a match).

1. If `package.json` exists, read its **top-level** `"packageManager"` field. It uses the Corepack-style `<pm>@<version>` shape (Corepack itself only ships npm/pnpm/yarn; artgraph extends the same shape to Bun). Parse the top-level field only — a nested `"packageManager"` key elsewhere in the JSON does not count — and ignore values without an `@version` suffix (a bare `"npm"` is malformed):
   - `npm` / `pnpm` / `bun` -> use that PM.
   - `yarn` -> use **pnpm** and warn: `packageManager=yarn but Yarn is not supported; falling back to pnpm`.
   - Field absent, malformed, unknown PM, or unparseable JSON -> continue to rule 2.
2. Lockfile / config sniffing — first match wins, in this order:
   - `bun.lockb` or `bun.lock` -> **bun**
   - `deno.lock`, `deno.json`, or `deno.jsonc`, and **no** `package.json` -> **deno**
   - `pnpm-lock.yaml` -> **pnpm**
   - `yarn.lock` -> **pnpm**, with warning: `yarn.lock found but Yarn is not supported; falling back to pnpm`
   - `package-lock.json` -> **npm**
3. `package.json` exists but nothing above matched -> default to **pnpm** (artgraph's default PM).
4. Nothing matched at all -> detection fails with error: `Cannot detect package manager; ask the user which to use`.

Warnings and the failure message go to the user (the TS detector writes them to stderr with `WARNING:` / `ERROR:` prefixes — keep the same wording when relaying).

## Command mapping

| PM | install dev dep (artgraph) | exec subcommand |
| --- | --- | --- |
| npm | `npm install -D artgraph` | `npx artgraph <cmd>` |
| pnpm | `pnpm add -D artgraph` | `pnpm exec artgraph <cmd>` |
| bun | `bun add -d artgraph` | `bunx artgraph <cmd>` |
| deno | `deno add npm:artgraph` | `deno run -A npm:artgraph/cli <cmd>` |

## Per-PM notes

- **npm**: assume npm >= 8 (bundled with Node 18+). `npx` resolves the local `node_modules/.bin/artgraph` first, so no global install is needed.
- **pnpm**: `pnpm exec` runs the locally installed binary; avoid `pnpm dlx` because it ignores the workspace lockfile and may pull a different artgraph version.
- **bun**: `bun add -d` writes `bun.lockb` (binary) or `bun.lock` (text — opt-in in Bun 1.1.39, default from Bun 1.2.0). `bunx` is the canonical exec wrapper; do not substitute `npx` because it bypasses Bun's resolver.
- **deno**: `deno add npm:artgraph` requires Deno >= 1.42 (when the `deno add` subcommand landed). The underlying `npm:` specifier itself is stable since Deno 1.28. Always pass `-A` on the `deno run` invocation — artgraph needs FS + env access to read the repo and write generated files, and shells out to `git` via `execFileSync` (see `src/diff.ts`). If the project pins permissions in `deno.json`, prefer scoped flags (`--allow-read --allow-write --allow-env --allow-run=git`) over `-A`.

## Failure handling

If detection fails (rule 4) or produced a warning, the Skill must pause and ask the user: "Which package manager would you like to use? (npm / pnpm / bun / deno)". Use the answer as the authoritative PM for the rest of the session and skip re-running detection. Record the chosen PM in the Skill's working memory so subsequent steps (install, exec) stay consistent.
