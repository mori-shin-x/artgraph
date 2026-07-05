---
name: "artgraph-detect"
description: "Reports the current artgraph installation, integration, and Skill availability in the project. Use when the user asks whether artgraph is set up, what's installed, or what's available. Make sure to use this skill whenever the user is uncertain about the project's artgraph state."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(bunx --no-install artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
  - "Bash(ls *)"
  - "Bash(test *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

This Skill inspects the project and reports a concise state summary: whether the artgraph CLI is installed, whether `.artgraph.json` and the trace lockfile exist, which SDD tools (Spec Kit, Kiro) have integration files, and which `artgraph-*` Skills are present under any of the project's canonical skills paths (`.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, `.kiro/skills/` — a project may have any subset, and multi-agent projects will often have several). This Skill itself is read-only and never writes to the project tree; however, the follow-up commands it recommends in Steps 4 and 5 DO modify files. Never execute those recommendations yourself — print them for the user, explain the caveats, and wait for explicit confirmation.

The steps below describe intent, not literal shell commands: compose each probe with your own shell's syntax (POSIX sh, PowerShell, ...) or your own file-inspection tools, whichever fits your environment.

## Steps

### 1. Check CLI availability

Probe whether the artgraph CLI is reachable. First try invoking the bare `artgraph` binary; if that is not on the PATH, try the package-runner forms that fit the project:

- `npx --no-install artgraph --version`
- `pnpm exec artgraph --version`
- `bunx --no-install artgraph --version`
- `deno run -A npm:artgraph/cli --version`

Prefer the flagged variants (`--no-install`) so the probe fails cleanly on missing installs instead of silently fetching artgraph and mutating the runner's package cache. If a probe requires an install-triggering fallback (e.g. older Bun without `--no-install`, or Deno, which has no equivalent flag), skip it and try the next probe rather than let the "read-only" contract of this Skill slip. If none of these succeeds, report `artgraph CLI not installed` and recommend the `artgraph-setup` Skill. Continue with the remaining inspection steps regardless — they remain useful without the CLI.

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

Enumerate all five canonical skills paths — each one maps to a fixed `--agents` id: `.claude/skills/` -> `claude`, `.agents/skills/` -> `codex`, `.cursor/skills/` -> `cursor`, `.github/skills/` -> `copilot`, `.kiro/skills/` -> `kiro`. For each path, treat it as a "qualifying artgraph skills path" only when BOTH of the following hold:

- the directory itself exists on disk, AND
- it contains at least one `artgraph-<name>/SKILL.md` file (a bare-empty directory, or a directory created by an unrelated tool with the same name and no SKILL.md inside, does NOT count).

Under each qualifying path, list the subdirectories whose names start with `artgraph-` and which contain a `SKILL.md`. Compare that list against the canonical set: `artgraph-coverage`, `artgraph-detect`, `artgraph-impact`, `artgraph-integrate`, `artgraph-plan-coverage`, `artgraph-rename`, `artgraph-setup`, `artgraph-verify`. If NO canonical path qualifies, report that no artgraph Skills are distributed anywhere in this project and skip the reinstall recommendation below — instead route the user to the "next steps" branch in Step 5 for that case.

If at least one path qualifies but some canonical Skills are missing (the user ran `init --minimal` or `--no-skills`, or deleted Skills manually), recommend the **Skills-only** reinstall form:

```
<PM-exec> init --minimal --with-skills --agents=<detected> --force
```

where:

- `<PM-exec>` is the project's package runner (`npx artgraph` / `pnpm exec artgraph` / `bunx artgraph` / `deno run -A npm:artgraph/cli`) — prefer the same runner that succeeded in Step 1.
- `<detected>` is the comma-separated list of agent ids corresponding to the qualifying paths above (lowercase, no trailing comma, no empty elements, no duplicate ids; order and case do not matter — the CLI normalizes them). Example: `claude,cursor` if both `.claude/skills/` and `.cursor/skills/` qualified.
- `--minimal --with-skills` restricts the run to the Skills stage only, so `.artgraph.json`, `.trace.lock`, SDD-tool integration files, the Stop hook, and the AGENTS.md wrapper are left untouched.
- `--force` overwrites drift — including any local edits under `<agent_skills_path>/artgraph-*/SKILL.md`.

**Caveats to relay to the user verbatim before they run it:**

- This command overwrites every `SKILL.md` under the selected agents' skills paths. Any local edits to those files will be replaced with the canonical templates.
- Advise the user to run `git status` (and `git stash` if there are pending edits) beforehand so they can review or preserve local changes.
- **Do NOT execute this command yourself.** Print it, explain the caveats, and wait for the user's explicit confirmation.

Only if the user explicitly asks to also re-provision `.artgraph.json`, `.trace.lock`, integration files, hooks, and the AGENTS.md wrapper, drop `--minimal --with-skills`. In that default-mode variant additionally warn: the run rewrites `.artgraph.json` (existing custom fields are preserved on merge, but `packageManager` is refreshed from current project state), re-scans and rewrites `.trace.lock`, overwrites Kiro `.kiro/steering/artgraph.md` and Spec Kit `.specify/extensions/artgraph/**` (including any manually tuned hook entries in `.specify/extensions.yml`), and refreshes the AGENTS.md wrapper's marker block (user content outside the marker is preserved). An existing `.claude/settings.json` Stop hook is NEVER overwritten, even with `--force` — that is a hard invariant of the `--force` contract.

### 5. Summarize

Print a 4-line summary like:

```
artgraph: installed | not installed
config: present | missing
integrations: speckit=[yes/no/not-detected] kiro=[yes/no/not-detected]
skills: N of 8 installed (paths: <skills dirs found>; missing: <list>)
```

Suggest next steps based on what's missing, in this priority order:

- **CLI not installed** → invoke `artgraph-setup` (fresh install).
- **SDD tools present but not yet integrated** → invoke `artgraph-integrate`.
- **Some canonical Skills absent AND at least one skills path qualified in Step 4** → recommend the Skills-only reinstall command from Step 4 (`<PM-exec> init --minimal --with-skills --agents=<detected> --force`). Print it, relay the Step 4 caveats, and wait for the user's explicit confirmation. Do NOT execute it yourself.
- **Some canonical Skills absent AND NO skills path qualified in Step 4** (i.e. `<detected>` would be empty) → invoke `artgraph-setup` instead. Do NOT emit `--agents=<detected>` in this case — the CLI rejects an empty `--agents=` list (`ERROR: --agents=<list> requires at least one non-empty value`) and `artgraph-setup` is the correct entry point when nothing is distributed yet.
