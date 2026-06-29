# artgraph install check

Shared pre-flight check. Skills run this before invoking any `artgraph` command to confirm the CLI is reachable.

Probe the CLI via a cascade so Deno-only / Bun-only / pnpm-only projects also succeed:

```bash
command -v artgraph >/dev/null 2>&1 \
  || npx --no-install artgraph --version >/dev/null 2>&1 \
  || pnpm exec artgraph --version >/dev/null 2>&1 \
  || bunx --no-install artgraph --version >/dev/null 2>&1 \
  || deno run -A npm:artgraph/cli --version >/dev/null 2>&1 \
  || {
    echo "artgraph not installed — install with one of these:"
    echo "  npm install -D artgraph"
    echo "  pnpm add -D artgraph"
    echo "  bun add -d artgraph"
    echo "  deno add npm:artgraph"
    exit 1
  }
```

If your Bun build does not accept `--no-install`, drop the flag (`bunx artgraph --version`); the cascade still works.

If the probe fails, do not run `npm install -D artgraph` directly. Invoke the `artgraph-setup` Skill, which detects the project's package manager (npm / pnpm / Bun / Deno) and installs accordingly.
