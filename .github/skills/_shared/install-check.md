# artgraph install check

Shared pre-flight check. Skills run this before invoking any `artgraph` command to confirm the CLI is reachable.

Probe for the CLI by trying the commands below **in order, stopping at the first one that succeeds** (exit code 0). Trying all runners means Deno-only / Bun-only / pnpm-only projects also succeed. Compose each probe for your own shell; discard the probes' stdout/stderr — only the exit code matters.

1. Check whether an `artgraph` executable is on `PATH` (e.g. run `artgraph --version`).
2. `npx --no-install artgraph --version`
3. `pnpm exec artgraph --version`
4. `bunx --no-install artgraph --version`
5. `deno run -A npm:artgraph/cli --version`

If your Bun build does not accept `--no-install`, drop the flag (`bunx artgraph --version`); the probe order still works.

If **every** probe fails, report that artgraph is not installed, show the user these install options, and STOP — do not proceed with the calling Skill:

```
npm install -D artgraph
pnpm add -D artgraph
bun add -d artgraph
deno add npm:artgraph
```

Do not run one of these installs directly. Invoke the `artgraph-setup` Skill instead, which detects the project's package manager (npm / pnpm / Bun / Deno) and installs accordingly.
