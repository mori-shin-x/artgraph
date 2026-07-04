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

This Skill inspects the project and reports a concise state summary: whether the artgraph CLI is installed, whether `.artgraph.json` and the trace lockfile exist, which SDD tools (Spec Kit, Kiro) have integration files, and which `artgraph-*` Skills are present under the host agent's skills path (`<agent_skills_path>` — one of `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.kiro/skills/`, depending on your agent). Read-only — it never writes or modifies anything.

The steps below describe intent, not literal shell commands: compose each probe with your own shell's syntax (POSIX sh, PowerShell, ...) or your own file-inspection tools, whichever fits your environment.

## Steps

### 1. Check CLI availability

Probe whether the artgraph CLI is reachable. First try invoking the bare `artgraph` binary; if that is not on the PATH, try the package-runner forms that fit the project:

- `npx --no-install artgraph --version`
- `pnpm exec artgraph --version`
- `bunx artgraph --version`
- `deno run -A npm:artgraph/cli --version`

If none of these succeeds, report `artgraph CLI not installed` and recommend the `artgraph-setup` Skill. Continue with the remaining inspection steps regardless — they remain useful without the CLI.

### 2. Check `.artgraph.json`

Check whether a `.artgraph.json` file exists at the project root; report `config: present` or `config: missing` accordingly. If present, report the lockfile path declared in the config (default `.trace.lock`) and whether that file exists on disk.

### 3. Check SDD-tool integrations

Check for the integration markers:

- the directory `.specify/extensions/artgraph/` exists -> Spec Kit integrated
- the file `.kiro/steering/artgraph.md` exists -> Kiro integrated

Also check for the tool markers themselves, to distinguish "tool not present" from "tool present but not integrated":

- `.specify/` exists -> Spec Kit detected
- `.kiro/` exists -> Kiro detected

### 4. Check installed Skills

Identify your own skills path among the five canonical locations, each of which maps to a fixed `--agents` id: `.claude/skills/` -> `claude`, `.agents/skills/` -> `codex`, `.cursor/skills/` -> `cursor`, `.github/skills/` -> `copilot`, `.kiro/skills/` -> `kiro`. Check every one of these paths that exists in the project — multi-agent projects may have several — and in each, list the subdirectories whose names start with `artgraph-`. If none of the five paths exists, report that no Skills are distributed in this project.

Report which `artgraph-*` Skills are present. The canonical set is: `artgraph-coverage`, `artgraph-detect`, `artgraph-impact`, `artgraph-integrate`, `artgraph-plan-coverage`, `artgraph-rename`, `artgraph-setup`, `artgraph-verify`. Missing entries suggest the user ran `init --minimal` or `--no-skills`, or deleted Skills manually. To reinstall Skills, recommend `<PM-exec> init --agents=<detected> --force` — where `<PM-exec>` is the project's package runner (`npx artgraph` / `pnpm exec artgraph` / `bunx artgraph` / `deno run -A npm:artgraph/cli`) and `<detected>` is a comma-separated list of the agent ids matching the skills path(s) found above (e.g. `claude,cursor` if both `.claude/skills/` and `.cursor/skills/` were found). `--force` is required because `.artgraph.json` already exists. Warn the user that this default-mode re-run also reconstructs the `.artgraph.json`, SDD-tool integration files, the Stop hook, and the AGENTS.md wrapper for the selected agents — Skills-only reinstall is not currently a supported CLI mode (per FR-013 the `--minimal` shortcut disables every cross-agent stage, including Skills).

### 5. Summarize

Print a 4-line summary like:

```
artgraph: installed | not installed
config: present | missing
integrations: speckit=[yes/no/not-detected] kiro=[yes/no/not-detected]
skills: N of 8 installed (paths: <skills dirs found>; missing: <list>)
```

Suggest next steps based on what's missing: invoke `artgraph-setup` if the CLI is not installed, `artgraph-integrate` if SDD tools are present but not yet integrated, and `<PM-exec> init --agents=<detected> --force` (with `<detected>` derived from Step 4, and with the caveat from Step 4 that this default-mode re-run also touches non-Skill stages) if any canonical Skills are absent.
