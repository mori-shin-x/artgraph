# artgraph install check

Shared pre-flight check. Skills run this before invoking any `artgraph` command to confirm the CLI is reachable.

Probe the CLI two ways:

```bash
command -v artgraph >/dev/null 2>&1 || npx --no-install artgraph --version >/dev/null 2>&1 || {
  echo "artgraph not installed — install with one of these:"
  echo "  npm install -D artgraph"
  echo "  pnpm add -D artgraph"
  echo "  bun add -d artgraph"
  echo "  deno add npm:artgraph"
  exit 1
}
```

If the probe fails, do not run `npm install -D artgraph` directly. Invoke the `artgraph-setup` Skill, which detects the project's package manager (npm / pnpm / Bun / Deno) and installs accordingly.
