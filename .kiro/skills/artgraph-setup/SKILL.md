---
name: "artgraph-setup"
description: "Installs artgraph in the current project, detects the package manager (npm / pnpm / Bun / Deno; default and Yarn fallback are pnpm), and wires up Skills, hooks, agent-context snippet, and any detected SDD-tool integration in one turn. Use when the user asks to install / set up / add artgraph, asks whether artgraph is set up or what is installed, or wants to wire artgraph into an SDD tool (Spec Kit / Kiro) added after artgraph. Make sure to use this skill whenever the user mentions artgraph for the first time and `artgraph` CLI is not yet available."
allowed-tools:
  - "Bash(npm install*)"
  - "Bash(npm i*)"
  - "Bash(pnpm add*)"
  - "Bash(bun add*)"
  - "Bash(deno add*)"
  - "Bash(npx artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(test *)"
  - "Bash(ls *)"
  - "Bash(command *)"
  - "Bash(node -e *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Installs artgraph using the project's detected package manager and runs `artgraph init` to lay down the full agent-native setup — Skills, hooks, agent-context snippet, and SDD-tool integration — in a single turn.

## Steps

Every Bash tool call is a **fresh shell** — variables do not persist across calls. Each step below is one self-contained Bash invocation; carry the detected PM across steps as plain text in your reasoning, not as a shell variable.

### 1. Confirm CLI is not yet installed

See [install-check](../_shared/install-check.md). For this Skill the probe is expected to FAIL — if it succeeds (CLI already on PATH or installed locally), tell the user "artgraph is already installed", skip steps 2-6, and report the current state instead (see "Already installed? Report the state" below).

### 2. Detect the package manager

Run this whole block as one Bash call. The Corepack `packageManager` field wins over lockfile sniffing; the canonical rules and rationale live in [package-manager](../_shared/package-manager.md). If both signals disagree (e.g. `packageManager: bun@*` with a `pnpm-lock.yaml`), ask the user.

```bash
if [ -f package.json ]; then
  pm_field=$(node -e 'try{const p=require("./package.json").packageManager;if(typeof p==="string"){const m=p.match(/^([a-z]+)@/);process.stdout.write(m?m[1]:"")}}catch{}' 2>/dev/null)
  case "$pm_field" in
    npm|pnpm|bun) echo "Detected: $pm_field"; exit 0 ;;
    yarn) echo "WARN: packageManager=yarn; falling back to pnpm (Yarn not supported)" >&2; echo "Detected: pnpm"; exit 0 ;;
  esac
fi
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

Run the **check** command from the same row as one Bash call. A clean exit confirms the install succeeded and the project's traceability graph reconciled without drift.

If the `init` output from Step 5 included `Zero-tag ready:` (no specs or `@impl` claims detected yet), a clean `check` here is expected but not meaningful — there are no req/doc nodes yet for it to reconcile. Note that to the user and recommend `artgraph impact --diff` instead (or in addition): it already works off the project's TS imports and demonstrates value before any tagging is done.

Report the result to the user.

## Already installed? Report the state

When the Step 1 probe succeeds, inspect and report instead of reinstalling (read-only, one Bash call):

```bash
test -f .artgraph.json && echo "config: present" || echo "config: missing"
test -d .specify && echo "speckit: detected" || echo "speckit: not detected"
test -d .specify/extensions/artgraph && echo "speckit: integrated" || echo "speckit: not integrated"
test -d .kiro && echo "kiro: detected" || echo "kiro: not detected"
test -f .kiro/steering/artgraph.md && echo "kiro: integrated" || echo "kiro: not integrated"
ls .claude/skills/ 2>/dev/null || echo "no .claude/skills/"
```

Report which `artgraph-*` Skills are present. The canonical set is: `artgraph-bootstrap`, `artgraph-impact`, `artgraph-plan-coverage`, `artgraph-rename`, `artgraph-setup`, `artgraph-verify`. Missing entries suggest the user ran `init --minimal` or `--no-skills`, or deleted Skills manually. To reinstall only the Skills without touching hooks / integration, run the **init** command from the Step 3 table with `--force --agents=<list> --no-scan --no-integrate --no-hooks --no-agent-context` appended (`--force` is required because `.artgraph.json` already exists).

## SDD tool installed after artgraph

`init` auto-integrates every SDD tool detected at init time, so the only manual case is a Spec Kit / Kiro marker (`.specify/` / `.kiro/`) that appeared **after** artgraph was set up — i.e. the state report above says "detected" but "not integrated". Confirm with `integrate list` (run via the PM runner from the Step 3 table), then run `integrate speckit` or `integrate kiro` the same way. Spec Kit accepts `--gate` / `--no-gate` to add / remove the `before_implement` gate hook, and `--uninstall` removes an integration.
