---
name: "artgraph-integrate"
description: "Wires artgraph into an installed SDD tool (Spec Kit / Kiro). Use when the user asks to integrate, hook up, or connect artgraph with an existing SDD tool. Make sure to use this skill whenever the user mentions integrating artgraph with a Spec Kit or Kiro project that already has `artgraph` installed."
allowed-tools:
  - "Bash(npx artgraph *)"
  - "Bash(artgraph *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

This Skill discovers which SDD tools are present in the current project and runs `artgraph integrate <tool>` for each one the user wants to wire up. It does not install artgraph itself — the `artgraph-setup` Skill handles that.

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check. If artgraph is not installed, stop and invoke the `artgraph-setup` Skill instead.

### 2. List available providers and their status

```bash
artgraph integrate list --format json
```

The JSON output has `providers[]` with `id`, `displayName`, `detected`, `installed`. Filter for providers where `detected: true && installed: false` — those are integrate candidates.

If every detected provider is already installed: report that and stop.
If no providers are detected: tell the user no SDD tools were found (no `.specify/` or `.kiro/` directory) and stop.

### 3. Confirm with the user per provider

For each detected-but-not-installed provider:
- Show the provider name and what `artgraph integrate <id>` will do (a brief one-liner per tool):
  - **speckit**: install `.specify/extensions/artgraph/` extension and add hook entries to `extensions.yml`
  - **kiro**: install `.kiro/steering/artgraph.md` steering file
- Ask whether to enable `--gate` mode (Spec Kit only; adds a `before_implement` blocking hook). Default: yes for greenfield projects, ask for established projects.
- Get explicit yes/no before running.

### 4. Run the integration

```bash
# speckit example
artgraph integrate speckit --gate

# kiro example
artgraph integrate kiro
```

If the command exits non-zero, surface stderr and stop. Do not retry.

### 5. Verify

```bash
artgraph integrate list
```

Confirm the previously-pending providers now show `installed: yes`. Report the final list to the user.
