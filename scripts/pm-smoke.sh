#!/usr/bin/env bash
#
# Package-manager smoke test (spec 015, FR-015/016, SC-006).
#
# Packs the current build, installs it into a throwaway fixture using the given
# package manager, and runs `init -> scan -> check` through that PM's exec
# runner. Deno (artgraph is not published) runs the built ./dist/cli.js directly.
#
# Usage:  scripts/pm-smoke.sh <npm|pnpm|bun|deno>
# Requires: `pnpm build` has produced ./dist, and the named PM is on PATH.
set -euo pipefail

PM="${1:?usage: pm-smoke.sh <npm|pnpm|bun|deno>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "ERROR: $ROOT/dist/cli.js missing — run 'pnpm build' first" >&2
  exit 1
fi

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

# Minimal fixture: one REQ, one @impl, so scan/check exercise ts-morph.
printf '{ "name": "pm-smoke-fixture", "version": "0.0.0", "type": "module" }\n' > "$FIX/package.json"
mkdir -p "$FIX/specs" "$FIX/src"
printf -- '- REQ-001: Users can sign in.\n' > "$FIX/specs/auth.md"
printf '// @impl REQ-001\nexport function signIn() { return true; }\n' > "$FIX/src/auth.ts"

echo "==== PM smoke: $PM ===="

run() {
  echo "--- $PM artgraph $* ---"
  ( cd "$FIX" && eval "$RUNNER $*" )
}

case "$PM" in
  npm)
    TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "$FIX")"
    ( cd "$FIX" && npm install --no-save "./$TARBALL" >/dev/null 2>&1 )
    RUNNER="npx --no-install artgraph"
    ;;
  pnpm)
    TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "$FIX")"
    ( cd "$FIX" && pnpm add "./$TARBALL" >/dev/null 2>&1 )
    RUNNER="pnpm exec artgraph"
    ;;
  bun)
    TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "$FIX")"
    ( cd "$FIX" && bun add "./$TARBALL" >/dev/null 2>&1 )
    RUNNER="bunx artgraph"
    ;;
  deno)
    # artgraph is unpublished, so run the built entry directly (research R4).
    RUNNER="deno run -A $ROOT/dist/cli.js"
    ;;
  *)
    echo "ERROR: unknown PM '$PM' (expected npm|pnpm|bun|deno)" >&2
    exit 1
    ;;
esac

run init --minimal --no-skills
run scan
run check

echo "==== PM smoke OK: $PM ===="
