# Package manager detection

The `artgraph-setup` Skill uses the rules below to pick the right install / exec commands. Supported: npm, pnpm, Bun, Deno. **The default PM is pnpm**: the signal-less default and the Yarn fallback both resolve to pnpm. Only an explicit npm signal (`package-lock.json` / `packageManager: npm@x`) selects npm.

## Detection order

1. If `package.json` exists and contains a top-level `"packageManager"` field, parse it (`npm@x.y.z` / `pnpm@x.y.z` / `bun@x.y.z` → that PM; `yarn@x.y.z` → **fallback to pnpm, warn**). Corepack-style `<pm>@<version>` format (Corepack itself only ships npm/pnpm/yarn, but artgraph extends the same shape to Bun).
2. Lockfile sniffing — first match wins, in this order:
   - `bun.lockb` or `bun.lock` → `bun`
   - `deno.lock` or `deno.json(c)` (without `package.json`) → `deno`
   - `pnpm-lock.yaml` → `pnpm`
   - `yarn.lock` → **fallback to pnpm, warn user** ("Yarn is not supported")
   - `package-lock.json` → `npm`
3. If none of the above match but `package.json` exists → default to `pnpm`.
4. Otherwise → error: "Cannot detect package manager; ask the user which to use".

## Command mapping

| PM | install dev dep (artgraph) | exec subcommand |
| --- | --- | --- |
| npm | `npm install -D artgraph` | `npx artgraph <cmd>` |
| pnpm | `pnpm add -D artgraph` | `pnpm exec artgraph <cmd>` |
| bun | `bun add -d artgraph` | `bunx artgraph <cmd>` |
| deno | `deno add npm:artgraph` | `deno run -A npm:artgraph/cli <cmd>` |

## Bash detection snippet

```bash
detect_package_manager() {
  local pm_field
  # 1. Corepack-style "<pm>@<version>" field in package.json. Corepack itself
  #    only ships npm/pnpm/yarn; artgraph extends the same shape to Bun.
  #    Parse the TOP-LEVEL field only (via node, which is present in any artgraph
  #    project) so this matches the TS detector exactly — a plain `grep` would
  #    also match a nested "packageManager" key and diverge (SC-007).
  if [ -f package.json ]; then
    pm_field=$(node -e 'try{const p=require("./package.json").packageManager;if(typeof p==="string"){const m=p.match(/^([a-z]+)@/);process.stdout.write(m?m[1]:"")}}catch{}' 2>/dev/null)
    case "$pm_field" in
      npm|pnpm|bun) echo "$pm_field"; return 0 ;;
      yarn)
        echo "WARNING: packageManager=yarn but Yarn is not supported; falling back to pnpm" >&2
        echo "pnpm"; return 0 ;;
    esac
  fi

  # 2. Lockfile sniffing (first match wins)
  if [ -f bun.lockb ] || [ -f bun.lock ]; then echo "bun"; return 0; fi
  if [ ! -f package.json ] && { [ -f deno.lock ] || [ -f deno.json ] || [ -f deno.jsonc ]; }; then
    echo "deno"; return 0
  fi
  if [ -f pnpm-lock.yaml ]; then echo "pnpm"; return 0; fi
  if [ -f yarn.lock ]; then
    echo "WARNING: yarn.lock found but Yarn is not supported; falling back to pnpm" >&2
    echo "pnpm"; return 0
  fi
  if [ -f package-lock.json ]; then echo "npm"; return 0; fi

  # 3. Fallback: package.json present but no other signal → pnpm (default PM)
  if [ -f package.json ]; then echo "pnpm"; return 0; fi

  # 4. Give up
  echo "ERROR: Cannot detect package manager; ask the user which to use" >&2
  return 1
}
```

## Per-PM notes

- **npm**: assume npm >= 8 (bundled with Node 18+). `npx` resolves the local `node_modules/.bin/artgraph` first, so no global install is needed.
- **pnpm**: `pnpm exec` runs the locally installed binary; avoid `pnpm dlx` because it ignores the workspace lockfile and may pull a different artgraph version.
- **bun**: `bun add -d` writes `bun.lockb` (binary) or `bun.lock` (text — opt-in in Bun 1.1.39, default from Bun 1.2.0). `bunx` is the canonical exec wrapper; do not substitute `npx` because it bypasses Bun's resolver.
- **deno**: `deno add npm:artgraph` requires Deno >= 1.42 (when the `deno add` subcommand landed). The underlying `npm:` specifier itself is stable since Deno 1.28. Always pass `-A` on the `deno run` invocation — artgraph needs FS + env access to read the repo and write generated files, and shells out to `git` via `execFileSync` (see `src/diff.ts`). If the project pins permissions in `deno.json`, prefer scoped flags (`--allow-read --allow-write --allow-env --allow-run=git`) over `-A`.

## Failure handling

If `detect_package_manager` exits non-zero or emits a `WARNING` / `ERROR` line to stderr, the Skill must pause and ask the user: "Which package manager would you like to use? (npm / pnpm / bun / deno)". Use the answer as the authoritative PM for the rest of the session and skip re-running detection. Record the chosen PM in the Skill's working memory so subsequent steps (install, exec) stay consistent.
