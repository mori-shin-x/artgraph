---
name: "artgraph-setup"
description: "Installs artgraph in the current project, detects the package manager (npm / pnpm / Bun / Deno; Yarn falls back to npm with a warning), and wires up Skills, hooks, agent-context snippet, and any detected SDD-tool integration in one turn. Use when the user asks to install / set up / add artgraph. Make sure to use this skill whenever the user mentions artgraph for the first time and `artgraph` CLI is not yet available."
allowed-tools:
  - "Bash(npm install*)"
  - "Bash(pnpm add*)"
  - "Bash(bun install*)"
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

This Skill installs artgraph using the project's detected package manager and runs `artgraph init` to lay down the full agent-native setup — Skills, hooks, agent-context snippet, and SDD-tool integration — in a single turn.

## Steps

### 1. Confirm CLI is not yet installed

See [install-check](../_shared/install-check.md). For this Skill, the probe is expected to FAIL — if it succeeds (CLI already on PATH or installed locally), tell the user "artgraph is already installed" and stop. The user probably wanted the `artgraph-detect` Skill instead.

### 2. Detect the package manager

See [package-manager detection](../_shared/package-manager.md). Run the `detect_package_manager` bash function and capture the result:

```bash
PM=$(detect_package_manager) || { echo "Could not detect package manager"; exit 1; }
echo "Detected: $PM"
```

If detection emits a WARNING to stderr (e.g. Yarn fallback), pass it on to the user verbatim.

### 3. Get explicit user consent

Show the user:
- The detected PM
- The install command (`<PM> install -D artgraph` per the mapping in [package-manager.md](../_shared/package-manager.md))
- The follow-up `<PM-exec> artgraph init` command (which runs the full default setup — Skills + integrate-auto + Stop hook + agent context)

Wait for confirmation before proceeding. If the user declines, exit and tell them they can run the commands manually.

### 4. Install the CLI

Run the install command for the detected PM:

```bash
case "$PM" in
  npm)   npm install -D artgraph ;;
  pnpm)  pnpm add -D artgraph ;;
  bun)   bun install -D artgraph ;;
  deno)  deno add npm:artgraph ;;
esac
```

If install fails (network error, registry timeout, etc.), report the stderr to the user and stop. Do not retry without consent.

### 5. Run init

```bash
case "$PM" in
  npm)   npx artgraph init ;;
  pnpm)  pnpm exec artgraph init ;;
  bun)   bunx artgraph init ;;
  deno)  deno run -A npm:artgraph/cli init ;;
esac
```

`init` runs the full default flow (config + scan + Skills + integrate-auto for detected SDD tools + Stop hook + agent context). If a step fails, init exits 1 with stderr explaining which; surface that to the user without retry.

### 6. Verify

```bash
<PM-exec> artgraph check
```

A clean exit confirms the install succeeded and the project's traceability graph reconciled without drift. Report the result to the user.
