# Package manager detection

The `artgraph-setup` Skill uses the rules below to pick the right install / exec commands. Supported: npm, pnpm, Bun, Deno. Yarn falls back to npm with a warning.

## Detection order

1. If `package.json` exists and contains a top-level `"packageManager"` field, parse it (`npm@x.y.z` / `pnpm@x.y.z` / `yarn@x.y.z` — yarn triggers fallback). Return that PM. (Corepack convention.)
2. Lockfile sniffing — first match wins, in this order:
   - `bun.lockb` or `bun.lock` → `bun`
   - `deno.lock` or `deno.json(c)` (without `package.json`) → `deno`
   - `pnpm-lock.yaml` → `pnpm`
   - `yarn.lock` → **fallback to npm, warn user** ("Yarn is not in the supported PM matrix yet")
   - `package-lock.json` → `npm`
3. If none of the above match but `package.json` exists → default to `npm`.
4. If `package.json` does not exist and `deno.json(c)` exists → `deno`.
5. Otherwise → error: "Cannot detect package manager; ask the user which to use".

## Command mapping

| PM | install dev dep (artgraph) | exec subcommand |
| --- | --- | --- |
| npm | `npm install -D artgraph` | `npx artgraph <cmd>` |
| pnpm | `pnpm add -D artgraph` | `pnpm exec artgraph <cmd>` |
| bun | `bun install -D artgraph` | `bunx artgraph <cmd>` |
| deno | `deno add npm:artgraph` | `deno run -A npm:artgraph/cli <cmd>` |

## Bash detection snippet

```bash
detect_package_manager() {
  # 1. Corepack-style "packageManager" field in package.json
  if [ -f package.json ]; then
    pm_field=$(grep -oE '"packageManager"[[:space:]]*:[[:space:]]*"[^"]+"' package.json \
      | sed -E 's/.*"([a-z]+)@.*/\1/')
    case "$pm_field" in
      npm|pnpm|bun) echo "$pm_field"; return 0 ;;
      yarn)
        echo "WARNING: packageManager=yarn but Yarn is not in the supported PM matrix yet; falling back to npm" >&2
        echo "npm"; return 0 ;;
    esac
  fi

  # 2. Lockfile sniffing (first match wins)
  if [ -f bun.lockb ] || [ -f bun.lock ]; then echo "bun"; return 0; fi
  if [ ! -f package.json ] && { [ -f deno.lock ] || [ -f deno.json ] || [ -f deno.jsonc ]; }; then
    echo "deno"; return 0
  fi
  if [ -f deno.lock ]; then echo "deno"; return 0; fi
  if [ -f pnpm-lock.yaml ]; then echo "pnpm"; return 0; fi
  if [ -f yarn.lock ]; then
    echo "WARNING: yarn.lock found but Yarn is not in the supported PM matrix yet; falling back to npm" >&2
    echo "npm"; return 0
  fi
  if [ -f package-lock.json ]; then echo "npm"; return 0; fi

  # 3-4. Fallbacks
  if [ -f package.json ]; then echo "npm"; return 0; fi
  if [ -f deno.json ] || [ -f deno.jsonc ]; then echo "deno"; return 0; fi

  # 5. Give up
  echo "ERROR: Cannot detect package manager; ask the user which to use" >&2
  return 1
}
```

## Per-PM notes

- **npm**: assume npm >= 8 (bundled with Node 18+). `npx` resolves the local `node_modules/.bin/artgraph` first, so no global install is needed.
- **pnpm**: `pnpm exec` runs the locally installed binary; avoid `pnpm dlx` because it ignores the workspace lockfile and may pull a different artgraph version.
- **bun**: `bun install -D` writes `bun.lockb` (binary) or `bun.lock` (text, Bun >= 1.1.30). `bunx` is the canonical exec wrapper; do not substitute `npx` because it bypasses Bun's resolver.
- **deno**: `deno add npm:artgraph` requires Deno >= 1.45 (npm specifier support). Always pass `-A` on the `deno run` invocation — artgraph needs FS + env access to read the repo and write generated files. If the project pins permissions in `deno.json`, prefer scoped flags (`--allow-read --allow-write --allow-env`) over `-A`.

## Failure handling

If `detect_package_manager` exits non-zero or emits a `WARNING` / `ERROR` line to stderr, the Skill must pause and ask the user: "Which package manager would you like to use? (npm / pnpm / bun / deno)". Use the answer as the authoritative PM for the rest of the session and skip re-running detection. Record the chosen PM in the Skill's working memory so subsequent steps (install, exec) stay consistent.
