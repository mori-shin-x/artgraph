---
name: "artgraph-detect"
description: "Reports the current artgraph installation, integration, and Skill availability in the project. Use when the user asks whether artgraph is set up, what's installed, or what's available. Make sure to use this skill whenever the user is uncertain about the project's artgraph state."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(ls *)"
  - "Bash(test *)"
  - "Bash(command *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

This Skill inspects the project and reports a concise state summary: whether the artgraph CLI is installed, whether `.artgraph.json` and the trace lockfile exist, which SDD tools (Spec Kit, Kiro) have integration files, and which `artgraph-*` Skills are present under `.claude/skills/`. Read-only — it never writes or modifies anything.

## Steps

### 1. Check CLI availability

```bash
command -v artgraph || npx --no-install artgraph --version || echo "not installed"
```

If not installed, report `artgraph CLI not installed` and recommend the `artgraph-setup` Skill. Continue with the remaining inspection steps regardless — they remain useful without the CLI.

### 2. Check `.artgraph.json`

```bash
test -f .artgraph.json && echo "config: present" || echo "config: missing"
```

If present, report the lockfile path declared in the config (default `.trace.lock`) and whether that file exists on disk.

### 3. Check SDD-tool integrations

```bash
test -d .specify/extensions/artgraph && echo "speckit: integrated" || echo "speckit: not integrated"
test -f .kiro/steering/artgraph.md && echo "kiro: integrated" || echo "kiro: not integrated"
```

Also check for the tool markers themselves, to distinguish "tool not present" from "tool present but not integrated":

- `.specify/` exists -> Spec Kit detected
- `.kiro/` exists -> Kiro detected

### 4. Check installed Skills

```bash
ls .claude/skills/ 2>/dev/null || echo "no .claude/skills/"
```

Report which `artgraph-*` Skills are present. The canonical set is: `artgraph-coverage`, `artgraph-detect`, `artgraph-impact`, `artgraph-integrate`, `artgraph-plan-coverage`, `artgraph-rename`, `artgraph-setup`, `artgraph-bootstrap`, `artgraph-verify`. Missing entries suggest the user ran `init --minimal` or `--no-skills`, or deleted Skills manually. To reinstall only the Skills without touching hooks / integration, recommend `<PM-exec> init --force --agents=<list> --no-scan --no-integrate --no-hooks --no-agent-context` (where `<PM-exec>` is the project's package runner: `npx artgraph` / `pnpm exec artgraph` / `bunx artgraph` / `deno run -A npm:artgraph/cli`). `--force` is required because `.artgraph.json` already exists.

### 5. Summarize

Print a 4-line summary like:

```
artgraph: installed | not installed
config: present | missing
integrations: speckit=[yes/no/not-detected] kiro=[yes/no/not-detected]
skills: N of 9 installed (missing: <list>)
```

Suggest next steps based on what's missing: invoke `artgraph-setup` if the CLI is not installed, `artgraph-integrate` if SDD tools are present but not yet integrated, and `<PM-exec> init --force --agents=<list> --no-scan --no-integrate --no-hooks --no-agent-context` if any canonical Skills are absent.
