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

See [install-check](../_shared/install-check.md). For this Skill the probe is expected to FAIL — if it succeeds (CLI already on PATH or installed locally), tell the user "artgraph is already installed" and stop. They probably wanted the `artgraph-detect` Skill instead.

### 2. Detect the package manager

Inspect the project root and apply these rules in order — first match wins. The Corepack `packageManager` field wins over lockfile sniffing; the canonical rules and rationale live in [package-manager](../_shared/package-manager.md), which must stay in sync with `src/package-manager.ts`. If both signals disagree (e.g. `packageManager: bun@*` with a `pnpm-lock.yaml`), ask the user.

1. If `package.json` exists, read its **top-level** `"packageManager"` field (Corepack-style `<pm>@<version>`, e.g. `pnpm@9.0.0`; a nested key does not count, and a value without an `@version` suffix is ignored):
   - `npm` / `pnpm` / `bun` -> use that PM.
   - `yarn` -> use **pnpm** and warn the user: Yarn is not supported, falling back to pnpm.
   - Field absent, malformed, or any other value -> continue to rule 2.
2. Lockfile / config sniffing — first matching **regular file** wins, in this order:
   - `bun.lockb` or `bun.lock` -> **bun**
   - `deno.lock`, `deno.json`, or `deno.jsonc`, and **no** `package.json` -> **deno**
   - `pnpm-lock.yaml` -> **pnpm**
   - `yarn.lock` -> **pnpm**, warn the user: Yarn is not supported, falling back to pnpm.
   - `package-lock.json` -> **npm**
3. `package.json` exists but nothing above matched -> default to **pnpm**.
4. Nothing matched at all -> detection fails: tell the user you cannot detect the package manager and ask which to use (npm / pnpm / bun / deno).

Relay any warning to the user verbatim. On detection failure, ask which PM (npm / pnpm / bun / deno) and use that answer for the rest of the steps. Remember the chosen PM for steps 3-6.

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
