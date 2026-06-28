---
name: "artgraph-setup"
description: "Installs artgraph in the current project, detects the package manager (npm / pnpm / Bun / Deno; default and Yarn fallback are pnpm), and wires up Skills, hooks, agent-context snippet, and any detected SDD-tool integration in one turn. Use when the user asks to install / set up / add artgraph. Make sure to use this skill whenever the user mentions artgraph for the first time and `artgraph` CLI is not yet available."
allowed-tools:
  - "Bash(npm install*)"
  - "Bash(npm i*)"
  - "Bash(pnpm add*)"
  - "Bash(bun add*)"
  - "Bash(deno add*)"
  - "Bash(npx artgraph *)"
  - "Bash(pnpm exec artgraph*)"
  - "Bash(bunx artgraph*)"
  - "Bash(deno run*)"
  - "Bash(artgraph *)"
  - "Bash(test *)"
  - "Bash(ls *)"
  - "Bash(command *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Installs artgraph using the project's detected package manager and runs `artgraph init` to lay down the full agent-native setup — Skills, hooks, agent-context snippet, and SDD-tool integration — in a single turn.

## Steps

Every Bash tool call is a **fresh shell** — variables do not persist across calls. Each step below is one self-contained Bash invocation; carry the detected PM across steps as plain text in your reasoning, not as a shell variable.

### 1. Confirm CLI is not yet installed

See [install-check](../_shared/install-check.md). For this Skill the probe is expected to FAIL — if it succeeds (CLI already on PATH or installed locally), tell the user "artgraph is already installed" and stop. They probably wanted the `artgraph-detect` Skill instead.

### 2. Detect the package manager

Run this whole block as one Bash call. Lockfile-only detection covers the common cases; for finer rules (Corepack `packageManager` field, etc.) see [package-manager](../_shared/package-manager.md), and if that disagrees with the lockfile result, ask the user.

```bash
if [ -f bun.lockb ] || [ -f bun.lock ]; then echo "Detected: bun"
elif { [ -f deno.lock ] || [ -f deno.json ] || [ -f deno.jsonc ]; } && [ ! -f package.json ]; then echo "Detected: deno"
elif [ -f pnpm-lock.yaml ]; then echo "Detected: pnpm"
elif [ -f yarn.lock ]; then echo "WARN: yarn.lock found; falling back to pnpm (Yarn not supported)" >&2; echo "Detected: pnpm"
elif [ -f package-lock.json ]; then echo "Detected: npm"
elif [ -f package.json ]; then echo "Detected: pnpm"
else echo "ERROR: cannot detect package manager; ask the user which to use (npm / pnpm / bun / deno)" >&2; exit 1
fi
```

Pass any `WARN:` / `ERROR:` line to the user verbatim. On error, ask which PM (npm / pnpm / bun / deno) and use that answer for the rest of the steps. Remember the chosen PM for steps 3-6.

### 3. Get explicit user consent

Look up the detected PM in this table and show the user the three commands that will run. Wait for confirmation before proceeding; if the user declines, exit and tell them they can run the commands manually.

| PM | install | init | check |
| --- | --- | --- | --- |
| npm | `npm install -D artgraph` | `npx artgraph init` | `npx artgraph check` |
| pnpm | `pnpm add -D artgraph` | `pnpm exec artgraph init` | `pnpm exec artgraph check` |
| bun | `bun add -d artgraph` | `bunx artgraph init` | `bunx artgraph check` |
| deno | `deno add npm:artgraph` | `deno run -A npm:artgraph/cli init` | `deno run -A npm:artgraph/cli check` |

`init` runs the full default flow (config + scan + Skills + integrate-auto for detected SDD tools + Stop hook + agent context).

### 4. Install the CLI

Pick the row in the table above for the detected PM and run the **install** command as one Bash call. If install fails (network, registry timeout, lockfile conflict, etc.), report the stderr to the user and stop. Do not retry without consent.

### 5. Run init

Run the **init** command from the same row as one Bash call. On non-zero exit, surface the stderr to the user without retry — `init` reports which sub-step failed (config / scan / Skills / integrate / hook / agent context).

### 6. Verify

Run the **check** command from the same row as one Bash call. A clean exit confirms the install succeeded and the project's traceability graph reconciled without drift. Report the result to the user.
